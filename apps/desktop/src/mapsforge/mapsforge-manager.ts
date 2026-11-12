import { app, type IpcMainInvokeEvent } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { IpcHandler } from '../app/decorators/ipc-handler';

interface MapsforgeResponse {
  status: 'ok' | 'error';
  command?: string;
  message?: string;
  request_id?: number;
  [key: string]: unknown;
}

class MapsforgeWorkerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private pending: Array<{ resolve: (value: MapsforgeResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  private queue: Promise<void> = Promise.resolve();
  private nextRequestId = 1;
  private starting: Promise<void> | null = null;

  constructor(private readonly javaPath: string, private readonly jarPath: string, private readonly environment: NodeJS.ProcessEnv) {}

  request(command: string, values: Record<string, unknown> = {}): Promise<MapsforgeResponse> {
    const result = this.queue.then(async () => {
      await this.ensureStarted();
      return this.sendRequest(command, values);
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async shutdown(): Promise<void> {
    await this.queue.catch(() => undefined);
    const child = this.child;
    if (!child) return;
    this.child = null;
    if (child.exitCode !== null || child.killed) return;
    try {
      if (child.stdin.writable && !child.stdin.destroyed) child.stdin.write(JSON.stringify({ command: 'quit' }) + '\n');
    } catch { /* The process may already be closing. */ }
    await new Promise<void>(resolve => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(resolve, 1500);
      child.once('close', () => { clearTimeout(timer); resolve(); });
    });
    if (child.exitCode === null) child.kill();
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && this.child.exitCode === null && this.child.stdin.writable && !this.child.stdin.destroyed) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (!existsSync(this.jarPath)) {
        throw new Error('Mapsforge renderer JAR not found: ' + this.jarPath
          + '. Build it with Maven: mvn -f tools/mapsforge-renderer/pom.xml package.');
      }
      const child = spawn(this.javaPath, ['-Djava.awt.headless=true', '-jar', this.jarPath, '--worker'], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this.environment
      });
      this.child = child;
      this.stdoutBuffer = '';
      this.stderrBuffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => this.readStdout(String(chunk)));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        this.stderrBuffer += String(chunk);
        if (this.stderrBuffer.length > 16000) this.stderrBuffer = this.stderrBuffer.slice(-16000);
      });
      child.stdin.on('error', error => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EPIPE' && code !== 'ERR_STREAM_DESTROYED') console.warn('[Mapsforge] Worker stdin error:', error);
      });
      child.once('error', error => this.failPending(error));
      child.once('close', (code, signal) => {
        const details = this.stderrBuffer.trim();
        this.failPending(new Error('Mapsforge worker exited (code ' + String(code) + ', signal ' + String(signal) + ').'
          + (details ? ' ' + details : '')));
        if (this.child === child) this.child = null;
      });
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
    })();
    try { await this.starting; } finally { this.starting = null; }
  }

  private readStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (this.stdoutBuffer.length > 128 * 1024 * 1024) {
      this.failPending(new Error('Mapsforge worker response exceeded the 128 MB line limit.'));
      this.child?.kill();
      this.stdoutBuffer = '';
      return;
    }
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      const waiter = this.pending.shift();
      if (!waiter) {
        console.warn('[Mapsforge] Ignoring unsolicited worker output:', line.slice(0, 500));
        continue;
      }
      clearTimeout(waiter.timer);
      try {
        const response = JSON.parse(line) as MapsforgeResponse;
        if (response.status === 'error') waiter.reject(new Error(String(response.message ?? 'Mapsforge worker request failed.')));
        else waiter.resolve(response);
      } catch (error) {
        waiter.reject(new Error('Invalid JSON response from Mapsforge worker: ' + (error instanceof Error ? error.message : String(error))));
      }
    }
  }

  private failPending(error: Error): void {
    while (this.pending.length) {
      const waiter = this.pending.shift()!;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private async sendRequest(command: string, values: Record<string, unknown>): Promise<MapsforgeResponse> {
    const child = this.child;
    if (!child || !child.stdin.writable || child.stdin.destroyed || child.stdin.writableEnded) {
      throw new Error('Mapsforge worker streams are unavailable.');
    }
    const requestId = this.nextRequestId++;
    const response = new Promise<MapsforgeResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.pending.findIndex(item => item.timer === timer);
        if (index >= 0) this.pending.splice(index, 1);
        reject(new Error('Mapsforge worker timed out while handling "' + command + '".'));
        child.kill();
      }, command === 'catalog' ? 120000 : command === 'open' ? 60000 : 30000);
      this.pending.push({ resolve, reject, timer });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(JSON.stringify({ command, request_id: requestId, ...values }) + '\n',
          error => error ? reject(error) : resolve());
      });
    } catch (error) {
      const waiter = this.pending.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    const result = await response;
    if (result.request_id !== undefined && Number(result.request_id) !== requestId) {
      throw new Error('Mapsforge worker response ID mismatch.');
    }
    return result;
  }
}

export class MapsforgeManager {
  private readonly jarCandidates = [
    join(process.resourcesPath, 'mapsforge', 'mapsforge-renderer.jar'),
    join(process.cwd(), 'tools', 'mapsforge-renderer', 'target', 'mapsforge-renderer.jar'),
    join(app.getAppPath(), '..', '..', 'tools', 'mapsforge-renderer', 'target', 'mapsforge-renderer.jar'),
    join(app.getAppPath(), 'tools', 'mapsforge-renderer', 'target', 'mapsforge-renderer.jar')
  ];
  private readonly jarPath = this.jarCandidates.find(path => existsSync(path)) ?? this.jarCandidates[1];
  private readonly javaPath = process.env.JAVA_HOME
    ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
    : 'java';
  private readonly environment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [dirname(this.javaPath), process.env.PATH || ''].filter(Boolean).join(delimiter)
  };
  private readonly worker = new MapsforgeWorkerClient(this.javaPath, this.jarPath, this.environment);

  constructor() {
    app.once('will-quit', () => { void this.worker.shutdown(); });
  }

  @IpcHandler({ name: 'Mapsforge.getStatus' })
  readonly getStatus = async (): Promise<MapsforgeResponse> => this.worker.request('ping');

  @IpcHandler({ name: 'Mapsforge.scanCatalog' })
  readonly scanCatalog = async (_event: IpcMainInvokeEvent, rootPath: string): Promise<MapsforgeResponse> => {
    if (typeof rootPath !== 'string' || !rootPath.trim()) throw new Error('Select a Mapsforge map folder.');
    return this.worker.request('catalog', { root_path: rootPath.trim() });
  };

  @IpcHandler({ name: 'Mapsforge.scanThemes' })
  readonly scanThemes = async (_event: IpcMainInvokeEvent, folderPath: string): Promise<Array<{ path: string; fileName: string; relativePath: string }>> => {
    if (typeof folderPath !== 'string' || !folderPath.trim()) throw new Error('Select a Mapsforge theme folder.');
    const root = resolve(folderPath.trim());
    if (!existsSync(root)) throw new Error('Mapsforge theme folder not found: ' + root);
    const themes: Array<{ path: string; fileName: string; relativePath: string }> = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile() && /\.xml$/i.test(entry.name)) {
          themes.push({ path, fileName: entry.name, relativePath: relative(root, path) });
        }
      }
    };
    visit(root);
    return themes.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  };

  @IpcHandler({ name: 'Mapsforge.open' })
  readonly open = async (_event: IpcMainInvokeEvent, mapPaths: string[], themePath?: string | null, deviceScaleFactor?: number): Promise<MapsforgeResponse> => {
    if (!Array.isArray(mapPaths) || mapPaths.length === 0 || mapPaths.some(path => typeof path !== 'string' || !path.trim())) {
      throw new Error('Select at least one valid Mapsforge .map file.');
    }
    return this.worker.request('open', {
      map_paths: [...new Set(mapPaths.map(path => path.trim()))],
      theme_path: typeof themePath === 'string' && themePath.trim() ? themePath.trim() : null,
      device_scale_factor: Number.isFinite(deviceScaleFactor) ? Math.max(1, Math.min(4, Number(deviceScaleFactor))) : 1
    });
  };

  @IpcHandler({ name: 'Mapsforge.renderTile' })
  readonly renderTile = async (_event: IpcMainInvokeEvent, z: number, x: number, y: number): Promise<MapsforgeResponse> => {
    if (![z, x, y].every(Number.isInteger) || z < 0 || z > 22) throw new Error('Invalid Mapsforge XYZ tile coordinates.');
    const dimension = 2 ** z;
    if (x < 0 || x >= dimension || y < 0 || y >= dimension) throw new Error('Mapsforge XYZ tile coordinates are outside the selected zoom level.');
    return this.worker.request('render', { z, x, y });
  };

  @IpcHandler({ name: 'Mapsforge.close' })
  readonly close = async (): Promise<MapsforgeResponse> => this.worker.request('close');

  @IpcHandler({ name: 'Mapsforge.shutdown' })
  readonly shutdown = async (): Promise<void> => this.worker.shutdown();
}
