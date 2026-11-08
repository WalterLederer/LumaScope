import { app, nativeImage, type IpcMainInvokeEvent } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { IpcHandler } from '../app/decorators/ipc-handler';
import { readAppSettings, updateAppSettingsSection } from '../settings/app-settings';

const TILE_SIZE = 256;
const TILE_BYTES = TILE_SIZE * TILE_SIZE * 4;
const HEADER_BYTES = 40;
const MAX_RESPONSE_BYTES = 512 * 1024 * 1024;
const HELPER_WORKER_COUNT = 4;

export interface OsmAndTileResult {
  width: number;
  height: number;
  stride: number;
  pixels: Uint8Array;
}

export interface OsmAndRenderingStyle { fileName: string; label: string; selected: boolean; }

export interface OsmAndRuntimeStatus {
  helperPath: string;
  helperAvailable: boolean;
  obfPath: string;
  obfPaths: string[];
  obfAvailable: boolean;
  resourcesPath: string;
  resourcesAvailable: boolean;
  stylePath: string;
  styleAvailable: boolean;
  cachePath: string;
}

type ReaderWaiter =
  | { kind: 'line'; resolve: (value: Buffer) => void; reject: (error: Error) => void }
  | { kind: 'bytes'; length: number; resolve: (value: Buffer) => void; reject: (error: Error) => void };

class ProcessOutputReader {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private readonly waiters: ReaderWaiter[] = [];
  private failure: Error | null = null;

  constructor(stream: NodeJS.ReadableStream, process: ChildProcessWithoutNullStreams) {
    stream.on('data', (chunk: Buffer | string) => {
      if (this.failure) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
      this.drain();
    });
    process.once('error', error => this.fail(error));
    process.once('close', (code, signal) => {
      this.fail(new Error('OsmAnd helper exited (code ' + String(code) + ', signal ' + String(signal) + ').'));
    });
  }

  readLine(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.waiters.push({ kind: 'line', resolve: value => resolve(value.toString('utf8').trim()), reject });
      this.drain();
    });
  }

  readBytes(length: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.waiters.push({ kind: 'bytes', length, resolve, reject });
      this.drain();
    });
  }

  fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    while (this.waiters.length) this.waiters.shift()!.reject(error);
  }

  private drain(): void {
    while (!this.failure && this.waiters.length) {
      const waiter = this.waiters[0];
      if (waiter.kind === 'line') {
        const newline = this.buffer.indexOf(10);
        if (newline < 0) return;
        const value = this.buffer.subarray(0, newline);
        this.buffer = this.buffer.subarray(newline + 1);
        this.waiters.shift();
        waiter.resolve(value);
      } else {
        if (this.buffer.length < waiter.length) return;
        const value = this.buffer.subarray(0, waiter.length);
        this.buffer = this.buffer.subarray(waiter.length);
        this.waiters.shift();
        waiter.resolve(value);
      }
    }
  }
}

class OsmAndHelperWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private reader: ProcessOutputReader | null = null;
  private nextRequestId = 1;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly helperPath: string,
    private readonly resourcesPath: string,
    private readonly stylePath: string,
    private readonly obfPaths: string[],
    private readonly environment: NodeJS.ProcessEnv
  ) {}

  render(z: number, x: number, y: number): Promise<Buffer> {
    const result = this.queue.then(() => this.renderQueued(z, x, y));
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async shutdown(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.reader = null;
    if (child && child.exitCode === null) child.kill();
  }

  private async renderQueued(z: number, x: number, y: number): Promise<Buffer> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.ensureStarted();
        return await this.renderOnce(z, x, y);
      } catch (error) {
        await this.shutdown();
        if (attempt === 1) throw error;
      }
    }
    throw new Error('OsmAnd tile rendering failed.');
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && this.child.exitCode === null && this.reader) return;
    if (!existsSync(this.helperPath)) throw new Error('OsmAnd render helper not found: ' + this.helperPath);
    if (!this.obfPaths.length) throw new Error('No enabled OsmAnd OBF maps are selected.');
    for (const path of this.obfPaths) { if (!existsSync(path)) throw new Error('OsmAnd OBF map not found: ' + path); }
    if (!this.resourcesPath || !existsSync(this.resourcesPath)) throw new Error('Select an external OsmAnd resources folder first.');
    if (!existsSync(this.stylePath)) throw new Error('OsmAnd rendering style not found: ' + this.stylePath);

    const child = spawn(this.helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this.environment });
    this.child = child;
    const reader = new ProcessOutputReader(child.stdout, child);
    this.reader = reader;
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000); });

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });

    await this.writeJson({ command: 'init', obf_paths: this.obfPaths, resources_root: this.resourcesPath, style_path: this.stylePath, night_mode: false });
    const response = JSON.parse(await this.withTimeout(reader.readLine(), 30000, 'OsmAnd helper initialization timed out')) as { status?: string; message?: string };
    if (response.status !== 'ok') {
      throw new Error(response.message || ('OsmAnd helper initialization failed. ' + stderr));
    }
  }

  private async renderOnce(z: number, x: number, y: number): Promise<Buffer> {
    const requestId = this.nextRequestId;
    this.nextRequestId = (this.nextRequestId + 1) >>> 0;
    if (this.nextRequestId === 0) this.nextRequestId = 1;
    await this.writeJson({ command: 'render', request_id: requestId, z, x, y, device_scale: 1.0 });

    const reader = this.reader;
    if (!reader) throw new Error('OsmAnd helper output stream is unavailable.');
    const header = await this.withTimeout(reader.readBytes(HEADER_BYTES), 30000, 'OsmAnd tile header timed out');
    if (header.toString('ascii', 0, 4) !== 'OSMR'
      || header.readUInt16LE(4) !== 1
      || header.readUInt16LE(6) !== HEADER_BYTES) {
      throw new Error('OsmAnd helper returned an unsupported binary response header.');
    }

    const status = header.readUInt32LE(8);
    const responseId = header.readUInt32LE(12);
    const width = header.readUInt32LE(16);
    const height = header.readUInt32LE(20);
    const stride = header.readUInt32LE(24);
    const pixelFormat = header.readUInt32LE(28);
    const payloadSize = Number(header.readBigUInt64LE(32));
    if (responseId !== requestId) throw new Error('OsmAnd helper response ID mismatch.');
    if (!Number.isSafeInteger(payloadSize) || payloadSize > MAX_RESPONSE_BYTES) throw new Error('OsmAnd tile response exceeds the safety limit.');

    const payload = await this.withTimeout(reader.readBytes(payloadSize), 30000, 'OsmAnd tile payload timed out');
    if (status !== 0) throw new Error(payload.toString('utf8') || 'OsmAnd tile rendering failed.');
    if (width !== TILE_SIZE || height !== TILE_SIZE || stride !== TILE_SIZE * 4 || pixelFormat !== 1 || payloadSize !== TILE_BYTES) {
      throw new Error('OsmAnd helper returned unexpected RGBA8 tile dimensions or format.');
    }
    return payload;
  }

  private async writeJson(value: Record<string, unknown>): Promise<void> {
    const child = this.child;
    if (!child || !child.stdin.writable) throw new Error('OsmAnd helper input stream is unavailable.');
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(JSON.stringify(value) + '\n', error => error ? reject(error) : resolve());
    });
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

export class OsmAndManager {
  private readonly localAppData = process.env.LOCALAPPDATA || app.getPath('appData');
  private readonly helperPath = join(process.resourcesPath, 'osmand', 'helpers', 'osmand_render_helper.exe');
  private resourcesPath = this.readSavedResourcesPath();
  private styleFileName = process.env.LUMASCOPE_OSMAND_STYLE_PATH
    ? process.env.LUMASCOPE_OSMAND_STYLE_PATH.split(/[\\/]/).pop() || 'default.render.xml'
    : this.readSavedStyleFileName();
  private stylePath = process.env.LUMASCOPE_OSMAND_STYLE_PATH
    || (this.resourcesPath ? join(this.resourcesPath, 'rendering_styles', this.styleFileName) : '');
  private obfPaths = this.getFallbackObfPaths();
  private readonly cachePath = join(this.localAppData, 'LumaScope', 'cache', 'maps', 'obf');
  private workers: OsmAndHelperWorker[];
  private nextWorker = 0;
  private readonly pendingTiles = new Map<string, Promise<Buffer>>();
  private temporaryFileId = 0;

  constructor() {
    this.workers = this.createWorkers(this.createEnvironment());
    app.once('will-quit', () => { for (const worker of this.workers) void worker.shutdown(); });
  }

  private readSavedResourcesPath(): string {
    const osmand = readAppSettings().osmand as Record<string, unknown> | undefined;
    const atlas = osmand?.atlas as Record<string, unknown> | undefined;
    return typeof atlas?.resourcesPath === 'string' ? atlas.resourcesPath : '';
  }

  private readSavedStyleFileName(): string {
    const osmand = readAppSettings().osmand as Record<string, unknown> | undefined;
    const fileName = osmand?.renderingStyle;
    return typeof fileName === 'string' && /^[a-zA-Z0-9_(). -]+\.render\.xml$/.test(fileName)
      ? fileName : 'default.render.xml';
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

  private async refreshSelectedObf(): Promise<void> {
    let selectedPaths = this.getFallbackObfPaths();
    try {
      const settings = (readAppSettings().offlineMaps ?? {}) as {
        obfPaths?: unknown; enabledByPath?: Record<string, unknown>;
      };
      if (Array.isArray(settings.obfPaths)) {
        selectedPaths = settings.obfPaths
          .filter((value): value is string => typeof value === 'string')
          .filter(path => settings.enabledByPath?.[path] !== false && existsSync(path));
      }
    } catch { /* Keep the configured fallback OBF map. */ }
    if (selectedPaths.length === this.obfPaths.length
      && selectedPaths.every((path, index) => path === this.obfPaths[index])) return;
    await Promise.all(this.workers.map(worker => worker.shutdown()));
    this.obfPaths = selectedPaths;
    this.pendingTiles.clear();
    this.nextWorker = 0;
    this.workers = this.createWorkers(this.createEnvironment());
    console.info('[OsmAnd]', 'active_obf_count=' + selectedPaths.length);
  }

  private createWorkers(environment: NodeJS.ProcessEnv): OsmAndHelperWorker[] {
    return Array.from({ length: HELPER_WORKER_COUNT }, () =>
      new OsmAndHelperWorker(this.helperPath, this.resourcesPath, this.stylePath, this.obfPaths, environment)
    );
  }

  private createEnvironment(): NodeJS.ProcessEnv {
    const runtimePath = [dirname(this.helperPath)];
    return { ...process.env, PATH: [...runtimePath, process.env.PATH || ''].filter(Boolean).join(delimiter) };
  }

  @IpcHandler({ name: 'OsmAnd.setResourcesPath' })
  readonly setResourcesPath = async (_event: Electron.IpcMainInvokeEvent, resourcesPath: string): Promise<OsmAndRuntimeStatus> => {
    if (typeof resourcesPath !== 'string' || !resourcesPath.trim()) throw new Error('Select a valid OsmAnd resources folder.');
    const resolvedPath = resourcesPath.trim();
    if (!existsSync(join(resolvedPath, 'rendering_styles', 'default.render.xml'))) {
      throw new Error('The selected folder must contain rendering_styles/default.render.xml.');
    }
    await Promise.all(this.workers.map(worker => worker.shutdown()));
    this.resourcesPath = resolvedPath;
    const styles = await readdir(join(resolvedPath, 'rendering_styles'), { withFileTypes: true });
    const names = styles.filter(entry => entry.isFile() && entry.name.endsWith('.render.xml')
      && !entry.name.endsWith('.addon.render.xml') && entry.name !== 'standalone-template.render.xml'
      && entry.name !== 'template.addon.render.xml').map(entry => entry.name);
    if (!names.includes(this.styleFileName)) this.styleFileName = names.includes('default.render.xml') ? 'default.render.xml' : (names.sort()[0] ?? 'default.render.xml');
    this.stylePath = process.env.LUMASCOPE_OSMAND_STYLE_PATH || join(resolvedPath, 'rendering_styles', this.styleFileName);
    await updateAppSettingsSection('osmand', { atlas: { resourcesPath: resolvedPath } });
    this.pendingTiles.clear();
    this.workers = this.createWorkers(this.createEnvironment());
    this.nextWorker = 0;
    return this.getRuntimeStatus();
  };

  @IpcHandler({ name: 'OsmAnd.getRenderingStyles' })
  readonly getRenderingStyles = async (): Promise<OsmAndRenderingStyle[]> => {
    if (!this.resourcesPath || !existsSync(this.resourcesPath)) return [];
    const styleDirectory = join(this.resourcesPath, 'rendering_styles');
    if (!existsSync(styleDirectory)) return [];
    const entries = await readdir(styleDirectory, { withFileTypes: true });
    const fileNames = entries
      .filter(entry => entry.isFile()
        && entry.name.endsWith('.render.xml')
        && !entry.name.endsWith('.addon.render.xml')
        && entry.name !== 'standalone-template.render.xml'
        && entry.name !== 'template.addon.render.xml')
      .map(entry => entry.name);
    // Never assume that default.render.xml is shipped: OsmAnd resource bundles
    // can expose a different set of rendering styles.
    const selectedFileName = fileNames.includes(this.styleFileName)
      ? this.styleFileName
      : fileNames.includes('default.render.xml') ? 'default.render.xml' : fileNames.sort()[0];
    if (!selectedFileName) return [];
    if (selectedFileName !== this.styleFileName) {
      await Promise.all(this.workers.map(worker => worker.shutdown()));
      this.styleFileName = selectedFileName;
      this.stylePath = join(styleDirectory, selectedFileName);
      void updateAppSettingsSection('osmand', { renderingStyle: selectedFileName })
        .catch(error => console.warn('[OsmAnd] Could not persist rendering style:', error));
      this.pendingTiles.clear();
      this.workers = this.createWorkers(this.createEnvironment());
    }
    return fileNames
      .map(fileName => {
        const baseName = fileName.slice(0, -'.render.xml'.length);
        const label = baseName
          .replace(/[_-]+/g, ' ')
          .replace(/\s+/g, ' ')
          .replace(/\b\w/g, character => character.toUpperCase());
        return { fileName, label, selected: fileName === this.styleFileName };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  };

  @IpcHandler({ name: 'OsmAnd.setRenderingStyle' })
  readonly setRenderingStyle = async (_event: IpcMainInvokeEvent, fileName: string): Promise<OsmAndRuntimeStatus> => {
    if (typeof fileName !== 'string' || !/^[a-zA-Z0-9_(). -]+\.render\.xml$/.test(fileName)) {
      throw new Error('Invalid OsmAnd rendering style name.');
    }
    const styles = await this.getRenderingStyles();
    const resolvedFileName = styles.some(style => style.fileName === fileName)
      ? fileName
      : styles.find(style => style.selected)?.fileName;
    if (!resolvedFileName) {
      throw new Error('No OsmAnd rendering styles are installed in: ' + join(this.resourcesPath, 'rendering_styles'));
    }
    if (resolvedFileName !== this.styleFileName) {
      await Promise.all(this.workers.map(worker => worker.shutdown()));
      this.styleFileName = resolvedFileName;
      this.stylePath = join(this.resourcesPath, 'rendering_styles', resolvedFileName);
      void updateAppSettingsSection('osmand', { renderingStyle: resolvedFileName })
        .catch(error => console.warn('[OsmAnd] Could not persist rendering style:', error));
      this.pendingTiles.clear();
      this.workers = this.createWorkers(this.createEnvironment());
    }
    return this.getRuntimeStatus();
  };

  @IpcHandler({ name: 'OsmAnd.getRuntimeStatus' })
  readonly getRuntimeStatus = async (): Promise<OsmAndRuntimeStatus> => {
    await this.refreshSelectedObf();
    return ({
    helperPath: this.helperPath,
    helperAvailable: existsSync(this.helperPath),
    obfPath: this.obfPaths[0] || '',
    obfPaths: [...this.obfPaths],
    obfAvailable: this.obfPaths.length > 0 && this.obfPaths.every(path => existsSync(path)),
    resourcesPath: this.resourcesPath,
    resourcesAvailable: existsSync(this.resourcesPath),
    stylePath: this.stylePath,
    styleAvailable: existsSync(this.stylePath),
    cachePath: this.cachePath
    });
  };

  @IpcHandler({ name: 'OsmAnd.renderTile' })
  readonly renderTile = async (_event: IpcMainInvokeEvent, z: number, x: number, y: number): Promise<OsmAndTileResult> => {
    await this.refreshSelectedObf();
    if (!Number.isInteger(z) || z < 2 || z > 19) throw new Error('OsmAnd zoom must be an integer between 2 and 19.');
    const tileCount = 2 ** z;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= tileCount || y >= tileCount) {
      throw new Error('Invalid XYZ tile coordinates.');
    }

    const styleCacheKey = this.styleFileName.replace(/\.render\.xml$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    const mapCacheKey = this.obfPaths.length
      ? createHash('sha256').update(this.obfPaths.join('\0')).digest('hex').slice(0, 20)
      : 'default';
    const cacheFile = join(this.cachePath, mapCacheKey, '1_00', styleCacheKey, String(z), String(x), y + '.png');
    let pixels = await this.readCachedTile(cacheFile);
    if (!pixels) {
      const key = this.obfPaths.join('|') + '/' + z + '/' + x + '/' + y;
      let pending = this.pendingTiles.get(key);
      if (!pending) {
        pending = this.renderAndCacheTile(z, x, y, cacheFile);
        this.pendingTiles.set(key, pending);
        void pending.finally(() => { if (this.pendingTiles.get(key) === pending) this.pendingTiles.delete(key); }).catch(() => undefined);
      }
      pixels = await pending;
    }
    return { width: TILE_SIZE, height: TILE_SIZE, stride: TILE_SIZE * 4, pixels: new Uint8Array(pixels) };
  };

  @IpcHandler({ name: 'OsmAnd.shutdown' })
  readonly shutdown = async (): Promise<void> => {
    await Promise.all(this.workers.map(worker => worker.shutdown()));
  };

  private async renderAndCacheTile(z: number, x: number, y: number, cacheFile: string): Promise<Buffer> {
    await mkdir(dirname(cacheFile), { recursive: true });
    const worker = this.workers[this.nextWorker++ % this.workers.length];
    const pixels = await worker.render(z, x, y);
    const bgra = Buffer.allocUnsafe(pixels.length);
    for (let i = 0; i < pixels.length; i += 4) {
      bgra[i] = pixels[i + 2];
      bgra[i + 1] = pixels[i + 1];
      bgra[i + 2] = pixels[i];
      bgra[i + 3] = pixels[i + 3];
    }
    const png = nativeImage.createFromBitmap(bgra, { width: TILE_SIZE, height: TILE_SIZE, scaleFactor: 1 }).toPNG();
    const temporaryPath = cacheFile + '.' + process.pid + '.' + (++this.temporaryFileId) + '.tmp';
    try {
      await writeFile(temporaryPath, png);
      await rename(temporaryPath, cacheFile);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    return pixels;
  }

  private async readCachedTile(path: string): Promise<Buffer | null> {
    if (!existsSync(path)) return null;
    try {
      const image = nativeImage.createFromBuffer(await readFile(path));
      const size = image.getSize();
      if (size.width !== TILE_SIZE || size.height !== TILE_SIZE) throw new Error('Cached tile dimensions are invalid.');
      const bgra = image.toBitmap();
      if (bgra.length !== TILE_BYTES) throw new Error('Cached tile pixel data is invalid.');
      const rgba = Buffer.allocUnsafe(TILE_BYTES);
      for (let i = 0; i < bgra.length; i += 4) {
        rgba[i] = bgra[i + 2];
        rgba[i + 1] = bgra[i + 1];
        rgba[i + 2] = bgra[i];
        rgba[i + 3] = bgra[i + 3];
      }
      return rgba;
    } catch {
      await unlink(path).catch(() => undefined);
      return null;
    }
  }
}
