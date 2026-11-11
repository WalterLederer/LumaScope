import { app } from 'electron';
import { appConfigName } from 'internal-api';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomically } from '../file-system/json-file';

export type AppSettings = Record<string, unknown>;

const settingsPath = (): string => join(app.getPath('userData'), appConfigName);
let writeQueue: Promise<void> = Promise.resolve();

export const readAppSettings = (): AppSettings => {
  try {
    const path = settingsPath();
    if (!existsSync(path)) return {};
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as AppSettings : {};
  } catch (error) {
    console.warn('[Settings] Could not read application settings:', error);
    return {};
  }
};

export const updateAppSettingsSection = (section: string, values: Record<string, unknown>): Promise<void> => {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(section)) {
    return Promise.reject(new Error('Invalid application settings section.'));
  }
  const operation = writeQueue.then(async () => {
    // Read only after the previous write has completed so concurrent windows
    // cannot overwrite each other's settings with stale snapshots.
    const settings = readAppSettings();
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
    // The unified offlineMaps.filePaths object replaces the former split
    // path lists and enabledByPath dictionary; do not leave stale keys behind.
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
