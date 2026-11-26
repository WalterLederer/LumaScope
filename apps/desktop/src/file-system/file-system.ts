import { app, BrowserWindow, dialog, IpcMainInvokeEvent, shell } from 'electron';
import { ApiResponse, FileInfo, SortDirection, SortType, supportedFileExtensions, formatOsDateTime } from 'internal-api';
import { Dirent, statSync } from 'node:fs';
import { copyFile, mkdir, open, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { IpcHandler } from '../app/decorators/ipc-handler';
import { Injector } from '../injector/injector';
import { writeJsonAtomically } from './json-file';

export class FileSystem {
  @IpcHandler({ name: 'FileSystem.join' })
  readonly join = async (_: IpcMainInvokeEvent, ...paths: string[]): Promise<string> => join(...paths);

  @IpcHandler({ name: 'FileSystem.dirname' })
  readonly dirname = async (_: IpcMainInvokeEvent, fileName: string): Promise<string> => dirname(fileName);

  @IpcHandler({ name: 'FileSystem.readDir' })
  readonly readDir = async (_: IpcMainInvokeEvent, path: string): Promise<FileInfo[]> => {
    const entries = await readdir(path, { withFileTypes: true });
    const result: FileInfo[] = [];
    for (let offset = 0; offset < entries.length; offset += 256) {
      const batch = await Promise.all(entries.slice(offset, offset + 256).map(async (entry): Promise<FileInfo | null> => {
        try {
          const filePath = join(path, entry.name);
          const stats = await stat(filePath);
          return {
            path: filePath, name: entry.name, parent: path,
            isDirectory: entry.isDirectory(), ext: extname(entry.name),
            createdAt: stats.birthtimeMs, size: stats.size, modifiedAt: stats.mtimeMs
          } satisfies FileInfo;
        } catch {
          // Files can disappear or become inaccessible while a large folder is scanned.
          return null;
        }
      }));
      result.push(...batch.filter((entry): entry is FileInfo => entry !== null));
      if (offset + 256 < entries.length) await new Promise<void>(resolveYield => setImmediate(resolveYield));
    }
    return result;
  };

  @IpcHandler({ name: 'FileSystem.readText' })
  readonly readText = async (_: IpcMainInvokeEvent, path: string): Promise<ApiResponse<string>> => {
    try {
      return { success: true, data: await readFile(path, 'utf-8') };
    } catch (_) {
      return { success: false, errorMessage: `Failed to read file ${path}.` };
    }
  };

  @IpcHandler({ name: 'FileSystem.readDocumentationFile' })
  readonly readDocumentationFile = async (_: IpcMainInvokeEvent, fileName: string): Promise<ApiResponse<string>> => {
    // Accept Markdown files by basename only. The file is always read from the
    // documentation root below; directory traversal and nested paths are rejected.
    if (typeof fileName !== 'string' || !/^[a-zA-Z0-9_-]+\.md$/i.test(fileName)) {
      return { success: false, errorMessage: 'Invalid documentation file name.' };
    }

    const roots = app.isPackaged
      ? [ join(process.resourcesPath, 'docs') ]
      : [ join(process.cwd(), 'docs'), join(app.getAppPath(), 'docs') ];
    const candidates = fileName === 'README.md'
      ? app.isPackaged
        ? [ join(process.resourcesPath, fileName), ...roots.map(root => join(root, fileName)) ]
        : [ join(process.cwd(), fileName), join(app.getAppPath(), fileName), ...roots.map(root => join(root, fileName)) ]
      : roots.map(root => join(root, fileName));

    let lastError: unknown = null;
    for (const sourcePath of candidates) {
      try {
        return { success: true, data: await readFile(sourcePath, 'utf-8') };
      } catch (error) {
        lastError = error;
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError ?? 'File not found.');
    return { success: false, errorMessage: 'Could not load ' + fileName + ': ' + message };
  };
  @IpcHandler({ name: 'FileSystem.openDocumentationFile' })
  readonly openDocumentationFile = async (_: IpcMainInvokeEvent, fileName: string): Promise<string> => {
    if (typeof fileName !== 'string' || !/^[a-zA-Z0-9_-]+\.md$/i.test(fileName)) {
      return 'Invalid documentation file name.';
    }

    const candidates = fileName === 'README.md'
      ? app.isPackaged
        ? [join(process.resourcesPath, fileName), join(process.resourcesPath, 'docs', fileName)]
        : [join(process.cwd(), fileName), join(app.getAppPath(), fileName), join(process.cwd(), 'docs', fileName), join(app.getAppPath(), 'docs', fileName)]
      : app.isPackaged
        ? [join(process.resourcesPath, 'docs', fileName)]
        : [join(process.cwd(), 'docs', fileName), join(app.getAppPath(), 'docs', fileName)];

    for (const sourcePath of candidates) {
      try {
        if (statSync(sourcePath).isFile()) return await shell.openPath(sourcePath);
      } catch {
        // Try the next known documentation root.
      }
    }
    return 'Documentation file not found: ' + fileName;
  };

  @IpcHandler({ name: 'FileSystem.readDocumentationImage' })
  readonly readDocumentationImage = async (_: IpcMainInvokeEvent, fileName: string): Promise<ApiResponse<string>> => {
    if (typeof fileName !== 'string' || !/^[a-zA-Z0-9_().-]+\.(?:png|jpe?g|webp|gif)$/i.test(fileName)) {
      return { success: false, errorMessage: 'Invalid documentation image name.' };
    }
    const mimeTypes: Record<string, string> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.webp': 'image/webp', '.gif': 'image/gif'
    };
    const mimeType = mimeTypes[extname(fileName).toLowerCase()];
    if (!mimeType) return { success: false, errorMessage: 'Unsupported documentation image format.' };
    const roots = app.isPackaged
      ? [ join(process.resourcesPath, 'docs', 'images') ]
      : [ join(process.cwd(), 'docs', 'images'), join(app.getAppPath(), 'docs', 'images') ];
    for (const root of roots) {
      try {
        const image = await readFile(join(root, fileName));
        return { success: true, data: 'data:' + mimeType + ';base64,' + image.toString('base64') };
      } catch (_) {
        // Continue to the next development root.
      }
    }
    return { success: false, errorMessage: 'Documentation image not found: ' + fileName };
  };

  @IpcHandler({ name: 'FileSystem.readHexRange' })
  readonly readHexRange = async (_: IpcMainInvokeEvent, sourcePath: string, startOffset: number, rowCount: number): Promise<ApiResponse<{ fileSize: number; rows: Array<{ offset: number; hex: string; ascii: string; utf16: string; utf16Shifted: string }> }>> => {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      if (typeof sourcePath !== 'string' || !sourcePath) throw new Error('Invalid file path.');
      const offset = Number.isSafeInteger(startOffset) ? Math.max(0, Math.floor(startOffset / 16) * 16) : 0;
      const count = Number.isSafeInteger(rowCount) ? Math.max(1, Math.min(512, rowCount)) : 256;
      file = await open(sourcePath, 'r');
      const info = await file.stat();
      const totalRows = Math.max(0, Math.ceil(info.size / 16));
      const actualRows = Math.max(0, Math.min(count, totalRows - offset / 16));
      const buffer = Buffer.alloc(actualRows * 16 + (actualRows ? 1 : 0));
      let bytesRead = 0;
      if (buffer.length) {
        bytesRead = (await file.read(buffer, 0, buffer.length, offset)).bytesRead;
      }
      const getByte = (index: number): number | undefined => index < bytesRead ? buffer[index] : undefined;
      const printable = (value: number): string =>
        value >= 0x20 && value <= 0x7e ? String.fromCharCode(value) : '.';
      const unicodeUnit = (low: number | undefined, high: number | undefined): string => {
        if (low === undefined || high === undefined) return ' ';
        const code = low | (high << 8);
        return code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0xd800 && code <= 0xdfff)
          ? '·' : String.fromCharCode(code);
      };
      const rows = Array.from({ length: actualRows }, (_, rowIndex) => {
        const rowOffset = offset + rowIndex * 16;
        const rowStart = rowIndex * 16;
        const byteCount = Math.min(16, info.size - rowOffset);
        const values = Array.from({ length: byteCount }, (_, index) => getByte(rowStart + index)).filter((value): value is number => value !== undefined);
        const hex = values.map(value => value.toString(16).padStart(2, '0').toUpperCase()).join(' ').padEnd(47, ' ');
        const ascii = values.map(printable).join('').padEnd(16, ' ');
        let utf16 = '';
        let utf16Shifted = '';
        for (let index = 0; index < 16; index += 2) {
          utf16 += unicodeUnit(getByte(rowStart + index), getByte(rowStart + index + 1));
          utf16Shifted += unicodeUnit(getByte(rowStart + index + 1), getByte(rowStart + index + 2));
        }
        return { offset: rowOffset, hex, ascii, utf16, utf16Shifted };
      });
      return { success: true, data: { fileSize: info.size, rows } };
    } catch (error) {
      return { success: false, errorMessage: 'Could not read HEX data: ' + (error instanceof Error ? error.message : String(error)) };
    } finally {
      await file?.close().catch(() => undefined);
    }
  };

  @IpcHandler({ name: 'FileSystem.searchBytes' })
  readonly searchBytes = async (_: IpcMainInvokeEvent, sourcePath: string, searchBytes: number[], startOffset: number, direction: 1 | -1): Promise<ApiResponse<number | null>> => {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      if (typeof sourcePath !== 'string' || !sourcePath) throw new Error('Invalid file path.');
      if (!Array.isArray(searchBytes) || searchBytes.length === 0 || searchBytes.length > 65536
        || searchBytes.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
        throw new Error('Invalid search byte sequence.');
      }
      if (direction !== 1 && direction !== -1) throw new Error('Invalid search direction.');
      file = await open(sourcePath, 'r');
      const info = await file.stat();
      const pattern = Buffer.from(searchBytes);
      if (pattern.length > info.size) return { success: true, data: null };
      const chunkSize = 1024 * 1024;
      if (direction > 0) {
        let blockStart = Math.max(0, Math.floor(startOffset));
        while (blockStart < info.size) {
          const readLength = Math.min(chunkSize + pattern.length - 1, info.size - blockStart);
          const buffer = Buffer.alloc(readLength);
          const bytesRead = (await file.read(buffer, 0, readLength, blockStart)).bytesRead;
          const available = buffer.subarray(0, bytesRead);
          const index = available.indexOf(pattern, Math.max(0, Math.floor(startOffset) - blockStart));
          if (index >= 0 && index < chunkSize) return { success: true, data: blockStart + index };
          blockStart += chunkSize;
        }
      } else {
        let upperBound = Math.min(Math.floor(startOffset), info.size - pattern.length);
        while (upperBound >= 0) {
          const lowerBound = Math.max(0, upperBound - chunkSize + 1);
          const readEnd = Math.min(info.size, upperBound + pattern.length);
          const readLength = readEnd - lowerBound;
          const buffer = Buffer.alloc(readLength);
          const bytesRead = (await file.read(buffer, 0, readLength, lowerBound)).bytesRead;
          const available = buffer.subarray(0, bytesRead);
          const index = available.lastIndexOf(pattern, upperBound - lowerBound);
          if (index >= 0) return { success: true, data: lowerBound + index };
          upperBound = lowerBound - 1;
        }
      }
      return { success: true, data: null };
    } catch (error) {
      return { success: false, errorMessage: 'Could not search file: ' + (error instanceof Error ? error.message : String(error)) };
    } finally {
      await file?.close().catch(() => undefined);
    }
  };

  @IpcHandler({ name: 'FileSystem.exportHex' })
  readonly exportHex = async (event: IpcMainInvokeEvent, sourcePath: string): Promise<ApiResponse<undefined>> => {
    try {
      const sourceBytes = await readFile(sourcePath);
      const sourceName = sourcePath.split(/[\\/]/).pop() || 'file';
      const suggestedName = sourceName.replace(/\.[^.]*$/, '') + '.hex.txt';
      const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const selection = await dialog.showSaveDialog(ownerWindow, {
        title: 'Export HEX',
        defaultPath: join(dirname(sourcePath), suggestedName),
        buttonLabel: 'Export',
        filters: [{ name: 'Text files', extensions: ['txt'] }, { name: 'All files', extensions: ['*'] }]
      });
      if (selection.canceled || !selection.filePath) return { success: true, data: undefined };

      const lines = [
        'OFFSET  HEX BYTES                                        ASCII                UTF-16LE              UTF-16LE (+1 byte)',
        '-------- ------------------------------------------------ -------------------- -------------------- --------------------'
      ];
      const printable = (value: number): string =>
        value >= 0x20 && value <= 0x7e ? String.fromCharCode(value) : '.';
      const unicodeUnit = (low: number, high: number): string => {
        const codeUnit = low | (high << 8);
        if (codeUnit < 0x20 || (codeUnit >= 0x7f && codeUnit <= 0x9f)
          || (codeUnit >= 0xd800 && codeUnit <= 0xdfff)) return '·';
        return String.fromCharCode(codeUnit);
      };
      for (let offset = 0; offset < sourceBytes.length; offset += 16) {
        const chunk = sourceBytes.subarray(offset, Math.min(offset + 16, sourceBytes.length));
        const hex = Array.from(chunk, value => value.toString(16).padStart(2, '0').toUpperCase()).join(' ').padEnd(47, ' ');
        const ascii = Array.from(chunk, printable).join('').padEnd(16, ' ');
        let utf16 = '';
        let utf16Shifted = '';
        for (let index = 0; index < 16; index += 2) {
          const low = sourceBytes[offset + index];
          const high = sourceBytes[offset + index + 1];
          utf16 += low === undefined || high === undefined ? ' ' : unicodeUnit(low, high);
          const shiftedLow = sourceBytes[offset + index + 1];
          const shiftedHigh = sourceBytes[offset + index + 2];
          utf16Shifted += shiftedLow === undefined || shiftedHigh === undefined ? ' ' : unicodeUnit(shiftedLow, shiftedHigh);
        }
        lines.push(offset.toString(16).toUpperCase().padStart(8, '0') + '  ' + hex + '  ' + ascii + '  ' + utf16 + '  ' + utf16Shifted);
      }
      await writeFile(selection.filePath, lines.join('\r\n') + '\r\n', 'utf-8');
      return { success: true, data: undefined };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, errorMessage: 'HEX export failed: ' + message };
    }
  };

  @IpcHandler({ name: 'FileSystem.writeText' })
  readonly writeText = async (_: IpcMainInvokeEvent, path: string, content: string): Promise<ApiResponse<undefined>> => {
    try {
      await writeFile(path, content, { encoding: 'utf-8', flag: 'w' });
      return { success: true, data: undefined };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, errorMessage: `Failed to write file ${path}: ${message}` };
    }
  };

  @IpcHandler({ name: 'FileSystem.readJson' })
  readonly readJson = async <T>(_: IpcMainInvokeEvent, path: string): Promise<ApiResponse<T>> => {
    try {
      const result = await readFile(path, 'utf-8');
      return { success: true, data: JSON.parse(result) };
    } catch (_) {
      return { success: false, errorMessage: `Failed to read file ${path}.` };
    }
  };

  @IpcHandler({ name: 'FileSystem.writeJson' })
  readonly writeJson = async <T>(_: IpcMainInvokeEvent, path: string, data: T): Promise<ApiResponse<undefined>> => {
    try {
      await writeJsonAtomically(path, data);
      return { success: true, data: undefined };
    } catch (_) {
      return { success: false, errorMessage: `Failed to write file ${path}.` };
    }
  };

  @IpcHandler({ name: 'FileSystem.readGalleryLocation' })
  readonly readGalleryLocation = async (_: IpcMainInvokeEvent, path: string): Promise<ApiResponse<FileInfo[]>> => {
    try {
      return { success: true, data: await this.readGalleryDir(path) };
    } catch (_) {
      return { success: false, errorMessage: `Failed to read gallery at ${path}.` };
    }
  };

  @IpcHandler({ name: 'FileSystem.readDirectories' })
  readonly readDirectories = async (_: IpcMainInvokeEvent, path: string): Promise<ApiResponse<FileInfo[]>> => {
    const startedAt = Date.now();
    console.log('[FileSystem.readDirectories] START', JSON.stringify({ path, startedAt: formatOsDateTime(startedAt) }));

    try {
      const entries = (await readdir(path, { withFileTypes: true }))
        .filter(file => file.isDirectory() && ![ '.cache', '.thumbnails' ].includes(file.name.toLowerCase()));

      // Keep directory metadata lookups asynchronous; statSync here can freeze the Electron main process.
      const directories = await Promise.all(entries.map(async file => {
        const directoryPath = join(path, file.name);
        const stats = await stat(directoryPath);

        return {
          path: directoryPath,
          name: file.name,
          parent: path,
          isDirectory: true,
          ext: extname(file.name),
          createdAt: stats.birthtimeMs,
          size: stats.size,
          modifiedAt: stats.mtimeMs
        } satisfies FileInfo;
      }));

      const data = directories.sort(this.sortByNameAsc);
      console.log('[FileSystem.readDirectories] DONE', JSON.stringify({
        path,
        count: data.length,
        durationMs: Date.now() - startedAt
      }));

      return { success: true, data };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[FileSystem.readDirectories] ERROR', JSON.stringify({
        path,
        durationMs: Date.now() - startedAt,
        error: message
      }));
      return { success: false, errorMessage: `Failed to read directory at ${path}.` };
    }
  };

    @IpcHandler({ name: 'FileSystem.prepareGalleryLocation' })
  readonly prepareGalleryLocation = async (_: IpcMainInvokeEvent, path: string): Promise<ApiResponse<undefined>> => {
    let testFile: string | null = null;
    let handle: Awaited<ReturnType<typeof open>> | null = null;

    try {
      const directoryStats = await stat(path);
      if (!directoryStats.isDirectory()) {
        return { success: false, errorMessage: 'The selected path is not a directory.' };
      }

      // Create the sidecar cache folder now so read-only media is rejected
      // before it is added to the gallery.
      const cacheDirectory = join(path, '.cache');
      await mkdir(cacheDirectory, { recursive: true });

      testFile = join(cacheDirectory, `.write-test-${process.pid}-${Date.now()}`);
      handle = await open(testFile, 'wx');
      await handle.close();
      handle = null;
      await unlink(testFile);
      testFile = null;

      return { success: true, data: undefined };
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      if (testFile) await unlink(testFile).catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        errorMessage: `This folder cannot be added to the gallery because Light Matter cannot create or write to its .cache folder. Choose a writable folder. Details: ${message}`
      };
    }
  };

  @IpcHandler({ name: 'FileSystem.readImages' })
  readonly readImages = async (
    _: IpcMainInvokeEvent,
    path: string,
    sortBy: SortType,
    sortDir: SortDirection,
    includeUnsupported = false,
    recursive = false
  ): Promise<ApiResponse<FileInfo[]>> => {
    const startedAt = Date.now();
    console.log('[FileSystem.readImages] START', JSON.stringify({ path, sortBy, sortDir, includeUnsupported, recursive }));
    try {
      const pendingDirectories = [path];
      const fileEntries: Array<{ name: string; parent: string }> = [];
      const enumerationStartedAt = performance.now();
      let directoriesRead = 0;
      while (pendingDirectories.length > 0) {
        const currentDirectory = pendingDirectories.pop()!;
        const entries = await readdir(currentDirectory, { withFileTypes: true });
        directoriesRead++;
        for (const entry of entries) {
          if (entry.isDirectory()) {
            if (recursive && !['.cache', '.thumbnails'].includes(entry.name.toLowerCase())) {
              pendingDirectories.push(join(currentDirectory, entry.name));
            }
            continue;
          }
          if (!entry.isFile()) continue;
          const extension = extname(entry.name).toLowerCase().replace('.', '');
          if (includeUnsupported || supportedFileExtensions.includes(extension)) {
            fileEntries.push({ name: entry.name, parent: currentDirectory });
          }
        }
      }

      const enumerationDurationMs = performance.now() - enumerationStartedAt;
      const statStartedAt = performance.now();
      // Do not block Electron's main process with thousands of synchronous statSync calls.
      const files: FileInfo[] = [];
      for (let offset = 0; offset < fileEntries.length; offset += 256) {
        const batch = await Promise.all(fileEntries.slice(offset, offset + 256).map(async (file): Promise<FileInfo | null> => {
          try {
            const filePath = join(file.parent, file.name);
            const stats = await stat(filePath);
            return {
              path: filePath, name: file.name, parent: file.parent, isDirectory: false,
              ext: extname(file.name), createdAt: stats.birthtimeMs,
              size: stats.size, modifiedAt: stats.mtimeMs
            } satisfies FileInfo;
          } catch {
            return null;
          }
        }));
        files.push(...batch.filter((file): file is FileInfo => file !== null));
        if (offset + 256 < fileEntries.length) await new Promise<void>(resolveYield => setImmediate(resolveYield));
      }

      const statDurationMs = performance.now() - statStartedAt;
      const sortStartedAt = performance.now();
      let data: FileInfo[];
      if (sortBy === 'gpsDate' || sortBy === 'gps' || sortBy === 'location') {
        // The filesystem remains the sole source of the displayed file list.
        // Use existing per-drive DB metadata only as an optional sort index;
        // do not reconcile/register files as a side effect of browsing.
        let metadataByPath = new Map<string, { latitude: number | null; longitude: number | null; gpsTimestamp: number | null; displayName: string | null; fileSize?: number; modifiedAt?: number }>();
        try {
          const locations = await Injector.getInstance().inject('CacheManager')
            .getDirectoryPhotoLocations(undefined as never, path, recursive, false);
          metadataByPath = new Map(locations.map(item => [item.path.toLocaleLowerCase(), item]));
        } catch (error) {
          // Photo DB metadata is optional. A missing/unavailable DB must never
          // prevent the filesystem file list from being displayed.
          console.warn('[FileSystem.readImages] Photo DB sort metadata unavailable:', error);
        }
        const direction = sortDir === 'desc' ? -1 : 1;
        const pathOrder = (a: FileInfo, b: FileInfo): number =>
          a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' });
        const getCurrentMetadata = (file: FileInfo) => {
          const metadata = metadataByPath.get(file.path.toLocaleLowerCase());
          return metadata && metadata.fileSize === file.size && metadata.modifiedAt === file.modifiedAt
            ? metadata : undefined;
        };
        data = files.sort((a, b) => {
          const left = getCurrentMetadata(a);
          const right = getCurrentMetadata(b);
          if (sortBy === 'gpsDate') {
            const leftValue = left?.gpsTimestamp ?? null;
            const rightValue = right?.gpsTimestamp ?? null;
            if (leftValue === null || rightValue === null) {
              return leftValue === rightValue ? pathOrder(a, b) : leftValue === null ? 1 : -1;
            }
            return (leftValue - rightValue) * direction || pathOrder(a, b);
          }
          if (sortBy === 'gps') {
            const leftValid = left?.latitude !== null && left?.latitude !== undefined
              && left?.longitude !== null && left?.longitude !== undefined;
            const rightValid = right?.latitude !== null && right?.latitude !== undefined
              && right?.longitude !== null && right?.longitude !== undefined;
            if (!leftValid || !rightValid) return leftValid === rightValid ? pathOrder(a, b) : leftValid ? -1 : 1;
            const leftValue = left!.latitude! * 1000 + left!.longitude!;
            const rightValue = right!.latitude! * 1000 + right!.longitude!;
            return (leftValue - rightValue) * direction || pathOrder(a, b);
          }
          const leftName = left?.displayName?.trim() ?? '';
          const rightName = right?.displayName?.trim() ?? '';
          if (!leftName || !rightName) return leftName === rightName ? pathOrder(a, b) : leftName ? -1 : 1;
          return leftName.localeCompare(rightName, undefined, { numeric: true, sensitivity: 'base' }) * direction || pathOrder(a, b);
        });
      } else {
        data = files.sort(this.sortFiles(sortBy, sortDir));
      }
      const sortDurationMs = performance.now() - sortStartedAt;
      console.log('[FileSystem.readImages] DONE', JSON.stringify({
        path, count: data.length, directoriesRead, fileEntries: fileEntries.length,
        enumerationMs: Number(enumerationDurationMs.toFixed(1)), statMs: Number(statDurationMs.toFixed(1)),
        sortMs: Number(sortDurationMs.toFixed(1)), durationMs: Date.now() - startedAt
      }));
      return { success: true, data };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[FileSystem.readImages] ERROR', JSON.stringify({ path, durationMs: Date.now() - startedAt, error: message }));
      return { success: false, errorMessage: `Failed to read directory at ${path}.` };
    }
  };

  @IpcHandler({ name: 'FileSystem.copyFile' })
  readonly copyFile = async (_: IpcMainInvokeEvent, sourcePath: string, destinationDirectory: string): Promise<ApiResponse<undefined>> => {
    try {
      const destinationPath = join(destinationDirectory, sourcePath.split(/[\\/]/).pop() ?? '');
      await copyFile(sourcePath, destinationPath, 1);
      return { success: true, data: undefined };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, errorMessage: `Failed to copy file: ${message}` };
    }
  };

  @IpcHandler({ name: 'FileSystem.deleteFile' })
  readonly deleteFile = async (_: IpcMainInvokeEvent, path: string): Promise<ApiResponse<undefined>> => {
    try {
      await unlink(path);
      return { success: true, data: undefined };
    } catch (_) {
      return { success: false, errorMessage: `Failed to delete file ${path}.` };
    }
  };

  private readonly sortFiles = (sortBy: SortType, sortDir: SortDirection) => {
    switch (sortBy) {
      case 'date':
        return sortDir === 'asc' ? this.sortByModifiedDateAsc : this.sortByModifiedDateDesc;
      case 'size':
        return sortDir === 'asc' ? this.sortBySizeAsc : this.sortBySizeDesc;
      case 'name':
        return sortDir === 'asc' ? this.sortByNameAsc : this.sortByNameDesc;
      case 'path':
        return sortDir === 'asc'
          ? (a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' })
          : (a, b) => b.path.localeCompare(a.path, undefined, { numeric: true, sensitivity: 'base' });
      case 'suffix':
        return sortDir === 'asc'
          ? (a, b) => extname(a.name).localeCompare(extname(b.name)) || this.sortByNameAsc(a, b)
          : (a, b) => extname(b.name).localeCompare(extname(a.name)) || this.sortByNameDesc(a, b);
      case 'gpsDate':
      case 'gps':
      case 'location':
        return sortDir === 'asc' ? this.sortByModifiedDateAsc : this.sortByModifiedDateDesc;
    }
  };

  private readonly sortByNameAsc = (a: FileInfo, b: FileInfo): number => {
    if (a.name < b.name) {
      return -1;
    }

    if (a.name > b.name) {
      return 1;
    }

    return 0;
  };

  private readonly sortByNameDesc = (a: FileInfo, b: FileInfo): number => {
    if (b.name < a.name) {
      return -1;
    }

    if (b.name > a.name) {
      return 1;
    }

    return 0;
  };

  private readonly sortByModifiedDateAsc = (a: FileInfo, b: FileInfo): number => a.modifiedAt - b.modifiedAt;

  private readonly sortByModifiedDateDesc = (a: FileInfo, b: FileInfo): number => b.modifiedAt - a.modifiedAt;

  private readonly sortBySizeAsc = (a: FileInfo, b: FileInfo): number => a.size - b.size;

  private readonly sortBySizeDesc = (a: FileInfo, b: FileInfo): number => b.size - a.size;

  private readonly readGalleryDir = async (path: string): Promise<FileInfo[]> =>
    (await readdir(path, { withFileTypes: true }))
      .filter(file =>
        (file.isDirectory() && ![ '.cache', '.thumbnails' ].includes(file.name.toLowerCase()))
        || supportedFileExtensions.includes(extname(file.name).toLowerCase().replace('.', ''))
      )
      .map(this.toFileInfo)
      .sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) {
          return -1;
        }

        if (!a.isDirectory && b.isDirectory) {
          return 1;
        }

        return a.createdAt - b.createdAt;
      });

  private readonly toFileInfo = (file: Dirent): FileInfo => {
    const path = join(file.parentPath, file.name);
    const stats = statSync(path);

    return {
      path,
      name: file.name,
      parent: file.parentPath,
      isDirectory: file.isDirectory(),
      ext: extname(file.name),
      createdAt: stats.birthtimeMs,
      size: stats.size,
      modifiedAt: stats.mtimeMs
    };
  };
}
