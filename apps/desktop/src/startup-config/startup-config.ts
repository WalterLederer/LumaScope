import { appConfigName } from 'internal-api';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { updateAppSettingsSection } from '../settings/app-settings';

export class StartupConfig {
  private _bounds: Electron.Rectangle | null = null;
  private _mapBounds: Electron.Rectangle | null = null;
  private _capturePreviewBounds: Electron.Rectangle | null = null;
  private _minimiseOnStart = false;
  private _devToolsOpen: boolean;

  constructor(private readonly app: Electron.App) {
    this._devToolsOpen = !app.isPackaged;
    this.init();
  }

  readonly bounds = () => this._bounds;
  readonly mapBounds = () => this._mapBounds;
  readonly capturePreviewBounds = () => this._capturePreviewBounds;

  readonly minimiseOnStart = () => this._minimiseOnStart;

  readonly devToolsOpen = () => this._devToolsOpen;

  readonly saveDevToolsOpen = async (open: boolean) => {
    this._devToolsOpen = open;
    await updateAppSettingsSection('system', { devToolsOpen: open });
  };

  readonly configPath = () => join(this.app.getPath('userData'), appConfigName);

  readonly saveBounds = async (bounds: Electron.Rectangle) => {
    await updateAppSettingsSection('system', {
      bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
    });
  };

  readonly saveMapBounds = async (bounds: Electron.Rectangle) => this.saveAuxiliaryBounds('mapBounds', bounds);

  readonly saveCapturePreviewBounds = async (bounds: Electron.Rectangle) => this.saveAuxiliaryBounds('capturePreviewBounds', bounds);

  private readonly saveAuxiliaryBounds = async (key: 'mapBounds' | 'capturePreviewBounds', bounds: Electron.Rectangle) => {
    await updateAppSettingsSection('system', {
      [key]: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
    });
  };

  private readonly init = () => {
    const json = this.load();

    if (json === null) {
      return;
    }

    this.parseConfig(json);
  };

  private readonly parseConfig = (config: unknown) => {
    this._bounds = null;
    this._mapBounds = null;
    this._capturePreviewBounds = null;

    if (!(config instanceof Object)) {
      return;
    }

    const system = config['system'];

    if (!(system instanceof Object)) {
      return;
    }

    this._minimiseOnStart = system.minimiseOnStart === true;
    if (typeof system.devToolsOpen === 'boolean') {
      this._devToolsOpen = system.devToolsOpen;
    }

    const readBounds = (value: any): Electron.Rectangle | null => {
      const x = value?.x, y = value?.y, width = value?.width, height = value?.height;
      return [x, y, width, height].every(item => typeof item === 'number' && Number.isFinite(item)) && width >= 320 && height >= 240
        ? { x, y, width, height } : null;
    };
    this._mapBounds = readBounds(system.mapBounds);
    this._capturePreviewBounds = readBounds(system.capturePreviewBounds);

    const x = system.bounds?.x;
    const y = system.bounds?.y;
    const width = system.bounds?.width;
    const height = system.bounds?.height;

    if (typeof x === 'number' && typeof y === 'number' && typeof width === 'number' && typeof height === 'number') {
      this._bounds = { x, y, width, height };
      return;
    }
  };

  private readonly load = () => {
    try {
      const configPath = this.configPath();
      const result = readFileSync(configPath, 'utf-8');
      return JSON.parse(result);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('ERROR: Unable to load startup config file', error);
      }
      return null;
    }
  };


}
