import { BrowserWindow, protocol, screen, shell } from 'electron';
import { appProtocol } from 'internal-api';
import { join } from 'path';
import { statSync } from 'node:fs';
import { format } from 'url';
import { environment } from '../environments/environment';
import { protocolHandler } from '../protocol-handler/protocol-handler';
import { StartupConfig } from '../startup-config/startup-config';
import { rendererAppName, rendererAppPort } from './constants';

export default class App {
  // Keep a global reference of the window object, if you don't, the window will
  // be closed automatically when the JavaScript object is garbage collected.
  static mainWindow: Electron.BrowserWindow;
  static mapWindow: Electron.BrowserWindow | null = null;
  static capturePreviewWindow: Electron.BrowserWindow | null = null;
  private static mapBoundsTimer: ReturnType<typeof setTimeout> | null = null;
  private static capturePreviewBoundsTimer: ReturnType<typeof setTimeout> | null = null;
  static application: Electron.App;
  static BrowserWindow;

  static startupConfig: StartupConfig;
  private static loupeGeometryTimer: ReturnType<typeof setTimeout> | null = null;

  private static executableTimestamp(): string {
    const modified = statSync(App.application.getPath('exe')).mtime;
    const pad = (value: number): string => String(value).padStart(2, '0');
    return `${modified.getFullYear()}-${pad(modified.getMonth() + 1)}-${pad(modified.getDate())} ${pad(modified.getHours())}:${pad(modified.getMinutes())}:${pad(modified.getSeconds())}`;
  }

  private static windowTitle(suffix = ''): string {
    return `LumaScope - ${App.executableTimestamp()}${suffix ? ` - ${suffix}` : ''}`;
  }

  public static isDevelopmentMode() {
    const isEnvironmentSet: boolean = 'ELECTRON_IS_DEV' in process.env;
    const getFromEnvironment: boolean = parseInt(process.env.ELECTRON_IS_DEV, 10) === 1;

    return isEnvironmentSet ? getFromEnvironment : !environment.production;
  }

  private static onWindowAllClosed() {
    if (process.platform !== 'darwin') {
      App.application.quit();
    }
  }

  private static onClose() {
    // Dereference the window object, usually you would store windows
    // in an array if your app supports multi windows, this is the time
    // when you should delete the corresponding element.
    App.mainWindow = null;
  }

  private static onRedirect(event: Event, url: string) {
    if (url !== App.mainWindow.webContents.getURL()) {
      // this is a normal external redirect, open it in a new browser window
      event.preventDefault();
      shell.openExternal(url);
    }
  }

  private static onReady() {
    // This method will be called when Electron has finished
    // initialization and is ready to create browser windows.
    // Some APIs can only be used after this event occurs.
    if (rendererAppName) {
      protocol.handle(appProtocol, protocolHandler);

      App.initMainWindow();
      App.loadMainWindow();
    }
  }

  private static onActivate() {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (App.mainWindow === null) {
      App.onReady();
    }
  }

  private static initMainWindow() {
    const workAreaSize = screen.getPrimaryDisplay().workAreaSize;

    const bounds = App.startupConfig.bounds();

    const width = bounds === null ? Math.round(workAreaSize.width * 0.8) : bounds.width;
    const height = bounds === null ? Math.round(workAreaSize.height * 0.8) : bounds.height;

    // Create the browser window.
    App.mainWindow = new BrowserWindow({
      x: bounds === null ? undefined : bounds.x,
      y: bounds === null ? undefined : bounds.y,
      width: width,
      height: height,
      show: false,
      title: App.windowTitle(),
      icon: join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
      webPreferences: {
        contextIsolation: true,
        backgroundThrottling: false,
        preload: join(__dirname, 'main.preload.js')
      }
    });
    App.mainWindow.setMenu(null);
    const mainWindowTitle = App.windowTitle();
    const applyMainWindowTitle = (): void => {
      if (App.mainWindow && !App.mainWindow.isDestroyed()) {
        App.mainWindow.setTitle(mainWindowTitle);
      }
    };
    App.mainWindow.webContents.on('page-title-updated', event => {
      event.preventDefault();
      applyMainWindowTitle();
    });
    App.mainWindow.webContents.on('did-finish-load', applyMainWindowTitle);
    App.mainWindow.webContents.on('dom-ready', applyMainWindowTitle);
    App.mainWindow.setTitle(mainWindowTitle);
    App.mainWindow.center();

    // Debounce move/resize events so the loupe refreshes after geometry settles.
    const notifyLoupeGeometryChanged = (): void => {
      if (App.loupeGeometryTimer !== null) clearTimeout(App.loupeGeometryTimer);
      App.loupeGeometryTimer = setTimeout(() => {
        App.loupeGeometryTimer = null;
        if (App.mainWindow && !App.mainWindow.isDestroyed() && !App.mainWindow.webContents.isDestroyed()) {
          App.mainWindow.webContents.send('Loupe.windowGeometryChanged');
        }
      }, 180);
    };
    App.mainWindow.on('move', notifyLoupeGeometryChanged);
    App.mainWindow.on('resize', notifyLoupeGeometryChanged);

    // if main window is ready to show, close the splash window and show the main window
    App.mainWindow.once('ready-to-show', () => {
      App.mainWindow.show();

      // In dev mode, optionally minimise the window to avoid interruptions on app reloads after file saves.
      if (!App.application.isPackaged && App.startupConfig.minimiseOnStart()) {
        App.mainWindow.minimize();
      }

      // Restore the persisted DevTools visibility setting in both development and packaged builds.
      if (App.startupConfig.devToolsOpen()) {
        App.mainWindow.webContents.openDevTools();
      }
    });

    // handle all external redirects in a new browser window
    // App.mainWindow.webContents.on('will-navigate', App.onRedirect);
    // App.mainWindow.webContents.on('new-window', (event, url, frameName, disposition, options) => {
    //     App.onRedirect(event, url);
    // });

    App.mainWindow.on('close', () => {
      // Persist the last normal window rectangle, not temporary fullscreen or maximized bounds.
      App.startupConfig.saveBounds(App.mainWindow.getNormalBounds());
    });

    // Emitted when the window is closed.
    App.mainWindow.on('closed', () => {
      // Dereference the main window and close all auxiliary Light Matter windows.
      App.mainWindow = null;

      if (App.isMapWindowOpen()) App.mapWindow.close();
      if (App.isCapturePreviewWindowOpen()) App.capturePreviewWindow.close();
    });
  }

  static setDevToolsOpen(open: boolean) {
    if (App.mainWindow !== null && App.mainWindow !== undefined) {
      if (open) {
        App.mainWindow.webContents.openDevTools();
      } else {
        App.mainWindow.webContents.closeDevTools();
      }
    }

    return App.startupConfig.saveDevToolsOpen(open);
  }

  static isCapturePreviewWindowOpen(): boolean {
    return App.capturePreviewWindow !== null && !App.capturePreviewWindow.isDestroyed();
  }

  static openCapturePreviewWindow(): boolean {
    if (App.isCapturePreviewWindowOpen()) {
      if (App.capturePreviewWindow.isMinimized()) App.capturePreviewWindow.restore();
      App.capturePreviewWindow.show();
      App.capturePreviewWindow.focus();
      return true;
    }
    const display = screen.getDisplayMatching(App.mainWindow.getBounds());
    const savedBounds = App.restoreAuxiliaryBounds(App.startupConfig.capturePreviewBounds(), display.workArea, 1100, 760);
    App.capturePreviewWindow = new BrowserWindow({
      ...savedBounds,
      minWidth: 480,
      minHeight: 320,
      resizable: true,
      show: false,
      title: App.windowTitle('CAPTURE'),
      webPreferences: {
        contextIsolation: true,
        backgroundThrottling: false,
        preload: join(__dirname, 'main.preload.js')
      }
    });
    App.capturePreviewWindow.setMenu(null);
    const capturePreviewWindowTitle = App.windowTitle('CAPTURE');
    App.capturePreviewWindow.webContents.on('page-title-updated', event => {
      event.preventDefault();
      App.capturePreviewWindow?.setTitle(capturePreviewWindowTitle);
    });
    App.capturePreviewWindow.setTitle(capturePreviewWindowTitle);
    App.capturePreviewWindow.on('move', () => App.scheduleAuxiliaryBoundsSave('capture'));
    App.capturePreviewWindow.on('resize', () => App.scheduleAuxiliaryBoundsSave('capture'));
    App.capturePreviewWindow.on('close', () => { void App.startupConfig.saveCapturePreviewBounds(App.capturePreviewWindow.getNormalBounds()); });
    const hash = '/capture-preview';
    if (!App.application.isPackaged) {
      App.capturePreviewWindow.loadURL(`http://localhost:${rendererAppPort}/#${hash}`);
    } else {
      App.capturePreviewWindow.loadURL(format({
        pathname: join(__dirname, '..', rendererAppName, 'index.html'),
        protocol: 'file:',
        slashes: true,
        hash
      }));
    }
    App.capturePreviewWindow.once('ready-to-show', () => {
      if (App.isCapturePreviewWindowOpen()) App.capturePreviewWindow.show();
    });
    App.capturePreviewWindow.on('closed', () => {
      App.capturePreviewWindow = null;
      if (App.mainWindow && !App.mainWindow.isDestroyed()) {
        App.mainWindow.webContents.send('CapturePreviewWindow.stateChanged', false);
      }
    });
    if (App.mainWindow && !App.mainWindow.isDestroyed()) {
      App.mainWindow.webContents.send('CapturePreviewWindow.stateChanged', true);
    }
    return true;
  }

  static closeCapturePreviewWindow(): void {
    if (App.isCapturePreviewWindowOpen()) App.capturePreviewWindow.close();
  }

  static isMapWindowOpen(): boolean {
    return App.mapWindow !== null && !App.mapWindow.isDestroyed();
  }

  static focusMapWindow(): boolean {
    if (!App.isMapWindowOpen()) return false;
    if (App.mapWindow.isMinimized()) App.mapWindow.restore();
    App.mapWindow.show();
    App.mapWindow.focus();
    return true;
  }

  static openMapWindow(latitude: number | null, longitude: number | null, bearing?: number): boolean {
    const hasCoordinates = Number.isFinite(latitude) && Number.isFinite(longitude)
      && latitude! >= -90 && latitude! <= 90 && longitude! >= -180 && longitude! <= 180;
    if ((latitude !== null || longitude !== null) && !hasCoordinates) {
      throw new Error('The map window received invalid GPS coordinates.');
    }

    if (App.isMapWindowOpen()) {
      App.mapWindow.webContents.send('MapWindow.locationChanged', hasCoordinates
        ? { latitude, longitude, bearing: Number.isFinite(bearing) ? bearing : null }
        : { latitude: null, longitude: null, bearing: null });
      if (App.mapWindow.isMinimized()) App.mapWindow.restore();
      App.mapWindow.showInactive();
      return true;
    }

    const display = screen.getDisplayMatching(App.mainWindow.getBounds());
    const savedBounds = App.restoreAuxiliaryBounds(App.startupConfig.mapBounds(), display.workArea, 1000, 760);
    App.mapWindow = new BrowserWindow({
      ...savedBounds,
      minWidth: 420,
      minHeight: 320,
      show: false,
      resizable: true,
      frame: true,
      transparent: false,
      title: App.windowTitle('LOCATION'),
      webPreferences: {
        contextIsolation: true,
        backgroundThrottling: false,
        preload: join(__dirname, 'main.preload.js')
      }
    });
    App.mapWindow.setMenu(null);
    const mapWindowTitle = App.windowTitle('LOCATION');
    App.mapWindow.webContents.on('page-title-updated', event => {
      event.preventDefault();
      App.mapWindow?.setTitle(mapWindowTitle);
    });
    App.mapWindow.setTitle(mapWindowTitle);
    App.mapWindow.on('move', () => App.scheduleAuxiliaryBoundsSave('map'));
    App.mapWindow.on('resize', () => App.scheduleAuxiliaryBoundsSave('map'));
    App.mapWindow.on('close', () => { void App.startupConfig.saveMapBounds(App.mapWindow.getNormalBounds()); });
    const hash = hasCoordinates
      ? `/map?lat=${encodeURIComponent(latitude!)}&lon=${encodeURIComponent(longitude!)}${Number.isFinite(bearing) ? `&bearing=${encodeURIComponent(bearing!)}` : ''}`
      : '/map';
    if (!App.application.isPackaged) {
      App.mapWindow.loadURL(`http://localhost:${rendererAppPort}/#${hash}`);
    } else {
      App.mapWindow.loadURL(format({
        pathname: join(__dirname, '..', rendererAppName, 'index.html'),
        protocol: 'file:',
        slashes: true,
        hash
      }));
    }
    App.mapWindow.once('ready-to-show', () => {
      if (App.isMapWindowOpen()) App.mapWindow.showInactive();
    });
    App.mapWindow.on('closed', () => {
      App.mapWindow = null;
      if (App.mainWindow && !App.mainWindow.isDestroyed()) {
        App.mainWindow.webContents.send('MapWindow.stateChanged', false);
      }
    });
    if (App.mainWindow && !App.mainWindow.isDestroyed()) {
      App.mainWindow.webContents.send('MapWindow.stateChanged', true);
    }
    return true;
  }

  private static restoreAuxiliaryBounds(saved: Electron.Rectangle | null, workArea: Electron.Rectangle, defaultWidth: number, defaultHeight: number): Electron.Rectangle {
    if (saved && screen.getAllDisplays().some(display => {
      const area = display.workArea;
      return saved.x < area.x + area.width && saved.x + saved.width > area.x
        && saved.y < area.y + area.height && saved.y + saved.height > area.y;
    })) return saved;
    return { x: workArea.x + Math.max(0, Math.round((workArea.width - Math.min(defaultWidth, workArea.width)) / 2)),
      y: workArea.y + Math.max(0, Math.round((workArea.height - Math.min(defaultHeight, workArea.height)) / 2)),
      width: Math.min(defaultWidth, workArea.width), height: Math.min(defaultHeight, workArea.height) };
  }

  private static scheduleAuxiliaryBoundsSave(kind: 'map' | 'capture'): void {
    const current = kind === 'map' ? App.mapWindow : App.capturePreviewWindow;
    if (!current || current.isDestroyed() || current.isMaximized() || current.isFullScreen()) return;
    const timer = kind === 'map' ? App.mapBoundsTimer : App.capturePreviewBoundsTimer;
    if (timer) clearTimeout(timer);
    const next = setTimeout(() => {
      if (kind === 'map') { App.mapBoundsTimer = null; if (App.mapWindow && !App.mapWindow.isDestroyed()) void App.startupConfig.saveMapBounds(App.mapWindow.getNormalBounds()); }
      else { App.capturePreviewBoundsTimer = null; if (App.capturePreviewWindow && !App.capturePreviewWindow.isDestroyed()) void App.startupConfig.saveCapturePreviewBounds(App.capturePreviewWindow.getNormalBounds()); }
    }, 250);
    if (kind === 'map') App.mapBoundsTimer = next; else App.capturePreviewBoundsTimer = next;
  }

  static setMapWindowAlwaysOnTop(enabled: boolean): boolean {
    if (!App.isMapWindowOpen()) return false;
    App.mapWindow.setAlwaysOnTop(!!enabled);
    return true;
  }

  static closeMapWindow(): void {
    if (App.isMapWindowOpen()) App.mapWindow.close();
  }

  private static loadMainWindow() {
    // load the index.html of the app.
    if (!App.application.isPackaged) {
      App.mainWindow.loadURL(`http://localhost:${rendererAppPort}`);
    } else {
      App.mainWindow.loadURL(
        format({
          pathname: join(__dirname, '..', rendererAppName, 'index.html'),
          protocol: 'file:',
          slashes: true
        })
      );
    }
  }

  static main(app: Electron.App, browserWindow: typeof BrowserWindow) {
    // we pass the Electron.App object and the
    // Electron.BrowserWindow into this function
    // so this class has no dependencies. This
    // makes the code easier to write tests for

    App.BrowserWindow = browserWindow;
    App.application = app;

    if (process.platform === 'linux') {
      // Must match the AppImage's light-matter.desktop filename for KDE/Wayland icon lookup.
      App.application.commandLine.appendSwitch('class', 'light-matter');
    }

    App.application.setName('LumaScope');
    App.application.setPath('userData', join(App.application.getPath('appData'), 'light-matter'));
    App.startupConfig = new StartupConfig(app);

    protocol.registerSchemesAsPrivileged([
      {
        scheme: appProtocol,
        privileges: {
          bypassCSP: true,
          corsEnabled: true,
          stream: true,
          supportFetchAPI: true
        }
      }
    ]);

    app.commandLine.appendSwitch('enable-features', 'JXLImageFormat');
    app.commandLine.appendSwitch('enable-experimental-web-platform-features');

    App.application.on('window-all-closed', App.onWindowAllClosed); // Quit when all windows are closed.
    App.application.on('ready', App.onReady); // App is ready to load data
    App.application.on('activate', App.onActivate); // App is activated
  }
}
