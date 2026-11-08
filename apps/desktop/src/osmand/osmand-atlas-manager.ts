import { app, BrowserWindow, nativeImage, screen } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { IpcHandler } from '../app/decorators/ipc-handler';
import { readAppSettings, updateAppSettingsSection } from '../settings/app-settings';

// Render a 2x2 group of 256px Atlas XYZ tiles as one 1024px raster metatile.
// MapLibre consumes it as one 512px tile, so its geographic extent is exactly
// four former 256px tiles. No per-quadrant split is performed.
const METATILE_SIZE = 1024;
const TILE_BYTES = METATILE_SIZE * METATILE_SIZE * 4;
const HEADER_BYTES = 40;
const MAX_RESPONSE_BYTES = 512 * 1024 * 1024;
const HELPER_WORKER_COUNT = 4;

export interface OsmAndAtlasTileResult {
  width: number;
  height: number;
  stride: number;
  pixels: Uint8Array;
}

class AtlasOutputReader {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private readonly waiters: Array<{ length: number; resolve: (value: Buffer) => void; reject: (error: Error) => void }> = [];
  private failure: Error | null = null;

  constructor(stream: NodeJS.ReadableStream, child: ChildProcessWithoutNullStreams) {
    stream.on('data', (chunk: Buffer | string) => {
      if (this.failure) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
      this.drain();
    });
    child.once('error', error => this.fail(error));
    child.once('close', (code, signal) => this.fail(new Error(
      'OsmAnd Atlas helper exited (code ' + String(code) + ', signal ' + String(signal) + ').'
    )));
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

class OsmAndAtlasWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private reader: AtlasOutputReader | null = null;
  private retired = false;
  private nextRequestId = 1;
  private queue: Promise<void> = Promise.resolve();
  private stderrBuffer = '';
  private configurationDirectory: string | null = null;

  constructor(
    private readonly helperPath: string,
    private readonly obfPaths: string[],
    private readonly resourcesPath: string,
    private readonly stylePath: string,
    private readonly environment: NodeJS.ProcessEnv,
    private readonly displayScale: number
  ) {}

  render(longitude: number, latitude: number, zoom: number): Promise<Buffer> {
    if (this.retired) return Promise.reject(new Error('OsmAnd Atlas helper worker has been replaced.'));
    const result = this.queue.then(() => this.renderQueued(longitude, latitude, zoom));
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

  async shutdown(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.reader = null;
    if (!child || child.exitCode !== null) {
      this.cleanupConfigurationFile();
      return;
    }
    try {
      if (child.stdin.writable) child.stdin.write(JSON.stringify({ type: 'quit' }) + '\n');
    } catch { /* The process may already be closing. */ }
    child.kill();
    this.cleanupConfigurationFile();
  }

  private cleanupConfigurationFile(): void {
    const directory = this.configurationDirectory;
    this.configurationDirectory = null;
    if (directory) {
      try { rmSync(directory, { recursive: true, force: true }); }
      catch (error) { console.warn('[OsmAnd Atlas] Could not remove helper configuration:', error); }
    }
  }

  private async renderQueued(longitude: number, latitude: number, zoom: number): Promise<Buffer> {
    try {
      if (this.retired) throw new Error('OsmAnd Atlas helper worker has been replaced.');
      await this.ensureStarted();
      return await this.renderOnce(longitude, latitude, zoom);
    } catch (error) {
      await this.shutdown();
      throw error;
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && this.child.exitCode === null && this.reader) return;
    if (!existsSync(this.helperPath)) throw new Error('OsmAnd Atlas render helper not found: ' + this.helperPath);
    if (!this.obfPaths.length) throw new Error('No enabled OsmAnd OBF maps are selected.');
    for (const path of this.obfPaths) {
      if (!existsSync(path)) throw new Error('OsmAnd OBF map not found: ' + path);
    }
    if (!existsSync(this.resourcesPath)) throw new Error('OsmAnd resources not found: ' + this.resourcesPath);
    if (!existsSync(this.stylePath)) throw new Error('OsmAnd rendering style not found: ' + this.stylePath);

    const spawnStartedAt = Date.now();
    const configurationDirectory = mkdtempSync(join(tmpdir(), 'lumascope-osmand-atlas-'));
    const configurationPath = join(configurationDirectory, 'obf-paths.json');
    try {
      writeFileSync(configurationPath, JSON.stringify(this.obfPaths), 'utf8');
    } catch (error) {
      rmSync(configurationDirectory, { recursive: true, force: true });
      throw error;
    }
    this.configurationDirectory = configurationDirectory;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.helperPath, [configurationPath, this.resourcesPath, this.stylePath, String(this.displayScale)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: this.environment
      });
    } catch (error) {
      this.cleanupConfigurationFile();
      throw error;
    }
    this.child = child;
    child.once('close', () => this.cleanupConfigurationFile());
    child.once('error', () => this.cleanupConfigurationFile());
    this.reader = new AtlasOutputReader(child.stdout, child);
    this.stderrBuffer = '';
    child.stderr.on('data', chunk => {
      this.stderrBuffer += String(chunk);
      const lines = this.stderrBuffer.split(/\r?\n/);
      this.stderrBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const message = line.trim();
        // The native renderer emits enormous INFO-level OpenGL capability
        // dumps on every worker start. Keep warnings/errors, suppress routine info.
        if (!message) continue;
        if (message.startsWith('ATLAS_INIT ')) {
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

  private async renderOnce(longitude: number, latitude: number, zoom: number): Promise<Buffer> {
    const requestId = this.nextRequestId;
    this.nextRequestId = (this.nextRequestId + 1) >>> 0;
    if (this.nextRequestId === 0) this.nextRequestId = 1;
    const child = this.child;
    const reader = this.reader;
    if (!child || !child.stdin.writable || !reader) throw new Error('OsmAnd Atlas helper streams are unavailable.');

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
    if (status !== 0) throw new Error(payload.toString('utf8') || 'OsmAnd Atlas rendering failed.');
    if (width !== METATILE_SIZE || height !== METATILE_SIZE || stride !== METATILE_SIZE * 4
      || pixelFormat !== 1 || payloadSize !== TILE_BYTES) {
      throw new Error('OsmAnd Atlas helper returned unexpected RGBA8 frame dimensions or format.');
    }
    return payload;
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
  private readonly localAppData = process.env.LOCALAPPDATA || app.getPath('appData');
  private readonly cachePath = join(this.localAppData, 'LumaScope', 'cache', 'maps', 'obf');
  private readonly helperPath = join(process.resourcesPath, 'osmand', 'helpers', 'osmand_atlas_render_helper.exe');
  private readonly resourcesPath = join(process.resourcesPath, 'osmand', 'resources');
  private styleFileName = this.readSavedStyleFileName();
  private stylePath = join(this.resourcesPath, 'rendering_styles', this.styleFileName);
  private obfPaths: string[] = this.getFallbackObfPaths();
  private obfRefresh: Promise<void> = Promise.resolve();
  private readonly environment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [dirname(this.helperPath), process.env.PATH || ''].filter(Boolean).join(delimiter)
  };
  private displayScale = 1.0;
  private scaleChange: Promise<void> = Promise.resolve();
  private workers = this.createWorkers();
  private nextWorker = 0;
  private readonly pendingTiles = new Map<string, Promise<Buffer>>();
  private temporaryFileId = 0;

  constructor() {
    app.once('will-quit', () => { for (const worker of this.workers) void worker.shutdown(); });
  }

  private readSavedStyleFileName(): string {
    const osmand = readAppSettings().osmand as Record<string, unknown> | undefined;
    const atlas = osmand?.atlas as Record<string, unknown> | undefined;
    let fileName = atlas?.renderingStyle;
    if (typeof fileName !== 'string') {
      try {
        const legacyPath = join(app.getPath('userData'), 'osmand-atlas-settings.json');
        const legacy = JSON.parse(readFileSync(legacyPath, 'utf8')) as { styleFileName?: unknown };
        fileName = legacy.styleFileName;
        if (typeof fileName === 'string' && /^[a-zA-Z0-9_(). -]+\.render\.xml$/.test(fileName)) {
          this.persistStyleFileName(fileName);
        }
      } catch { /* No legacy Atlas style setting. */ }
    }
    return typeof fileName === 'string' && /^[a-zA-Z0-9_(). -]+\.render\.xml$/.test(fileName)
      ? fileName : 'default.render.xml';
  }

  private persistStyleFileName(fileName: string): void {
    void updateAppSettingsSection('osmand', { atlas: { renderingStyle: fileName } })
      .catch(error => console.warn('[OsmAnd Atlas] Could not persist rendering style:', error));
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
        const settings = (readAppSettings().offlineMaps ?? {}) as {
          obfPaths?: unknown; enabledByPath?: Record<string, unknown>;
        };
        if (Array.isArray(settings.obfPaths)) {
          const paths = settings.obfPaths.filter((value): value is string => typeof value === 'string');
          selectedPaths = paths.filter(path => settings.enabledByPath?.[path] !== false && existsSync(path));
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

  @IpcHandler({ name: 'OsmAndAtlas.getRenderingStyles' })
  readonly getRenderingStyles = async () => {
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
    const selectedFileName = fileNames.includes(this.styleFileName)
      ? this.styleFileName
      : fileNames.includes('default.render.xml') ? 'default.render.xml' : fileNames.sort()[0];
    if (!selectedFileName) return [];
    if (selectedFileName !== this.styleFileName) {
      this.styleFileName = selectedFileName;
      this.stylePath = join(styleDirectory, selectedFileName);
      this.persistStyleFileName(selectedFileName);
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
      this.styleFileName = resolvedFileName;
      this.stylePath = join(this.resourcesPath, 'rendering_styles', resolvedFileName);
      this.persistStyleFileName(resolvedFileName);
      await this.replaceWorkers();
    }
    return this.getRuntimeStatus();
  };

  @IpcHandler({ name: 'OsmAndAtlas.getRuntimeStatus' })
  readonly getRuntimeStatus = async () => {
    await this.refreshSelectedObf();
    return ({
    helperPath: this.helperPath,
    helperAvailable: existsSync(this.helperPath),
    obfPath: this.obfPaths.join('; '),
    obfPaths: [...this.obfPaths],
    obfAvailable: this.obfPaths.length > 0 && this.obfPaths.every(path => existsSync(path)),
    resourcesPath: this.resourcesPath,
    resourcesAvailable: existsSync(this.resourcesPath),
    stylePath: this.stylePath,
    styleAvailable: existsSync(this.stylePath)
    });
  };

  @IpcHandler({ name: 'OsmAndAtlas.renderTile' })
  readonly renderTile = async (event: Electron.IpcMainInvokeEvent, z: number, x: number, y: number, requestedDisplayScale?: number): Promise<OsmAndAtlasTileResult> => {
    await this.refreshSelectedObf();
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
    if (!this.workers.length) throw new Error('No enabled OsmAnd OBF maps are selected.');

    const mapCacheKey = this.obfPaths.length
      ? createHash('sha256').update(this.obfPaths.join('\\0')).digest('hex').slice(0, 20)
      : 'default';
    const densityCacheKey = displayScale.toFixed(3).replace('.', '_');
    const styleCacheKey = this.styleFileName
      .replace(/\\.render\\.xml$/i, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .toLowerCase();
    const cacheFile = join(
      this.cachePath, mapCacheKey, densityCacheKey, styleCacheKey,
      String(z), String(metatileX), metatileY + '.png'
    );

    let metatilePixels = await this.readCachedTile(cacheFile);
    if (!metatilePixels) {
      let pending = this.pendingTiles.get(cacheFile);
      if (!pending) {
        pending = this.renderAndCacheTile(z, metatileX, metatileY, cacheFile);
        this.pendingTiles.set(cacheFile, pending);
        void pending.finally(() => {
          if (this.pendingTiles.get(cacheFile) === pending) this.pendingTiles.delete(cacheFile);
        }).catch(() => undefined);
      }
      metatilePixels = await pending;
    }
    return { width: METATILE_SIZE, height: METATILE_SIZE, stride: METATILE_SIZE * 4, pixels: new Uint8Array(metatilePixels) };
  };

  @IpcHandler({ name: 'OsmAndAtlas.shutdown' })
  readonly shutdown = async (): Promise<void> => {
    await this.retireWorkers();
  };

  private async renderAndCacheTile(z: number, metatileX: number, metatileY: number, cacheFile: string): Promise<Buffer> {
    // The 2x2 metatile centre is one XYZ tile east and south of its NW corner.
    const longitude = (metatileX + 1) / (2 ** z) * 360 - 180;
    const mercatorY = Math.PI * (1 - 2 * (metatileY + 1) / (2 ** z));
    const latitude = Math.atan(Math.sinh(mercatorY)) * 180 / Math.PI;
    if (!this.workers.length) throw new Error('No enabled OsmAnd OBF maps are selected.');
    const worker = this.workers[this.nextWorker++ % this.workers.length];
    // 1024px at helper zoom z-1 yields a geographic span of exactly 2x2 XYZ tiles.
    const pixels = await worker.render(longitude, latitude, z - 1);

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
    return pixels;
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
      return rgba;
    } catch {
      await unlink(path).catch(() => undefined);
      return null;
    }
  }
}
