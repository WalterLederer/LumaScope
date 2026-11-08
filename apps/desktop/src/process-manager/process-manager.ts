import { app, IpcMainInvokeEvent, shell } from 'electron';
import { SystemPathMapping } from 'internal-api';
import { stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import App from '../app/app';
import { IpcHandler } from '../app/decorators/ipc-handler';
import { environment } from '../environments/environment';
import { readAppSettings, updateAppSettingsSection } from '../settings/app-settings';

export class ProcessManager {
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
