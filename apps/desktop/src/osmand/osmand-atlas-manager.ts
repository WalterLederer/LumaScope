import { app, BrowserWindow, dialog, nativeImage, screen } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { IpcHandler } from '../app/decorators/ipc-handler';
import { getOfflineFileEntries, readAppSettings, updateAppSettingsSection } from '../settings/app-settings';

interface HillshadeDatabaseInfo { id: string; path: string; enabled: boolean; available: boolean; lastModified: number | null; sizeBytes: number | null; }

// Render one MapLibre 256px tile at native resolution. The helper derives
// its zoom compensation from this width, preserving the same geographic extent.
const ATLAS_TILE_SIZE = 256;
const TILE_BYTES = ATLAS_TILE_SIZE * ATLAS_TILE_SIZE * 4;
const HEADER_BYTES = 40;
const MAX_RESPONSE_BYTES = 512 * 1024 * 1024;
// Worker counts are shared with the View > Render concurrency setting.
// Valid transparent PNG returned for XYZ cells outside a regional hillshade database.
const EMPTY_HILLSHADE_TILE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAQAAAD2e2DtAAAAlUlEQVR42u3BAQ0AAADCoPdP7ewBFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3AR4AAY/4QuAAAAAASUVORK5CYII=', 'base64');

function getAtlasPixelDiagnostics(pixels: Buffer): {
  uniqueRgbColors: number;
  uniqueRgbaColors: number;
  uniqueCountCapped: boolean;
  flatTopLeftRatio: number;
  transparentPixels: number;
  nonOpaquePixels: number;
  rgbMin: [number, number, number];
  rgbMax: [number, number, number];
  topLeft: [number, number, number, number];
  center: [number, number, number, number];
} {
  const unique = new Set<number>();
  const uniqueRgba = new Set<number>();
  const topLeft: [number, number, number, number] = [pixels[0], pixels[1], pixels[2], pixels[3]];
  const centerOffset = ((ATLAS_TILE_SIZE >> 1) * ATLAS_TILE_SIZE + (ATLAS_TILE_SIZE >> 1)) * 4;
  const center: [number, number, number, number] = [
    pixels[centerOffset], pixels[centerOffset + 1], pixels[centerOffset + 2], pixels[centerOffset + 3]
  ];
  const rgbMin: [number, number, number] = [255, 255, 255];
  const rgbMax: [number, number, number] = [0, 0, 0];
  let flatTopLeftPixels = 0;
  let transparentPixels = 0;
  let nonOpaquePixels = 0;
  const pixelCount = ATLAS_TILE_SIZE * ATLAS_TILE_SIZE;

  for (let offset = 0; offset < pixels.length; offset += 4) {
    const red = pixels[offset];
    const green = pixels[offset + 1];
    const blue = pixels[offset + 2];
    const alpha = pixels[offset + 3];
    if (red === topLeft[0] && green === topLeft[1] && blue === topLeft[2] && alpha === topLeft[3]) {
      flatTopLeftPixels++;
    }
    if (alpha === 0) transparentPixels++;
    if (alpha !== 255) nonOpaquePixels++;
    if (red < rgbMin[0]) rgbMin[0] = red;
    if (green < rgbMin[1]) rgbMin[1] = green;
    if (blue < rgbMin[2]) rgbMin[2] = blue;
    if (red > rgbMax[0]) rgbMax[0] = red;
    if (green > rgbMax[1]) rgbMax[1] = green;
    if (blue > rgbMax[2]) rgbMax[2] = blue;
    if (unique.size <= 4096) unique.add((red << 16) | (green << 8) | blue);
    if (uniqueRgba.size <= 4096) uniqueRgba.add((red << 24) | (green << 16) | (blue << 8) | alpha);
  }

  return {
    uniqueRgbColors: unique.size,
    uniqueRgbaColors: uniqueRgba.size,
    uniqueCountCapped: unique.size > 4096 || uniqueRgba.size > 4096,
    flatTopLeftRatio: Number((flatTopLeftPixels / pixelCount).toFixed(4)),
    transparentPixels,
    nonOpaquePixels,
    rgbMin,
    rgbMax,
    topLeft,
    center
  };
}

export interface OsmAndAtlasTileResult {
  width: number;
  height: number;
  stride: number;
  pixels: Uint8Array;
  cacheHit: boolean;
  queueWaitMs?: number;
  diagnostics?: { helperPath: string; geometryEnabled: boolean; nativeRender: boolean; forceRender: boolean; geometryMessages: string[] };
}

class AtlasOutputReader {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private readonly waiters: Array<{ length: number; resolve: (value: Buffer) => void; reject: (error: Error) => void }> = [];
  private failure: Error | null = null;

  constructor(
    stream: NodeJS.ReadableStream,
    child: ChildProcessWithoutNullStreams,
    private readonly getExitDetails: () => string = () => ''
  ) {
    stream.on('data', (chunk: Buffer | string) => {
      if (this.failure) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
      this.drain();
    });
    child.once('error', error => this.fail(error));
    child.once('close', (code, signal) => {
      const details = this.getExitDetails().trim();
      this.fail(new Error(
        'OsmAnd Atlas helper exited (code ' + String(code) + ', signal ' + String(signal) + ').'
        + (details ? ' ' + details : '')
      ));
    });
  }

  readBytes(length: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.waiters.push({ length, resolve, reject });
      this.drain();
    });
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    while (this.waiters.length) this.waiters.shift()!.reject(error);
  }

  private drain(): void {
    while (!this.failure && this.waiters.length && this.buffer.length >= this.waiters[0].length) {
      const waiter = this.waiters.shift()!;
      const value = this.buffer.subarray(0, waiter.length);
      this.buffer = this.buffer.subarray(waiter.length);
      waiter.resolve(value);
    }
  }
}


class OsmAndHillshadeWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private reader: AtlasOutputReader | null = null;
  private queue: Promise<void> = Promise.resolve();
  private nextRequestId = 1;
  private stderr = '';

  constructor(
    private readonly helperPath: string,
    private readonly environment: NodeJS.ProcessEnv
  ) {}

  readTile(databasePath: string, z: number, x: number, y: number, s = 0): Promise<Uint8Array> {
    const queuedAt = Date.now();
    const result = this.queue.then(() => {
      const queueWaitMs = Date.now() - queuedAt;
      if (queueWaitMs >= 100) console.info('[OsmAnd Hillshade] worker_queue_wait_ms=' + queueWaitMs, { z, x, y });
      return this.readTileQueued(databasePath, z, x, y, s);
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result.catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      if (/timed out/i.test(message)) {
        // A timed-out binary response may still be in flight. Retire the helper
        // so a late response cannot desynchronize the next request's framing.
        const child = this.child;
        this.child = null;
        this.reader = null;
        child?.kill();
      }
      throw error;
    });
  }

  async shutdown(): Promise<void> {
    await this.queue;
    const child = this.child;
    this.child = null;
    this.reader = null;
    if (!child || child.exitCode !== null) return;
    try {
      if (child.stdin.writable) child.stdin.end(JSON.stringify({ type: 'quit' }) + '\n');
    } catch { /* Process may already be closing. */ }
    child.kill();
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && this.child.exitCode === null && this.reader) return;
    if (!existsSync(this.helperPath)) throw new Error('OsmAnd Atlas helper not found: ' + this.helperPath);

    // Hillshade uses the dedicated worker mode of the Atlas helper executable.
    // This keeps Atlas rendering and SQLite tile reads in separate processes,
    // while sharing one native binary and its Qt SQL runtime.
    let child: ChildProcessWithoutNullStreams;
    const startupStartedAt = Date.now();
    try {
      child = spawn(this.helperPath, ['--hillshade-worker'], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this.environment
      });
    } catch (error) {
      throw error;
    }
    this.child = child;
    child.stdin.on('error', error => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPIPE' && code !== 'ERR_STREAM_DESTROYED') {
        console.warn('[OsmAnd Hillshade] Helper stdin error:', error);
      }
    });
    this.stderr = '';
    this.reader = new AtlasOutputReader(child.stdout, child, () => this.stderr.trim());
    child.stderr.on('data', chunk => {
      this.stderr += String(chunk);
      if (this.stderr.length > 12000) this.stderr = this.stderr.slice(-12000);
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    console.info('[OsmAnd Hillshade] helper_ready', { startupMs: Date.now() - startupStartedAt });
  }

  private async readTileQueued(databasePath: string, z: number, x: number, y: number, s: number): Promise<Uint8Array> {
    await this.ensureStarted();
    const child = this.child;
    const reader = this.reader;
    if (!child || !child.stdin.writable || child.stdin.destroyed || child.stdin.writableEnded || !reader) {
      throw new Error('OsmAnd Hillshade helper streams are unavailable.');
    }
    const readStartedAt = Date.now();
    let requestId = this.nextRequestId >>> 0;
    if (requestId === 0) requestId = 1;
    this.nextRequestId = (requestId + 1) >>> 0;
    if (this.nextRequestId === 0) this.nextRequestId = 1;
    const request = { type: 'hillshade_tile', requestId, databasePath, z, x, y, s };
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(JSON.stringify(request) + '\n', error => error ? reject(error) : resolve());
    });
    const header = await this.withTimeout(reader.readBytes(24), 30000, 'OsmAnd Hillshade response header timed out');
    if (header.toString('ascii', 0, 4) !== 'OSMH' || header.readUInt16LE(4) !== 1 || header.readUInt16LE(6) !== 24) {
      throw new Error('OsmAnd Hillshade helper returned an unsupported OSMH response header.');
    }
    const status = header.readUInt32LE(8);
    const responseId = header.readUInt32LE(12);
    const payloadLength = Number(header.readBigUInt64LE(16));
    if (responseId !== requestId) throw new Error('OsmAnd Hillshade response ID mismatch.');
    if (!Number.isSafeInteger(payloadLength) || payloadLength < 0 || payloadLength > 32 * 1024 * 1024) {
      throw new Error('OsmAnd Hillshade PNG exceeds the 32 MB safety limit.');
    }
    const payload = await this.withTimeout(reader.readBytes(payloadLength), 30000, 'OsmAnd Hillshade PNG payload timed out');
    if (status !== 0) throw new Error('[OsmAnd Hillshade] ' + payload.toString('utf8').trim());
    if (payload.length < 8 || payload.toString('hex', 0, 8) !== '89504e470d0a1a0a') {
      throw new Error('OsmAnd Hillshade helper returned invalid PNG data.');
    }
    console.info('[OsmAnd Hillshade] tile_read_complete z=' + z
      + ' x=' + x + ' y=' + y
      + ' database=' + databasePath.split(/[\\\\/]/).pop()
      + ' totalMs=' + (Date.now() - readStartedAt)
      + ' pngBytes=' + payload.length);
    return new Uint8Array(payload);
  }

  private async withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error(message + ' (' + milliseconds + ' ms).')), milliseconds);
        })
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

class OsmAndAtlasWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private reader: AtlasOutputReader | null = null;
  private retired = false;
  private nextRequestId = 1;
  private queue: Promise<void> = Promise.resolve();
  private stderrBuffer = '';
  private stderrMessages: string[] = [];
  private geometryMessages: string[] = [];
  private renderGeneration = 0;

  constructor(
    private readonly helperPath: string,
    private readonly obfPaths: string[],
    private readonly resourcesPath: string,
    private readonly stylePath: string,
    private readonly environment: NodeJS.ProcessEnv,
    private readonly displayScale: number
  ) {}

  render(longitude: number, latitude: number, zoom: number): Promise<{ pixels: Buffer; geometryMessages: string[]; queueWaitMs: number }> {
    if (this.retired) return Promise.reject(new Error('OsmAnd Atlas helper worker has been replaced.'));
    const generation = this.renderGeneration;
    const queuedAt = Date.now();
    const result = this.queue.then(() => {
      const queueWaitMs = Date.now() - queuedAt;
      if (queueWaitMs >= 100) console.info('[OsmAnd Atlas] worker_queue_wait_ms=' + queueWaitMs, { longitude, latitude, zoom });
      if (generation !== this.renderGeneration) {
        // MapLibre routinely aborts obsolete tile requests during camera moves.
        // Resolve those queued requests with a transparent frame instead of
        // rejecting the IPC call (Electron logs rejected handlers as errors).
        return { pixels: Buffer.alloc(TILE_BYTES), geometryMessages: [], queueWaitMs };
      }
      return this.renderQueued(longitude, latitude, zoom, generation).then(rendered => ({ ...rendered, queueWaitMs }));
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async retire(): Promise<void> {
    // The manager stops assigning new work before calling retire(). Let queued
    // renders finish before shutting down this worker.
    await this.queue;
    this.retired = true;
    await this.shutdown();
  }

  async stop(): Promise<void> {
    // A source switch may stop the native process, but must not kill a frame
    // that is still being read by an active IPC request.
    await this.queue;
    await this.shutdown();
  }

  async cancelPending(): Promise<void> {
    // Invalidate queued requests while allowing the current frame to finish.
    this.renderGeneration++;
  }

  async abort(): Promise<void> {
    // A renderer switch must not wait for a slow OBF frame or its timeout.
    this.renderGeneration++;
    await this.shutdown();
  }

  async shutdown(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.reader = null;
    if (!child || child.exitCode !== null) return;
    try {
      if (child.stdin.writable) child.stdin.write(JSON.stringify({ type: 'quit' }) + '\n');
    } catch { /* The process may already be closing. */ }
    child.kill();
  }

  private cleanupConfigurationDirectory(directory: string): void {
    try { rmSync(directory, { recursive: true, force: true }); }
    catch (error) { console.warn('[OsmAnd Atlas] Could not remove helper configuration:', error); }
  }

  private async renderQueued(longitude: number, latitude: number, zoom: number, generation: number): Promise<{ pixels: Buffer; geometryMessages: string[] }> {
    if (this.retired) throw new Error('OsmAnd Atlas helper worker has been replaced.');
    if (generation !== this.renderGeneration) return { pixels: Buffer.alloc(TILE_BYTES), geometryMessages: [] };
    const maxRetries = 2;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.ensureStarted();
        return await this.renderOnce(longitude, latitude, zoom);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (generation !== this.renderGeneration) {
          await this.shutdown();
          return { pixels: Buffer.alloc(TILE_BYTES), geometryMessages: [] };
        }
        const isTimeout = /timed?\s*out|timeout|did not settle/i.test(message);
        if (!isTimeout || attempt >= maxRetries || this.retired) {
          await this.shutdown();
          throw error;
        }
        console.warn('[Atlas] retry=' + (attempt + 1) + '/' + maxRetries + ' reason=timeout');
        await this.shutdown();
        // Give Windows/OpenGL a short moment to release the old helper context.
        await new Promise<void>(resolve => setTimeout(resolve, 750));
      }
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && this.child.exitCode === null && this.reader) return;
    if (!existsSync(this.helperPath)) throw new Error('OsmAnd Atlas render helper not found: ' + this.helperPath);
    if (!this.obfPaths.length) throw new Error('No enabled OsmAnd OBF maps are selected.');
    for (const path of this.obfPaths) {
      if (!existsSync(path)) throw new Error('OsmAnd OBF map not found: ' + path);
    }
    if (!this.resourcesPath || !existsSync(this.resourcesPath)) throw new Error('Select an external OsmAnd resources folder first.');
    if (!existsSync(this.stylePath)) throw new Error('OsmAnd rendering style not found: ' + this.stylePath);


    const configurationDirectory = mkdtempSync(join(tmpdir(), 'lumascope-osmand-atlas-'));
    const configurationPath = join(configurationDirectory, 'obf-paths.json');
    try {
      writeFileSync(configurationPath, JSON.stringify(this.obfPaths), 'utf8');
    } catch (error) {
      this.cleanupConfigurationDirectory(configurationDirectory);
      throw error;
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      // atlas_render_helper.cpp decodes utf8hex: arguments explicitly. Use it
      // for all paths so Unicode folder names survive Windows argv conversion.
      const encodePathArgument = (value: string): string =>
        'utf8hex:' + Buffer.from(value, 'utf8').toString('hex');
      child = spawn(this.helperPath, [
        encodePathArgument(configurationPath),
        encodePathArgument(this.resourcesPath),
        encodePathArgument(this.stylePath),
        String(this.displayScale)
      ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: this.environment
      });
    } catch (error) {
      this.cleanupConfigurationDirectory(configurationDirectory);
      throw error;
    }
    this.child = child;
    // A cancellation can kill the helper while a render command is being
    // written. Node emits EPIPE on stdin in that race; always handle the
    // stream error so it cannot become an uncaught main-process exception.
    child.stdin.on('error', error => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPIPE' && code !== 'ERR_STREAM_DESTROYED') {
        console.warn('[OsmAnd Atlas] Helper stdin error:', error);
      }
    });
    // Keep this process' configuration alive until Windows has fully closed it.
    child.once('close', () => this.cleanupConfigurationDirectory(configurationDirectory));
    this.stderrBuffer = '';
    this.stderrMessages = [];
    this.geometryMessages = [];
    this.reader = new AtlasOutputReader(child.stdout, child, () => this.stderrMessages.slice(-12).join(' | '));
    child.stderr.on('data', chunk => {
      this.stderrBuffer += String(chunk);
      const lines = this.stderrBuffer.split(/\r?\n/);
      this.stderrBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const message = line.trim();
        // The native renderer emits enormous INFO-level OpenGL capability
        // dumps on every worker start. Keep warnings/errors, suppress routine info.
        if (!message) continue;
        this.stderrMessages.push(message);
        if (this.stderrMessages.length > 12) this.stderrMessages.shift();
        if (message.includes('[OsmAnd Atlas][geometry]')) {
          this.geometryMessages.push(message);
          if (this.geometryMessages.length > 32) this.geometryMessages.shift();
        }
        if (message.startsWith('[Atlas]')) {
          console.info(message);
        } else if (message.startsWith('ERROR:') || /\[FATAL\]|\b(error|failed|failure)\b/i.test(message)) {
          this.geometryMessages.push(message);
          if (this.geometryMessages.length > 32) this.geometryMessages.shift();
          console.warn('[Atlas helper]', message);
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  }

  private async renderOnce(longitude: number, latitude: number, zoom: number): Promise<{ pixels: Buffer; geometryMessages: string[] }> {
    const requestId = this.nextRequestId;
    this.nextRequestId = (this.nextRequestId + 1) >>> 0;
    if (this.nextRequestId === 0) this.nextRequestId = 1;
    const child = this.child;
    const reader = this.reader;
    if (!child || !child.stdin.writable || child.stdin.destroyed || child.stdin.writableEnded || !reader) {
      throw new Error('OsmAnd Atlas helper streams are unavailable.');
    }

    const command = {
      type: 'render',
      requestId,
      width: ATLAS_TILE_SIZE,
      height: ATLAS_TILE_SIZE,
      longitude,
      latitude,
      zoom
    };
    const requestStartedAt = Date.now();
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(JSON.stringify(command) + '\n', error => error ? reject(error) : resolve());
    });

    const header = await this.withTimeout(reader.readBytes(HEADER_BYTES), 35000, 'OsmAnd Atlas frame header timed out');
    if (header.toString('ascii', 0, 4) !== 'OSMA'
      || header.readUInt16LE(4) !== 1
      || header.readUInt16LE(6) !== HEADER_BYTES) {
      throw new Error('OsmAnd Atlas helper returned an unsupported binary response header.');
    }

    const status = header.readUInt32LE(8);
    const responseId = header.readUInt32LE(12);
    const width = header.readUInt32LE(16);
    const height = header.readUInt32LE(20);
    const stride = header.readUInt32LE(24);
    const pixelFormat = header.readUInt32LE(28);
    const payloadSize = Number(header.readBigUInt64LE(32));
    if (responseId !== requestId) throw new Error('OsmAnd Atlas response ID mismatch.');
    if (!Number.isSafeInteger(payloadSize) || payloadSize > MAX_RESPONSE_BYTES) {
      throw new Error('OsmAnd Atlas frame exceeds the safety limit.');
    }

    const payload = await this.withTimeout(reader.readBytes(payloadSize), 35000, 'OsmAnd Atlas frame payload timed out');
    const elapsedMs = Date.now() - requestStartedAt;
    if (status !== 0) {
      const responseMessage = payload.toString('utf8').trim();
      // Prefer the error text carried in the helper response. Keep stderr as
      // a fallback for older helpers and failures that occur before a frame is
      // written; exclude routine Qt/OpenGL diagnostics from the user-facing error.
      const helperErrors = [
        ...this.stderrMessages.filter(message => !/^(INFO|DEBUG):/i.test(message)),
        this.stderrBuffer.trim()
      ].filter(Boolean).slice(-4);
      const details = [responseMessage, ...helperErrors].filter(Boolean).join(' | ');
      const statusDescription = status === 1 ? 'native render failure' : 'native helper error';
      console.error('[Atlas] req=' + requestId
        + ' result=error status=' + status
        + ' elapsed=' + elapsedMs + 'ms'
        + ' frame=' + width + 'x' + height
        + ' reason=' + (responseMessage || statusDescription));
      const requestDetails = 'OsmAnd Atlas ' + statusDescription + ' (status ' + status
        + ', request ' + requestId + ', frame ' + width + 'x' + height
        + ', payload ' + payloadSize + ' bytes, elapsed ' + elapsedMs + ' ms).';
      throw new Error(details ? requestDetails + ' ' + details
        : requestDetails + ' The native helper did not provide an error message; check the helper diagnostics.');
    }
    if (width !== ATLAS_TILE_SIZE || height !== ATLAS_TILE_SIZE || stride !== ATLAS_TILE_SIZE * 4
      || pixelFormat !== 1 || payloadSize !== TILE_BYTES) {
      throw new Error('OsmAnd Atlas helper returned unexpected RGBA8 frame dimensions or format.');
    }
    return { pixels: payload, geometryMessages: this.geometryMessages.splice(0) };
  }

  private async withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error(message)), milliseconds); })
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

export class OsmAndAtlasManager {
  private hillshadeDatabases = this.readSavedHillshadeDatabases();
  private hillshadeWorkers: OsmAndHillshadeWorker[] = [];
  private nextHillshadeWorker = 0;
  private readonly localAppData = process.env.LOCALAPPDATA || app.getPath('appData');
  private readonly cachePath = join(this.localAppData, 'LumaScope', 'cache', 'maps', 'obf');
  private readonly helperPath = join(process.resourcesPath, 'osmand', 'helpers', 'osmand_atlas_render_helper.exe');
  private readonly searchHelperPath = join(process.resourcesPath, 'osmand', 'helpers', 'osmand_search_helper.exe');
  private readonly hillshadeHelperPath = join(process.resourcesPath, 'osmand', 'helpers', 'osmand_atlas_render_helper.exe');
  private resourcesPath = this.readSavedResourcesPath();
  private styleFileName = this.readSavedStyleFileName();
  private stylePath = this.resourcesPath ? join(this.resourcesPath, 'rendering_styles', this.styleFileName) : '';
  private obfPaths: string[] = this.getFallbackObfPaths();
  private runtimeObfSelection = false;
  private obfRefresh: Promise<void> = Promise.resolve();
  private styleChange: Promise<void> = Promise.resolve();
  private readonly environment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [dirname(this.helperPath), process.env.PATH || ''].filter(Boolean).join(delimiter)
  };
  private searchWorker: ChildProcessWithoutNullStreams | null = null;
  private searchWorkerKey = '';
  private searchWorkerBuffer = '';
  private searchWorkerStderr = '';
  private searchWorkerReady: Promise<void> | null = null;
  private resolveSearchWorkerReady: (() => void) | null = null;
  private rejectSearchWorkerReady: ((error: Error) => void) | null = null;
  private searchWorkerIsReady = false;
  private searchWorkerPending: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  private displayScale = 1.0;
  private scaleChange: Promise<void> = Promise.resolve();
  private workers = this.createWorkers();
  private nextWorker = 0;
  private readonly pendingTiles = new Map<string, Promise<{ pixels: Buffer; geometryMessages: string[]; queueWaitMs: number }>>();
  private readonly diagnosedTiles = new Set<string>();
  private temporaryFileId = 0;

  constructor() {
    this.hillshadeWorkers = this.createHillshadeWorkers();
    app.once('will-quit', () => {
      for (const worker of this.workers) void worker.shutdown();
      for (const worker of this.hillshadeWorkers) void worker.shutdown();
      this.stopSearchWorker();
    });
  }

  private stopSearchWorker(): void {
    const child = this.searchWorker;
    this.searchWorker = null;
    this.searchWorkerKey = '';
    this.searchWorkerIsReady = false;
    this.searchWorkerReady = null;
    const error = new Error('OsmAnd reverse-geocoding worker was stopped.');
    this.rejectSearchWorkerReady?.(error);
    this.resolveSearchWorkerReady = null;
    this.rejectSearchWorkerReady = null;
    for (const pending of this.searchWorkerPending.splice(0)) pending.reject(error);
    child?.kill();
  }

  private async ensureSearchWorker(activePaths: string[]): Promise<void> {
    const workerKey = JSON.stringify({ paths: activePaths, resourcesPath: this.resourcesPath });
    if (this.searchWorker && this.searchWorker.exitCode === null && this.searchWorkerKey === workerKey) {
      if (this.searchWorkerIsReady) return;
      if (this.searchWorkerReady) return this.searchWorkerReady;
    }

    this.stopSearchWorker();
    if (!existsSync(this.searchHelperPath)) {
      throw new Error('OsmAnd reverse geocoding helper not found: ' + this.searchHelperPath);
    }
    const encodeArgument = (value: string): string => 'utf8hex:' + Buffer.from(value, 'utf8').toString('hex');
    const child = spawn(this.searchHelperPath, [
      '--reverse-geocode-worker',
      encodeArgument(JSON.stringify(activePaths)),
      encodeArgument(this.resourcesPath)
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this.environment });
    this.searchWorker = child;
    this.searchWorkerKey = workerKey;
    this.searchWorkerBuffer = '';
    this.searchWorkerStderr = '';
    this.searchWorkerIsReady = false;

    const readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveSearchWorkerReady = resolve;
      this.rejectSearchWorkerReady = reject;
    });
    this.searchWorkerReady = readyPromise;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      this.searchWorkerBuffer += String(chunk);
      let newline = this.searchWorkerBuffer.indexOf('\\n');
      while (newline >= 0) {
        const line = this.searchWorkerBuffer.slice(0, newline).trim();
        this.searchWorkerBuffer = this.searchWorkerBuffer.slice(newline + 1);
        if (!line) {
          newline = this.searchWorkerBuffer.indexOf('\\n');
          continue;
        }
        if (!this.searchWorkerIsReady) {
          try {
            const ready = JSON.parse(line) as { worker_ready?: unknown; error?: unknown };
            if (ready.worker_ready !== true) throw new Error(String(ready.error ?? 'Invalid worker startup response.'));
            this.searchWorkerIsReady = true;
            this.resolveSearchWorkerReady?.();
            this.resolveSearchWorkerReady = null;
            this.rejectSearchWorkerReady = null;
          } catch (error) {
            const startupError = error instanceof Error ? error : new Error(String(error));
            this.rejectSearchWorkerReady?.(startupError);
            this.rejectSearchWorkerReady = null;
            child.kill();
          }
        } else {
          const pending = this.searchWorkerPending.shift();
          if (pending) pending.resolve(line);
          else console.warn('[OsmAnd Search] Ignoring unsolicited worker output:', line);
        }
        newline = this.searchWorkerBuffer.indexOf('\\n');
      }
    });
    child.stderr.on('data', chunk => {
      this.searchWorkerStderr += String(chunk);
      if (this.searchWorkerStderr.length > 12000) this.searchWorkerStderr = this.searchWorkerStderr.slice(-12000);
    });
    child.once('error', error => {
      this.rejectSearchWorkerReady?.(error);
      this.rejectSearchWorkerReady = null;
      for (const pending of this.searchWorkerPending.splice(0)) pending.reject(error);
    });
    child.once('close', code => {
      const closeError = new Error('OsmAnd reverse-geocoding worker exited (code '
        + String(code) + '). ' + this.searchWorkerStderr.trim());
      if (this.searchWorker === child) {
        this.searchWorker = null;
        this.searchWorkerKey = '';
        this.searchWorkerIsReady = false;
        this.searchWorkerReady = null;
      }
      this.rejectSearchWorkerReady?.(closeError);
      this.resolveSearchWorkerReady = null;
      this.rejectSearchWorkerReady = null;
      for (const pending of this.searchWorkerPending.splice(0)) pending.reject(closeError);
    });

    return readyPromise;
  }

  private async requestSearchWorker(activePaths: string[], latitude: number, longitude: number, locale: string): Promise<string> {
    await this.ensureSearchWorker(activePaths);
    const child = this.searchWorker;
    if (!child || !child.stdin.writable || child.stdin.destroyed || child.stdin.writableEnded) {
      throw new Error('OsmAnd reverse-geocoding worker input is unavailable.');
    }
    return new Promise<string>((resolve, reject) => {
      this.searchWorkerPending.push({ resolve, reject });
      child.stdin.write(JSON.stringify({ latitude, longitude, locale }) + '\\n');
    });
  }

  private readRenderWorkerCount(): number {
    const mapWindow = readAppSettings().mapWindow as Record<string, unknown> | undefined;
    const value = Number(mapWindow?.renderWorkerCount ?? 2);
    return Number.isFinite(value) ? Math.max(1, Math.min(4, Math.round(value))) : 2;
  }

  private async ensureRenderWorkerPools(): Promise<void> {
    const count = this.readRenderWorkerCount();
    const previousWorkers = this.workers.length === count ? null : this.workers;
    const previousHillshadeWorkers = this.hillshadeWorkers.length === count ? null : this.hillshadeWorkers;
    if (!previousWorkers && !previousHillshadeWorkers) return;
    if (previousWorkers) {
      this.workers = this.createWorkers(count);
      this.nextWorker = 0;
      this.pendingTiles.clear();
    }
    if (previousHillshadeWorkers) {
      this.hillshadeWorkers = this.createHillshadeWorkers(count);
      this.nextHillshadeWorker = 0;
    }
    await Promise.all([
      ...(previousWorkers ?? []).map(worker => worker.retire()),
      ...(previousHillshadeWorkers ?? []).map(worker => worker.shutdown())
    ]);
    console.info('[OsmAnd Atlas] render_worker_count=' + count);
  }

  private createHillshadeWorkers(count = this.readRenderWorkerCount()): OsmAndHillshadeWorker[] {
    return Array.from({ length: count }, () =>
      new OsmAndHillshadeWorker(this.hillshadeHelperPath, this.environment)
    );
  }

  private readSavedHillshadeDatabases(): Array<{ id: string; path: string; enabled: boolean }> {
    const seen = new Set<string>();
    return getOfflineFileEntries(readAppSettings())
      .filter(item => item.type === 'hillshade')
      .map(item => {
        const id = createHash('sha1').update(item.path.toLowerCase()).digest('hex').slice(0, 16);
        return { id, path: item.path, enabled: item.enabled };
      })
      .filter(item => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      });
  }

  private async persistHillshadeDatabases(): Promise<void> {
    await updateAppSettingsSection('osmand', {
      hillshadeDatabases: this.hillshadeDatabases.map(({ path, enabled }) => ({ path, enabled }))
    });
  }

  private readSavedResourcesPath(): string {
    return getOfflineFileEntries(readAppSettings()).find(entry => entry.type === 'osmand-resources')?.path ?? '';
  }

  private readSavedStyleFileName(): string {
    const osmand = readAppSettings().osmand as Record<string, unknown> | undefined;
    const fileName = osmand?.renderingStyle;
    return typeof fileName === 'string' && /^[a-zA-Z0-9_(). -]+\.render\.xml$/.test(fileName)
      ? fileName : 'default.render.xml';
  }

  private persistStyleFileName(fileName: string): Promise<void> {
    return updateAppSettingsSection('osmand', { renderingStyle: fileName });
  }

  private async inspectRenderingStyles(resourcesPath: string): Promise<{ styleDirectory: string; fileNames: string[] }> {
    const configuredPath = typeof resourcesPath === 'string' ? resourcesPath.trim() : '';
    if (!configuredPath) {
      throw new Error('[OsmAnd Atlas] resources path is empty. Expected resources directory: <not configured>.');
    }
    if (!existsSync(configuredPath)) {
      throw new Error('[OsmAnd Atlas] resources directory not found: ' + configuredPath
        + '\nExpected rendering styles directory: ' + join(configuredPath, 'rendering_styles'));
    }

    const styleDirectory = join(configuredPath, 'rendering_styles');
    let entries;
    try {
      entries = await readdir(styleDirectory, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error('[OsmAnd Atlas] rendering styles directory is missing or inaccessible: ' + styleDirectory
        + '\nFilesystem error: ' + code + ' — ' + detail);
    }

    const discoveredFiles = entries.filter(entry => entry.isFile()).map(entry => entry.name);
    const fileNames = discoveredFiles.filter(name =>
      name.endsWith('.render.xml')
      && !name.endsWith('.addon.render.xml')
      && name !== 'standalone-template.render.xml'
      && name !== 'template.addon.render.xml'
    );
    if (!fileNames.includes('default.render.xml')) {
      const found = discoveredFiles.length
        ? discoveredFiles.map(name => join(styleDirectory, name)).join('\n')
        : '<no files>';
      throw new Error('[OsmAnd Atlas] required base rendering style not found: '
        + join(styleDirectory, 'default.render.xml')
        + '\nRendering styles directory: ' + styleDirectory
        + '\nDiscovered files (' + discoveredFiles.length + '):\n' + found);
    }
    return { styleDirectory, fileNames };
  }

  private getFallbackObfPaths(): string[] {
    const configured = process.env.LUMASCOPE_OSMAND_OBF_PATH || process.env.IPHOTO_OSMAND_OBF_PATH;
    if (configured) return [configured];
    const fallback = [
      join(app.getAppPath(), 'tools', 'Austria_wien_europe.obf'),
      join(app.getAppPath(), '..', '..', 'tools', 'Austria_wien_europe.obf'),
      join(process.cwd(), 'tools', 'Austria_wien_europe.obf')
    ].find(candidate => existsSync(candidate));
    return fallback ? [fallback] : [];
  }

  private async retireWorkers(): Promise<void> {
    const previousWorkers = this.workers;
    this.workers = [];
    this.nextWorker = 0;
    await Promise.all(previousWorkers.map(worker => worker.retire()));
  }

  private async replaceWorkers(): Promise<void> {
    const previousWorkers = this.workers;
    // Publish the replacement first. Existing requests retain their worker
    // references and finish before the old helper processes are stopped.
    this.workers = this.createWorkers();
    this.nextWorker = 0;
    this.pendingTiles.clear();
    await Promise.all(previousWorkers.map(worker => worker.retire()));
  }

  private async refreshSelectedObf(): Promise<void> {
    if (this.runtimeObfSelection) return;
    const update = this.obfRefresh.then(async () => {
      let selectedPaths = this.getFallbackObfPaths();
      try {
        const appSettings = readAppSettings();
        const settings = (appSettings.offline ?? appSettings.offlineMaps ?? appSettings.Maps ?? {}) as {
          paths?: unknown;
          filePaths?: unknown;
        };
        const configuredPaths = Array.isArray(settings.paths) ? settings.paths : settings.filePaths;
        if (Array.isArray(configuredPaths)) {
          const savedPaths: Array<{ path: string; enabled: boolean }> = Array.isArray(configuredPaths)
            ? configuredPaths.flatMap(entry => {
              if (typeof entry === 'string') return [{ path: entry, enabled: true }];
              if (entry && typeof entry === 'object'
                && typeof (entry as { path?: unknown }).path === 'string'
                && typeof (entry as { enabled?: unknown }).enabled === 'boolean') {
                return [{ path: (entry as { path: string }).path, enabled: (entry as { enabled: boolean }).enabled }];
              }
              return [];
            })
            : configuredPaths && typeof configuredPaths === 'object'
              ? Object.entries(configuredPaths as Record<string, unknown>)
                .filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')
                .map(([path, enabled]) => ({ path, enabled }))
              : [];
          // The enabled flags in paths are the sole source of truth.
          // Do not apply a separately persisted regional preset here.
          selectedPaths = savedPaths
            .filter(entry => entry.enabled && /.obf$/i.test(entry.path))
            .map(entry => entry.path)
            .filter(path => existsSync(path));
        }
      } catch { /* Keep configured fallback OBF maps. */ }
      if (selectedPaths.length === this.obfPaths.length
        && selectedPaths.every((path, index) => path === this.obfPaths[index])) return;
      this.obfPaths = selectedPaths;
      await this.replaceWorkers();
      console.info('[OsmAnd]', 'active_obf_count=' + selectedPaths.length);
    });
    this.obfRefresh = update.catch(() => undefined);
    return update;
  }

  private createWorkers(count = this.readRenderWorkerCount()): OsmAndAtlasWorker[] {
    return Array.from({ length: count }, () =>
      new OsmAndAtlasWorker(
        this.helperPath, this.obfPaths, this.resourcesPath, this.stylePath, this.environment, this.displayScale
      )
    );
  }

  private ensureDisplayScale(displayScale: number): Promise<void> {
    const update = this.scaleChange.then(async () => {
      if (Math.abs(this.displayScale - displayScale) < 0.001) return;
      this.displayScale = displayScale;
      await this.replaceWorkers();
      console.info('[OsmAnd Atlas]', 'display_scale=' + displayScale);
    });
    this.scaleChange = update.catch(() => undefined);
    return update;
  }

  @IpcHandler({ name: 'OsmAndAtlas.setResourcesPath' })
  readonly setResourcesPath = async (_event: Electron.IpcMainInvokeEvent, resourcesPath: string) => {
    if (typeof resourcesPath !== 'string' || !resourcesPath.trim()) throw new Error('Select a valid OsmAnd resources folder.');
    const resolvedPath = resourcesPath.trim();
    if (!existsSync(join(resolvedPath, 'rendering_styles', 'default.render.xml'))) {
      throw new Error('The selected folder must contain rendering_styles/default.render.xml.');
    }
    await this.retireWorkers();
    this.resourcesPath = resolvedPath;
    const { styleDirectory, fileNames } = await this.inspectRenderingStyles(resolvedPath);
    if (!fileNames.includes(this.styleFileName)) this.styleFileName = 'default.render.xml';
    this.stylePath = join(styleDirectory, this.styleFileName);
    await updateAppSettingsSection('osmand', {
      resourcesPath: resolvedPath,
      renderingStyle: this.styleFileName,
      atlas: undefined
    });
    this.pendingTiles.clear();
    this.workers = this.createWorkers();
    this.nextWorker = 0;
    return this.getRuntimeStatus();
  };

  @IpcHandler({ name: 'OsmAndAtlas.getRenderingStyles' })
  readonly getRenderingStyles = async () => {
    await this.styleChange;
    const { styleDirectory, fileNames } = await this.inspectRenderingStyles(this.resourcesPath);
    // config.json is the single persistent source of truth. Refresh the
    // in-memory selection before reporting it or allowing a helper to render.
    const savedFileName = this.readSavedStyleFileName();
    const selectedFileName = fileNames.includes(savedFileName) ? savedFileName : 'default.render.xml';
    console.info('[OsmAnd Atlas][style-trace] getRenderingStyles', {
      configStyle: savedFileName,
      managerStyle: this.styleFileName,
      selectedStyle: selectedFileName,
      stylePath: join(styleDirectory, selectedFileName)
    });

    if (selectedFileName !== this.styleFileName || this.stylePath !== join(styleDirectory, selectedFileName)) {
      this.styleFileName = selectedFileName;
      this.stylePath = join(styleDirectory, selectedFileName);
      if (savedFileName !== selectedFileName) await this.persistStyleFileName(selectedFileName);
      await this.replaceWorkers();
    }

    return fileNames.map(fileName => {
      const baseName = fileName.slice(0, -'.render.xml'.length);
      const label = baseName.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
        .replace(/\b\w/g, character => character.toUpperCase());
      return { fileName, label, selected: fileName === this.styleFileName };
    }).sort((a, b) => a.label.localeCompare(b.label));
  };

  @IpcHandler({ name: 'OsmAndAtlas.setRenderingStyle' })
  readonly setRenderingStyle = async (_event: Electron.IpcMainInvokeEvent, fileName: string) => {
    const update = this.styleChange.then(async () => {
      if (typeof fileName !== 'string' || !/^[a-zA-Z0-9_(). -]+\.render\.xml$/.test(fileName)) {
        throw new Error('[OsmAnd Atlas] invalid rendering style name: ' + String(fileName));
      }

      const { styleDirectory, fileNames } = await this.inspectRenderingStyles(this.resourcesPath);
      // The UI can issue its first render request before getRenderingStyles()
      // has restored the persisted selection. Never let a stale/removed style
      // prevent map initialization: fall back to the installed base style.
      const selectedFileName = fileNames.includes(fileName) ? fileName : 'default.render.xml';
      if (selectedFileName !== fileName) {
        console.warn('[OsmAnd Atlas] Requested rendering style is not installed; falling back to default.render.xml:', fileName);
      }

      console.info('[OsmAnd Atlas][style-trace] setRenderingStyle', {
        requestedStyle: fileName,
        selectedStyle: selectedFileName,
        managerStyleBefore: this.styleFileName,
        configStyleBefore: this.readSavedStyleFileName()
      });
      if (selectedFileName !== this.styleFileName) {
        this.styleFileName = selectedFileName;
        this.stylePath = join(styleDirectory, selectedFileName);
        await this.persistStyleFileName(selectedFileName);
        await this.replaceWorkers();
        console.info('[OsmAnd Atlas] Rendering style applied:', selectedFileName);
      }
    });
    this.styleChange = update.catch(() => undefined);
    await update;
    return this.getRuntimeStatus();
  };

  @IpcHandler({ name: 'OsmAndAtlas.getObfMetadata' })
  readonly getObfMetadata = async (_event: Electron.IpcMainInvokeEvent, paths: string[]) => {
    if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string' || !path.trim() || !/\.obf$/i.test(path))) {
      throw new Error('OBF metadata requires an array of valid .obf file paths.');
    }
    if (!paths.length) return [];
    if (!this.resourcesPath || !existsSync(this.resourcesPath)) {
      throw new Error('Select an available OsmAnd resources folder before reading OBF metadata.');
    }
    if (!existsSync(this.helperPath)) throw new Error('OsmAnd Atlas metadata helper not found: ' + this.helperPath);

    const configurationDirectory = mkdtempSync(join(tmpdir(), 'lumascope-obf-metadata-'));
    const configurationPath = join(configurationDirectory, 'obf-paths.json');
    try {
      writeFileSync(configurationPath, JSON.stringify(paths), 'utf8');
      const encodePathArgument = (value: string): string =>
        'utf8hex:' + Buffer.from(value, 'utf8').toString('hex');
      const output = await new Promise<string>((resolveOutput, rejectOutput) => {
        const child = spawn(this.helperPath, [
          '--obf-metadata', encodePathArgument(configurationPath), encodePathArgument(this.resourcesPath)
        ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: this.environment });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { stdout += String(chunk); });
        child.stderr.on('data', chunk => { stderr += String(chunk); });
        child.once('error', rejectOutput);
        child.once('close', code => {
          if (code !== 0) {
            rejectOutput(new Error('OBF metadata helper failed (exit ' + String(code) + '). ' + stderr.trim()));
            return;
          }
          resolveOutput(stdout);
        });
      });
      const line = output.split(/\r?\n/).find(value => value.startsWith('OBF_METADATA '));
      if (!line) throw new Error('OBF metadata helper returned no metadata payload.');
      const parsed: unknown = JSON.parse(line.slice('OBF_METADATA '.length));
      if (!Array.isArray(parsed)) throw new Error('OBF metadata helper returned an invalid payload.');
      return parsed;
    } finally {
      rmSync(configurationDirectory, { recursive: true, force: true });
    }
  };

  @IpcHandler({ name: 'OsmAndAtlas.setActiveObfMaps' })
  readonly setActiveObfMaps = async (_event: Electron.IpcMainInvokeEvent, paths: string[]): Promise<string[]> => {
    if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string' || !/\.obf$/i.test(path))) {
      throw new Error('Active OBF selection must contain valid .obf file paths.');
    }
    const selectedPaths = [...new Set(paths.filter(path => existsSync(path)))];
    if (!selectedPaths.length) {
      // A transient empty viewport result must not replace the configured
      // active OBF set (for example before Offline Files metadata has loaded).
      this.runtimeObfSelection = false;
      await this.refreshSelectedObf();
      return [...this.obfPaths];
    }
    this.runtimeObfSelection = true;
    if (selectedPaths.length === this.obfPaths.length
      && selectedPaths.every((path, index) => path === this.obfPaths[index])) return [...this.obfPaths];
    await this.cancelRendering();
    const previousWorkers = this.workers;
    this.obfPaths = selectedPaths;
    this.workers = this.createWorkers();
    this.nextWorker = 0;
    await Promise.all(previousWorkers.map(worker => worker.retire()));
    console.info('[OsmAnd Atlas] viewport_obf_selection', { count: selectedPaths.length, paths: selectedPaths });
    return [...this.obfPaths];
  };

  @IpcHandler({ name: 'OsmAndAtlas.reverseGeocode' })
  readonly reverseGeocode = async (
    _event: Electron.IpcMainInvokeEvent,
    latitude: number,
    longitude: number,
    locale = ''
  ): Promise<{
    found: boolean;
    latitude: number;
    longitude: number;
    building: string;
    street: string;
    place: string;
    postcode: string;
    administrative_areas: Array<{ admin_level: number; name: string }>;
    helper_version: string;
    diagnostics: { loaded_map_objects: number; administrative_boundary_objects: number; loaded_address_boundary_groups: number; matching_address_boundary_groups: number; matched_address_boundary_object_ids: number; map_boundary_object_ids: string[]; address_boundary_object_ids: string[]; matched_boundary_object_ids: string[]; resolved_administrative_areas: number };
    distance_m: number | null;
    source: string;
  }> => {
    if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new Error('Reverse geocoding requires valid latitude and longitude coordinates.');
    }
    await this.refreshSelectedObf();
    const activePaths = [...new Set(this.obfPaths.filter(path => existsSync(path)))];
    if (!activePaths.length) throw new Error('Enable at least one available OsmAnd OBF map in Offline Files.');
    if (!this.resourcesPath || !existsSync(this.resourcesPath)) throw new Error('Select an available OsmAnd resources folder first.');
    const output = await this.requestSearchWorker(activePaths, latitude, longitude, locale);
    const parsed: unknown = JSON.parse(output.trim());
    if (parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string') {
      throw new Error('Offline reverse geocoding failed: ' + String((parsed as { error: string }).error));
    }
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { found?: unknown }).found !== 'boolean') {
      throw new Error('Offline reverse geocoding returned an invalid result.');
    }
    const result = parsed as {
      found: boolean;
      building?: string;
      street?: string;
      place?: string;
      postcode?: string;
      administrative_areas?: unknown;
      helper_version?: unknown;
      diagnostics?: unknown;
      distance_m?: number;
      source?: string;
    };
    const administrativeAreas = Array.isArray(result.administrative_areas)
      ? result.administrative_areas.filter((area): area is { admin_level: number; name: string } =>
        !!area && typeof area === 'object'
        && typeof (area as { admin_level?: unknown }).admin_level === 'number'
        && Number.isInteger((area as { admin_level: number }).admin_level)
        && typeof (area as { name?: unknown }).name === 'string'
        && (area as { name: string }).name.trim().length > 0)
      : [];
    const rawDiagnostics = result.diagnostics && typeof result.diagnostics === 'object'
      ? result.diagnostics as Record<string, unknown>
      : {};
    const diagnosticCount = (key: string): number => {
      const value = rawDiagnostics[key];
      return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    };
    return {
      found: result.found,
      latitude,
      longitude,
      building: typeof result.building === 'string' ? result.building : '',
      street: typeof result.street === 'string' ? result.street : '',
      place: typeof result.place === 'string' ? result.place : '',
      postcode: typeof result.postcode === 'string' ? result.postcode : '',
      administrative_areas: administrativeAreas,
      helper_version: typeof result.helper_version === 'string' ? result.helper_version : 'unknown',
      diagnostics: {
        loaded_map_objects: diagnosticCount('loaded_map_objects'),
        administrative_boundary_objects: diagnosticCount('administrative_boundary_objects'),
        loaded_address_boundary_groups: diagnosticCount('loaded_address_boundary_groups'),
        matching_address_boundary_groups: diagnosticCount('matching_address_boundary_groups'),
        matched_address_boundary_object_ids: diagnosticCount('matched_address_boundary_object_ids'),
        map_boundary_object_ids: Array.isArray(rawDiagnostics['map_boundary_object_ids']) ? rawDiagnostics['map_boundary_object_ids'].filter((value): value is string => typeof value === 'string').slice(0, 20) : [],
        address_boundary_object_ids: Array.isArray(rawDiagnostics['address_boundary_object_ids']) ? rawDiagnostics['address_boundary_object_ids'].filter((value): value is string => typeof value === 'string').slice(0, 20) : [],
        matched_boundary_object_ids: Array.isArray(rawDiagnostics['matched_boundary_object_ids']) ? rawDiagnostics['matched_boundary_object_ids'].filter((value): value is string => typeof value === 'string').slice(0, 20) : [],
        resolved_administrative_areas: diagnosticCount('resolved_administrative_areas')
      },
      distance_m: typeof result.distance_m === 'number' && Number.isFinite(result.distance_m) ? result.distance_m : null,
      source: typeof result.source === 'string' ? result.source : 'OsmAnd'
    };
  };

  @IpcHandler({ name: 'OsmAndAtlas.searchAddresses' })
  readonly searchAddresses = async (
    _event: Electron.IpcMainInvokeEvent,
    paths: string[],
    query: string,
    limit = 5
  ): Promise<Array<{ display_name: string; secondary_text: string; longitude: number; latitude: number; source_kind: string; match_kind: string }>> => {
    if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string' || !/\.obf$/i.test(path))) {
      throw new Error('Address search requires a valid list of active OBF files.');
    }
    const activePaths = [...new Set(paths.filter(path => existsSync(path)))];
    if (!activePaths.length) throw new Error('Enable at least one available OsmAnd OBF map in Offline Files.');
    const trimmedQuery = typeof query === 'string' ? query.trim() : '';
    if (trimmedQuery.length < 2) throw new Error('Enter at least two characters to search addresses.');
    if (!Number.isInteger(limit) || limit < 0 || limit > 1000000) throw new Error('Address search result limit must be zero (unlimited) or between 1 and 1000000.');
    if (!this.resourcesPath || !existsSync(this.resourcesPath)) throw new Error('Select an available OsmAnd resources folder first.');
    if (!existsSync(this.searchHelperPath)) throw new Error('OsmAnd address search helper not found: ' + this.searchHelperPath);

    const encodeArgument = (value: string): string => 'utf8hex:' + Buffer.from(value, 'utf8').toString('hex');
    const output = await new Promise<string>((resolveOutput, rejectOutput) => {
      const child = spawn(this.searchHelperPath, [
        '--search',
        encodeArgument(JSON.stringify(activePaths)),
        encodeArgument(this.resourcesPath),
        encodeArgument(trimmedQuery),
        encodeArgument(''),
        String(limit)
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: this.environment });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += String(chunk); });
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      child.once('error', rejectOutput);
      child.once('close', code => {
        if (code !== 0) {
          rejectOutput(new Error('Offline address search failed (exit ' + String(code) + '). ' + stderr.trim()));
          return;
        }
        resolveOutput(stdout);
      });
    });
    const parsed: unknown = JSON.parse(output.trim());
    if (!Array.isArray(parsed)) throw new Error('Offline address search returned an invalid result.');
    return parsed.filter((item): item is { display_name: string; secondary_text: string; longitude: number; latitude: number; source_kind: string; match_kind: string } =>
      !!item && typeof item === 'object'
      && typeof (item as { display_name?: unknown }).display_name === 'string'
      && typeof (item as { latitude?: unknown }).latitude === 'number'
      && typeof (item as { longitude?: unknown }).longitude === 'number');
  };

  @IpcHandler({ name: 'OsmAndAtlas.getRuntimeStatus' })
  readonly getRuntimeStatus = async () => {
    await this.refreshSelectedObf();
    console.info('[OsmAnd Atlas] runtime style=' + this.styleFileName + ' stylePath=' + this.stylePath
      + ' obfCount=' + this.obfPaths.length + ' obfPaths=' + this.obfPaths.join('; '));
    return ({
      helperPath: this.helperPath,
      helperAvailable: existsSync(this.helperPath),
      obfPath: this.obfPaths.join('; '),
      obfPaths: [...this.obfPaths],
      obfAvailable: this.obfPaths.length > 0 && this.obfPaths.every(path => existsSync(path)),
      resourcesPath: this.resourcesPath,
      resourcesAvailable: !!this.resourcesPath && existsSync(this.resourcesPath),
      stylePath: this.stylePath,
      styleAvailable: existsSync(this.stylePath)
    });
  };


  @IpcHandler({ name: 'OsmAndAtlas.getHillshadeDatabases' })
  readonly getHillshadeDatabases = async (): Promise<HillshadeDatabaseInfo[]> => {
    return this.hillshadeDatabases.map(item => {
      try {
        const stats = statSync(item.path);
        return { ...item, available: stats.isFile(), lastModified: stats.mtimeMs, sizeBytes: stats.size };
      } catch {
        return { ...item, available: false, lastModified: null, sizeBytes: null };
      }
    });
  };

  @IpcHandler({ name: 'OsmAndAtlas.addHillshadeDatabases' })
  readonly addHillshadeDatabases = async (): Promise<HillshadeDatabaseInfo[]> => {
    const result = await dialog.showOpenDialog({
      title: 'Add OsmAnd Hillshade databases',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Hillshade SQLite databases', extensions: ['sqlitedb', 'sqlite', 'db'] }]
    });
    if (result.canceled || !result.filePaths.length) return this.getHillshadeDatabases();
    const byId = new Map(this.hillshadeDatabases.map(item => [item.id, item]));
    for (const selectedPath of result.filePaths) {
      if (!existsSync(selectedPath) || !/\.(?:sqlitedb|sqlite|db)$/i.test(selectedPath)) continue;
      const id = createHash('sha1').update(selectedPath.toLowerCase()).digest('hex').slice(0, 16);
      if (!byId.has(id)) byId.set(id, { id, path: selectedPath, enabled: true });
    }
    this.hillshadeDatabases = [...byId.values()];
    await this.persistHillshadeDatabases();
    return this.getHillshadeDatabases();
  };

  @IpcHandler({ name: 'OsmAndAtlas.addHillshadeDatabasePaths' })
  readonly addHillshadeDatabasePaths = async (_event: Electron.IpcMainInvokeEvent, paths: string[]): Promise<HillshadeDatabaseInfo[]> => {
    if (!Array.isArray(paths)) throw new Error('Hillshade database paths must be an array.');
    const byId = new Map(this.hillshadeDatabases.map(item => [item.id, item]));
    for (const selectedPath of paths) {
      if (typeof selectedPath !== 'string' || !existsSync(selectedPath) || !/\.(?:sqlitedb|sqlite|db)$/i.test(selectedPath)) continue;
      if (!statSync(selectedPath).isFile()) continue;
      const id = createHash('sha1').update(selectedPath.toLowerCase()).digest('hex').slice(0, 16);
      if (!byId.has(id)) byId.set(id, { id, path: selectedPath, enabled: true });
    }
    this.hillshadeDatabases = [...byId.values()];
    await this.persistHillshadeDatabases();
    return this.getHillshadeDatabases();
  };

  @IpcHandler({ name: 'OsmAndAtlas.reconcileHillshadeDatabasePaths' })
  readonly reconcileHillshadeDatabasePaths = async (_event: Electron.IpcMainInvokeEvent, paths: string[]): Promise<HillshadeDatabaseInfo[]> => {
    if (!Array.isArray(paths)) throw new Error('Hillshade database paths must be an array.');
    const existingByPath = new Map(this.hillshadeDatabases.map(item => [resolve(item.path).toLocaleLowerCase(), item]));
    const next = new Map<string, { id: string; path: string; enabled: boolean }>();
    for (const candidate of paths) {
      if (typeof candidate !== 'string' || !candidate.trim() || !/\.(?:sqlitedb|sqlite|db)$/i.test(candidate)) continue;
      const path = resolve(candidate.trim());
      try {
        const stats = statSync(path);
        if (!stats.isFile()) continue;
      } catch {
        continue;
      }
      const key = path.toLocaleLowerCase();
      const id = createHash('sha1').update(key).digest('hex').slice(0, 16);
      next.set(id, { id, path, enabled: existingByPath.get(key)?.enabled ?? true });
    }
    this.hillshadeDatabases = [...next.values()];
    await this.persistHillshadeDatabases();
    return this.getHillshadeDatabases();
  };

  @IpcHandler({ name: 'OsmAndAtlas.setHillshadeDatabaseEnabled' })
  readonly setHillshadeDatabaseEnabled = async (_event: Electron.IpcMainInvokeEvent, id: string, enabled: boolean): Promise<HillshadeDatabaseInfo[]> => {
    this.hillshadeDatabases = this.hillshadeDatabases.map(item => item.id === id ? { ...item, enabled: !!enabled } : item);
    await this.persistHillshadeDatabases();
    return this.getHillshadeDatabases();
  };

  @IpcHandler({ name: 'OsmAndAtlas.removeHillshadeDatabase' })
  readonly removeHillshadeDatabase = async (_event: Electron.IpcMainInvokeEvent, id: string): Promise<HillshadeDatabaseInfo[]> => {
    this.hillshadeDatabases = this.hillshadeDatabases.filter(item => item.id !== id);
    await this.persistHillshadeDatabases();
    return this.getHillshadeDatabases();
  };

  @IpcHandler({ name: 'OsmAndAtlas.renderHillshadeTile' })
  readonly renderHillshadeTile = async (_event: Electron.IpcMainInvokeEvent, databasePath: string, z: number, x: number, y: number, s = 0): Promise<Uint8Array> => {
    await this.ensureRenderWorkerPools();
    if (!this.hillshadeDatabases.some(item => item.path === databasePath && item.enabled)) throw new Error('[OsmAnd Hillshade] Database is not in the active Hillshade list: ' + databasePath);
    if (!databasePath || !existsSync(databasePath)) throw new Error('[OsmAnd Hillshade] Hillshade database is unavailable: ' + databasePath);
    if (!/\.(?:sqlitedb|sqlite|db)$/i.test(databasePath)) throw new Error('[OsmAnd Hillshade] Unsupported database file.');
    if (!Number.isInteger(z) || z < 0 || z > 24) throw new Error('[OsmAnd Hillshade] Zoom must be an integer between 0 and 24.');
    const tileCount = 2 ** z;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= tileCount || y >= tileCount) {
      throw new Error('[OsmAnd Hillshade] Invalid XYZ tile coordinates.');
    }
    if (!Number.isInteger(s) || s < 0 || s > 255) throw new Error('[OsmAnd Hillshade] Invalid tile scale.');
    if (!this.hillshadeWorkers.length) this.hillshadeWorkers = this.createHillshadeWorkers();
    const worker = this.hillshadeWorkers[this.nextHillshadeWorker++ % this.hillshadeWorkers.length];
    try {
      return await worker.readTile(databasePath, z, x, y, s);
    } catch (error) {
      // Regional hillshade databases naturally omit cells outside their coverage.
      // Resolve these at the IPC boundary so Electron does not log an expected
      // "tile not found" rejection for every empty cell requested by MapLibre.
      const message = error instanceof Error ? error.message : String(error);
      if (/Hillshade tile not found/i.test(message)) {
        return new Uint8Array(EMPTY_HILLSHADE_TILE_PNG);
      }
      throw error;
    }
  };

  @IpcHandler({ name: 'OsmAndAtlas.renderTile' })
  readonly renderTile = async (event: Electron.IpcMainInvokeEvent, z: number, x: number, y: number, requestedDisplayScale?: number, forceRender = false): Promise<OsmAndAtlasTileResult> => {
    await this.ensureRenderWorkerPools();
    await this.styleChange;
    // OBF selection is refreshed by getRuntimeStatus() during map initialization.
    // Do not reread settings and stat every selected OBF for every tile request.
    if (!Number.isInteger(z) || z < 2 || z > 22) throw new Error('OsmAnd Atlas zoom must be an integer between 2 and 22.');
    const tileCount = 2 ** z;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= tileCount || y >= tileCount) {
      throw new Error('Invalid XYZ tile coordinates.');
    }

    // Return an empty tile before initializing/restarting native workers.
    // An empty active OBF selection is a valid no-data state, not an IPC error.
    if (!this.obfPaths.length) {
      return {
        width: ATLAS_TILE_SIZE, height: ATLAS_TILE_SIZE, stride: ATLAS_TILE_SIZE * 4,
        pixels: new Uint8Array(TILE_BYTES), cacheHit: false
      };
    }

    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    const display = ownerWindow
      ? screen.getDisplayMatching(ownerWindow.getBounds())
      : screen.getPrimaryDisplay();
    const windowsDisplayScale = Math.min(4, Math.max(1, display.scaleFactor || 1));
    const displayScale = Number.isFinite(requestedDisplayScale)
      ? Math.min(4, Math.max(1, requestedDisplayScale!))
      : windowsDisplayScale;
    await this.ensureDisplayScale(displayScale);

    const tileX = x;
    const tileY = y;
    if (!this.workers.length) throw new Error('OsmAnd Atlas worker pool is not initialized.');

    const mapCacheKey = this.obfPaths.length
      ? createHash('sha256').update(this.obfPaths.join('\0')).digest('hex').slice(0, 20)
      : 'default';
    const densityCacheKey = displayScale.toFixed(3).replace('.', '_');
    const styleCacheKey = this.styleFileName
      .replace(/\.render\.xml$/i, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .toLowerCase();
    const cacheFile = join(
      this.cachePath, 'xyz-256', mapCacheKey, densityCacheKey, styleCacheKey,
      String(z), String(tileX), tileY + '.png'
    );

    let tilePixels = forceRender ? null : await this.readCachedTile(cacheFile);
    let geometryMessages: string[] = [];
    let queueWaitMs: number | undefined;
    const cacheHit = tilePixels !== null;
    if (forceRender) {
      // Wait for an older request for this tile before replacing its cache
      // entry, otherwise an in-flight render could overwrite the forced result.
      const previousRender = this.pendingTiles.get(cacheFile);
      if (previousRender) await previousRender.catch(() => undefined);
      const forcedRender = this.renderAndCacheTile(z, tileX, tileY, cacheFile);
      this.pendingTiles.set(cacheFile, forcedRender);
      try {
        const rendered = await forcedRender;
        tilePixels = rendered.pixels;
        geometryMessages = rendered.geometryMessages;
        queueWaitMs = rendered.queueWaitMs;
      } finally {
        if (this.pendingTiles.get(cacheFile) === forcedRender) this.pendingTiles.delete(cacheFile);
      }
    } else if (!tilePixels) {
      let pending = this.pendingTiles.get(cacheFile);
      if (!pending) {
        pending = this.renderAndCacheTile(z, tileX, tileY, cacheFile);
        this.pendingTiles.set(cacheFile, pending);
        void pending.finally(() => {
          if (this.pendingTiles.get(cacheFile) === pending) this.pendingTiles.delete(cacheFile);
        }).catch(() => undefined);
      }
      const rendered = await pending;
      tilePixels = rendered.pixels;
      geometryMessages = rendered.geometryMessages;
      queueWaitMs = rendered.queueWaitMs;
    }

    const tilePixelDiagnostics = getAtlasPixelDiagnostics(tilePixels);
    if (tilePixelDiagnostics.uniqueRgbaColors === 1) {
      geometryMessages.push('Atlas returned a uniform tile: uniqueRgbColors=1, rgb=' + tilePixelDiagnostics.rgbMin.join(','));
    }
    // Diagnose each tile once per application session. This deliberately
    // examines the exact RGBA bytes returned to the renderer, whether they came
    // from the native helper or from the PNG disk cache.
    if (forceRender || !this.diagnosedTiles.has(cacheFile)) {
      this.diagnosedTiles.add(cacheFile);
      console.info('[OsmAnd Atlas] tile pixel diagnostics', {
        source: cacheHit ? 'disk-cache' : 'native-renderer',
        zoom: z,
        tileX,
        tileY,
        width: ATLAS_TILE_SIZE,
        height: ATLAS_TILE_SIZE,
        ...getAtlasPixelDiagnostics(tilePixels)
      });
    }

    return {
      width: ATLAS_TILE_SIZE, height: ATLAS_TILE_SIZE, stride: ATLAS_TILE_SIZE * 4,
      pixels: new Uint8Array(tilePixels), cacheHit,
      ...(queueWaitMs !== undefined ? { queueWaitMs } : {}),
      diagnostics: {
        helperPath: this.helperPath,
        geometryEnabled: this.environment.OSMAND_ATLAS_DEBUG_GEOMETRY !== undefined,
        nativeRender: !cacheHit,
        forceRender,
        geometryMessages
      }
    };
  };

  @IpcHandler({ name: 'OsmAndAtlas.cancelRendering' })
  readonly cancelRendering = async (): Promise<void> => {
    this.pendingTiles.clear();
    await Promise.all(this.workers.map(worker => worker.abort()));
  };

  @IpcHandler({ name: 'OsmAndAtlas.shutdown' })
  readonly shutdown = async (): Promise<void> => {
    // Stop helper processes only after active/queued frames have completed.
    // Worker objects remain reusable; ensureStarted() lazily restarts them.
    await Promise.all(this.workers.map(worker => worker.stop()));
    await Promise.all(this.hillshadeWorkers.map(worker => worker.shutdown()));
  };

  private async renderAndCacheTile(z: number, tileX: number, tileY: number, cacheFile: string): Promise<{ pixels: Buffer; geometryMessages: string[]; queueWaitMs: number }> {
    // Render the centre of this exact XYZ tile; no 2x2 grouping or zoom shift.
    const longitude = (tileX + 0.5) / (2 ** z) * 360 - 180;
    const mercatorY = Math.PI * (1 - 2 * (tileY + 0.5) / (2 ** z));
    const latitude = Math.atan(Math.sinh(mercatorY)) * 180 / Math.PI;
    if (!this.workers.length) throw new Error('OsmAnd Atlas worker pool is not initialized.');
    const worker = this.workers[this.nextWorker++ % this.workers.length];
    // The native helper renders one 256px XYZ tile at the same zoom.
    const rendered = await worker.render(longitude, latitude, z);
    const pixels = rendered.pixels;
    const pixelDiagnostics = getAtlasPixelDiagnostics(pixels);
    if (pixelDiagnostics.uniqueRgbaColors === 1) {
      console.info('[OsmAnd Atlas] Uniform tile not cached', {
        zoom: z, tileX, tileY,
        uniqueRgbColors: pixelDiagnostics.uniqueRgbColors,
        uniqueRgbaColors: pixelDiagnostics.uniqueRgbaColors,
        transparentPixels: pixelDiagnostics.transparentPixels,
        nonOpaquePixels: pixelDiagnostics.nonOpaquePixels,
        topLeft: pixelDiagnostics.topLeft,
        center: pixelDiagnostics.center,
        rgbMin: pixelDiagnostics.rgbMin, rgbMax: pixelDiagnostics.rgbMax
      });
      return rendered;
    }

    await mkdir(dirname(cacheFile), { recursive: true });
    const bgra = Buffer.allocUnsafe(pixels.length);
    for (let i = 0; i < pixels.length; i += 4) {
      bgra[i] = pixels[i + 2];
      bgra[i + 1] = pixels[i + 1];
      bgra[i + 2] = pixels[i];
      bgra[i + 3] = pixels[i + 3];
    }
    const png = nativeImage.createFromBitmap(bgra, {
      width: ATLAS_TILE_SIZE,
      height: ATLAS_TILE_SIZE,
      scaleFactor: 1
    }).toPNG();
    const temporaryPath = cacheFile + '.' + process.pid + '.' + (++this.temporaryFileId) + '.tmp';
    try {
      await writeFile(temporaryPath, png);
      await rename(temporaryPath, cacheFile);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    return rendered;
  }

  private async readCachedTile(path: string): Promise<Buffer | null> {
    if (!existsSync(path)) return null;
    try {
      const image = nativeImage.createFromBuffer(await readFile(path));
      const size = image.getSize();
      if (size.width !== ATLAS_TILE_SIZE || size.height !== ATLAS_TILE_SIZE) {
        throw new Error('Cached OsmAnd Atlas tile dimensions are invalid.');
      }
      const bgra = image.toBitmap();
      if (bgra.length !== TILE_BYTES) throw new Error('Cached OsmAnd Atlas tile pixel data is invalid.');
      const rgba = Buffer.allocUnsafe(TILE_BYTES);
      for (let i = 0; i < bgra.length; i += 4) {
        rgba[i] = bgra[i + 2];
        rgba[i + 1] = bgra[i + 1];
        rgba[i + 2] = bgra[i];
        rgba[i + 3] = bgra[i + 3];
      }
      if (getAtlasPixelDiagnostics(rgba).uniqueRgbaColors === 1) {
        await unlink(path).catch(() => undefined);
        console.info('[OsmAnd Atlas] Removed uniform tile from disk cache:', path);
        return null;
      }
      return rgba;
    } catch {
      await unlink(path).catch(() => undefined);
      return null;
    }
  }
}
