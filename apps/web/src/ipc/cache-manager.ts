import { Injectable, signal } from '@angular/core';
import { CacheClearResult, CacheDirectoryStats, CacheImageStatus, CacheInfo, DesktopCacheManager, PhotoLocation } from 'internal-api';

@Injectable({ providedIn: 'root' })
export class CacheManager implements DesktopCacheManager {
  readonly cacheRevision = signal(0);

  readonly clear = async (): Promise<CacheClearResult> => {
    const result = await window.desktop.CacheManager.clear();
    this.cacheRevision.update(value => value + 1);
    return result;
  };

  readonly clearFullSize = async (): Promise<CacheClearResult> => {
    const result = await window.desktop.CacheManager.clearFullSize();
    this.cacheRevision.update(value => value + 1);
    return result;
  };

  readonly clearThumbnails = async (): Promise<CacheClearResult> => {
    const result = await window.desktop.CacheManager.clearThumbnails();
    this.cacheRevision.update(value => value + 1);
    return result;
  };

  readonly deleteImage = async (sourceName: string): Promise<CacheClearResult> => {
    const result = await window.desktop.CacheManager.deleteImage(sourceName);
    this.cacheRevision.update(value => value + 1);
    return result;
  };

  readonly cacheSize = () => window.desktop.CacheManager.cacheSize();

  readonly cacheInfo = (): Promise<CacheInfo> => window.desktop.CacheManager.cacheInfo();

  readonly imageCachePath = (sourceName: string): Promise<string | null> =>
    window.desktop.CacheManager.imageCachePath(sourceName);

  readonly getImageCacheStatuses = (sourceNames: string[], verifyCacheFiles = false, sourceMetadata: Array<{ path: string; size: number; modifiedAt: number }> = []): Promise<CacheImageStatus[]> =>
    window.desktop.CacheManager.getImageCacheStatuses(sourceNames, verifyCacheFiles, sourceMetadata);

  readonly getBuildLogPath = (): Promise<string> => window.desktop.CacheManager.getBuildLogPath();

  readonly resetBuildLog = (): Promise<void> => window.desktop.CacheManager.resetBuildLog();

  readonly appendBuildLog = (line: string): Promise<void> => window.desktop.CacheManager.appendBuildLog(line);

  readonly getDirectoryCacheStats = (sourceNames: string[]): Promise<CacheDirectoryStats> =>
    window.desktop.CacheManager.getDirectoryCacheStats(sourceNames);

  readonly getDirectoryPhotoLocations = (directory: string): Promise<PhotoLocation[]> =>
    window.desktop.CacheManager.getDirectoryPhotoLocations(directory);

}
