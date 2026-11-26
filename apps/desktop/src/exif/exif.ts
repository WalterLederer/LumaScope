import { IpcMainInvokeEvent } from 'electron';
import { ExifTool } from 'exiftool-vendored';
import { open, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { ApiResponse, ExifTags, FixPhotoLocationsResult, MissingGpsScanResult, MissingPhotoRecordsScanResult, formatOsDateTime, supportedFileExtensions } from 'internal-api';
import { Injector } from '../injector/injector';
import { IpcHandler } from '../app/decorators/ipc-handler';


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

  @IpcHandler({ name: 'Exif.refreshGpsMetadata' })
  readonly refreshGpsMetadata = async (_: IpcMainInvokeEvent, path: string): Promise<ApiResponse<{ latitude: number | null; longitude: number | null }>> => {
    try {
      if (typeof path !== 'string' || !path.trim()) throw new Error('A valid image path is required.');
      const injector = Injector.getInstance();
      const cacheManager = injector.inject('CacheManager');
      const existingRecord = await cacheManager.getPhotoDatabaseRecord(undefined as never, path);
      const gps = await this.readPhotoMetadata(path, true);
      const hasCoordinates = gps.latitude !== null && gps.longitude !== null;
      const expectedGpsCheckStatus = hasCoordinates ? 1 : 2;
      const databaseMatchesFile = !!existingRecord
        && Number(existingRecord.gps_check_status ?? 0) === expectedGpsCheckStatus
        && existingRecord.gps_checked_at != null
        && (existingRecord.latitude ?? null) === gps.latitude
        && (existingRecord.longitude ?? null) === gps.longitude
        && (existingRecord.altitude_m ?? null) === (hasCoordinates ? gps.altitudeM : null)
        && (existingRecord.direction_deg ?? null) === (hasCoordinates ? gps.directionDeg : null)
        && (existingRecord.coordinate_source_id ?? null) === (hasCoordinates ? gps.coordinateSourceId : null)
        && Number(existingRecord.gps_manually_corrected ?? 0) === (gps.gpsManuallyCorrected && hasCoordinates ? 1 : 0)
        && (hasCoordinates || (
          existingRecord.location_name_id == null
          && existingRecord.location_lookup_error == null
          && existingRecord.location_lookup_attempted_at == null
        ));
      if (!databaseMatchesFile) {
        await cacheManager.updatePhotoMetadata(path, Number(existingRecord?.is_hdr) === 1, gps);
      }
      return { success: true, data: { latitude: gps.latitude, longitude: gps.longitude } };
    } catch (error) {
      return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
    }
  };

  @IpcHandler({ name: 'Exif.scanMissingGps' })
  readonly scanMissingGps = async (
    _: IpcMainInvokeEvent, requestedDatabaseKeys: string[], dryRun: boolean
  ): Promise<ApiResponse<MissingGpsScanResult>> => {
    try {
      if (!Array.isArray(requestedDatabaseKeys) || requestedDatabaseKeys.length === 0
        || requestedDatabaseKeys.some(key => typeof key !== 'string' || !/^[a-z]:$/i.test(key))) {
        throw new Error('Provide one or more valid local photo database drive keys, for example D:.');
      }
      if (typeof dryRun !== 'boolean') throw new Error('The dry-run flag must be explicitly true or false.');

      const databaseKeys = [...new Set(requestedDatabaseKeys.map(key => key.toUpperCase()))].sort();
      const injector = Injector.getInstance();
      const cacheManager = injector.inject('CacheManager');
      const result: MissingGpsScanResult = {
        dryRun,
        scanned: 0,
        withGpsInFile: 0,
        withoutGpsInFile: 0,
        manuallyCorrectedSkipped: 0,
        fileChangedSkipped: 0,
        wouldUpdate: 0,
        updated: 0,
        skippedDuringUpdate: 0,
        errors: 0,
        databaseKeys
      };

      for (const databaseKey of databaseKeys) {
        let afterId = 0;
        while (true) {
          const batch = await cacheManager.getMissingGpsPhotoBatch(undefined as never, databaseKey, afterId, 128);
          if (batch.length === 0) break;

          for (const candidate of batch) {
            afterId = candidate.id;
            result.scanned++;
            if (candidate.manuallyCorrected) {
              result.manuallyCorrectedSkipped++;
              continue;
            }

            try {
              const beforeRead = await stat(candidate.path);
              if (!beforeRead.isFile() || beforeRead.size !== candidate.fileSize
                || Math.abs(beforeRead.mtimeMs - candidate.modifiedAt) > 0.01) {
                result.fileChangedSkipped++;
                continue;
              }

              const gps = await this.readPhotoMetadata(candidate.path, true);
              const afterRead = await stat(candidate.path);
              if (afterRead.size !== candidate.fileSize
                || Math.abs(afterRead.mtimeMs - candidate.modifiedAt) > 0.01) {
                result.fileChangedSkipped++;
                continue;
              }
              if (gps.latitude === null || gps.longitude === null) {
                result.withoutGpsInFile++;
                continue;
              }

              result.withGpsInFile++;
              result.wouldUpdate++;
              if (!dryRun) {
                const updated = await cacheManager.updateExistingPhotoGpsFromExif(
                  undefined as never, candidate.path, candidate.fileSize, candidate.modifiedAt, gps
                );
                if (updated) result.updated++;
                else result.skippedDuringUpdate++;
              }
            } catch (error) {
              result.errors++;
              console.warn('[Exif] Missing-GPS database scan failed for:', candidate.path, error);
            }

            if (result.scanned % 500 === 0) {
              console.info('[Exif] Missing-GPS scan progress:', {
                databaseKey, ...result
              });
            }
          }
        }
      }

      console.info('[Exif] Missing-GPS scan complete:', result);
      return { success: true, data: result };
    } catch (error) {
      return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
    }
  };

  @IpcHandler({ name: 'Exif.scanMissingPhotoRecords' })
  readonly scanMissingPhotoRecords = async (
    _: IpcMainInvokeEvent, requestedRoots: string[], dryRun: boolean
  ): Promise<ApiResponse<MissingPhotoRecordsScanResult>> => {
    try {
      if (!Array.isArray(requestedRoots) || requestedRoots.length === 0
        || requestedRoots.some(root => typeof root !== 'string' || !root.trim())) {
        throw new Error('Provide one or more valid photo-folder roots.');
      }
      if (typeof dryRun !== 'boolean') throw new Error('The dry-run flag must be explicitly true or false.');

      const roots = [...new Set(requestedRoots.map(root => resolve(root)))].sort();
      for (const root of roots) {
        if (!/^[a-z]:\\/i.test(root)) throw new Error(`Only local drive folders are supported: ${root}`);
      }
      const databaseKeys = [...new Set(roots.map(root => root.slice(0, 2).toUpperCase()))].sort();
      const injector = Injector.getInstance();
      const cacheManager = injector.inject('CacheManager');
      const result: MissingPhotoRecordsScanResult = {
        dryRun, scannedFiles: 0, alreadyInDatabase: 0, missingRecords: 0,
        imageFiles: 0, gpsFound: 0, withoutGps: 0, createdRecords: 0,
        fileChangedSkipped: 0, errors: 0, databaseKeys, roots
      };

      const scanDirectory = async (directory: string): Promise<void> => {
        let entries: Awaited<ReturnType<typeof readdir>>;
        try {
          entries = await readdir(directory, { withFileTypes: true }) as never;
        } catch (error) {
          result.errors++;
          console.warn('[Exif] Could not scan directory:', directory, error);
          return;
        }

        const childDirectories: string[] = [];
        const files: Array<{ name: string; path: string; size: number; modifiedAt: number }> = [];
        for (const entry of entries as unknown as Array<{
          name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean
        }>) {
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) {
            if (entry.name.toLowerCase() !== '.cache' && entry.name.toLowerCase() !== '.thumbnails') {
              childDirectories.push(join(directory, entry.name));
            }
            continue;
          }
          const filePath = join(directory, entry.name);
          try {
            const metadata = await stat(filePath);
            if (metadata.isFile()) files.push({
              name: entry.name, path: filePath, size: metadata.size, modifiedAt: metadata.mtimeMs
            });
            else if (metadata.isDirectory()) childDirectories.push(filePath);
          } catch {
            result.errors++;
          }
        }

        result.scannedFiles += files.length;
        const missingNames = await cacheManager.getMissingPhotoFileNames(
          undefined as never, directory, files.map(file => file.name)
        );
        const missingSet = new Set(missingNames.map(name => name.toLocaleLowerCase()));
        result.alreadyInDatabase += files.length - missingSet.size;
        result.missingRecords += missingSet.size;

        for (const file of files) {
          if (!missingSet.has(file.name.toLocaleLowerCase())) continue;
          let gps: Awaited<ReturnType<Exif['readPhotoMetadata']>> | null = null;
          const extension = extname(file.name).slice(1).toLowerCase();
          if (supportedFileExtensions.includes(extension)) {
            result.imageFiles++;
            try {
              const beforeRead = await stat(file.path);
              if (!beforeRead.isFile() || beforeRead.size !== file.size
                || Math.abs(beforeRead.mtimeMs - file.modifiedAt) > 0.01) {
                result.fileChangedSkipped++;
                continue;
              }
              gps = await this.readPhotoMetadata(file.path, true);
              const afterRead = await stat(file.path);
              if (afterRead.size !== file.size
                || Math.abs(afterRead.mtimeMs - file.modifiedAt) > 0.01) {
                result.fileChangedSkipped++;
                continue;
              }
              if (gps.latitude !== null && gps.longitude !== null) result.gpsFound++;
              else result.withoutGps++;
            } catch (error) {
              result.errors++;
              console.warn('[Exif] Could not read metadata for new photo record:', file.path, error);
            }
          }

          if (!dryRun) {
            try {
              const created = await cacheManager.registerMissingPhotoRecord(
                undefined as never, file.path, file.size, file.modifiedAt
              );
              if (!created) continue;
              result.createdRecords++;
              if (gps?.gpsMetadataRead) {
                await cacheManager.updatePhotoMetadata(undefined as never, file.path, false, gps);
              }
            } catch (error) {
              result.errors++;
              console.warn('[Exif] Could not create photo database record:', file.path, error);
            }
          }

          if (result.scannedFiles % 10000 === 0) {
            console.info('[Exif] Missing photo record scan progress:', { directory, ...result });
          }
        }

        for (const childDirectory of childDirectories) await scanDirectory(childDirectory);
      };

      for (const root of roots) await scanDirectory(root);
      console.info('[Exif] Missing photo record scan complete:', result);
      return { success: true, data: result };
    } catch (error) {
      return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
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
        GPSLongitudeRef: longitude < 0 ? 'West' : 'East',
        GPSProcessingMethod: 'LumaScope manual correction'
      });

      // Verify the provenance marker from the file before reporting a successful correction.
      const gps = await this.readPhotoMetadata(path, true);
      if (!gps.gpsManuallyCorrected) {
        throw new Error('The GPS position was written, but the EXIF manual-correction marker could not be verified.');
      }

      // Keep the Browse tab's database-backed GPS data in sync immediately.
      // A successful manual correction requires both the file marker and DB flag.
      const injector = Injector.getInstance();
      const cacheManager = injector.inject('CacheManager');
      const existingRecord = await cacheManager.getPhotoDatabaseRecord(undefined as never, path);
      await cacheManager.updatePhotoMetadata(path, Number(existingRecord?.is_hdr) === 1, gps);

      return { success: true, data: undefined };
    } catch (error) {
      return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
    }
  };

  @IpcHandler({ name: 'Exif.removeGpsMetadata' })
  readonly removeGpsMetadata = async (_: IpcMainInvokeEvent, path: string): Promise<ApiResponse<undefined>> => {
    try {
      if (typeof path !== 'string' || !path.trim()) throw new Error('A valid image path is required.');
      await this.exifTool.write(path, {
        GPSLatitude: null, GPSLatitudeRef: null, GPSLongitude: null, GPSLongitudeRef: null,
        GPSAltitude: null, GPSAltitudeRef: null, GPSDateStamp: null, GPSTimeStamp: null,
        GPSImgDirection: null, GPSImgDirectionRef: null, GPSProcessingMethod: null
      }, [
        '-XMP:GPSLatitude=', '-XMP:GPSLongitude=', '-XMP:GPSAltitude=',
        '-XMP:GPSImgDirection=', '-XMP:GPSDateTime='
      ]);

      const gps = await this.readPhotoMetadata(path, true);
      if (gps.latitude !== null || gps.longitude !== null) {
        throw new Error('GPS coordinates remain in the image file; the database was not changed.');
      }

      const injector = Injector.getInstance();
      const cacheManager = injector.inject('CacheManager');
      const existingRecord = await cacheManager.getPhotoDatabaseRecord(undefined as never, path);
      await cacheManager.updatePhotoMetadata(path, Number(existingRecord?.is_hdr) === 1, gps);
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
    event: IpcMainInvokeEvent, folder: string, checkOnly: boolean, maxDifferenceSeconds = 120, operationId = '', requestedDatabaseKeys: string[] = []
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
        aborted: false,
        gpxFromTimestamp: null, gpxToTimestamp: null,
        photoFromTimestamp: null, photoToTimestamp: null,
        databaseKeys: []
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
            rootFolder: root, currentFolder,
            gpxFromTimestamp: result.gpxFromTimestamp, gpxToTimestamp: result.gpxToTimestamp,
            photoFromTimestamp: result.photoFromTimestamp, photoToTimestamp: result.photoToTimestamp,
            databaseKeys: result.databaseKeys
          });
        } catch { /* The requesting window may have closed. */ }
      };
      sendProgress();
      const injector = Injector.getInstance();
      const cacheManager = injector.inject('CacheManager');
      const rootDrive = root.slice(0, 2).toUpperCase();
      const databaseKeys = [...new Set([rootDrive, ...(Array.isArray(requestedDatabaseKeys) ? requestedDatabaseKeys : [])]
        .filter(key => typeof key === 'string' && /^[a-z]:$/i.test(key))
        .map(key => key.toUpperCase()))].sort((a, b) => a.localeCompare(b));
      const gpxDatabaseStats = await Promise.all(databaseKeys.map(async databaseKey => ({
        databaseKey,
        stats: await cacheManager.getGpxDatabaseStats(undefined as never, databaseKey)
      })));
      result.databaseKeys = databaseKeys;
      const gpxDatabaseRanges = await Promise.all(databaseKeys.map(databaseKey =>
        cacheManager.getGpxDatabaseTimeRange(undefined as never, databaseKey)
      ));
      const gpxTimestamps = gpxDatabaseRanges.flatMap(range =>
        [range.from, range.to].filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
      );
      result.gpxFromTimestamp = gpxTimestamps.length ? Math.min(...gpxTimestamps) : null;
      result.gpxToTimestamp = gpxTimestamps.length ? Math.max(...gpxTimestamps) : null;
      const hasTimestampedGpxData = gpxDatabaseStats.some(({ stats }) =>
        stats.files > 0 && stats.segments > 0 && stats.points > 0 && stats.timestampedPoints > 0
      );
      if (!hasTimestampedGpxData) {
        console.info('[Exif] No timestamped GPX track points found; GPS Auto Fix will still use cached geotagged images as reference positions.');
      }
      sendProgress();
      try {
        await cacheManager.resetGpsAutoFixDebug([
          `GPS Auto Fix debug started: ${formatOsDateTime(new Date())}`,
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
          await cacheManager.appendGpsAutoFixDebug(`[${formatOsDateTime(new Date())}] ${label} ${JSON.stringify(details)}`);
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
          if (!checkOnly) {
            // The image file is the authoritative GPS source. Always synchronize
            // the database so removed file coordinates clear stale GPS metadata.
            await cacheManager.registerPhotoFile(path);
            const existingRecord = await cacheManager.getPhotoDatabaseRecord(undefined as never, path);
            await cacheManager.updatePhotoMetadata(path, Number(existingRecord?.is_hdr) === 1, metadata);
          }
          // Prefer camera-generated filename timestamps over filesystem dates:
          // Android/ADB copies can replace Created/Modified times with copy time.
          // Filesystem last-modified remains the final fallback.
          let photoTimestamp = metadata.gpsTimestamp;
          let photoTimestampSource = metadata.gpsTimestampSource;
          let filesystemModifiedAt: string | null = null;
          if (photoTimestamp === null) {
            const fileInfo = await stat(path);
            if (Number.isFinite(fileInfo.mtimeMs) && fileInfo.mtimeMs > 0) {
              photoTimestamp = Math.floor(fileInfo.mtimeMs / 1000);
              photoTimestampSource = 'Filesystem:LastModified';
              filesystemModifiedAt = fileInfo.mtime.toISOString();
            }
          }
          if (photoTimestamp !== null && Number.isFinite(photoTimestamp)) {
            const timestampMs = photoTimestamp * 1000;
            result.photoFromTimestamp = result.photoFromTimestamp === null
              ? timestampMs : Math.min(result.photoFromTimestamp, timestampMs);
            result.photoToTimestamp = result.photoToTimestamp === null
              ? timestampMs : Math.max(result.photoToTimestamp, timestampMs);
          }
          // Keep the selected capture timestamp in SQLite even when the photo
          // already has coordinates or no GPX match is found. Check-only runs
          // remain read-only.
          if (!checkOnly && photoTimestamp !== null) {
            await cacheManager.updatePhotoGpsTimestamp(path, photoTimestamp);
          }
          if (metadata.latitude !== null && metadata.longitude !== null) {
            result.withGps++;
            continue;
          }
          result.withoutGps++;
          if (photoTimestamp === null) {
            const missingTimestampDetails = {
              photo: path,
              selectedExifTag: metadata.gpsTimestampSource,
              selectedExifRaw: metadata.gpsTimestampRaw,
              allExifTimestampCandidates: metadata.gpsTimestampCandidates,
              filesystemModifiedAt,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              localNow: formatOsDateTime(new Date()),
              utcNow: new Date().toISOString()
            };
            console.info('[Exif GPX time debug] Photo has no usable EXIF or filesystem timestamp:', missingTimestampDetails);
            await writeGpsDebug('No timestamp: ' + basename(path), { source: photoTimestampSource || '—' });
            result.unmatched++;
            continue;
          }
          const photoTimestampDetails = {
            photo: path,
            timestampSeconds: photoTimestamp,
            timestampUtc: new Date(photoTimestamp * 1000).toISOString(),
            timestampLocal: formatOsDateTime(new Date(photoTimestamp * 1000)),
            selectedExifTag: photoTimestampSource,
            selectedExifRaw: metadata.gpsTimestampRaw,
            filesystemModifiedAt,
            allExifTimestampCandidates: metadata.gpsTimestampCandidates,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            localOffsetMinutes: new Date(photoTimestamp * 1000).getTimezoneOffset(),
            maxDifferenceSeconds
          };
          console.info('[Exif GPX time debug] Photo timestamp:', photoTimestampDetails);
          await writeGpsDebug('Photo: ' + basename(path), { time: photoTimestampDetails.timestampLocal, source: photoTimestampSource || '—' });
          let position: { latitude: number; longitude: number; deviationSeconds: number; source: string } | null = null;
          for (const databaseKey of databaseKeys) {
            const [trackCandidate, imageCandidate] = await Promise.all([
              cacheManager.getInterpolatedGpxPosition(undefined as never, root, photoTimestamp * 1000, maxDifferenceSeconds, databaseKey),
              cacheManager.getInterpolatedPhotoGpsPosition(undefined as never, path, photoTimestamp * 1000, databaseKey)
            ]);
            if (trackCandidate && (!position || trackCandidate.deviationSeconds < position.deviationSeconds)) {
              position = { ...trackCandidate, source: `GPX track points (${databaseKey})` };
            }
            if (imageCandidate && (!position || imageCandidate.deviationSeconds < position.deviationSeconds)) {
              position = { ...imageCandidate, source: `geotagged images (${databaseKey})` };
            }
          }
          await writeGpsDebug('Reference comparison: ' + basename(path), {
            selectedSource: position?.source ?? 'none',
            selectedDeviationSeconds: position?.deviationSeconds ?? null,
            searchedDatabaseKeys: databaseKeys,
            sources: ['GPX track points', 'cached image GPS positions']
          });
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
          sendProgress(path);
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

  readonly readPhotoMetadata = async (path: string, throwOnError = false): Promise<{
    latitude: number | null;
    longitude: number | null;
    altitudeM: number | null;
    gpsTimestamp: number | null;
    gpsTimestampSource: string | null;
    gpsTimestampRaw: string | null;
    gpsTimestampCandidates: Array<{ tag: string; raw: string; timestamp: number | null }>;
    directionDeg: number | null;
    coordinateSourceId: number | null;
    gpsManuallyCorrected: boolean;
    gpsMetadataRead: boolean;
  }> => {
    const empty = { latitude: null, longitude: null, altitudeM: null, gpsTimestamp: null, gpsTimestampSource: null, gpsTimestampRaw: null, gpsTimestampCandidates: [], directionDeg: null, coordinateSourceId: null, gpsManuallyCorrected: false, gpsMetadataRead: false };
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
      // Samsung camera filenames such as IMG_20261009_093728.jpg retain the
      // original capture time even when Android/ADB does not preserve the
      // filesystem timestamps during copying. Interpret filename times locally,
      // like EXIF DateTimeOriginal values without an explicit timezone.
      const fileName = basename(path);
      const fileNameDate = fileName.match(/(?:^|[^0-9])(\d{4})(\d{2})(\d{2})[_-]?(\d{2})(\d{2})(\d{2})(?=[^0-9]|$)/);
      let fileNameTimestamp: Date | null = null;
      if (fileNameDate) {
        const [, year, month, day, hour, minute, second] = fileNameDate;
        const parsed = new Date(
          Number(year), Number(month) - 1, Number(day),
          Number(hour), Number(minute), Number(second)
        );
        if (parsed.getFullYear() === Number(year)
          && parsed.getMonth() === Number(month) - 1
          && parsed.getDate() === Number(day)
          && parsed.getHours() === Number(hour)
          && parsed.getMinutes() === Number(minute)
          && parsed.getSeconds() === Number(second)) {
          fileNameTimestamp = parsed;
        }
      }
      const timestampTags: Array<{ tag: string; value: unknown; assumeUtc: boolean }> = [
        { tag: 'GPSDateTime', value: tags['GPSDateTime'], assumeUtc: true },
        { tag: 'XMP:GPSDateTime', value: tags['XMP:GPSDateTime'], assumeUtc: true },
        { tag: 'Filename:YYYYMMDD_HHmmss', value: fileNameTimestamp, assumeUtc: false },
        { tag: 'DateTimeOriginal', value: tags['DateTimeOriginal'], assumeUtc: false },
        { tag: 'XMP:DateCreated', value: tags['XMP:DateCreated'], assumeUtc: false },
        { tag: 'CreateDate', value: tags['CreateDate'], assumeUtc: false }
      ];
      const gpsTimestampCandidates = timestampTags.map(candidate => ({
        tag: candidate.tag,
        raw: candidate.tag === 'Filename:YYYYMMDD_HHmmss'
          ? (fileNameDate?.[0]?.trim() ?? '')
          : candidate.value === undefined || candidate.value === null ? '' : String(candidate.value),
        timestamp: toTimestamp(candidate.value, candidate.assumeUtc)
      }));
      const selectedTimestamp = gpsTimestampCandidates.find(candidate => candidate.timestamp !== null);
      const gpsTimestamp = selectedTimestamp?.timestamp ?? null;
      const directionDeg = numeric(first(tags['GPSImgDirection'], tags['XMP:GPSImgDirection']));
      const gpsProcessingMethod = String(tags['GPSProcessingMethod'] ?? '').toLowerCase();
      const gpsManuallyCorrected = gpsProcessingMethod.includes('lumascope') && gpsProcessingMethod.includes('manual');
      return {
        latitude: latitude !== null && latitude >= -90 && latitude <= 90 ? latitude : null,
        longitude: longitude !== null && longitude >= -180 && longitude <= 180 ? longitude : null,
        altitudeM,
        gpsTimestamp,
        gpsTimestampSource: selectedTimestamp?.tag ?? null,
        gpsTimestampRaw: selectedTimestamp?.raw ?? null,
        gpsTimestampCandidates,
        directionDeg: directionDeg !== null && directionDeg >= 0 && directionDeg < 360 ? directionDeg : null,
        gpsManuallyCorrected,
        coordinateSourceId,
        gpsMetadataRead: true
      };
    } catch (error) {
      console.warn('[Exif] Could not read photo GPS metadata:', path, error);
      if (throwOnError) throw error;
      return empty;
    }
  };

}
