import { app, type IpcMainInvokeEvent } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { promisify } from 'node:util';
import { IpcHandler } from '../app/decorators/ipc-handler';
import { CacheClearResult, CacheImageStatus, CacheInfo, PhotoLocation } from 'internal-api';
import type { Exif } from '../exif/exif';
import { createMigrationTable, dbMigrations, getMigrationRecords, insertMigrationRecord } from './cache-manager.migration';

const execFileAsync = promisify(execFile);
const CACHE_STORAGE_TYPE = { SIDECAR: 2, PARALLEL: 3 } as const;
const FULL_SIZE_EXTENSIONS = new Set([ '.jxr', '.avif', '.heif', '.heic', '.exr', '.hdr', '.tif', '.tiff' ]);

interface PhotoRow {
  id: number;
  path_id: number;
  file_name: string;
  file_size: number;
  modified_at: number;
  is_hdr: number;
  thumbnail_cache_id: number | null;
  thumbnail_cache_version: string | null;
  fullsize_cache_id: number | null;
  fullsize_cache_version: string | null;
  latitude: number | null;
  longitude: number | null;
}

export class CacheManager {
  private readonly userData = app.getPath('userData');
  private readonly cacheConfigFile = join(this.userData, 'cache.sqlite');
  private readonly legacyCacheDir = join(this.userData, 'image-cache');
  private readonly db: DatabaseSync;
  private readonly pendingEntries = new Map<string, Promise<string | null>>();
  private readonly deletingSources = new Map<string, Promise<CacheClearResult>>();

  constructor() {
    mkdirSync(this.userData, { recursive: true });
    this.db = new DatabaseSync(this.cacheConfigFile);
    this.db.exec('PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;');
    this.init();
  }

  @IpcHandler({ name: 'CacheManager.clear' })
  readonly clear = async (): Promise<CacheClearResult> => {
    const [thumbnails, fullSize] = await Promise.all([this.clearThumbnails(), this.clearFullSize()]);
    return { entries: thumbnails.entries + fullSize.entries, bytes: thumbnails.bytes + fullSize.bytes };
  };

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
  readonly clearFullSize = async (): Promise<CacheClearResult> => this.clearKind('fullsize');

  @IpcHandler({ name: 'CacheManager.clearThumbnails' })
  readonly clearThumbnails = async (): Promise<CacheClearResult> => this.clearKind('thumbnail');

  private readonly clearKind = async (kind: 'thumbnail' | 'fullsize'): Promise<CacheClearResult> => {
    const column = kind === 'thumbnail' ? 'thumbnail' : 'fullsize';
    const rows = this.db.prepare('SELECT photos.*, paths.folder_path FROM photos JOIN paths ON paths.id = photos.path_id WHERE photos.' + column + '_cache_id = :cacheId')
      .all({ cacheId: CACHE_STORAGE_TYPE.SIDECAR }) as unknown as Array<PhotoRow & { folder_path: string }>;
    let bytes = 0;
    for (const row of rows) {
      const source = join(row.folder_path, row.file_name);
      const target = this.getSidecarPath(source, kind === 'fullsize');
      try { bytes += (await stat(target)).size; await rm(target, { force: true }); } catch { /* Missing cache file. */ }
      this.db.prepare('UPDATE photos SET ' + column + '_cache_id = NULL, ' + column + '_cache_version = NULL WHERE id = :id').run({ id: row.id });
    }
    return { entries: rows.length, bytes };
  };

  @IpcHandler({ name: 'CacheManager.cacheInfo' })
  readonly cacheInfo = async (): Promise<CacheInfo> => {
    const thumbnails = await this.getKindStats('thumbnail');
    const fullSize = await this.getKindStats('fullsize');
    return { entries: thumbnails.entries + fullSize.entries, bytes: thumbnails.bytes + fullSize.bytes, thumbnails, fullSize };
  };

  @IpcHandler({ name: 'CacheManager.cacheSize' })
  readonly cacheSize = async (): Promise<number> => (await this.cacheInfo()).bytes;

  @IpcHandler({ name: 'CacheManager.getImageCacheStatuses' })
  readonly getImageCacheStatuses = async (_event: IpcMainInvokeEvent, sourceNames: string[]): Promise<CacheImageStatus[]> => {
    if (!Array.isArray(sourceNames) || sourceNames.length > 10000 || sourceNames.some(path => typeof path !== 'string' || !path.trim())) {
      throw new Error('A list of valid image paths is required.');
    }

    // Gallery detail columns are read from SQLite only; folder changes must not trigger filesystem checks.
    const findPhoto = this.db.prepare(`SELECT photos.* FROM photos
      JOIN paths ON paths.id = photos.path_id
      WHERE paths.folder_path = :folder AND photos.file_name = :file COLLATE NOCASE`);

    return [...new Set(sourceNames)].map(sourceName => {
      const row = findPhoto.get({ folder: dirname(sourceName), file: basename(sourceName) }) as unknown as PhotoRow | undefined;
      const getStatus = (kind: 'thumbnail' | 'fullsize') => {
        if (!row) return null;
        const id = kind === 'thumbnail' ? row.thumbnail_cache_id : row.fullsize_cache_id;
        const version = kind === 'thumbnail' ? row.thumbnail_cache_version : row.fullsize_cache_version;
        if (id === null || !version) return null;
        const parallel = id === CACHE_STORAGE_TYPE.PARALLEL && kind === 'fullsize';
        return {
          status: 'valid' as const,
          path: parallel ? this.getParallelPath(sourceName) : this.getSidecarPath(sourceName, kind === 'fullsize'),
          storageType: parallel ? 'parallel' as const : 'sidecar' as const,
          sourceTag: version
        };
      };

      return {
        sourceName,
        thumbnail: getStatus('thumbnail'),
        fullSize: getStatus('fullsize'),
        fullSizeRequired: FULL_SIZE_EXTENSIONS.has(extname(sourceName).toLowerCase()),
        latitude: row?.latitude ?? null,
        longitude: row?.longitude ?? null
      };
    });
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
  };

  readonly usesSidecarStorage = (_sourceName: string): boolean => true;

  readonly exists = (sourceName: string, sourceTag: string): Record<string, SQLOutputValue> | null => {
    const row = this.getPhoto(sourceName);
    if (!row) return null;
    const full = sourceTag.includes('-full-');
    const cacheId = full ? row.fullsize_cache_id : row.thumbnail_cache_id;
    const version = full ? row.fullsize_cache_version : row.thumbnail_cache_version;
    if (cacheId === null || version !== sourceTag) return null;
    return {
      storage_type_id: cacheId,
      source_size: row.file_size,
      updated_at: row.modified_at,
      target_path: cacheId === CACHE_STORAGE_TYPE.PARALLEL && full ? this.getParallelPath(sourceName) : this.getSidecarPath(sourceName, full)
    };
  };

  readonly forgetParallel = (sourceName: string, sourceTag: string): void => {
    const row = this.getPhoto(sourceName);
    if (row?.fullsize_cache_id === CACHE_STORAGE_TYPE.PARALLEL && row.fullsize_cache_version === sourceTag) {
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
        .run({ cacheId: CACHE_STORAGE_TYPE.PARALLEL, version: sourceTag, id: row.id });
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
    const parallelPath = this.getParallelPath(sourceName);
    if (full && existsSync(parallelPath)) {
      await this.registerParallel(sourceName, sourceTag, parallelPath);
      return parallelPath;
    }
    const targetPath = this.getSidecarPath(sourceName, full);
    const cacheId = full ? previous?.fullsize_cache_id : previous?.thumbnail_cache_id;
    const cacheVersion = full ? previous?.fullsize_cache_version : previous?.thumbnail_cache_version;
    const sourceChanged = previous !== null && (previousSize !== sourceStats.size || previousModified !== sourceStats.mtimeMs);
    if (sourceChanged || (cacheVersion && cacheVersion !== sourceTag)) await rm(targetPath, { force: true });
    if (!sourceChanged && cacheId === CACHE_STORAGE_TYPE.SIDECAR && cacheVersion === sourceTag && existsSync(targetPath)) return targetPath;
    await this.ensureCacheDirectory(dirname(targetPath));
    if (!existsSync(targetPath)) {
      const generated = callback ? await callback(targetPath) : (await copyFile(sourceName, targetPath), true);
      if (!generated) return null;
    }
    this.db.prepare('UPDATE photos SET ' + (full ? 'fullsize' : 'thumbnail') + '_cache_id = :cacheId, ' +
      (full ? 'fullsize' : 'thumbnail') + '_cache_version = :version WHERE id = :id')
      .run({ cacheId: CACHE_STORAGE_TYPE.SIDECAR, version: sourceTag, id: row.id });
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
        coordinate_source_id = CASE WHEN photos.file_size != excluded.file_size OR photos.modified_at != excluded.modified_at THEN NULL ELSE photos.coordinate_source_id END,
        file_size = excluded.file_size,
        modified_at = excluded.modified_at`)
      .run({ pathId: path.id, file: basename(sourceName), size, modified });
    return this.getPhoto(sourceName)!;
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

  private readonly getKindStats = async (kind: 'thumbnail' | 'fullsize'): Promise<CacheClearResult> => {
    const column = kind === 'thumbnail' ? 'thumbnail' : 'fullsize';
    const rows = this.db.prepare('SELECT photos.*, paths.folder_path FROM photos JOIN paths ON paths.id = photos.path_id WHERE photos.' + column + '_cache_id = :cacheId')
      .all({ cacheId: CACHE_STORAGE_TYPE.SIDECAR }) as unknown as Array<PhotoRow & { folder_path: string }>;
    let bytes = 0;
    for (const row of rows) {
      const path = this.getSidecarPath(join(row.folder_path, row.file_name), kind === 'fullsize');
      try { bytes += (await stat(path)).size; } catch { /* Missing cache file. */ }
    }
    return { entries: rows.length, bytes };
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
      updatePhoto.run({ full: full ? 1 : 0, cacheId: storageId, version: tag, pathId: path.id, file });
    }
    this.db.exec('DROP TABLE cache_files; DROP TABLE IF EXISTS cache_volume_settings;');
  };
}
