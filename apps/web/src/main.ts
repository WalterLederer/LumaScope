import { bootstrapApplication } from '@angular/platform-browser';
import { setPackagedMode } from 'internal-api';
import { App } from './app/app';
import { appConfig } from './app/app.config';

console.warn('[Startup] Renderer entry reached; requesting ProcessManager.isPackaged');

// Capture renderer failures before Angular and the router start bootstrapping.
window.addEventListener('error', event => {
  console.error('[RendererGlobalError] Uncaught error', {
    message: event.message,
    filename: event.filename,
    line: event.lineno,
    column: event.colno,
    stack: event.error instanceof Error ? event.error.stack : undefined
  });
});
window.addEventListener('unhandledrejection', event => {
  const reason = event.reason;
  console.error('[RendererGlobalError] Unhandled promise rejection', reason instanceof Error ? reason.stack ?? reason.message : reason);
});


window.desktop
  .ProcessManager
  .isPackaged()
  .then(isPackaged => {
    console.warn('[Startup] ProcessManager.isPackaged resolved', isPackaged);
    setPackagedMode(isPackaged);
    console.warn('[Startup] Loading startup theme and application settings');

    // Apply the saved theme before Angular starts rendering. The HTML already
    // paints Light Mode immediately; this early read switches to Dark Mode
    // before the first application window is shown when Dark Mode was saved.
    const startupTheme = window.desktop.ProcessManager.getSystemPaths()
      .then(paths => window.desktop.FileSystem.readJson<Record<string, unknown>>(paths.appConfig))
      .then(result => {
        const system = result.success && result.data && typeof result.data === 'object'
          ? (result.data as Record<string, unknown>)['system'] : undefined;
        const theme = system && typeof system === 'object'
          ? (system as Record<string, unknown>)['theme'] : undefined;
        const selectedTheme = theme === 'dark' ? 'dark' : 'light';
        document.documentElement.dataset['theme'] = selectedTheme;
        document.documentElement.style.colorScheme = selectedTheme;
      })
      .catch(error => console.warn('[Startup] Could not read saved startup theme; using Light Mode.', error));

    return Promise.all([window.desktop.ProcessManager.getAppSettings(), startupTheme]).then(async ([settings]) => {
      const mapWindow = settings['mapWindow'] && typeof settings['mapWindow'] === 'object'
        ? { ...(settings['mapWindow'] as Record<string, unknown>) } : {};
      const preferences = settings['preferences'] && typeof settings['preferences'] === 'object'
        ? { ...(settings['preferences'] as Record<string, unknown>) } : {};
      const osmand = settings['osmand'] && typeof settings['osmand'] === 'object'
        ? { ...(settings['osmand'] as Record<string, unknown>) } : {};
      const mapPrefix = 'mapWindow.';
      const values = new Map<string, string>();
      const migratedMap: Record<string, unknown> = {};
      const migratedPreferences: Record<string, unknown> = {};

      // The JSON configuration is the only persistent settings store.
      // Seed the renderer compatibility storage from its existing sections.
      for (const [key, value] of Object.entries(mapWindow)) {
        if (key === 'osmandStyle') continue;
        if (value !== null && value !== undefined) values.set(mapPrefix + key, String(value));
      }
      for (const [key, value] of Object.entries(preferences)) {
        if (value !== null && value !== undefined) values.set(key, String(value));
      }

      // Import values from the former Chromium localStorage once, but only
      // when the central JSON file does not already contain that setting.
      const legacyStorage = window.localStorage;
      for (let index = 0; index < legacyStorage.length; index++) {
        const key = legacyStorage.key(index);
        if (!key) continue;
        // Do not resurrect preferences from the obsolete Light Matter namespace.
        if (key.startsWith('light-matter.')) continue;
        const value = legacyStorage.getItem(key);
        if (key === mapPrefix + 'osmandStyle' || key === mapPrefix + 'osmandResourcesPath') continue;
        if (value === null || values.has(key)) continue;
        values.set(key, value);
        if (key.startsWith(mapPrefix)) {
          migratedMap[key.slice(mapPrefix.length)] = value;
        } else {
          migratedPreferences[key] = value;
        }
      }

      // OsmAnd has one authoritative settings pair under osmand. Do not
      // import or read any renderer-local or Atlas-specific legacy values.
      delete mapWindow['osmandStyle'];
      delete mapWindow['osmandResourcesPath'];
      delete osmand['atlas'];

      // Persist any one-time imports before replacing browser storage.
      if (Object.keys(migratedMap).length) {
        await window.desktop.ProcessManager.setAppSettingsSection('mapWindow', migratedMap);
      }
      if (Object.keys(migratedPreferences).length) {
        await window.desktop.ProcessManager.setAppSettingsSection('preferences', migratedPreferences);
      }
      // Remove obsolete duplicate settings without importing their values.
      await window.desktop.ProcessManager.setAppSettingsSection('osmand', { atlas: undefined });
      await window.desktop.ProcessManager.setAppSettingsSection('mapWindow', {
        osmandStyle: undefined,
        osmandResourcesPath: undefined
      });

      const persistValue = (key: string, value: string | null): void => {
        if (key.startsWith(mapPrefix)) {
          void window.desktop.ProcessManager.setAppSettingsSection('mapWindow', {
            [key.slice(mapPrefix.length)]: value
          }).catch(error => console.error('[Settings] Could not save map-window preference:', key, error));
        } else {
          void window.desktop.ProcessManager.setAppSettingsSection('preferences', {
            [key]: value
          }).catch(error => console.error('[Settings] Could not save preference:', key, error));
        }
      };

      // Keep the existing Storage API for current UI components, but back it
      // only with memory and the central JSON settings file. The native
      // Chromium localStorage is cleared and is never used again.
      const memoryStorage: Storage = {
        get length(): number { return values.size; },
        clear(): void {
          const keys = [...values.keys()];
          values.clear();
          for (const key of keys) persistValue(key, null);
        },
        getItem(key: string): string | null {
          return values.get(String(key)) ?? null;
        },
        key(index: number): string | null {
          return [...values.keys()][index] ?? null;
        },
        removeItem(key: string): void {
          const normalizedKey = String(key);
          values.delete(normalizedKey);
          persistValue(normalizedKey, null);
        },
        setItem(key: string, value: string): void {
          const normalizedKey = String(key);
          const normalizedValue = String(value);
          values.set(normalizedKey, normalizedValue);
          persistValue(normalizedKey, normalizedValue);
        }
      };

      // Remove the old duplicate store after importing its values.
      legacyStorage.clear();
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        enumerable: true,
        value: memoryStorage
      });

      console.warn('[Startup] Starting Angular bootstrap');
      return bootstrapApplication(App, appConfig);
    })
      .then(() => console.warn('[Startup] Angular bootstrap completed'))
      .catch(err => console.error('[Startup] Angular bootstrap failed', err));
  })
  .catch(err => console.error('[Startup] ProcessManager.isPackaged failed', err));
