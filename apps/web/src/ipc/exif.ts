import { Injectable } from '@angular/core';
import { ApiResponse, DesktopExif, ExifTags, FixPhotoLocationsProgress, FixPhotoLocationsResult } from 'internal-api';

@Injectable({ providedIn: 'root' })
export class ExifService implements DesktopExif {
  private readonly metadataCache = new Map<string, { expiresAt: number; result: Promise<ApiResponse<ExifTags>> }>();

  readonly readFresh = (path: string): Promise<ApiResponse<ExifTags>> => {
    this.metadataCache.delete(path);
    return this.read(path);
  };

  readonly read = (path: string): Promise<ApiResponse<ExifTags>> => {
    const cached = this.metadataCache.get(path);
    if (cached && cached.expiresAt > Date.now()) return cached.result;

    const result = window.desktop.Exif.read(path);
    this.metadataCache.set(path, { expiresAt: Date.now() + 5 * 60 * 1000, result });
    void result.then(response => {
      if (!response.success && this.metadataCache.get(path)?.result === result) this.metadataCache.delete(path);
    }, () => {
      if (this.metadataCache.get(path)?.result === result) this.metadataCache.delete(path);
    });
    if (this.metadataCache.size > 2000) {
      const oldest = this.metadataCache.keys().next().value;
      if (oldest !== undefined) this.metadataCache.delete(oldest);
    }
    return result;
  };

  readonly writeGpsPosition = async (path: string, latitude: number, longitude: number): Promise<ApiResponse<undefined>> => {
    const result = await window.desktop.Exif.writeGpsPosition(path, latitude, longitude);
    if (result.success) this.metadataCache.delete(path);
    return result;
  };

  readonly refreshGpsMetadata = async (path: string): Promise<ApiResponse<{ latitude: number | null; longitude: number | null }>> => {
    const result = await window.desktop.Exif.refreshGpsMetadata(path);
    if (result.success) this.metadataCache.delete(path);
    return result;
  };

  readonly fixFolderLocations = async (folder: string, checkOnly: boolean, maxDifferenceSeconds: number, operationId: string): Promise<ApiResponse<FixPhotoLocationsResult>> => {
    const result = await window.desktop.Exif.fixFolderLocations(folder, checkOnly, maxDifferenceSeconds, operationId);
    if (result.success && !checkOnly) this.metadataCache.clear();
    return result;
  };
  readonly cancelFixFolderLocations = (operationId: string): void => window.desktop.Exif.cancelFixFolderLocations(operationId);
  readonly onFixFolderLocationsProgress = (callback: (progress: FixPhotoLocationsProgress) => void): (() => void) => window.desktop.Exif.onFixFolderLocationsProgress(callback);
}
