import type { Desktop, OfflinePhotoLocationRecord } from 'internal-api';

type PhotoDatabaseBounds = { west: number; south: number; east: number; north: number };
type PhotoDatabaseRecords = Awaited<ReturnType<Desktop['CacheManager']['getDirectoryPhotoLocations']>>;
type PhotoImageListing = Awaited<ReturnType<Desktop['FileSystem']['readImages']>>;
export type PhotoDatabaseMarker = {
  path: string;
  fileName: string;
  latitude: number;
  longitude: number;
  gpsTimestamp: number | null;
};

export class PhotoDatabaseManager {
  constructor(private readonly desktop: Desktop) {}

  async checkCompleteness(directory: string, recursive: boolean): Promise<{ total: number; missing: string[] }> {
    const result = await this.desktop.FileSystem.readImages(directory, 'name', 'asc', false, recursive);
    if (!result.success) throw new Error(result.errorMessage || `Could not read images in ${directory}`);
    const images = result.data.filter(image => !image.isDirectory);
    const missing: string[] = [];
    for (let offset = 0; offset < images.length; offset += 100) {
      const batch = images.slice(offset, offset + 100);
      const records = await Promise.all(batch.map(image => this.desktop.CacheManager.getPhotoDatabaseRecord(image.path)));
      records.forEach((record, index) => {
        const image = batch[index];
        const modifiedAt = image.modifiedAt ?? image.createdAt;
        if (!record || Number(record['file_size']) !== image.size
          || (Number.isFinite(modifiedAt) && Number(record['modified_at']) !== modifiedAt)) {
          missing.push(image.name);
        }
      });
    }
    return { total: images.length, missing };
  }

  async getDirectoryPhotoLocations(directory: string, recursive: boolean): Promise<{
    records: PhotoDatabaseRecords;
    imageFiles: PhotoImageListing;
  }> {
    const [records, imageFiles] = await Promise.all([
      this.desktop.CacheManager.getDirectoryPhotoLocations(directory, recursive),
      this.desktop.FileSystem.readImages(directory, 'name', 'asc', false, recursive)
    ]);
    return { records, imageFiles };
  }

  getPhotoLocationsInBounds(bounds: PhotoDatabaseBounds, databaseKey: string): Promise<PhotoDatabaseRecords> {
    return this.desktop.CacheManager.getPhotoLocationsInBounds(bounds, databaseKey);
  }

  createPhotoMarkers(
    records: PhotoDatabaseRecords,
    imageFiles: PhotoImageListing | null
  ): PhotoDatabaseMarker[] {
    const modifiedAtByName = new Map(
      (imageFiles?.success ? imageFiles.data : [])
        .filter(file => !file.isDirectory && Number.isFinite(file.modifiedAt) && file.modifiedAt! > 0)
        .map(file => [file.name.toLowerCase(), Math.floor(file.modifiedAt! / 1000)])
    );
    return records
      .filter(record => record.latitude !== null && record.longitude !== null
        && Number.isFinite(record.latitude) && Number.isFinite(record.longitude)
        && Math.abs(record.latitude) <= 90 && Math.abs(record.longitude) <= 180)
      .map(record => ({
        path: record.path,
        fileName: record.fileName,
        latitude: record.latitude!,
        longitude: record.longitude!,
        gpsTimestamp: record.gpsTimestamp ?? modifiedAtByName.get(record.fileName.toLowerCase()) ?? null
      }));
  }
}
