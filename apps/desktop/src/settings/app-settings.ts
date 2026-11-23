import { app } from 'electron';
import { appConfigName } from 'internal-api';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { copyFile, readdir, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { writeJsonAtomically } from '../file-system/json-file';

export type AppSettings = Record<string, unknown>;

const settingsPath = (): string => join(app.getPath('userData'), appConfigName);
let writeQueue: Promise<void> = Promise.resolve();

// Settings are persisted immediately by each update. This periodic checkpoint
// also waits for the serialized queue, so shutdown/builds cannot interrupt a
// write that was already accepted by the main process.
let settingsCheckpointTimer: ReturnType<typeof setInterval> | null = null;

export const flushAppSettingsWrites = async (): Promise<void> => {
  await writeQueue;
};

export const startAppSettingsCheckpoint = (): void => {
  if (settingsCheckpointTimer) return;
  settingsCheckpointTimer = setInterval(() => {
    void flushAppSettingsWrites().catch(error => {
      console.error('[Settings] Periodic settings checkpoint failed:', error);
    });
  }, 30_000);
  settingsCheckpointTimer.unref?.();
};

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

// Writes must never treat an unreadable existing configuration as an empty
// object. Doing so would replace the user's complete settings with only the
// section being saved (for example, window bounds during application shutdown).
const readUserAppSettingsForUpdate = (): AppSettings => {
  const path = settingsPath();
  if (!existsSync(path)) return {};
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isPlainObject(value)) {
    throw new Error('The application configuration must contain a JSON object. No settings were changed: ' + path);
  }
  return value;
};

// Keep the immediately previous file plus one dated snapshot per day.
// The caller validates the existing JSON before this runs, so backups are
// always made from a readable configuration rather than preserving corruption.
const backupUserAppSettings = async (): Promise<void> => {
  const path = settingsPath();
  if (!existsSync(path)) return;

  const directory = dirname(path);
  const backupPrefix = appConfigName + '.backup-';
  const dailyBackupPath = join(directory, backupPrefix + new Date().toISOString().slice(0, 10));
  // The rolling .bak file can be temporarily locked by Windows (for example
  // by an antivirus scanner or a backup/indexing process). A dated snapshot is
  // an independent valid recovery point, so failure to refresh .bak alone must
  // not prevent otherwise safe settings updates.
  let rollingBackupError: unknown;
  try {
    await copyFile(path, path + '.bak');
  } catch (error) {
    rollingBackupError = error;
  }

  if (!existsSync(dailyBackupPath)) {
    try {
      await copyFile(path, dailyBackupPath);
    } catch (error) {
      if (rollingBackupError) {
        throw new AggregateError(
          [rollingBackupError, error],
          'Could not create either the rolling or dated configuration backup.'
        );
      }
      throw error;
    }
  }

  if (rollingBackupError) {
    console.warn('[Settings] Could not refresh the rolling configuration backup; using the dated snapshot:', rollingBackupError);
  }

  try {
    const backups = (await readdir(directory))
      .filter(name => name.startsWith(backupPrefix))
      .sort()
      .reverse();
    await Promise.all(backups.slice(30).map(name => unlink(join(directory, name)).catch(() => undefined)));
  } catch (error) {
    console.warn('[Settings] Could not rotate dated configuration backups:', error);
  }
};


export type OfflineFileType =
  | 'mbtiles' | 'obf' | 'mapsforge-map' | 'hillshade'
  | 'valhalla-config' | 'osmand-resources' | 'mapsforge-theme-folder' | 'mapsforge-theme';

export interface OfflineFileConfigEntry {
  type: OfflineFileType;
  path: string;
  enabled: boolean;
  size: number;
  name?: string;
  sourcePath?: string;
}

const inferOfflineFileType = (path: string): OfflineFileType | null => {
  const extension = extname(path).toLowerCase();
  if (extension === '.mbtiles') return 'mbtiles';
  if (extension === '.obf') return 'obf';
  if (extension === '.map') return 'mapsforge-map';
  if (['.sqlitedb', '.sqlite', '.db'].includes(extension)) return 'hillshade';
  if (extension === '.json' && /valhalla/i.test(path)) return 'valhalla-config';
  if (extension === '.xml') return 'mapsforge-theme';
  return null;
};

const offlineEntrySize = (type: OfflineFileType, path: string): number => {
  const target = type === 'valhalla-config' ? dirname(path) : path;
  try {
    const stats = statSync(target);
    if (stats.isFile()) return stats.size;
    if (!stats.isDirectory()) return 0;
  } catch { return 0; }
  let total = 0;
  const visit = (directory: string, depth = 0): void => {
    if (depth > 32) return;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = join(directory, entry.name);
      try {
        if (entry.isDirectory()) visit(child, depth + 1);
        else if (entry.isFile()) total += statSync(child).size;
      } catch { /* Keep the total of files that can be read. */ }
    }
  };
  visit(target);
  return total;
};

const normalizeOfflineFileEntries = (settings: AppSettings): OfflineFileConfigEntry[] => {
  const offline = isPlainObject(settings['offline'])
    ? { ...(isPlainObject(settings['Maps']) ? settings['Maps'] : {}), ...(isPlainObject(settings['offlineMaps']) ? settings['offlineMaps'] : {}), ...settings['offline'] }
    : isPlainObject(settings['offlineMaps']) ? settings['offlineMaps'] : isPlainObject(settings['Maps']) ? settings['Maps'] : {};
  const osmand = isPlainObject(settings['osmand']) ? settings['osmand'] : {};
  const valhalla = isPlainObject(settings['valhalla']) ? settings['valhalla'] : {};
  const mapsforge = isPlainObject(settings['mapsforge']) ? settings['mapsforge'] : {};
  const entries = new Map<string, OfflineFileConfigEntry>();
  const computedSizes = new Map<string, number>();
  const add = (raw: unknown, fallbackType?: OfflineFileType, active = true): void => {
    if (!isPlainObject(raw) || typeof raw['path'] !== 'string' || !raw['path'].trim()) return;
    const path = raw['path'].trim();
    const type = (typeof raw['type'] === 'string' ? raw['type'] : fallbackType ?? inferOfflineFileType(path)) as OfflineFileType | null;
    if (!type || !['mbtiles','obf','mapsforge-map','hillshade','valhalla-config','osmand-resources','mapsforge-theme-folder','mapsforge-theme'].includes(type)) return;
    const sourcePath = typeof raw['sourcePath'] === 'string' ? raw['sourcePath'] : undefined;
    const name = typeof raw['name'] === 'string' ? raw['name'] : undefined;
    const key = type + '|' + resolve(path).toLocaleLowerCase() + '|' + (sourcePath ? resolve(sourcePath).toLocaleLowerCase() : name ?? '');
    const previous = entries.get(key);
    const sizeKey = resolve(type === 'valhalla-config' ? dirname(path) : path).toLocaleLowerCase();
    const size = typeof raw['size'] === 'number' && Number.isFinite(raw['size']) && raw['size'] >= 0
      ? raw['size'] : previous?.size ?? computedSizes.get(sizeKey) ?? offlineEntrySize(type, path);
    computedSizes.set(sizeKey, size);
    entries.set(key, { type, path, enabled: typeof raw['enabled'] === 'boolean' ? raw['enabled'] : active, size, ...(name ? { name } : {}), ...(sourcePath ? { sourcePath } : {}) });
  };
  const storedPaths = Array.isArray(offline['paths']) ? offline['paths'] : offline['filePaths'];
  if (Array.isArray(storedPaths)) {
    for (const entry of storedPaths) {
      if (typeof entry === 'string') add({ path: entry, enabled: true });
      else add(entry);
    }
  } else if (isPlainObject(storedPaths)) {
    for (const [path, enabled] of Object.entries(storedPaths)) if (typeof enabled === 'boolean') add({ path, enabled });
  } else if (typeof offline['filePath'] === 'string' && offline['filePath']) add({ path: offline['filePath'], enabled: true });
  if (Array.isArray(offline['obfPaths'])) for (const path of offline['obfPaths']) if (typeof path === 'string') add({ path, enabled: true }, 'obf');
  if (Array.isArray(osmand['hillshadeDatabases'])) for (const entry of osmand['hillshadeDatabases']) add(entry, 'hillshade');
  if (typeof osmand['hillshadeDatabasePath'] === 'string' && osmand['hillshadeDatabasePath']) add({ path: osmand['hillshadeDatabasePath'], enabled: true }, 'hillshade');
  if (typeof osmand['resourcesPath'] === 'string' && osmand['resourcesPath']) add({ path: osmand['resourcesPath'], enabled: true }, 'osmand-resources');
  if (Array.isArray(valhalla['configurations'])) {
    for (const entry of valhalla['configurations']) {
      if (isPlainObject(entry) && typeof entry['path'] === 'string') add({ path: entry['path'], enabled: entry['path'].toLocaleLowerCase() === String(valhalla['configPath'] ?? '').toLocaleLowerCase() }, 'valhalla-config');
    }
  }
  if (typeof valhalla['configPath'] === 'string' && valhalla['configPath']) add({ path: valhalla['configPath'], enabled: true }, 'valhalla-config');
  if (typeof mapsforge['themeFolder'] === 'string' && mapsforge['themeFolder']) add({ path: mapsforge['themeFolder'], enabled: true }, 'mapsforge-theme-folder');
  if (typeof mapsforge['themePath'] === 'string' && mapsforge['themePath']) {
    const themePath = mapsforge['themePath'];
    const themeFolder = typeof mapsforge['themeFolder'] === 'string' && mapsforge['themeFolder'] ? mapsforge['themeFolder'] : dirname(themePath);
    add({ path: themeFolder, name: basename(themePath, extname(themePath)), sourcePath: themePath, enabled: true }, 'mapsforge-theme');
  }
  return [...entries.values()].sort((a, b) => a.type.localeCompare(b.type) || a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
};

export const getOfflineFileEntries = (settings: AppSettings = readAppSettings()): OfflineFileConfigEntry[] =>
  normalizeOfflineFileEntries(settings);

export const migrateOfflineFileSettings = async (): Promise<void> => {
  const userSettings = readUserAppSettings();
  const offline = isPlainObject(userSettings['offline'])
    ? { ...(isPlainObject(userSettings['Maps']) ? userSettings['Maps'] : {}), ...(isPlainObject(userSettings['offlineMaps']) ? userSettings['offlineMaps'] : {}), ...userSettings['offline'] }
    : isPlainObject(userSettings['offlineMaps']) ? userSettings['offlineMaps'] : isPlainObject(userSettings['Maps']) ? userSettings['Maps'] : {};
  const legacySections = userSettings['Maps'] != null || ['osmand', 'valhalla', 'mapsforge'].some(sectionName => {
    const section = isPlainObject(userSettings[sectionName]) ? userSettings[sectionName] : {};
    const keys = sectionName === 'osmand' ? ['hillshadeDatabases', 'hillshadeDatabasePath', 'resourcesPath']
      : sectionName === 'valhalla' ? ['configurations', 'configPath'] : ['themeFolder', 'themePath'];
    return keys.some(key => Object.prototype.hasOwnProperty.call(section, key));
  });
  const legacyRoot = userSettings['offlineMaps'] != null || userSettings['Maps'] != null;
  const storedPaths = Array.isArray(offline['paths']) ? offline['paths'] : offline['filePaths'];
  const needsTypedEntries = legacyRoot || !Array.isArray(storedPaths) || storedPaths.some((entry: unknown) =>
    !isPlainObject(entry) || typeof entry['type'] !== 'string' || typeof entry['size'] !== 'number'
  );
  if (!legacySections && !needsTypedEntries) return;
  await updateAppSettingsSection('offline', { paths: normalizeOfflineFileEntries(userSettings) });
};

const replaceOfflineFileTypes = (
  entries: OfflineFileConfigEntry[],
  types: OfflineFileType[],
  replacements: OfflineFileConfigEntry[]
): OfflineFileConfigEntry[] => [
  ...entries.filter(entry => !types.includes(entry.type)),
  ...replacements
];

const removeLegacyOfflinePathSettings = (settings: AppSettings): void => {
  for (const [sectionName, keys] of Object.entries({
    osmand: ['hillshadeDatabases', 'hillshadeDatabasePath', 'resourcesPath'],
    valhalla: ['configurations', 'configPath'],
    mapsforge: ['themeFolder', 'themePath']
  })) {
    const section = isPlainObject(settings[sectionName]) ? { ...settings[sectionName] as Record<string, unknown> } : null;
    if (!section) continue;
    for (const key of keys) delete section[key];
    if (Object.keys(section).length) settings[sectionName] = section;
    else delete settings[sectionName];
  }
};

export const readAppSettings = (): AppSettings =>
  mergeSettings(readJsonObject(defaultSettingsPath()), readUserAppSettings());

export const updateAppSettingsSection = (section: string, values: Record<string, unknown>): Promise<void> => {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(section)) {
    return Promise.reject(new Error('Invalid application settings section.'));
  }
  const operation = writeQueue.then(async () => {
    let settings: AppSettings;
    try {
      settings = readUserAppSettingsForUpdate();
    } catch (error) {
      console.error('[Settings] Refusing to overwrite an unreadable configuration file:', error);
      throw error;
    }
    try {
      await backupUserAppSettings();
    } catch (error) {
      console.error('[Settings] Could not create a configuration backup; refusing to save changes:', error);
      throw error;
    }
    if (section === 'root') {
      const updated = { ...settings, ...values };
      for (const [key, value] of Object.entries(values)) if (value === undefined) delete updated[key];
      await writeJsonAtomically(settingsPath(), updated);
      return;
    }

    let offlineEntries = normalizeOfflineFileEntries(settings);
    const nextValues = { ...values };
    const calculatedOfflineSizes = new Map<string, number>();
    const addOrReplace = (type: OfflineFileType, rawEntries: unknown[]): void => {
      const replacements: OfflineFileConfigEntry[] = [];
      for (const raw of rawEntries) {
        if (!isPlainObject(raw) || typeof raw['path'] !== 'string' || !raw['path'].trim()) continue;
        const path = raw['path'].trim();
        const sourcePath = typeof raw['sourcePath'] === 'string' ? raw['sourcePath'] : undefined;
        const name = typeof raw['name'] === 'string' ? raw['name'] : undefined;
        const previous = offlineEntries.find(entry => entry.type === type
          && resolve(entry.path).toLocaleLowerCase() === resolve(path).toLocaleLowerCase()
          && (sourcePath ? entry.sourcePath && resolve(entry.sourcePath).toLocaleLowerCase() === resolve(sourcePath).toLocaleLowerCase() : name ? entry.name === name : !entry.sourcePath && !entry.name));
        const sizeKey = resolve(type === 'valhalla-config' ? dirname(path) : path).toLocaleLowerCase();
        const size = typeof raw['size'] === 'number' && Number.isFinite(raw['size']) && raw['size'] >= 0
          ? raw['size'] : previous?.size ?? calculatedOfflineSizes.get(sizeKey) ?? offlineEntrySize(type, path);
        calculatedOfflineSizes.set(sizeKey, size);
        replacements.push({ type, path, enabled: typeof raw['enabled'] === 'boolean' ? raw['enabled'] : true, size, ...(name ? { name } : {}), ...(sourcePath ? { sourcePath } : {}) });
      }
      offlineEntries = replaceOfflineFileTypes(offlineEntries, [type], replacements);
    };

    if (section === 'offline' && Object.prototype.hasOwnProperty.call(values, 'paths') && Array.isArray(values['paths'])) {
      const incoming = (values['paths'] as unknown[]).flatMap((raw: unknown) => {
        if (typeof raw === 'string') return [{ path: raw, enabled: true }];
        return isPlainObject(raw) ? [raw] : [];
      });
      const types = [...new Set(incoming.map((raw: Record<string, unknown>) =>
        typeof raw['type'] === 'string' ? raw['type'] as OfflineFileType : inferOfflineFileType(String(raw['path'] ?? ''))
      ).filter((type): type is OfflineFileType => !!type))];
      if (!incoming.length) {
        offlineEntries = replaceOfflineFileTypes(offlineEntries, ['mbtiles', 'obf', 'mapsforge-map'], []);
      } else {
        for (const type of types) addOrReplace(type, incoming.filter((raw: Record<string, unknown>) =>
          (typeof raw['type'] === 'string' ? raw['type'] : inferOfflineFileType(String(raw['path'] ?? ''))) === type
        ));
      }
      nextValues['paths'] = undefined;
    }
    if (section === 'osmand') {
      if (Array.isArray(values['hillshadeDatabases'])) addOrReplace('hillshade', values['hillshadeDatabases'] as unknown[]);
      else if (typeof values['hillshadeDatabasePath'] === 'string') addOrReplace('hillshade', values['hillshadeDatabasePath'] ? [{ path: values['hillshadeDatabasePath'], enabled: true }] : []);
      if (typeof values['resourcesPath'] === 'string') addOrReplace('osmand-resources', values['resourcesPath'] ? [{ path: values['resourcesPath'], enabled: true }] : []);
      for (const key of ['hillshadeDatabases', 'hillshadeDatabasePath', 'resourcesPath']) nextValues[key] = undefined;
    }
    if (section === 'valhalla') {
      if (Array.isArray(values['configurations'])) {
        const activePath = typeof values['configPath'] === 'string' ? values['configPath'] : '';
        addOrReplace('valhalla-config', (values['configurations'] as unknown[]).flatMap((raw: unknown) =>
          isPlainObject(raw) && typeof raw['path'] === 'string'
            ? [{ path: raw['path'], enabled: raw['path'].toLocaleLowerCase() === activePath.toLocaleLowerCase() }]
            : []
        ));
      }
      if (typeof values['configPath'] === 'string' && values['configPath']) {
        const path = values['configPath'];
        if (!offlineEntries.some(entry => entry.type === 'valhalla-config' && resolve(entry.path).toLocaleLowerCase() === resolve(path).toLocaleLowerCase())) {
          addOrReplace('valhalla-config', [...offlineEntries.filter(entry => entry.type === 'valhalla-config').map(entry => ({ path: entry.path, enabled: false })), { path, enabled: true }]);
        } else {
          offlineEntries = offlineEntries.map(entry => entry.type === 'valhalla-config' ? { ...entry, enabled: resolve(entry.path).toLocaleLowerCase() === resolve(path).toLocaleLowerCase() } : entry);
        }
      }
      for (const key of ['configurations', 'configPath']) nextValues[key] = undefined;
    }
    if (section === 'mapsforge') {
      if (typeof values['themeFolder'] === 'string') addOrReplace('mapsforge-theme-folder', values['themeFolder'] ? [{ path: values['themeFolder'], enabled: true }] : []);
      if (Array.isArray(values['themes'])) {
        const activePath = typeof values['themePath'] === 'string' ? values['themePath'].toLocaleLowerCase() : '';
        addOrReplace('mapsforge-theme', (values['themes'] as unknown[]).flatMap((raw: unknown) =>
          isPlainObject(raw) && typeof raw['path'] === 'string' && typeof raw['sourcePath'] === 'string'
            ? [{ path: raw['path'], name: typeof raw['name'] === 'string' ? raw['name'] : basename(raw['sourcePath'], extname(raw['sourcePath'])),
                sourcePath: raw['sourcePath'], enabled: raw['sourcePath'].toLocaleLowerCase() === activePath }]
            : []
        ));
      } else if (typeof values['themePath'] === 'string' && values['themePath']) {
        const activePath = values['themePath'];
        offlineEntries = offlineEntries.map(entry => entry.type === 'mapsforge-theme'
          ? { ...entry, enabled: (entry.sourcePath ?? entry.path).toLocaleLowerCase() === activePath.toLocaleLowerCase() }
          : entry);
        if (!offlineEntries.some(entry => entry.type === 'mapsforge-theme' && (entry.sourcePath ?? entry.path).toLocaleLowerCase() === activePath.toLocaleLowerCase())) {
          const existingThemes = offlineEntries.filter(entry => entry.type === 'mapsforge-theme')
            .map(entry => ({ path: entry.path, name: entry.name, sourcePath: entry.sourcePath, enabled: entry.enabled, size: entry.size }));
          const themeFolder = typeof values['themeFolder'] === 'string' && values['themeFolder'] ? values['themeFolder'] : dirname(activePath);
          existingThemes.push({ path: themeFolder, name: basename(activePath, extname(activePath)), sourcePath: activePath,
            enabled: true, size: offlineEntrySize('mapsforge-theme', themeFolder) });
          addOrReplace('mapsforge-theme', existingThemes);
        }
      } else if (values['themePath'] === '' && values['themeFolder'] === '') {
        offlineEntries = offlineEntries.filter(entry => entry.type !== 'mapsforge-theme');
      } else if (values['themePath'] === '') {
        offlineEntries = offlineEntries.map(entry => entry.type === 'mapsforge-theme' ? { ...entry, enabled: false } : entry);
      }
      for (const key of ['themeFolder', 'themePath', 'themes']) nextValues[key] = undefined;
    }

    const previous = settings[section];
    const merged: Record<string, unknown> = {
      ...(isPlainObject(previous) ? previous : {}),
      ...nextValues
    };
    for (const [key, value] of Object.entries(nextValues)) if (value === undefined) delete merged[key];
    settings[section] = merged;

    // Every path-backed offline resource is stored exactly once in offline.paths.
    settings['offline'] = {
      ...(isPlainObject(settings['Maps']) ? settings['Maps'] : {}),
      ...(isPlainObject(settings['offlineMaps']) ? settings['offlineMaps'] : {}),
      ...(isPlainObject(settings['offline']) ? settings['offline'] : {}),
      paths: offlineEntries.sort((a, b) => a.type.localeCompare(b.type) || a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }) || (a.name ?? '').localeCompare(b.name ?? '', undefined, { sensitivity: 'base' }))
    };
    removeLegacyOfflinePathSettings(settings);
    delete settings['offlineMaps'];
    delete settings['Maps'];
    await writeJsonAtomically(settingsPath(), settings);
  });
  writeQueue = operation.catch(() => undefined);
  return operation;
};
