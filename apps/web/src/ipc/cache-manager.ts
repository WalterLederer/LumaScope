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

  readonly exportGpxTrackFromMemory = (trackName: string, segments: Array<Array<{ latitude: number; longitude: number; elevation: number | null; timestamp: string | null }>>) =>
    window.desktop.CacheManager.exportGpxTrackFromMemory(trackName, segments);

  readonly getGpxDatabaseStats = (databaseKey?: string) => window.desktop.CacheManager.getGpxDatabaseStats(databaseKey);

  readonly clearAllGpxDatabaseEntries = () => window.desktop.CacheManager.clearAllGpxDatabaseEntries();

  readonly deleteGpxDatabaseEntriesForFile = (sourcePath: string, databaseKey?: string) => window.desktop.CacheManager.deleteGpxDatabaseEntriesForFile(sourcePath, databaseKey);

  readonly getGpxDatabaseTimeRange = (databaseKey?: string) => window.desktop.CacheManager.getGpxDatabaseTimeRange(databaseKey);

  readonly getLatestGpxElevationProfile = (sourcePath?: string) => window.desktop.CacheManager.getLatestGpxElevationProfile(sourcePath);

  readonly getGpxFilesInBounds = (bounds: { west: number; south: number; east: number; north: number }, databaseKey?: string) => window.desktop.CacheManager.getGpxFilesInBounds(bounds, databaseKey);

  readonly getInterpolatedGpxPosition = (folder: string, timestampMs: number, maxDifferenceSeconds = 120, databaseKey?: string) =>
    window.desktop.CacheManager.getInterpolatedGpxPosition(folder, timestampMs, maxDifferenceSeconds, databaseKey);

  readonly getInterpolatedPhotoGpsPosition = (sourceName: string, timestampMs: number, databaseKey: string) =>
    window.desktop.CacheManager.getInterpolatedPhotoGpsPosition(sourceName, timestampMs, databaseKey);

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

  readonly registerGalleryFiles = (directory: string, files: import('internal-api').FileInfo[]): Promise<number> =>
    window.desktop.CacheManager.registerGalleryFiles(directory, files);

  readonly removeGalleryFile = async (sourceName: string): Promise<boolean> => {
    const removed = await window.desktop.CacheManager.removeGalleryFile(sourceName);
    if (removed) this.cacheRevision.update(value => value + 1);
    return removed;
  };

  readonly getGalleryFiles = (directory: string, recursive = false, includeUnsupported = false, sortBy: import('internal-api').SortType = 'name', sortDir: import('internal-api').SortDirection = 'asc') =>
    window.desktop.CacheManager.getGalleryFiles(directory, recursive, includeUnsupported, sortBy, sortDir);

  readonly getGalleryFilesPage = (directory: string, recursive = false, includeUnsupported = false, sortBy: import('internal-api').SortType = 'name', sortDir: import('internal-api').SortDirection = 'asc', offset = 0, limit = 250) =>
    window.desktop.CacheManager.getGalleryFilesPage(directory, recursive, includeUnsupported, sortBy, sortDir, offset, limit);

  readonly getGalleryFileAtPosition = (directory: string, recursive = false, includeUnsupported = false, sortBy: import('internal-api').SortType = 'name', sortDir: import('internal-api').SortDirection = 'asc', position = 1): Promise<FileInfo | null> =>
    window.desktop.CacheManager.getGalleryFileAtPosition(directory, recursive, includeUnsupported, sortBy, sortDir, position);

  readonly getGalleryFilePosition = (directory: string, sourcePath: string, recursive = false, includeUnsupported = false, sortBy: import('internal-api').SortType = 'name', sortDir: import('internal-api').SortDirection = 'asc'): Promise<number> =>
    window.desktop.CacheManager.getGalleryFilePosition(directory, sourcePath, recursive, includeUnsupported, sortBy, sortDir);

  readonly getGalleryUnsupportedSummary = (directory: string, recursive = false) =>
    window.desktop.CacheManager.getGalleryUnsupportedSummary(directory, recursive);

  readonly onGalleryFilesChanged = (callback: (directory: string) => void): (() => void) =>
    window.desktop.CacheManager.onGalleryFilesChanged(callback);

  readonly getDirectoryCacheStats = (sourceNames: string[], verifyCacheFiles = false): Promise<CacheDirectoryStats> =>
    window.desktop.CacheManager.getDirectoryCacheStats(sourceNames, verifyCacheFiles);

  readonly reconcilePhotoRecords = (directory: string, sourceNames: string[], recursive = false): Promise<number> =>
    window.desktop.CacheManager.reconcilePhotoRecords(directory, sourceNames, recursive);

  readonly selectDatabaseForDirectory = (directory: string): Promise<boolean> =>
    window.desktop.CacheManager.selectDatabaseForDirectory(directory);

  readonly getDirectoryPhotoLocations = (directory: string, recursive = false): Promise<PhotoLocation[]> =>
    window.desktop.CacheManager.getDirectoryPhotoLocations(directory, recursive);

  readonly getPhotoLocationsInBounds = (bounds: { west: number; south: number; east: number; north: number }, databaseKey: string): Promise<PhotoLocation[]> =>
    window.desktop.CacheManager.getPhotoLocationsInBounds(bounds, databaseKey);

  readonly getPhotoDatabaseRecord = (sourceName: string): Promise<PhotoDatabaseRecord | null> =>
    window.desktop.CacheManager.getPhotoDatabaseRecord(sourceName);

  readonly resolvePhotoLocation = (sourceName: string, latitude: number, longitude: number): Promise<string | null> =>
    window.desktop.CacheManager.resolvePhotoLocation(sourceName, latitude, longitude);

}
