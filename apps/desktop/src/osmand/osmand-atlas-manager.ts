import { app, BrowserWindow, dialog, nativeImage, screen } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { IpcHandler } from '../app/decorators/ipc-handler';
import { readAppSettings, updateAppSettingsSection } from '../settings/app-settings';

interface HillshadeDatabaseInfo { id: string; path: string; enabled: boolean; available: boolean; lastModified: number | null; sizeBytes: number | null; }

// Render one MapLibre 512px tile at native resolution. The helper derives
// its zoom compensation from this width, preserving the same geographic extent.
const METATILE_SIZE = 512;
const TILE_BYTES = METATILE_SIZE * METATILE_SIZE * 4;
const HEADER_BYTES = 40;
const MAX_RESPONSE_BYTES = 512 * 1024 * 1024;
const HELPER_WORKER_COUNT = 1;
// Valid transparent PNG returned for XYZ cells outside a regional hillshade database.
const EMPTY_HILLSHADE_TILE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAQAAAD2e2DtAAAAlUlEQVR42u3BAQ0AAADCoPdP7ewBFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3AR4AAY/4QuAAAAAASUVORK5CYII=', 'base64');

function getAtlasPixelDiagnostics(pixels: Buffer): {
  uniqueRgbColors: number;
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
  const topLeft: [number, number, number, number] = [pixels[0], pixels[1], pixels[2], pixels[3]];
  const centerOffset = ((METATILE_SIZE >> 1) * METATILE_SIZE + (METATILE_SIZE >> 1)) * 4;
  const center: [number, number, number, number] = [
    pixels[centerOffset], pixels[centerOffset + 1], pixels[centerOffset + 2], pixels[centerOffset + 3]
  ];
  const rgbMin: [number, number, number] = [255, 255, 255];
  const rgbMax: [number, number, number] = [0, 0, 0];
  let flatTopLeftPixels = 0;
  let transparentPixels = 0;
  let nonOpaquePixels = 0;
  const pixelCount = METATILE_SIZE * METATILE_SIZE;

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
  }

  return {
    uniqueRgbColors: unique.size,
    uniqueCountCapped: unique.size > 4096,
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
    const result = this.queue.then(() => this.readTileQueued(databasePath, z, x, y, s));
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async shutdown(): Promise<void> {
    await this.queue;
    const child = this.child;
    this.child = null;
    this.reader = null;
    if (!child || child.exitCode !== null) return;
    try {
      if (child.stdin.writable) child.stdin.write(JSON.stringify({ command: 'shutdown' }) + '\n');
    } catch { /* Process may already be closing. */ }
    child.kill();
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && this.child.exitCode === null && this.reader) return;
    if (!existsSync(this.helperPath)) throw new Error('OsmAnd Atlas helper not found: ' + this.helperPath);

    // The native helper's stdin/stdout worker protocol starts only when no
    // command-line arguments are supplied. Hillshade requests access SQLite
    // directly and do not require Atlas OBF/resources/style initialization.
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.helperPath, [], {
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
  }

  private async readTileQueued(databasePath: string, z: number, x: number, y: number, s: number): Promise<Uint8Array> {
    await this.ensureStarted();
    const child = this.child;
    const reader = this.reader;
    if (!child || !child.stdin.writable || child.stdin.destroyed || child.stdin.writableEnded || !reader) {
      throw new Error('OsmAnd Hillshade helper streams are unavailable.');
    }
    let requestId = this.nextRequestId >>> 0;
    if (requestId === 0) requestId = 1;
    this.nextRequestId = (requestId + 1) >>> 0;
    if (this.nextRequestId === 0) this.nextRequestId = 1;
    const request = { command: 'hillshade_tile', request_id: requestId, database_path: databasePath, z, x, y, s };
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(JSON.stringify(request) + '\n', error => error ? reject(error) : resolve());
    });
    const header = await reader.readBytes(24);
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
    const payload = await reader.readBytes(payloadLength);
    if (status !== 0) throw new Error('[OsmAnd Hillshade] ' + payload.toString('utf8').trim());
    if (payload.length < 8 || payload.toString('hex', 0, 8) !== '89504e470d0a1a0a') {
      throw new Error('OsmAnd Hillshade helper returned invalid PNG data.');
    }
    return new Uint8Array(payload);
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

  render(longitude: number, latitude: number, zoom: number): Promise<{ pixels: Buffer; geometryMessages: string[] }> {
    if (this.retired) return Promise.reject(new Error('OsmAnd Atlas helper worker has been replaced.'));
    const generation = this.renderGeneration;
    const result = this.queue.then(() => {
      if (generation !== this.renderGeneration) {
        // MapLibre routinely aborts obsolete tile requests during camera moves.
        // Resolve those queued requests with a transparent frame instead of
        // rejecting the IPC call (Electron logs rejected handlers as errors).
        return { pixels: Buffer.alloc(TILE_BYTES), geometryMessages: [] };
      }
      return this.renderQueued(longitude, latitude, zoom);
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
    // Invalidate requests that are still queued, but let the active frame finish.
    // Killing the helper here caused SIGTERM errors on ordinary zoom changes and
    // forced the next tile to recreate the OpenGL context.
    this.renderGeneration++;
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

  private async renderQueued(longitude: number, latitude: number, zoom: number): Promise<{ pixels: Buffer; geometryMessages: string[] }> {
    if (this.retired) throw new Error('OsmAnd Atlas helper worker has been replaced.');
    const maxRetries = 2;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.ensureStarted();
        return await this.renderOnce(longitude, latitude, zoom);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isTimeout = /timed?\s*out|timeout|did not settle/i.test(message);
        if (!isTimeout || attempt >= maxRetries || this.retired) {
          await this.shutdown();
          throw error;
        }
        console.warn('[OsmAnd Atlas] Initial render timeout; restarting helper and retrying',
          { attempt: attempt + 1, maxRetries, message });
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

    console.info('[OsmAnd Atlas][style-trace] helper spawn', {
      stylePath: this.stylePath,
      resourcesPath: this.resourcesPath,
      obfCount: this.obfPaths.length,
      obfPaths: [...this.obfPaths]
    });
    const spawnStartedAt = Date.now();
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
        if (message.startsWith('ERROR:')) {
          this.geometryMessages.push(message);
          if (this.geometryMessages.length > 32) this.geometryMessages.shift();
          console.warn('[OsmAnd Atlas helper]', message);
        } else if (message.startsWith('ATLAS_INIT ')) {
          console.info('[OsmAnd Atlas helper]', message);
        } else if (!/^(INFO|DEBUG):/i.test(message)) {
          console.warn('[OsmAnd Atlas helper]', message);
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    console.info('[OsmAnd Atlas]', 'process_spawn_ms=' + (Date.now() - spawnStartedAt));
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
      width: METATILE_SIZE,
      height: METATILE_SIZE,
      longitude,
      latitude,
      zoom
    };
    const requestStartedAt = Date.now();
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(JSON.stringify(command) + '\n', error => error ? reject(error) : resolve());
    });

    const header = await this.withTimeout(reader.readBytes(HEADER_BYTES), 35000, 'OsmAnd Atlas frame header timed out');
    console.info('[OsmAnd Atlas]', 'frame_header_ms=' + (Date.now() - requestStartedAt) + ' request_id=' + requestId);
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
    const megaPixels = (width * height) / 1_000_000;
    console.info('[OsmAnd Atlas]', 'render_complete_ms=' + elapsedMs
      + ' dimensions=' + width + 'x' + height
      + ' ms_per_megapixel=' + (megaPixels > 0 ? (elapsedMs / megaPixels).toFixed(2) : 'n/a')
      + ' request_id=' + requestId);
    if (status !== 0) {
      const responseMessage = payload.toString('utf8').trim();
      const timeoutMessages = this.stderrMessages.filter(message => /did not settle|timed?\s*out|timeout/i.test(message)).slice(-3);
      const details = [responseMessage, ...timeoutMessages].filter(Boolean).join(' | ');
      throw new Error(details || 'OsmAnd Atlas rendering failed.');
    }
    if (width !== METATILE_SIZE || height !== METATILE_SIZE || stride !== METATILE_SIZE * 4
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
  private hillshadeWorker: OsmAndHillshadeWorker | null = null;
  private readonly localAppData = process.env.LOCALAPPDATA || app.getPath('appData');
  private readonly cachePath = join(this.localAppData, 'LumaScope', 'cache', 'maps', 'obf');
  private readonly helperPath = join(process.resourcesPath, 'osmand', 'helpers', 'osmand_atlas_render_helper.exe');
  private readonly hillshadeHelperPath = join(process.resourcesPath, 'osmand', 'helpers', 'osmand_render_helper.exe');
  private resourcesPath = this.readSavedResourcesPath();
  private styleFileName = this.readSavedStyleFileName();
  private stylePath = this.resourcesPath ? join(this.resourcesPath, 'rendering_styles', this.styleFileName) : '';
  private obfPaths: string[] = this.getFallbackObfPaths();
  private obfRefresh: Promise<void> = Promise.resolve();
  private styleChange: Promise<void> = Promise.resolve();
  private readonly environment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [dirname(this.helperPath), process.env.PATH || ''].filter(Boolean).join(delimiter)
  };
  private displayScale = 1.0;
  private scaleChange: Promise<void> = Promise.resolve();
  private workers = this.createWorkers();
  private nextWorker = 0;
  private readonly pendingTiles = new Map<string, Promise<{ pixels: Buffer; geometryMessages: string[] }>>();
  private readonly diagnosedTiles = new Set<string>();
  private temporaryFileId = 0;

  constructor() {
    this.hillshadeWorker = new OsmAndHillshadeWorker(this.hillshadeHelperPath, this.environment);
    app.once('will-quit', () => {
      for (const worker of this.workers) void worker.shutdown();
      void this.hillshadeWorker?.shutdown();
    });
  }

  private readSavedHillshadeDatabases(): Array<{ id: string; path: string; enabled: boolean }> {
    const osmand = readAppSettings().osmand as Record<string, unknown> | undefined;
    const saved = Array.isArray(osmand?.hillshadeDatabases)
      ? osmand.hillshadeDatabases as Array<{ path?: unknown; enabled?: unknown }>
      : typeof osmand?.hillshadeDatabasePath === 'string' && osmand.hillshadeDatabasePath
        ? [{ path: osmand.hillshadeDatabasePath, enabled: true }]
        : [];
    const seen = new Set<string>();
    return saved.filter(item => typeof item.path === 'string' && item.path.length > 0)
      .map(item => {
        const path = item.path as string;
        const id = createHash('sha1').update(path.toLowerCase()).digest('hex').slice(0, 16);
        return { id, path, enabled: item.enabled !== false };
      })
      .filter(item => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      });
  }

  private async persistHillshadeDatabases(): Promise<void> {
    await updateAppSettingsSection('osmand', {
      hillshadeDatabases: this.hillshadeDatabases.map(({ path, enabled }) => ({ path, enabled })),
      hillshadeDatabasePath: this.hillshadeDatabases[0]?.path ?? ''
    });
  }

  private readSavedResourcesPath(): string {
    const osmand = readAppSettings().osmand as Record<string, unknown> | undefined;
    return typeof osmand?.resourcesPath === 'string' ? osmand.resourcesPath : '';
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
    const update = this.obfRefresh.then(async () => {
      let selectedPaths = this.getFallbackObfPaths();
      try {
        const appSettings = readAppSettings();
        const settings = (appSettings.offlineMaps ?? appSettings.Maps ?? {}) as {
          filePaths?: unknown; obfPreset?: unknown;
        };
        if (settings.filePaths && typeof settings.filePaths === 'object' && !Array.isArray(settings.filePaths)) {
          const preset = settings.obfPreset === 'europe' || settings.obfPreset === 'all' || settings.obfPreset === 'custom' || settings.obfPreset === 'custom-no-world-map' ? settings.obfPreset : 'austria';
          selectedPaths = Object.entries(settings.filePaths as Record<string, unknown>)
            .filter(([path, enabled]) => enabled === true && /\.obf$/i.test(path))
            .map(([path]) => path)
            .filter(path => {
              if (!existsSync(path)) return false;
              const name = path.split(/[\\/]/).pop() ?? path;
              const isWorldBasemap = /^World_basemap\.obf$/i.test(name);
              if (isWorldBasemap) return preset !== 'custom-no-world-map';
              // The old nationwide Austria extract is no longer maintained.
              // Austria preset must use the current regional extracts only.
              if (preset === 'austria' && /^Austria_europe\.obf$/i.test(name)) return false;
              const isAustria = /austria|österreich|osterreich/i.test(name);
              const isEurope = /(?:^|[_. -])europe(?:[_. -]|$)/i.test(name);
              return preset === 'all' || preset === 'custom' || preset === 'custom-no-world-map' || (preset === 'austria' ? isAustria : isEurope);
            });
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

  private createWorkers(): OsmAndAtlasWorker[] {
    return Array.from({ length: HELPER_WORKER_COUNT }, () =>
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
    if (!this.hillshadeDatabases.some(item => item.path === databasePath && item.enabled)) throw new Error('[OsmAnd Hillshade] Database is not in the active Hillshade list: ' + databasePath);
    if (!databasePath || !existsSync(databasePath)) throw new Error('[OsmAnd Hillshade] Hillshade database is unavailable: ' + databasePath);
    if (!/\.(?:sqlitedb|sqlite|db)$/i.test(databasePath)) throw new Error('[OsmAnd Hillshade] Unsupported database file.');
    if (!Number.isInteger(z) || z < 0 || z > 24) throw new Error('[OsmAnd Hillshade] Zoom must be an integer between 0 and 24.');
    const tileCount = 2 ** z;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= tileCount || y >= tileCount) {
      throw new Error('[OsmAnd Hillshade] Invalid XYZ tile coordinates.');
    }
    if (!Number.isInteger(s) || s < 0 || s > 255) throw new Error('[OsmAnd Hillshade] Invalid tile scale.');
    if (!this.hillshadeWorker) {
      this.hillshadeWorker = new OsmAndHillshadeWorker(this.hillshadeHelperPath, this.environment);
    }
    try {
      return await this.hillshadeWorker.readTile(databasePath, z, x, y, s);
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
    await this.styleChange;
    // OBF selection is refreshed by getRuntimeStatus() during map initialization.
    // Do not reread settings and stat every selected OBF for every tile request.
    if (!Number.isInteger(z) || z < 2 || z > 22) throw new Error('OsmAnd Atlas zoom must be an integer between 2 and 22.');
    const tileCount = 2 ** z;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= tileCount || y >= tileCount) {
      throw new Error('Invalid XYZ tile coordinates.');
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

    const metatileX = x & ~1;
    const metatileY = y & ~1;
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
      this.cachePath, mapCacheKey, densityCacheKey, styleCacheKey,
      String(z), String(metatileX), metatileY + '.png'
    );

    let metatilePixels = forceRender ? null : await this.readCachedTile(cacheFile);
    let geometryMessages: string[] = [];
    const cacheHit = metatilePixels !== null;
    if (forceRender) {
      // Wait for an older request for this metatile before replacing its cache
      // entry, otherwise an in-flight render could overwrite the forced result.
      const previousRender = this.pendingTiles.get(cacheFile);
      if (previousRender) await previousRender.catch(() => undefined);
      const forcedRender = this.renderAndCacheTile(z, metatileX, metatileY, cacheFile);
      this.pendingTiles.set(cacheFile, forcedRender);
      try {
        const rendered = await forcedRender;
        metatilePixels = rendered.pixels;
        geometryMessages = rendered.geometryMessages;
      } finally {
        if (this.pendingTiles.get(cacheFile) === forcedRender) this.pendingTiles.delete(cacheFile);
      }
    } else if (!metatilePixels) {
      let pending = this.pendingTiles.get(cacheFile);
      if (!pending) {
        pending = this.renderAndCacheTile(z, metatileX, metatileY, cacheFile);
        this.pendingTiles.set(cacheFile, pending);
        void pending.finally(() => {
          if (this.pendingTiles.get(cacheFile) === pending) this.pendingTiles.delete(cacheFile);
        }).catch(() => undefined);
      }
      const rendered = await pending;
      metatilePixels = rendered.pixels;
      geometryMessages = rendered.geometryMessages;
    }

    const tilePixelDiagnostics = getAtlasPixelDiagnostics(metatilePixels);
    if (tilePixelDiagnostics.uniqueRgbColors === 1) {
      geometryMessages.push('Atlas returned a uniform tile: uniqueRgbColors=1, rgb=' + tilePixelDiagnostics.rgbMin.join(','));
    }
    // Diagnose each metatile once per application session. This deliberately
    // examines the exact RGBA bytes returned to the renderer, whether they came
    // from the native helper or from the PNG disk cache.
    if (forceRender || !this.diagnosedTiles.has(cacheFile)) {
      this.diagnosedTiles.add(cacheFile);
      console.info('[OsmAnd Atlas] metatile pixel diagnostics', {
        source: cacheHit ? 'disk-cache' : 'native-renderer',
        zoom: z,
        metatileX,
        metatileY,
        width: METATILE_SIZE,
        height: METATILE_SIZE,
        ...getAtlasPixelDiagnostics(metatilePixels)
      });
    }

    return {
      width: METATILE_SIZE, height: METATILE_SIZE, stride: METATILE_SIZE * 4,
      pixels: new Uint8Array(metatilePixels), cacheHit,
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
    await Promise.all(this.workers.map(worker => worker.cancelPending()));
  };

  @IpcHandler({ name: 'OsmAndAtlas.shutdown' })
  readonly shutdown = async (): Promise<void> => {
    // Stop helper processes only after active/queued frames have completed.
    // Worker objects remain reusable; ensureStarted() lazily restarts them.
    await Promise.all(this.workers.map(worker => worker.stop()));
    await this.hillshadeWorker?.shutdown();
  };

  private async renderAndCacheTile(z: number, metatileX: number, metatileY: number, cacheFile: string): Promise<{ pixels: Buffer; geometryMessages: string[] }> {
    // The 2x2 metatile centre is one XYZ tile east and south of its NW corner.
    const longitude = (metatileX + 1) / (2 ** z) * 360 - 180;
    const mercatorY = Math.PI * (1 - 2 * (metatileY + 1) / (2 ** z));
    const latitude = Math.atan(Math.sinh(mercatorY)) * 180 / Math.PI;
    if (!this.workers.length) throw new Error('OsmAnd Atlas worker pool is not initialized.');
    const worker = this.workers[this.nextWorker++ % this.workers.length];
    // 512px at the compensated helper zoom yields one MapLibre 512px tile extent.
    const rendered = await worker.render(longitude, latitude, z - 1);
    const pixels = rendered.pixels;
    const pixelDiagnostics = getAtlasPixelDiagnostics(pixels);
    if (pixelDiagnostics.uniqueRgbColors === 1) {
      console.info('[OsmAnd Atlas] Uniform metatile not cached', {
        zoom: z, metatileX, metatileY, uniqueRgbColors: pixelDiagnostics.uniqueRgbColors,
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
      width: METATILE_SIZE,
      height: METATILE_SIZE,
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
      if (size.width !== METATILE_SIZE || size.height !== METATILE_SIZE) {
        throw new Error('Cached OsmAnd Atlas metatile dimensions are invalid.');
      }
      const bgra = image.toBitmap();
      if (bgra.length !== TILE_BYTES) throw new Error('Cached OsmAnd Atlas metatile pixel data is invalid.');
      const rgba = Buffer.allocUnsafe(TILE_BYTES);
      for (let i = 0; i < bgra.length; i += 4) {
        rgba[i] = bgra[i + 2];
        rgba[i + 1] = bgra[i + 1];
        rgba[i + 2] = bgra[i];
        rgba[i + 3] = bgra[i + 3];
      }
      if (getAtlasPixelDiagnostics(rgba).uniqueRgbColors === 1) {
        await unlink(path).catch(() => undefined);
        console.info('[OsmAnd Atlas] Removed uniform metatile from disk cache:', path);
        return null;
      }
      return rgba;
    } catch {
      await unlink(path).catch(() => undefined);
      return null;
    }
  }
}
