import { BrowserWindow, globalShortcut, ipcMain, protocol, screen, shell } from 'electron';
import { appProtocol, GlobalShortcutStatus } from 'internal-api';
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
  static mapWindowLocation: { latitude: number | null; longitude: number | null; bearing: number | null; imagePath: string | null } = { latitude: null, longitude: null, bearing: null, imagePath: null };
  static capturePreviewWindow: Electron.BrowserWindow | null = null;
  private static mapBoundsTimer: ReturnType<typeof setTimeout> | null = null;
  private static capturePreviewBoundsTimer: ReturnType<typeof setTimeout> | null = null;
  static application: Electron.App;
  static BrowserWindow;

  static startupConfig: StartupConfig;
  private static loupeGeometryTimer: ReturnType<typeof setTimeout> | null = null;
  private static globalCaptureShortcutStatuses: GlobalShortcutStatus[] = [
    { id: 'top-window', accelerator: 'Ctrl + Win + PrtScn', active: false, error: 'Not registered yet.' },
    { id: 'rectangle', accelerator: 'Ctrl + Shift + Win + PrtScn', active: false, error: 'Not registered yet.' }
  ];

  static getGlobalCaptureShortcutStatus(): GlobalShortcutStatus[] {
    return App.globalCaptureShortcutStatuses.map(status => ({ ...status }));
  }

  private static publishGlobalCaptureShortcutStatus(): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('Capture.globalShortcutStatusChanged', App.getGlobalCaptureShortcutStatus());
      }
    }
  }


  private static executableTimestamp(): string {
    const modified = statSync(App.application.getPath('exe')).mtime;
    const pad = (value: number): string => String(value).padStart(2, '0');
    return `${modified.getFullYear()}-${pad(modified.getMonth() + 1)}-${pad(modified.getDate())} ${pad(modified.getHours())}:${pad(modified.getMinutes())}:${pad(modified.getSeconds())}`;
  }

  public static windowTitle(suffix = ''): string {
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
      // Windows global shortcuts. Super is the Windows key in Electron accelerators.
      const topWindowAccelerator = 'Control+Super+PrintScreen';
      const rectangleAccelerator = 'Control+Shift+Super+PrintScreen';
      const registerCaptureShortcut = (
        id: GlobalShortcutStatus['id'],
        accelerator: string,
        channel: string,
        label: string
      ): void => {
        let active = false;
        let error: string | null = null;
        try {
          if (globalShortcut.isRegistered(accelerator)) globalShortcut.unregister(accelerator);
          const registered = globalShortcut.register(accelerator, () => {
            // Capture UI can be hosted by any live renderer window. Broadcast the
            // shortcut event instead of assuming the main window owns the panel.
            for (const window of BrowserWindow.getAllWindows()) {
              if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
                window.webContents.send(channel);
              }
            }
          });
          active = registered && globalShortcut.isRegistered(accelerator);
          if (!active) {
            error = 'Could not register this shortcut. Another application may already use it.';
          }
        } catch (registrationError) {
          error = registrationError instanceof Error ? registrationError.message : String(registrationError);
        }

        const status = App.globalCaptureShortcutStatuses.find(item => item.id === id);
        if (status) {
          status.accelerator = label;
          status.active = active;
          status.error = error;
        }
        if (error) console.warn(`[Capture] Global shortcut ${label} is unavailable: ${error}`);
        App.publishGlobalCaptureShortcutStatus();
      };
      registerCaptureShortcut('top-window', topWindowAccelerator, 'Capture.topWindowClipboardHotkey', 'Ctrl + Win + PrtScn');
      registerCaptureShortcut('rectangle', rectangleAccelerator, 'Capture.rectangleClipboardHotkey', 'Ctrl + Shift + Win + PrtScn');
      App.application.once('will-quit', () => {
        globalShortcut.unregister(topWindowAccelerator);
        globalShortcut.unregister(rectangleAccelerator);
      });
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
      icon: join(__dirname, 'assets', process.platform === 'win32' ? 'lumascope.ico' : 'icon.png'),
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
    App.mainWindow.webContents.on('did-fail-load', (_event, code, description, validatedURL, isMainFrame) => {
      if (isMainFrame) console.error('[Startup] Main window failed to load:', { code, description, validatedURL });
    });
    App.mainWindow.webContents.on('render-process-gone', (_event, details) => {
      console.error('[Startup] Renderer process exited unexpectedly:', details);
    });

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

    // Show the window once Chromium reports it is ready.
    App.mainWindow.once('ready-to-show', () => {
      if (App.mainWindow && !App.mainWindow.isDestroyed()) App.mainWindow.show();

      if (!App.application.isPackaged && App.startupConfig.minimiseOnStart()) {
        App.mainWindow.minimize();
      }

      if (App.startupConfig.devToolsOpen()) {
        App.mainWindow.webContents.openDevTools();
      }
    });

    // Avoid leaving the application running invisibly if ready-to-show never arrives.
    setTimeout(() => {
      if (App.mainWindow && !App.mainWindow.isDestroyed() && !App.mainWindow.isVisible()) {
        console.warn('[Startup] Window did not become visible; showing it as a fallback.');
        App.mainWindow.show();
      }
    }, 10000);

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

  private static getApplicationWindows(): Electron.BrowserWindow[] {
    return [App.mainWindow, App.mapWindow, App.capturePreviewWindow]
      .filter((window): window is Electron.BrowserWindow => !!window && !window.isDestroyed());
  }

  static setDevToolsOpen(open: boolean) {
    for (const window of App.getApplicationWindows()) {
      if (window.webContents.isDestroyed()) continue;
      if (open) {
        if (!window.webContents.isDevToolsOpened()) window.webContents.openDevTools();
      } else if (window.webContents.isDevToolsOpened()) {
        window.webContents.closeDevTools();
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
      title: App.windowTitle('SCREEN CAPTURE'),
      webPreferences: {
        contextIsolation: true,
        backgroundThrottling: false,
        preload: join(__dirname, 'main.preload.js')
      }
    });
    App.capturePreviewWindow.setMenu(null);
    const capturePreviewWindowTitle = App.windowTitle('SCREEN CAPTURE');
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
      if (!App.isCapturePreviewWindowOpen()) return;
      if (App.startupConfig.devToolsOpen()) App.capturePreviewWindow.webContents.openDevTools();
      App.capturePreviewWindow.show();
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

  static openMapWindow(latitude: number | null, longitude: number | null, bearing?: number, imagePath?: string | null): boolean {
    const hasCoordinates = Number.isFinite(latitude) && Number.isFinite(longitude)
      && latitude! >= -90 && latitude! <= 90 && longitude! >= -180 && longitude! <= 180;
    if ((latitude !== null || longitude !== null) && !hasCoordinates) {
      throw new Error('The map window received invalid GPS coordinates.');
    }
    App.mapWindowLocation = hasCoordinates
      ? { latitude, longitude, bearing: Number.isFinite(bearing) ? bearing! : null, imagePath: imagePath ?? null }
      : { latitude: null, longitude: null, bearing: null, imagePath: imagePath ?? null };

    if (App.isMapWindowOpen()) {
      App.mapWindow.webContents.send('MapWindow.locationChanged', hasCoordinates
        ? { latitude, longitude, bearing: Number.isFinite(bearing) ? bearing : null, imagePath: imagePath ?? null }
        : { latitude: null, longitude: null, bearing: null, imagePath: imagePath ?? null });
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
      ? `/map?lat=${encodeURIComponent(latitude!)}&lon=${encodeURIComponent(longitude!)}${Number.isFinite(bearing) ? `&bearing=${encodeURIComponent(bearing!)}` : ''}${imagePath ? `&imagePath=${encodeURIComponent(imagePath)}` : ''}`
      : `/map${imagePath ? `?imagePath=${encodeURIComponent(imagePath)}` : ''}`;
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
      if (!App.isMapWindowOpen()) return;
      if (App.startupConfig.devToolsOpen()) App.mapWindow.webContents.openDevTools();
      App.mapWindow.showInactive();
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
    ipcMain.handle('Capture.getGlobalShortcutStatus', () => App.getGlobalCaptureShortcutStatus());

    App.application = app;

    if (process.platform === 'linux') {
      // Must match the AppImage's light-matter.desktop filename for KDE/Wayland icon lookup.
      App.application.commandLine.appendSwitch('class', 'light-matter');
    }

    App.application.setName('LumaScope');
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
