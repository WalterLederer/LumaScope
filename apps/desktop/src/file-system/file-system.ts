import { IpcMainInvokeEvent } from 'electron';
import { ApiResponse, FileInfo, SortDirection, SortType, supportedFileExtensions } from 'internal-api';
import { Dirent, statSync } from 'node:fs';
import { copyFile, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { IpcHandler } from '../app/decorators/ipc-handler';
import { writeJsonAtomically } from './json-file';

export class FileSystem {
  @IpcHandler({ name: 'FileSystem.join' })
  readonly join = async (_: IpcMainInvokeEvent, ...paths: string[]): Promise<string> => join(...paths);

  @IpcHandler({ name: 'FileSystem.dirname' })
  readonly dirname = async (_: IpcMainInvokeEvent, fileName: string): Promise<string> => dirname(fileName);

  @IpcHandler({ name: 'FileSystem.readDir' })
  readonly readDir = async (_: IpcMainInvokeEvent, path: string): Promise<FileInfo[]> => {
    const result = await readdir(path, { withFileTypes: true });

    return result.map(this.toFileInfo);
  };

  @IpcHandler({ name: 'FileSystem.readText' })
  readonly readText = async (_: IpcMainInvokeEvent, path: string): Promise<ApiResponse<string>> => {
    try {
      return { success: true, data: await readFile(path, 'utf-8') };
    } catch (_) {
      return { success: false, errorMessage: `Failed to read file ${path}.` };
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
    console.log('[FileSystem.readDirectories] START', JSON.stringify({ path, startedAt: new Date(startedAt).toISOString() }));

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

  @IpcHandler({ name: 'FileSystem.readImages' })
  readonly readImages = async (
    _: IpcMainInvokeEvent,
    path: string,
    sortBy: SortType,
    sortDir: SortDirection
  ): Promise<ApiResponse<FileInfo[]>> => {
    const startedAt = Date.now();
    console.log('[FileSystem.readImages] START', JSON.stringify({ path, sortBy, sortDir }));
    try {
      const entries = (await readdir(path, { withFileTypes: true }))
        .filter(file =>
          file.isFile() && supportedFileExtensions.includes(extname(file.name).toLowerCase().replace('.', ''))
        );

      // Do not block Electron's main process with thousands of synchronous statSync calls.
      const files = await Promise.all(entries.map(async file => {
        const filePath = join(path, file.name);
        const stats = await stat(filePath);

        return {
          path: filePath,
          name: file.name,
          parent: path,
          isDirectory: false,
          ext: extname(file.name),
          createdAt: stats.birthtimeMs,
          size: stats.size,
          modifiedAt: stats.mtimeMs
        } satisfies FileInfo;
      }));

      const data = files.sort(this.sortFiles(sortBy, sortDir));
      console.log('[FileSystem.readImages] DONE', JSON.stringify({
        path,
        count: data.length,
        durationMs: Date.now() - startedAt
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
        return sortDir === 'asc' ? this.sortByCreatedDateAsc : this.sortByCreatedDateDesc;
      case 'size':
        return sortDir === 'asc' ? this.sortBySizeAsc : this.sortBySizeDesc;
      case 'name':
        return sortDir === 'asc' ? this.sortByNameAsc : this.sortByNameDesc;
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

  private readonly sortByCreatedDateAsc = (a: FileInfo, b: FileInfo): number => a.createdAt - b.createdAt;

  private readonly sortByCreatedDateDesc = (a: FileInfo, b: FileInfo): number => b.createdAt - a.createdAt;

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
