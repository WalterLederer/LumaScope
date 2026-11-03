import { app, shell, type IpcMainInvokeEvent } from 'electron';
import { execFile } from 'node:child_process';
import { nanoid } from 'nanoid/non-secure';
import { existsSync, mkdirSync } from 'node:fs';
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { promisify } from 'node:util';
import { IpcHandler } from '../app/decorators/ipc-handler';
import { CacheCategoryInfo, CacheClearResult, CacheImageStatus, CacheInfo } from 'internal-api';
import {
  clearCacheRecords,
  createMigrationTable,
  dbMigrations,
  deleteCacheFile,
  findCacheFiles,
  findCacheFilesForSource,
  findFullSizeCacheFiles,
  findCacheFile,
  findThumbnailCacheFiles,
  getMigrationRecords,
  insertCacheFile,
  insertMigrationRecord
} from './cache-manager.migration';

const execFileAsync = promisify(execFile);

const CACHE_STORAGE_TYPE = { CENTRAL: 1, SIDECAR: 2, PARALLEL: 3 } as const;

interface CacheFileEntry {
  source_name: string;
  source_tag: string;
  target_path: string;
  storage_type_id: number;
}

export class CacheManager {
  private readonly userData = app.getPath('userData');

  private readonly cacheConfigFile = join(this.userData, 'cache.sqlite');

  private readonly cacheDir = join(this.userData, 'image-cache');

  private readonly db: DatabaseSync;

  private readonly pendingEntries = new Map<string, Promise<string | null>>();

  private readonly deletingSources = new Map<string, Promise<CacheClearResult>>();

  private readonly sidecarVolumes = new Set<string>();

  private readonly volumeChanges = new Map<string, Promise<void>>();

  constructor() {
    // SQLite does not create its parent directory, unlike the image cache below.
    mkdirSync(this.userData, { recursive: true });
    this.db = new DatabaseSync(this.cacheConfigFile);
    // Wait briefly for another process or a transient filesystem lock instead
    // of failing application startup immediately.
    this.db.exec('PRAGMA busy_timeout = 10000;');
    this.init();
    for (const row of this.db.prepare('SELECT volume_root FROM cache_volume_settings WHERE sidecar_enabled = 1').all() as Array<{ volume_root: string }>) {
      this.sidecarVolumes.add(row.volume_root.toLowerCase());
    }
  }

  @IpcHandler({ name: 'CacheManager.getSidecarVolumes' })
  readonly getSidecarVolumes = async (): Promise<string[]> => [...this.sidecarVolumes].sort();

  @IpcHandler({ name: 'CacheManager.setSidecarVolumeEnabled' })
  readonly setSidecarVolumeEnabled = async (_event: IpcMainInvokeEvent, volumeRoot: string, enabled: boolean): Promise<string[]> => {
    if (typeof volumeRoot !== 'string' || !isAbsolute(volumeRoot) || parse(volumeRoot).root.toLowerCase() !== volumeRoot.toLowerCase()) {
      throw new Error('A volume root such as D:\\ is required.');
    }
    if (typeof enabled !== 'boolean') throw new Error('A boolean sidecar setting is required.');
    const normalizedRoot = volumeRoot.toLowerCase();
    const change = this.applySidecarVolumeSetting(normalizedRoot, enabled);
    this.volumeChanges.set(normalizedRoot, change);
    try {
      await change;
    } finally {
      if (this.volumeChanges.get(normalizedRoot) === change) {
        this.volumeChanges.delete(normalizedRoot);
      }
    }
    return [...this.sidecarVolumes].sort();
  };

  private readonly applySidecarVolumeSetting = async (volumeRoot: string, enabled: boolean): Promise<void> => {
    const alreadyEnabled = this.sidecarVolumes.has(volumeRoot);
    if (enabled === alreadyEnabled) return;

    const pending = [...this.pendingEntries.entries()]
      .filter(([key]) => {
        try {
          const sourceName = JSON.parse(key)[0] as string;
          return parse(sourceName).root.toLowerCase() === volumeRoot;
        } catch {
          return false;
        }
      })
      .map(([, operation]) => operation);
    await Promise.all(pending);

    if (enabled) {
      // Remove all central cache entries for this drive before switching it to sidecar storage.
      const centralEntries = (this.db.prepare(findCacheFiles).all() as unknown as CacheFileEntry[])
        .filter(entry => entry.storage_type_id === CACHE_STORAGE_TYPE.CENTRAL
          && parse(entry.source_name).root.toLowerCase() === volumeRoot);
      await this.clearEntries(centralEntries);
      this.db.prepare('INSERT INTO cache_volume_settings (volume_root, sidecar_enabled) VALUES (:root, 1) ON CONFLICT(volume_root) DO UPDATE SET sidecar_enabled = 1').run({ root: volumeRoot });
      this.sidecarVolumes.add(volumeRoot);
    } else {
      this.db.prepare('DELETE FROM cache_volume_settings WHERE volume_root = :root').run({ root: volumeRoot });
      this.sidecarVolumes.delete(volumeRoot);
    }
  };

  @IpcHandler({ name: 'CacheManager.clear' })
  readonly clear = async (): Promise<CacheClearResult> => {
    const result = await this.getDirStats(this.cacheDir);
    this.db.exec(clearCacheRecords);
    await rm(this.cacheDir, { recursive: true, force: true });
    return result;
  };

  @IpcHandler({ name: 'CacheManager.deleteImage' })
  readonly deleteImage = async (_event: IpcMainInvokeEvent, sourceName: string): Promise<CacheClearResult> => {
    if (typeof sourceName !== 'string' || sourceName.trim().length === 0) {
      throw new Error('A valid source image path is required.');
    }

    const existing = this.deletingSources.get(sourceName);
    if (existing) return existing;

    // Block new cache requests for this source while the existing operations
    // finish and all indexed variants are removed. Without this gate, a new
    // thumbnail/full-size request can recreate an entry during deletion.
    const operation = this.deleteImageEntries(sourceName);
    this.deletingSources.set(sourceName, operation);
    try {
      return await operation;
    } finally {
      if (this.deletingSources.get(sourceName) === operation) {
        this.deletingSources.delete(sourceName);
      }
    }
  };

  private readonly deleteImageEntries = async (sourceName: string): Promise<CacheClearResult> => {
    const pending = [ ...this.pendingEntries.entries() ]
      .filter(([ key ]) => {
        try { return JSON.parse(key)[0] === sourceName; }
        catch { return false; }
      })
      .map(([, operation]) => operation);
    await Promise.all(pending);

    const entries = this.db.prepare(findCacheFilesForSource).all({ sourceName }) as unknown as CacheFileEntry[];
    return this.clearEntries(entries);
  };

  @IpcHandler({ name: 'CacheManager.clearFullSize' })
  readonly clearFullSize = async (): Promise<CacheClearResult> =>
    this.clearEntries(this.db.prepare(findFullSizeCacheFiles).all() as unknown as CacheFileEntry[]);

  @IpcHandler({ name: 'CacheManager.clearThumbnails' })
  readonly clearThumbnails = async (): Promise<CacheClearResult> =>
    this.clearEntries(this.db.prepare(findThumbnailCacheFiles).all() as unknown as CacheFileEntry[]);

  private readonly clearEntries = async (entries: CacheFileEntry[]): Promise<CacheClearResult> => {
    const deleteEntry = this.db.prepare(deleteCacheFile);
    let removedBytes = 0;

    for (const entry of entries) {
      if (entry.storage_type_id === CACHE_STORAGE_TYPE.PARALLEL) {
        // Parallel-folder images are external source files; only forget the reference.
        deleteEntry.run({ sourceName: entry.source_name, sourceTag: entry.source_tag });
        continue;
      }

      const targetPath = resolve(entry.target_path);
      const storageDirectories = entry.storage_type_id === CACHE_STORAGE_TYPE.SIDECAR
        ? entry.source_tag.includes('-full-')
          ? [ join(dirname(entry.source_name), '.cache') ]
          // Accept legacy thumbnail entries stored in .cache as well as the new .thumbnails folder.
          : [ join(dirname(entry.source_name), '.thumbnails'), join(dirname(entry.source_name), '.cache') ]
        : [ this.cacheDir ];
      const isSafePath = storageDirectories.some(directory => {
        const relativePath = relative(directory, targetPath);
        return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath);
      });

      if (!isSafePath) {
        throw new Error(`Refusing to remove cache file outside its storage directory: ${entry.target_path}`);
      }

      try {
        removedBytes += (await stat(targetPath)).size;
      } catch {
        // The file may already have been removed; still clear its database record.
      }

      await rm(targetPath, { force: true });
      deleteEntry.run({ sourceName: entry.source_name, sourceTag: entry.source_tag });
    }

    return { entries: entries.length, bytes: removedBytes };
  };

  readonly forgetParallel = (sourceName: string, sourceTag: string): void => {
    const existing = this.exists(sourceName, sourceTag);
    if (existing?.['storage_type_id'] === CACHE_STORAGE_TYPE.PARALLEL) {
      this.db.prepare(deleteCacheFile).run({ sourceName, sourceTag });
    }
  };

  readonly registerParallel = async (sourceName: string, sourceTag: string, targetPath: string): Promise<string | null> => {
    const convertibleExtensions = new Set([ '.jxr', '.avif', '.heif', '.heic', '.exr', '.hdr', '.tif', '.tiff', '.jxl', '.png' ]);
    if (!convertibleExtensions.has(extname(sourceName).toLowerCase()) || !isAbsolute(targetPath) || extname(targetPath).toLowerCase() !== '.jpg') {
      return null;
    }

    try {
      const [sourceStats, targetStats] = await Promise.all([stat(sourceName), stat(targetPath)]);
      if (!targetStats.isFile()) return null;

      const existing = this.exists(sourceName, sourceTag);
      if (existing && existing['storage_type_id'] === CACHE_STORAGE_TYPE.PARALLEL && existing['target_path'] === targetPath
        && existing['source_size'] === sourceStats.size && existing['updated_at'] === sourceStats.mtimeMs) {
        return targetPath;
      }

      if (existing) {
        await this.clearEntries([{
          source_name: sourceName,
          source_tag: sourceTag,
          target_path: String(existing['target_path']),
          storage_type_id: Number(existing['storage_type_id'])
        }]);
      }

      return this.addEntry(sourceName, sourceTag, sourceStats.size, sourceStats.mtimeMs, targetPath, CACHE_STORAGE_TYPE.PARALLEL);
    } catch {
      return null;
    }
  };

  @IpcHandler({ name: 'CacheManager.cacheSize' })
  readonly cacheSize = async (): Promise<number> => this.getDirSize(this.cacheDir);

  @IpcHandler({ name: 'CacheManager.cacheInfo' })
  readonly cacheInfo = async (): Promise<CacheInfo> => {
    const entries = this.db.prepare(findCacheFiles).all() as unknown as CacheFileEntry[];
    const fullSizeEntries = entries.filter(entry => entry.source_tag.includes('-full-'));
    const thumbnailEntries = entries.filter(entry => !entry.source_tag.includes('-full-'));
    const [ central, sidecar, fullSize, thumbnails ] = await Promise.all([
      this.getEntryStats(entries.filter(entry => entry.storage_type_id === CACHE_STORAGE_TYPE.CENTRAL)),
      this.getEntryStats(entries.filter(entry => entry.storage_type_id === CACHE_STORAGE_TYPE.SIDECAR)),
      this.getCategoryStats(fullSizeEntries),
      this.getCategoryStats(thumbnailEntries)
    ]);
    return {
      path: this.cacheDir,
      entries: central.entries + sidecar.entries,
      bytes: central.bytes + sidecar.bytes,
      central,
      sidecar,
      fullSize,
      thumbnails
    };
  };

  @IpcHandler({ name: 'CacheManager.getImageCacheStatuses' })
  readonly getImageCacheStatuses = async (_event: IpcMainInvokeEvent, sourceNames: string[]): Promise<CacheImageStatus[]> => {
    if (!Array.isArray(sourceNames) || sourceNames.length > 10000 || sourceNames.some(path => typeof path !== 'string' || path.trim().length === 0)) {
      throw new Error('A list of valid image paths is required.');
    }

    const query = this.db.prepare(findCacheFilesForSource);
    const storageTypeQuery = this.db.prepare('SELECT name FROM cache_storage_types WHERE id = :id');
    const fullSizeExtensions = new Set([ '.jxr', '.avif', '.heif', '.heic', '.exr', '.hdr', '.tif', '.tiff' ]);
    const uniquePaths = [...new Set(sourceNames)];
    return Promise.all(uniquePaths.map(async sourceName => {
      const extension = extname(sourceName).toLowerCase();
      if (fullSizeExtensions.has(extension)) {
        const isTiff = extension === '.tif' || extension === '.tiff';
        const sourceTag = `${extension.slice(1)}-full-${isTiff ? 'hdr-v6' : extension === '.exr' ? 'uhdr-v2' : 'uhdr'}`;
        const parallelJpg = join(dirname(dirname(sourceName)), 'jpg', `${basename(sourceName, extname(sourceName))}.jpg`);
        if (existsSync(parallelJpg)) {
          await this.registerParallel(sourceName, sourceTag, parallelJpg);
        } else {
          this.forgetParallel(sourceName, sourceTag);
        }
      }

      const entries = query.all({ sourceName }) as unknown as CacheFileEntry[];
      let sourceStats: Awaited<ReturnType<typeof stat>> | null = null;
      try { sourceStats = await stat(sourceName); } catch { /* Keep the indexed entry visible as stale if the source is unavailable. */ }

      const toStatus = async (entry: CacheFileEntry | undefined) => {
        if (!entry) return null;
        let status: 'valid' | 'missing' | 'stale' = 'valid';
        if (!sourceStats) {
          status = 'stale';
        } else {
          const row = this.db.prepare(findCacheFile).get({ sourceName, sourceTag: entry.source_tag }) as Record<string, SQLOutputValue> | undefined;
          if (!row || row['source_size'] !== sourceStats.size || row['updated_at'] !== sourceStats.mtimeMs) {
            status = 'stale';
          } else {
            try {
              const targetStats = await stat(entry.target_path);
              if (!targetStats.isFile()) status = 'missing';
            } catch { status = 'missing'; }
          }
        }
        return {
          status,
          path: entry.target_path,
          storageType: (storageTypeQuery.get({ id: entry.storage_type_id }) as { name: 'central' | 'sidecar' | 'parallel' } | undefined)?.name ?? 'central',
          sourceTag: entry.source_tag
        };
      };

      return {
        sourceName,
        thumbnail: await toStatus(entries.find(entry => !entry.source_tag.includes('-full-'))),
        fullSize: await toStatus(entries.find(entry => entry.source_tag.includes('-full-'))),
        fullSizeRequired: fullSizeExtensions.has(extname(sourceName).toLowerCase())
      };
    }));
  };

  @IpcHandler({ name: 'CacheManager.imageCachePath' })
  readonly imageCachePath = async (_event: IpcMainInvokeEvent, sourceName: string): Promise<string | null> => {
    const extension = extname(sourceName).toLowerCase();
    if (![ '.jxr', '.avif', '.heif', '.heic', '.exr', '.hdr', '.tif', '.tiff', '.jxl', '.png' ].includes(extension)) {
      return null;
    }

    const sourceTag = `${extension.slice(1)}${[ '.tif', '.tiff' ].includes(extension) ? '-full-hdr-v6' : extension === '.exr' ? '-full-uhdr-v2' : '-full-uhdr'}`;

    const entry = this.exists(sourceName, sourceTag);
    if (!entry || typeof entry['target_path'] !== 'string') {
      return null;
    }

    try {
      const [ sourceStats, cacheStats ] = await Promise.all([
        stat(sourceName),
        stat(entry['target_path'])
      ]);
      if (entry['source_size'] !== sourceStats.size || entry['updated_at'] !== sourceStats.mtimeMs || !cacheStats.isFile()) {
        return null;
      }
      return entry['target_path'];
    } catch {
      return null;
    }
  };

  @IpcHandler({ name: 'CacheManager.openCacheFolder' })
  readonly openCacheFolder = async (): Promise<string> => {
    await mkdir(this.cacheDir, { recursive: true });
    return shell.openPath(this.cacheDir);
  };

  readonly usesSidecarStorage = (sourceName: string): boolean =>
    this.sidecarVolumes.has(parse(sourceName).root.toLowerCase());

  readonly exists = (sourceName: string, sourceTag: string): Record<string, SQLOutputValue> | null => {
    const row = this.db.prepare(findCacheFile).get({ sourceName, sourceTag });
    return row ? row : null;
  };

  readonly get = async (
    sourceName: string,
    sourceTag: string,
    callback?: (cachePath: string) => Promise<boolean>,
    targetExtension = extname(sourceName)
  ): Promise<string | null> => {
    const volumeChange = this.volumeChanges.get(parse(sourceName).root.toLowerCase());
    if (volumeChange) {
      await volumeChange;
      return this.get(sourceName, sourceTag, callback, targetExtension);
    }

    const deletion = this.deletingSources.get(sourceName);
    if (deletion) {
      await deletion;
      return this.get(sourceName, sourceTag, callback, targetExtension);
    }

    const key = JSON.stringify([ sourceName, sourceTag ]);
    const pending = this.pendingEntries.get(key);

    if (pending !== undefined) {
      return await pending;
    }

    const operation = this.getOrCreate(sourceName, sourceTag, callback, targetExtension);
    this.pendingEntries.set(key, operation);

    try {
      return await operation;
    } finally {
      if (this.pendingEntries.get(key) === operation) {
        this.pendingEntries.delete(key);
      }
    }
  };

  private readonly getOrCreate = async (
    sourceName: string,
    sourceTag: string,
    callback?: (cachePath: string) => Promise<boolean>,
    targetExtension = extname(sourceName)
  ): Promise<string | null> => {
    const stats = await stat(sourceName);
    const sourceSize = stats.size;
    const updatedAt = stats.mtimeMs;

    const existing = this.exists(sourceName, sourceTag);
    const volumeRoot = parse(sourceName).root.toLowerCase();
    const useSidecar = this.sidecarVolumes.has(volumeRoot);
    const isFullSize = sourceTag.includes('-full-');
    const storageType = useSidecar ? CACHE_STORAGE_TYPE.SIDECAR : CACHE_STORAGE_TYPE.CENTRAL;
    const sourceExtension = extname(sourceName).slice(1).toLowerCase();
    const sourceBaseName = basename(sourceName, extname(sourceName));
    const sidecarPath = useSidecar
      ? join(
        dirname(sourceName),
        '.cache',
        isFullSize
          ? `${sourceBaseName}_${sourceExtension}.jpg`
          : `${sourceBaseName}_${sourceExtension}_thumb.jpg`
      )
      : null;
    const targetPath = sidecarPath ?? this.getCacheItemPath(this.generateCacheName(targetExtension));

    if (useSidecar && !isFullSize && sourceTag === 'sidecar-thumbnail-v2') {
      // Replace the legacy 384-pixel sidecar entry without deleting the file before regenerating it.
      const legacyEntries = this.db.prepare(findCacheFilesForSource).all({ sourceName }) as unknown as CacheFileEntry[];
      for (const entry of legacyEntries) {
        if (entry.storage_type_id === CACHE_STORAGE_TYPE.SIDECAR && entry.source_tag === 'sidecar-thumbnail-v1'
          && resolve(entry.target_path) === resolve(targetPath)) {
          this.db.prepare(deleteCacheFile).run({ sourceName, sourceTag: entry.source_tag });
        }
      }
    }

    if (existing && existing['storage_type_id'] === CACHE_STORAGE_TYPE.PARALLEL) {
      if (existing['source_size'] === sourceSize && existing['updated_at'] === updatedAt && existsSync(existing['target_path'] as string)) {
        return existing['target_path'] as string;
      }
      // The parallel file is external; invalidate only its database reference.
      this.db.prepare(deleteCacheFile).run({ sourceName, sourceTag });
    }

    if (
      existing &&
      existing['storage_type_id'] === storageType &&
      existing['source_size'] === sourceSize &&
      existing['updated_at'] === updatedAt &&
      existsSync(existing['target_path'] as string) &&
      (storageType !== CACHE_STORAGE_TYPE.SIDECAR || resolve(existing['target_path'] as string) === resolve(targetPath))
    ) {
      return existing['target_path'] as string;
    }

    // A changed source or storage preference invalidates the previous cache entry.
    // Only remove files from the exact storage directory recorded for that entry.
    if (existing && existing['storage_type_id'] !== CACHE_STORAGE_TYPE.PARALLEL) {
      const stalePath = resolve(existing['target_path'] as string);
      const storageDirectories = existing['storage_type_id'] === CACHE_STORAGE_TYPE.SIDECAR
        ? [ join(dirname(sourceName), '.cache'), join(dirname(sourceName), '.thumbnails') ]
        : [ this.cacheDir ];
      const isSafePath = storageDirectories.some(directory => {
        const relativePath = relative(directory, stalePath);
        return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath);
      });

      if (!isSafePath) {
        throw new Error(`Refusing to remove cache file outside its storage directory: ${existing['target_path']}`);
      }

      await rm(stalePath, { force: true });
      this.db.prepare(deleteCacheFile).run({ sourceName, sourceTag });
    }

    // Existing sidecar conversions can be adopted without decoding the original again.
    if (useSidecar && existsSync(targetPath)) {
      await this.ensureCacheDirectory(dirname(targetPath), true);
      return this.addEntry(sourceName, sourceTag, sourceSize, updatedAt, targetPath, storageType);
    }

    await this.ensureCacheDirectory(dirname(targetPath), useSidecar);

    if (callback) {
      const result = await callback(targetPath);
      return result
        ? this.addEntry(sourceName, sourceTag, sourceSize, updatedAt, targetPath, storageType)
        : null;
    }

    await copyFile(sourceName, targetPath);

    return this.addEntry(sourceName, sourceTag, sourceSize, updatedAt, targetPath, storageType);
  };

  private readonly ensureCacheDirectory = async (directory: string, hidden: boolean): Promise<void> => {
    await mkdir(directory, { recursive: true });
    if (hidden && process.platform === 'win32') {
      await execFileAsync('attrib', [ '+h', directory ]);
    }
  };

  private readonly init = () => {
    this.db.exec(createMigrationTable);
    const migrations = this.db.prepare(getMigrationRecords).all();
    const insert = this.db.prepare(insertMigrationRecord);

    dbMigrations.forEach(migration => {
      const found = migrations.find(m => m['name'] === migration.name);

      if (found === undefined) {
        this.db.exec(migration.query);
        insert.get({ name: migration.name });
      }
    });
  };

  private readonly generateCacheName = (ext: string): string => `${nanoid(32)}${ext}`;

  private readonly getCacheItemPath = (hash: string): string =>
    join(this.cacheDir, hash[0], hash.substring(0, 2), hash);

  private readonly addEntry = (
    sourceName: string,
    sourceTag: string,
    sourceSize: number,
    updatedAt: number,
    targetPath: string,
    storageType: number = CACHE_STORAGE_TYPE.CENTRAL
  ): string => {
    const ttl = Date.now();

    this.db.prepare(insertCacheFile).run({
      sourceName,
      sourceTag,
      sourceSize,
      updatedAt,
      targetPath,
      ttl,
      storageTypeId: storageType
    });

    return targetPath;
  };

  private readonly getDirSize = async (directory: string): Promise<number> => {
    let size = 0;

    try {
      const files = await readdir(directory, { withFileTypes: true });

      for (const file of files) {
        const filePath = join(directory, file.name);

        if (file.isDirectory()) {
          size += await this.getDirSize(filePath);
        } else if (file.isFile()) {
          size += (await stat(filePath)).size;
        }
      }
    } catch {
      return 0;
    }

    return size;
  };

  private readonly getCategoryStats = async (entries: CacheFileEntry[]): Promise<CacheCategoryInfo> => {
    const [ central, sidecar ] = await Promise.all([
      this.getEntryStats(entries.filter(entry => entry.storage_type_id === CACHE_STORAGE_TYPE.CENTRAL)),
      this.getEntryStats(entries.filter(entry => entry.storage_type_id === CACHE_STORAGE_TYPE.SIDECAR))
    ]);
    return {
      entries: central.entries + sidecar.entries,
      bytes: central.bytes + sidecar.bytes,
      central,
      sidecar
    };
  };

  private readonly getEntryStats = async (entries: CacheFileEntry[]): Promise<CacheClearResult> => {
    let bytes = 0;

    for (const entry of entries) {
      try {
        bytes += (await stat(entry.target_path)).size;
      } catch {
        // Stale cache records are ignored in the displayed totals.
      }
    }

    return { entries: entries.length, bytes };
  };

  private readonly getDirStats = async (directory: string): Promise<CacheClearResult> => {
    let entries = 0;
    let bytes = 0;

    try {
      const files = await readdir(directory, { withFileTypes: true });

      for (const file of files) {
        const filePath = join(directory, file.name);

        if (file.isDirectory()) {
          const child = await this.getDirStats(filePath);
          entries += child.entries;
          bytes += child.bytes;
        } else if (file.isFile()) {
          entries++;
          bytes += (await stat(filePath)).size;
        }
      }
    } catch {
      return { entries, bytes };
    }

    return { entries, bytes };
  };
}
