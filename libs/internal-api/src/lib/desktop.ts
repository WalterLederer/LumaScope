import type { Tags } from 'exiftool-vendored';
import { Arguments } from 'yargs';
import { FileInfo } from './fs';

export interface ExternalProcessCall {
  id: number;
  timestamp: number;
  programName: string;
  commandLine: string;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
}

export interface ProcessMemoryEntry {
  name: string;
  pid: number;
  kind: 'main' | 'app' | 'helper';
  workingSetBytes: number;
  privateBytes: number | null;
}

export interface ProcessMemorySnapshot {
  processes: ProcessMemoryEntry[];
  error: string | null;
}

export interface DesktopProcessManager {
  readonly getProcessMemoryUsage: () => Promise<ProcessMemorySnapshot>;
  readonly getAppVersion: () => Promise<string>;
  readonly getAppSettings: () => Promise<Record<string, unknown>>;
  readonly setAppSettingsSection: (section: string, values: Record<string, unknown>) => Promise<void>;
  readonly isPackaged: () => Promise<boolean>;
  readonly getDevToolsOpen: () => Promise<boolean>;
  readonly setDevToolsOpen: (open: boolean) => Promise<void>;
  readonly getPlatform: () => Promise<string>;
  readonly argv: () => Promise<Arguments>;
  readonly getSystemPaths: () => Promise<SystemPathMapping>;
  readonly openConfigFile: () => Promise<string>;
  readonly openExternal: (url: string) => Promise<void>;
  readonly quit: (code: number) => Promise<void>;
  readonly setWindowTitle: (title: string) => Promise<void>;
}

export interface DesktopFileSystem {
  readonly join: (...paths: string[]) => Promise<string>;
  readonly dirname: (fileName: string) => Promise<string>;
  readonly readDir: (path: string) => Promise<FileInfo[]>;
  readonly readText: (path: string) => Promise<ApiResponse<string>>;
  readonly readJson: <T>(path: string) => Promise<ApiResponse<T>>;
  readonly writeJson: <T>(path: string, data: T) => Promise<ApiResponse<undefined>>;
  /**
   * @deprecated Use readDirectories() and readImages() instead
   */
  readonly readGalleryLocation: (path: string) => Promise<ApiResponse<FileInfo[]>>;
  readonly readDirectories: (path: string) => Promise<ApiResponse<FileInfo[]>>;
  readonly prepareGalleryLocation: (path: string) => Promise<ApiResponse<undefined>>;
  readonly readImages: (path: string, sortBy: SortType, sortDir: SortDirection) => Promise<ApiResponse<FileInfo[]>>;
  readonly deleteFile: (path: string) => Promise<ApiResponse<undefined>>;
  readonly copyFile: (sourcePath: string, destinationDirectory: string) => Promise<ApiResponse<undefined>>;
}

export interface DesktopDialogs {
  readonly openFolder: (initialPath?: string) => Promise<ApiResponse<string>>;
}

export interface DesktopExif {
  readonly read: (path: string) => Promise<ApiResponse<ExifTags>>;
}

export interface CacheSummary {
  total: CacheClearResult;
  fullSize: CacheClearResult;
  thumbnails: CacheClearResult;
  sidecar: CacheClearResult;
  gps: CacheClearResult;
  databases: Array<{ path: string; bytes: number }>;
}

export type PhotoDatabaseRecord = Record<string, string | number | null>;

export interface ResolveLocationNamesResult {
  total: number;
  resolved: number;
  unresolved: number;
  cancelled?: boolean;
}

export interface BackgroundReverseGeocodingStatus {
  total: number;
  resolved: number;
  pending: number;
  inProgress: number;
  errors: number;
  status: 'running' | 'idle' | 'completed';
  currentFilePath: string | null;
  currentDisplayName: string | null;
}

export interface DesktopCacheManager {
  readonly getOsmAndTileCacheSummary: () => Promise<{ path: string; entries: number; bytes: number; available: boolean }>;
  readonly clear: (directory?: string, recursive?: boolean, operationId?: string) => Promise<CacheClearResult>;
  readonly clearFullSize: (directory?: string, recursive?: boolean, operationId?: string) => Promise<CacheClearResult>;
  readonly clearThumbnails: (directory?: string, recursive?: boolean, operationId?: string) => Promise<CacheClearResult>;
  readonly cancelClear: (operationId: string) => Promise<boolean>;
  readonly deleteImage: (sourceName: string) => Promise<CacheClearResult>;
  readonly cacheSize: () => Promise<number>;
  readonly getCacheSummary: () => Promise<CacheSummary>;
  readonly resolveMissingLocationNames: (directory: string, recursive?: boolean) => Promise<ResolveLocationNamesResult>;
  readonly cancelResolveMissingLocationNames: () => Promise<boolean>;
  readonly getBackgroundReverseGeocodingStatus: () => Promise<BackgroundReverseGeocodingStatus>;
  readonly cacheInfo: (directory?: string, recursive?: boolean) => Promise<CacheInfo>;
  readonly imageCachePath: (sourceName: string) => Promise<string | null>;
  readonly getImageCacheStatuses: (sourceNames: string[], verifyCacheFiles?: boolean, sourceMetadata?: Array<{ path: string; size: number; modifiedAt: number }>) => Promise<CacheImageStatus[]>;
  readonly getBuildLogPath: () => Promise<string>;
  readonly resetBuildLog: () => Promise<void>;
  readonly appendBuildLog: (line: string) => Promise<void>;
  readonly getDirectoryCacheStats: (sourceNames: string[], verifyCacheFiles?: boolean) => Promise<CacheDirectoryStats>;
  readonly getDirectoryPhotoLocations: (directory: string) => Promise<PhotoLocation[]>;
  readonly getPhotoDatabaseRecord: (sourceName: string) => Promise<PhotoDatabaseRecord | null>;
  readonly resolvePhotoLocation: (sourceName: string, latitude: number, longitude: number) => Promise<string | null>;
}

export interface PhotoLocation {
  path: string;
  fileName: string;
  latitude: number | null;
  longitude: number | null;
  displayName: string | null;
}

export interface CacheClearResult {
  entries: number;
  bytes: number;
  cancelled?: boolean;
}

export interface CacheDirectoryStats {
  total: number;
  thumbnails: number;
  fullSizeConversions: number;
  thumbnailPaths: string[];
  fullSizePaths: string[];
}

export interface CacheInfo extends CacheClearResult {
  fullSize: CacheClearResult;
  thumbnails: CacheClearResult;
}

export interface CacheEntryStatus {
  status: 'valid' | 'missing' | 'stale';
  path: string;
  storageType: 'sidecar' | 'parallel';
  sourceTag: string;
}

export interface CacheImageStatus {
  sourceName: string;
  thumbnail: CacheEntryStatus | null;
  fullSize: CacheEntryStatus | null;
  fullSizeRequired: boolean;
  latitude: number | null;
  longitude: number | null;
  verification?: { sourceChecked: boolean; thumbnailChecked: boolean; fullSizeChecked: boolean; invalidEntries: number };
}

export interface DesktopLoupe {
  readonly capture: () => Promise<{ width: number; height: number; x: number; y: number; contentX: number; contentY: number; windowWidth: number; windowHeight: number; scaleFactor: number }>;
  readonly region: (x: number, y: number, width: number, height: number) => Promise<{
    width: number; height: number; x: number; y: number;
    regionWidth: number; regionHeight: number; centerX: number; centerY: number; data: Uint16Array;
  } | null>;
  readonly sample: (x: number, y: number, radius?: number) => Promise<{
    width: number; height: number; x: number; y: number; radius: number;
    regionWidth: number; regionHeight: number; centerX: number; centerY: number; data: Uint16Array;
    center: { r: number; g: number; b: number; rHex: string; gHex: string; bHex: string; color: string };
    pixels: Array<{ x: number; y: number; color: string }>;
  } | null>;
  readonly release: () => Promise<void>;
  readonly onWindowGeometryChanged: (callback: () => void) => () => void;
}

export interface CaptureMonitor {
  index: number;
  name: string;
  deviceName: string;
  width: number;
  height: number;
  refreshRate: number;
  /** Windows advanced-color mode for this monitor, when available. */
  isHdr?: boolean;
}

export interface CaptureWindow {
  title: string;
  processName: string;
  /** Stable executable path, when provided by the native window enumerator. */
  executablePath?: string;
  processId: number;
  handle: number;
  width: number;
  height: number;
  /** Zero-based position in the native Windows Z-order (0 is frontmost). */
  zOrder: number;
  /** Whether this window passes the current Top Window selection filters. */
  isTopWindowCandidate: boolean;
  monitorIndex?: number;
  /** Win32 monitor device name (for example, \\.\DISPLAY1), when resolved. */
  monitorDeviceName?: string;
  /** Whether the window is currently minimized. */
  isMinimized?: boolean;
}

export interface CaptureSources {
  monitors: CaptureMonitor[];
  windows: CaptureWindow[];
  sourceErrors?: string[];
}

export type CaptureTarget =
  | { kind: 'monitor'; index: number }
  | { kind: 'window'; handle: number }
  | { kind: 'top-window'; includeAppWindows?: boolean }
  | { kind: 'rectangle' };

export interface CaptureResult {
  path: string;
  width: number;
  height: number;
}

export interface CapturePreview {
  width: number;
  height: number;
  /** Packed RGBA16F/scRGB pixels from the native HDR capture. */
  pixels: Uint16Array;
  /** Browser-decodable Ultra HDR JPEG used as the SDR readback reference. */
  sdrImage?: Uint8Array;
  /** Native source details for diagnosing Top Window selection. */
  sourceDetails?: string;
}

export type CaptureFormat = 'exr' | 'jxr' | 'uhdr' | 'clipboard';

export interface OfflineMapStatus { type?:'mbtiles'|'obf'; updateMatched?:boolean; id:string; available:boolean; enabled:boolean; filePath:string; fileName:string; fileSize:number; lastModified:number; name:string; format:string; minZoom:number; maxZoom:number; bounds:string|null; error:string|null; schema?:'shortbread'|'openmaptiles'; vectorLayers?:string[]; updateAvailable?:boolean|null; updateChecked?:boolean; updateDate?:string|null; updateSource?:string|null; }
export interface OfflineMapImportResult { maps:OfflineMapStatus[]; errors:string[]; }
export interface OfflineMapCatalogueFile { fileName:string; fileType:'obf'|'mbtiles'; dateMs:number|null; source:string; url:string; matched:boolean; }
export interface OfflineMapUpdateCheckResult { maps:OfflineMapStatus[]; checkedAt:string; filesFound:number; matchedMaps:number; unmatchedMaps:number; catalogueFiles:OfflineMapCatalogueFile[]; sourceErrors:string[]; }
export interface DesktopOfflineMap {
 readonly chooseFile:()=>Promise<OfflineMapImportResult>;
 readonly getMaps:()=>Promise<OfflineMapStatus[]>;
 readonly checkForUpdates:()=>Promise<OfflineMapUpdateCheckResult>;
 readonly removeFile:(id:string)=>Promise<OfflineMapStatus[]>;
 readonly setEnabled:(id:string,enabled:boolean)=>Promise<OfflineMapStatus[]>;
 readonly setAllEnabled:(enabled:boolean)=>Promise<OfflineMapStatus[]>;
 readonly getStatus:()=>Promise<OfflineMapStatus>;
 readonly selectForCoordinates:(latitude:number,longitude:number)=>Promise<OfflineMapStatus|null>;
}

export interface DesktopMapWindow {
  readonly getZoom: () => Promise<number>;
  readonly setZoom: (zoom: number) => Promise<void>;
  readonly open: (latitude: number | null, longitude: number | null, bearing?: number, imagePath?: string | null) => Promise<boolean>;
  readonly getLocation: () => Promise<{ latitude: number | null; longitude: number | null; bearing: number | null; imagePath: string | null }>;
  readonly close: () => Promise<void>;
  readonly isOpen: () => Promise<boolean>;
  readonly focus: () => Promise<boolean>;
  readonly setAlwaysOnTop: (enabled: boolean) => Promise<boolean>;
  readonly selectImage: (path: string) => Promise<boolean>;
  readonly onImageSelected: (callback: (path: string) => void) => () => void;
  readonly onStateChanged: (callback: (open: boolean) => void) => () => void;
  readonly onLocationChanged: (callback: (location: { latitude: number | null; longitude: number | null; bearing?: number | null; imagePath?: string | null }) => void) => () => void;
}

export interface DesktopMapOverlayWindow {
  readonly open: (latitude: number | null, longitude: number | null, bearing?: number, imagePath?: string | null) => Promise<boolean>;
  readonly close: () => Promise<void>;
  readonly isOpen: () => Promise<boolean>;
  readonly focus: () => Promise<boolean>;
  readonly setAlwaysOnTop: (enabled: boolean) => Promise<boolean>;
  readonly getBounds: () => Promise<{ x: number; y: number; width: number; height: number } | null>;
  readonly setBounds: (bounds: { x: number; y: number; width: number; height: number }) => Promise<boolean>;
  readonly onStateChanged: (callback: (open: boolean) => void) => () => void;
}

export interface DesktopCapturePreviewWindow {
  readonly open: () => Promise<boolean>;
  readonly close: () => Promise<void>;
  readonly isOpen: () => Promise<boolean>;
  readonly getFrame: () => Promise<CapturePreview | null>;
  readonly onStateChanged: (callback: (open: boolean) => void) => () => void;
  readonly onFrameChanged: (callback: (frame: CapturePreview) => void) => () => void;
}

export interface GlobalShortcutStatus {
  id: 'top-window' | 'rectangle';
  accelerator: string;
  active: boolean;
  error: string | null;
}

export interface DesktopCapture {
  readonly listSources: () => Promise<CaptureSources>;
  readonly chooseFolder: (initialPath?: string) => Promise<string | null>;
  readonly preview: (target: CaptureTarget) => Promise<CapturePreview>;
  readonly capture: (target: CaptureTarget, folder: string, format?: CaptureFormat, gammaCorrection?: number, encoderQuality?: number, previewFrame?: CapturePreview) => Promise<CaptureResult>;
  readonly copyPreviewToClipboard: (pngData: Uint8Array, playFeedback?: boolean) => Promise<CaptureResult>;
  readonly getGlobalShortcutStatus: () => Promise<GlobalShortcutStatus[]>;
  readonly onGlobalShortcutStatusChanged: (callback: (statuses: GlobalShortcutStatus[]) => void) => () => void;
  readonly onTopWindowClipboardHotkey: (callback: () => void) => () => void;
  readonly onRectangleClipboardHotkey: (callback: () => void) => () => void;
}

export interface DesktopHistogram {
  readonly calculate: (path: string) => Promise<ApiResponse<ImageHistogram>>;
}

export interface OsmAndTileResult {
  width: number;
  height: number;
  stride: number;
  pixels: Uint8Array;
  cacheHit: boolean;
}

export interface OsmAndRuntimeStatus {
  helperPath: string;
  helperAvailable: boolean;
  obfPath: string;
  obfPaths: string[];
  obfAvailable: boolean;
  resourcesPath: string;
  resourcesAvailable: boolean;
  stylePath: string;
  styleAvailable: boolean;
  cachePath: string;
}

export interface OsmAndRenderingStyle { fileName: string; label: string; selected: boolean; }

export interface DesktopOsmAnd {
  readonly getRuntimeStatus: () => Promise<OsmAndRuntimeStatus>;
  readonly getRenderingStyles: () => Promise<OsmAndRenderingStyle[]>;
  readonly setRenderingStyle: (fileName: string) => Promise<OsmAndRuntimeStatus>;
  readonly setResourcesPath: (resourcesPath: string) => Promise<OsmAndRuntimeStatus>;
  readonly renderTile: (z: number, x: number, y: number, forceRender?: boolean) => Promise<OsmAndTileResult>;
  readonly shutdown: () => Promise<void>;
}

export interface OsmAndAtlasTileResult {
  width: number;
  height: number;
  stride: number;
  pixels: Uint8Array;
  cacheHit: boolean;
  diagnostics?: {
    helperPath: string;
    geometryEnabled: boolean;
    nativeRender: boolean;
    forceRender: boolean;
    geometryMessages: string[];
  };
}

export interface OsmAndAtlasRuntimeStatus {
  helperPath: string;
  helperAvailable: boolean;
  obfPath: string;
  obfPaths: string[];
  obfAvailable: boolean;
  resourcesPath: string;
  resourcesAvailable: boolean;
  stylePath: string;
  styleAvailable: boolean;
}

export interface DesktopOsmAndAtlas {
  readonly getRuntimeStatus: () => Promise<OsmAndAtlasRuntimeStatus>;
  readonly getRenderingStyles: () => Promise<OsmAndRenderingStyle[]>;
  readonly setRenderingStyle: (fileName: string) => Promise<OsmAndAtlasRuntimeStatus>;
  readonly setResourcesPath: (resourcesPath: string) => Promise<OsmAndAtlasRuntimeStatus>;
  readonly renderTile: (z: number, x: number, y: number, displayScale?: number, forceRender?: boolean) => Promise<OsmAndAtlasTileResult>;
  readonly cancelRendering: () => Promise<void>;
  readonly shutdown: () => Promise<void>;
}

export interface Desktop {
  readonly ProcessManager: DesktopProcessManager;
  readonly Profiling: {
    readonly getExternalProcessCalls: () => Promise<ExternalProcessCall[]>;
    readonly onExternalProcessCall: (callback: (call: ExternalProcessCall) => void) => () => void;
  };
  readonly FileSystem: DesktopFileSystem;
  readonly Dialogs: DesktopDialogs;
  readonly Exif: DesktopExif;
  readonly CacheManager: DesktopCacheManager;
  readonly Histogram: DesktopHistogram;
  readonly Loupe: DesktopLoupe;
  readonly Capture: DesktopCapture;
  readonly MapWindow: DesktopMapWindow;
  readonly MapOverlayWindow: DesktopMapOverlayWindow;
  readonly OfflineMap: DesktopOfflineMap;
  readonly OsmAnd: DesktopOsmAnd;
  readonly OsmAndAtlas: DesktopOsmAndAtlas;
  readonly CapturePreviewWindow: DesktopCapturePreviewWindow;

  openFolder: () => Promise<FileListing>;
  openFile: () => Promise<FileListing>;
  openFileFromArgs: (fileName: string) => Promise<FileListing>;
  getPathForFile: (file: File) => string;
}

export interface Success<T> {
  success: true;
  data: T;
}

export interface Failure {
  success: false;
  errorMessage: string;
}

export interface FileListingData {
  folder: string;
  files: string[];
  selected?: string;
}

export type FileListing = Success<FileListingData> | Failure;

export type ApiResponse<T> = Success<T> | Failure;

export interface ImageHistogram {
  linear: {
    white: number[];
    red: number[];
    green: number[];
    blue: number[];
  };
  logarithmic: {
    white: number[];
    red: number[];
    green: number[];
    blue: number[];
  };
  /** Upper bound of the displayed luminance range, based on this image's actual peak. */
  maximumNits: number;
  /** Lower bound of the logarithmic luminance range. */
  minimumLogNits: number;
  /** True only when the JPEG decoder successfully applied an embedded Ultra HDR gain map. */
  hasGainmap?: boolean;
}

export const appProtocol = 'atom';

export const appConfigName = 'LumaScope.config.json';

export const appPaths = {
  thumbs: '/thumbs',
  raw: '/raw',
  histogram: '/histogram',
  conversionTime: '/conversion-time',
  offlineTiles: '/offline-tiles'
};

export type SystemPath =
  | 'home'
  | 'appData'
  | 'userData'
  | 'temp'
  | 'exe'
  | 'desktop'
  | 'documents'
  | 'downloads'
  | 'music'
  | 'pictures'
  | 'videos'
  | 'recent'
  | 'appConfig';

export type SystemPathMapping = Record<SystemPath, string>;

export const supportedFileFormats = [
  {
    name: 'AVIF',
    extensions: [ 'avif' ],
    hdr: true,
    fullSizeCache: true,
    bitDepth: '8, 10 or 12 bit/channel',
    details: 'HDR preview for Rec. 2020 PQ and HLG profiles.'
  },
  {
    name: 'BMP',
    extensions: [ 'bmp' ],
    hdr: false,
    fullSizeCache: false,
    bitDepth: '1, 4, 8, 16, 24 or 32 bit/pixel',
    details: 'Raster bitmap format.'
  },
  {
    name: 'GIF',
    extensions: [ 'gif' ],
    hdr: false,
    fullSizeCache: false,
    bitDepth: 'Up to 8 bit indexed color',
    details: 'Palette-based raster format; animation is supported by the image viewer.'
  },
  {
    name: 'HEIF / HEIC',
    extensions: [ 'heif', 'heic' ],
    hdr: true,
    fullSizeCache: true,
    bitDepth: '8 bit SDR; HDR 10 bit and above',
    details: 'HDR preview for Rec. 2020 PQ and HLG profiles.'
  },
  {
    name: 'JPEG',
    extensions: [ 'jpg', 'jpeg' ],
    hdr: false,
    fullSizeCache: false,
    bitDepth: '8 bit/channel',
    details: 'Raster image, usually SDR.'
  },
  {
    name: 'JPEG XL',
    extensions: [ 'jxl' ],
    hdr: true,
    fullSizeCache: false,
    bitDepth: '8–16 bit integer; 16/32 bit float',
    details: 'Supports high bit depth and HDR where the file and decoder expose it.'
  },
  {
    name: 'JPEG XR',
    extensions: [ 'jxr' ],
    hdr: true,
    fullSizeCache: true,
    bitDepth: '8/16 bit integer; 16/32 bit float',
    details: 'High bit depth and floating-point images are converted through the HDR display path.'
  },
  {
    name: 'OpenEXR',
    extensions: [ 'exr' ],
    hdr: true,
    fullSizeCache: true,
    bitDepth: '16 bit half or 32 bit float',
    details: 'HDR; the viewer currently uses the standard RGB channels.'
  },
  {
    name: 'PNG',
    extensions: [ 'png' ],
    hdr: true,
    fullSizeCache: false,
    bitDepth: '1/2/4/8/16 bit/channel',
    details: 'Lossless raster format with transparency and HDR support for high bit-depth images.'
  },
  {
    name: 'Radiance HDR',
    extensions: [ 'hdr' ],
    hdr: true,
    fullSizeCache: true,
    bitDepth: '32 bit RGBE per pixel',
    details: 'HDR RGBE data is expanded to floating-point RGB for display.'
  },
  {
    name: 'SVG',
    extensions: [ 'svg' ],
    hdr: false,
    fullSizeCache: false,
    bitDepth: 'Not applicable',
    details: 'Vector graphics; rasterized for display at the required size.'
  },
  {
    name: 'TIFF',
    extensions: [ 'tif', 'tiff' ],
    hdr: true,
    fullSizeCache: true,
    bitDepth: 'Depends on file; common 8/16 bit integer and float variants',
    details: '16-bit HDR TIFF images use the HDR display path; other TIFFs are converted for display.'
  },
  {
    name: 'Ultra HDR JPEG',
    extensions: [ 'jpg', 'jpeg' ],
    hdr: true,
    fullSizeCache: false,
    bitDepth: '8 bit base image + HDR gain map',
    details: 'JPEG with an embedded gain map; HDR is displayed when the image contains a supported gain map.'
  },
  {
    name: 'WebP',
    extensions: [ 'webp' ],
    hdr: false,
    fullSizeCache: false,
    bitDepth: '8 bit/channel',
    details: 'Lossy or lossless raster format with transparency and animation.'
  }
] as const;

export const supportedFileExtensions: string[] = [ ...new Set(
  supportedFileFormats.flatMap(format => [ ...format.extensions ])
) ];

export type ExifTags =
  & Tags
  & {
    ImagePixelDepth?: string;
    ChromaFormat?: string;
  };

export const allSortTypes = [ 'date', 'name', 'size' ] as const;
export type SortType = typeof allSortTypes[number];

export const allSortDirections = [ 'desc', 'asc' ] as const;
export type SortDirection = typeof allSortDirections[number];
