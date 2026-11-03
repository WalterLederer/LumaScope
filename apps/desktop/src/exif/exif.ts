import { IpcMainInvokeEvent } from 'electron';
import { ExifTool } from 'exiftool-vendored';
import { open } from 'node:fs/promises';
import { ApiResponse, ExifTags } from 'internal-api';
import { IpcHandler } from '../app/decorators/ipc-handler';

export class Exif {
  private readonly exifTool = new ExifTool();

  @IpcHandler({ name: 'Exif.read' })
  readonly read = async (_: IpcMainInvokeEvent, path: string): Promise<ApiResponse<ExifTags>> => {
    try {
      const tags = await this.exifTool.read(path);

      if (/\.jpe?g$/i.test(path) && await this.hasUltraHdrGainMap(path)) {
        (tags as ExifTags & { HDRGainMap?: boolean }).HDRGainMap = true;
      }

      return { success: true, data: tags };
    } catch (e) {
      return { success: false, errorMessage: e.message };
    }
  };

  private readonly hasUltraHdrGainMap = async (path: string): Promise<boolean> => {
    const file = await open(path, 'r');

    try {
      // Gain-map metadata can occur after the first MiB, for example in the
      // embedded secondary JPEG. Scan the complete file in chunks instead.
      const buffer = Buffer.alloc(64 * 1024);
      const markerPattern = /hdrgm|gainmap|mincontentboost|maxcontentboost|ultrahdr/i;
      const overlapLength = 32;
      let position = 0;
      let overlap = '';

      while (true) {
        const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) {
          return false;
        }

        const text = overlap + buffer.subarray(0, bytesRead).toString('latin1');
        if (markerPattern.test(text)) {
          return true;
        }

        overlap = text.slice(-overlapLength);
        position += bytesRead;
      }
    } finally {
      await file.close();
    }
  };

  readonly readPhotoMetadata = async (path: string): Promise<{
    latitude: number | null;
    longitude: number | null;
    altitudeM: number | null;
    gpsTimestamp: number | null;
    directionDeg: number | null;
  }> => {
    const empty = { latitude: null, longitude: null, altitudeM: null, gpsTimestamp: null, directionDeg: null };
    try {
      const tags = await this.exifTool.read(path) as unknown as Record<string, unknown>;
      const first = (...values: unknown[]) => values.find(value => value !== undefined && value !== null);
      const numeric = (value: unknown): number | null => {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
        return null;
      };
      const latitudeValue = numeric(first(tags['GPSLatitude'], tags['XMP:GPSLatitude']));
      const longitudeValue = numeric(first(tags['GPSLongitude'], tags['XMP:GPSLongitude']));
      const latitudeRef = String(first(tags['GPSLatitudeRef'], tags['XMP:GPSLatitudeRef']) ?? '').toUpperCase();
      const longitudeRef = String(first(tags['GPSLongitudeRef'], tags['XMP:GPSLongitudeRef']) ?? '').toUpperCase();
      const latitude = latitudeValue === null ? null
        : latitudeRef === 'S' ? -Math.abs(latitudeValue) : latitudeRef === 'N' ? Math.abs(latitudeValue) : latitudeValue;
      const longitude = longitudeValue === null ? null
        : longitudeRef === 'W' ? -Math.abs(longitudeValue) : longitudeRef === 'E' ? Math.abs(longitudeValue) : longitudeValue;
      const altitudeValue = numeric(first(tags['GPSAltitude'], tags['XMP:GPSAltitude']));
      const altitudeRef = String(first(tags['GPSAltitudeRef'], tags['XMP:GPSAltitudeRef']) ?? '').toLowerCase();
      const altitudeM = altitudeValue === null ? null
        : altitudeRef === '1' || altitudeRef.includes('below') ? -Math.abs(altitudeValue)
          : altitudeRef === '0' || altitudeRef.includes('above') ? Math.abs(altitudeValue) : altitudeValue;
      const rawDate = first(tags['GPSDateTime'], tags['XMP:GPSDateTime']);
      const gpsDate = rawDate instanceof Date ? rawDate : typeof rawDate === 'string' ? new Date(rawDate) : null;
      const gpsTimestamp = gpsDate && Number.isFinite(gpsDate.getTime()) ? Math.floor(gpsDate.getTime() / 1000) : null;
      const directionDeg = numeric(first(tags['GPSImgDirection'], tags['XMP:GPSImgDirection']));
      return {
        latitude: latitude !== null && latitude >= -90 && latitude <= 90 ? latitude : null,
        longitude: longitude !== null && longitude >= -180 && longitude <= 180 ? longitude : null,
        altitudeM,
        gpsTimestamp,
        directionDeg: directionDeg !== null && directionDeg >= 0 && directionDeg < 360 ? directionDeg : null
      };
    } catch (error) {
      console.warn('[Exif] Could not read photo GPS metadata:', path, error);
      return empty;
    }
  };

}
