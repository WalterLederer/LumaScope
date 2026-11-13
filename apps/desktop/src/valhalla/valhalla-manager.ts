import { app, dialog, type IpcMainInvokeEvent } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
import { IpcHandler } from '../app/decorators/ipc-handler';
import { readAppSettings, updateAppSettingsSection } from '../settings/app-settings';

export type ValhallaRouteProfile = 'driving-car' | 'cycling-regular' | 'foot-walking';

export interface ValhallaRoutePoint {
  latitude: number;
  longitude: number;
}

export interface ValhallaRouteRequest {
  points: ValhallaRoutePoint[];
  profile: ValhallaRouteProfile;
}

export interface ValhallaRouteResult {
  provider: 'offline-valhalla';
  coordinates: ValhallaRoutePoint[];
}

export interface ValhallaConfigEntry {
  path: string;
  name: string;
  available: boolean;
}

export interface ValhallaRuntimeStatus {
  helperPath: string;
  helperAvailable: boolean;
  configPath: string;
  configAvailable: boolean;
  configurations: ValhallaConfigEntry[];
  running: boolean;
}

type LineWaiter = {
  resolve: (line: string) => void;
  reject: (error: Error) => void;
};

class ProcessLineReader {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private readonly waiters: LineWaiter[] = [];
  private failure: Error | null = null;

  constructor(stream: NodeJS.ReadableStream, child: ChildProcessWithoutNullStreams) {
    stream.on('data', (chunk: Buffer | string) => {
      if (this.failure) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
      this.drain();
    });
    child.once('error', error => this.fail(error));
    child.once('close', (code, signal) => {
      this.fail(new Error('Valhalla helper exited (code ' + String(code) + ', signal ' + String(signal) + ').'));
    });
  }

  readLine(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
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
      const newline = this.buffer.indexOf(10);
      if (newline < 0) return;
      const line = this.buffer.subarray(0, newline).toString('utf8').trim();
      this.buffer = this.buffer.subarray(newline + 1);
      this.waiters.shift()!.resolve(line);
    }
  }
}

interface ValhallaResponse {
  error?: string;
  status?: number;
  status_message?: string;
  trip?: {
    status?: number;
    status_message?: string;
    legs?: Array<{ shape?: string }>;
  };
}

export class ValhallaManager {
  private readonly helperPath = this.resolveHelperPath();
  private configPath = this.readSavedConfigPath();
  private configurations = this.readSavedConfigurations();
  private child: ChildProcessWithoutNullStreams | null = null;
  private reader: ProcessLineReader | null = null;
  private stderr = '';
  private queue: Promise<void> = Promise.resolve();

  constructor() {
    app.once('will-quit', () => { void this.stop(); });
  }

  private resolveHelperPath(): string {
    const configured = process.env.LUMASCOPE_VALHALLA_HELPER;
    if (configured) return configured;

    if (app.isPackaged) {
      return join(process.resourcesPath, 'valhalla', 'helpers', 'valhalla_route_helper.exe');
    }

    return join(process.cwd(), '..', 'Valhalla', 'build-release', 'RelWithDebInfo', 'valhalla_route_helper.exe');
  }

  private readSavedConfigPath(): string {
    const settings = readAppSettings().valhalla as Record<string, unknown> | undefined;
    const configured = settings?.configPath;
    return typeof configured === 'string' ? configured : (process.env.LUMASCOPE_VALHALLA_CONFIG || '');
  }

  private readSavedConfigurations(): ValhallaConfigEntry[] {
    const settings = readAppSettings().valhalla as Record<string, unknown> | undefined;
    const saved = Array.isArray(settings?.configurations) ? settings.configurations : [];
    const entries = saved.flatMap((item: unknown) => {
      if (!item || typeof item !== 'object') return [];
      const value = item as Record<string, unknown>;
      if (typeof value['path'] !== 'string' || !value['path'].trim()) return [];
      const path = value['path'].trim();
      return [{ path, name: typeof value['name'] === 'string' ? value['name'] : basename(dirname(path)), available: existsSync(path) }];
    });
    if (this.configPath && !entries.some(entry => entry.path.toLowerCase() === this.configPath.toLowerCase())) {
      entries.unshift({ path: this.configPath, name: basename(dirname(this.configPath)), available: existsSync(this.configPath) });
    }
    return entries;
  }

  private async persistConfigurations(): Promise<void> {
    await updateAppSettingsSection('valhalla', {
      configPath: this.configPath || undefined,
      configurations: this.configurations.map(({ path, name }) => ({ path, name }))
    });
  }

  @IpcHandler({ name: 'Valhalla.getRuntimeStatus' })
  readonly getRuntimeStatus = async (): Promise<ValhallaRuntimeStatus> => ({
    helperPath: this.helperPath,
    helperAvailable: existsSync(this.helperPath),
    configPath: this.configPath,
    configAvailable: !!this.configPath && existsSync(this.configPath),
    configurations: this.configurations.map(entry => ({ ...entry, available: existsSync(entry.path) })),
    running: !!this.child && this.child.exitCode === null
  });

  @IpcHandler({ name: 'Valhalla.setConfigPath' })
  readonly setConfigPath = async (_event: IpcMainInvokeEvent, configPath: string): Promise<ValhallaRuntimeStatus> => {
    if (typeof configPath !== 'string' || !configPath.trim() || !existsSync(configPath.trim())) {
      throw new Error('Select an existing Valhalla configuration file.');
    }
    const resolvedPath = configPath.trim();
    await this.stop();
    this.configPath = resolvedPath;
    if (!this.configurations.some(entry => entry.path.toLowerCase() === resolvedPath.toLowerCase())) {
      this.configurations.push({ path: resolvedPath, name: basename(dirname(resolvedPath)), available: true });
    }
    await this.persistConfigurations();
    return this.getRuntimeStatus();
  };

  @IpcHandler({ name: 'Valhalla.addConfig' })
  readonly addConfig = async (): Promise<ValhallaRuntimeStatus> => {
    const result = await dialog.showOpenDialog({
      title: 'Add Valhalla routing configuration',
      properties: ['openFile'],
      filters: [{ name: 'Valhalla configuration', extensions: ['json'] }]
    });
    if (result.canceled || result.filePaths.length === 0) return this.getRuntimeStatus();
    const selectedPath = result.filePaths[0];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(selectedPath, 'utf8'));
    } catch (error) {
      throw new Error('The selected file is not valid JSON: ' + (error instanceof Error ? error.message : String(error)));
    }
    if (!parsed || typeof parsed !== 'object' || !('mjolnir' in parsed)) {
      throw new Error('The selected JSON does not look like a Valhalla configuration (missing "mjolnir").');
    }
    if (!this.configurations.some(entry => entry.path.toLowerCase() === selectedPath.toLowerCase())) {
      this.configurations.push({ path: selectedPath, name: basename(dirname(selectedPath)), available: true });
      await this.persistConfigurations();
    }
    return this.getRuntimeStatus();
  };

  @IpcHandler({ name: 'Valhalla.removeConfig' })
  readonly removeConfig = async (_event: IpcMainInvokeEvent, configPath: string): Promise<ValhallaRuntimeStatus> => {
    const target = typeof configPath === 'string' ? configPath.trim() : '';
    if (!target) throw new Error('Select a Valhalla configuration to remove.');
    this.configurations = this.configurations.filter(entry => entry.path.toLowerCase() !== target.toLowerCase());
    if (this.configPath.toLowerCase() === target.toLowerCase()) {
      await this.stop();
      this.configPath = this.configurations[0]?.path ?? '';
    }
    await this.persistConfigurations();
    return this.getRuntimeStatus();
  };

  @IpcHandler({ name: 'Valhalla.route' })
  readonly route = async (_event: Electron.IpcMainInvokeEvent, request: ValhallaRouteRequest): Promise<ValhallaRouteResult> => {
    this.validateRequest(request);
    const operation = this.queue.then(() => this.routeQueued(request));
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  };

  @IpcHandler({ name: 'Valhalla.shutdown' })
  readonly shutdown = async (): Promise<void> => {
    await this.stop();
  };

  private validateRequest(request: ValhallaRouteRequest): void {
    if (!request || !Array.isArray(request.points) || request.points.length < 2 || request.points.length > 50) {
      throw new Error('Valhalla routing requires between 2 and 50 active route points.');
    }
    if (!['driving-car', 'cycling-regular', 'foot-walking'].includes(request.profile)) {
      throw new Error('Unsupported Valhalla route profile: ' + String(request.profile));
    }
    for (const point of request.points) {
      if (!point || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)
        || point.latitude < -90 || point.latitude > 90 || point.longitude < -180 || point.longitude > 180) {
        throw new Error('Valhalla received an invalid route coordinate.');
      }
    }
  }

  private async routeQueued(request: ValhallaRouteRequest): Promise<ValhallaRouteResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.ensureStarted();
        const costing = request.profile === 'driving-car'
          ? 'auto'
          : request.profile === 'cycling-regular' ? 'bicycle' : 'pedestrian';
        const payload: Record<string, unknown> = {
          locations: request.points.map(point => ({ lat: point.latitude, lon: point.longitude })),
          costing,
          units: 'kilometers'
        };
        if (costing === 'auto') {
          payload.costing_options = { auto: { height: 1.4 } };
        }

        await this.writeRequest(payload);
        const reader = this.reader;
        if (!reader) throw new Error('Valhalla helper output stream is unavailable.');
        const raw = await this.withTimeout(reader.readLine(), 120000, 'Valhalla route calculation timed out.');
        let response: ValhallaResponse;
        try {
          response = JSON.parse(raw) as ValhallaResponse;
        } catch {
          throw new Error('Valhalla helper returned invalid JSON: ' + raw.slice(0, 500));
        }
        if (response.error) throw new Error(response.error);
        if (response.status !== undefined && response.status !== 0) {
          throw new Error(response.status_message || ('Valhalla route failed with status ' + response.status + '.'));
        }

        if (response.trip?.status !== undefined && response.trip.status !== 0) {
          throw new Error(response.trip.status_message || ('Valhalla route failed with status ' + response.trip.status + '.'));
        }
        const legs = response.trip?.legs;
        if (!Array.isArray(legs) || !legs.length) {
          throw new Error(response.status_message || 'Valhalla returned no route legs.');
        }
        const coordinates: ValhallaRoutePoint[] = [];
        for (const leg of legs) {
          if (typeof leg.shape !== 'string' || !leg.shape) {
            throw new Error('Valhalla returned a route leg without geometry.');
          }
          const decoded = this.decodePolyline6(leg.shape);
          for (const point of decoded) {
            const previous = coordinates[coordinates.length - 1];
            if (!previous || previous.latitude !== point.latitude || previous.longitude !== point.longitude) {
              coordinates.push(point);
            }
          }
        }
        if (coordinates.length < 2) throw new Error('Valhalla returned fewer than two route coordinates.');
        return { provider: 'offline-valhalla', coordinates };
      } catch (error) {
        await this.stop();
        if (attempt === 1) throw error;
      }
    }
    throw new Error('Valhalla route calculation failed.');
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && this.child.exitCode === null && this.reader) return;
    if (!existsSync(this.helperPath)) throw new Error('Valhalla route helper not found: ' + this.helperPath);
    if (!this.configPath || !existsSync(this.configPath)) {
      throw new Error('Select a valid Valhalla configuration file first.');
    }

    const helperDirectory = dirname(this.helperPath);
    const buildDirectory = dirname(helperDirectory);
    const environment = {
      ...process.env,
      PATH: [
        helperDirectory,
        join(buildDirectory, 'Release'),
        join(buildDirectory, 'src', 'Release'),
        join(buildDirectory, 'vcpkg_installed', 'x64-windows-release', 'bin'),
        join(buildDirectory, 'vcpkg', 'installed', 'x64-windows-release', 'bin'),
        process.env.PATH || ''
      ].filter(Boolean).join(delimiter)
    };
    const child = spawn(this.helperPath, [this.configPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: environment
    });
    this.child = child;
    this.reader = new ProcessLineReader(child.stdout, child);
    this.stderr = '';
    child.stderr.on('data', chunk => {
      this.stderr = (this.stderr + String(chunk)).slice(-8000);
    });

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  }

  private async writeRequest(value: Record<string, unknown>): Promise<void> {
    const child = this.child;
    if (!child || !child.stdin.writable) throw new Error('Valhalla helper input stream is unavailable.');
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(JSON.stringify(value) + '\n', error => error ? reject(error) : resolve());
    });
  }

  private decodePolyline6(encoded: string): ValhallaRoutePoint[] {
    const points: ValhallaRoutePoint[] = [];
    let index = 0;
    let latitude = 0;
    let longitude = 0;

    const readDelta = (): number => {
      let result = 0;
      let shift = 0;
      let byte: number;
      do {
        if (index >= encoded.length) throw new Error('Valhalla returned a truncated encoded polyline.');
        byte = encoded.charCodeAt(index++) - 63;
        if (byte < 0 || byte > 63 || shift > 30) throw new Error('Valhalla returned an invalid encoded polyline.');
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      return (result & 1) ? ~(result >> 1) : (result >> 1);
    };

    while (index < encoded.length) {
      latitude += readDelta();
      longitude += readDelta();
      points.push({ latitude: latitude / 1e6, longitude: longitude / 1e6 });
    }
    return points;
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

  private async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.reader = null;
    if (child && child.exitCode === null) {
      child.kill();
    }
  }
}
