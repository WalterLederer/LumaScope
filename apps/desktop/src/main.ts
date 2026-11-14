import './user-data-path';
import { app, BrowserWindow } from 'electron';
import * as path from 'node:path';
import App from './app/app';
import ElectronEvents from './app/events/electron.events';
import SquirrelEvents from './app/events/squirrel.events';
import UpdateEvents from './app/events/update.events';

const isImageFileArgument = (value: string): boolean =>
  /\.(?:avif|bmp|gif|hdr|heic|heif|jpe?g|jxl|jxr|png|svg|tiff?|webp|exr)$/i.test(value);

export default class Main {
  static initialize(): boolean {
    if (SquirrelEvents.handleEvents()) {
      // Squirrel event handled (except first run event); the app will exit shortly.
      app.quit();
      return false;
    }

    if (!app.requestSingleInstanceLock()) {
      app.quit();
      return false;
    }

    app.on('second-instance', (_event, commandLine, workingDirectory) => {
      const mainWindow = BrowserWindow.getAllWindows()[0];
      if (!mainWindow || mainWindow.isDestroyed()) return;

      const imagePaths = commandLine
        .slice(1)
        .filter(argument => !argument.startsWith('-') && isImageFileArgument(argument))
        .map(argument => path.isAbsolute(argument) ? argument : path.resolve(workingDirectory, argument));

      const sendOpenFiles = (): void => {
        if (!mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed() && imagePaths.length > 0) {
          mainWindow.webContents.send('App.openFiles', imagePaths);
        }
      };
      if (mainWindow.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', sendOpenFiles);
      else sendOpenFiles();

      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });

    return true;
  }

  static bootstrapApp() {
    App.main(app, BrowserWindow);
  }

  static bootstrapAppEvents() {
    ElectronEvents.bootstrapElectronEvents();

    // initialize auto updater service
    if (!App.isDevelopmentMode()) {
      UpdateEvents.initAutoUpdateService();
    }
  }
}

// Handle setup events as quickly as possible. Only one process may access
// the application's SQLite databases at a time.
if (Main.initialize()) {
  // Bootstrap app
  Main.bootstrapApp();
  Main.bootstrapAppEvents();
}
