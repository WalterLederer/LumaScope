import { Injectable } from '@angular/core';
import { ApiResponse, DesktopExif, ExifTags, FixPhotoLocationsProgress, FixPhotoLocationsResult } from 'internal-api';

@Injectable({ providedIn: 'root' })
export class ExifService implements DesktopExif {
  readonly read = (path: string): Promise<ApiResponse<ExifTags>> => window.desktop.Exif.read(path);
  readonly writeGpsPosition = (path: string, latitude: number, longitude: number): Promise<ApiResponse<undefined>> => window.desktop.Exif.writeGpsPosition(path, latitude, longitude);
  readonly fixFolderLocations = (folder: string, checkOnly: boolean, maxDifferenceSeconds: number, operationId: string): Promise<ApiResponse<FixPhotoLocationsResult>> => window.desktop.Exif.fixFolderLocations(folder, checkOnly, maxDifferenceSeconds, operationId);
  readonly cancelFixFolderLocations = (operationId: string): void => window.desktop.Exif.cancelFixFolderLocations(operationId);
  readonly onFixFolderLocationsProgress = (callback: (progress: FixPhotoLocationsProgress) => void): (() => void) => window.desktop.Exif.onFixFolderLocationsProgress(callback);
}
