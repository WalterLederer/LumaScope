import { app, type IpcMainInvokeEvent } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { appendFile, copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { promisify } from 'node:util';
import { IpcHandler } from '../app/decorators/ipc-handler';
import { CacheClearResult, CacheDirectoryStats, CacheImageStatus, CacheInfo, PhotoLocation, ResolveLocationNamesResult } from 'internal-api';
import type { Exif } from '../exif/exif';
import { lookupReverseGeocoding } from 'internal-api';
import { createMigrationTable, dbMigrations, getMigrationRecords, insertMigrationRecord } from './cache-manager.migration';

const execFileAsync = promisify(execFile);
const CACHE_STORAGE_TYPE = { SIDECAR: 2, PARALLEL: 3 } as const;
const THUMBNAIL_CACHE_VERSION = 2;
const THUMBNAIL_CACHE_TAG = 'sidecar-thumbnail-v2';
const FULLSIZE_CACHE_VERSION_CODES: Record<string, number> = {
  'jxr-full-uhdr': 10,
  'avif-full-uhdr': 11,
  'heif-full-uhdr': 12,
  'heic-full-uhdr': 13,
  'hdr-full-uhdr': 14,
  'exr-full-uhdr-v2': 15,
  'tif-full-hdr-v6': 16,
  'tiff-full-hdr-v6': 17
};
const getFullSizeCacheVersionCode = (tag: string): number | null => FULLSIZE_CACHE_VERSION_CODES[tag] ?? null;
const FULL_SIZE_EXTENSIONS = new Set([ '.jxr', '.avif', '.heif', '.heic', '.exr', '.hdr', '.tif', '.tiff' ]);

export interface CacheSummary {
  total: CacheClearResult;
  fullSize: CacheClearResult;
  thumbnails: CacheClearResult;
  sidecar: CacheClearResult;
  gps: CacheClearResult;
  selectedDatabaseKey: string | null;
  databases: Array<{ key: string; path: string; bytes: number }>;
}

interface PhotoRow {
  id: number;
  path_id: number;
  file_name: string;
  file_size: number;
  modified_at: number;
  is_hdr: number;
  thumbnail_cache_id: number | null;
  thumbnail_cache_version: number | null;
  fullsize_cache_id: number | null;
  fullsize_cache_version: number | null;
  latitude: number | null;
  longitude: number | null;
  location_name_id: number | null;
}

export class CacheManager {
  private readonly userData = app.getPath('userData');
  private readonly legacyCacheDir = join(this.userData, 'image-cache');
  private readonly databases = new Map<string, DatabaseSync>();
  private activeDatabaseKey: string | null = null;
  private readonly pendingEntries = new Map<string, Promise<string | null>>();
  private readonly pendingLocationLookups = new Map<string, Promise<string | null>>();
  private locationLookupCancelled = false;
  private currentReverseGeocodingPath: string | null = null;
  private currentReverseGeocodingDisplayName: string | null = null;
  private currentReverseGeocodingPhotoId: number | null = null;
  private currentReverseGeocodingDatabaseKey: string | null = null;

  private readonly activeClearOperations = new Set<string>();

  private readonly cancelledClearOperations = new Set<string>();
  private readonly deletingSources = new Map<string, Promise<CacheClearResult>>();

  constructor() {
    mkdirSync(this.userData, { recursive: true });
    app.on('before-quit', () => {
      for (const db of this.databases.values()) {
        try { db.close(); } catch { /* Ignore shutdown races. */ }
      }
      this.databases.clear();
    });
  }

  private readonly databaseKeyForPath = (sourcePath: string): string => {
    const absolutePath = resolve(sourcePath);
    const root = absolutePath.slice(0, 2);
    if (!/^[a-z]:$/i.test(root)) {
      throw new Error(`Cache database requires a local drive path: ${sourcePath}`);
    }
    return root.slice(0, 2).toUpperCase();
  };

  private readonly databaseForPath = (sourcePath: string): DatabaseSync => {
    const key = this.databaseKeyForPath(sourcePath);
    let db = this.databases.get(key);
    if (!db) {
      const databaseDirectory = join(key + '\\', '.cache');
      mkdirSync(databaseDirectory, { recursive: true });
      const databasePath = join(databaseDirectory, 'LumaScope.cache.sqlite');
      db = new DatabaseSync(databasePath);
      try {
        db.exec('PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;');
        this.databases.set(key, db);
        this.init(db, key);
      } catch (error) {
        this.databases.delete(key);
        try { db.close(); } catch { /* Ignore initialization cleanup failures. */ }
        throw error;
      }
    }
    return db;
  };

  private readonly databaseForDirectoryOrActive = (directory?: string): DatabaseSync => directory ? this.databaseForPath(directory) : this.activeDatabase();

  private readonly activeDatabase = (): DatabaseSync => {
    if (!this.activeDatabaseKey) throw new Error('No gallery drive has selected a cache database yet.');
    const db = this.databases.get(this.activeDatabaseKey);
    if (!db) throw new Error('The active gallery cache database is not open.');
    return db;
  };

  private readonly toRelativeFolderPath = (folderPath: string, databaseKey: string): string | null => {
    const absolute = resolve(folderPath);
    if (!/^[a-z]:$/i.test(absolute.slice(0, 2)) || absolute.slice(0, 2).toUpperCase() !== databaseKey.toUpperCase()) return null;
    const root = resolve(databaseKey + '\\');
    const value = relative(root, absolute);
    if (value === '..' || value.startsWith('..' + sep) || isAbsolute(value)) return null;
    return value.replace(/[\\/]+/g, '\\').replace(/\\+$/, '');
  };

  private readonly resolveStoredFolderPath = (storedPath: string, databaseKey: string): string => {
    if (isAbsolute(storedPath) || /^[a-z]:/i.test(storedPath)) throw new Error(`Non-relative cache folder path: ${storedPath}`);
    const root = resolve(databaseKey + '\\');
    const absolute = resolve(root, storedPath);
    const value = relative(root, absolute);
    if (value === '..' || value.startsWith('..' + sep) || isAbsolute(value)) throw new Error(`Cache folder is outside its drive: ${storedPath}`);
    return absolute;
  };

  @IpcHandler({ name: 'CacheManager.clear' })
  readonly clear = async (_event: IpcMainInvokeEvent, directory?: string, recursive = false, operationId?: string): Promise<CacheClearResult> =>
    this.runClearOperation(operationId, async () => {
      const [thumbnails, fullSize] = await Promise.all([
        this.clearKind('thumbnail', directory, recursive, operationId),
        this.clearKind('fullsize', directory, recursive, operationId)
      ]);
      return {
        entries: thumbnails.entries + fullSize.entries,
        bytes: thumbnails.bytes + fullSize.bytes,
        cancelled: this.isClearCancelled(operationId)
      };
    });

  @IpcHandler({ name: 'CacheManager.cancelClear' })
  readonly cancelClear = async (_event: IpcMainInvokeEvent, operationId: string): Promise<boolean> => {
    if (!operationId || !this.activeClearOperations.has(operationId)) return false;
    this.cancelledClearOperations.add(operationId);
    return true;
  };

  private readonly runClearOperation = async (
    operationId: string | undefined,
    operation: () => Promise<CacheClearResult>
  ): Promise<CacheClearResult> => {
    if (operationId) this.activeClearOperations.add(operationId);
    try {
      return await operation();
    } finally {
      if (operationId) {
        this.activeClearOperations.delete(operationId);
        this.cancelledClearOperations.delete(operationId);
      }
    }
  };

  private readonly isClearCancelled = (operationId?: string): boolean =>
    !!operationId && this.cancelledClearOperations.has(operationId);

  @IpcHandler({ name: 'CacheManager.deleteImage' })
  readonly deleteImage = async (_event: IpcMainInvokeEvent, sourceName: string): Promise<CacheClearResult> => {
    if (!sourceName || !sourceName.trim()) throw new Error('A valid source image path is required.');
    const existing = this.deletingSources.get(sourceName);
    if (existing) return existing;
    const operation = this.deleteImageEntries(sourceName);
    this.deletingSources.set(sourceName, operation);
    try { return await operation; }
    finally { if (this.deletingSources.get(sourceName) === operation) this.deletingSources.delete(sourceName); }
  };

  private readonly deleteImageEntries = async (sourceName: string): Promise<CacheClearResult> => {
    const db = this.databaseForPath(sourceName);
    const pending = [...this.pendingEntries.entries()]
      .filter(([key]) => { try { return JSON.parse(key)[0] === sourceName; } catch { return false; } })
      .map(([, operation]) => operation);
    await Promise.all(pending);
    const row = this.getPhoto(sourceName, db);
    if (!row) return { entries: 0, bytes: 0 };
    let entries = 0;
    let bytes = 0;
    if (row.thumbnail_cache_id === CACHE_STORAGE_TYPE.SIDECAR) {
      const target = this.getSidecarPath(sourceName, false);
      try { bytes += (await stat(target)).size; await rm(target, { force: true }); } catch { /* Missing cache file. */ }
      entries++;
    }
    if (row.fullsize_cache_id === CACHE_STORAGE_TYPE.SIDECAR) {
      const target = this.getSidecarPath(sourceName, true);
      try { bytes += (await stat(target)).size; await rm(target, { force: true }); } catch { /* Missing cache file. */ }
      entries++;
    }
    db.prepare('UPDATE photos SET thumbnail_cache_id = NULL, thumbnail_cache_version = NULL, fullsize_cache_id = NULL, fullsize_cache_version = NULL WHERE id = :id').run({ id: row.id });
    return { entries, bytes };
  };

  @IpcHandler({ name: 'CacheManager.clearFullSize' })
  readonly clearFullSize = async (_event: IpcMainInvokeEvent, directory?: string, recursive = false, operationId?: string): Promise<CacheClearResult> =>
    this.runClearOperation(operationId, async () => {
      const result = await this.clearKind('fullsize', directory, recursive, operationId);
      return { ...result, cancelled: this.isClearCancelled(operationId) };
    });

  @IpcHandler({ name: 'CacheManager.clearThumbnails' })
  readonly clearThumbnails = async (_event: IpcMainInvokeEvent, directory?: string, recursive = false, operationId?: string): Promise<CacheClearResult> =>
    this.runClearOperation(operationId, async () => {
      const result = await this.clearKind('thumbnail', directory, recursive, operationId);
      return { ...result, cancelled: this.isClearCancelled(operationId) };
    });

  private readonly clearKind = async (
    kind: 'thumbnail' | 'fullsize',
    directory?: string,
    recursive = false,
    operationId?: string
  ): Promise<CacheClearResult> => {
    if (directory !== undefined && (typeof directory !== 'string' || !directory.trim())) {
      throw new Error('A valid cache directory is required.');
    }
    if (recursive && !directory) {
      throw new Error('Recursive cache deletion requires a directory.');
    }

    const db = this.databaseForDirectoryOrActive(directory);
    const column = kind === 'thumbnail' ? 'thumbnail' : 'fullsize';
    const allRows = db.prepare('SELECT photos.*, paths.relative_folder_path FROM photos JOIN paths ON paths.id = photos.path_id WHERE photos.' + column + '_cache_id = :cacheId')
      .all({ cacheId: CACHE_STORAGE_TYPE.SIDECAR }) as unknown as Array<PhotoRow & { relative_folder_path: string }>;
    const root = directory ? resolve(directory) : null;
    const rows = root === null ? allRows : allRows.filter(row => {
      const relativeFolder = relative(root, resolve(this.resolveStoredFolderPath(row.relative_folder_path, this.databaseKeyForPath(directory))));
      if (relativeFolder === '') return true;
      return recursive && relativeFolder !== '..' && !relativeFolder.startsWith('..' + sep) && !isAbsolute(relativeFolder);
    });
    let bytes = 0;
    let entries = 0;
    for (const row of rows) {
      if (this.isClearCancelled(operationId)) break;
      const source = join(this.resolveStoredFolderPath(row.relative_folder_path, directory ? this.databaseKeyForPath(directory) : this.activeDatabaseKey!), row.file_name);
      const target = this.getSidecarPath(source, kind === 'fullsize');
      try { bytes += (await stat(target)).size; await rm(target, { force: true }); } catch { /* Missing cache file. */ }
      db.prepare('UPDATE photos SET ' + column + '_cache_id = NULL, ' + column + '_cache_version = NULL WHERE id = :id').run({ id: row.id });
      entries++;
    }
    return { entries, bytes, cancelled: this.isClearCancelled(operationId) };
  };

  @IpcHandler({ name: 'CacheManager.cacheInfo' })
  readonly cacheInfo = async (_event?: IpcMainInvokeEvent, directory?: string, recursive = false): Promise<CacheInfo> => {
    if (directory !== undefined && (typeof directory !== 'string' || !directory.trim())) {
      throw new Error('A valid cache directory is required.');
    }
    if (recursive && !directory) {
      throw new Error('Recursive cache statistics require a directory.');
    }
    const thumbnails = await this.getKindStats('thumbnail', directory, recursive);
    const fullSize = await this.getKindStats('fullsize', directory, recursive);
    return { entries: thumbnails.entries + fullSize.entries, bytes: thumbnails.bytes + fullSize.bytes, thumbnails, fullSize };
  };

  @IpcHandler({ name: 'CacheManager.resolveMissingLocationNames' })
  readonly resolveMissingLocationNames = async (
    _event: IpcMainInvokeEvent,
    directory: string,
    recursive = false
  ): Promise<ResolveLocationNamesResult> => {
    if (typeof directory !== 'string' || !directory.trim()) {
      throw new Error('A valid location lookup directory is required.');
    }

    const db = this.databaseForPath(directory);
    const root = resolve(directory);
    const rows = db.prepare(`SELECT photos.id, photos.latitude, photos.longitude, photos.location_name_id, paths.relative_folder_path,
          CASE WHEN location_names.display_name IS NULL THEN 1 ELSE 0 END AS needs_refresh
      FROM photos JOIN paths ON paths.id = photos.path_id
      LEFT JOIN location_names ON location_names.id = photos.location_name_id
      WHERE photos.latitude IS NOT NULL AND photos.longitude IS NOT NULL
        AND (photos.location_name_id IS NULL OR photos.location_name_id = 0 OR location_names.display_name IS NULL)
      ORDER BY paths.relative_folder_path, photos.file_name`)
      .all() as unknown as Array<Pick<PhotoRow, 'id' | 'latitude' | 'longitude' | 'location_name_id'> & { relative_folder_path: string; needs_refresh: number }>;
    const candidates = rows.filter(row => {
      const relativeFolder = relative(root, resolve(this.resolveStoredFolderPath(row.relative_folder_path, directory ? this.databaseKeyForPath(directory) : this.activeDatabaseKey!)));
      if (relativeFolder === '') return true;
      return recursive && relativeFolder !== '..' && !relativeFolder.startsWith('..' + sep) && !isAbsolute(relativeFolder);
    });

    let processed = 0;
    let resolved = 0;
    let unresolved = 0;
    this.locationLookupCancelled = false;
    for (const row of candidates) {
      if (this.locationLookupCancelled) break;
      // Also refresh older location records that predate persistent full-address storage.
      await this.ensureLocationName({
        ...row,
        location_name_id: row.needs_refresh === 1 ? null : row.location_name_id
      }, db, true, false, row.needs_refresh === 1, this.databaseKeyForPath(directory));
      const saved = db.prepare(`SELECT photos.location_name_id, location_names.display_name
        FROM photos LEFT JOIN location_names ON location_names.id = photos.location_name_id
        WHERE photos.id = :id`)
        .get({ id: row.id }) as { location_name_id: number | null; display_name: string | null } | undefined;
      if (saved?.location_name_id !== null && saved?.location_name_id !== undefined
        && saved.location_name_id !== 0 && saved.display_name !== null) resolved++;
      else unresolved++;
      processed++;
    }
    return { total: processed, resolved, unresolved, cancelled: this.locationLookupCancelled };
  };

  @IpcHandler({ name: 'CacheManager.cancelResolveMissingLocationNames' })
  readonly cancelResolveMissingLocationNames = async (): Promise<boolean> => {
    this.locationLookupCancelled = true;
    return true;
  };

  @IpcHandler({ name: 'CacheManager.getBackgroundReverseGeocodingStatus' })
  readonly getBackgroundReverseGeocodingStatus = async (): Promise<import('internal-api').BackgroundReverseGeocodingStatus> => {
    const db = this.activeDatabase();
    const totals = db.prepare(`SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN location_names.id IS NOT NULL AND location_names.display_name IS NOT NULL THEN 1 ELSE 0 END) AS resolved,
        SUM(CASE WHEN (photos.location_name_id IS NULL OR photos.location_name_id = 0 OR location_names.display_name IS NULL)
          AND photos.location_lookup_error IS NOT NULL THEN 1 ELSE 0 END) AS errors
      FROM photos
      LEFT JOIN location_names ON location_names.id = photos.location_name_id
      WHERE photos.latitude IS NOT NULL AND photos.longitude IS NOT NULL
        AND photos.latitude BETWEEN -90 AND 90 AND photos.longitude BETWEEN -180 AND 180`)
      .get() as { total: number; resolved: number | null; errors: number | null };

    const total = Number(totals.total ?? 0);
    const resolved = Number(totals.resolved ?? 0);
    const errors = Number(totals.errors ?? 0);
    let inProgress = 0;
    const findActivePhoto = db.prepare(`SELECT photos.location_lookup_error, location_names.display_name
      FROM photos
      LEFT JOIN location_names ON location_names.id = photos.location_name_id
      WHERE photos.id = :id
        AND photos.latitude BETWEEN -90 AND 90 AND photos.longitude BETWEEN -180 AND 180`);
    for (const pendingKey of this.pendingLocationLookups.keys()) {
      const [databaseKey, photoId] = pendingKey.split('|');
      if (databaseKey !== this.activeDatabaseKey) continue;
      const active = findActivePhoto.get({ id: Number(photoId) }) as { display_name: string | null; location_lookup_error: string | null } | undefined;
      if (active && active.display_name === null && active.location_lookup_error === null) inProgress++;
    }

    const pending = Math.max(0, total - resolved - errors - inProgress);
    const activePendingCount = [...this.pendingLocationLookups.keys()].filter(key => key.startsWith(`${this.activeDatabaseKey}|`)).length;
    const status = activePendingCount > 0
      ? 'running'
      : total > 0 && pending === 0
        ? 'completed'
        : 'idle';

    return { total, resolved, pending, inProgress, errors, status,
      currentFilePath: this.currentReverseGeocodingDatabaseKey === this.activeDatabaseKey ? this.currentReverseGeocodingPath : null,
      currentDisplayName: this.currentReverseGeocodingDatabaseKey === this.activeDatabaseKey ? this.currentReverseGeocodingDisplayName : null };
  };

  @IpcHandler({ name: 'CacheManager.getCacheSummary' })
  readonly getCacheSummary = async (_event?: IpcMainInvokeEvent, requestedDatabaseKey?: string): Promise<CacheSummary> => {
    const databaseKey = requestedDatabaseKey ?? this.activeDatabaseKey;
    if (!databaseKey || !/^[a-z]:$/i.test(databaseKey)) throw new Error('A valid cache database drive must be selected.');
    const selectedDatabaseKey = databaseKey.toUpperCase();
    const db = this.databases.get(selectedDatabaseKey) ?? this.databaseForPath(selectedDatabaseKey + '\\');
    const rows = db.prepare(`SELECT photos.*, paths.relative_folder_path FROM photos
      JOIN paths ON paths.id = photos.path_id
      WHERE photos.thumbnail_cache_id IS NOT NULL OR photos.fullsize_cache_id IS NOT NULL
      OR (photos.latitude IS NOT NULL AND photos.longitude IS NOT NULL)`)
      .all() as unknown as Array<PhotoRow & { relative_folder_path: string }>;
    const summary: CacheSummary = {
      total: { entries: 0, bytes: 0 },
      fullSize: { entries: 0, bytes: 0 },
      thumbnails: { entries: 0, bytes: 0 },
      sidecar: { entries: 0, bytes: 0 },
      gps: { entries: 0, bytes: 0 },
      selectedDatabaseKey,
      databases: []
    };

    for (const row of rows) {
      const source = join(this.resolveStoredFolderPath(row.relative_folder_path, selectedDatabaseKey), row.file_name);
      if (row.latitude !== null && row.longitude !== null
        && Number.isFinite(row.latitude) && Number.isFinite(row.longitude)
        && row.latitude >= -90 && row.latitude <= 90 && row.longitude >= -180 && row.longitude <= 180) {
        summary.gps.entries++;
        summary.gps.bytes += row.file_size;
      }

      if (row.thumbnail_cache_id === CACHE_STORAGE_TYPE.SIDECAR) {
        const path = this.getSidecarPath(source, false);
        try {
          const info = await stat(path);
          if (info.isFile()) {
            summary.thumbnails.entries++;
            summary.thumbnails.bytes += info.size;
            summary.sidecar.entries++;
            summary.sidecar.bytes += info.size;
          }
        } catch { /* Missing thumbnail cache file. */ }
      }

      if (row.fullsize_cache_id !== null) {
        const parallel = row.fullsize_cache_id === CACHE_STORAGE_TYPE.PARALLEL;
        const path = parallel ? this.getParallelPath(source) : this.getSidecarPath(source, true);
        try {
          const info = await stat(path);
          if (info.isFile()) {
            summary.fullSize.entries++;
            summary.fullSize.bytes += info.size;
            if (!parallel) {
              summary.sidecar.entries++;
              summary.sidecar.bytes += info.size;
            }
          }
        } catch { /* Missing full-size cache file. */ }
      }
    }

    summary.total.entries = summary.fullSize.entries + summary.thumbnails.entries;
    summary.total.bytes = summary.fullSize.bytes + summary.thumbnails.bytes;

    for (const key of this.databases.keys()) {
      const databasePath = join(key + '\\', '.cache', 'LumaScope.cache.sqlite');
      try { const info = await stat(databasePath); summary.databases.push({ key, path: databasePath, bytes: info.size }); } catch { /* Database may be removed. */ }
    }
    summary.databases.sort((left, right) => left.path.localeCompare(right.path, undefined, { sensitivity: 'base' }));
    return summary;
  };

  @IpcHandler({ name: 'CacheManager.clearOsmAndTileCache' })
  readonly clearOsmAndTileCache = async (): Promise<CacheClearResult> => {
    const summary = await this.getOsmAndTileCacheSummary();
    const cachePath = summary.path;
    const expectedRoot = resolve(process.env.LOCALAPPDATA || app.getPath('appData'), 'LumaScope', 'cache', 'maps', 'obf');
    if (resolve(cachePath) !== expectedRoot) {
      throw new Error('Refusing to clear an unexpected OsmAnd tile cache path.');
    }
    await rm(cachePath, { recursive: true, force: true });
    return { entries: summary.entries, bytes: summary.bytes };
  };

  @IpcHandler({ name: 'CacheManager.getOsmAndTileCacheSummary' })
  readonly getOsmAndTileCacheSummary = async (): Promise<{ path: string; entries: number; bytes: number; available: boolean }> => {
    const localAppData = process.env.LOCALAPPDATA || app.getPath('appData');
    const cachePath = join(localAppData, 'LumaScope', 'cache', 'maps', 'obf');
    if (!existsSync(cachePath)) return { path: cachePath, entries: 0, bytes: 0, available: false };

    let entries = 0;
    let bytes = 0;
    const visit = async (directory: string): Promise<void> => {
      const children = await readdir(directory, { withFileTypes: true });
      for (const child of children) {
        const childPath = join(directory, child.name);
        if (child.isDirectory()) {
          await visit(childPath);
        } else if (child.isFile() && extname(child.name).toLowerCase() === '.png') {
          const info = await stat(childPath);
          entries++;
          bytes += info.size;
        }
      }
    };

    await visit(cachePath);
    return { path: cachePath, entries, bytes, available: true };
  };

  @IpcHandler({ name: 'CacheManager.cacheSize' })
  readonly cacheSize = async (): Promise<number> => (await this.cacheInfo()).bytes;

  @IpcHandler({ name: 'CacheManager.getBuildLogPath' })
  readonly getBuildLogPath = async (): Promise<string> => join(this.userData, 'cache-build.log');

  @IpcHandler({ name: 'CacheManager.resetBuildLog' })
  readonly resetBuildLog = async (): Promise<void> => {
    await writeFile(join(this.userData, 'cache-build.log'), '', 'utf-8');
  };

  @IpcHandler({ name: 'CacheManager.appendBuildLog' })
  readonly appendBuildLog = async (_event: IpcMainInvokeEvent, line: string): Promise<void> => {
    if (typeof line !== 'string' || line.length > 1048576) throw new Error('Invalid cache log entry.');
    await appendFile(join(this.userData, 'cache-build.log'), line.endsWith('\n') ? line : line + '\n', 'utf-8');
  };

  @IpcHandler({ name: 'CacheManager.getImageCacheStatuses' })
  readonly getImageCacheStatuses = async (
    _event: IpcMainInvokeEvent,
    sourceNames: string[],
    verifyCacheFiles = false,
    sourceMetadata: Array<{ path: string; size: number; modifiedAt: number }> = []
  ): Promise<CacheImageStatus[]> => {
    if (!Array.isArray(sourceNames) || sourceNames.length > 10000 || sourceNames.some(path => typeof path !== 'string' || !path.trim())) {
      throw new Error('A list of valid image paths is required.');
    }

    const metadataByPath = new Map(sourceMetadata.map(item => [item.path, item]));

    return Promise.all([...new Set(sourceNames)].map(async sourceName => {
      const db = this.databaseForPath(sourceName);
      const row = this.getPhoto(sourceName, db) ?? undefined;
      // Cache status checks must never wait for reverse geocoding. Geocoding is
      // performed when GPS metadata is written, independently of gallery status.
      const extension = extname(sourceName).toLowerCase();
      const fullSizeRequired = FULL_SIZE_EXTENSIONS.has(extension);
      const expectedFullSizeTag = `${extension.slice(1)}${[ '.tif', '.tiff' ].includes(extension) ? '-full-hdr-v6' : extension === '.exr' ? '-full-uhdr-v2' : '-full-uhdr'}`;
      const metadata = metadataByPath.get(sourceName);
      const sourceMatches = !metadata || (!!row && row.file_size === metadata.size && row.modified_at === metadata.modifiedAt);
      const getStatus = (kind: 'thumbnail' | 'fullsize') => {
        if (!row || !sourceMatches) return null;
        const id = kind === 'thumbnail' ? row.thumbnail_cache_id : row.fullsize_cache_id;
        const version = kind === 'thumbnail' ? row.thumbnail_cache_version : row.fullsize_cache_version;
        const expectedVersion = kind === 'thumbnail' ? THUMBNAIL_CACHE_VERSION : getFullSizeCacheVersionCode(expectedFullSizeTag);
        if (id === null || expectedVersion === null || version !== expectedVersion) return null;
        const parallel = id === CACHE_STORAGE_TYPE.PARALLEL && kind === 'fullsize';
        return {
          status: 'valid' as const,
          path: parallel ? this.getParallelPath(sourceName) : this.getSidecarPath(sourceName, kind === 'fullsize'),
          storageType: parallel ? 'parallel' as const : 'sidecar' as const,
          sourceTag: kind === 'thumbnail' ? THUMBNAIL_CACHE_TAG : expectedFullSizeTag
        };
      };
      let thumbnail = getStatus('thumbnail');
      let fullSize = fullSizeRequired ? getStatus('fullsize') : null;
      const verification = { sourceChecked: false, thumbnailChecked: false, fullSizeChecked: false, invalidEntries: 0 };
      if (verifyCacheFiles && row && sourceMatches && (thumbnail || fullSize)) {
        verification.sourceChecked = true;
        try {
          const sourceStats = await stat(sourceName);
          if (sourceStats.size !== row.file_size || sourceStats.mtimeMs !== row.modified_at) {
            verification.invalidEntries = Number(!!thumbnail) + Number(!!fullSize);
            thumbnail = null;
            fullSize = null;
          } else {
            if (thumbnail) {
              verification.thumbnailChecked = true;
              try { const info = await stat(thumbnail.path); if (!info.isFile()) { thumbnail = null; verification.invalidEntries++; } }
              catch { thumbnail = null; verification.invalidEntries++; }
            }
            if (fullSize) {
              verification.fullSizeChecked = true;
              try { const info = await stat(fullSize.path); if (!info.isFile()) { fullSize = null; verification.invalidEntries++; } }
              catch { fullSize = null; verification.invalidEntries++; }
            }
          }
        } catch {
          verification.invalidEntries = Number(!!thumbnail) + Number(!!fullSize);
          thumbnail = null;
          fullSize = null;
        }
      }
      return { sourceName, thumbnail, fullSize, fullSizeRequired, latitude: row?.latitude ?? null, longitude: row?.longitude ?? null, verification };
    }));
  };

  @IpcHandler({ name: 'CacheManager.getDirectoryCacheStats' })
  readonly getDirectoryCacheStats = async (_event: IpcMainInvokeEvent, sourceNames: string[], verifyCacheFiles = false): Promise<CacheDirectoryStats> => {
    if (!Array.isArray(sourceNames) || sourceNames.length > 10000 || sourceNames.some(path => typeof path !== 'string' || !path.trim())) {
      throw new Error('A list of valid image paths is required.');
    }
    if (sourceNames.length === 0) return { total: 0, thumbnails: 0, fullSizeConversions: 0, thumbnailPaths: [], fullSizePaths: [] };
    const folder = dirname(sourceNames[0]);
    const db = this.databaseForPath(sourceNames[0]);
    const requestedNames = new Set(sourceNames.filter(sourceName => dirname(sourceName) === folder).map(sourceName => basename(sourceName).toLowerCase()));
    const rows = db.prepare(`SELECT photos.*, paths.relative_folder_path FROM photos
      JOIN paths ON paths.id = photos.path_id WHERE paths.relative_folder_path = :folder COLLATE NOCASE
      AND (photos.thumbnail_cache_id IS NOT NULL OR photos.fullsize_cache_id IS NOT NULL)`)
      .all({ folder: this.toRelativeFolderPath(folder, this.databaseKeyForPath(folder)) ?? '' }) as unknown as Array<PhotoRow & { relative_folder_path: string }>;
    const matching = rows.filter(row => requestedNames.has(row.file_name.toLowerCase()));
    const thumbnailPaths: string[] = [];
    const fullSizePaths: string[] = [];
    await Promise.all(matching.map(async row => {
      const sourceName = join(folder, row.file_name);
      const extension = extname(sourceName).toLowerCase();
      const thumbnailValid = row.thumbnail_cache_id === CACHE_STORAGE_TYPE.SIDECAR
        && row.thumbnail_cache_version === THUMBNAIL_CACHE_VERSION;
      const fullSizeTag = `${extension.slice(1)}${[ '.tif', '.tiff' ].includes(extension) ? '-full-hdr-v6' : extension === '.exr' ? '-full-uhdr-v2' : '-full-uhdr'}`;
      const fullSizeValid = FULL_SIZE_EXTENSIONS.has(extension) && row.fullsize_cache_id !== null
        && row.fullsize_cache_version === getFullSizeCacheVersionCode(fullSizeTag);
      if (!verifyCacheFiles) {
        if (thumbnailValid) thumbnailPaths.push(sourceName);
        if (fullSizeValid) fullSizePaths.push(sourceName);
        return;
      }
      try {
        const sourceStats = await stat(sourceName);
        if (sourceStats.size !== row.file_size || sourceStats.mtimeMs !== row.modified_at) return;
      } catch { return; }
      if (thumbnailValid) {
        try { const info = await stat(this.getSidecarPath(sourceName, false)); if (info.isFile()) thumbnailPaths.push(sourceName); }
        catch { /* Missing thumbnail cache file. */ }
      }
      if (fullSizeValid) {
        const fullSizePath = row.fullsize_cache_id === CACHE_STORAGE_TYPE.PARALLEL
          ? this.getParallelPath(sourceName) : this.getSidecarPath(sourceName, true);
        try { const info = await stat(fullSizePath); if (info.isFile()) fullSizePaths.push(sourceName); }
        catch { /* Missing full-size cache file. */ }
      }
    }));
    return { total: sourceNames.length, thumbnails: thumbnailPaths.length, fullSizeConversions: fullSizePaths.length, thumbnailPaths, fullSizePaths };
  };

  @IpcHandler({ name: 'CacheManager.getDirectoryPhotoLocations' })
  readonly getDirectoryPhotoLocations = async (_event: IpcMainInvokeEvent, directory: string): Promise<PhotoLocation[]> => {
    if (typeof directory !== 'string' || !directory.trim()) throw new Error('A valid image folder path is required.');
    const db = this.databaseForPath(directory);
    this.activeDatabaseKey = this.databaseKeyForPath(directory);
    const rows = db.prepare(`SELECT photos.file_name, photos.latitude, photos.longitude, photos.gps_timestamp,
        location_names.display_name AS location_display_name
      FROM photos JOIN paths ON paths.id = photos.path_id
      LEFT JOIN location_names ON location_names.id = photos.location_name_id AND photos.location_name_id <> 0
      WHERE paths.relative_folder_path = :folder COLLATE NOCASE
      ORDER BY photos.file_name COLLATE NOCASE`)
      .all({ folder: this.toRelativeFolderPath(directory, this.databaseKeyForPath(directory)) ?? '' }) as unknown as Array<{ file_name: string; latitude: number | null; longitude: number | null; gps_timestamp: number | null; location_display_name: string | null }>;
    return rows.map(row => ({
      path: join(directory, row.file_name),
      fileName: row.file_name,
      latitude: row.latitude,
      longitude: row.longitude,
      gpsTimestamp: row.gps_timestamp,
      displayName: row.location_display_name
    }));
  };

  @IpcHandler({ name: 'CacheManager.getPhotoDatabaseRecord' })
  readonly getPhotoDatabaseRecord = async (_event: IpcMainInvokeEvent, sourceName: string): Promise<Record<string, string | number | null> | null> => {
    if (typeof sourceName !== 'string' || !sourceName.trim()) throw new Error('A valid image path is required.');
    const db = this.databaseForPath(sourceName);
    const row = db.prepare(`SELECT photos.*, paths.relative_folder_path
      FROM photos
      JOIN paths ON paths.id = photos.path_id
      WHERE paths.relative_folder_path = :folder COLLATE NOCASE AND photos.file_name = :file COLLATE NOCASE
    `).get({ folder: this.toRelativeFolderPath(dirname(sourceName), this.databaseKeyForPath(sourceName)) ?? '', file: basename(sourceName) }) as unknown as Record<string, string | number | null> | undefined;
    if (!row) return null;
    const columnTypes = new Map<string, string>();
    for (const table of ['photos', 'paths']) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>;
      for (const column of columns) columnTypes.set(column.name, column.type.toUpperCase());
    }
    const databaseKey = this.databaseKeyForPath(sourceName);
    const typedRecord: Record<string, string | number | null> = { ...row };
    if (typeof row.relative_folder_path === 'string') {
      typedRecord.relative_folder_path_expanded = this.resolveStoredFolderPath(row.relative_folder_path, databaseKey);
    }
    typedRecord.database_path = join(databaseKey + '\\', '.cache', 'LumaScope.cache.sqlite');
    for (const key of Object.keys(row)) {
      typedRecord[`${key}_type`] = columnTypes.get(key) ?? 'TEXT';
    }
    return typedRecord;
  };

  @IpcHandler({ name: 'CacheManager.resolvePhotoLocation' })
  readonly resolvePhotoLocation = async (
    _event: IpcMainInvokeEvent,
    sourceName: string,
    latitude: number,
    longitude: number
  ): Promise<string | null> => {
    if (typeof sourceName !== 'string' || !sourceName.trim()) throw new Error('A valid image path is required.');
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
      || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      throw new Error('Valid GPS coordinates are required.');
    }

    const db = this.databaseForPath(sourceName);
    const sourceStats = await stat(sourceName);
    if (!sourceStats.isFile()) throw new Error('The selected image file is not available.');
    const row = this.ensurePhoto(sourceName, Number(sourceStats.size), Number(sourceStats.mtimeMs), db);

    if (row.latitude !== latitude || row.longitude !== longitude) {
      db.prepare(`UPDATE photos SET latitude = :latitude, longitude = :longitude,
        location_name_id = NULL, location_lookup_error = NULL, location_lookup_attempted_at = NULL
        WHERE id = :id`)
        .run({ latitude, longitude, id: row.id });
    }

    const updated = this.getPhoto(sourceName);
    if (!updated) return null;
    // Map-window address display is a normal read path: reuse the saved DB location
    // and only contact the provider when this photo has no linked location yet.
    const resolvedDisplayName = await this.ensureLocationName(updated, db, true, true, false, this.databaseKeyForPath(sourceName));

    const saved = db.prepare(`SELECT location_names.display_name, location_names.place_name,
        location_names.locality, location_names.region, location_names.country_code
      FROM photos JOIN location_names ON location_names.id = photos.location_name_id WHERE photos.id = :id`)
      .get({ id: row.id }) as { display_name: string | null; place_name: string; locality: string | null; region: string | null; country_code: string | null } | undefined;
    if (!saved) throw new Error('The reverse-geocoding provider returned no location for these GPS coordinates.');
    return saved.display_name || resolvedDisplayName || [saved.place_name, saved.locality, saved.region, saved.country_code]
      .filter((part, index, values): part is string => !!part && values.indexOf(part) === index)
      .join(', ');
  };

  @IpcHandler({ name: 'CacheManager.imageCachePath' })
  readonly imageCachePath = async (_event: IpcMainInvokeEvent, sourceName: string): Promise<string | null> => {
    const row = this.getPhoto(sourceName);
    if (!row || row.fullsize_cache_id === null || !row.fullsize_cache_version) return null;
    const path = row.fullsize_cache_id === CACHE_STORAGE_TYPE.PARALLEL ? this.getParallelPath(sourceName) : this.getSidecarPath(sourceName, true);
    try {
      const [sourceStats, cacheStats] = await Promise.all([stat(sourceName), stat(path)]);
      return sourceStats.size === row.file_size && sourceStats.mtimeMs === row.modified_at && cacheStats.isFile() ? path : null;
    } catch { return null; }
  };


  readonly updatePhotoMetadata = async (sourceName: string, isHdr: boolean, gps: Awaited<ReturnType<Exif['readPhotoMetadata']>>): Promise<void> => {
    const db = this.databaseForPath(sourceName);
    const sourceStats = await stat(sourceName);
    const row = this.ensurePhoto(sourceName, Number(sourceStats.size), Number(sourceStats.mtimeMs), db);
    const hasCoordinates = gps.latitude !== null && gps.longitude !== null;
    db.prepare(`UPDATE photos SET is_hdr = :isHdr,
      location_name_id = CASE WHEN latitude IS NOT :latitude OR longitude IS NOT :longitude THEN NULL ELSE location_name_id END,
      location_lookup_error = CASE WHEN latitude IS NOT :latitude OR longitude IS NOT :longitude THEN NULL ELSE location_lookup_error END,
      location_lookup_attempted_at = CASE WHEN latitude IS NOT :latitude OR longitude IS NOT :longitude THEN NULL ELSE location_lookup_attempted_at END,
      latitude = :latitude, longitude = :longitude,
      altitude_m = :altitude, gps_timestamp = :gpsTimestamp, direction_deg = :direction,
      coordinate_source_id = :sourceId WHERE id = :id`)
      .run({
        isHdr: isHdr ? 1 : 0,
        latitude: hasCoordinates ? gps.latitude : null,
        longitude: hasCoordinates ? gps.longitude : null,
        altitude: hasCoordinates ? gps.altitudeM : null,
        gpsTimestamp: hasCoordinates ? gps.gpsTimestamp : null,
        direction: hasCoordinates ? gps.directionDeg : null,
        sourceId: hasCoordinates ? gps.coordinateSourceId : null,
        id: row.id
      });
    if (hasCoordinates) {
      const updated = this.getPhoto(sourceName);
      // Resolve the location in the background so metadata and thumbnail work can continue immediately.
      if (updated) void this.ensureLocationName(updated, db, false, false, false, this.databaseKeyForPath(sourceName));
    }
  };

  readonly usesSidecarStorage = (_sourceName: string): boolean => true;

  readonly exists = (sourceName: string, sourceTag: string): Record<string, SQLOutputValue> | null => {
    const row = this.getPhoto(sourceName);
    if (!row) return null;
    const full = sourceTag.includes('-full-');
    const cacheId = full ? row.fullsize_cache_id : row.thumbnail_cache_id;
    const version = full ? row.fullsize_cache_version : row.thumbnail_cache_version;
    const expectedVersion = full ? getFullSizeCacheVersionCode(sourceTag) : THUMBNAIL_CACHE_VERSION;
    if (cacheId === null || expectedVersion === null || version !== expectedVersion || (!full && sourceTag !== THUMBNAIL_CACHE_TAG)) return null;
    return {
      storage_type_id: cacheId,
      source_size: row.file_size,
      updated_at: row.modified_at,
      target_path: cacheId === CACHE_STORAGE_TYPE.PARALLEL && full ? this.getParallelPath(sourceName) : this.getSidecarPath(sourceName, full)
    };
  };

  readonly forgetParallel = (sourceName: string, sourceTag: string): void => {
    const db = this.databaseForPath(sourceName);
    const row = this.getPhoto(sourceName, db);
    if (row?.fullsize_cache_id === CACHE_STORAGE_TYPE.PARALLEL && row.fullsize_cache_version === getFullSizeCacheVersionCode(sourceTag)) {
      db.prepare('UPDATE photos SET fullsize_cache_id = NULL, fullsize_cache_version = NULL WHERE id = :id').run({ id: row.id });
    }
  };

  readonly registerParallel = async (sourceName: string, sourceTag: string, targetPath: string): Promise<string | null> => {
    if (!FULL_SIZE_EXTENSIONS.has(extname(sourceName).toLowerCase()) || resolve(targetPath) !== resolve(this.getParallelPath(sourceName))) return null;
    try {
      const db = this.databaseForPath(sourceName);
      const [sourceStats, targetStats] = await Promise.all([stat(sourceName), stat(targetPath)]);
      if (!targetStats.isFile()) return null;
      const previous = this.getPhoto(sourceName, db);
      const row = this.ensurePhoto(sourceName, Number(sourceStats.size), Number(sourceStats.mtimeMs), db);
      if (previous?.fullsize_cache_id === CACHE_STORAGE_TYPE.SIDECAR) {
        await rm(this.getSidecarPath(sourceName, true), { force: true });
      }
      db.prepare('UPDATE photos SET fullsize_cache_id = :cacheId, fullsize_cache_version = :version WHERE id = :id')
        .run({ cacheId: CACHE_STORAGE_TYPE.PARALLEL, version: getFullSizeCacheVersionCode(sourceTag), id: row.id });
      return targetPath;
    } catch { return null; }
  };

  readonly get = async (sourceName: string, sourceTag: string, callback?: (cachePath: string) => Promise<boolean>, _targetExtension = extname(sourceName)): Promise<string | null> => {
    const deletion = this.deletingSources.get(sourceName);
    if (deletion) {
      await deletion;
      return this.get(sourceName, sourceTag, callback, _targetExtension);
    }
    const key = JSON.stringify([sourceName, sourceTag]);
    const pending = this.pendingEntries.get(key);
    if (pending) return pending;
    const operation = this.getOrCreate(sourceName, sourceTag, callback);
    this.pendingEntries.set(key, operation);
    try { return await operation; }
    finally { if (this.pendingEntries.get(key) === operation) this.pendingEntries.delete(key); }
  };

  private readonly getOrCreate = async (sourceName: string, sourceTag: string, callback?: (cachePath: string) => Promise<boolean>): Promise<string | null> => {
    const db = this.databaseForPath(sourceName);
    const sourceStats = await stat(sourceName);
    const previous = this.getPhoto(sourceName, db);
    const full = sourceTag.includes('-full-');
    const previousSize = previous?.file_size;
    const previousModified = previous?.modified_at;
    const row = this.ensurePhoto(sourceName, Number(sourceStats.size), Number(sourceStats.mtimeMs), db);
    // Cache retrieval and thumbnail generation must never wait for network geocoding.
    const parallelPath = this.getParallelPath(sourceName);
    if (full && existsSync(parallelPath)) {
      await this.registerParallel(sourceName, sourceTag, parallelPath);
      return parallelPath;
    }
    const targetPath = this.getSidecarPath(sourceName, full);
    const cacheId = full ? previous?.fullsize_cache_id : previous?.thumbnail_cache_id;
    const cacheVersion = full ? previous?.fullsize_cache_version : previous?.thumbnail_cache_version;
    const sourceChanged = previous !== null && (previousSize !== sourceStats.size || previousModified !== sourceStats.mtimeMs);
    const storedVersion = full ? getFullSizeCacheVersionCode(sourceTag) : sourceTag === THUMBNAIL_CACHE_TAG ? THUMBNAIL_CACHE_VERSION : null;
    if (sourceChanged || (cacheVersion !== null && cacheVersion !== storedVersion)) await rm(targetPath, { force: true });
    if (!sourceChanged && cacheId === CACHE_STORAGE_TYPE.SIDECAR && cacheVersion === storedVersion && storedVersion !== null && existsSync(targetPath)) return targetPath;
    await this.ensureCacheDirectory(dirname(targetPath));
    if (!existsSync(targetPath)) {
      const generated = callback ? await callback(targetPath) : (await copyFile(sourceName, targetPath), true);
      if (!generated) return null;
    }
    db.prepare('UPDATE photos SET ' + (full ? 'fullsize' : 'thumbnail') + '_cache_id = :cacheId, ' +
      (full ? 'fullsize' : 'thumbnail') + '_cache_version = :version WHERE id = :id')
      .run({ cacheId: CACHE_STORAGE_TYPE.SIDECAR, version: storedVersion, id: row.id });
    return targetPath;
  };

  private readonly getPhoto = (sourceName: string, db = this.databaseForPath(sourceName)): PhotoRow | null => {
    const row = db.prepare('SELECT photos.* FROM photos JOIN paths ON paths.id = photos.path_id WHERE paths.relative_folder_path = :folder COLLATE NOCASE AND photos.file_name = :file COLLATE NOCASE')
      .get({ folder: this.toRelativeFolderPath(dirname(sourceName), this.databaseKeyForPath(sourceName)) ?? '', file: basename(sourceName) }) as unknown as PhotoRow | undefined;
    return row ?? null;
  };

  private readonly ensurePhoto = (sourceName: string, size: number, modified: number, db = this.databaseForPath(sourceName)): PhotoRow => {
    const folder = this.toRelativeFolderPath(dirname(sourceName), this.databaseKeyForPath(sourceName));
    if (folder === null) throw new Error(`Image path is outside the cache database drive: ${sourceName}`);
    db.prepare('INSERT OR IGNORE INTO paths (relative_folder_path) VALUES (:folder)').run({ folder });
    const path = db.prepare('SELECT id FROM paths WHERE relative_folder_path = :folder COLLATE NOCASE').get({ folder }) as { id: number };
    db.prepare(`INSERT INTO photos (path_id, file_name, file_size, modified_at, is_hdr)
      VALUES (:pathId, :file, :size, :modified, 0)
      ON CONFLICT(path_id, file_name) DO UPDATE SET
        is_hdr = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN 0 ELSE photos.is_hdr END,
        latitude = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.latitude END,
        longitude = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.longitude END,
        altitude_m = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.altitude_m END,
        gps_timestamp = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.gps_timestamp END,
        direction_deg = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.direction_deg END,
        location_name_id = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.location_name_id END,
        coordinate_source_id = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.coordinate_source_id END,
        file_size = excluded.file_size,
        modified_at = excluded.modified_at`)
      .run({ pathId: path.id, file: basename(sourceName), size, modified });
    return this.getPhoto(sourceName, db)!;
  };

  private readonly ensureLocationName = async (photo: Pick<PhotoRow, 'id' | 'latitude' | 'longitude' | 'location_name_id'>, db: DatabaseSync, retryUnknown = false, throwOnError = false, forceRefresh = false, databaseKey = this.activeDatabaseKey ?? ''): Promise<string | null> => {
    if ((photo.location_name_id !== null && !(retryUnknown && photo.location_name_id === 0) && !forceRefresh) || photo.latitude === null || photo.longitude === null
      || !Number.isFinite(photo.latitude) || !Number.isFinite(photo.longitude)
      || photo.latitude < -90 || photo.latitude > 90 || photo.longitude < -180 || photo.longitude > 180) return null;

    const pendingKey = `${databaseKey}|${photo.id}`;
    const pending = this.pendingLocationLookups.get(pendingKey);
    if (pending) return pending;

    const operation = (async (): Promise<string | null> => {
      let locationNameId: number | null = null;
      let displayName: string | null = null;
      let lookupError: string | null = null;
      let thrownError: unknown = null;
      const startedAt = Date.now();
      this.currentReverseGeocodingPhotoId = photo.id;
      this.currentReverseGeocodingDatabaseKey = databaseKey;
      this.currentReverseGeocodingDisplayName = null;
      const source = db.prepare(`SELECT paths.relative_folder_path, photos.file_name FROM photos JOIN paths ON paths.id = photos.path_id WHERE photos.id = :photoId`)
        .get({ photoId: photo.id }) as { relative_folder_path: string; file_name: string } | undefined;
      this.currentReverseGeocodingPath = source ? join(this.resolveStoredFolderPath(source.relative_folder_path, databaseKey), source.file_name) : null;
      db.prepare(`UPDATE photos
        SET location_lookup_error = NULL, location_lookup_attempted_at = :attemptedAt
        WHERE id = :photoId`)
        .run({ attemptedAt: startedAt, photoId: photo.id });

      try {
        const location = await lookupReverseGeocoding(photo.latitude!, photo.longitude!, 'en');
        if (location) {
          displayName = location.displayName;
          if (this.currentReverseGeocodingPhotoId === photo.id && this.currentReverseGeocodingDatabaseKey === databaseKey) this.currentReverseGeocodingDisplayName = location.displayName;
          db.prepare(`INSERT OR IGNORE INTO location_names
            (latitude, longitude, place_name, display_name, street, country_code, region, locality, provider, updated_at)
            VALUES (:latitude, :longitude, :placeName, :displayName, :street, :countryCode, :region, :locality, 'nominatim', :updatedAt)`)
            .run({
              latitude: photo.latitude,
              longitude: photo.longitude,
              placeName: location.placeName,
              displayName: location.displayName,
              street: location.street,
              countryCode: location.countryCode,
              region: location.region,
              locality: location.locality,
              updatedAt: Date.now()
            });
          const saved = db.prepare(`SELECT id FROM location_names
            WHERE lower(trim(place_name)) = lower(trim(:placeName))
              AND lower(trim(COALESCE(display_name, ''))) = lower(trim(:displayName))
              AND lower(trim(COALESCE(street, ''))) = lower(trim(COALESCE(:street, '')))
              AND lower(trim(COALESCE(country_code, ''))) = lower(trim(COALESCE(:countryCode, '')))
              AND lower(trim(COALESCE(region, ''))) = lower(trim(COALESCE(:region, '')))
              AND lower(trim(COALESCE(locality, ''))) = lower(trim(COALESCE(:locality, '')))
              AND lower(trim(COALESCE(provider, ''))) = 'nominatim'
            ORDER BY id
            LIMIT 1`)
            .get({
              placeName: location.placeName,
              displayName: location.displayName,
              street: location.street,
              countryCode: location.countryCode,
              region: location.region,
              locality: location.locality
            }) as { id: number } | undefined
            ?? db.prepare(`SELECT id FROM location_names
              WHERE latitude = :latitude AND longitude = :longitude AND provider = 'nominatim'`)
              .get({ latitude: photo.latitude, longitude: photo.longitude }) as { id: number } | undefined;
          if (saved) {
            locationNameId = saved.id;
            db.prepare(`UPDATE location_names
              SET display_name = :displayName, street = :street, updated_at = :updatedAt
              WHERE id = :id`)
              .run({ displayName: location.displayName, street: location.street, updatedAt: Date.now(), id: saved.id });
          } else {
            lookupError = 'The provider returned a location, but it could not be stored in the database.';
          }
        } else {
          lookupError = 'The provider returned no location result for these coordinates.';
        }
      } catch (error) {
        lookupError = error instanceof Error ? error.message : String(error);
        thrownError = error;
        console.error('[CacheManager] Reverse geocoding failed', {
          photoId: photo.id,
          latitude: photo.latitude,
          longitude: photo.longitude,
          error: lookupError
        });
      }

      db.prepare(`UPDATE photos SET
          location_name_id = CASE WHEN :locationNameId IS NOT NULL THEN :locationNameId ELSE location_name_id END,
          location_lookup_error = :lookupError,
          location_lookup_attempted_at = :attemptedAt
        WHERE id = :photoId
          AND (:locationNameId IS NOT NULL OR location_name_id IS NULL OR (:retryUnknown = 1 AND location_name_id = 0) OR :forceRefresh = 1)`)
        .run({
          locationNameId,
          lookupError,
          attemptedAt: Date.now(),
          photoId: photo.id,
          retryUnknown: retryUnknown ? 1 : 0,
          forceRefresh: forceRefresh ? 1 : 0
        });
      if (throwOnError && thrownError) throw thrownError;
      if (this.currentReverseGeocodingPhotoId === photo.id && this.currentReverseGeocodingDatabaseKey === databaseKey) this.currentReverseGeocodingDisplayName = displayName;
      return displayName;
    })();

    this.pendingLocationLookups.set(pendingKey, operation);
    try { return await operation; }
    finally { if (this.pendingLocationLookups.get(pendingKey) === operation) this.pendingLocationLookups.delete(pendingKey); }
  };

  private readonly getSidecarPath = (sourceName: string, full: boolean): string => {
    const extension = extname(sourceName).slice(1).toLowerCase();
    const base = basename(sourceName, extname(sourceName));
    return join(dirname(sourceName), '.cache', full ? base + '_' + extension + '.jpg' : base + '_' + extension + '_thumb.jpg');
  };

  private readonly getParallelPath = (sourceName: string): string =>
    join(dirname(dirname(sourceName)), 'jpg', basename(sourceName, extname(sourceName)) + '.jpg');

  private readonly ensureCacheDirectory = async (directory: string): Promise<void> => {
    await mkdir(directory, { recursive: true });
    if (process.platform === 'win32') await execFileAsync('attrib', ['+h', directory]);
  };

  private readonly getKindStats = async (kind: 'thumbnail' | 'fullsize', directory?: string, recursive = false): Promise<CacheClearResult> => {
    const db = this.databaseForDirectoryOrActive(directory);
    const column = kind === 'thumbnail' ? 'thumbnail' : 'fullsize';
    const allRows = db.prepare('SELECT photos.*, paths.relative_folder_path FROM photos JOIN paths ON paths.id = photos.path_id WHERE photos.' + column + '_cache_id = :cacheId')
      .all({ cacheId: CACHE_STORAGE_TYPE.SIDECAR }) as unknown as Array<PhotoRow & { relative_folder_path: string }>;
    const root = directory ? resolve(directory) : null;
    const rows = root === null ? allRows : allRows.filter(row => {
      const relativeFolder = relative(root, resolve(this.resolveStoredFolderPath(row.relative_folder_path, directory ? this.databaseKeyForPath(directory) : this.activeDatabaseKey!)));
      if (relativeFolder === '') return true;
      return recursive && relativeFolder !== '..' && !relativeFolder.startsWith('..' + sep) && !isAbsolute(relativeFolder);
    });
    let bytes = 0;
    let existingEntries = 0;
    for (const row of rows) {
      const path = this.getSidecarPath(join(this.resolveStoredFolderPath(row.relative_folder_path, directory ? this.databaseKeyForPath(directory) : this.activeDatabaseKey!), row.file_name), kind === 'fullsize');
      try {
        const info = await stat(path);
        bytes += info.size;
        existingEntries++;
      } catch { /* Missing cache file. */ }
    }
    return { entries: existingEntries, bytes };
  };

  private readonly init = (db: DatabaseSync, databaseKey: string): void => {
    db.exec(createMigrationTable);
    const migrations = db.prepare(getMigrationRecords).all() as Array<{ name: string }>;
    const insert = db.prepare(insertMigrationRecord);
    for (const migration of dbMigrations) {
      if (!migrations.some(item => item.name === migration.name)) {
        db.exec(migration.query);
        insert.run({ name: migration.name });
      }
    }
    if (!migrations.some(item => item.name === 'storeDriveRelativePhotoPathsV16')) {
      this.migrateDriveRelativePhotoPaths(db, databaseKey);
      insert.run({ name: 'storeDriveRelativePhotoPathsV16' });
    }
    if (!migrations.some(item => item.name === 'migrateLegacyCacheFilesToPhotosV8')) {
      this.migrateLegacyCacheFiles(db, databaseKey);
      insert.run({ name: 'migrateLegacyCacheFilesToPhotosV8' });
    }
    if (!migrations.some(item => item.name === 'renameFolderPathToRelativeFolderPathV17')) {
      const columns = db.prepare('PRAGMA table_info(paths)').all() as Array<{ name: string }>;
      const hasOldColumn = columns.some(column => column.name === 'folder_path');
      const hasNewColumn = columns.some(column => column.name === 'relative_folder_path');
      if (hasOldColumn && !hasNewColumn) {
        db.exec('BEGIN IMMEDIATE;');
        try {
          db.exec('ALTER TABLE paths RENAME COLUMN folder_path TO relative_folder_path;');
          insert.run({ name: 'renameFolderPathToRelativeFolderPathV17' });
          db.exec('COMMIT;');
        } catch (error) {
          try { db.exec('ROLLBACK;'); } catch { /* Keep the original migration error. */ }
          throw error;
        }
      } else if (hasNewColumn) {
        insert.run({ name: 'renameFolderPathToRelativeFolderPathV17' });
      } else {
        throw new Error('Cache database migration failed: paths.relative_folder_path is missing.');
      }
    }
    db.exec("DELETE FROM cache_storage_types WHERE name = 'central';");
    rm(this.legacyCacheDir, { recursive: true, force: true }).catch(() => undefined);
  };

  private readonly migrateDriveRelativePhotoPaths = (db: DatabaseSync, databaseKey: string): void => {
    db.exec('BEGIN IMMEDIATE;');
    try {
      const rows = db.prepare('SELECT id, folder_path FROM paths ORDER BY id').all() as Array<{ id: number; folder_path: string }>;
      const photosForPath = db.prepare('SELECT * FROM photos WHERE path_id = :id ORDER BY id');
      const findPhoto = db.prepare('SELECT id FROM photos WHERE path_id = :pathId AND file_name = :file COLLATE NOCASE');
      const movePhoto = db.prepare('UPDATE photos SET path_id = :pathId WHERE id = :id');
      const deletePathPhotos = db.prepare('DELETE FROM photos WHERE path_id = :id');
      const deletePath = db.prepare('DELETE FROM paths WHERE id = :id');
      const updateFolder = db.prepare('UPDATE paths SET folder_path = :folder WHERE id = :id');
      const mergePhoto = db.prepare(`UPDATE photos SET
        file_size = CASE WHEN file_size = 0 THEN :file_size ELSE file_size END,
        modified_at = CASE WHEN modified_at = 0 THEN :modified_at ELSE modified_at END,
        is_hdr = MAX(is_hdr, :is_hdr),
        thumbnail_cache_id = COALESCE(thumbnail_cache_id, :thumbnail_cache_id),
        thumbnail_cache_version = COALESCE(thumbnail_cache_version, :thumbnail_cache_version),
        fullsize_cache_id = COALESCE(fullsize_cache_id, :fullsize_cache_id),
        fullsize_cache_version = COALESCE(fullsize_cache_version, :fullsize_cache_version),
        latitude = COALESCE(latitude, :latitude), longitude = COALESCE(longitude, :longitude),
        altitude_m = COALESCE(altitude_m, :altitude_m), gps_timestamp = COALESCE(gps_timestamp, :gps_timestamp),
        direction_deg = COALESCE(direction_deg, :direction_deg),
        coordinate_source_id = COALESCE(coordinate_source_id, :coordinate_source_id),
        location_name_id = COALESCE(location_name_id, :location_name_id),
        location_lookup_error = COALESCE(location_lookup_error, :location_lookup_error),
        location_lookup_attempted_at = COALESCE(location_lookup_attempted_at, :location_lookup_attempted_at)
        WHERE id = :id`);
      const canonical = new Map<string, number>();
      for (const item of rows) {
        let folder: string | null = /^[a-z]:/i.test(item.folder_path)
          ? this.toRelativeFolderPath(item.folder_path, databaseKey)
          : item.folder_path.replace(/[\\/]+/g, '\\').replace(/^\\+|\\+$/g, '');
        if (folder !== null) {
          const driveRoot = resolve(databaseKey + '\\');
          const normalized = relative(driveRoot, resolve(driveRoot, folder));
          folder = normalized === '..' || normalized.startsWith('..' + sep) || isAbsolute(normalized)
            ? null
            : normalized.replace(/[\\/]+/g, '\\').replace(/\\+$/, '');
        }
        if (folder !== null && (isAbsolute(folder) || /^[a-z]:/i.test(folder) || folder === '..' || folder.startsWith('..' + sep))) {
          deletePathPhotos.run({ id: item.id });
          deletePath.run({ id: item.id });
          continue;
        }
        if (folder === null) {
          deletePathPhotos.run({ id: item.id });
          deletePath.run({ id: item.id });
          continue;
        }
        const key = folder.toLowerCase();
        const canonicalId = canonical.get(key);
        if (canonicalId === undefined) {
          updateFolder.run({ folder, id: item.id });
          canonical.set(key, item.id);
          continue;
        }
        const photos = photosForPath.all({ id: item.id }) as Array<Record<string, SQLOutputValue> & { id: number; file_name: string }>;
        for (const photo of photos) {
          const existing = findPhoto.get({ pathId: canonicalId, file: photo.file_name }) as { id: number } | undefined;
          if (existing) {
            mergePhoto.run({ ...photo, id: existing.id });
            db.prepare('DELETE FROM photos WHERE id = :id').run({ id: photo.id });
          } else {
            movePhoto.run({ pathId: canonicalId, id: photo.id });
          }
        }
        deletePath.run({ id: item.id });
      }
      db.exec('DELETE FROM paths WHERE id NOT IN (SELECT DISTINCT path_id FROM photos);');
      db.exec('COMMIT;');
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch { /* Keep the original migration error. */ }
      throw error;
    }
  };

  private readonly migrateLegacyCacheFiles = (db: DatabaseSync, databaseKey: string): void => {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cache_files'").get();
    if (!table) return;
    const rows = db.prepare('SELECT * FROM cache_files').all() as Array<Record<string, SQLOutputValue>>;
    const insertPath = db.prepare('INSERT OR IGNORE INTO paths (folder_path) VALUES (:folder)');
    const findPath = db.prepare('SELECT id FROM paths WHERE folder_path = :folder COLLATE NOCASE');
    const insertPhoto = db.prepare('INSERT OR IGNORE INTO photos (path_id, file_name, file_size, modified_at, is_hdr) VALUES (:pathId, :file, :size, :modified, :hdr)');
    const updatePhoto = db.prepare('UPDATE photos SET thumbnail_cache_id = CASE WHEN :full = 0 THEN :cacheId ELSE thumbnail_cache_id END, thumbnail_cache_version = CASE WHEN :full = 0 THEN :version ELSE thumbnail_cache_version END, fullsize_cache_id = CASE WHEN :full = 1 THEN :cacheId ELSE fullsize_cache_id END, fullsize_cache_version = CASE WHEN :full = 1 THEN :version ELSE fullsize_cache_version END WHERE path_id = :pathId AND file_name = :file');
    for (const row of rows) {
      const source = String(row.source_name ?? '');
      const storageId = Number(row.storage_type_id);
      if (!source || storageId === 1) continue;
      const folder = this.toRelativeFolderPath(dirname(source), databaseKey);
      if (folder === null) continue;
      const file = basename(source);
      const tag = String(row.source_tag ?? '');
      const full = tag.includes('-full-');
      const expected = storageId === CACHE_STORAGE_TYPE.PARALLEL && full ? this.getParallelPath(source) : this.getSidecarPath(source, full);
      if (resolve(String(row.target_path ?? '')) !== resolve(expected)) continue;
      insertPath.run({ folder });
      const path = findPath.get({ folder }) as { id: number };
      insertPhoto.run({ pathId: path.id, file, size: Number(row.source_size ?? 0), modified: Number(row.updated_at ?? 0), hdr: 0 });
      updatePhoto.run({ full: full ? 1 : 0, cacheId: storageId, version: full ? getFullSizeCacheVersionCode(tag) : tag === THUMBNAIL_CACHE_TAG ? THUMBNAIL_CACHE_VERSION : null, pathId: path.id, file });
    }
    db.exec('DROP TABLE cache_files; DROP TABLE IF EXISTS cache_volume_settings;');
  };
}
