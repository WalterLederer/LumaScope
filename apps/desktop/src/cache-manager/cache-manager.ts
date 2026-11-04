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
  databases: Array<{ path: string; bytes: number }>;
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
  private readonly cacheConfigFile = join(this.userData, 'cache.sqlite');
  private readonly legacyCacheDir = join(this.userData, 'image-cache');
  private readonly db: DatabaseSync;
  private readonly pendingEntries = new Map<string, Promise<string | null>>();
  private readonly pendingLocationLookups = new Map<number, Promise<string | null>>();

  private readonly activeClearOperations = new Set<string>();

  private readonly cancelledClearOperations = new Set<string>();
  private readonly deletingSources = new Map<string, Promise<CacheClearResult>>();

  constructor() {
    mkdirSync(this.userData, { recursive: true });
    this.db = new DatabaseSync(this.cacheConfigFile);
    this.db.exec('PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;');
    this.init();
  }

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
    const pending = [...this.pendingEntries.entries()]
      .filter(([key]) => { try { return JSON.parse(key)[0] === sourceName; } catch { return false; } })
      .map(([, operation]) => operation);
    await Promise.all(pending);
    const row = this.getPhoto(sourceName);
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
    this.db.prepare('UPDATE photos SET thumbnail_cache_id = NULL, thumbnail_cache_version = NULL, fullsize_cache_id = NULL, fullsize_cache_version = NULL WHERE id = :id').run({ id: row.id });
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

    const column = kind === 'thumbnail' ? 'thumbnail' : 'fullsize';
    const allRows = this.db.prepare('SELECT photos.*, paths.folder_path FROM photos JOIN paths ON paths.id = photos.path_id WHERE photos.' + column + '_cache_id = :cacheId')
      .all({ cacheId: CACHE_STORAGE_TYPE.SIDECAR }) as unknown as Array<PhotoRow & { folder_path: string }>;
    const root = directory ? resolve(directory) : null;
    const rows = root === null ? allRows : allRows.filter(row => {
      const relativeFolder = relative(root, resolve(row.folder_path));
      if (relativeFolder === '') return true;
      return recursive && relativeFolder !== '..' && !relativeFolder.startsWith('..' + sep) && !isAbsolute(relativeFolder);
    });
    let bytes = 0;
    let entries = 0;
    for (const row of rows) {
      if (this.isClearCancelled(operationId)) break;
      const source = join(row.folder_path, row.file_name);
      const target = this.getSidecarPath(source, kind === 'fullsize');
      try { bytes += (await stat(target)).size; await rm(target, { force: true }); } catch { /* Missing cache file. */ }
      this.db.prepare('UPDATE photos SET ' + column + '_cache_id = NULL, ' + column + '_cache_version = NULL WHERE id = :id').run({ id: row.id });
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

    const root = resolve(directory);
    const rows = this.db.prepare(`SELECT photos.id, photos.latitude, photos.longitude, photos.location_name_id, paths.folder_path
      FROM photos JOIN paths ON paths.id = photos.path_id
      WHERE photos.latitude IS NOT NULL AND photos.longitude IS NOT NULL
        AND (photos.location_name_id IS NULL OR photos.location_name_id = 0)
      ORDER BY paths.folder_path, photos.file_name`)
      .all() as unknown as Array<Pick<PhotoRow, 'id' | 'latitude' | 'longitude' | 'location_name_id'> & { folder_path: string }>;
    const candidates = rows.filter(row => {
      const relativeFolder = relative(root, resolve(row.folder_path));
      if (relativeFolder === '') return true;
      return recursive && relativeFolder !== '..' && !relativeFolder.startsWith('..' + sep) && !isAbsolute(relativeFolder);
    });

    let resolved = 0;
    let unresolved = 0;
    for (const row of candidates) {
      // Allow this explicit batch action to retry previous Unknown (ID 0) results.
      await this.ensureLocationName({ ...row, location_name_id: null }, true);
      const saved = this.db.prepare('SELECT location_name_id FROM photos WHERE id = :id')
        .get({ id: row.id }) as { location_name_id: number | null } | undefined;
      if (saved?.location_name_id !== null && saved?.location_name_id !== undefined && saved.location_name_id !== 0) resolved++;
      else unresolved++;
    }
    return { total: candidates.length, resolved, unresolved };
  };

  @IpcHandler({ name: 'CacheManager.getCacheSummary' })
  readonly getCacheSummary = async (): Promise<CacheSummary> => {
    const rows = this.db.prepare(`SELECT photos.*, paths.folder_path FROM photos
      JOIN paths ON paths.id = photos.path_id
      WHERE photos.thumbnail_cache_id IS NOT NULL OR photos.fullsize_cache_id IS NOT NULL
      OR (photos.latitude IS NOT NULL AND photos.longitude IS NOT NULL)`)
      .all() as unknown as Array<PhotoRow & { folder_path: string }>;
    const summary: CacheSummary = {
      total: { entries: 0, bytes: 0 },
      fullSize: { entries: 0, bytes: 0 },
      thumbnails: { entries: 0, bytes: 0 },
      sidecar: { entries: 0, bytes: 0 },
      gps: { entries: 0, bytes: 0 },
      databases: []
    };

    for (const row of rows) {
      const source = join(row.folder_path, row.file_name);
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

    const findDatabases = async (directory: string): Promise<void> => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          await findDatabases(path);
        } else if (entry.isFile() && /\.(?:sqlite|sqlite3|db)$/i.test(entry.name)) {
          try {
            const info = await stat(path);
            summary.databases.push({ path, bytes: info.size });
          } catch { /* Database may disappear during enumeration. */ }
        }
      }
    };
    await findDatabases(this.userData);
    summary.databases.sort((left, right) => left.path.localeCompare(right.path, undefined, { sensitivity: 'base' }));
    return summary;
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
    const findPhoto = this.db.prepare(`SELECT photos.* FROM photos
      JOIN paths ON paths.id = photos.path_id
      WHERE paths.folder_path = :folder AND photos.file_name = :file COLLATE NOCASE`);

    return Promise.all([...new Set(sourceNames)].map(async sourceName => {
      const row = findPhoto.get({ folder: dirname(sourceName), file: basename(sourceName) }) as unknown as PhotoRow | undefined;
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
    const requestedNames = new Set(sourceNames.filter(sourceName => dirname(sourceName) === folder).map(sourceName => basename(sourceName).toLowerCase()));
    const rows = this.db.prepare(`SELECT photos.*, paths.folder_path FROM photos
      JOIN paths ON paths.id = photos.path_id WHERE paths.folder_path = :folder
      AND (photos.thumbnail_cache_id IS NOT NULL OR photos.fullsize_cache_id IS NOT NULL)`)
      .all({ folder }) as unknown as Array<PhotoRow & { folder_path: string }>;
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
    const rows = this.db.prepare(`SELECT photos.file_name, photos.latitude, photos.longitude
      FROM photos JOIN paths ON paths.id = photos.path_id
      WHERE paths.folder_path = :folder
      ORDER BY photos.file_name COLLATE NOCASE`)
      .all({ folder: directory }) as unknown as Array<{ file_name: string; latitude: number | null; longitude: number | null }>;
    return rows.map(row => ({
      path: join(directory, row.file_name),
      fileName: row.file_name,
      latitude: row.latitude,
      longitude: row.longitude
    }));
  };

  @IpcHandler({ name: 'CacheManager.getPhotoDatabaseRecord' })
  readonly getPhotoDatabaseRecord = async (_event: IpcMainInvokeEvent, sourceName: string): Promise<Record<string, string | number | null> | null> => {
    if (typeof sourceName !== 'string' || !sourceName.trim()) throw new Error('A valid image path is required.');
    const row = this.db.prepare(`SELECT
        photos.id,
        photos.path_id,
        paths.folder_path AS path_id_expanded,
        photos.file_name,
        photos.file_size,
        photos.modified_at,
        photos.is_hdr,
        photos.thumbnail_cache_id,
        cache_thumb.name AS thumbnail_cache_id_expanded,
        photos.thumbnail_cache_version,
        photos.fullsize_cache_id,
        cache_full.name AS fullsize_cache_id_expanded,
        photos.fullsize_cache_version,
        photos.latitude,
        photos.longitude,
        photos.altitude_m,
        photos.gps_timestamp,
        photos.direction_deg,
        photos.coordinate_source_id,
        coordinate_sources.name AS coordinate_source_id_expanded,
        CASE WHEN photos.location_name_id = 0 THEN NULL ELSE photos.location_name_id END AS location_name_id,
        CASE WHEN photos.location_name_id = 0 OR location_names.id IS NULL THEN NULL ELSE
          location_names.place_name || COALESCE(', ' || location_names.locality, '') ||
          COALESCE(', ' || location_names.region, '') ||
          COALESCE(', ' || location_names.country_code, '') END AS location_name_id_expanded
      FROM photos
      JOIN paths ON paths.id = photos.path_id
      LEFT JOIN cache_storage_types AS cache_thumb ON cache_thumb.id = photos.thumbnail_cache_id
      LEFT JOIN cache_storage_types AS cache_full ON cache_full.id = photos.fullsize_cache_id
      LEFT JOIN coordinate_sources ON coordinate_sources.id = photos.coordinate_source_id
      LEFT JOIN location_names ON location_names.id = photos.location_name_id AND photos.location_name_id <> 0
      WHERE paths.folder_path = :folder AND photos.file_name = :file COLLATE NOCASE
    `).get({ folder: dirname(sourceName), file: basename(sourceName) }) as unknown as Record<string, string | number | null> | undefined;
    if (!row) return null;
    const columnTypes = new Map(
      (this.db.prepare('PRAGMA table_info(photos)').all() as Array<{ name: string; type: string }>)
        .map(column => [column.name, column.type.toUpperCase()])
    );
    const typedRecord: Record<string, string | number | null> = { ...row };
    for (const key of Object.keys(row)) {
      if (key.endsWith('_expanded')) continue;
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

    const sourceStats = await stat(sourceName);
    if (!sourceStats.isFile()) throw new Error('The selected image file is not available.');
    const row = this.ensurePhoto(sourceName, Number(sourceStats.size), Number(sourceStats.mtimeMs));

    if (row.latitude !== latitude || row.longitude !== longitude) {
      this.db.prepare('UPDATE photos SET latitude = :latitude, longitude = :longitude, location_name_id = NULL WHERE id = :id')
        .run({ latitude, longitude, id: row.id });
    }

    const updated = this.getPhoto(sourceName);
    if (!updated) return null;
    const resolvedDisplayName = await this.ensureLocationName(updated, true, true);

    const saved = this.db.prepare(`SELECT location_names.place_name, location_names.locality, location_names.region, location_names.country_code
      FROM photos JOIN location_names ON location_names.id = photos.location_name_id WHERE photos.id = :id`)
      .get({ id: row.id }) as { place_name: string; locality: string | null; region: string | null; country_code: string | null } | undefined;
    if (!saved) throw new Error('The reverse-geocoding provider returned no location for these GPS coordinates.');
    if (resolvedDisplayName) return resolvedDisplayName;
    return [saved.place_name, saved.locality, saved.region, saved.country_code]
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
    const sourceStats = await stat(sourceName);
    const row = this.ensurePhoto(sourceName, Number(sourceStats.size), Number(sourceStats.mtimeMs));
    const hasCoordinates = gps.latitude !== null && gps.longitude !== null;
    this.db.prepare(`UPDATE photos SET is_hdr = :isHdr, latitude = :latitude, longitude = :longitude,
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
      if (updated) void this.ensureLocationName(updated);
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
    const row = this.getPhoto(sourceName);
    if (row?.fullsize_cache_id === CACHE_STORAGE_TYPE.PARALLEL && row.fullsize_cache_version === getFullSizeCacheVersionCode(sourceTag)) {
      this.db.prepare('UPDATE photos SET fullsize_cache_id = NULL, fullsize_cache_version = NULL WHERE id = :id').run({ id: row.id });
    }
  };

  readonly registerParallel = async (sourceName: string, sourceTag: string, targetPath: string): Promise<string | null> => {
    if (!FULL_SIZE_EXTENSIONS.has(extname(sourceName).toLowerCase()) || resolve(targetPath) !== resolve(this.getParallelPath(sourceName))) return null;
    try {
      const [sourceStats, targetStats] = await Promise.all([stat(sourceName), stat(targetPath)]);
      if (!targetStats.isFile()) return null;
      const previous = this.getPhoto(sourceName);
      const row = this.ensurePhoto(sourceName, Number(sourceStats.size), Number(sourceStats.mtimeMs));
      if (previous?.fullsize_cache_id === CACHE_STORAGE_TYPE.SIDECAR) {
        await rm(this.getSidecarPath(sourceName, true), { force: true });
      }
      this.db.prepare('UPDATE photos SET fullsize_cache_id = :cacheId, fullsize_cache_version = :version WHERE id = :id')
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
    const sourceStats = await stat(sourceName);
    const previous = this.getPhoto(sourceName);
    const full = sourceTag.includes('-full-');
    const previousSize = previous?.file_size;
    const previousModified = previous?.modified_at;
    const row = this.ensurePhoto(sourceName, Number(sourceStats.size), Number(sourceStats.mtimeMs));
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
    this.db.prepare('UPDATE photos SET ' + (full ? 'fullsize' : 'thumbnail') + '_cache_id = :cacheId, ' +
      (full ? 'fullsize' : 'thumbnail') + '_cache_version = :version WHERE id = :id')
      .run({ cacheId: CACHE_STORAGE_TYPE.SIDECAR, version: storedVersion, id: row.id });
    return targetPath;
  };

  private readonly getPhoto = (sourceName: string): PhotoRow | null => {
    const row = this.db.prepare('SELECT photos.* FROM photos JOIN paths ON paths.id = photos.path_id WHERE paths.folder_path = :folder AND photos.file_name = :file COLLATE NOCASE')
      .get({ folder: dirname(sourceName), file: basename(sourceName) }) as unknown as PhotoRow | undefined;
    return row ?? null;
  };

  private readonly ensurePhoto = (sourceName: string, size: number, modified: number): PhotoRow => {
    const folder = dirname(sourceName);
    this.db.prepare('INSERT OR IGNORE INTO paths (folder_path) VALUES (:folder)').run({ folder });
    const path = this.db.prepare('SELECT id FROM paths WHERE folder_path = :folder').get({ folder }) as { id: number };
    this.db.prepare(`INSERT INTO photos (path_id, file_name, file_size, modified_at, is_hdr)
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
    return this.getPhoto(sourceName)!;
  };

  private readonly ensureLocationName = async (photo: Pick<PhotoRow, 'id' | 'latitude' | 'longitude' | 'location_name_id'>, retryUnknown = false, throwOnError = false): Promise<string | null> => {
    if ((photo.location_name_id !== null && !(retryUnknown && photo.location_name_id === 0)) || photo.latitude === null || photo.longitude === null
      || !Number.isFinite(photo.latitude) || !Number.isFinite(photo.longitude)
      || photo.latitude < -90 || photo.latitude > 90 || photo.longitude < -180 || photo.longitude > 180) return null;

    const pending = this.pendingLocationLookups.get(photo.id);
    if (pending) return pending;

    const operation = (async (): Promise<string | null> => {
      let locationNameId: number | null = null;
      let displayName: string | null = null;
      try {
        const location = await lookupReverseGeocoding(photo.latitude!, photo.longitude!, 'en');
        if (location) {
          displayName = location.displayName;
          this.db.prepare(`INSERT OR IGNORE INTO location_names
            (latitude, longitude, place_name, country_code, region, locality, provider, updated_at)
            VALUES (:latitude, :longitude, :placeName, :countryCode, :region, :locality, 'nominatim', :updatedAt)`)
            .run({
              latitude: photo.latitude,
              longitude: photo.longitude,
              placeName: location.placeName,
              countryCode: location.countryCode,
              region: location.region,
              locality: location.locality,
              updatedAt: Date.now()
            });
          const saved = this.db.prepare(`SELECT id FROM location_names
            WHERE latitude = :latitude AND longitude = :longitude AND provider = 'nominatim'`)
            .get({ latitude: photo.latitude, longitude: photo.longitude }) as { id: number } | undefined;
          if (saved) locationNameId = saved.id;
        }
      } catch (error) {
        console.error('[CacheManager] Reverse geocoding failed', {
          photoId: photo.id,
          latitude: photo.latitude,
          longitude: photo.longitude,
          error: error instanceof Error ? error.message : String(error)
        });
        if (throwOnError) throw error;
      }

      this.db.prepare('UPDATE photos SET location_name_id = :locationNameId WHERE id = :photoId AND (location_name_id IS NULL OR (:retryUnknown = 1 AND location_name_id = 0))')
        .run({ locationNameId, photoId: photo.id, retryUnknown: retryUnknown ? 1 : 0 });
      return displayName;
    })();

    this.pendingLocationLookups.set(photo.id, operation);
    try { return await operation; }
    finally { if (this.pendingLocationLookups.get(photo.id) === operation) this.pendingLocationLookups.delete(photo.id); }
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
    const column = kind === 'thumbnail' ? 'thumbnail' : 'fullsize';
    const allRows = this.db.prepare('SELECT photos.*, paths.folder_path FROM photos JOIN paths ON paths.id = photos.path_id WHERE photos.' + column + '_cache_id = :cacheId')
      .all({ cacheId: CACHE_STORAGE_TYPE.SIDECAR }) as unknown as Array<PhotoRow & { folder_path: string }>;
    const root = directory ? resolve(directory) : null;
    const rows = root === null ? allRows : allRows.filter(row => {
      const relativeFolder = relative(root, resolve(row.folder_path));
      if (relativeFolder === '') return true;
      return recursive && relativeFolder !== '..' && !relativeFolder.startsWith('..' + sep) && !isAbsolute(relativeFolder);
    });
    let bytes = 0;
    let existingEntries = 0;
    for (const row of rows) {
      const path = this.getSidecarPath(join(row.folder_path, row.file_name), kind === 'fullsize');
      try {
        const info = await stat(path);
        bytes += info.size;
        existingEntries++;
      } catch { /* Missing cache file. */ }
    }
    return { entries: existingEntries, bytes };
  };

  private readonly init = (): void => {
    this.db.exec(createMigrationTable);
    const migrations = this.db.prepare(getMigrationRecords).all() as Array<{ name: string }>;
    const insert = this.db.prepare(insertMigrationRecord);
    for (const migration of dbMigrations) {
      if (!migrations.some(item => item.name === migration.name)) {
        this.db.exec(migration.query);
        insert.run({ name: migration.name });
      }
    }
    if (!migrations.some(item => item.name === 'migrateLegacyCacheFilesToPhotosV8')) {
      this.migrateLegacyCacheFiles();
      insert.run({ name: 'migrateLegacyCacheFilesToPhotosV8' });
    }
    this.db.exec("DELETE FROM cache_storage_types WHERE name = 'central';");
    rm(this.legacyCacheDir, { recursive: true, force: true }).catch(() => undefined);
  };

  private readonly migrateLegacyCacheFiles = (): void => {
    const table = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cache_files'").get();
    if (!table) return;
    const rows = this.db.prepare('SELECT * FROM cache_files').all() as Array<Record<string, SQLOutputValue>>;
    const insertPath = this.db.prepare('INSERT OR IGNORE INTO paths (folder_path) VALUES (:folder)');
    const findPath = this.db.prepare('SELECT id FROM paths WHERE folder_path = :folder');
    const insertPhoto = this.db.prepare('INSERT OR IGNORE INTO photos (path_id, file_name, file_size, modified_at, is_hdr) VALUES (:pathId, :file, :size, :modified, :hdr)');
    const updatePhoto = this.db.prepare('UPDATE photos SET thumbnail_cache_id = CASE WHEN :full = 0 THEN :cacheId ELSE thumbnail_cache_id END, thumbnail_cache_version = CASE WHEN :full = 0 THEN :version ELSE thumbnail_cache_version END, fullsize_cache_id = CASE WHEN :full = 1 THEN :cacheId ELSE fullsize_cache_id END, fullsize_cache_version = CASE WHEN :full = 1 THEN :version ELSE fullsize_cache_version END WHERE path_id = :pathId AND file_name = :file');
    for (const row of rows) {
      const source = String(row.source_name ?? '');
      const storageId = Number(row.storage_type_id);
      if (!source || storageId === 1) continue;
      const folder = dirname(source);
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
    this.db.exec('DROP TABLE cache_files; DROP TABLE IF EXISTS cache_volume_settings;');
  };
}
