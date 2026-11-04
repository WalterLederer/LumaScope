import { Injectable, signal } from '@angular/core';
import { CacheClearResult, CacheDirectoryStats, CacheImageStatus, CacheInfo, CacheSummary, DesktopCacheManager, PhotoLocation, PhotoDatabaseRecord } from 'internal-api';

@Injectable({ providedIn: 'root' })
export class CacheManager implements DesktopCacheManager {
  readonly cacheRevision = signal(0);

  readonly clear = async (directory?: string, recursive = false, operationId?: string): Promise<CacheClearResult> => {
    const result = await window.desktop.CacheManager.clear(directory, recursive, operationId);
    this.cacheRevision.update(value => value + 1);
    return result;
  };

  readonly clearFullSize = async (directory?: string, recursive = false, operationId?: string): Promise<CacheClearResult> => {
    const result = await window.desktop.CacheManager.clearFullSize(directory, recursive, operationId);
    this.cacheRevision.update(value => value + 1);
    return result;
  };

  readonly clearThumbnails = async (directory?: string, recursive = false, operationId?: string): Promise<CacheClearResult> => {
    const result = await window.desktop.CacheManager.clearThumbnails(directory, recursive, operationId);
    this.cacheRevision.update(value => value + 1);
    return result;
  };

  readonly cancelClear = (operationId: string): Promise<boolean> => window.desktop.CacheManager.cancelClear(operationId);

  readonly deleteImage = async (sourceName: string): Promise<CacheClearResult> => {
    const result = await window.desktop.CacheManager.deleteImage(sourceName);
    this.cacheRevision.update(value => value + 1);
    return result;
  };

  readonly cacheSize = () => window.desktop.CacheManager.cacheSize();

  readonly getCacheSummary = (): Promise<CacheSummary> => window.desktop.CacheManager.getCacheSummary();\n\n  readonly resolveMissingLocationNames = (directory: string, recursive = false) =>\n    window.desktop.CacheManager.resolveMissingLocationNames(directory, recursive);

  readonly cacheInfo = (directory?: string, recursive = false): Promise<CacheInfo> => window.desktop.CacheManager.cacheInfo(directory, recursive);

  readonly imageCachePath = (sourceName: string): Promise<string | null> =>
    window.desktop.CacheManager.imageCachePath(sourceName);

  readonly getImageCacheStatuses = (sourceNames: string[], verifyCacheFiles = false, sourceMetadata: Array<{ path: string; size: number; modifiedAt: number }> = []): Promise<CacheImageStatus[]> =>
    window.desktop.CacheManager.getImageCacheStatuses(sourceNames, verifyCacheFiles, sourceMetadata);

  readonly getBuildLogPath = (): Promise<string> => window.desktop.CacheManager.getBuildLogPath();

  readonly resetBuildLog = (): Promise<void> => window.desktop.CacheManager.resetBuildLog();

  readonly appendBuildLog = (line: string): Promise<void> => window.desktop.CacheManager.appendBuildLog(line);

  readonly getDirectoryCacheStats = (sourceNames: string[], verifyCacheFiles = false): Promise<CacheDirectoryStats> =>
    window.desktop.CacheManager.getDirectoryCacheStats(sourceNames, verifyCacheFiles);

  readonly getDirectoryPhotoLocations = (directory: string): Promise<PhotoLocation[]> =>
    window.desktop.CacheManager.getDirectoryPhotoLocations(directory);

  readonly getPhotoDatabaseRecord = (sourceName: string): Promise<PhotoDatabaseRecord | null> =>
    window.desktop.CacheManager.getPhotoDatabaseRecord(sourceName);

}
