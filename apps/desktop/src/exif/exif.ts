import { IpcMainInvokeEvent } from 'electron';
import { ExifTool } from 'exiftool-vendored';
import { open, readdir, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { ApiResponse, ExifTags, FixPhotoLocationsResult } from 'internal-api';
import { Injector } from '../injector/injector';
import { IpcHandler } from '../app/decorators/ipc-handler';


const formatLocalDateTime = (date: Date): string => date.toLocaleString('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

export class Exif {
  private readonly cancelledLocationFixes = new Set<string>();
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

  @IpcHandler({ name: 'Exif.writeGpsPosition' })
  readonly writeGpsPosition = async (
    _: IpcMainInvokeEvent, path: string, latitude: number, longitude: number
  ): Promise<ApiResponse<undefined>> => {
    try {
      if (!path || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
        || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        throw new Error('A valid image path and GPS coordinate pair are required.');
      }
      await this.exifTool.write(path, {
        GPSLatitude: Math.abs(latitude),
        GPSLatitudeRef: latitude < 0 ? 'South' : 'North',
        GPSLongitude: Math.abs(longitude),
        GPSLongitudeRef: longitude < 0 ? 'West' : 'East'
      });

      // Keep the Browse tab's database-backed GPS data in sync immediately.
      // Thumbnail generation is not guaranteed to run again after the EXIF write.
      try {
        const injector = Injector.getInstance();
        const cacheManager = injector.inject('CacheManager');
        const existingRecord = await cacheManager.getPhotoDatabaseRecord(undefined as never, path);
        const gps = await this.readPhotoMetadata(path);
        await cacheManager.updatePhotoMetadata(path, Number(existingRecord?.is_hdr) === 1, gps);
      } catch (cacheError) {
        console.warn('[Exif] GPS was written, but the photo database could not be synchronized:', path, cacheError);
      }

      return { success: true, data: undefined };
    } catch (error) {
      return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
    }
  };

  @IpcHandler({ name: 'Exif.cancelFixFolderLocations' })
  readonly cancelFixFolderLocations = (_event: IpcMainInvokeEvent, operationId: string): void => {
    if (typeof operationId === 'string' && operationId) this.cancelledLocationFixes.add(operationId);
  };

  @IpcHandler({ name: 'Exif.fixFolderLocations' })
  readonly fixFolderLocations = async (
    event: IpcMainInvokeEvent, folder: string, checkOnly: boolean, maxDifferenceSeconds = 120, operationId = ''
  ): Promise<ApiResponse<FixPhotoLocationsResult>> => {
    if (operationId) this.cancelledLocationFixes.delete(operationId);
    try {
      if (!folder || typeof folder !== 'string') throw new Error('Select a valid photo folder first.');
      if (!Number.isFinite(maxDifferenceSeconds) || maxDifferenceSeconds < 0 || maxDifferenceSeconds > 86_400) {
        throw new Error('Maximum time difference must be between 0 and 1440 minutes.');
      }
      const startedAt = Date.now();
      const root = resolve(folder);
      const rootInfo = await stat(root);
      if (!rootInfo.isDirectory()) throw new Error('The selected path is not a folder.');
      const imageExtensions = new Set([
        '.jpg', '.jpeg', '.tif', '.tiff', '.heic', '.heif', '.png', '.webp',
        '.dng', '.cr2', '.cr3', '.nef', '.arw', '.orf', '.rw2', '.raf', '.raw'
      ]);
      const candidates: string[] = [];
      let totalFilesProcessed = 0;
      let totalFoldersProcessed = 0;
      const pending = [root];
      while (pending.length) {
        const directory = pending.pop()!;
        totalFoldersProcessed++;
        let entries;
        try { entries = await readdir(directory, { withFileTypes: true }); }
        catch { continue; }
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          const path = join(directory, entry.name);
          if (entry.isDirectory()) {
            if (!['.cache', '$RECYCLE.BIN', 'System Volume Information', 'node_modules', '.git'].includes(entry.name)) pending.push(path);
          } else if (entry.isFile()) {
            totalFilesProcessed++;
            if (imageExtensions.has(extname(entry.name).toLowerCase())) candidates.push(path);
          }
        }
      }

      const result: FixPhotoLocationsResult = {
        rootFolder: root,
        totalFilesProcessed,
        totalFoldersProcessed,
        elapsedMilliseconds: 0,
        scanned: 0, withGps: 0, withoutGps: 0, matched: 0, updated: 0, unmatched: 0,
        ignoredTooFar: 0, minDeviationSeconds: null, meanDeviationSeconds: null, maxDeviationSeconds: null, errors: 0,
        aborted: false
      };
      const deviations: number[] = [];
      let lastProgressFolder = '';
      const sendProgress = (currentPhotoPath?: string): void => {
        const currentFolder = currentPhotoPath ? (relative(root, dirname(currentPhotoPath)) || '.') : '.';
        lastProgressFolder = currentFolder;
        try {
          event.sender.send('Exif.fixFolderLocationsProgress', {
            scanned: result.scanned, total: candidates.length,
            withGps: result.withGps, withoutGps: result.withoutGps, matched: result.matched,
            unmatched: result.unmatched, ignoredTooFar: result.ignoredTooFar,
            updated: result.updated, errors: result.errors,
            totalFilesProcessed: result.totalFilesProcessed, totalFoldersProcessed: result.totalFoldersProcessed,
            minDeviationSeconds: deviations.length ? Math.min(...deviations) : null,
            meanDeviationSeconds: deviations.length ? deviations.reduce((sum, value) => sum + value, 0) / deviations.length : null,
            maxDeviationSeconds: deviations.length ? Math.max(...deviations) : null,
            elapsedMilliseconds: Date.now() - startedAt,
            rootFolder: root, currentFolder
          });
        } catch { /* The requesting window may have closed. */ }
      };
      sendProgress();
      const injector = Injector.getInstance();
      const cacheManager = injector.inject('CacheManager');
      try {
        await cacheManager.resetGpsAutoFixDebug([
          `GPS Auto Fix debug started: ${formatLocalDateTime(new Date())}`,
          `Folder: ${root}`,
          `Check only: ${checkOnly}`,
          `Maximum time difference: ${maxDifferenceSeconds} seconds`,
          `Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
          `Local UTC offset now: ${new Date().getTimezoneOffset()} minutes`,
          `Photo candidates: ${candidates.length}`,
          ''
        ].join('\n'));
      } catch (logError) {
        console.warn('[Exif] Could not initialize GPS Auto Fix debug log:', logError);
      }
      const writeGpsDebug = async (label: string, details: unknown): Promise<void> => {
        try {
          await cacheManager.appendGpsAutoFixDebug(`[${formatLocalDateTime(new Date())}] ${label} ${JSON.stringify(details)}`);
        } catch (logError) {
          console.warn('[Exif] Could not write GPS Auto Fix debug log:', logError);
        }
      };
      for (const path of candidates) {
        if (operationId && this.cancelledLocationFixes.has(operationId)) {
          result.aborted = true;
          break;
        }
        result.scanned++;
        try {
          const metadata = await this.readPhotoMetadata(path);
          if (metadata.latitude !== null && metadata.longitude !== null) {
            result.withGps++;
            continue;
          }
          result.withoutGps++;
          if (metadata.gpsTimestamp === null) {
            const missingTimestampDetails = {
              photo: path,
              selectedExifTag: metadata.gpsTimestampSource,
              selectedExifRaw: metadata.gpsTimestampRaw,
              allExifTimestampCandidates: metadata.gpsTimestampCandidates,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              localNow: formatLocalDateTime(new Date()),
              utcNow: new Date().toISOString()
            };
            console.info('[Exif GPX time debug] Photo has no usable timestamp:', missingTimestampDetails);
            await writeGpsDebug('Photo has no usable timestamp:', missingTimestampDetails);
            result.unmatched++;
            continue;
          }
          const photoTimestampDetails = {
            photo: path,
            timestampSeconds: metadata.gpsTimestamp,
            timestampUtc: new Date(metadata.gpsTimestamp * 1000).toISOString(),
            timestampLocal: formatLocalDateTime(new Date(metadata.gpsTimestamp * 1000)),
            selectedExifTag: metadata.gpsTimestampSource,
            selectedExifRaw: metadata.gpsTimestampRaw,
            allExifTimestampCandidates: metadata.gpsTimestampCandidates,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            localOffsetMinutes: new Date(metadata.gpsTimestamp * 1000).getTimezoneOffset(),
            maxDifferenceSeconds
          };
          console.info('[Exif GPX time debug] Photo timestamp:', photoTimestampDetails);
          await writeGpsDebug('Photo timestamp:', photoTimestampDetails);
          const position = await cacheManager.getInterpolatedGpxPosition(undefined as never, root, metadata.gpsTimestamp * 1000, maxDifferenceSeconds);
          if (!position) {
            result.unmatched++;
            continue;
          }
          deviations.push(position.deviationSeconds);
          if (position.deviationSeconds > maxDifferenceSeconds) {
            result.ignoredTooFar++;
            continue;
          }
          result.matched++;
          if (checkOnly) continue;

          await this.exifTool.write(path, {
            GPSLatitude: Math.abs(position.latitude),
            GPSLatitudeRef: position.latitude < 0 ? 'South' : 'North',
            GPSLongitude: Math.abs(position.longitude),
            GPSLongitudeRef: position.longitude < 0 ? 'West' : 'East'
          });
          const existingRecord = await cacheManager.getPhotoDatabaseRecord(undefined as never, path);
          const updatedMetadata = await this.readPhotoMetadata(path);
          await cacheManager.updatePhotoMetadata(path, Number(existingRecord?.is_hdr) === 1, updatedMetadata);
          result.updated++;
        } catch (error) {
          result.errors++;
          console.warn('[Exif] Automatic GPS correction failed:', path, error);
          await writeGpsDebug('Photo processing error:', {
            photo: path,
            error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error)
          });
        } finally {
          const currentFolder = relative(root, dirname(path)) || '.';
          if (result.scanned % 100 === 0 || currentFolder !== lastProgressFolder) sendProgress(path);
          if (result.scanned % 25 === 0) await new Promise<void>(resolveYield => setImmediate(resolveYield));
        }
      }
      result.elapsedMilliseconds = Date.now() - startedAt;
      await writeGpsDebug('GPS Auto Fix summary:', result);
      if (operationId) this.cancelledLocationFixes.delete(operationId);
      if (deviations.length) {
        result.minDeviationSeconds = Math.min(...deviations);
        result.meanDeviationSeconds = deviations.reduce((sum, value) => sum + value, 0) / deviations.length;
        result.maxDeviationSeconds = Math.max(...deviations);
      }
      sendProgress(result.scanned ? candidates[result.scanned - 1] : undefined);
      return { success: true, data: result };
    } catch (error) {
      if (operationId) this.cancelledLocationFixes.delete(operationId);
      return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
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
    gpsTimestampSource: string | null;
    gpsTimestampRaw: string | null;
    gpsTimestampCandidates: Array<{ tag: string; raw: string; timestamp: number | null }>;
    directionDeg: number | null;
    coordinateSourceId: number | null;
  }> => {
    const empty = { latitude: null, longitude: null, altitudeM: null, gpsTimestamp: null, gpsTimestampSource: null, gpsTimestampRaw: null, gpsTimestampCandidates: [], directionDeg: null, coordinateSourceId: null };
    try {
      const tags = await this.exifTool.read(path) as unknown as Record<string, unknown>;
      const first = (...values: unknown[]) => values.find(value => value !== undefined && value !== null);
      const numeric = (value: unknown): number | null => {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
        return null;
      };
      const exifLatitude = numeric(tags['GPSLatitude']);
      const exifLongitude = numeric(tags['GPSLongitude']);
      const xmpLatitude = numeric(tags['XMP:GPSLatitude']);
      const xmpLongitude = numeric(tags['XMP:GPSLongitude']);
      const coordinateSourceId = exifLatitude !== null && exifLongitude !== null ? 1
        : xmpLatitude !== null && xmpLongitude !== null ? 2 : null;
      const latitudeValue = exifLatitude ?? xmpLatitude;
      const longitudeValue = exifLongitude ?? xmpLongitude;
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
      const toTimestamp = (value: unknown, assumeUtc = false): number | null => {
        if (value instanceof Date) {
          return Number.isFinite(value.getTime()) ? Math.floor(value.getTime() / 1000) : null;
        }

        // exiftool-vendored can return date tags as ExifDateTime objects
        // rather than native Date or string values. Their string form carries
        // the original EXIF timestamp (including any timezone suffix).
        const text = typeof value === 'string'
          ? value.trim()
          : value && typeof value === 'object'
            ? String(value).trim()
            : '';
        if (!text || text === '[object Object]') return null;
        // ExifTool may return EXIF date strings without timezone information.
        // Interpret those camera-local values in the local timezone rather than
        // letting Date.parse reject the colon-separated date format.
        const exifDate = text.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/i);
        const date = exifDate
          ? exifDate[8]
            ? new Date(exifDate[1] + '-' + exifDate[2] + '-' + exifDate[3] + 'T'
              + exifDate[4] + ':' + exifDate[5] + ':' + exifDate[6]
              + (exifDate[7] ? '.' + exifDate[7] : '')
              + (exifDate[8].length === 5 && exifDate[8] !== 'Z'
                ? exifDate[8].slice(0, 3) + ':' + exifDate[8].slice(3)
                : exifDate[8]))
            : assumeUtc
              ? new Date(Date.UTC(
                  Number(exifDate[1]), Number(exifDate[2]) - 1, Number(exifDate[3]),
                  Number(exifDate[4]), Number(exifDate[5]), Number(exifDate[6]),
                  Number((exifDate[7] ?? '').padEnd(3, '0').slice(0, 3))
                ))
              : new Date(
                  Number(exifDate[1]), Number(exifDate[2]) - 1, Number(exifDate[3]),
                  Number(exifDate[4]), Number(exifDate[5]), Number(exifDate[6]),
                  Number((exifDate[7] ?? '').padEnd(3, '0').slice(0, 3))
                )
          : new Date(text);
        return Number.isFinite(date.getTime()) ? Math.floor(date.getTime() / 1000) : null;
      };
      const timestampTags: Array<{ tag: string; value: unknown; assumeUtc: boolean }> = [
        { tag: 'GPSDateTime', value: tags['GPSDateTime'], assumeUtc: true },
        { tag: 'XMP:GPSDateTime', value: tags['XMP:GPSDateTime'], assumeUtc: true },
        { tag: 'DateTimeOriginal', value: tags['DateTimeOriginal'], assumeUtc: false },
        { tag: 'XMP:DateCreated', value: tags['XMP:DateCreated'], assumeUtc: false },
        { tag: 'CreateDate', value: tags['CreateDate'], assumeUtc: false }
      ];
      const gpsTimestampCandidates = timestampTags.map(candidate => ({
        tag: candidate.tag,
        raw: candidate.value === undefined || candidate.value === null ? '' : String(candidate.value),
        timestamp: toTimestamp(candidate.value, candidate.assumeUtc)
      }));
      const selectedTimestamp = gpsTimestampCandidates.find(candidate => candidate.timestamp !== null);
      const gpsTimestamp = selectedTimestamp?.timestamp ?? null;
      const directionDeg = numeric(first(tags['GPSImgDirection'], tags['XMP:GPSImgDirection']));
      return {
        latitude: latitude !== null && latitude >= -90 && latitude <= 90 ? latitude : null,
        longitude: longitude !== null && longitude >= -180 && longitude <= 180 ? longitude : null,
        altitudeM,
        gpsTimestamp,
        gpsTimestampSource: selectedTimestamp?.tag ?? null,
        gpsTimestampRaw: selectedTimestamp?.raw ?? null,
        gpsTimestampCandidates,
        directionDeg: directionDeg !== null && directionDeg >= 0 && directionDeg < 360 ? directionDeg : null,
        coordinateSourceId
      };
    } catch (error) {
      console.warn('[Exif] Could not read photo GPS metadata:', path, error);
      return empty;
    }
  };

}
