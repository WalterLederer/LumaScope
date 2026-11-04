import { app, BrowserWindow } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import App from './app/app';
import ElectronEvents from './app/events/electron.events';
import SquirrelEvents from './app/events/squirrel.events';
import UpdateEvents from './app/events/update.events';

// Keep all application settings and data in the renamed LumaScope profile directory.
// Use Windows' roaming profile path directly instead of deriving it from the Electron app name.
app.setName('LumaScope');
const roamingAppData = process.env.APPDATA || app.getPath('appData');
const lumaScopeUserData = join(roamingAppData, 'LumaScope');
mkdirSync(lumaScopeUserData, { recursive: true });
app.setPath('userData', lumaScopeUserData);

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

    app.on('second-instance', () => {
      const mainWindow = BrowserWindow.getAllWindows()[0];
      if (!mainWindow || mainWindow.isDestroyed()) return;
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
