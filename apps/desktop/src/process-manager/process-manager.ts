import { app, IpcMainInvokeEvent, shell } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ProcessMemorySnapshot, SystemPathMapping } from 'internal-api';
import { stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import App from '../app/app';
import { IpcHandler } from '../app/decorators/ipc-handler';
import { environment } from '../environments/environment';
import { readAppSettings, updateAppSettingsSection } from '../settings/app-settings';

const execFileAsync = promisify(execFile);

export class ProcessManager {
  @IpcHandler({ name: 'ProcessManager.getProcessMemoryUsage' })
  readonly getProcessMemoryUsage = async (): Promise<ProcessMemorySnapshot> => {
    const mainMemory = process.memoryUsage();
    const processes: ProcessMemorySnapshot['processes'] = [{
      name: 'LumaScope (Main)',
      pid: process.pid,
      kind: 'main',
      workingSetBytes: mainMemory.rss,
      privateBytes: null
    }];
    const knownHelpers = new Map([
      ['osmand_render_helper', { name: 'OsmAnd Helper', kind: 'helper' as const }],
      ['osmand_render_helper.exe', { name: 'OsmAnd Helper', kind: 'helper' as const }],
      ['osmand_atlas_render_helper', { name: 'OsmAnd Atlas Helper', kind: 'helper' as const }],
      ['osmand_atlas_render_helper.exe', { name: 'OsmAnd Atlas Helper', kind: 'helper' as const }]
    ]);
    const appExecutable = process.platform === 'win32' ? `${app.getName()}.exe` : app.getName();
    const isAppProcess = (name: string): boolean =>
      name.toLowerCase() === appExecutable.toLowerCase()
      || name.toLowerCase() === app.getName().toLowerCase();

    try {
      if (process.platform === 'win32') {
        // tasklist is part of Windows; unlike the former implementation this
        // does not require PowerShell. It reports working-set memory only.
        const { stdout } = await execFileAsync('tasklist.exe', ['/FO', 'CSV', '/NH'], {
          windowsHide: true,
          timeout: 5000,
          maxBuffer: 4 * 1024 * 1024
        });
        for (const line of stdout.split(/\r?\n/)) {
          const fields = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map(match => match[1].replace(/""/g, '"'));
          if (fields.length < 5) continue;
          const imageName = fields[0];
          const pid = Number(fields[1].replace(/,/g, ''));
          const memoryText = fields[4];
          const memoryKb = Number(memoryText.replace(/[^0-9]/g, ''));
          if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(memoryKb)) continue;
          const helper = knownHelpers.get(imageName.toLowerCase());
          if (!helper && !isAppProcess(imageName)) continue;
          if (pid === process.pid) {
            processes[0].workingSetBytes = memoryKb * 1024;
            continue;
          }
          processes.push({
            name: helper?.name ?? 'LumaScope (Process)',
            pid,
            kind: helper?.kind ?? 'app',
            workingSetBytes: memoryKb * 1024,
            privateBytes: null
          });
        }
      } else if (process.platform === 'linux') {
        const entries = await fs.readdir('/proc', { withFileTypes: true });
        const pageSize = 4096;
        for (const entry of entries) {
          if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
          const pid = Number(entry.name);
          try {
            const name = (await fs.readFile(`/proc/${entry.name}/comm`, 'utf8')).trim();
            const helper = knownHelpers.get(name.toLowerCase());
            if (!helper && !isAppProcess(name)) continue;
            const statm = (await fs.readFile(`/proc/${entry.name}/statm`, 'utf8')).trim().split(/\s+/);
            const residentPages = Number(statm[1]);
            if (!Number.isFinite(residentPages)) continue;
            let privateBytes: number | null = null;
            try {
              const rollup = await fs.readFile(`/proc/${entry.name}/smaps_rollup`, 'utf8');
              const privateKb = [...rollup.matchAll(/^Private_(?:Clean|Dirty|Hugetlb):\s+(\d+)\s+kB$/gm)]
                .reduce((total, match) => total + Number(match[1]), 0);
              privateBytes = privateKb * 1024;
            } catch {
              // smaps_rollup may be restricted; resident memory is still available.
            }
            if (pid === process.pid) {
              processes[0].workingSetBytes = residentPages * pageSize;
              processes[0].privateBytes = privateBytes;
              continue;
            }
            processes.push({
              name: helper?.name ?? 'LumaScope (Process)',
              pid,
              kind: helper?.kind ?? 'app',
              workingSetBytes: residentPages * pageSize,
              privateBytes
            });
          } catch {
            // Processes may exit or become inaccessible while the snapshot is collected.
          }
        }
      } else if (process.platform === 'darwin') {
        const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,rss=,comm='], {
          timeout: 5000,
          maxBuffer: 4 * 1024 * 1024
        });
        for (const line of stdout.split(/\r?\n/)) {
          const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
          if (!match) continue;
          const pid = Number(match[1]);
          const workingSetBytes = Number(match[2]) * 1024;
          const executable = match[3].split('/').pop() ?? match[3];
          const helper = knownHelpers.get(executable.toLowerCase());
          if (!helper && !isAppProcess(executable)) continue;
          if (pid === process.pid) {
            processes[0].workingSetBytes = workingSetBytes;
            continue;
          }
          processes.push({
            name: helper?.name ?? 'LumaScope (Process)',
            pid,
            kind: helper?.kind ?? 'app',
            workingSetBytes,
            privateBytes: null
          });
        }
      }
      return { processes, error: null };
    } catch (error) {
      return {
        processes,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  };

  @IpcHandler({ name: 'ProcessManager.getAppSettings' })
  readonly getAppSettings = async (): Promise<Record<string, unknown>> => readAppSettings();

  @IpcHandler({ name: 'ProcessManager.setAppSettingsSection' })
  readonly setAppSettingsSection = async (_: IpcMainInvokeEvent, section: string, values: Record<string, unknown>): Promise<void> => {
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Settings values must be an object.');
    await updateAppSettingsSection(section, values);
  };

  @IpcHandler({ name: 'MapWindow.getZoom' })
  readonly getMapZoom = async (): Promise<number> => {
    const mapWindow = readAppSettings().mapWindow as Record<string, unknown> | undefined;
    let zoom = mapWindow?.zoom;
    if (typeof zoom !== 'number' || !Number.isFinite(zoom)) {
      // One-time compatibility read for installations using the former file.
      try {
        const legacyPath = join(app.getPath('userData'), 'map-window-settings.json');
        if (existsSync(legacyPath)) {
          const legacy = JSON.parse(readFileSync(legacyPath, 'utf8')) as { zoom?: unknown };
          zoom = legacy.zoom;
          if (typeof zoom === 'number' && Number.isFinite(zoom)) {
            await updateAppSettingsSection('mapWindow', { zoom: Math.max(1, Math.min(20, Math.round(zoom))) });
          }
        }
      } catch (error) {
        console.warn('[MapWindow] Could not migrate legacy zoom setting:', error);
      }
    }
    return typeof zoom === 'number' && Number.isFinite(zoom)
      ? Math.max(1, Math.min(20, Math.round(zoom))) : 13;
  };

  @IpcHandler({ name: 'MapWindow.setZoom' })
  readonly setMapZoom = async (_: IpcMainInvokeEvent, value: number): Promise<void> => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    await updateAppSettingsSection('mapWindow', { zoom: Math.max(1, Math.min(20, Math.round(value))) });
  };

  @IpcHandler({ name: 'ProcessManager.getAppVersion' })
  readonly getAppVersion = async (): Promise<string> => {
    try {
      const { mtime } = await stat(process.execPath);
      return `${environment.version} ${mtime.toLocaleString('de-AT')}`;
    } catch (_) {
      return environment.version;
    }
  };

  @IpcHandler({ name: 'ProcessManager.quit' })
  readonly quit = async (_: IpcMainInvokeEvent, code: number): Promise<void> => app.exit(code);

  @IpcHandler({ name: 'ProcessManager.setWindowTitle' })
  readonly setWindowTitle = async (_: IpcMainInvokeEvent, suffix: string): Promise<void> => {
    App.mainWindow?.setTitle(App.windowTitle(suffix));
  };

  @IpcHandler({ name: 'ProcessManager.isPackaged' })
  readonly isPackaged = async (): Promise<boolean> => {
    console.log('[ProcessManager.isPackaged] Handler START');
    const result = App.application.isPackaged;
    console.log('[ProcessManager.isPackaged] Handler DONE', result);
    return result;
  };

  @IpcHandler({ name: 'ProcessManager.getDevToolsOpen' })
  readonly getDevToolsOpen = async (): Promise<boolean> => App.startupConfig.devToolsOpen();

  @IpcHandler({ name: 'ProcessManager.setDevToolsOpen' })
  readonly setDevToolsOpen = async (_: IpcMainInvokeEvent, open: boolean): Promise<void> => {
    await App.setDevToolsOpen(open === true);
  };

  @IpcHandler({ name: 'ProcessManager.openExternal' })
  readonly openExternal = async (_: IpcMainInvokeEvent, url: string): Promise<void> => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('Only HTTPS URLs can be opened externally.');
    await shell.openExternal(parsed.toString());
  };

  @IpcHandler({ name: 'ProcessManager.openPath' })
  readonly openPath = async (_: IpcMainInvokeEvent, filePath: string): Promise<string> => shell.openPath(filePath);

  @IpcHandler({ name: 'ProcessManager.openConfigFile' })
  readonly openConfigFile = async (): Promise<string> => shell.openPath(App.startupConfig.configPath());

  @IpcHandler({ name: 'ProcessManager.getPlatform' })
  readonly getPlatform = async (): Promise<string> => process.platform;

  @IpcHandler({ name: 'ProcessManager.argv' })
  readonly argv = async () => yargs(hideBin(process.argv)).parse();

  @IpcHandler({ name: 'ProcessManager.getSystemPaths' })
  readonly getSystemPaths = async (): Promise<SystemPathMapping> => {
    const getPath = (name: Parameters<typeof app.getPath>[0]): string => {
      try {
        return App.application.getPath(name);
      } catch (_) {
        return '';
      }
    };

    return {
      home: getPath('home'),
      appData: getPath('appData'),
      userData: getPath('userData'),
      temp: getPath('temp'),
      exe: getPath('exe'),
      desktop: getPath('desktop'),
      documents: getPath('documents'),
      downloads: getPath('downloads'),
      music: getPath('music'),
      pictures: getPath('pictures'),
      videos: getPath('videos'),
      recent: getPath('recent'),
      appConfig: App.startupConfig.configPath()
    };
  };
}
