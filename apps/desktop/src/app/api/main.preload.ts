import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { Desktop, ExternalProcessCall, SortDirection, SortType } from 'internal-api';

const api: Desktop = {
  ProcessManager: {
    getAppVersion: () => ipcRenderer.invoke('ProcessManager.getAppVersion'),
    isPackaged: () => ipcRenderer.invoke('ProcessManager.isPackaged'),
    getDevToolsOpen: () => ipcRenderer.invoke('ProcessManager.getDevToolsOpen'),
    setDevToolsOpen: (open: boolean) => ipcRenderer.invoke('ProcessManager.setDevToolsOpen', open),
    getPlatform: () => ipcRenderer.invoke('ProcessManager.getPlatform'),
    argv: () => ipcRenderer.invoke('ProcessManager.argv'),
    getSystemPaths: () => ipcRenderer.invoke('ProcessManager.getSystemPaths'),
    openConfigFile: () => ipcRenderer.invoke('ProcessManager.openConfigFile'),
    quit: (code: number) => ipcRenderer.invoke('ProcessManager.quit', code),
    setWindowTitle: (title: string) => ipcRenderer.invoke('ProcessManager.setWindowTitle', title)
  },

  Profiling: {
    getExternalProcessCalls: () => ipcRenderer.invoke('Profiling.getExternalProcessCalls'),
    onExternalProcessCall: (callback: (call: ExternalProcessCall) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, call: ExternalProcessCall): void => callback(call);
      ipcRenderer.on('Profiling.externalProcessCall', listener);
      return () => ipcRenderer.removeListener('Profiling.externalProcessCall', listener);
    }
  },

  FileSystem: {
    join: (...paths: string[]) => ipcRenderer.invoke('FileSystem.join', ...paths),
    dirname: (fileName: string) => ipcRenderer.invoke('FileSystem.dirname', fileName),
    readDir: (path: string) => ipcRenderer.invoke('FileSystem.readDir', path),
    readText: (path: string) => ipcRenderer.invoke('FileSystem.readText', path),
    readJson: (path: string) => ipcRenderer.invoke('FileSystem.readJson', path),
    writeJson: <T>(path: string, data: T) => ipcRenderer.invoke('FileSystem.writeJson', path, data),
    readGalleryLocation: (path: string) => ipcRenderer.invoke('FileSystem.readGalleryLocation', path),
    readDirectories: (path: string) => ipcRenderer.invoke('FileSystem.readDirectories', path),
    prepareGalleryLocation: (path: string) => ipcRenderer.invoke('FileSystem.prepareGalleryLocation', path),
    readImages: (path: string, sortBy: SortType, sortDir: SortDirection) =>
      ipcRenderer.invoke('FileSystem.readImages', path, sortBy, sortDir),
    deleteFile: (path: string) => ipcRenderer.invoke('FileSystem.deleteFile', path),
    copyFile: (sourcePath: string, destinationDirectory: string) =>
      ipcRenderer.invoke('FileSystem.copyFile', sourcePath, destinationDirectory)
  },

  Dialogs: {
    openFolder: (initialPath?: string) => ipcRenderer.invoke('Dialogs.openFolder', initialPath)
  },

  Exif: {
    read: (path: string) => ipcRenderer.invoke('Exif.read', path)
  },

  CacheManager: {
    clear: (directory?: string, recursive = false, operationId?: string) => ipcRenderer.invoke('CacheManager.clear', directory, recursive, operationId),
    clearFullSize: (directory?: string, recursive = false, operationId?: string) => ipcRenderer.invoke('CacheManager.clearFullSize', directory, recursive, operationId),
    clearThumbnails: (directory?: string, recursive = false, operationId?: string) => ipcRenderer.invoke('CacheManager.clearThumbnails', directory, recursive, operationId),
    cancelClear: (operationId: string) => ipcRenderer.invoke('CacheManager.cancelClear', operationId),
    deleteImage: (sourceName: string) => ipcRenderer.invoke('CacheManager.deleteImage', sourceName),
    cacheSize: () => ipcRenderer.invoke('CacheManager.cacheSize'),
    getCacheSummary: () => ipcRenderer.invoke('CacheManager.getCacheSummary'),
    resolveMissingLocationNames: (directory: string, recursive = false) => ipcRenderer.invoke('CacheManager.resolveMissingLocationNames', directory, recursive),
    getBackgroundReverseGeocodingStatus: () => ipcRenderer.invoke('CacheManager.getBackgroundReverseGeocodingStatus'),
    cacheInfo: (directory?: string, recursive = false) => ipcRenderer.invoke('CacheManager.cacheInfo', directory, recursive),
    imageCachePath: (sourceName: string) => ipcRenderer.invoke('CacheManager.imageCachePath', sourceName),
    getImageCacheStatuses: (sourceNames: string[], verifyCacheFiles?: boolean, sourceMetadata?: Array<{ path: string; size: number; modifiedAt: number }>) => ipcRenderer.invoke('CacheManager.getImageCacheStatuses', sourceNames, verifyCacheFiles, sourceMetadata),
    getBuildLogPath: () => ipcRenderer.invoke('CacheManager.getBuildLogPath'),
    resetBuildLog: () => ipcRenderer.invoke('CacheManager.resetBuildLog'),
    appendBuildLog: (line: string) => ipcRenderer.invoke('CacheManager.appendBuildLog', line),
    getDirectoryCacheStats: (sourceNames: string[], verifyCacheFiles?: boolean) => ipcRenderer.invoke('CacheManager.getDirectoryCacheStats', sourceNames, verifyCacheFiles),
    getDirectoryPhotoLocations: (directory: string) => ipcRenderer.invoke('CacheManager.getDirectoryPhotoLocations', directory),
    getPhotoDatabaseRecord: (sourceName: string) => ipcRenderer.invoke('CacheManager.getPhotoDatabaseRecord', sourceName),
    resolvePhotoLocation: (sourceName: string, latitude: number, longitude: number) => ipcRenderer.invoke('CacheManager.resolvePhotoLocation', sourceName, latitude, longitude)
  },

  Histogram: {
    calculate: (path: string) => ipcRenderer.invoke('Histogram.calculate', path)
  },

  Loupe: {
    capture: () => ipcRenderer.invoke('Loupe.capture'),
    sample: (x: number, y: number, radius?: number) => ipcRenderer.invoke('Loupe.sample', x, y, radius),
    region: (x: number, y: number, width: number, height: number) => ipcRenderer.invoke('Loupe.region', x, y, width, height),
    release: () => ipcRenderer.invoke('Loupe.release'),
    onWindowGeometryChanged: (callback: () => void) => {
      const listener = (): void => callback();
      ipcRenderer.on('Loupe.windowGeometryChanged', listener);
      return () => ipcRenderer.removeListener('Loupe.windowGeometryChanged', listener);
    }
  },

  MapWindow: {
    open: (latitude: number | null, longitude: number | null, bearing?: number, imagePath?: string | null) => ipcRenderer.invoke('MapWindow.open', latitude, longitude, bearing, imagePath),
    getLocation: () => ipcRenderer.invoke('MapWindow.getLocation') as Promise<{ latitude: number | null; longitude: number | null; bearing: number | null; imagePath: string | null }>,
    close: () => ipcRenderer.invoke('MapWindow.close'),
    isOpen: () => ipcRenderer.invoke('MapWindow.isOpen'),
    focus: () => ipcRenderer.invoke('MapWindow.focus'),
    setAlwaysOnTop: (enabled: boolean) => ipcRenderer.invoke('MapWindow.setAlwaysOnTop', enabled),
    selectImage: (path: string) => ipcRenderer.invoke('MapWindow.selectImage', path),
    onImageSelected: (callback: (path: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, path: string): void => callback(path);
      ipcRenderer.on('MapWindow.imageSelected', listener);
      return () => ipcRenderer.removeListener('MapWindow.imageSelected', listener);
    },
    onStateChanged: (callback: (open: boolean) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, open: boolean): void => callback(open);
      ipcRenderer.on('MapWindow.stateChanged', listener);
      return () => ipcRenderer.removeListener('MapWindow.stateChanged', listener);
    },
    onLocationChanged: (callback: (location: { latitude: number | null; longitude: number | null; bearing?: number | null; imagePath?: string | null }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, location: { latitude: number | null; longitude: number | null; bearing?: number | null; imagePath?: string | null }): void => callback(location);
      ipcRenderer.on('MapWindow.locationChanged', listener);
      return () => ipcRenderer.removeListener('MapWindow.locationChanged', listener);
    }
  },

  CapturePreviewWindow: {
    open: () => ipcRenderer.invoke('CapturePreviewWindow.open'),
    close: () => ipcRenderer.invoke('CapturePreviewWindow.close'),
    isOpen: () => ipcRenderer.invoke('CapturePreviewWindow.isOpen'),
    getFrame: () => ipcRenderer.invoke('CapturePreviewWindow.getFrame'),
    onStateChanged: (callback: (open: boolean) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, open: boolean): void => callback(open);
      ipcRenderer.on('CapturePreviewWindow.stateChanged', listener);
      return () => ipcRenderer.removeListener('CapturePreviewWindow.stateChanged', listener);
    },
    onFrameChanged: (callback: (frame: { width: number; height: number; pixels: Uint16Array }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, frame: { width: number; height: number; pixels: Uint16Array }): void => callback(frame);
      ipcRenderer.on('CapturePreviewWindow.frameChanged', listener);
      return () => ipcRenderer.removeListener('CapturePreviewWindow.frameChanged', listener);
    }
  },

  Capture: {
    listSources: () => ipcRenderer.invoke('Capture.listSources'),
    chooseFolder: (initialPath?: string) => ipcRenderer.invoke('Capture.chooseFolder', initialPath),
    preview: target => ipcRenderer.invoke('Capture.preview', target),
    capture: (target, folder: string, format?: 'exr' | 'jxr' | 'uhdr' | 'clipboard', gammaCorrection?: number, encoderQuality?: number, previewFrame?: import('internal-api').CapturePreview) => ipcRenderer.invoke('Capture.capture', target, folder, format, gammaCorrection, encoderQuality, previewFrame),
    copyPreviewToClipboard: (pngData: Uint8Array, playFeedback = true) => ipcRenderer.invoke('Capture.copyPreviewToClipboard', pngData, playFeedback),
    getGlobalShortcutStatus: () => ipcRenderer.invoke('Capture.getGlobalShortcutStatus'),
    onGlobalShortcutStatusChanged: (callback: (statuses: import('internal-api').GlobalShortcutStatus[]) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, statuses: import('internal-api').GlobalShortcutStatus[]): void => callback(statuses);
      ipcRenderer.on('Capture.globalShortcutStatusChanged', listener);
      return () => ipcRenderer.removeListener('Capture.globalShortcutStatusChanged', listener);
    },
    onTopWindowClipboardHotkey: (callback: () => void) => {
      const listener = (): void => callback();
      ipcRenderer.on('Capture.topWindowClipboardHotkey', listener);
      return () => ipcRenderer.removeListener('Capture.topWindowClipboardHotkey', listener);
    },
    onRectangleClipboardHotkey: (callback: () => void) => {
      const listener = (): void => callback();
      ipcRenderer.on('Capture.rectangleClipboardHotkey', listener);
      return () => ipcRenderer.removeListener('Capture.rectangleClipboardHotkey', listener);
    }
  },

  // TODO: Deprecated methods, should be moved into a handler class in the future
  openFolder: () => ipcRenderer.invoke('openFolder'),
  openFile: () => ipcRenderer.invoke('openFile'),
  openFileFromArgs: (fileName: string) => ipcRenderer.invoke('openFileFromArgs', fileName),
  getPathForFile: (file: File) => webUtils.getPathForFile(file)
};

contextBridge.exposeInMainWorld('desktop', api);
