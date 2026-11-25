import { app } from 'electron';
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/* Add an absolute timestamp to every Electron main-process console entry.
 * This module is imported first by the desktop entry point, before application
 * services and their startup diagnostics are evaluated. */
const timestampConsoleOutput = (write: (...data: unknown[]) => void) =>
  (...data: unknown[]): void => write(`[${new Date().toISOString()}]`, ...data);

console.log = timestampConsoleOutput(console.log.bind(console));
console.info = timestampConsoleOutput(console.info.bind(console));
console.warn = timestampConsoleOutput(console.warn.bind(console));
console.error = timestampConsoleOutput(console.error.bind(console));
console.debug = timestampConsoleOutput(console.debug.bind(console));

// Set the profile path before any other application modules are evaluated.
// Some imported modules may initialize services that read app.getPath('userData').
app.setName('LumaScope');
const roamingAppData = process.env.APPDATA || app.getPath('appData');
const lumaScopeUserData = join(roamingAppData, 'LumaScope');
mkdirSync(lumaScopeUserData, { recursive: true });
app.setPath('userData', lumaScopeUserData);

// Keep all LumaScope-owned settings and caches below the single userData root.
// Older builds placed OsmAnd tiles below %LOCALAPPDATA%\\LumaScope\\cache.
if (process.platform === 'win32') {
  const localAppData = process.env.LOCALAPPDATA || join(app.getPath('home'), 'AppData', 'Local');
  const legacyTileCache = join(localAppData, 'LumaScope', 'cache', 'maps', 'obf');
  const unifiedTileCache = join(lumaScopeUserData, 'Cache', 'maps', 'obf');

  const mergeCacheDirectory = (source: string, target: string): void => {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const sourceEntry = join(source, entry.name);
      const targetEntry = join(target, entry.name);
      if (entry.isDirectory()) {
        if (existsSync(targetEntry)) mergeCacheDirectory(sourceEntry, targetEntry);
        else renameSync(sourceEntry, targetEntry);
      } else if (!existsSync(targetEntry)) {
        renameSync(sourceEntry, targetEntry);
      } else {
        // Both locations contain the same cache key. Keep the unified copy;
        // tile images can always be regenerated if a cached entry is stale.
        unlinkSync(sourceEntry);
      }
    }
    rmdirSync(source);
  };

  try {
    if (existsSync(legacyTileCache)) {
      if (existsSync(unifiedTileCache)) mergeCacheDirectory(legacyTileCache, unifiedTileCache);
      else {
        mkdirSync(join(lumaScopeUserData, 'Cache', 'maps'), { recursive: true });
        renameSync(legacyTileCache, unifiedTileCache);
      }
      for (const directory of [
        join(localAppData, 'LumaScope', 'cache', 'maps'),
        join(localAppData, 'LumaScope', 'cache')
      ]) {
        try { rmdirSync(directory); } catch { /* Other legacy data may still be present. */ }
      }
      console.info('[Startup] Migrated the legacy OsmAnd tile cache into the unified userData directory.');
    }
  } catch (error) {
    console.warn('[Startup] Could not fully migrate the legacy OsmAnd tile cache:', error);
  }

  // The standalone OsmAnd SDK prototype was also stored in LocalAppData.
  // Keep it beside the app configuration, without copying a potentially large tree.
  const legacySdkDirectory = join(localAppData, 'LumaScope', 'OsmAnd-SDK');
  const unifiedSdkDirectory = join(lumaScopeUserData, 'OsmAnd-SDK');
  try {
    if (existsSync(legacySdkDirectory) && !existsSync(unifiedSdkDirectory)) {
      renameSync(legacySdkDirectory, unifiedSdkDirectory);
      console.info('[Startup] Moved the local OsmAnd SDK directory into the unified userData directory.');
    } else if (existsSync(legacySdkDirectory) && existsSync(unifiedSdkDirectory)) {
      console.warn('[Startup] Both legacy and unified OsmAnd SDK directories exist; the legacy directory was left untouched.');
    }
    try { rmdirSync(join(localAppData, 'LumaScope')); } catch { /* Other legacy files may still be present. */ }
  } catch (error) {
    console.warn('[Startup] Could not migrate the legacy OsmAnd SDK directory:', error);
  }
}

console.info(`[Startup] Electron userData path: ${app.getPath('userData')}`);
