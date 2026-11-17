import { BrowserWindow, globalShortcut, ipcMain, protocol, screen, shell } from 'electron';
import { appProtocol, GlobalShortcutStatus } from 'internal-api';
import { join } from 'path';
import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { format } from 'url';
import { environment } from '../environments/environment';
import { protocolHandler } from '../protocol-handler/protocol-handler';
import { StartupConfig } from '../startup-config/startup-config';
import { flushAppSettingsWrites, startAppSettingsCheckpoint } from '../settings/app-settings';
import { rendererAppName, rendererAppPort } from './constants';

export default class App {
  // Keep a global reference of the window object, if you don't, the window will
  // be closed automatically when the JavaScript object is garbage collected.
  static mainWindow: Electron.BrowserWindow;
  static mapWindow: Electron.BrowserWindow | null = null;
  static mapOverlayWindow: Electron.BrowserWindow | null = null;
  static mapWindowLocation: { latitude: number | null; longitude: number | null; bearing: number | null; imagePath: string | null } = { latitude: null, longitude: null, bearing: null, imagePath: null };
  static capturePreviewWindow: Electron.BrowserWindow | null = null;
  private static mapBoundsTimer: ReturnType<typeof setTimeout> | null = null;
  private static capturePreviewBoundsTimer: ReturnType<typeof setTimeout> | null = null;
  private static pendingCaptureHotkey: string | null = null;
  private static shutdownStartedAt: number | null = null;

  private static logShutdown(event: string, details: Record<string, unknown> = {}): void {
    try {
      const logDirectory = join(App.application.getPath('userData'), 'logs');
      mkdirSync(logDirectory, { recursive: true });
      const elapsedMs = App.shutdownStartedAt === null ? null : Date.now() - App.shutdownStartedAt;
      const now = new Date();
      const offsetMinutes = -now.getTimezoneOffset();
      const offsetSign = offsetMinutes >= 0 ? '+' : '-';
      const offset = `${offsetSign}${String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, '0')}:${String(Math.abs(offsetMinutes) % 60).padStart(2, '0')}`;
      const entry = {
        timestamp: now.toISOString(),
        timestampLocal: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}.${String(now.getMilliseconds()).padStart(3, '0')}${offset}`,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        processId: process.pid,
        elapsedMs,
        event,
        ...details
      };
      appendFileSync(join(logDirectory, 'shutdown.log'), `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      console.error('[Shutdown] Could not write shutdown diagnostic log:', error);
    }
  }
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

  private static triggerCaptureHotkey(channel: string): void {
    if (App.isCapturePreviewWindowOpen()) {
      if (App.capturePreviewWindow.isMinimized()) App.capturePreviewWindow.restore();
      // Keep the previously active external window as the foreground capture target.
      App.capturePreviewWindow.showInactive();
      if (App.capturePreviewWindow.webContents.isLoading()) {
        App.pendingCaptureHotkey = channel;
      } else {
        App.capturePreviewWindow.webContents.send(channel);
      }
      return;
    }

    // Preserve the action until the detached capture renderer has finished loading.
    App.pendingCaptureHotkey = channel;
    App.openCapturePreviewWindow();
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
    App.logShutdown('window-all-closed', { platform: process.platform });
    if (process.platform !== 'darwin') {
      App.logShutdown('quit-requested', { source: 'window-all-closed' });
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
            App.triggerCaptureHotkey(channel);
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
    const startupStartedAt = Date.now();
    const logRendererStartup = (event: string, details: Record<string, unknown> = {}): void => {
      console.warn(`[Startup] ${event}`, { elapsedMs: Date.now() - startupStartedAt, ...details });
    };
    let devToolsAttachedForMainNavigation = false;
    App.mainWindow.webContents.on('did-start-loading', () => {
      logRendererStartup('Renderer navigation started');
      // Attach after Chromium has created the navigation target, but before
      // the renderer executes the application entry bundle.
      if (!devToolsAttachedForMainNavigation && App.startupConfig.devToolsOpen()) {
        devToolsAttachedForMainNavigation = true;
        App.mainWindow.webContents.openDevTools({ mode: 'right', activate: true });
        logRendererStartup('DevTools attached to active renderer navigation');
      }
    });
    App.mainWindow.webContents.on('dom-ready', () => logRendererStartup('Renderer DOM ready'));
    App.mainWindow.webContents.on('did-finish-load', () => logRendererStartup('Renderer document finished loading', {
      url: App.mainWindow && !App.mainWindow.isDestroyed() ? App.mainWindow.webContents.getURL() : null
    }));
    App.mainWindow.webContents.on('console-message', ({ level, message, lineNumber, sourceId }) => {
      const label = level === 'error' ? 'ERROR'
        : level === 'warning' ? 'WARN'
        : level === 'debug' ? 'DEBUG'
        : 'INFO';
      const log = level === 'error' ? console.error
        : level === 'warning' ? console.warn
        : level === 'debug' ? console.debug
        : console.log;
      log(`[Renderer ${label}] ${message} ( ${sourceId}:${lineNumber} )`);
    });
    App.mainWindow.webContents.on('paint', () => logRendererStartup('First renderer paint'));
    App.mainWindow.webContents.on('did-fail-load', (_event, code, description, validatedURL, isMainFrame) => {
      if (isMainFrame) console.error('[Startup] Main window failed to load:', { code, description, validatedURL });
    });
    App.mainWindow.webContents.on('render-process-gone', (_event, details) => {
      App.logShutdown('main-render-process-gone', { details });
      console.error('[Startup] Renderer process exited unexpectedly:', details);
    });
    App.mainWindow.webContents.on('unresponsive', () => {
      App.logShutdown('main-renderer-unresponsive', {
        loading: App.mainWindow && !App.mainWindow.isDestroyed() ? App.mainWindow.webContents.isLoading() : null
      });
    });
    App.mainWindow.webContents.on('responsive', () => App.logShutdown('main-renderer-responsive'));
    App.mainWindow.webContents.on('will-prevent-unload', event => {
      App.logShutdown('main-renderer-will-prevent-unload');
      // Keep Electron's default behavior: the close is allowed unless the
      // renderer explicitly prevents unload. This event is diagnostic only.
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

    // Show the window once Chromium reports that the first frame is ready.
    App.mainWindow.once('ready-to-show', () => {
      logRendererStartup('Renderer ready-to-show');
      if (App.mainWindow && !App.mainWindow.isDestroyed()) App.mainWindow.show();

      if (!App.application.isPackaged && App.startupConfig.minimiseOnStart()) {
        App.mainWindow.minimize();
      }
    });

    // Capture renderer state while startup is waiting for the first visible frame.
    // This diagnostic runs in the main process, so it remains useful when DevTools is blank.
    let startupProbeCount = 0;
    const startupProbe = setInterval(() => {
      if (!App.mainWindow || App.mainWindow.isDestroyed() || App.mainWindow.webContents.isDestroyed()) {
        clearInterval(startupProbe);
        return;
      }
      startupProbeCount++;
      const webContents = App.mainWindow.webContents;
      const probeStartedAt = Date.now();
      void webContents.executeJavaScript(
        `({ readyState: document.readyState, bodyChildCount: document.body?.children.length ?? 0, bodyTextLength: document.body?.innerText?.length ?? 0, appRootCount: document.querySelectorAll('app-root').length, imageViewCount: document.querySelectorAll('app-image-view').length, galleryCount: document.querySelectorAll('app-gallery').length, imageGridCount: document.querySelectorAll('app-image-grid').length, imageCount: document.querySelectorAll('app-thumbnail').length })`,
        true
      ).then(state => {
        console.warn('[StartupProbe] Renderer responded', {
          probe: startupProbeCount,
          elapsedMs: Date.now() - startupStartedAt,
          responseMs: Date.now() - probeStartedAt,
          loading: webContents.isLoading(),
          crashed: webContents.isCrashed(),
          state
        });
      }).catch(error => {
        console.error('[StartupProbe] Renderer did not answer', {
          probe: startupProbeCount,
          elapsedMs: Date.now() - startupStartedAt,
          responseMs: Date.now() - probeStartedAt,
          loading: webContents.isLoading(),
          crashed: webContents.isCrashed(),
          error: error instanceof Error ? error.message : String(error)
        });
      });
      if (startupProbeCount >= 8) clearInterval(startupProbe);
    }, 1500);

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
      const closeStartedAt = Date.now();
      App.logShutdown('window-close', {
        window: 'main',
        destroyed: App.mainWindow.isDestroyed(),
        webContentsDestroyed: App.mainWindow.webContents.isDestroyed(),
        rendererLoading: App.mainWindow.webContents.isLoading(),
        rendererUrl: App.mainWindow.webContents.getURL()
      });
      try {
        // Persist the last normal window rectangle, not temporary fullscreen or maximized bounds.
        App.startupConfig.saveBounds(App.mainWindow.getNormalBounds());
        App.logShutdown('main-window-close-handler-complete', { durationMs: Date.now() - closeStartedAt });
      } catch (error) {
        App.logShutdown('main-window-close-handler-failed', {
          durationMs: Date.now() - closeStartedAt,
          error: error instanceof Error ? error.stack ?? error.message : String(error)
        });
        throw error;
      }
    });

    // Emitted when the window is closed.
    App.mainWindow.on('closed', () => {
      App.logShutdown('window-closed', { window: 'main' });
      // Dereference the main window and close all auxiliary LumaScope windows.
      App.mainWindow = null;

      if (App.isMapWindowOpen()) {
        App.logShutdown('auxiliary-close-requested', { window: 'location' });
        App.mapWindow.close();
      }
      if (App.isMapOverlayWindowOpen()) {
        App.logShutdown('auxiliary-close-requested', { window: 'location-overlay' });
        App.mapOverlayWindow.close();
      }
      if (App.isCapturePreviewWindowOpen()) {
        App.logShutdown('auxiliary-close-requested', { window: 'capture-preview' });
        App.capturePreviewWindow.close();
      }
    });
  }

  private static getApplicationWindows(): Electron.BrowserWindow[] {
    return [App.mainWindow, App.mapWindow, App.mapOverlayWindow, App.capturePreviewWindow]
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
    App.capturePreviewWindow.on('close', () => {
      App.logShutdown('window-close', { window: 'capture-preview' });
      void App.startupConfig.saveCapturePreviewBounds(App.capturePreviewWindow.getNormalBounds());
    });
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
      const pendingHotkey = App.pendingCaptureHotkey;
      App.pendingCaptureHotkey = null;
      if (pendingHotkey) App.capturePreviewWindow.webContents.send(pendingHotkey);
      // A hotkey-opened preview must not steal focus before Top Window is resolved.
      if (pendingHotkey) App.capturePreviewWindow.showInactive();
      else App.capturePreviewWindow.show();
    });
    App.capturePreviewWindow.on('closed', () => {
      App.logShutdown('window-closed', { window: 'capture-preview' });
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
    const location = App.mapWindowLocation;
    if (App.isMapOverlayWindowOpen()) App.mapOverlayWindow.webContents.send('MapWindow.locationChanged', location);

    if (App.isMapWindowOpen()) {
      App.mapWindow.webContents.send('MapWindow.locationChanged', location);
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
    App.mapWindow.on('close', () => {
      App.logShutdown('window-close', { window: 'location' });
      void App.startupConfig.saveMapBounds(App.mapWindow.getNormalBounds());
    });
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
      App.logShutdown('window-closed', { window: 'location' });
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

  static isMapOverlayWindowOpen(): boolean {
    return App.mapOverlayWindow !== null && !App.mapOverlayWindow.isDestroyed();
  }

  static focusMapOverlayWindow(): boolean {
    if (!App.isMapOverlayWindowOpen()) return false;
    if (App.mapOverlayWindow.isMinimized()) App.mapOverlayWindow.restore();
    App.mapOverlayWindow.show();
    App.mapOverlayWindow.focus();
    return true;
  }

  static openMapOverlayWindow(latitude: number | null, longitude: number | null, bearing?: number, imagePath?: string | null): boolean {
    const hasCoordinates = Number.isFinite(latitude) && Number.isFinite(longitude)
      && latitude! >= -90 && latitude! <= 90 && longitude! >= -180 && longitude! <= 180;
    if ((latitude !== null || longitude !== null) && !hasCoordinates) throw new Error('The map overlay received invalid GPS coordinates.');
    App.mapWindowLocation = hasCoordinates
      ? { latitude, longitude, bearing: Number.isFinite(bearing) ? bearing! : null, imagePath: imagePath ?? null }
      : { latitude: null, longitude: null, bearing: null, imagePath: imagePath ?? null };
    const location = App.mapWindowLocation;
    if (App.isMapWindowOpen()) App.mapWindow.webContents.send('MapWindow.locationChanged', location);
    if (App.isMapOverlayWindowOpen()) {
      App.mapOverlayWindow.webContents.send('MapWindow.locationChanged', location);
      if (App.mapOverlayWindow.isMinimized()) App.mapOverlayWindow.restore();
      App.mapOverlayWindow.showInactive();
      return true;
    }
    const parentBounds = App.mainWindow.getBounds();
    const width = Math.max(420, Math.min(900, parentBounds.width - 80));
    const height = Math.max(320, Math.min(640, parentBounds.height - 120));
    App.mapOverlayWindow = new BrowserWindow({
      x: parentBounds.x + Math.max(20, Math.round((parentBounds.width - width) / 2)),
      y: parentBounds.y + Math.max(50, Math.round((parentBounds.height - height) / 2)),
      width, height, minWidth: 420, minHeight: 320,
      parent: App.mainWindow, show: false, frame: false, transparent: true,
      backgroundColor: '#00000000', resizable: false, movable: true, hasShadow: true,
      skipTaskbar: true, title: App.windowTitle('LOCATION OVERLAY'),
      webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: join(__dirname, 'main.preload.js') }
    });
    App.mapOverlayWindow.setMenu(null);
    App.mapOverlayWindow.on('closed', () => {
      App.logShutdown('window-closed', { window: 'location-overlay' });
      App.mapOverlayWindow = null;
      if (App.mainWindow && !App.mainWindow.isDestroyed()) App.mainWindow.webContents.send('MapOverlayWindow.stateChanged', false);
    });
    const hash = `/map?overlay=1${hasCoordinates ? `&lat=${encodeURIComponent(latitude!)}&lon=${encodeURIComponent(longitude!)}${Number.isFinite(bearing) ? `&bearing=${encodeURIComponent(bearing!)}` : ''}` : ''}${imagePath ? `&imagePath=${encodeURIComponent(imagePath)}` : ''}`;
    if (!App.application.isPackaged) App.mapOverlayWindow.loadURL(`http://localhost:${rendererAppPort}/#${hash}`);
    else App.mapOverlayWindow.loadURL(format({ pathname: join(__dirname, '..', rendererAppName, 'index.html'), protocol: 'file:', slashes: true, hash }));
    App.mapOverlayWindow.once('ready-to-show', () => {
      if (!App.isMapOverlayWindowOpen()) return;
      if (App.startupConfig.devToolsOpen()) App.mapOverlayWindow.webContents.openDevTools();
      App.mapOverlayWindow.show();
    });
    if (App.mainWindow && !App.mainWindow.isDestroyed()) App.mainWindow.webContents.send('MapOverlayWindow.stateChanged', true);
    return true;
  }

  static closeMapOverlayWindow(): void { if (App.isMapOverlayWindowOpen()) App.mapOverlayWindow.close(); }

  static setMapOverlayWindowAlwaysOnTop(enabled: boolean): boolean {
    if (!App.isMapOverlayWindowOpen()) return false;
    App.mapOverlayWindow.setAlwaysOnTop(!!enabled);
    return true;
  }

  static getMapOverlayWindowBounds(): Electron.Rectangle | null {
    return App.isMapOverlayWindowOpen() ? App.mapOverlayWindow.getBounds() : null;
  }

  static setMapOverlayWindowBounds(bounds: Electron.Rectangle): boolean {
    if (!App.isMapOverlayWindowOpen() || !bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return false;
    const next = { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.max(420, Math.round(bounds.width)), height: Math.max(320, Math.round(bounds.height)) };
    if (next.width > 10000 || next.height > 10000) return false;
    App.mapOverlayWindow.setBounds(next);
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

    startAppSettingsCheckpoint();

    // Record shutdown phases to a dedicated file so a stalled quit can be diagnosed
    // without relying on the transient DevTools or console output.
    let settingsFlushOnQuitStarted = false;
    app.on('before-quit', event => {
      if (settingsFlushOnQuitStarted) {
        App.logShutdown('before-quit-reentry');
        return;
      }
      event.preventDefault();
      settingsFlushOnQuitStarted = true;
      App.shutdownStartedAt = Date.now();
      App.logShutdown('before-quit-start', {
        windows: App.getApplicationWindows().map(window => ({
          title: window.getTitle(),
          destroyed: window.isDestroyed(),
          visible: window.isVisible()
        }))
      });

      const flushStartedAt = Date.now();
      App.logShutdown('settings-flush-start');
      const watchdogs = [5000, 15000, 30000].map(delay => setTimeout(() => {
        App.logShutdown('settings-flush-still-pending', { elapsedMs: Date.now() - flushStartedAt });
      }, delay));

      void flushAppSettingsWrites()
        .then(() => {
          App.logShutdown('settings-flush-complete', { durationMs: Date.now() - flushStartedAt });
        })
        .catch(error => {
          App.logShutdown('settings-flush-failed', {
            durationMs: Date.now() - flushStartedAt,
            error: error instanceof Error ? error.message : String(error)
          });
          console.error('[Settings] Could not flush settings before quit:', error);
        })
        .finally(() => {
          watchdogs.forEach(timer => clearTimeout(timer));
          App.logShutdown('quit-requested', { source: 'settings-flush-complete' });
          app.quit();
        });
    });
    app.on('will-quit', () => App.logShutdown('will-quit'));
    app.on('quit', (_event, exitCode) => App.logShutdown('quit', { exitCode }));
    app.on('browser-window-focus', (_event, window) => {
      App.logShutdown('browser-window-focus', { title: window.getTitle() });
    });
    app.on('browser-window-blur', (_event, window) => {
      App.logShutdown('browser-window-blur', { title: window.getTitle() });
    });

    if (process.platform === 'linux') {
      // Must match the AppImage's light-matter.desktop filename for KDE/Wayland icon lookup.
      App.application.commandLine.appendSwitch('class', 'light-matter');
    }

    App.application.setName('LumaScope');
    App.logShutdown('application-initialized', { logFile: join(app.getPath('userData'), 'logs', 'shutdown.log') });
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
