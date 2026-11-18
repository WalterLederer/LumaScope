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

  readonly getCacheSummary = (databaseKey?: string): Promise<CacheSummary> => window.desktop.CacheManager.getCacheSummary(databaseKey);

  readonly importGpxFolder = () => window.desktop.CacheManager.importGpxFolder();

  readonly importGpxFiles = (filePaths: string[]) => window.desktop.CacheManager.importGpxFiles(filePaths);

  readonly exportGpxFileFromDatabase = (sourcePath: string, databaseKey?: string) =>
    window.desktop.CacheManager.exportGpxFileFromDatabase(sourcePath, databaseKey);

  readonly getGpxDatabaseStats = (databaseKey?: string) => window.desktop.CacheManager.getGpxDatabaseStats(databaseKey);

  readonly clearAllGpxDatabaseEntries = () => window.desktop.CacheManager.clearAllGpxDatabaseEntries();

  readonly deleteGpxDatabaseEntriesForFile = (sourcePath: string, databaseKey?: string) => window.desktop.CacheManager.deleteGpxDatabaseEntriesForFile(sourcePath, databaseKey);

  readonly getGpxDatabaseTimeRange = (databaseKey?: string) => window.desktop.CacheManager.getGpxDatabaseTimeRange(databaseKey);

  readonly getLatestGpxElevationProfile = (sourcePath?: string) => window.desktop.CacheManager.getLatestGpxElevationProfile(sourcePath);

  readonly getGpxFilesInBounds = (bounds: { west: number; south: number; east: number; north: number }, databaseKey?: string) => window.desktop.CacheManager.getGpxFilesInBounds(bounds, databaseKey);

  readonly getInterpolatedGpxPosition = (folder: string, timestampMs: number, maxDifferenceSeconds = 120, databaseKey?: string) =>
    window.desktop.CacheManager.getInterpolatedGpxPosition(folder, timestampMs, maxDifferenceSeconds, databaseKey);

  readonly getOsmAndTileCacheSummary = () => window.desktop.CacheManager.getOsmAndTileCacheSummary();

  readonly clearOsmAndTileCache = (): Promise<CacheClearResult> =>
    window.desktop.CacheManager.clearOsmAndTileCache();

  readonly resolveMissingLocationNames = (directory: string, recursive = false) =>
    window.desktop.CacheManager.resolveMissingLocationNames(directory, recursive);

  readonly cancelResolveMissingLocationNames = () =>
    window.desktop.CacheManager.cancelResolveMissingLocationNames();

  readonly pauseBackgroundReverseGeocoding = () =>
    window.desktop.CacheManager.pauseBackgroundReverseGeocoding();

  readonly resumeBackgroundReverseGeocoding = () =>
    window.desktop.CacheManager.resumeBackgroundReverseGeocoding();

  readonly abortBackgroundReverseGeocoding = () =>
    window.desktop.CacheManager.abortBackgroundReverseGeocoding();

  readonly getBackgroundReverseGeocodingStatus = () =>
    window.desktop.CacheManager.getBackgroundReverseGeocodingStatus();

  readonly onBackgroundReverseGeocodingStatusChanged = (callback: () => void): (() => void) =>
    window.desktop.CacheManager.onBackgroundReverseGeocodingStatusChanged(callback);

  readonly onDirectoryPhotoLocationsChanged = (callback: (directory: string) => void): (() => void) =>
    window.desktop.CacheManager.onDirectoryPhotoLocationsChanged(callback);

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

  readonly selectDatabaseForDirectory = (directory: string): Promise<boolean> =>
    window.desktop.CacheManager.selectDatabaseForDirectory(directory);

  readonly getDirectoryPhotoLocations = (directory: string): Promise<PhotoLocation[]> =>
    window.desktop.CacheManager.getDirectoryPhotoLocations(directory);

  readonly getPhotoLocationsInBounds = (bounds: { west: number; south: number; east: number; north: number }, databaseKey: string): Promise<PhotoLocation[]> =>
    window.desktop.CacheManager.getPhotoLocationsInBounds(bounds, databaseKey);

  readonly getPhotoDatabaseRecord = (sourceName: string): Promise<PhotoDatabaseRecord | null> =>
    window.desktop.CacheManager.getPhotoDatabaseRecord(sourceName);

  readonly resolvePhotoLocation = (sourceName: string, latitude: number, longitude: number): Promise<string | null> =>
    window.desktop.CacheManager.resolvePhotoLocation(sourceName, latitude, longitude);

}
