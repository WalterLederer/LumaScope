import { app, BrowserWindow, dialog, type IpcMainInvokeEvent } from 'electron';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { appendFile, copyFile, mkdir, opendir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { promisify } from 'node:util';
import { IpcHandler } from '../app/decorators/ipc-handler';
import { CacheClearResult, CacheDirectoryStats, CacheImageStatus, CacheInfo, FileInfo, PhotoLocation, ResolveLocationNamesResult, SortDirection, SortType, supportedFileExtensions, formatOsDateTime } from 'internal-api';
import type { Exif } from '../exif/exif';
import { abortReverseGeocoding, isReverseGeocodingPaused, lookupReverseGeocoding, pauseReverseGeocoding, resumeReverseGeocoding } from 'internal-api';
import { createMigrationTable, dbMigrations, getMigrationRecords, insertMigrationRecord } from './cache-manager.migration';

const execFileAsync = promisify(execFile);
const CACHE_STORAGE_TYPE = { SIDECAR: 2, PARALLEL: 3 } as const;
const THUMBNAIL_CACHE_VERSION = 2;
// Bump when the bundled thumbnail decoder support changes so failed files are retried.
const THUMBNAIL_FAILURE_VERSION = 1;
const DNG_THUMBNAIL_CACHE_VERSION = 3;
const OHSP_THUMBNAIL_CACHE_VERSION = 13;
const THUMBNAIL_CACHE_TAG = 'sidecar-thumbnail-v2';
const FULLSIZE_CACHE_VERSION_CODES: Record<string, number> = {
  'jxr-full-uhdr': 10,
  'avif-full-uhdr': 11,
  'heif-full-uhdr': 12,
  'heic-full-uhdr': 13,
  'hdr-full-uhdr': 14,
  'exr-full-uhdr-v2': 15,
  'tif-full-hdr-v6': 16,
  'tiff-full-hdr-v6': 17,
  'dng-full-raw-v2': 19,
  'camera-raw-full-v1': 20,
  'ohsp-full-spectrum-v15': 35
};
const getFullSizeCacheVersionCode = (tag: string): number | null => FULLSIZE_CACHE_VERSION_CODES[tag] ?? null;
const getThumbnailCacheVersion = (sourceName: string): number => {
  const extension = extname(sourceName).toLowerCase();
  return extension === '.dng' ? DNG_THUMBNAIL_CACHE_VERSION : extension === '.ohsp' ? OHSP_THUMBNAIL_CACHE_VERSION : THUMBNAIL_CACHE_VERSION;
};
const FULL_SIZE_EXTENSIONS = new Set([ '.jxr', '.avif', '.heif', '.heic', '.exr', '.hdr', '.tif', '.tiff', '.dng', '.rw2', '.raw', '.ohsp' ]);
const CHROMIUM_NATIVE_IMAGE_EXTENSIONS = new Set([ '.jpg', '.jpeg', '.jpe', '.png', '.gif', '.webp', '.bmp', '.svg', '.avif' ]);
const DIRECT_IMAGE_MAX_DIMENSION = 1024;

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
  gps_timestamp: number | null;
  is_hdr: number;
  thumbnail_cache_id: number | null;
  thumbnail_cache_version: number | null;
  thumbnail_failure_size: number | null;
  thumbnail_failure_modified_at: number | null;
  thumbnail_failure_version: number | null;
  fullsize_cache_id: number | null;
  fullsize_cache_version: number | null;
  latitude: number | null;
  longitude: number | null;
  location_name_id: number | null;
  gps_manually_corrected: number;
  gps_manual_corrected_at: number | null;
}



export class CacheManager {
  private readonly userData = app.getPath('userData');
  private readonly legacyCacheDir = join(this.userData, 'image-cache');
  private readonly databases = new Map<string, DatabaseSync>();
  // Counts are stable for a gallery query until its folder is changed; avoid a COUNT(*) scan for every virtual page request.
  private readonly galleryCountCache = new Map<string, number>();
  private activeDatabaseKey: string | null = null;
  private readonly pendingEntries = new Map<string, Promise<string | null>>();
  private readonly pendingLocationLookups = new Map<string, Promise<string | null>>();
  // Keep background reverse-geocoding requests bounded while cache builds
  // continue. Nominatim allows roughly one request per second, so queuing every
  // image from a large folder can otherwise retain thousands of promises in V8.
  private static readonly maxBackgroundLocationLookups = 20;
  private backgroundLocationLookupReservations = 0;
  private readonly backgroundLocationLookupWaiters: Array<() => void> = [];

  private readonly acquireBackgroundLocationLookupSlot = async (): Promise<() => void> => {
    if (this.backgroundLocationLookupReservations >= CacheManager.maxBackgroundLocationLookups) {
      // A released reservation is handed directly to the next waiter, so
      // concurrent cache workers cannot briefly exceed the configured limit.
      await new Promise<void>(resolve => this.backgroundLocationLookupWaiters.push(resolve));
    } else {
      this.backgroundLocationLookupReservations++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.backgroundLocationLookupWaiters.shift();
      if (next) next();
      else this.backgroundLocationLookupReservations = Math.max(0, this.backgroundLocationLookupReservations - 1);
    };
  };
  private locationLookupCancelled = false;
  private currentReverseGeocodingPath: string | null = null;
  private currentReverseGeocodingDisplayName: string | null = null;
  private currentReverseGeocodingPhotoId: number | null = null;
  private currentReverseGeocodingDatabaseKey: string | null = null;

  private readonly broadcastCacheEvent = (channel: string, ...args: unknown[]): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
      window.webContents.send(channel, ...args);
    }
  };

  private readonly notifyReverseGeocodingStatusChanged = (): void => {
    this.broadcastCacheEvent('CacheManager.reverseGeocodingStatusChanged');
  };

  private readonly notifyGalleryFilesChanged = (directory: string): void => {
    // Gallery mutations can affect recursive parent queries as well as this folder.
    this.galleryCountCache.clear();
    this.broadcastCacheEvent('CacheManager.galleryFilesChanged', directory);
  };

  private readonly notifyDirectoryPhotoLocationsChanged = (directory: string): void => {
    this.broadcastCacheEvent('CacheManager.directoryPhotoLocationsChanged', directory);
    this.notifyReverseGeocodingStatusChanged();
  };

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
        db.function('reverse', (value: unknown) => [...String(value ?? '')].reverse().join(''));
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
    db.prepare('UPDATE photos SET thumbnail_cache_id = NULL, thumbnail_cache_version = NULL, thumbnail_failure_size = NULL, thumbnail_failure_modified_at = NULL, thumbnail_failure_version = NULL, fullsize_cache_id = NULL, fullsize_cache_version = NULL WHERE id = :id').run({ id: row.id });
    return { entries, bytes };
  };

  @IpcHandler({ name: 'CacheManager.removeGalleryFile' })
  readonly removeGalleryFile = async (_event: IpcMainInvokeEvent, sourceName: string): Promise<boolean> => {
    if (!sourceName || !sourceName.trim()) throw new Error('A valid gallery file path is required.');
    const db = this.databaseForPath(sourceName);
    const row = this.getPhoto(sourceName, db);
    if (!row) return false;
    await this.deleteImageEntries(sourceName);
    db.prepare('DELETE FROM photos WHERE id = :id').run({ id: row.id });
    db.prepare('DELETE FROM paths WHERE id = :pathId AND NOT EXISTS (SELECT 1 FROM photos WHERE path_id = :pathId)')
      .run({ pathId: row.path_id });
    this.notifyGalleryFilesChanged(dirname(sourceName));
    return true;
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
    const allRows = db.prepare('SELECT photos.*, paths.relative_folder_path FROM photos JOIN paths ON paths.id = photos.path_id WHERE photos.' + column + '_cache_id = :cacheId' + (kind === 'thumbnail' ? ' OR photos.thumbnail_failure_version IS NOT NULL' : ''))
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
      if (kind === 'thumbnail') {
        db.prepare('UPDATE photos SET thumbnail_cache_id = NULL, thumbnail_cache_version = NULL, thumbnail_failure_size = NULL, thumbnail_failure_modified_at = NULL, thumbnail_failure_version = NULL WHERE id = :id')
          .run({ id: row.id });
      } else {
        db.prepare('UPDATE photos SET fullsize_cache_id = NULL, fullsize_cache_version = NULL WHERE id = :id')
          .run({ id: row.id });
      }
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

  @IpcHandler({ name: 'CacheManager.pauseBackgroundReverseGeocoding' })
  readonly pauseBackgroundReverseGeocoding = async (): Promise<boolean> => {
    pauseReverseGeocoding();
    this.notifyReverseGeocodingStatusChanged();
    return true;
  };

  @IpcHandler({ name: 'CacheManager.resumeBackgroundReverseGeocoding' })
  readonly resumeBackgroundReverseGeocoding = async (): Promise<boolean> => {
    resumeReverseGeocoding();
    this.notifyReverseGeocodingStatusChanged();
    return true;
  };

  @IpcHandler({ name: 'CacheManager.abortBackgroundReverseGeocoding' })
  readonly abortBackgroundReverseGeocoding = async (): Promise<boolean> => {
    this.locationLookupCancelled = true;
    abortReverseGeocoding();
    this.notifyReverseGeocodingStatusChanged();
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

    return { total, resolved, pending, inProgress, errors, status, paused: isReverseGeocodingPaused(),
      currentFilePath: this.currentReverseGeocodingDatabaseKey === this.activeDatabaseKey ? this.currentReverseGeocodingPath : null,
      currentDisplayName: this.currentReverseGeocodingDatabaseKey === this.activeDatabaseKey ? this.currentReverseGeocodingDisplayName : null };
  };

  private readonly importGpxFilePaths = async (databaseKey: string, candidates: string[], folder: string): Promise<{
    folder: string; files: number; segments: number; points: number; timestampedPoints: number;
    imported: number; unchanged: number; duplicates: number; errors: number; cancelled: false;
  }> => {
    const db = this.databaseForPath(databaseKey + '\\');
    const driveRoot = resolve(databaseKey + '\\');
    let imported = 0, unchanged = 0, duplicates = 0, errors = 0;
    const findByPath = db.prepare('SELECT id, content_hash, file_size, modified_at FROM gpx_files WHERE relative_file_path = :path COLLATE NOCASE');
    const findByHash = db.prepare('SELECT id, relative_file_path FROM gpx_files WHERE content_hash = :hash');
    const deleteFile = db.prepare('DELETE FROM gpx_files WHERE id = :id');
    const insertFile = db.prepare(`INSERT INTO gpx_files
      (relative_file_path, file_name, file_size, modified_at, content_hash, imported_at, point_count, segment_count)
      VALUES (:path, :name, :size, :modified, :hash, :importedAt, :points, :segments)`);
    const insertSegment = db.prepare(`INSERT INTO gpx_track_segments
      (gpx_file_id, segment_index, point_count, start_timestamp_ms, end_timestamp_ms)
      VALUES (:fileId, :index, :count, :start, :end)`);
    const insertPoint = db.prepare(`INSERT INTO gpx_track_points
      (segment_id, point_index, timestamp_ms, latitude, longitude, elevation_m)
      VALUES (:segmentId, :index, :timestamp, :latitude, :longitude, :elevation)`);
    const insertBounds = db.prepare(`INSERT OR REPLACE INTO gpx_segment_rtree
      (segment_id, min_latitude, max_latitude, min_longitude, max_longitude)
      VALUES (:id, :minLat, :maxLat, :minLon, :maxLon)`);

    let processedPointCount = 0;
    for (const filePath of candidates) {
      try {
        const absolute = resolve(filePath);
        const relativePath = relative(driveRoot, absolute);
        if (!relativePath || relativePath === '..' || relativePath.startsWith('..' + sep) || isAbsolute(relativePath)) {
          errors++;
          continue;
        }
        const info = await stat(absolute);
        const xml = await readFile(absolute, 'utf8');
        const hash = createHash('sha256').update(xml).digest('hex');
        const existing = findByPath.get({ path: relativePath }) as { id: number; content_hash: string | null; file_size: number; modified_at: number } | undefined;
        if (existing?.content_hash === hash) {
          db.prepare('UPDATE gpx_files SET file_size = :size, modified_at = :modified WHERE id = :id')
            .run({ id: existing.id, size: info.size, modified: Math.trunc(info.mtimeMs) });
          // Older imports may contain stale elevation values even when the source
          // GPX has no <ele> elements (for example, LumaScope Photo Markers GPX).
          // Reconcile that metadata even when the file content hash is unchanged.
          const hasElevation = /<(?:[\w.-]+:)?ele\b[^>]*>\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\s*<\/(?:[\w.-]+:)?ele\s*>/i.test(xml);
          if (!hasElevation) {
            db.prepare(`UPDATE gpx_track_points SET elevation_m = NULL
              WHERE segment_id IN (SELECT id FROM gpx_track_segments WHERE gpx_file_id = :fileId)`)
              .run({ fileId: existing.id });
          }
          unchanged++;
          continue;
        }
        const duplicate = findByHash.get({ hash }) as { id: number; relative_file_path: string } | undefined;
        if (duplicate && duplicate.id !== existing?.id) {
          if (existing) {
            db.exec('BEGIN IMMEDIATE;');
            try { deleteFile.run({ id: existing.id }); db.exec('COMMIT;'); }
            catch (error) { try { db.exec('ROLLBACK;'); } catch { /* Preserve the database error. */ } throw error; }
          }
          duplicates++;
          continue;
        }

        const pointPattern = /<(?:[\w.-]+:)?(trkpt|rtept)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?\1\s*>)/gi;
        const parsePoints = (content: string): Array<{ latitude: number; longitude: number; timestamp: number | null; elevation: number | null }> => {
          const points: Array<{ latitude: number; longitude: number; timestamp: number | null; elevation: number | null }> = [];
          let match: RegExpExecArray | null;
          while ((match = pointPattern.exec(content)) !== null) {
            const lat = Number(/\blat\s*=\s*["']([^"']+)["']/i.exec(match[2])?.[1]);
            const lon = Number(/\blon\s*=\s*["']([^"']+)["']/i.exec(match[2])?.[1]);
            if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
            const body = match[3] ?? '';
            const timeText = /<(?:[\w.-]+:)?time\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?time\s*>/i.exec(body)?.[1]?.trim();
            const elevationText = /<(?:[\w.-]+:)?ele\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?ele\s*>/i.exec(body)?.[1]?.trim();
            const timestamp = timeText ? Date.parse(timeText) : Number.NaN;
            const elevation = elevationText ? Number(elevationText) : Number.NaN;
            points.push({ latitude: lat, longitude: lon, timestamp: Number.isFinite(timestamp) ? timestamp : null, elevation: Number.isFinite(elevation) ? elevation : null });
          }
          pointPattern.lastIndex = 0;
          return points;
        };
        const segmentPattern = /<(?:[\w.-]+:)?trkseg\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?trkseg\s*>/gi;
        const segments: ReturnType<typeof parsePoints>[] = [];
        let segmentMatch: RegExpExecArray | null;
        while ((segmentMatch = segmentPattern.exec(xml)) !== null) {
          const points = parsePoints(segmentMatch[1]);
          if (points.length) segments.push(points);
        }
        if (!segments.length) {
          const points = parsePoints(xml);
          if (points.length) segments.push(points);
        }
        const pointCount = segments.reduce((total, segment) => total + segment.length, 0);
        if (!pointCount) { errors++; continue; }

        db.exec('BEGIN IMMEDIATE;');
        try {
          if (existing) deleteFile.run({ id: existing.id });
          const fileResult = insertFile.run({
            path: relativePath.replace(/[\\/]+/g, sep), name: basename(absolute),
            size: info.size, modified: Math.trunc(info.mtimeMs), hash, importedAt: Date.now(),
            points: pointCount, segments: segments.length
          });
          const fileId = Number(fileResult.lastInsertRowid);
          for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
            const points = segments[segmentIndex];
            let startTimestamp: number | null = null, endTimestamp: number | null = null;
            for (const point of points) {
              if (point.timestamp === null) continue;
              startTimestamp = startTimestamp === null ? point.timestamp : Math.min(startTimestamp, point.timestamp);
              endTimestamp = endTimestamp === null ? point.timestamp : Math.max(endTimestamp, point.timestamp);
            }
            const segmentResult = insertSegment.run({
              fileId, index: segmentIndex, count: points.length,
              start: startTimestamp, end: endTimestamp
            });
            const segmentId = Number(segmentResult.lastInsertRowid);
            let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
            for (let pointIndex = 0; pointIndex < points.length; pointIndex++) {
              const point = points[pointIndex];
              insertPoint.run({
                segmentId, index: pointIndex, timestamp: point.timestamp,
                latitude: point.latitude, longitude: point.longitude, elevation: point.elevation
              });
              minLat = Math.min(minLat, point.latitude); maxLat = Math.max(maxLat, point.latitude);
              minLon = Math.min(minLon, point.longitude); maxLon = Math.max(maxLon, point.longitude);
              if (++processedPointCount % 5000 === 0) {
                await new Promise<void>(resolveYield => setImmediate(resolveYield));
              }
            }
            insertBounds.run({ id: segmentId, minLat, maxLat, minLon, maxLon });
          }
          db.exec('COMMIT;');
          imported++;
        } catch (error) {
          try { db.exec('ROLLBACK;'); } catch { /* Preserve the import error. */ }
          throw error;
        }
      } catch {
        errors++;
      }
    }

    const counts = db.prepare(`SELECT
      (SELECT COUNT(*) FROM gpx_files) AS files,
      (SELECT COUNT(*) FROM gpx_track_segments) AS segments,
      (SELECT COUNT(*) FROM gpx_track_points) AS points,
      (SELECT COUNT(*) FROM gpx_track_points WHERE timestamp_ms IS NOT NULL) AS timestampedPoints`).get() as { files: number; segments: number; points: number; timestampedPoints: number };
    return { folder, ...counts, imported, unchanged, duplicates, errors, cancelled: false };
  };

  @IpcHandler({ name: 'CacheManager.importGpxFolder' })
  readonly importGpxFolder = async (): Promise<{
    folder: string | null; files: number; segments: number; points: number;
    imported: number; unchanged: number; duplicates: number; errors: number; cancelled: boolean;
  }> => {
    const selection = await dialog.showOpenDialog({
      title: 'Add all GPX tracks from folder to cache database',
      properties: ['openDirectory']
    });
    if (selection.canceled || !selection.filePaths[0]) {
      return { folder: null, files: 0, segments: 0, points: 0, imported: 0, unchanged: 0, duplicates: 0, errors: 0, cancelled: true };
    }
    const folder = resolve(selection.filePaths[0]);
    const databaseKey = this.databaseKeyForPath(folder);
    this.activeDatabaseKey = databaseKey;
    const candidates: string[] = [];
    const pending = [folder];
    while (pending.length) {
      const directory = pending.pop()!;
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const fullPath = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!['.cache', '$RECYCLE.BIN', 'System Volume Information', 'node_modules', '.git'].includes(entry.name)) pending.push(fullPath);
        } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.gpx') candidates.push(fullPath);
      }
    }
    return this.importGpxFilePaths(databaseKey, candidates, folder);
  };

  @IpcHandler({ name: 'CacheManager.importGpxFiles' })
  readonly importGpxFiles = async (_event?: IpcMainInvokeEvent, filePaths?: string[]): Promise<{
    files: number; imported: number; unchanged: number; duplicates: number; errors: number;
  }> => {
    const grouped = new Map<string, string[]>();
    for (const candidate of filePaths ?? []) {
      if (typeof candidate !== 'string' || !candidate || extname(candidate).toLowerCase() !== '.gpx') continue;
      const absolute = resolve(candidate);
      try { if (!(await stat(absolute)).isFile()) continue; } catch { continue; }
      const key = this.databaseKeyForPath(absolute);
      const group = grouped.get(key) ?? [];
      if (!group.some(path => path.toLowerCase() === absolute.toLowerCase())) group.push(absolute);
      grouped.set(key, group);
    }
    let files = 0, imported = 0, unchanged = 0, duplicates = 0, errors = 0;
    for (const [key, paths] of grouped) {
      const result = await this.importGpxFilePaths(key, paths, dirname(paths[0]));
      files += result.files; imported += result.imported; unchanged += result.unchanged;
      duplicates += result.duplicates; errors += result.errors;
    }
    return { files, imported, unchanged, duplicates, errors };
  };

  @IpcHandler({ name: 'CacheManager.exportGpxTrackFromMemory' })
  readonly exportGpxTrackFromMemory = async (_event?: IpcMainInvokeEvent, trackName?: string, sourceSegments?: Array<Array<{ latitude: number; longitude: number; elevation: number | null; timestamp: string | null }>>): Promise<{ cancelled: boolean; path: string | null; points: number; elevationPoints: number }> => {
    if (typeof trackName !== 'string' || !trackName.trim() || !Array.isArray(sourceSegments)) throw new Error('An in-memory GPX track and its points are required.');
    const escapeXml = (value: string): string => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character] ?? character);
    let pointCount = 0, elevationCount = 0;
    const segments = sourceSegments.map(segment => {
      if (!Array.isArray(segment)) return '';
      const points = segment.map(point => {
        if (!point || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude) || Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180) return '';
        pointCount++;
        const elevation = point.elevation !== null && Number.isFinite(point.elevation) ? (elevationCount++, `<ele>${point.elevation}</ele>`) : '';
        const parsedTime = typeof point.timestamp === 'string' ? Date.parse(point.timestamp) : Number.NaN;
        const timestamp = Number.isFinite(parsedTime) ? `<time>${new Date(parsedTime).toISOString()}</time>` : '';
        return `<trkpt lat="${point.latitude}" lon="${point.longitude}">${elevation}${timestamp}</trkpt>`;
      }).join('');
      return points ? `<trkseg>${points}</trkseg>` : '';
    }).filter(Boolean);
    if (!pointCount) throw new Error('The in-memory GPX track contains no valid track points.');
    const defaultName = trackName.replace(/\.[^.]+$/, '').trim() + '.from-memory.gpx';
    const selection = await dialog.showSaveDialog({ title: 'Export GPX track from memory', defaultPath: join(app.getPath('documents'), defaultName), filters: [{ name: 'GPX files', extensions: ['gpx'] }] });
    if (selection.canceled || !selection.filePath) return { cancelled: true, path: null, points: pointCount, elevationPoints: elevationCount };
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="LumaScope" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${escapeXml(trackName)}</name>${segments.join('')}</trk></gpx>\n`;
    await writeFile(selection.filePath, xml, 'utf8');
    return { cancelled: false, path: selection.filePath, points: pointCount, elevationPoints: elevationCount };
  };
  @IpcHandler({ name: 'CacheManager.exportGpxFileFromDatabase' })
  readonly exportGpxFileFromDatabase = async (
    _event?: IpcMainInvokeEvent, sourcePath?: string, requestedDatabaseKey?: string
  ): Promise<{ cancelled: boolean; path: string | null; points: number; elevationPoints: number }> => {
    if (!sourcePath || typeof sourcePath !== 'string') throw new Error('A GPX source path is required.');
    let databaseKey: string;
    let relativePath: string;
    if (/^[a-z]:[\\/]/i.test(sourcePath)) {
      const absolute = resolve(sourcePath);
      databaseKey = this.databaseKeyForPath(absolute);
      relativePath = relative(resolve(databaseKey + '\\\\'), absolute);
    } else {
      databaseKey = (requestedDatabaseKey ?? this.activeDatabaseKey ?? '').toUpperCase();
      relativePath = sourcePath;
    }
    if (!/^[A-Z]:$/.test(databaseKey) || !relativePath || relativePath === '..'
      || relativePath.startsWith('..' + sep) || isAbsolute(relativePath)) {
      throw new Error('The GPX file path is not inside a cache database drive.');
    }
    const db = this.databases.get(databaseKey) ?? this.databaseForPath(databaseKey + '\\\\');
    const findFile = db.prepare('SELECT id, file_name FROM gpx_files WHERE replace(relative_file_path, char(92), \'/\') = :path COLLATE NOCASE');
    const normalizedRelativePath = relativePath.replace(/[\\\\/]+/g, '/');
    // Always reconcile an absolute source file before exporting. This is important
    // even when the database row already exists: an unchanged GPX without <ele>
    // elements may still have stale elevation_m values from an older import.
    if (/^[a-z]:[\\/]/i.test(sourcePath)) {
      const absolute = resolve(sourcePath);
      const importResult = await this.importGpxFilePaths(databaseKey, [absolute], dirname(absolute));
      if (importResult.errors > 0) {
        throw new Error('The GPX source file could not be reconciled with the cache database. Check that the file is accessible and contains valid track points.');
      }
    }
    const file = findFile.get({ path: normalizedRelativePath }) as { id: number; file_name: string } | undefined;
    if (!file) throw new Error('The selected GPX track was not found in the cache database.');
    const segments = db.prepare(`SELECT s.id, s.segment_index FROM gpx_track_segments s
      WHERE s.gpx_file_id = :fileId ORDER BY s.segment_index`).all({ fileId: file.id }) as Array<{ id: number; segment_index: number }>;
    const rows = db.prepare(`SELECT timestamp_ms, latitude, longitude, elevation_m
      FROM gpx_track_points WHERE segment_id = :segmentId ORDER BY point_index`);
    const escapeXml = (value: string): string => value.replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
    })[character] ?? character);
    let pointCount = 0, elevationCount = 0;
    const trackSegments: string[] = [];
    for (const segment of segments) {
      const points = rows.all({ segmentId: segment.id }) as Array<{
        timestamp_ms: number | null; latitude: number; longitude: number; elevation_m: number | null;
      }>;
      const pointXml = points.map(point => {
        pointCount++;
        const elevation = point.elevation_m !== null && Number.isFinite(point.elevation_m)
          ? (elevationCount++, `<ele>${point.elevation_m}</ele>`) : '';
        const timestamp = point.timestamp_ms !== null && Number.isFinite(point.timestamp_ms)
          ? `<time>${new Date(point.timestamp_ms).toISOString()}</time>` : '';
        return `<trkpt lat="${point.latitude}" lon="${point.longitude}">${elevation}${timestamp}</trkpt>`;
      }).join('');
      if (pointXml) trackSegments.push(`<trkseg>${pointXml}</trkseg>`);
    }
    if (!pointCount) throw new Error('The selected GPX database entry contains no track points.');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="LumaScope" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${escapeXml(file.file_name)}</name>${trackSegments.join('')}</trk></gpx>\n`;
    const defaultName = file.file_name.toLowerCase().endsWith('.gpx')
      ? file.file_name.replace(/\.gpx$/i, '') + '.from-db.gpx' : file.file_name + '.from-db.gpx';
    const selection = await dialog.showSaveDialog({
      title: 'Export GPX track from cache database',
      defaultPath: join(app.getPath('documents'), defaultName),
      filters: [{ name: 'GPX files', extensions: ['gpx'] }]
    });
    if (selection.canceled || !selection.filePath) {
      return { cancelled: true, path: null, points: pointCount, elevationPoints: elevationCount };
    }
    await writeFile(selection.filePath, xml, 'utf8');
    return { cancelled: false, path: selection.filePath, points: pointCount, elevationPoints: elevationCount };
  };

  @IpcHandler({ name: 'CacheManager.deleteGpxDatabaseEntriesForFile' })
  readonly deleteGpxDatabaseEntriesForFile = async (_event?: IpcMainInvokeEvent, sourcePath?: string, requestedDatabaseKey?: string): Promise<{ deleted: boolean; files: number; segments: number; points: number }> => {
    if (!sourcePath || typeof sourcePath !== 'string') throw new Error('A GPX source path is required.');
    let databaseKey: string;
    let relativePath: string;
    if (/^[a-z]:[\\/]/i.test(sourcePath)) {
      const absolute = resolve(sourcePath);
      databaseKey = this.databaseKeyForPath(absolute);
      relativePath = relative(resolve(databaseKey + '\\\\'), absolute);
    } else {
      databaseKey = (requestedDatabaseKey ?? this.activeDatabaseKey ?? '').toUpperCase();
      relativePath = sourcePath;
    }
    if (!/^[A-Z]:$/.test(databaseKey) || !relativePath || relativePath === '..' || relativePath.startsWith('..' + sep) || isAbsolute(relativePath)) throw new Error('The GPX file path is not inside a cache database drive.');
    const databasePath = join(databaseKey + '\\\\', '.cache', 'LumaScope.cache.sqlite');
    if (!existsSync(databasePath)) return { deleted: false, files: 0, segments: 0, points: 0 };
    const db = this.databases.get(databaseKey) ?? this.databaseForPath(databaseKey + '\\\\');
    const normalizedPath = relativePath.replace(/[\\\\/]+/g, '/');
    const file = db.prepare(`SELECT id FROM gpx_files WHERE replace(relative_file_path, char(92), '/') = :path COLLATE NOCASE`).get({ path: normalizedPath }) as { id: number } | undefined;
    if (!file) return { deleted: false, files: 0, segments: 0, points: 0 };
    const counts = db.prepare(`SELECT
      (SELECT COUNT(*) FROM gpx_track_segments WHERE gpx_file_id = :fileId) AS segments,
      (SELECT COUNT(*) FROM gpx_track_points WHERE segment_id IN (SELECT id FROM gpx_track_segments WHERE gpx_file_id = :fileId)) AS points`).get({ fileId: file.id }) as { segments: number; points: number };
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare('DELETE FROM gpx_files WHERE id = :fileId').run({ fileId: file.id });
      db.exec('COMMIT;');
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch { /* Preserve the original error. */ }
      throw error;
    }
    return { deleted: true, files: 1, segments: counts.segments, points: counts.points };
  };

  @IpcHandler({ name: 'CacheManager.clearAllGpxDatabaseEntries' })
  readonly clearAllGpxDatabaseEntries = async (): Promise<{ databases: number; files: number; segments: number; points: number }> => {
    let databases = 0, files = 0, segments = 0, points = 0;
    // Cache databases are stored under each drive's .cache directory. Inspect all
    // drive letters, not only databases that happen to be open in this process.
    for (let code = 65; code <= 90; code++) {
      const databaseKey = String.fromCharCode(code) + ':';
      const databasePath = join(databaseKey + '\\\\', '.cache', 'LumaScope.cache.sqlite');
      if (!existsSync(databasePath)) continue;
      const db = this.databases.get(databaseKey) ?? this.databaseForPath(databaseKey + '\\\\');
      const counts = db.prepare(`SELECT
        (SELECT COUNT(*) FROM gpx_files) AS files,
        (SELECT COUNT(*) FROM gpx_track_segments) AS segments,
        (SELECT COUNT(*) FROM gpx_track_points) AS points`).get() as {
          files: number; segments: number; points: number;
        };
      db.exec('BEGIN IMMEDIATE;');
      try {
        // ON DELETE CASCADE removes segments and points; the segment trigger
        // also removes the corresponding R-tree bounds.
        db.exec('DELETE FROM gpx_files;');
        db.exec('COMMIT;');
      } catch (error) {
        try { db.exec('ROLLBACK;'); } catch { /* Preserve the original error. */ }
        throw error;
      }
      databases++;
      files += counts.files;
      segments += counts.segments;
      points += counts.points;
    }
    return { databases, files, segments, points };
  };

  @IpcHandler({ name: 'CacheManager.getGpxDatabaseStats' })
  readonly getGpxDatabaseStats = async (_event?: IpcMainInvokeEvent, databaseKey?: string): Promise<{ files: number; segments: number; points: number; timestampedPoints: number }> => {
    const key = databaseKey ?? this.activeDatabaseKey;
    if (!key || !/^[a-z]:$/i.test(key)) return { files: 0, segments: 0, points: 0, timestampedPoints: 0 };
    const db = this.databases.get(key.toUpperCase()) ?? this.databaseForPath(key.toUpperCase() + '\\\\');
    return db.prepare(`SELECT
      (SELECT COUNT(*) FROM gpx_files) AS files,
      (SELECT COUNT(*) FROM gpx_track_segments) AS segments,
      (SELECT COUNT(*) FROM gpx_track_points) AS points,
      (SELECT COUNT(*) FROM gpx_track_points WHERE timestamp_ms IS NOT NULL) AS timestampedPoints`).get() as { files: number; segments: number; points: number; timestampedPoints: number };
  };

  @IpcHandler({ name: 'CacheManager.getLatestGpxElevationProfile' })
  readonly getLatestGpxElevationProfile = async (
    _event?: IpcMainInvokeEvent, sourcePath?: string
  ): Promise<{
    databaseKey: string; fileName: string; relativePath: string; importedAt: number;
    pointCount: number; minElevationM: number; maxElevationM: number;
    startTimestampMs: number; endTimestampMs: number;
    points: Array<{ timestampMs: number; elevationM: number }>;
  } | null> => {
    // The profile must belong to the exact GPX file most recently displayed by the map.
    // Never substitute another track merely because it has elevation data.
    if (typeof sourcePath !== 'string' || !/^[a-z]:[\\/]/i.test(sourcePath)) return null;
    const databaseKey = sourcePath.slice(0, 2).toUpperCase();
    const databasePath = join(databaseKey + '\\\\', '.cache', 'LumaScope.cache.sqlite');
    if (!existsSync(databasePath)) return null;
    const db = this.databases.get(databaseKey) ?? this.databaseForPath(databaseKey + '\\\\');
    const relativePath = relative(resolve(databaseKey + '\\\\'), resolve(sourcePath)).replace(/[\\\\/]+/g, '/');
    if (!relativePath || relativePath === '..' || relativePath.startsWith('../')) return null;
    const file = db.prepare(`SELECT f.id, f.file_name, f.relative_file_path, f.imported_at
      FROM gpx_files f
      WHERE replace(f.relative_file_path, char(92), '/') = :path COLLATE NOCASE
    `).get({ path: relativePath }) as {
      id: number; file_name: string; relative_file_path: string; imported_at: number;
    } | undefined;
    if (!file) return null;
    const latest = {
      databaseKey, fileId: file.id, fileName: file.file_name,
      relativePath: file.relative_file_path, importedAt: file.imported_at
    };
    const summary = db.prepare(`SELECT COUNT(*) AS pointCount,
        MIN(p.elevation_m) AS minElevationM, MAX(p.elevation_m) AS maxElevationM,
        MIN(p.timestamp_ms) AS startTimestampMs, MAX(p.timestamp_ms) AS endTimestampMs
      FROM gpx_track_segments s
      JOIN gpx_track_points p ON p.segment_id = s.id
      WHERE s.gpx_file_id = :fileId
        AND p.timestamp_ms IS NOT NULL AND p.elevation_m IS NOT NULL`).get({ fileId: latest.fileId }) as {
          pointCount: number; minElevationM: number | null; maxElevationM: number | null;
          startTimestampMs: number | null; endTimestampMs: number | null;
        };
    if (!summary.pointCount || summary.minElevationM === null || summary.maxElevationM === null
      || summary.startTimestampMs === null || summary.endTimestampMs === null) return null;
    const step = Math.max(1, Math.ceil(summary.pointCount / 1200));
    const rows = db.prepare(`SELECT timestamp_ms, elevation_m FROM (
        SELECT p.timestamp_ms, p.elevation_m,
          ROW_NUMBER() OVER (ORDER BY p.timestamp_ms, s.segment_index, p.point_index) AS sequence
        FROM gpx_track_segments s
        JOIN gpx_track_points p ON p.segment_id = s.id
        WHERE s.gpx_file_id = :fileId
          AND p.timestamp_ms IS NOT NULL AND p.elevation_m IS NOT NULL
      )
      WHERE sequence = 1 OR sequence = :pointCount OR sequence % :step = 0
      ORDER BY sequence`).all({ fileId: latest.fileId, pointCount: summary.pointCount, step }) as Array<{
        timestamp_ms: number; elevation_m: number;
      }>;
    return {
      databaseKey: latest.databaseKey, fileName: latest.fileName, relativePath: latest.relativePath,
      importedAt: latest.importedAt, pointCount: summary.pointCount,
      minElevationM: summary.minElevationM, maxElevationM: summary.maxElevationM,
      startTimestampMs: summary.startTimestampMs, endTimestampMs: summary.endTimestampMs,
      points: rows.map(point => ({ timestampMs: point.timestamp_ms, elevationM: point.elevation_m }))
    };
  };

  @IpcHandler({ name: 'CacheManager.getGpxDatabaseTimeRange' })
  readonly getGpxDatabaseTimeRange = async (
    _event?: IpcMainInvokeEvent, databaseKey?: string
  ): Promise<{ from: number | null; to: number | null }> => {
    const key = databaseKey ?? this.activeDatabaseKey;
    if (!key || !/^[a-z]:$/i.test(key)) return { from: null, to: null };
    const db = this.databases.get(key.toUpperCase()) ?? this.databaseForPath(key.toUpperCase() + '\\\\');
    const range = db.prepare(`SELECT MIN(timestamp_ms) AS fromTimestamp, MAX(timestamp_ms) AS toTimestamp
      FROM gpx_track_points WHERE timestamp_ms IS NOT NULL`).get() as {
        fromTimestamp: number | null; toTimestamp: number | null;
      };
    return { from: range.fromTimestamp, to: range.toTimestamp };
  };

  @IpcHandler({ name: 'CacheManager.getGpxFilesInBounds' })
  readonly getGpxFilesInBounds = async (
    _event: IpcMainInvokeEvent,
    bounds: { west: number; south: number; east: number; north: number },
    requestedDatabaseKey?: string
  ): Promise<Array<{
    id: number; path: string; name: string; sizeBytes: number; lastModified: number;
    matchingPoints: number; segments: Array<Array<{ latitude: number; longitude: number; timestamp: number | null; inViewport: boolean }>>;
  }>> => {
    if (!bounds || ![bounds.west, bounds.south, bounds.east, bounds.north].every(Number.isFinite)
      || bounds.south < -90 || bounds.north > 90 || bounds.south > bounds.north
      || bounds.west < -180 || bounds.west > 180 || bounds.east < -180 || bounds.east > 180) {
      throw new Error('A valid map viewport is required.');
    }
    const databaseKey = requestedDatabaseKey?.toUpperCase() ?? this.activeDatabaseKey;
    if (!databaseKey || !/^[A-Z]:$/.test(databaseKey)) throw new Error('No cache database drive is active. Import GPX files into the cache database first.');
    const db = this.databases.get(databaseKey) ?? this.databaseForPath(databaseKey + '\\\\');
    const rows = db.prepare(`SELECT f.id AS file_id, f.relative_file_path, f.file_name, f.file_size, f.modified_at,
        s.id AS segment_id, p.point_index, p.timestamp_ms, p.latitude, p.longitude,
        CASE WHEN p.latitude BETWEEN :south AND :north AND p.longitude BETWEEN :west AND :east THEN 1 ELSE 0 END AS in_viewport
      FROM gpx_segment_rtree r
      JOIN gpx_track_segments s ON s.id = r.segment_id
      JOIN gpx_files f ON f.id = s.gpx_file_id
      JOIN gpx_track_points p ON p.segment_id = s.id
        AND p.point_index IN (
          SELECT p2.point_index FROM gpx_track_points p2
            WHERE p2.segment_id = s.id AND p2.latitude BETWEEN :south AND :north AND p2.longitude BETWEEN :west AND :east
          UNION SELECT p2.point_index - 1 FROM gpx_track_points p2
            WHERE p2.segment_id = s.id AND p2.point_index > 0 AND p2.latitude BETWEEN :south AND :north AND p2.longitude BETWEEN :west AND :east
          UNION SELECT p2.point_index + 1 FROM gpx_track_points p2
            WHERE p2.segment_id = s.id AND p2.latitude BETWEEN :south AND :north AND p2.longitude BETWEEN :west AND :east
        )
      WHERE r.min_latitude <= :north AND r.max_latitude >= :south
        AND r.min_longitude <= :east AND r.max_longitude >= :west
      ORDER BY f.id, s.id, p.point_index`).all({
        west: bounds.west, south: bounds.south, east: bounds.east, north: bounds.north
      }) as unknown as Array<{
        file_id: number; relative_file_path: string; file_name: string; file_size: number; modified_at: number;
        segment_id: number; point_index: number; timestamp_ms: number | null; latitude: number; longitude: number; in_viewport: number;
      }>;
    const files = new Map<number, {
      id: number; path: string; name: string; sizeBytes: number; lastModified: number;
      matchingPoints: number; segments: Array<Array<{ latitude: number; longitude: number; timestamp: number | null; inViewport: boolean }>>;
      lastSegmentId: number; lastPointIndex: number;
    }>();
    for (const row of rows) {
      let file = files.get(row.file_id);
      if (!file) {
        file = {
          id: row.file_id,
          path: join(this.resolveStoredFolderPath(dirname(row.relative_file_path), databaseKey), basename(row.relative_file_path)),
          name: row.file_name, sizeBytes: row.file_size, lastModified: row.modified_at,
          matchingPoints: 0, segments: [], lastSegmentId: -1, lastPointIndex: -2
        };
        files.set(row.file_id, file);
      }
      if (file.lastSegmentId !== row.segment_id || row.point_index !== file.lastPointIndex + 1) {
        file.segments.push([]);
      }
      file.segments[file.segments.length - 1].push({
        latitude: row.latitude, longitude: row.longitude, timestamp: row.timestamp_ms, inViewport: row.in_viewport === 1
      });
      if (row.in_viewport === 1) file.matchingPoints++;
      file.lastSegmentId = row.segment_id;
      file.lastPointIndex = row.point_index;
    }
    return [...files.values()].map(({ lastSegmentId: _segment, lastPointIndex: _point, ...file }) => file);
  };

  @IpcHandler({ name: 'CacheManager.getInterpolatedGpxPosition' })
  readonly getInterpolatedGpxPosition = async (
    _event: IpcMainInvokeEvent, folder: string, timestampMs: number, maxDifferenceSeconds = 120, requestedDatabaseKey?: string
  ): Promise<{ latitude: number; longitude: number; deviationSeconds: number } | null> => {
    if (!folder || !Number.isFinite(timestampMs) || !Number.isFinite(maxDifferenceSeconds) || maxDifferenceSeconds < 0) return null;
    const databaseKey = requestedDatabaseKey && /^[a-z]:$/i.test(requestedDatabaseKey) ? requestedDatabaseKey.toUpperCase() : this.databaseKeyForPath(folder);
    const db = this.databaseForPath(databaseKey + '\\');
    if (!requestedDatabaseKey) this.activeDatabaseKey = databaseKey;
    const diagnosticPointQuery = db.prepare(`SELECT p.timestamp_ms, p.latitude, p.longitude,
        s.id AS segment_id, f.file_name, f.relative_file_path
      FROM gpx_track_points p
      JOIN gpx_track_segments s ON s.id = p.segment_id
      JOIN gpx_files f ON f.id = s.gpx_file_id
      WHERE p.timestamp_ms IS NOT NULL AND p.timestamp_ms <= :timestamp
      ORDER BY p.timestamp_ms DESC LIMIT 1`);
    const diagnosticBefore = diagnosticPointQuery.get({ timestamp: timestampMs }) as
      { timestamp_ms: number; latitude: number; longitude: number; segment_id: number; file_name: string; relative_file_path: string } | undefined;
    const diagnosticAfter = db.prepare(`SELECT p.timestamp_ms, p.latitude, p.longitude,
        s.id AS segment_id, f.file_name, f.relative_file_path
      FROM gpx_track_points p
      JOIN gpx_track_segments s ON s.id = p.segment_id
      JOIN gpx_files f ON f.id = s.gpx_file_id
      WHERE p.timestamp_ms IS NOT NULL AND p.timestamp_ms >= :timestamp
      ORDER BY p.timestamp_ms ASC LIMIT 1`).get({ timestamp: timestampMs }) as
      { timestamp_ms: number; latitude: number; longitude: number; segment_id: number; file_name: string; relative_file_path: string } | undefined;
    const nearestPoint = db.prepare(`SELECT p.timestamp_ms, p.latitude, p.longitude,
        s.id AS segment_id, f.file_name, f.relative_file_path
      FROM gpx_track_points p
      JOIN gpx_track_segments s ON s.id = p.segment_id
      JOIN gpx_files f ON f.id = s.gpx_file_id
      WHERE p.timestamp_ms IS NOT NULL
      ORDER BY ABS(p.timestamp_ms - :timestamp), p.timestamp_ms
      LIMIT 1`).get({ timestamp: timestampMs }) as typeof diagnosticBefore;
    const describePoint = (point: typeof diagnosticBefore) => point ? ({
      timestampMs: point.timestamp_ms,
      utc: new Date(point.timestamp_ms).toISOString(),
      local: formatOsDateTime(new Date(point.timestamp_ms)),
      deltaSeconds: (point.timestamp_ms - timestampMs) / 1000,
      absoluteDeltaSeconds: Math.abs(point.timestamp_ms - timestampMs) / 1000,
      segmentId: point.segment_id,
      file: point.relative_file_path,
      filePath: resolve(databaseKey + '\\\\', point.relative_file_path),
      latitude: point.latitude,
      longitude: point.longitude
    }) : null;
    const gpxTimeDiagnostic = {
      photoTimestampMs: timestampMs,
      photoUtc: new Date(timestampMs).toISOString(),
      photoLocal: formatOsDateTime(new Date(timestampMs)),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      localOffsetMinutes: new Date(timestampMs).getTimezoneOffset(),
      databaseKey,
      importedGpxPointCount: (db.prepare('SELECT COUNT(*) AS count FROM gpx_track_points WHERE timestamp_ms IS NOT NULL').get() as { count: number }).count,
      nearestPoint: describePoint(nearestPoint),
      nearestBefore: describePoint(diagnosticBefore),
      nearestAfter: describePoint(diagnosticAfter),
      sameSegment: !!diagnosticBefore && !!diagnosticAfter && diagnosticBefore.segment_id === diagnosticAfter.segment_id
    };
    console.info('[GPX time debug] Compare photo time with nearest imported GPX points:', gpxTimeDiagnostic);
    try {
      const compactPoint = (point: typeof diagnosticBefore): string => point
        ? `${formatOsDateTime(new Date(point.timestamp_ms))} (${((point.timestamp_ms - timestampMs) / 1000).toFixed(0)} s)`
        : '—';
      await this.appendGpsAutoFixDebug(
        `[${formatOsDateTime(new Date())}] GPX ${databaseKey}: ${gpxTimeDiagnostic.importedGpxPointCount} points; before ${compactPoint(diagnosticBefore)}; after ${compactPoint(diagnosticAfter)}; same segment ${gpxTimeDiagnostic.sameSegment ? 'yes' : 'no'}`
      );
    } catch (error) {
      console.warn('[CacheManager] Could not write GPS Auto Fix debug log:', error);
    }
    const pair = db.prepare(`SELECT segment_id,
        MAX(CASE WHEN timestamp_ms <= :timestamp THEN timestamp_ms END) AS before_timestamp,
        MIN(CASE WHEN timestamp_ms >= :timestamp THEN timestamp_ms END) AS after_timestamp
      FROM gpx_track_points
      WHERE timestamp_ms BETWEEN :minimum AND :maximum
      GROUP BY segment_id
      HAVING MAX(CASE WHEN timestamp_ms <= :timestamp THEN timestamp_ms END) IS NOT NULL
        AND MIN(CASE WHEN timestamp_ms >= :timestamp THEN timestamp_ms END) IS NOT NULL
      ORDER BY MIN(ABS(:timestamp - before_timestamp), ABS(after_timestamp - :timestamp)),
        (after_timestamp - before_timestamp), segment_id
      LIMIT 1`).get({
        timestamp: timestampMs,
        minimum: timestampMs - 86_400_000,
        maximum: timestampMs + 86_400_000
      }) as { segment_id: number; before_timestamp: number; after_timestamp: number } | undefined;
    if (!pair) return null;
    const getPoint = db.prepare(`SELECT latitude, longitude FROM gpx_track_points
      WHERE segment_id = :segmentId AND timestamp_ms = :timestamp
      ORDER BY point_index LIMIT 1`);
    const before = getPoint.get({ segmentId: pair.segment_id, timestamp: pair.before_timestamp }) as
      { latitude: number; longitude: number } | undefined;
    const after = getPoint.get({ segmentId: pair.segment_id, timestamp: pair.after_timestamp }) as
      { latitude: number; longitude: number } | undefined;
    if (!before || !after) return null;
    const beforeDelta = Math.abs(timestampMs - pair.before_timestamp) / 1000;
    const afterDelta = Math.abs(pair.after_timestamp - timestampMs) / 1000;
    const deviationSeconds = Math.min(beforeDelta, afterDelta);
    const span = pair.after_timestamp - pair.before_timestamp;
    if (span < 0 || span > 172_800_000) return null;
    if (span === 0) return { latitude: before.latitude, longitude: before.longitude, deviationSeconds };
    const ratio = (timestampMs - pair.before_timestamp) / span;
    return {
      latitude: before.latitude + (after.latitude - before.latitude) * ratio,
      longitude: before.longitude + (after.longitude - before.longitude) * ratio,
      deviationSeconds
    };
  };

  @IpcHandler({ name: 'CacheManager.getInterpolatedPhotoGpsPosition' })
  readonly getInterpolatedPhotoGpsPosition = async (
    _event: IpcMainInvokeEvent, sourceName: string, timestampMs: number, requestedDatabaseKey: string
  ): Promise<{ latitude: number; longitude: number; deviationSeconds: number } | null> => {
    if (!sourceName || !Number.isFinite(timestampMs) || !/^[a-z]:$/i.test(requestedDatabaseKey)) return null;
    const databaseKey = requestedDatabaseKey.toUpperCase();
    const db = this.databaseForPath(databaseKey + '\\');
    const targetFolder = this.toRelativeFolderPath(dirname(sourceName), databaseKey) ?? '';
    const targetFile = basename(sourceName);
    const timestamp = Math.floor(timestampMs / 1000);
    const windowSeconds = 86_400;
    const parameters = {
      timestamp,
      minimum: timestamp - windowSeconds,
      maximum: timestamp + windowSeconds,
      targetFolder,
      targetFile
    };
    const before = db.prepare(`SELECT photos.gps_timestamp, photos.latitude, photos.longitude,
        photos.file_name, paths.relative_folder_path
      FROM photos
      JOIN paths ON paths.id = photos.path_id
      WHERE photos.gps_timestamp IS NOT NULL
        AND photos.latitude IS NOT NULL AND photos.longitude IS NOT NULL
        AND NOT (paths.relative_folder_path = :targetFolder COLLATE NOCASE AND photos.file_name = :targetFile COLLATE NOCASE)
        AND photos.gps_timestamp BETWEEN :minimum AND :timestamp
      ORDER BY photos.gps_timestamp DESC, photos.id DESC
      LIMIT 1`).get(parameters) as {
        gps_timestamp: number; latitude: number; longitude: number;
        file_name: string; relative_folder_path: string
      } | undefined;
    const after = db.prepare(`SELECT photos.gps_timestamp, photos.latitude, photos.longitude,
        photos.file_name, paths.relative_folder_path
      FROM photos
      JOIN paths ON paths.id = photos.path_id
      WHERE photos.gps_timestamp IS NOT NULL
        AND photos.latitude IS NOT NULL AND photos.longitude IS NOT NULL
        AND NOT (paths.relative_folder_path = :targetFolder COLLATE NOCASE AND photos.file_name = :targetFile COLLATE NOCASE)
        AND photos.gps_timestamp BETWEEN :timestamp AND :maximum
      ORDER BY photos.gps_timestamp ASC, photos.id ASC
      LIMIT 1`).get(parameters) as typeof before;
    const nearest = [before, after].filter((point): point is NonNullable<typeof point> => !!point)
      .sort((a, b) => Math.abs(a.gps_timestamp - timestamp) - Math.abs(b.gps_timestamp - timestamp))[0];
    const deviationSeconds = nearest ? Math.abs(nearest.gps_timestamp - timestamp) : null;
    const diagnostic = {
      databaseKey,
      targetTimestamp: timestamp,
      targetLocal: formatOsDateTime(new Date(timestampMs)),
      before: before ? {
        timestamp: before.gps_timestamp, latitude: before.latitude, longitude: before.longitude,
        file: resolve(databaseKey + '\\\\', before.relative_folder_path, before.file_name)
      } : null,
      after: after ? {
        timestamp: after.gps_timestamp, latitude: after.latitude, longitude: after.longitude,
        file: resolve(databaseKey + '\\\\', after.relative_folder_path, after.file_name)
      } : null,
      deviationSeconds
    };
    console.info('[Photo GPS reference] Compare photo time with cached geotagged images:', diagnostic);
    try {
      await this.appendGpsAutoFixDebug(
        `[${formatOsDateTime(new Date())}] Image GPS ${databaseKey}: before ${before ? formatOsDateTime(new Date(before.gps_timestamp * 1000)) : '—'}; after ${after ? formatOsDateTime(new Date(after.gps_timestamp * 1000)) : '—'}; nearest deviation ${deviationSeconds ?? '—'} s`
      );
    } catch (error) {
      console.warn('[CacheManager] Could not write image GPS reference debug log:', error);
    }
    if (deviationSeconds === null || !nearest) return null;
    // A single cached geotagged image is still a useful anchor. Do not invent
    // interpolation: use its exact coordinates and let the caller enforce the
    // configured maximum time difference before accepting the candidate.
    if (!before || !after) {
      const singleReference = before ?? after!;
      const diagnosticLine = `[Photo GPS reference] Single image anchor used for ${targetFile}: ${singleReference.file_name} (${deviationSeconds} s)`;
      console.info(diagnosticLine, {
        databaseKey,
        reference: resolve(databaseKey + '\\\\', singleReference.relative_folder_path, singleReference.file_name),
        latitude: singleReference.latitude,
        longitude: singleReference.longitude
      });
      try {
        await this.appendGpsAutoFixDebug(
          `[${formatOsDateTime(new Date())}] Image GPS ${databaseKey}: single reference ${singleReference.file_name}; exact position used without interpolation; deviation ${deviationSeconds} s`
        );
      } catch (error) {
        console.warn('[CacheManager] Could not write single image GPS reference diagnostic:', error);
      }
      return {
        latitude: singleReference.latitude,
        longitude: singleReference.longitude,
        deviationSeconds
      };
    }
    const span = after.gps_timestamp - before.gps_timestamp;
    if (span < 0 || span > 172_800) return null;
    if (span === 0) return { latitude: before.latitude, longitude: before.longitude, deviationSeconds };
    const ratio = (timestamp - before.gps_timestamp) / span;
    return {
      latitude: before.latitude + (after.latitude - before.latitude) * ratio,
      longitude: before.longitude + (after.longitude - before.longitude) * ratio,
      deviationSeconds
    };
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

    // Always include the selected database, even if it was not previously
    // opened by gallery navigation (for example, a background cache build).
    const summaryDatabaseKeys = new Set([...this.databases.keys(), selectedDatabaseKey]);
    for (const key of summaryDatabaseKeys) {
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

  readonly resetGpsAutoFixDebug = async (header = ''): Promise<void> => {
    const filePath = join(this.userData, 'gps-auto-fix-debug.log');
    await writeFile(filePath, header ? header + '\n' : '', 'utf-8');
  };

  readonly appendGpsAutoFixDebug = async (line: string): Promise<void> => {
    if (typeof line !== 'string' || line.length > 1048576) return;
    await appendFile(join(this.userData, 'gps-auto-fix-debug.log'), line.endsWith('\n') ? line : line + '\n', 'utf-8');
  };

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
      const expectedFullSizeTag = (extension === '.ohsp' ? 'ohsp-full-spectrum-v15' : `${['.dng', '.rw2', '.raw'].includes(extension) ? (extension === '.dng' ? 'dng-full-raw-v2' : 'camera-raw-full-v1') : `${extension.slice(1)}${[ '.tif', '.tiff' ].includes(extension) ? '-full-hdr-v6' : extension === '.exr' ? '-full-uhdr-v2' : '-full-uhdr'}`}`);
      const metadata = metadataByPath.get(sourceName);
      const sourceMatches = !metadata || (!!row && row.file_size === metadata.size && row.modified_at === metadata.modifiedAt);
      const getStatus = (kind: 'thumbnail' | 'fullsize') => {
        if (!row || !sourceMatches) return null;
        const id = kind === 'thumbnail' ? row.thumbnail_cache_id : row.fullsize_cache_id;
        const version = kind === 'thumbnail' ? row.thumbnail_cache_version : row.fullsize_cache_version;
        const expectedVersion = kind === 'thumbnail' ? getThumbnailCacheVersion(sourceName) : getFullSizeCacheVersionCode(expectedFullSizeTag);
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
      const verification = {
        sourceChecked: false,
        thumbnailChecked: false,
        fullSizeChecked: false,
        invalidEntries: 0,
        redundantThumbnailRemoved: false
      };
      let thumbnailDirect = false;
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
      // Only an explicit Build cache > Verify pass may remove redundant
      // thumbnail sidecars. Normal gallery scans and non-verify cache builds
      // never perform this cleanup.
      if (verifyCacheFiles && sourceMatches && CHROMIUM_NATIVE_IMAGE_EXTENSIONS.has(extension)) {
        try {
          const sourceStats = await stat(sourceName);
          if ((!row || (sourceStats.size === row.file_size && sourceStats.mtimeMs === row.modified_at))
            && sourceStats.isFile()) {
            const { Injector } = await import('../injector/injector');
            const thumbManager = Injector.getInstance().inject('ThumbManager');
            const dimensions = await thumbManager.getImageDimensions(sourceName);
            if (dimensions
              && dimensions.width > 0
              && dimensions.height > 0
              && Math.max(dimensions.width, dimensions.height) <= DIRECT_IMAGE_MAX_DIMENSION) {
              const thumbnailPath = this.getSidecarPath(sourceName, false);
              try {
                const thumbnailStats = await stat(thumbnailPath);
                if (thumbnailStats.isFile()) {
                  await rm(thumbnailPath, { force: true });
                  verification.redundantThumbnailRemoved = true;
                }
              } catch { /* No existing sidecar to remove. */ }
              if (row?.thumbnail_cache_id !== null && row?.thumbnail_cache_id !== undefined) {
                db.prepare('UPDATE photos SET thumbnail_cache_id = NULL, thumbnail_cache_version = NULL, thumbnail_failure_size = NULL, thumbnail_failure_modified_at = NULL, thumbnail_failure_version = NULL WHERE id = :id')
                  .run({ id: row.id });
                verification.redundantThumbnailRemoved = true;
              }
              thumbnail = null;
              thumbnailDirect = true;
            }
          }
        } catch (error) {
          console.warn('[CacheManager] Could not verify direct-thumbnail eligibility:', sourceName, error);
        }
      }
      return {
        sourceName,
        thumbnail,
        thumbnailDirect,
        fullSize,
        fullSizeRequired,
        latitude: row?.latitude ?? null,
        longitude: row?.longitude ?? null,
        gpsTimestamp: sourceMatches ? row?.gps_timestamp ?? null : null,
        verification
      };
    }));
  };

  @IpcHandler({ name: 'CacheManager.scanGalleryDirectory' })
  readonly scanGalleryDirectory = async (
    _event: IpcMainInvokeEvent,
    directory: string,
    verifyCacheFiles = false
  ): Promise<{ files: number; directories: string[]; removedStale: number; removedCacheFiles: number; removedCacheBytes: number; complete: boolean }> => {
    if (typeof directory !== 'string' || !directory.trim()) throw new Error('A valid gallery folder path is required.');
    const root = resolve(directory);
    const db = this.databaseForPath(root);
    const databaseKey = this.databaseKeyForPath(root);
    const relativeFolder = this.toRelativeFolderPath(root, databaseKey) ?? '';
    db.prepare('INSERT OR IGNORE INTO paths (relative_folder_path) VALUES (:folder)').run({ folder: relativeFolder });
    const pathRow = db.prepare('SELECT id FROM paths WHERE relative_folder_path = :folder COLLATE NOCASE')
      .get({ folder: relativeFolder }) as { id: number };
    db.exec('CREATE TEMP TABLE IF NOT EXISTS lumascope_seen_gallery_files (file_name TEXT PRIMARY KEY COLLATE NOCASE);');
    db.exec('DELETE FROM temp.lumascope_seen_gallery_files;');
    const markSeen = db.prepare('INSERT OR IGNORE INTO temp.lumascope_seen_gallery_files (file_name) VALUES (:file)');
    const upsertFile = db.prepare(`INSERT INTO photos (path_id, file_name, file_size, modified_at, is_hdr)
      VALUES (:pathId, :file, :size, :modified, 0)
      ON CONFLICT(path_id, file_name) DO UPDATE SET
        is_hdr = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN 0 ELSE photos.is_hdr END,
        thumbnail_cache_id = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.thumbnail_cache_id END,
        thumbnail_cache_version = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.thumbnail_cache_version END,
        thumbnail_failure_size = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.thumbnail_failure_size END,
        thumbnail_failure_modified_at = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.thumbnail_failure_modified_at END,
        thumbnail_failure_version = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.thumbnail_failure_version END,
        fullsize_cache_id = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.fullsize_cache_id END,
        fullsize_cache_version = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.fullsize_cache_version END,
        latitude = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.latitude END,
        longitude = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.longitude END,
        altitude_m = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.altitude_m END,
        gps_timestamp = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.gps_timestamp END,
        direction_deg = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.direction_deg END,
        location_name_id = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.location_name_id END,
        coordinate_source_id = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.coordinate_source_id END,
        gps_manually_corrected = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN 0 ELSE photos.gps_manually_corrected END,
        gps_manual_corrected_at = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.gps_manual_corrected_at END,
        file_name = excluded.file_name,
        file_size = excluded.file_size,
        modified_at = excluded.modified_at`);
    const selectStale = db.prepare(`SELECT id, file_name, thumbnail_cache_id, fullsize_cache_id
      FROM photos
      WHERE path_id = :pathId
        AND lower(file_name) NOT IN (SELECT lower(file_name) FROM temp.lumascope_seen_gallery_files)`);
    const deleteStale = db.prepare(`DELETE FROM photos
      WHERE path_id = :pathId
        AND lower(file_name) NOT IN (SELECT lower(file_name) FROM temp.lumascope_seen_gallery_files)`);
    const directories: string[] = [];
    let files = 0;
    let removedStale = 0;
    let removedCacheFiles = 0;
    let removedCacheBytes = 0;
    let scanComplete = true;
    let batch: Array<{ name: string; size: number; modifiedAt: number }> = [];
    const flushBatch = (): void => {
      if (batch.length === 0) return;
      db.exec('BEGIN IMMEDIATE;');
      try {
        for (const file of batch) {
          markSeen.run({ file: file.name });
          upsertFile.run({
            pathId: pathRow.id,
            file: file.name,
            size: Math.max(0, Math.trunc(file.size)),
            modified: Number.isFinite(file.modifiedAt) ? file.modifiedAt : 0
          });
        }
        db.exec('COMMIT;');
      } catch (error) {
        try { db.exec('ROLLBACK;'); } catch { /* Preserve the original registration error. */ }
        throw error;
      }
      batch = [];
    };

    const handle = await opendir(root);
    try {
      for await (const entry of handle) {
        const entryPath = join(root, entry.name);
        let metadata: Awaited<ReturnType<typeof stat>>;
        try {
          metadata = await stat(entryPath);
        } catch {
          scanComplete = false;
          continue;
        }
        if (metadata.isDirectory()) {
          if (!entry.isSymbolicLink() && !['.cache', '.thumbnails'].includes(entry.name.toLowerCase())) {
            directories.push(entryPath);
          }
          continue;
        }
        if (!metadata.isFile()) continue;
        batch.push({ name: entry.name, size: metadata.size, modifiedAt: metadata.mtimeMs });
        files++;
        if (batch.length >= 500) {
          flushBatch();
          await new Promise<void>(resolveYield => setImmediate(resolveYield));
        }
      }
      flushBatch();
    } catch (error) {
      scanComplete = false;
      throw error;
    } finally {
      await handle.close().catch(() => undefined);
    }

    if (scanComplete) {
      if (verifyCacheFiles) {
        // A Verify cache pass also removes cache files belonging to source files
        // that are no longer present in this completely scanned folder.
        const staleRows = selectStale.all({ pathId: pathRow.id }) as Array<{
          id: number; file_name: string; thumbnail_cache_id: number | null; fullsize_cache_id: number | null
        }>;
        for (const row of staleRows) {
          const sourceName = join(root, row.file_name);
          // Check both sidecar names even if the DB reference was already
          // cleared by an earlier scan; the physical files may still remain.
          const cachePaths = [
            this.getSidecarPath(sourceName, false),
            this.getSidecarPath(sourceName, true)
          ];
          if (row.fullsize_cache_id === CACHE_STORAGE_TYPE.PARALLEL) {
            cachePaths.push(this.getParallelPath(sourceName));
          }
          for (const cachePath of cachePaths) {
            try {
              const info = await stat(cachePath);
              if (!info.isFile()) continue;
              await rm(cachePath, { force: true });
              removedCacheFiles++;
              removedCacheBytes += info.size;
            } catch { /* Missing or inaccessible cache file; preserve scan completion. */ }
          }
        }

        // A previous ordinary scan may already have removed the photo row while
        // leaving its sidecar behind. Reconcile the .cache directory against all
        // files seen in this scan so those unreferenced sidecars are removed too.
        const expectedSidecars = new Set<string>();
        const seenFiles = db.prepare('SELECT file_name FROM temp.lumascope_seen_gallery_files')
          .all() as Array<{ file_name: string }>;
        for (const file of seenFiles) {
          const extension = extname(file.file_name).slice(1).toLowerCase();
          if (!extension) continue;
          const base = basename(file.file_name, extname(file.file_name));
          expectedSidecars.add(`${base}_${extension}_thumb.jpg`.toLowerCase());
          expectedSidecars.add(`${base}_${extension}.jpg`.toLowerCase());
        }
        const cacheDirectory = join(root, '.cache');
        try {
          const cacheEntries = await readdir(cacheDirectory, { withFileTypes: true });
          const cacheExtensions = supportedFileExtensions.map(extension => extension.toLowerCase().replace(/^\\./, ''));
          for (const entry of cacheEntries) {
            if (!entry.isFile()) continue;
            const cacheName = entry.name.toLowerCase();
            const isLumaScopeSidecar = cacheExtensions.some(extension =>
              cacheName.endsWith(`_${extension}_thumb.jpg`) || cacheName.endsWith(`_${extension}.jpg`));
            if (!isLumaScopeSidecar || expectedSidecars.has(cacheName)) continue;
            const cachePath = join(cacheDirectory, entry.name);
            try {
              const info = await stat(cachePath);
              await rm(cachePath, { force: true });
              removedCacheFiles++;
              removedCacheBytes += info.size;
            } catch { /* Ignore sidecars that disappear during verification. */ }
          }
        } catch { /* The folder has no sidecar cache directory. */ }
      }
      db.exec('BEGIN IMMEDIATE;');
      try {
        removedStale = Number(deleteStale.run({ pathId: pathRow.id }).changes);
        db.exec('DELETE FROM paths WHERE id NOT IN (SELECT DISTINCT path_id FROM photos);');
        db.exec('COMMIT;');
      } catch (error) {
        try { db.exec('ROLLBACK;'); } catch { /* Preserve the original registration error. */ }
        throw error;
      }
    }
    db.exec('DELETE FROM temp.lumascope_seen_gallery_files;');
    this.notifyGalleryFilesChanged(root);
    return { files, directories, removedStale, removedCacheFiles, removedCacheBytes, complete: scanComplete };
  };

  @IpcHandler({ name: 'CacheManager.registerGalleryFiles' })
  readonly registerGalleryFiles = async (
    _event: IpcMainInvokeEvent,
    directory: string,
    files: FileInfo[]
  ): Promise<number> => {
    if (typeof directory !== 'string' || !directory.trim()
      || !Array.isArray(files) || files.length > 500000
      || files.some(file => !file || typeof file.path !== 'string' || typeof file.name !== 'string'
        || typeof file.size !== 'number' || typeof file.modifiedAt !== 'number')) {
      throw new Error('A valid folder and file metadata list are required.');
    }
    const root = resolve(directory);
    const db = this.databaseForPath(root);
    const databaseKey = this.databaseKeyForPath(root);
    const relativeFolder = this.toRelativeFolderPath(root, databaseKey) ?? '';
    const currentNames = new Set(files.filter(file => !file.isDirectory
      && dirname(resolve(file.path)).toLocaleLowerCase() === root.toLocaleLowerCase())
      .map(file => basename(file.path).toLocaleLowerCase()));
    db.prepare('INSERT OR IGNORE INTO paths (relative_folder_path) VALUES (:folder)').run({ folder: relativeFolder });
    const pathRow = db.prepare('SELECT id FROM paths WHERE relative_folder_path = :folder COLLATE NOCASE')
      .get({ folder: relativeFolder }) as { id: number };
    let registered = 0;
    const existingRows = db.prepare('SELECT id, file_name FROM photos WHERE path_id = :pathId')
      .all({ pathId: pathRow.id }) as Array<{ id: number; file_name: string }>;
    const deletePhoto = db.prepare('DELETE FROM photos WHERE id = :id');
    db.exec('BEGIN IMMEDIATE;');
    try {
      for (const row of existingRows) {
        if (!currentNames.has(row.file_name.toLocaleLowerCase())) deletePhoto.run({ id: row.id });
      }
      db.exec('COMMIT;');
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch { /* Preserve the original registration error. */ }
      throw error;
    }
    const upsertFile = db.prepare(`INSERT INTO photos (path_id, file_name, file_size, modified_at, is_hdr)
      VALUES (:pathId, :file, :size, :modified, 0)
      ON CONFLICT(path_id, file_name) DO UPDATE SET
        is_hdr = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN 0 ELSE photos.is_hdr END,
        thumbnail_cache_id = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.thumbnail_cache_id END,
        thumbnail_cache_version = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.thumbnail_cache_version END,
        thumbnail_failure_size = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.thumbnail_failure_size END,
        thumbnail_failure_modified_at = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.thumbnail_failure_modified_at END,
        thumbnail_failure_version = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.thumbnail_failure_version END,
        fullsize_cache_id = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.fullsize_cache_id END,
        fullsize_cache_version = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.fullsize_cache_version END,
        latitude = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.latitude END,
        longitude = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.longitude END,
        altitude_m = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.altitude_m END,
        gps_timestamp = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.gps_timestamp END,
        direction_deg = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.direction_deg END,
        location_name_id = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.location_name_id END,
        coordinate_source_id = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.coordinate_source_id END,
        gps_manually_corrected = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN 0 ELSE photos.gps_manually_corrected END,
        gps_manual_corrected_at = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.gps_manual_corrected_at END,
        file_name = excluded.file_name,
        file_size = excluded.file_size,
        modified_at = excluded.modified_at`);
    for (let offset = 0; offset < files.length; offset += 500) {
      const batch = files.slice(offset, offset + 500);
      db.exec('BEGIN IMMEDIATE;');
      try {
        for (const file of batch) {
          if (file.isDirectory) continue;
          const absolute = resolve(file.path);
          if (dirname(absolute).toLocaleLowerCase() !== root.toLocaleLowerCase()) continue;
          upsertFile.run({
            pathId: pathRow.id,
            file: basename(absolute),
            size: Math.max(0, Math.trunc(file.size)),
            modified: typeof file.modifiedAt === 'number' && Number.isFinite(file.modifiedAt) ? file.modifiedAt : 0
          });
          registered++;
        }
        db.exec('COMMIT;');
      } catch (error) {
        try { db.exec('ROLLBACK;'); } catch { /* Preserve the original registration error. */ }
        throw error;
      }
      if (registered > 0 && registered % 5000 === 0) this.notifyGalleryFilesChanged(root);
      if (offset + 500 < files.length) await new Promise<void>(resolveYield => setImmediate(resolveYield));
    }
    db.exec('DELETE FROM paths WHERE id NOT IN (SELECT DISTINCT path_id FROM photos);');
    this.notifyGalleryFilesChanged(root);
    return registered;
  };

  @IpcHandler({ name: 'CacheManager.getGalleryUnsupportedSummary' })
  readonly getGalleryUnsupportedSummary = async (
    _event: IpcMainInvokeEvent,
    directory: string,
    recursive = false
  ): Promise<{ count: number; suffixes: string[] }> => {
    if (typeof directory !== 'string' || !directory.trim()) throw new Error('A valid gallery folder path is required.');
    const databaseKey = this.databaseKeyForPath(directory);
    const db = this.databaseForPath(directory);
    const folder = this.toRelativeFolderPath(directory, databaseKey) ?? '';
    const folderPrefix = folder ? folder.replace(/[\\/]+$/, '') + String.fromCharCode(92) : '';
    const rows = db.prepare(`SELECT photos.file_name, paths.relative_folder_path
      FROM photos JOIN paths ON paths.id = photos.path_id
      WHERE lower(replace(rtrim(paths.relative_folder_path, char(92) || '/'), '/', char(92))) =
          lower(replace(rtrim(:folder, char(92) || '/'), '/', char(92)))
        OR (:recursive = 1 AND substr(lower(replace(paths.relative_folder_path, '/', char(92))), 1, length(:folderPrefix)) = lower(:folderPrefix))`)
      .all({ folder, recursive: recursive ? 1 : 0, folderPrefix }) as Array<{ file_name: string; relative_folder_path: string }>;
    const suffixes = new Set<string>();
    let count = 0;
    for (const row of rows) {
      const extension = extname(row.file_name).toLowerCase().replace(/^\./, '');
      if (supportedFileExtensions.includes(extension)) continue;
      count++;
      suffixes.add(extension || '(no extension)');
    }
    return { count, suffixes: [...suffixes].sort((a, b) => a.localeCompare(b)) };
  };

  @IpcHandler({ name: 'CacheManager.getGalleryFiles' })
  readonly getGalleryFiles = async (
    _event: IpcMainInvokeEvent,
    directory: string,
    recursive = false,
    includeUnsupported = false,
    sortBy: SortType = 'name',
    sortDir: SortDirection = 'asc'
  ): Promise<FileInfo[]> => {
    if (typeof directory !== 'string' || !directory.trim()) throw new Error('A valid gallery folder path is required.');
    const databaseKey = this.databaseKeyForPath(directory);
    const db = this.databaseForPath(directory);
    this.activeDatabaseKey = databaseKey;
    const folder = this.toRelativeFolderPath(directory, databaseKey) ?? '';
    const folderPrefix = folder ? folder.replace(/[\\/]+$/, '') + String.fromCharCode(92) : '';
    const rows = db.prepare(`SELECT photos.file_name, photos.file_size, photos.modified_at, photos.gps_timestamp, paths.relative_folder_path
      FROM photos JOIN paths ON paths.id = photos.path_id
      WHERE lower(replace(rtrim(paths.relative_folder_path, char(92) || '/'), '/', char(92))) =
          lower(replace(rtrim(:folder, char(92) || '/'), '/', char(92)))
        OR (:recursive = 1 AND substr(lower(replace(paths.relative_folder_path, '/', char(92))), 1, length(:folderPrefix)) = lower(:folderPrefix))`)
      .all({ folder, recursive: recursive ? 1 : 0, folderPrefix }) as Array<{
        file_name: string; file_size: number; modified_at: number; gps_timestamp: number | null; relative_folder_path: string;
      }>;
    const data = rows.map(row => {
      const parent = this.resolveStoredFolderPath(row.relative_folder_path, databaseKey);
      const path = join(parent, row.file_name);
      return {
        file: {
          path, name: row.file_name, parent, isDirectory: false,
          ext: extname(row.file_name), createdAt: row.modified_at,
          size: row.file_size, modifiedAt: row.modified_at
        } satisfies FileInfo,
        gpsTimestamp: row.gps_timestamp
      };
    }).filter(entry => includeUnsupported || supportedFileExtensions.includes(entry.file.ext.toLowerCase().replace(/^\\./, '')));
    const direction = sortDir === 'desc' ? -1 : 1;
    data.sort((a, b) => {
      if (sortBy === 'gpsDate') {
        if (a.gpsTimestamp === null) return b.gpsTimestamp === null ? 0 : 1;
        if (b.gpsTimestamp === null) return -1;
        return (a.gpsTimestamp - b.gpsTimestamp) * direction;
      }
      const comparison = sortBy === 'date' ? a.file.modifiedAt - b.file.modifiedAt
        : sortBy === 'size' ? a.file.size - b.file.size
          : a.file.name.localeCompare(b.file.name, undefined, { numeric: true, sensitivity: 'base' });
      return comparison * direction;
    });
    return data.map(entry => entry.file);
  };

  @IpcHandler({ name: 'CacheManager.getGalleryFilesPage' })
  readonly getGalleryFilesPage = async (
    _event: IpcMainInvokeEvent,
    directory: string,
    recursive = false,
    includeUnsupported = false,
    sortBy: SortType = 'name',
    sortDir: SortDirection = 'asc',
    offset = 0,
    limit = 250,
    nameFilter = ''
  ): Promise<{ files: FileInfo[]; totalCount: number; offset: number; limit: number }> => {
    if (typeof directory !== 'string' || !directory.trim()) throw new Error('A valid gallery folder path is required.');
    const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.trunc(limit))) : 250;
    const databaseKey = this.databaseKeyForPath(directory);
    const db = this.databaseForPath(directory);
    this.activeDatabaseKey = databaseKey;
    const folder = this.toRelativeFolderPath(directory, databaseKey) ?? '';
    const folderPrefix = folder ? folder.replace(/[\\/]+$/, '') + String.fromCharCode(92) : '';
    const scope = `FROM photos JOIN paths ON paths.id = photos.path_id
      LEFT JOIN location_names ON location_names.id = photos.location_name_id AND photos.location_name_id <> 0
      WHERE (
        lower(replace(rtrim(paths.relative_folder_path, char(92) || '/'), '/', char(92))) =
          lower(replace(rtrim(:folder, char(92) || '/'), '/', char(92)))
        OR (:recursive = 1 AND substr(lower(replace(paths.relative_folder_path, '/', char(92))), 1, length(:folderPrefix)) = lower(:folderPrefix))
      )`;
    const supportedFilter = includeUnsupported ? '' : ` AND (${supportedFileExtensions.map((_, index) => `lower(photos.file_name) LIKE :extension${index}`).join(' OR ')})`;
    const normalizedNameFilter = typeof nameFilter === 'string' ? nameFilter.trim().toLocaleLowerCase() : '';
    const nameFilterTerms = normalizedNameFilter.split(/\s+/).filter(Boolean);
    const filterParams: Record<string, string | number> = {
      folder, recursive: recursive ? 1 : 0, folderPrefix
    };
    if (!includeUnsupported) {
      supportedFileExtensions.forEach((extension, index) => { filterParams[`extension${index}`] = `%.${extension.toLowerCase()}`; });
    }
    const nameFilterSql = nameFilterTerms.map((term, index) => {
      filterParams[`nameFilter${index}`] = term;
      return `instr(lower(photos.file_name), :nameFilter${index}) > 0`;
    });
    const where = scope + supportedFilter + (nameFilterSql.length ? ` AND (${nameFilterSql.join(' AND ')})` : '');
    // Counts are independent of sorting and are reused across page requests.
    const countCacheKey = [databaseKey, folder.toLocaleLowerCase(), recursive ? '1' : '0', includeUnsupported ? '1' : '0', ...nameFilterTerms].join('|');
    const countStartedAt = Date.now();
    let totalCount = this.galleryCountCache.get(countCacheKey);
    if (totalCount === undefined) {
      const totalCountRow = db.prepare(`SELECT COUNT(*) AS totalCount ${where}`).get(filterParams) as { totalCount: number };
      totalCount = Number(totalCountRow.totalCount) || 0;
      this.galleryCountCache.set(countCacheKey, totalCount);
      // Keep searches typed character by character from growing this cache indefinitely.
      if (this.galleryCountCache.size > 100) {
        const oldestKey = this.galleryCountCache.keys().next().value;
        if (oldestKey !== undefined) this.galleryCountCache.delete(oldestKey);
      }
    }
    const direction = sortDir === 'desc' ? 'DESC' : 'ASC';
    const orderBy = sortBy === 'path'
      ? `paths.relative_folder_path COLLATE NOCASE ${direction}, photos.file_name COLLATE NOCASE ${direction}`
      : sortBy === 'gpsDate'
        ? `photos.gps_timestamp IS NULL ASC, photos.gps_timestamp ${direction}, paths.relative_folder_path COLLATE NOCASE ASC, photos.file_name COLLATE NOCASE ASC`
        : sortBy === 'gps'
          ? `(photos.latitude IS NULL OR photos.longitude IS NULL) ASC, (photos.latitude * 1000 + photos.longitude) ${direction}, paths.relative_folder_path COLLATE NOCASE ASC, photos.file_name COLLATE NOCASE ASC`
          : sortBy === 'location'
            ? `(location_names.display_name IS NULL OR trim(location_names.display_name) = '') ASC, location_names.display_name COLLATE NOCASE ${direction}, paths.relative_folder_path COLLATE NOCASE ASC, photos.file_name COLLATE NOCASE ASC`
            : sortBy === 'suffix'
              ? `lower(substr(photos.file_name, length(photos.file_name) - instr(reverse(photos.file_name), '.') + 2)) ${direction}, photos.file_name COLLATE NOCASE ASC, paths.relative_folder_path COLLATE NOCASE ASC`
              : `${sortBy === 'date' ? 'photos.modified_at' : sortBy === 'size' ? 'photos.file_size' : 'photos.file_name COLLATE NOCASE'} ${direction}, paths.relative_folder_path COLLATE NOCASE ASC, photos.file_name COLLATE NOCASE ASC`;
    const sql = `SELECT photos.file_name, photos.file_size, photos.modified_at, paths.relative_folder_path
      ${where}
      ORDER BY ${orderBy}
      LIMIT :limit OFFSET :offset`;
    const queryParameters = { ...filterParams, limit: safeLimit, offset: safeOffset };
    const queryStartedAt = Date.now();
    console.info('[GalleryDB] QUERY getGalleryFilesPage', {
      directory,
      recursive,
      includeUnsupported,
      sort: `${sortBy} ${sortDir}`,
      limit: safeLimit,
      offset: safeOffset,
      sql
    });
    const rows = db.prepare(sql).all(queryParameters) as Array<{
      file_name: string; file_size: number; modified_at: number; relative_folder_path: string;
    }>;
    console.info('[GalleryDB] QUERY END getGalleryFilesPage', {
      database: databaseKey,
      directory,
      offset: safeOffset,
      limit: safeLimit,
      rows: rows.length,
      durationMs: Date.now() - queryStartedAt
    });
    const files = rows.map(row => {
      const parent = this.resolveStoredFolderPath(row.relative_folder_path, databaseKey);
      return {
        path: join(parent, row.file_name), name: row.file_name, parent, isDirectory: false,
        ext: extname(row.file_name), createdAt: row.modified_at, size: row.file_size, modifiedAt: row.modified_at
      } satisfies FileInfo;
    });
    console.info('[GalleryDB] COUNT END getGalleryFilesPage', {
      directory,
      totalCount,
      durationMs: Date.now() - countStartedAt
    });
    return { files, totalCount, offset: safeOffset, limit: safeLimit };
  };

  @IpcHandler({ name: 'CacheManager.getGalleryFilePosition' })
  readonly getGalleryFilePosition = async (
    _event: IpcMainInvokeEvent,
    directory: string,
    sourcePath: string,
    recursive = false,
    includeUnsupported = false,
    sortBy: SortType = 'name',
    sortDir: SortDirection = 'asc'
  ): Promise<number> => {
    if (typeof directory !== 'string' || !directory.trim() || typeof sourcePath !== 'string' || !sourcePath.trim()) return 0;
    const databaseKey = this.databaseKeyForPath(directory);
    const db = this.databaseForPath(directory);
    const folder = this.toRelativeFolderPath(directory, databaseKey) ?? '';
    const folderPrefix = folder ? folder.replace(/[\\/]+$/, '') + String.fromCharCode(92) : '';
    const scope = `FROM photos JOIN paths ON paths.id = photos.path_id
      LEFT JOIN location_names ON location_names.id = photos.location_name_id AND photos.location_name_id <> 0
      WHERE (
        lower(replace(rtrim(paths.relative_folder_path, char(92) || '/'), '/', char(92))) =
          lower(replace(rtrim(:folder, char(92) || '/'), '/', char(92)))
        OR (:recursive = 1 AND substr(lower(replace(paths.relative_folder_path, '/', char(92))), 1, length(:folderPrefix)) = lower(:folderPrefix))
      )`;
    const supportedFilter = includeUnsupported ? '' : ` AND (${supportedFileExtensions.map((_, index) => `lower(photos.file_name) LIKE :extension${index}`).join(' OR ')})`;
    const parameters: Record<string, string | number> = {
      folder, recursive: recursive ? 1 : 0, folderPrefix,
      targetFolder: this.toRelativeFolderPath(dirname(sourcePath), databaseKey) ?? '',
      targetName: basename(sourcePath).toLocaleLowerCase()
    };
    if (!includeUnsupported) supportedFileExtensions.forEach((extension, index) => {
      parameters[`extension${index}`] = `%.${extension.toLowerCase()}`;
    });
    const direction = sortDir === 'desc' ? 'DESC' : 'ASC';
    const orderBy = sortBy === 'path'
      ? `paths.relative_folder_path COLLATE NOCASE ${direction}, photos.file_name COLLATE NOCASE ${direction}`
      : sortBy === 'gpsDate'
        ? `photos.gps_timestamp IS NULL ASC, photos.gps_timestamp ${direction}, paths.relative_folder_path COLLATE NOCASE ASC, photos.file_name COLLATE NOCASE ASC`
        : sortBy === 'gps'
          ? `(photos.latitude IS NULL OR photos.longitude IS NULL) ASC, (photos.latitude * 1000 + photos.longitude) ${direction}, paths.relative_folder_path COLLATE NOCASE ASC, photos.file_name COLLATE NOCASE ASC`
          : sortBy === 'location'
            ? `(location_names.display_name IS NULL OR trim(location_names.display_name) = '') ASC, location_names.display_name COLLATE NOCASE ${direction}, paths.relative_folder_path COLLATE NOCASE ASC, photos.file_name COLLATE NOCASE ASC`
            : sortBy === 'suffix'
              ? `lower(substr(photos.file_name, length(photos.file_name) - instr(reverse(photos.file_name), '.') + 2)) ${direction}, photos.file_name COLLATE NOCASE ASC, paths.relative_folder_path COLLATE NOCASE ASC`
              : `${sortBy === 'date' ? 'photos.modified_at' : sortBy === 'size' ? 'photos.file_size' : 'photos.file_name COLLATE NOCASE'} ${direction}, paths.relative_folder_path COLLATE NOCASE ASC, photos.file_name COLLATE NOCASE ASC`;
    const row = db.prepare(`SELECT position FROM (
        SELECT photos.file_name, paths.relative_folder_path,
          ROW_NUMBER() OVER (ORDER BY ${orderBy}) AS position
        ${scope}${supportedFilter}
      )
      WHERE lower(file_name) = :targetName
        AND lower(replace(rtrim(relative_folder_path, char(92) || '/'), '/', char(92))) =
            lower(replace(rtrim(:targetFolder, char(92) || '/'), '/', char(92)))
      LIMIT 1`).get(parameters) as { position?: number } | undefined;
    return Number(row?.position) || 0;
  };

  @IpcHandler({ name: 'CacheManager.getGalleryFileAtPosition' })
  readonly getGalleryFileAtPosition = async (
    event: IpcMainInvokeEvent,
    directory: string,
    recursive = false,
    includeUnsupported = false,
    sortBy: SortType = 'name',
    sortDir: SortDirection = 'asc',
    position = 1
  ): Promise<FileInfo | null> => {
    const safePosition = Number.isFinite(position) ? Math.max(1, Math.trunc(position)) : 1;
    const page = await this.getGalleryFilesPage(
      event, directory, recursive, includeUnsupported, sortBy, sortDir, safePosition - 1, 1
    );
    return page.files[0] ?? null;
  };

  @IpcHandler({ name: 'CacheManager.getDirectoryCacheStats' })
  readonly getDirectoryCacheStats = async (_event: IpcMainInvokeEvent, sourceNames: string[], verifyCacheFiles = false): Promise<CacheDirectoryStats> => {
    if (!Array.isArray(sourceNames) || sourceNames.length > 10000 || sourceNames.some(path => typeof path !== 'string' || !path.trim())) {
      throw new Error('A list of valid image paths is required.');
    }
    if (sourceNames.length === 0) return { total: 0, thumbnails: 0, fullSizeConversions: 0, fullSizeConversionTotal: 0, gps: 0, hdr: 0, location: 0, thumbnailPaths: [], fullSizePaths: [] };
    const folder = dirname(sourceNames[0]);
    const databaseKey = this.databaseKeyForPath(folder);
    const db = this.databaseForPath(sourceNames[0]);
    const requestedNames = [...new Set(sourceNames
      .filter(sourceName => dirname(sourceName) === folder)
      .map(sourceName => basename(sourceName).toLowerCase()))];
    if (requestedNames.length === 0) {
      return { total: sourceNames.length, thumbnails: 0, fullSizeConversions: 0, fullSizeConversionTotal: 0, gps: 0, hdr: 0, location: 0, thumbnailPaths: [], fullSizePaths: [] };
    }
    const nameParameters = requestedNames.map((_, index) => `:name${index}`).join(', ');
    const parameters: Record<string, string> = {
      folder: this.toRelativeFolderPath(folder, databaseKey) ?? ''
    };
    requestedNames.forEach((name, index) => { parameters[`name${index}`] = name; });
    const sql = `SELECT photos.*, paths.relative_folder_path,
        location_names.display_name AS location_display_name
      FROM photos JOIN paths ON paths.id = photos.path_id
      LEFT JOIN location_names ON location_names.id = photos.location_name_id AND photos.location_name_id <> 0
      WHERE paths.relative_folder_path = :folder COLLATE NOCASE
        AND photos.file_name COLLATE NOCASE IN (${nameParameters})`;
    const queryStartedAt = Date.now();
    console.info('[GalleryDB] QUERY getDirectoryCacheStats', {
      folder,
      fileCount: requestedNames.length,
      verifyCacheFiles,
      sql
    });
    const matching = db.prepare(sql).all(parameters) as unknown as Array<PhotoRow & {
      relative_folder_path: string; location_display_name: string | null
    }>;
    console.info('[GalleryDB] QUERY END getDirectoryCacheStats', {
      database: databaseKey,
      folder,
      requestedFiles: requestedNames.length,
      matchedRows: matching.length,
      durationMs: Date.now() - queryStartedAt
    });
    const fullSizeConversionTotal = matching.filter(row => FULL_SIZE_EXTENSIONS.has(extname(row.file_name).toLowerCase())).length;
    const gps = matching.filter(row => row.latitude !== null && row.longitude !== null).length;
    const hdr = matching.filter(row => row.is_hdr === 1).length;
    const location = matching.filter(row => !!row.location_display_name?.trim()).length;
    const thumbnailPaths: string[] = [];
    const fullSizePaths: string[] = [];
    await Promise.all(matching.map(async row => {
      const sourceName = join(folder, row.file_name);
      const extension = extname(sourceName).toLowerCase();
      const isOhsp = extension === '.ohsp';
      const fullSizeTag = isOhsp ? 'ohsp-full-spectrum-v15' : ['.dng', '.rw2', '.raw'].includes(extension) ? (extension === '.dng' ? 'dng-full-raw-v2' : 'camera-raw-full-v1') : `${extension.slice(1)}${[ '.tif', '.tiff' ].includes(extension) ? '-full-hdr-v6' : extension === '.exr' ? '-full-uhdr-v2' : '-full-uhdr'}`;
      const fullSizeValid = FULL_SIZE_EXTENSIONS.has(extension) && row.fullsize_cache_id !== null
        && row.fullsize_cache_version === getFullSizeCacheVersionCode(fullSizeTag);
      // OHSP gallery previews use the full-size derivative as their thumbnail.
      const thumbnailValid = isOhsp
        ? fullSizeValid
        : row.thumbnail_cache_id === CACHE_STORAGE_TYPE.SIDECAR
          && row.thumbnail_cache_version === getThumbnailCacheVersion(sourceName);
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
        const thumbnailPath = isOhsp
          ? (row.fullsize_cache_id === CACHE_STORAGE_TYPE.PARALLEL ? this.getParallelPath(sourceName) : this.getSidecarPath(sourceName, true))
          : this.getSidecarPath(sourceName, false);
        try { const info = await stat(thumbnailPath); if (info.isFile()) thumbnailPaths.push(sourceName); }
        catch { /* Missing thumbnail cache file. */ }
      }
      if (fullSizeValid) {
        const fullSizePath = row.fullsize_cache_id === CACHE_STORAGE_TYPE.PARALLEL
          ? this.getParallelPath(sourceName) : this.getSidecarPath(sourceName, true);
        try { const info = await stat(fullSizePath); if (info.isFile()) fullSizePaths.push(sourceName); }
        catch { /* Missing full-size cache file. */ }
      }
    }));
    return { total: sourceNames.length, thumbnails: thumbnailPaths.length, fullSizeConversions: fullSizePaths.length, fullSizeConversionTotal, gps, hdr, location, thumbnailPaths, fullSizePaths };
  };

  @IpcHandler({ name: 'CacheManager.selectDatabaseForDirectory' })
  readonly selectDatabaseForDirectory = async (_event: IpcMainInvokeEvent, directory: string): Promise<boolean> => {
    if (typeof directory !== 'string' || !directory.trim()) throw new Error('A valid image folder path is required.');
    this.databaseForPath(directory);
    this.activeDatabaseKey = this.databaseKeyForPath(directory);
    this.notifyReverseGeocodingStatusChanged();
    return true;
  };

  private readonly reconcilePhotoRecordsInScope = (directory: string, sourceNames: string[], recursive: boolean): number => {
    const root = resolve(directory);
    const databaseKey = this.databaseKeyForPath(root);
    const db = this.databaseForPath(root);
    const existingPaths = new Set<string>();
    for (const sourceName of sourceNames) {
      const absolute = resolve(sourceName);
      const relativePath = relative(root, absolute);
      if (relativePath === '..' || relativePath.startsWith('..' + sep) || isAbsolute(relativePath)) {
        throw new Error(`A verified image path is outside the selected folder: ${sourceName}`);
      }
      existingPaths.add(absolute.toLowerCase());
    }

    const rows = db.prepare(`SELECT photos.id, photos.file_name, paths.relative_folder_path
      FROM photos JOIN paths ON paths.id = photos.path_id`)
      .all() as Array<{ id: number; file_name: string; relative_folder_path: string }>;
    const staleIds = rows.filter(row => {
      const folder = resolve(this.resolveStoredFolderPath(row.relative_folder_path, databaseKey));
      const relativeFolder = relative(root, folder);
      const inScope = relativeFolder === ''
        || (recursive && relativeFolder !== '..' && !relativeFolder.startsWith('..' + sep) && !isAbsolute(relativeFolder));
      return inScope && !existingPaths.has(resolve(folder, row.file_name).toLowerCase());
    }).map(row => row.id);

    if (!staleIds.length) return 0;
    const deletePhoto = db.prepare('DELETE FROM photos WHERE id = :id');
    db.exec('BEGIN IMMEDIATE;');
    try {
      for (const id of staleIds) deletePhoto.run({ id });
      db.exec('DELETE FROM paths WHERE id NOT IN (SELECT DISTINCT path_id FROM photos);');
      db.exec('COMMIT;');
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch { /* Preserve the database error. */ }
      throw error;
    }
    return staleIds.length;
  };

  @IpcHandler({ name: 'CacheManager.reconcilePhotoRecordsFromDisk' })
  readonly reconcilePhotoRecordsFromDisk = async (
    _event: IpcMainInvokeEvent,
    directory: string,
    recursive = false
  ): Promise<number> => {
    if (typeof directory !== 'string' || !directory.trim()) {
      throw new Error('A valid image folder path is required.');
    }
    const root = resolve(directory);
    const databaseKey = this.databaseKeyForPath(root);
    const db = this.databaseForPath(root);
    const folder = this.toRelativeFolderPath(root, databaseKey) ?? '';
    const folderPrefix = folder ? folder.replace(/[\\/]+$/, '') + String.fromCharCode(92) : '';
    const select = db.prepare(`SELECT photos.id, photos.file_name, paths.relative_folder_path
      FROM photos
      JOIN paths ON paths.id = photos.path_id
      WHERE lower(replace(rtrim(paths.relative_folder_path, char(92) || '/'), '/', char(92))) =
          lower(replace(rtrim(:folder, char(92) || '/'), '/', char(92)))
        OR (:recursive = 1 AND substr(lower(replace(paths.relative_folder_path, '/', char(92))), 1, length(:folderPrefix)) = lower(:folderPrefix))`);
    const insertStale = db.prepare('INSERT OR IGNORE INTO temp.lumascope_stale_photo_ids (id) VALUES (:id)');
    const deleteStale = db.prepare('DELETE FROM photos WHERE id IN (SELECT id FROM temp.lumascope_stale_photo_ids)');
    db.exec('CREATE TEMP TABLE IF NOT EXISTS lumascope_stale_photo_ids (id INTEGER PRIMARY KEY);');
    db.exec('DELETE FROM temp.lumascope_stale_photo_ids;');
    let staleCount = 0;
    db.exec('BEGIN IMMEDIATE;');
    try {
      const rows = select.iterate({ folder, recursive: recursive ? 1 : 0, folderPrefix }) as unknown as Iterable<{
        id: number; file_name: string; relative_folder_path: string
      }>;
      for (const row of rows) {
        const sourcePath = join(this.resolveStoredFolderPath(row.relative_folder_path, databaseKey), row.file_name);
        if (!existsSync(sourcePath)) {
          insertStale.run({ id: row.id });
          staleCount++;
        }
      }
      if (staleCount > 0) deleteStale.run();
      db.exec('DELETE FROM paths WHERE id NOT IN (SELECT DISTINCT path_id FROM photos);');
      db.exec('DELETE FROM temp.lumascope_stale_photo_ids;');
      db.exec('COMMIT;');
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch { /* Preserve the database error. */ }
      throw error;
    }
    return staleCount;
  };

  @IpcHandler({ name: 'CacheManager.reconcilePhotoRecords' })
  readonly reconcilePhotoRecords = async (
    _event: IpcMainInvokeEvent,
    directory: string,
    sourceNames: string[],
    recursive = false
  ): Promise<number> => {
    if (typeof directory !== 'string' || !directory.trim()
      || !Array.isArray(sourceNames) || sourceNames.length > 500000
      || sourceNames.some(path => typeof path !== 'string' || !path.trim())) {
      throw new Error('A valid folder and complete list of image paths are required.');
    }
    return this.reconcilePhotoRecordsInScope(directory, sourceNames, recursive);
  };

  @IpcHandler({ name: 'CacheManager.getDirectoryPhotoLocations' })
  readonly getDirectoryPhotoLocations = async (_event: IpcMainInvokeEvent, directory: string, recursive = false): Promise<PhotoLocation[]> => {
    if (typeof directory !== 'string' || !directory.trim()) throw new Error('A valid image folder path is required.');
    if (!recursive) {
      const entries = await readdir(directory, { withFileTypes: true });
      const sourceNames = entries
        .filter(entry => entry.isFile() || entry.isSymbolicLink())
        .map(entry => join(directory, entry.name));
      this.reconcilePhotoRecordsInScope(directory, sourceNames, false);
    }
    const db = this.databaseForPath(directory);
    const databaseKey = this.databaseKeyForPath(directory);
    this.activeDatabaseKey = databaseKey;
    const folder = this.toRelativeFolderPath(directory, databaseKey) ?? '';
    const folderPrefix = folder ? folder.replace(/[\\/]+$/, '') + String.fromCharCode(92) : '';
    const rows = db.prepare(`SELECT photos.file_name, photos.latitude, photos.longitude, photos.gps_timestamp,
        paths.relative_folder_path,
        location_names.display_name AS location_display_name
      FROM photos JOIN paths ON paths.id = photos.path_id
      LEFT JOIN location_names ON location_names.id = photos.location_name_id AND photos.location_name_id <> 0
      WHERE lower(replace(rtrim(paths.relative_folder_path, char(92) || '/'), '/', char(92))) =
          lower(replace(rtrim(:folder, char(92) || '/'), '/', char(92)))
        OR (:recursive = 1 AND substr(lower(replace(paths.relative_folder_path, '/', char(92))), 1, length(:folderPrefix)) = lower(:folderPrefix))
      ORDER BY paths.relative_folder_path COLLATE NOCASE, photos.file_name COLLATE NOCASE`)
      .all({ folder, recursive: recursive ? 1 : 0, folderPrefix }) as unknown as Array<{ file_name: string; relative_folder_path: string; latitude: number | null; longitude: number | null; gps_timestamp: number | null; location_display_name: string | null }>;
    return rows.map(row => ({
      path: join(directory, relative(folder, row.relative_folder_path), row.file_name),
      fileName: row.file_name,
      latitude: row.latitude,
      longitude: row.longitude,
      gpsTimestamp: row.gps_timestamp,
      displayName: row.location_display_name
    }));
  };

  @IpcHandler({ name: 'CacheManager.getPhotoLocationsInBounds' })
  readonly getPhotoLocationsInBounds = async (
    _event: IpcMainInvokeEvent,
    bounds: { west: number; south: number; east: number; north: number },
    requestedDatabaseKey: string
  ): Promise<PhotoLocation[]> => {
    if (!bounds || ![bounds.west, bounds.south, bounds.east, bounds.north].every(Number.isFinite)
      || bounds.south < -90 || bounds.north > 90 || bounds.south > bounds.north
      || bounds.west < -180 || bounds.west > 180 || bounds.east < -180 || bounds.east > 180
      || bounds.west > bounds.east) {
      throw new Error('A valid map viewport is required.');
    }
    const databaseKey = requestedDatabaseKey?.toUpperCase();
    if (!databaseKey || !/^[A-Z]:$/.test(databaseKey)) throw new Error('A valid cache database drive must be selected.');
    const db = this.databases.get(databaseKey) ?? this.databaseForPath(databaseKey + '\\');
    this.activeDatabaseKey = databaseKey;
    const rows = db.prepare(`SELECT photos.file_name, photos.latitude, photos.longitude, photos.gps_timestamp,
        paths.relative_folder_path,
        location_names.display_name AS location_display_name
      FROM photo_location_rtree r
      JOIN photos ON photos.id = r.photo_id
      JOIN paths ON paths.id = photos.path_id
      LEFT JOIN location_names ON location_names.id = photos.location_name_id AND photos.location_name_id <> 0
      WHERE r.min_latitude <= :north AND r.max_latitude >= :south
        AND r.min_longitude <= :east AND r.max_longitude >= :west
      ORDER BY paths.relative_folder_path COLLATE NOCASE, photos.file_name COLLATE NOCASE`)
      .all({ west: bounds.west, south: bounds.south, east: bounds.east, north: bounds.north }) as unknown as Array<{
        file_name: string; latitude: number | null; longitude: number | null; gps_timestamp: number | null;
        relative_folder_path: string; location_display_name: string | null;
      }>;
    return rows.map(row => ({
      path: join(this.resolveStoredFolderPath(row.relative_folder_path, databaseKey), row.file_name),
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
    const row = db.prepare(`SELECT photos.*, paths.relative_folder_path,
        coordinate_sources.name AS coordinate_source_name,
        COALESCE(location_names.display_name, location_names.place_name) AS location_name_display
      FROM photos
      JOIN paths ON paths.id = photos.path_id
      LEFT JOIN coordinate_sources ON coordinate_sources.id = photos.coordinate_source_id
      LEFT JOIN location_names ON location_names.id = photos.location_name_id
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
      typedRecord.path_id_expanded = this.resolveStoredFolderPath(row.relative_folder_path, databaseKey);
    }
    typedRecord.coordinate_source_id_expanded = row.coordinate_source_name ?? null;
    typedRecord.location_name_id_expanded = row.location_name_display ?? null;
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


  // Register every image inspected by GPS Auto Fix, even when it has no usable timestamp or GPS data.
  // ensurePhoto also refreshes the stored file fingerprint and invalidates stale cache metadata if the source changed.
  readonly registerPhotoFile = async (sourceName: string): Promise<void> => {
    const db = this.databaseForPath(sourceName);
    const sourceStats = await stat(sourceName);
    if (!sourceStats.isFile()) throw new Error('The selected image file is not available.');
    this.ensurePhoto(sourceName, Number(sourceStats.size), Number(sourceStats.mtimeMs), db);
  };

  readonly updatePhotoMetadata = async (sourceName: string, isHdr: boolean, gps: Awaited<ReturnType<Exif['readPhotoMetadata']>>): Promise<void> => {
    const db = this.databaseForPath(sourceName);
    const sourceStats = await stat(sourceName);
    const row = this.ensurePhoto(sourceName, Number(sourceStats.size), Number(sourceStats.mtimeMs), db);
    const hasCoordinates = gps.latitude !== null && gps.longitude !== null;
    db.prepare(`UPDATE photos SET is_hdr = :isHdr,
      location_name_id = CASE WHEN :hasCoordinates = 0 OR latitude IS NOT :latitude OR longitude IS NOT :longitude THEN NULL ELSE location_name_id END,
      location_lookup_error = CASE WHEN :hasCoordinates = 0 OR latitude IS NOT :latitude OR longitude IS NOT :longitude THEN NULL ELSE location_lookup_error END,
      location_lookup_attempted_at = CASE WHEN :hasCoordinates = 0 OR latitude IS NOT :latitude OR longitude IS NOT :longitude THEN NULL ELSE location_lookup_attempted_at END,
      latitude = :latitude, longitude = :longitude,
      altitude_m = :altitude, gps_timestamp = :gpsTimestamp, direction_deg = :direction,
      coordinate_source_id = :sourceId,
      gps_manually_corrected = :gpsManuallyCorrected,
      gps_manual_corrected_at = CASE
        WHEN :gpsManuallyCorrected = 0 THEN NULL
        WHEN gps_manually_corrected = 1 AND gps_manual_corrected_at IS NOT NULL THEN gps_manual_corrected_at
        ELSE :gpsManualCorrectedAt
      END WHERE id = :id`)
      .run({
        isHdr: isHdr ? 1 : 0,
        hasCoordinates: hasCoordinates ? 1 : 0,
        latitude: hasCoordinates ? gps.latitude : null,
        longitude: hasCoordinates ? gps.longitude : null,
        altitude: hasCoordinates ? gps.altitudeM : null,
        // Store the selected capture timestamp for every photo, including
        // photos that do not yet have GPS coordinates. The EXIF reader applies
        // GPSDateTime -> XMP:GPSDateTime -> camera filename timestamp ->
        // DateTimeOriginal -> XMP:DateCreated -> CreateDate. Filesystem
        // last-modified time is the final fallback (e.g. Android/ADB copies
        // where a valid camera filename timestamp must win over copy time).
        gpsTimestamp: gps.gpsTimestamp ?? Math.floor(Number(sourceStats.mtimeMs) / 1000),
        direction: hasCoordinates ? gps.directionDeg : null,
        sourceId: hasCoordinates ? gps.coordinateSourceId : null,
        gpsManuallyCorrected: gps.gpsManuallyCorrected && hasCoordinates ? 1 : 0,
        gpsManualCorrectedAt: Math.floor(Date.now() / 1000),
        id: row.id
      });
    if (hasCoordinates) {
      const updated = this.getPhoto(sourceName);
      // Resolve the location in the background, but apply backpressure to the
      // cache builder. Nominatim is rate-limited to about one request per second;
      // allowing every photo to enqueue at once retains an unbounded promise chain
      // and can exhaust Electron's main-process V8 heap on large folders.
      if (updated) {
        const releaseSlot = await this.acquireBackgroundLocationLookupSlot();
        void this.ensureLocationName(updated, db, false, false, false, this.databaseKeyForPath(sourceName))
          .finally(releaseSlot);
      }
    }
  };

  readonly updatePhotoGpsTimestamp = async (sourceName: string, timestamp: number): Promise<void> => {
    if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error('A valid photo timestamp is required.');
    const db = this.databaseForPath(sourceName);
    const sourceStats = await stat(sourceName);
    const row = this.ensurePhoto(sourceName, Number(sourceStats.size), Number(sourceStats.mtimeMs), db);
    db.prepare('UPDATE photos SET gps_timestamp = :timestamp WHERE id = :id')
      .run({ timestamp: Math.floor(timestamp), id: row.id });
  };

  readonly usesSidecarStorage = (_sourceName: string): boolean => true;

  readonly hasThumbnailFailure = async (sourceName: string): Promise<boolean> => {
    try {
      const sourceStats = await stat(sourceName);
      const row = this.getPhoto(sourceName);
      return !!row
        && row.thumbnail_failure_version === THUMBNAIL_FAILURE_VERSION
        && row.thumbnail_failure_size === sourceStats.size
        && row.thumbnail_failure_modified_at === sourceStats.mtimeMs;
    } catch {
      return false;
    }
  };

  readonly markThumbnailFailure = async (sourceName: string): Promise<void> => {
    const sourceStats = await stat(sourceName);
    const db = this.databaseForPath(sourceName);
    const row = this.ensurePhoto(sourceName, Number(sourceStats.size), Number(sourceStats.mtimeMs), db);
    db.prepare(`UPDATE photos SET thumbnail_failure_size = :size,
      thumbnail_failure_modified_at = :modifiedAt,
      thumbnail_failure_version = :version
      WHERE id = :id`).run({
        size: sourceStats.size,
        modifiedAt: sourceStats.mtimeMs,
        version: THUMBNAIL_FAILURE_VERSION,
        id: row.id
      });
  };

  readonly clearThumbnailFailure = (sourceName: string): void => {
    const row = this.getPhoto(sourceName);
    if (!row) return;
    const db = this.databaseForPath(sourceName);
    db.prepare('UPDATE photos SET thumbnail_failure_size = NULL, thumbnail_failure_modified_at = NULL, thumbnail_failure_version = NULL WHERE id = :id')
      .run({ id: row.id });
  };

  /** Remove legacy per-thumbnail OHSP files; the full-size derivative is the sole cache. */
  readonly clearThumbnailCache = async (sourceName: string): Promise<void> => {
    const db = this.databaseForPath(sourceName);
    const row = this.getPhoto(sourceName, db);
    if (!row || row.thumbnail_cache_id === null) return;
    if (row.thumbnail_cache_id === CACHE_STORAGE_TYPE.SIDECAR) {
      await rm(this.getSidecarPath(sourceName, false), { force: true });
    }
    db.prepare('UPDATE photos SET thumbnail_cache_id = NULL, thumbnail_cache_version = NULL WHERE id = :id')
      .run({ id: row.id });
  };

  readonly exists = (sourceName: string, sourceTag: string): Record<string, SQLOutputValue> | null => {
    const row = this.getPhoto(sourceName);
    if (!row) return null;
    const full = sourceTag.includes('-full-');
    const cacheId = full ? row.fullsize_cache_id : row.thumbnail_cache_id;
    const version = full ? row.fullsize_cache_version : row.thumbnail_cache_version;
    const expectedVersion = full ? getFullSizeCacheVersionCode(sourceTag) : getThumbnailCacheVersion(sourceName);
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
    const isOhsp = extname(sourceName).toLowerCase() === '.ohsp';
    const storedVersion = full
      ? getFullSizeCacheVersionCode(sourceTag)
      : sourceTag === THUMBNAIL_CACHE_TAG || isOhsp ? getThumbnailCacheVersion(sourceName) : null;
    if (sourceChanged || (storedVersion !== null && cacheVersion !== storedVersion)) await rm(targetPath, { force: true });
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
        thumbnail_cache_id = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.thumbnail_cache_id END,
        thumbnail_cache_version = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.thumbnail_cache_version END,
        thumbnail_failure_size = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.thumbnail_failure_size END,
        thumbnail_failure_modified_at = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.thumbnail_failure_modified_at END,
        thumbnail_failure_version = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.thumbnail_failure_version END,
        fullsize_cache_id = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.fullsize_cache_id END,
        fullsize_cache_version = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.fullsize_cache_version END,
        latitude = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.latitude END,
        longitude = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.longitude END,
        altitude_m = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.altitude_m END,
        gps_timestamp = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.gps_timestamp END,
        direction_deg = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.direction_deg END,
        location_name_id = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.location_name_id END,
        coordinate_source_id = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.coordinate_source_id END,
        gps_manually_corrected = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN 0 ELSE photos.gps_manually_corrected END,
        gps_manual_corrected_at = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.gps_manual_corrected_at END,
        file_name = excluded.file_name,
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

    let lookupDirectory: string | null = null;
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
      lookupDirectory = this.currentReverseGeocodingPath ? dirname(this.currentReverseGeocodingPath) : null;
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
        const errorName = error instanceof Error ? error.name : '';
        const aborted = errorName === 'AbortError';
        const timedOut = errorName === 'TimeoutError';
        if (timedOut) {
          // Keep location_name_id unset so a later cache/geocoding pass can retry this photo.
          lookupError = 'Nominatim request timed out; this location can be retried.';
          console.warn('[CacheManager] Reverse geocoding timed out; location remains retryable', {
            photoId: photo.id,
            latitude: photo.latitude,
            longitude: photo.longitude,
            error: error instanceof Error ? error.message : String(error)
          });
        } else if (!aborted) {
          lookupError = error instanceof Error ? error.message : String(error);
          thrownError = error;
          console.error('[CacheManager] Reverse geocoding failed', {
            photoId: photo.id,
            latitude: photo.latitude,
            longitude: photo.longitude,
            error: lookupError
          });
        }
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
    this.notifyReverseGeocodingStatusChanged();
    try {
      return await operation;
    } finally {
      if (this.pendingLocationLookups.get(pendingKey) === operation) this.pendingLocationLookups.delete(pendingKey);
      if (this.currentReverseGeocodingPhotoId === photo.id && this.currentReverseGeocodingDatabaseKey === databaseKey) {
        this.currentReverseGeocodingPath = null;
        this.currentReverseGeocodingDisplayName = null;
        this.currentReverseGeocodingPhotoId = null;
      }
      if (lookupDirectory) this.notifyDirectoryPhotoLocationsChanged(lookupDirectory);
      else this.notifyReverseGeocodingStatusChanged();
    }
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
      updatePhoto.run({ full: full ? 1 : 0, cacheId: storageId, version: full ? getFullSizeCacheVersionCode(tag) : tag === THUMBNAIL_CACHE_TAG ? getThumbnailCacheVersion(file) : null, pathId: path.id, file });
    }
    db.exec('DROP TABLE cache_files; DROP TABLE IF EXISTS cache_volume_settings;');
  };
}
