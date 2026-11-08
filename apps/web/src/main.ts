import { bootstrapApplication } from '@angular/platform-browser';
import { setPackagedMode } from 'internal-api';
import { App } from './app/app';
import { appConfig } from './app/app.config';

console.warn('[Startup] Renderer entry reached; requesting ProcessManager.isPackaged');

window.desktop
  .ProcessManager
  .isPackaged()
  .then(isPackaged => {
    console.warn('[Startup] ProcessManager.isPackaged resolved', isPackaged);
    setPackagedMode(isPackaged);
    console.warn('[Startup] Loading application settings');

    return window.desktop.ProcessManager.getAppSettings().then(async settings => {
      const mapWindow = settings['mapWindow'] && typeof settings['mapWindow'] === 'object'
        ? { ...(settings['mapWindow'] as Record<string, unknown>) } : {};
      const preferences = settings['preferences'] && typeof settings['preferences'] === 'object'
        ? { ...(settings['preferences'] as Record<string, unknown>) } : {};
      const osmand = settings['osmand'] && typeof settings['osmand'] === 'object'
        ? { ...(settings['osmand'] as Record<string, unknown>) } : {};
      const mapPrefix = 'light-matter.mapWindow.';
      const migratedMap: Record<string, unknown> = {};
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (!key) continue;
        const value = localStorage.getItem(key);
        if (key.startsWith(mapPrefix)) {
          const settingKey = key.slice(mapPrefix.length);
          if (!(settingKey in mapWindow)) migratedMap[settingKey] = value;
        } else if (!(key in preferences)) {
          preferences[key] = value;
        }
      }
      Object.assign(mapWindow, migratedMap);
      const migrateOsmandStyle = typeof osmand['renderingStyle'] !== 'string'
        && typeof mapWindow['osmandStyle'] === 'string';
      if (migrateOsmandStyle) osmand['renderingStyle'] = mapWindow['osmandStyle'];
      await Promise.all([
        Object.keys(migratedMap).length
          ? window.desktop.ProcessManager.setAppSettingsSection('mapWindow', mapWindow) : Promise.resolve(),
        Object.keys(preferences).length
          ? window.desktop.ProcessManager.setAppSettingsSection('preferences', preferences) : Promise.resolve(),
        migrateOsmandStyle
          ? window.desktop.ProcessManager.setAppSettingsSection('osmand', { renderingStyle: osmand['renderingStyle'] }) : Promise.resolve()
      ]);
      // The native OsmAnd manager is created before renderer-side legacy
      // preferences are migrated. Apply that one-time migration immediately.
      if (migrateOsmandStyle && typeof osmand['renderingStyle'] === 'string') {
        await window.desktop.OsmAnd.setRenderingStyle(osmand['renderingStyle']);
      }
      for (const [key, value] of Object.entries(mapWindow)) {
        if (value !== null && value !== undefined) localStorage.setItem(mapPrefix + key, String(value));
      }
      for (const [key, value] of Object.entries(preferences)) {
        if (value !== null && value !== undefined) localStorage.setItem(key, String(value));
      }
      const originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key: string, value: string): void {
        originalSetItem.call(this, key, value);
        if (this !== window.localStorage) return;
        if (key.startsWith(mapPrefix)) {
          void window.desktop.ProcessManager.setAppSettingsSection('mapWindow', { [key.slice(mapPrefix.length)]: value })
            .catch(error => console.error('[Settings] Could not save map-window preference:', key, error));
        } else {
          void window.desktop.ProcessManager.setAppSettingsSection('preferences', { [key]: value })
            .catch(error => console.error('[Settings] Could not save preference:', key, error));
        }
      };
      console.warn('[Startup] Starting Angular bootstrap');
      return bootstrapApplication(App, appConfig);
    })
      .then(() => console.warn('[Startup] Angular bootstrap completed'))
      .catch(err => console.error('[Startup] Angular bootstrap failed', err));
  })
  .catch(err => console.error('[Startup] ProcessManager.isPackaged failed', err));
