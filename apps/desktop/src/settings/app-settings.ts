import { app } from 'electron';
import { appConfigName } from 'internal-api';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeJsonAtomically } from '../file-system/json-file';

export type AppSettings = Record<string, unknown>;

const settingsPath = (): string => join(app.getPath('userData'), appConfigName);
let writeQueue: Promise<void> = Promise.resolve();

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isLegacyDefaultUpdateSources = (value: unknown): boolean => {
  const legacy = [
    ['https://download.geofabrik.de/europe/austria.html', 'mbtiles', false],
    ['https://www.limaps.org/tileserver.html', 'mbtiles', true],
    ['https://shortbread-tiles.org/download/', 'mbtiles', false],
    ['https://download.osmand.net/list.php', 'obf', true],
    ['https://github.com/osmandapp/OsmAnd-resources', 'obf', false],
    ['https://fides.fe.uni-lj.si/~arpadb/osmand/', 'obf', true],
    ['https://download.osmand.net/latest-night-build/', 'android', false],
    ['https://download.mapsforge.org/maps/', 'mapsforge', false]
  ] as const;
  return Array.isArray(value) && value.length === legacy.length
    && value.every((entry, index) => {
      if (!isPlainObject(entry)) return false;
      const expected = legacy[index];
      return entry['url'] === expected[0]
        && entry['fileType'] === expected[1]
        && entry['useForUpdates'] === expected[2];
    });
};

const mergeSettings = (defaults: Record<string, unknown>, user: Record<string, unknown>): AppSettings => {
  const merged: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(user)) {
    // Older releases wrote their built-in download-source list into the user
    // config. Replace only that exact untouched legacy list with current defaults.
    if (key === 'updateSources' && isLegacyDefaultUpdateSources(value) && Array.isArray(defaults[key])) {
      merged[key] = defaults[key];
    } else {
      merged[key] = isPlainObject(value) && isPlainObject(defaults[key])
        ? mergeSettings(defaults[key] as Record<string, unknown>, value)
        : value;
    }
  }
  return merged;
};

const defaultSettingsPath = (): string => {
  const fileName = 'LumaScope.default.config.json';
  const candidates = app.isPackaged
    ? [join(dirname(process.execPath), fileName)]
    : [join(process.cwd(), fileName), join(app.getAppPath(), fileName)];
  return candidates.find(path => existsSync(path)) ?? candidates[0];
};

const readJsonObject = (path: string): AppSettings => {
  try {
    if (!existsSync(path)) return {};
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isPlainObject(value) ? value : {};
  } catch (error) {
    console.warn('[Settings] Could not read configuration file:', path, error);
    return {};
  }
};

export const readUserAppSettings = (): AppSettings => readJsonObject(settingsPath());

export const readAppSettings = (): AppSettings =>
  mergeSettings(readJsonObject(defaultSettingsPath()), readUserAppSettings());

export const updateAppSettingsSection = (section: string, values: Record<string, unknown>): Promise<void> => {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(section)) {
    return Promise.reject(new Error('Invalid application settings section.'));
  }
  const operation = writeQueue.then(async () => {
    // Read only after the previous write has completed so concurrent windows
    // cannot overwrite each other's settings with stale snapshots.
    const settings = readUserAppSettings();
    if (section === 'root') {
      // Reserved section name for one-time cleanup of former top-level config keys.
      const updated = { ...settings, ...values };
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete updated[key];
      }
      await writeJsonAtomically(settingsPath(), updated);
      return;
    }
    const previous = settings[section];
    const merged: Record<string, unknown> = {
      ...(previous && typeof previous === 'object' && !Array.isArray(previous)
        ? previous as Record<string, unknown> : {}),
      ...values
    };
    // Undefined explicitly removes a setting instead of persisting a second,
    // obsolete compatibility key in config.json.
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete merged[key];
    }
    // The unified offlineMaps.filePaths array replaces the former object and
    // split path lists; do not leave stale compatibility keys behind.
    if (section === 'offlineMaps' && Object.prototype.hasOwnProperty.call(values, 'filePaths')) {
      delete merged.obfPaths;
      delete merged.enabledByPath;
      delete merged.filePath;
    }
    settings[section] = merged;
    await writeJsonAtomically(settingsPath(), settings);
  });
  writeQueue = operation.catch(() => undefined);
  return operation;
};
