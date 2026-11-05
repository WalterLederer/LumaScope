import { app, IpcMainInvokeEvent, shell } from 'electron';
import { SystemPathMapping } from 'internal-api';
import { stat } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import App from '../app/app';
import { IpcHandler } from '../app/decorators/ipc-handler';
import { environment } from '../environments/environment';

export class ProcessManager {
  private readonly mapSettingsPath = resolve(app.getPath('userData'), 'map-window-settings.json');

  @IpcHandler({ name: 'MapWindow.getZoom' })
  readonly getMapZoom = async (): Promise<number> => {
    try {
      if (!existsSync(this.mapSettingsPath)) return 13;
      const settings = JSON.parse(readFileSync(this.mapSettingsPath, 'utf8')) as { zoom?: unknown };
      return typeof settings.zoom === 'number' && Number.isFinite(settings.zoom)
        ? Math.max(1, Math.min(20, Math.round(settings.zoom))) : 13;
    } catch (error) {
      console.warn('[MapWindow] Could not read saved zoom:', error);
      return 13;
    }
  };

  @IpcHandler({ name: 'MapWindow.setZoom' })
  readonly setMapZoom = async (_: IpcMainInvokeEvent, value: number): Promise<void> => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    let settings: Record<string, unknown> = {};
    try {
      if (existsSync(this.mapSettingsPath)) {
        const parsed = JSON.parse(readFileSync(this.mapSettingsPath, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) settings = parsed;
      }
    } catch (error) {
      console.warn('[MapWindow] Could not read map settings before saving zoom:', error);
    }
    settings.zoom = Math.max(1, Math.min(20, Math.round(value)));
    writeFileSync(this.mapSettingsPath, JSON.stringify(settings, null, 2), 'utf8');
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
