import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, input, output, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { BackgroundReverseGeocodingStatus, CacheClearResult, CacheInfo, CacheSummary, ExternalProcessCall, GlobalShortcutStatus, supportedFileFormats } from 'internal-api';
import { CacheManager } from '../../../ipc/cache-manager';
import { ThemeService } from '../../../system/services/theme/theme.service';
import { ProcessManager } from '../../../ipc/process-manager';
import { ByteSizePipe } from '../../../ui/pipes/byte-size/byte-size.pipe';

@Component({
  selector: 'app-settings-panel',
  imports: [
    ByteSizePipe,
    DatePipe
  ],
  templateUrl: './settings-dialog.component.html',
  styleUrl: './settings-dialog.component.scss',
  host: { '[class.busy]': 'isClearing()' },
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SettingsPanelComponent {
  readonly mode = input<'all' | 'general' | 'cache' | 'help'>('all');
  readonly cacheBuildActive = input(false);
  readonly cacheBuildProgress = input({ completed: 0, total: 0 });
  readonly cacheBuildCurrentOperation = input('');
  readonly currentFolderPath = input('');
  readonly verifyCacheFiles = input(false);
  readonly verifyCacheFilesChange = output<boolean>();
  readonly startCacheBuild = input<(() => void) | null>(null);
  readonly startRecursiveCacheBuild = input<(() => void) | null>(null);
  readonly cancelCacheBuild = input<(() => void) | null>(null);
  protected readonly cacheBuildLogPath = signal('');
  protected readonly recursiveBuild = signal(false);
  protected readonly cacheOutputMode = signal<'build' | 'check' | 'locations'>('build');
  protected readonly locationLookupActive = signal(false);
  protected readonly locationLookupCancelRequested = signal(false);
  protected readonly locationLookupOutput = signal('No location lookup has run yet.');
  protected readonly reverseGeocodingStatus = signal<BackgroundReverseGeocodingStatus>({
    total: 0, resolved: 0, pending: 0, inProgress: 0, errors: 0, status: 'idle', currentFilePath: null, currentDisplayName: null
  });
  protected readonly reverseGeocodingStatusError = signal<string | null>(null);
  protected readonly reverseGeocodingCompleted = computed(() =>
    this.reverseGeocodingStatus().resolved + this.reverseGeocodingStatus().errors
  );
  protected readonly runCacheBuild = (): void => {
    this.cacheOutputMode.set('build');
    this.cacheCheckLog.set([]);
    this.cacheCheckResult.set(null);
    this.cacheCheckError.set(null);
    if (this.recursiveBuild()) {
      this.startRecursiveCacheBuild()?.();
    } else {
      this.startCacheBuild()?.();
    }
  };
  protected readonly stopCacheBuild = (): void => this.cancelCacheBuild()?.();

  protected readonly resolveMissingLocations = async (): Promise<void> => {
    const directory = this.currentFolderPath().trim();
    if (!directory || this.locationLookupActive() || this.cacheBuildActive() || this.cacheCheckState() === 'checking' || this.isClearing()) return;

    const recursive = this.recursiveBuild();
    this.cacheOutputMode.set('locations');
    this.locationLookupActive.set(true);
    this.locationLookupCancelRequested.set(false);
    this.locationLookupOutput.set([
      'Reverse geocoding started',
      `Scope: ${recursive ? 'Current folder and all subfolders' : 'Current folder only'} · ${directory}`,
      'Processing photos with GPS coordinates and no location name…',
      'Requests are sent sequentially using the existing reverse-geocoding provider.'
    ].join('\n'));

    try {
      const result = await this.cacheManager.resolveMissingLocationNames(directory, recursive);
      this.locationLookupOutput.set([
        result.cancelled ? 'Reverse geocoding cancelled' : 'Reverse geocoding completed',
        `Scope: ${recursive ? 'Current folder and all subfolders' : 'Current folder only'} · ${directory}`,
        `Photos processed: ${result.total}`,
        `Location names resolved: ${result.resolved}`,
        `Unresolved / provider returned no result: ${result.unresolved}`
      ].join('\n'));
      await this.updateCacheSummary();
    } catch (error) {
      this.locationLookupOutput.set(`Reverse geocoding failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.locationLookupActive.set(false);
      this.locationLookupCancelRequested.set(false);
    }
  };

  protected readonly cancelLocationLookup = (): void => {
    if (!this.locationLookupActive() || this.locationLookupCancelRequested()) return;
    this.locationLookupCancelRequested.set(true);
    this.locationLookupOutput.update(output => `${output}\nCancellation requested. The current request will finish before processing stops.`);
    this.cacheManager.cancelResolveMissingLocationNames().catch(error => {
      this.reverseGeocodingStatusError.set(error instanceof Error ? error.message : String(error));
    });
  };
  /* DI */
  readonly cacheManager = inject(CacheManager);

  protected readonly themeService = inject(ThemeService);

  private readonly processManager = inject(ProcessManager);

  /* State */
  protected readonly cacheInfo = signal<CacheInfo>({ entries: 0, bytes: 0, fullSize: { entries: 0, bytes: 0 }, thumbnails: { entries: 0, bytes: 0 } });
  protected readonly buildCacheInfo = signal<CacheInfo>({ entries: 0, bytes: 0, fullSize: { entries: 0, bytes: 0 }, thumbnails: { entries: 0, bytes: 0 } });
  protected readonly cacheSummary = signal<CacheSummary>({
    total: { entries: 0, bytes: 0 }, fullSize: { entries: 0, bytes: 0 },
    thumbnails: { entries: 0, bytes: 0 }, sidecar: { entries: 0, bytes: 0 },
    gps: { entries: 0, bytes: 0 }, selectedDatabaseKey: null, databases: []
  });
  protected readonly selectedCacheDatabaseKey = signal<string | null>(null);
  protected readonly selectCacheDatabase = (databaseKey: string): void => {
    if (!databaseKey || !this.cacheSummary().databases.some(database => database.key === databaseKey)) return;
    this.selectedCacheDatabaseKey.set(databaseKey);
    void this.updateCacheSummary(databaseKey);
  };
  protected readonly cacheSummaryLoading = signal(false);
  protected readonly cacheSummaryError = signal<string | null>(null);
  private cacheSummaryRequestId = 0;

  private cacheInfoRequestId = 0;
  private buildCacheInfoRequestId = 0;

  protected readonly cacheCheckState = signal<'idle' | 'checking' | 'complete' | 'missing' | 'error'>('idle');
  protected readonly cacheCheckResult = signal<{ directory: string; recursive: boolean; images: number; missingThumbnails: string[]; missingFullSize: string[] } | null>(null);
  protected readonly cacheCheckError = signal<string | null>(null);
  protected readonly cacheCheckLog = signal<string[]>([]);
  protected readonly cacheCheckOutput = computed(() => {
    const lines = [...this.cacheCheckLog()];
    const result = this.cacheCheckResult();
    if (result) {
      lines.push(
        'Cache check completed',
        `Scope: ${result.recursive ? 'Current folder and all subfolders' : 'Current folder only'} · ${result.directory}`,
        `Images checked: ${result.images}`,
        `Missing thumbnails: ${result.missingThumbnails.length}`,
        `Missing full-size conversions: ${result.missingFullSize.length}`
      );
    }
    const error = this.cacheCheckError();
    if (error) lines.push(`Cache check failed: ${error}`);
    return lines.join('\n');
  });
  private cacheCheckRequestId = 0;

  protected readonly isClearing = signal(false);

  protected readonly deleteCacheGlobal = signal(false);

  protected readonly recursiveDelete = signal(false);

  protected readonly externalProcessCalls = signal<ExternalProcessCall[]>([]);

  protected readonly profilingError = signal<string | null>(null);

  protected readonly profilingSortColumn = signal<keyof Pick<ExternalProcessCall, 'timestamp' | 'programName' | 'commandLine' | 'durationMs'>>('timestamp');

  protected readonly profilingSortDirection = signal<'asc' | 'desc'>('desc');

  protected readonly externalPrograms = computed(() => {
    const programs = new Map<string, { programName: string; functions: Set<string> }>();
    for (const call of this.externalProcessCalls()) {
      const key = call.programName.toLowerCase();
      const entry = programs.get(key) ?? { programName: call.programName, functions: new Set<string>() };
      entry.functions.add(this.externalProgramFunction(call));
      programs.set(key, entry);
    }
    // These renderer processes are launched as persistent workers rather than
    // through the short-lived external-process wrapper, so seed them explicitly.
    const knownPrograms: Array<[string, string]> = [
      [
        'osmand_atlas_render_helper.exe',
        'C++ OsmAnd Atlas vector-map renderer (OsmAnd Core / Qt). Loads the selected .obf map files, the external OsmAnd resources and the selected rendering-style XML; renders 2×2 XYZ metatiles as RGBA pixels, applies the display-density scale and caches rendered metatiles on disk.'
      ],
      [
        'osmand_render_helper.exe',
        'C++ OsmAnd native map renderer used for Hillshade database tiles. Reads elevation data directly from the selected SQLite hillshade database and returns rendered raster tiles; it runs independently of the Atlas OBF renderer.'
      ],
      [
        'java.exe',
        'Java Mapsforge renderer (Mapsforge 0.25.0). Runs the bundled mapsforge-renderer.jar as a persistent worker, reads selected .map files and renders 256×256 vector-map tiles using either the selected external XML render theme or Mapsforge’s built-in default theme; Windows display density is applied to text and symbols.'
      ],
      [
        'jxr-wic-encoder.exe',
        'Encode an FP16 HDR capture as JPEG XR using the native Windows Imaging Component encoder.'
      ]
    ];
    for (const [programName, description] of knownPrograms) {
      const key = programName.toLowerCase();
      const entry = programs.get(key) ?? { programName, functions: new Set<string>() };
      entry.functions.add(description);
      programs.set(key, entry);
    }
    return [...programs.values()]
      .map(program => ({ programName: program.programName, function: [...program.functions].sort().join('; ') }))
      .sort((left, right) =>
        left.programName.localeCompare(right.programName, undefined, { sensitivity: 'base' })
      );
  });

  protected readonly windowsApiCalls = [
    { dll: 'user32.dll', api: 'EnumWindows', purpose: 'Enumerates top-level windows in Z-order; supplies the window handles used to build the capture-source list.' },
    { dll: 'user32.dll', api: 'IsWindow', purpose: 'Checks whether a previously selected HWND still identifies an existing window.' },
    { dll: 'user32.dll', api: 'IsWindowVisible', purpose: 'Filters out hidden top-level windows when discovering capture sources.' },
    { dll: 'user32.dll', api: 'IsIconic', purpose: 'Detects minimized windows so they are not offered as usable capture sources.' },
    { dll: 'user32.dll', api: 'GetWindowTextW', purpose: 'Reads the Unicode title of a window for the capture-source list and diagnostics.' },
    { dll: 'user32.dll', api: 'GetClassNameW', purpose: 'Reads the window class to exclude desktop, shell and other non-application windows.' },
    { dll: 'user32.dll', api: 'GetWindowThreadProcessId', purpose: 'Maps a window handle to its owning process ID.' },
    { dll: 'user32.dll', api: 'GetWindowRect', purpose: 'Reads window bounds; also serves as a fallback when DWM extended frame bounds are unavailable.' },
    { dll: 'user32.dll', api: 'GetWindow', purpose: 'Reads the owner window (GW_OWNER) to distinguish owned windows from top-level application windows.' },
    { dll: 'user32.dll', api: 'GetWindowLongPtrW', purpose: 'Reads extended window styles (GWL_EXSTYLE), including WS_EX_TOOLWINDOW filtering.' },
    { dll: 'user32.dll', api: 'MonitorFromWindow', purpose: 'Finds the monitor nearest to a selected window.' },
    { dll: 'user32.dll', api: 'MonitorFromRect', purpose: 'Finds the monitor nearest to an enumerated window rectangle.' },
    { dll: 'user32.dll', api: 'GetMonitorInfoW', purpose: 'Reads monitor and work-area bounds plus the Windows display-device name.' },
    { dll: 'user32.dll', api: 'SetProcessDpiAwarenessContext', purpose: 'Requests per-monitor-v2 DPI awareness before reading physical window and monitor coordinates.' },
    { dll: 'user32.dll', api: 'GetDisplayConfigBufferSizes', purpose: 'Queries the buffer sizes needed to enumerate the active Windows display paths and modes.' },
    { dll: 'user32.dll', api: 'QueryDisplayConfig', purpose: 'Reads the active display topology so monitor identifiers can be matched to their display configuration.' },
    { dll: 'user32.dll', api: 'DisplayConfigGetDeviceInfo (source name)', purpose: 'Retrieves the GDI display-device name for a display path.' },
    { dll: 'user32.dll', api: 'DisplayConfigGetDeviceInfo (advanced color)', purpose: 'Reads advanced-colour / HDR capability and active colour information for each display; includes the current and legacy packet versions.' },
    { dll: 'dwmapi.dll', api: 'DwmGetWindowAttribute', purpose: 'Reads DWMWA_EXTENDED_FRAME_BOUNDS for the visible window frame; GetWindowRect is used as fallback.' },
    { dll: 'kernel32.dll', api: 'OpenProcess', purpose: 'Opens the owning process with query-limited-information access when a window is large enough to be a useful capture source.' },
    { dll: 'kernel32.dll', api: 'QueryFullProcessImageNameW', purpose: 'Retrieves the executable path of the process that owns an enumerated window.' },
    { dll: 'kernel32.dll', api: 'CloseHandle', purpose: 'Releases process handles used during window enumeration and the duplicated stdout handle when the native Atlas helper shuts down.' },
    { dll: 'kernel32.dll', api: 'GetStdHandle', purpose: 'In the native C++ OsmAnd Atlas helper, obtains the original stdout and stderr handles for its binary frame protocol.' },
    { dll: 'kernel32.dll', api: 'GetCurrentProcess', purpose: 'Supplies the current-process pseudo-handle when duplicating the Atlas helper protocol output handle.' },
    { dll: 'kernel32.dll', api: 'DuplicateHandle', purpose: 'Keeps a dedicated copy of the Atlas helper’s original stdout handle for binary tile-frame output.' },
    { dll: 'kernel32.dll', api: 'SetStdHandle', purpose: 'Redirects the Atlas helper’s standard output to stderr so diagnostic text cannot corrupt the binary frame protocol.' },
    { dll: 'kernel32.dll', api: 'WriteFile', purpose: 'Writes the Atlas helper’s binary frame header and RGBA pixel payload to the preserved stdout handle.' },
    { dll: 'ole32.dll', api: 'CoInitializeEx / CoUninitialize', purpose: 'Initializes and releases the COM multithreaded apartment used by the native JPEG XR encoder.' },
    { dll: 'ole32.dll', api: 'CoCreateInstance', purpose: 'Creates the Windows Imaging Component (WIC) imaging factory used by the JPEG XR encoder.' },
    { dll: 'oleaut32.dll', api: 'VariantInit / VariantClear', purpose: 'Initializes and releases the VARIANT value used to pass JPEG XR encoder quality settings through WIC.' },
    { dll: 'Windows Imaging Component (COM)', api: 'IWICImagingFactory / IWICStream / IWICBitmapEncoder / IWICBitmapFrameEncode', purpose: 'Creates the output stream and JPEG XR encoder, configures image dimensions, pixel format and quality, writes FP16 pixel rows, and commits the encoded image.' }
  ] as const;

  private readonly externalProgramFunction = (call: ExternalProcessCall): string => {
    const program = call.programName.toLowerCase();
    const command = call.commandLine.toLowerCase();

    if (program === 'powershell.exe' || program === 'powershell') {
      if (command.includes('lightmatterwindowenumerator')) {
        return 'Enumerate visible application windows and read their executable paths';
      }
      if (command.includes('lightmatterexternalwindow')) {
        return 'Find the topmost visible application window for capture';
      }
      if (command.includes('lightmattercapturewindowstate')) {
        return 'Check whether the selected window exists and is minimized';
      }
      if (command.includes('lightmatterwindowgeometry')) {
        return 'Read window and monitor geometry for HDR capture';
      }
      return 'Run a Windows PowerShell script for Windows integration';
    }

    if (program === 'java.exe' || program === 'java') {
      if (command.includes('mapsforge-renderer.jar')) {
        return 'Java Mapsforge renderer (Mapsforge 0.25.0): loads .map vector data and an external XML render theme (or the built-in default), then renders 256×256 map tiles with display-density-aware labels and symbols';
      }
      return 'Run a Java application or worker process';
    }

    if (program === 'osmand_atlas_render_helper.exe') {
      return 'C++ OsmAnd Atlas vector-map renderer (OsmAnd Core / Qt): reads .obf maps, OsmAnd resources and rendering-style XML; produces RGBA 2×2 metatiles with display-density scaling and disk caching';
    }

    if (program === 'osmand_render_helper.exe') {
      return 'C++ OsmAnd Hillshade renderer: reads elevation data from SQLite hillshade databases and renders raster tiles independently of the Atlas OBF renderer';
    }

    if (program === 'jxr-wic-encoder.exe') {
      return 'Encode an FP16 HDR capture as JPEG XR using the native Windows Imaging Component encoder';
    }

    return 'Run an external helper process requested by the application';
  };

  protected readonly sortedExternalProcessCalls = computed(() => {
    const column = this.profilingSortColumn();
    const direction = this.profilingSortDirection();
    return [...this.externalProcessCalls()].sort((left, right) => {
      const a = left[column];
      const b = right[column];
      const comparison = typeof a === 'number' && typeof b === 'number'
        ? a - b
        : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
      return direction === 'asc' ? comparison : -comparison;
    });
  });

  protected readonly sortProfiling = (column: keyof Pick<ExternalProcessCall, 'timestamp' | 'programName' | 'commandLine' | 'durationMs'>): void => {
    if (this.profilingSortColumn() === column) {
      this.profilingSortDirection.set(this.profilingSortDirection() === 'asc' ? 'desc' : 'asc');
    } else {
      this.profilingSortColumn.set(column);
      this.profilingSortDirection.set(column === 'timestamp' || column === 'durationMs' ? 'desc' : 'asc');
    }
  };

  protected readonly profilingSortIndicator = (column: string): string =>
    this.profilingSortColumn() === column ? (this.profilingSortDirection() === 'asc' ? '▲' : '▼') : '↕';

  protected readonly devToolsOpen = signal(false);

  protected readonly debugImageSwitching = signal(this.readDebugImageSwitching());

  private readDebugImageSwitching(): boolean {
    try {
      return globalThis.localStorage.getItem('debugImageSwitching') === 'true';
    } catch {
      return false;
    }
  }

  protected readonly setDebugImageSwitching = (enabled: boolean) => {
    this.debugImageSwitching.set(enabled);
    try {
      globalThis.localStorage.setItem('debugImageSwitching', String(enabled));
    } catch {
      // The option remains active for this dialog session if storage is unavailable.
    }
  };

  protected readonly devToolsLoading = signal(true);

  protected readonly devToolsError = signal<string | null>(null);

  protected readonly configPath = signal('');

  protected readonly configFileError = signal<string | null>(null);

  protected readonly lastClearResult = signal<CacheClearResult | null>(null);

  protected readonly clearError = signal<string | null>(null);

  protected readonly deleteCacheSummary = signal('No cache deletion operation has run yet.');

  private activeDeleteOperationId: string | null = null;

  protected readonly deleteCancelRequested = signal(false);

  protected readonly cancelDeleteCache = (): void => {
    const operationId = this.activeDeleteOperationId;
    if (!operationId || this.deleteCancelRequested()) return;
    this.deleteCancelRequested.set(true);
    this.deleteCacheSummary.update(summary => `${summary}\nCancellation requested…`);
    this.cacheManager.cancelClear(operationId).catch(error => {
      this.clearError.set(error instanceof Error ? error.message : String(error));
    });
  };


  protected readonly supportedFormats = supportedFileFormats;
  protected readonly supportedMapFormats = [
    { name: 'Online map (XYZ tiles)', extensions: 'URL / XYZ tile endpoint', online: true, renderer: 'MapLibre', details: 'Online raster or vector tiles loaded from a tile-server URL; requires an internet connection.' },
    { name: 'MBTiles', extensions: '.mbtiles', online: false, renderer: 'LumaScope / MapLibre', details: 'Offline raster or vector tile database.' },
    { name: 'OsmAnd', extensions: '.obf', online: false, renderer: 'OsmAnd native renderer', details: 'Offline vector map data; labels depend on the selected OsmAnd renderer.' },
    { name: 'MapsForge', extensions: '.map', online: false, renderer: 'Mapsforge 0.25.0', details: 'Offline vector map data; visible detail depends on the selected XML render theme.' },
    { name: 'Hillshade database', extensions: '.sqlite', online: false, renderer: 'Hillshade', details: 'SQLite elevation database used to generate shaded-relief overlays; not a standalone base map.' }
  ] as const;

  protected readonly keyShortcuts = [
    { keys: 'Ctrl + Win + PrtScn', action: 'Copy the topmost visible window to the clipboard', global: true, id: 'top-window' as const },
    { keys: 'Ctrl + Shift + Win + PrtScn', action: 'Select a screen rectangle and copy it to the clipboard', global: true, id: 'rectangle' as const },
    { keys: 'Space / → / Page Down', action: 'Show the next image (when the location map is not under the pointer)', global: false, id: null },
    { keys: '← / Page Up', action: 'Show the previous image (when the location map is not under the pointer)', global: false, id: null },
    { keys: 'Esc', action: 'Close the image view or dismiss the active dialog', global: false, id: null },
    { keys: '+ / =', action: 'Zoom in; in the gallery, increase thumbnail size; over the location map, zoom the map in', global: false, id: null },
    { keys: '- / _', action: 'Zoom out; in the gallery, decrease thumbnail size; over the location map, zoom the map out', global: false, id: null },
    { keys: 'V', action: 'Cycle image comparison modes', global: false, id: null },
    { keys: 'L', action: 'Open the location window', global: false, id: null },
    { keys: 'C / F8', action: 'Copy the current image to the clipboard', global: false, id: null },
    { keys: 'S', action: 'Open the Screen Capture window', global: false, id: null },
    { keys: 'M', action: 'Toggle the magnifier (loupe)', global: false, id: null },
    { keys: 'H', action: 'Toggle the histogram', global: false, id: null },
    { keys: 'Delete', action: 'Delete the current image', global: false, id: null },
    { keys: 'F / F11', action: 'Toggle fullscreen mode', global: false, id: null }
  ] as const;

  protected readonly globalShortcutStatuses = signal<GlobalShortcutStatus[]>([]);
  protected readonly globalShortcutLoading = signal(true);
  protected readonly globalShortcutError = signal<string | null>(null);

  protected readonly globalShortcutStatusText = (id: GlobalShortcutStatus['id'] | null): string => {
    if (id === null) return '—';
    const status = this.globalShortcutStatuses().find(item => item.id === id);
    if (!status) return this.globalShortcutLoading() ? 'Checking…' : 'Unavailable';
    return status.active ? 'Active' : `Error: ${status.error ?? 'Registration failed'}`;
  };

  protected readonly globalShortcutStatusTitle = (id: GlobalShortcutStatus['id'] | null): string => {
    if (id === null) return 'This shortcut is handled inside the application.';
    const status = this.globalShortcutStatuses().find(item => item.id === id);
    return status?.error ?? (status?.active ? 'The global shortcut is registered and active.' : 'The global shortcut is not active.');
  };

  private readonly decoderFamilyFor = (extensions: readonly string[]): string => {
    const normalized = extensions.map(extension => extension.toLowerCase().replace(/^\\./, ''));
    if (normalized.includes('jxr')) return 'jpegxr';
    if (normalized.includes('avif') || normalized.includes('hdr') || normalized.includes('tif') || normalized.includes('tiff')) return 'wasm-vips/libvips';
    if (normalized.includes('heif') || normalized.includes('heic')) return 'libheif-js + wasm-vips';
    if (normalized.includes('exr')) return 'exrs';
    return 'Chromium / Electron';
  };

  protected readonly formatSummary = {
    hdr: supportedFileFormats.filter(format => format.hdr).length,
    sdr: supportedFileFormats.filter(format => !format.hdr).length,
    decoders: new Set(supportedFileFormats.map(format => this.decoderFamilyFor(format.extensions))).size
  };

  protected readonly decoderFor = (extensions: readonly string[]): string => {
    // supportedFileFormats stores extensions without a leading dot.
    const normalized = extensions.map(extension => extension.toLowerCase().replace(/^\\./, ''));

    if (normalized.some(extension => extension === 'jxr')) {
      return 'jpegxr + wasm-vips (HDR → scRGB/JPEG)';
    }
    if (normalized.some(extension => extension === 'avif')) {
      return 'wasm-vips/libvips (AVIF); custom PQ/HLG → scRGB for HDR';
    }
    if (normalized.some(extension => ['heif', 'heic'].includes(extension))) {
      return 'libheif-js + wasm-vips (custom PQ/HLG HDR path)';
    }
    if (normalized.some(extension => extension === 'exr')) {
      return 'exrs (EXR → scRGB/JPEG)';
    }
    if (normalized.some(extension => extension === 'hdr')) {
      return 'wasm-vips/libvips (Radiance HDR → scRGB/JPEG)';
    }
    if (normalized.some(extension => ['tif', 'tiff'].includes(extension))) {
      return 'wasm-vips/libvips (TIFF; custom HDR → scRGB/JPEG)';
    }

    return 'Chromium / Electron (native image decoder)';
  };

  /* Constructor */
  constructor() {
    const removeExternalProcessListener = window.desktop.Profiling.onExternalProcessCall(call => {
      this.externalProcessCalls.update(calls => [...calls, call]);
    });
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(removeExternalProcessListener);
    void this.refreshReverseGeocodingStatus();
    const reverseGeocodingTimer = setInterval(() => void this.refreshReverseGeocodingStatus(), 1000);
    destroyRef.onDestroy(() => clearInterval(reverseGeocodingTimer));
    const removeShortcutStatusListener = window.desktop.Capture.onGlobalShortcutStatusChanged(statuses => {
      this.globalShortcutStatuses.set(statuses);
      this.globalShortcutLoading.set(false);
      this.globalShortcutError.set(null);
    });
    destroyRef.onDestroy(removeShortcutStatusListener);
    this.loadGlobalShortcutStatus().then();
    this.loadExternalProcessCalls().then();
    effect(() => {
      const global = this.deleteCacheGlobal();
      const recursive = this.recursiveDelete();
      const directory = this.currentFolderPath().trim();
      void this.updateCacheInfo(global ? undefined : directory || null, !global && recursive);
    });
    effect(() => {
      const recursive = this.recursiveBuild();
      const directory = this.currentFolderPath().trim();
      void this.updateBuildCacheInfo(directory || null, recursive);
    });
    effect(() => {
      this.currentFolderPath();
      this.recursiveBuild();
      this.cacheCheckRequestId++;
      this.cacheCheckState.set('idle');
      this.cacheCheckResult.set(null);
      this.cacheCheckError.set(null);
      this.cacheCheckLog.set([]);
    });
    let cacheBuildWasActive = false;
    effect(() => {
      const active = this.cacheBuildActive();
      const operation = this.cacheBuildCurrentOperation();

      if (active) {
        cacheBuildWasActive = true;
        this.cacheCheckState.set('checking');
        return;
      }

      if (!cacheBuildWasActive) return;
      cacheBuildWasActive = false;

      if (/^Cache build completed\b/i.test(operation)) {
        this.cacheCheckState.set('complete');
        this.cacheCheckError.set(null);
      } else if (/^Cache build (?:cancelled|failed)\b/i.test(operation)) {
        this.cacheCheckState.set('error');
        this.cacheCheckError.set(operation.split('\n')[0]);
      }
    });
    effect(() => {
      const buildActive = this.cacheBuildActive();
      if (!buildActive) {
        const directory = this.currentFolderPath().trim();
        void this.updateBuildCacheInfo(directory || null, this.recursiveBuild());
      }
    });
    let previousSummaryDrive: string | null = null;
    effect(() => {
      const folder = this.currentFolderPath().trim();
      const drive = /^[a-z]:/i.test(folder) ? folder.slice(0, 2).toUpperCase() : null;
      if (!drive || drive === previousSummaryDrive) return;
      previousSummaryDrive = drive;
      this.selectedCacheDatabaseKey.set(drive);
      void this.updateCacheSummary(drive);
    });
    effect(() => {
      const buildActive = this.cacheBuildActive();
      const clearing = this.isClearing();
      this.cacheManager.cacheRevision();
      if (!buildActive && !clearing) void this.updateCacheSummary();
    });
    this.cacheManager.getBuildLogPath().then(path => this.cacheBuildLogPath.set(path)).catch(error => this.clearError.set(error instanceof Error ? error.message : String(error)));
    this.loadDevToolsSetting().then();
    this.loadConfigPath().then();
  }

  private readonly refreshReverseGeocodingStatus = async (): Promise<void> => {
    try {
      this.reverseGeocodingStatus.set(await this.cacheManager.getBackgroundReverseGeocodingStatus());
      this.reverseGeocodingStatusError.set(null);
    } catch (error) {
      this.reverseGeocodingStatusError.set(error instanceof Error ? error.message : String(error));
    }
  };

  private readonly loadGlobalShortcutStatus = async (): Promise<void> => {
    try {
      this.globalShortcutStatuses.set(await window.desktop.Capture.getGlobalShortcutStatus());
      this.globalShortcutError.set(null);
    } catch (error) {
      this.globalShortcutError.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.globalShortcutLoading.set(false);
    }
  };

  private readonly loadExternalProcessCalls = async (): Promise<void> => {
    try {
      const snapshot = await window.desktop.Profiling.getExternalProcessCalls();
      this.externalProcessCalls.update(current => {
        const calls = new Map<number, ExternalProcessCall>();
        current.forEach(call => calls.set(call.id, call));
        snapshot.forEach(call => calls.set(call.id, call));
        return [...calls.values()];
      });
      this.profilingError.set(null);
    } catch (error) {
      this.profilingError.set(error instanceof Error ? error.message : String(error));
    }
  };

  private readonly loadConfigPath = async () => {
    try {
      this.configPath.set((await this.processManager.getSystemPaths()).appConfig);
    } catch (error) {
      this.configFileError.set(error instanceof Error ? error.message : String(error));
    }
  };

  protected readonly openConfigFile = async () => {
    this.configFileError.set(null);
    try {
      const error = await this.processManager.openConfigFile();
      if (error) {
        this.configFileError.set(error);
      }
    } catch (error) {
      this.configFileError.set(error instanceof Error ? error.message : String(error));
    }
  };

  private readonly loadDevToolsSetting = async () => {
    try {
      this.devToolsOpen.set(await this.processManager.getDevToolsOpen());
    } catch (error) {
      this.devToolsError.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.devToolsLoading.set(false);
    }
  };

  protected readonly setDevToolsOpen = async (open: boolean) => {
    if (this.devToolsLoading()) {
      return;
    }

    const previousValue = this.devToolsOpen();
    this.devToolsOpen.set(open);
    this.devToolsError.set(null);

    try {
      await this.processManager.setDevToolsOpen(open);
    } catch (error) {
      this.devToolsOpen.set(previousValue);
      this.devToolsError.set(error instanceof Error ? error.message : String(error));
    }
  };

  /* State modifiers */
  private readonly updateBuildCacheInfo = async (directory: string | null, recursive: boolean): Promise<void> => {
    const requestId = ++this.buildCacheInfoRequestId;
    if (directory === null) {
      this.buildCacheInfo.set({ entries: 0, bytes: 0, fullSize: { entries: 0, bytes: 0 }, thumbnails: { entries: 0, bytes: 0 } });
      return;
    }
    try {
      const info = await this.cacheManager.cacheInfo(directory, recursive);
      if (requestId === this.buildCacheInfoRequestId) this.buildCacheInfo.set(info);
    } catch (error) {
      if (requestId === this.buildCacheInfoRequestId) this.clearError.set(error instanceof Error ? error.message : String(error));
    }
  };

  private readonly updateCacheInfo = async (directory?: string | null, recursive = false): Promise<void> => {
    const requestId = ++this.cacheInfoRequestId;
    if (directory === null) {
      this.cacheInfo.set({
        entries: 0,
        bytes: 0,
        fullSize: { entries: 0, bytes: 0 },
        thumbnails: { entries: 0, bytes: 0 }
      });
      return;
    }
    try {
      const info = await this.cacheManager.cacheInfo(directory, recursive);
      if (requestId === this.cacheInfoRequestId) this.cacheInfo.set(info);
    } catch (error) {
      if (requestId === this.cacheInfoRequestId) {
        this.clearError.set(error instanceof Error ? error.message : String(error));
      }
    }
  };

  private readonly updateCacheSummary = async (databaseKey = this.selectedCacheDatabaseKey() ?? undefined): Promise<void> => {
    const requestId = ++this.cacheSummaryRequestId;
    this.cacheSummaryLoading.set(true);
    try {
      const summary = await this.cacheManager.getCacheSummary(databaseKey);
      if (requestId === this.cacheSummaryRequestId) {
        this.cacheSummary.set(summary);
        if (!this.selectedCacheDatabaseKey() || !summary.databases.some(database => database.key === this.selectedCacheDatabaseKey())) {
          this.selectedCacheDatabaseKey.set(summary.selectedDatabaseKey);
        }
        this.cacheSummaryError.set(null);
      }
    } catch (error) {
      if (requestId === this.cacheSummaryRequestId) {
        this.cacheSummaryError.set(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (requestId === this.cacheSummaryRequestId) this.cacheSummaryLoading.set(false);
    }
  };

  /* Event handlers */
  protected readonly checkCache = async (): Promise<void> => {
    const directory = this.currentFolderPath().trim();
    const recursive = this.recursiveBuild();
    if (!directory || this.cacheCheckState() === 'checking' || this.cacheBuildActive() || this.locationLookupActive()) return;

    const requestId = ++this.cacheCheckRequestId;
    this.cacheOutputMode.set('check');
    this.cacheCheckState.set('checking');
    this.cacheCheckResult.set(null);
    this.cacheCheckError.set(null);
    this.cacheCheckLog.set([`Starting directory enumeration: ${directory}`]);

    try {
      const pendingDirectories = [directory];
      const images: Array<{ path: string; size: number; modifiedAt: number }> = [];

      while (pendingDirectories.length > 0) {
        const currentDirectory = pendingDirectories.pop()!;
        const imageResponse = await window.desktop.FileSystem.readImages(currentDirectory, 'name', 'asc');
        if (!imageResponse.success) {
          throw new Error(imageResponse.errorMessage || `Could not read folder: ${currentDirectory}`);
        }
        images.push(...imageResponse.data.map(file => ({
          path: file.path,
          size: file.size,
          modifiedAt: file.modifiedAt ?? 0
        })));

        let subfolderCount = 0;
        if (recursive) {
          const directoryResponse = await window.desktop.FileSystem.readDirectories(currentDirectory);
          if (!directoryResponse.success) {
            throw new Error(directoryResponse.errorMessage || `Could not read subfolders in: ${currentDirectory}`);
          }
          subfolderCount = directoryResponse.data.length;
          pendingDirectories.push(...directoryResponse.data.map(folder => folder.path));
        }

        this.cacheCheckLog.set([
          `Enumerated: ${currentDirectory} · ${imageResponse.data.length} images${recursive ? ` · ${subfolderCount} subfolders` : ''}`
        ]);

        if (requestId !== this.cacheCheckRequestId
          || directory !== this.currentFolderPath().trim()
          || recursive !== this.recursiveBuild()) return;
      }

      this.cacheCheckLog.set([`Directory enumeration complete · ${images.length} images found`, 'Checking cache files…']);

      const missingThumbnails: string[] = [];
      const missingFullSize: string[] = [];
      for (let offset = 0; offset < images.length; offset += 10000) {
        const batch = images.slice(offset, offset + 10000);
        const statuses = await this.cacheManager.getImageCacheStatuses(
          batch.map(file => file.path),
          true,
          batch
        );
        missingThumbnails.push(...statuses.filter(status => status.thumbnail === null).map(status => status.sourceName));
        missingFullSize.push(...statuses
          .filter(status => status.fullSizeRequired && status.fullSize === null)
          .map(status => status.sourceName));

        if (requestId !== this.cacheCheckRequestId
          || directory !== this.currentFolderPath().trim()
          || recursive !== this.recursiveBuild()) return;
      }

      this.cacheCheckResult.set({ directory, recursive, images: images.length, missingThumbnails, missingFullSize });
      this.cacheCheckState.set(missingThumbnails.length || missingFullSize.length ? 'missing' : 'complete');
      await this.updateCacheSummary();
    } catch (error) {
      if (requestId !== this.cacheCheckRequestId) return;
      this.cacheCheckError.set(error instanceof Error ? error.message : String(error));
      this.cacheCheckState.set('error');
    }
  };

  protected readonly deleteCache = () => this.clearCache(
    'Delete all cache files',
    (directory, recursive, operationId) => this.cacheManager.clear(directory, recursive, operationId),
    'Delete all selected cache files from the chosen scope? This cannot be undone.'
  );

  protected readonly deleteFullSizeCache = () => this.clearCache(
    'Delete full-size cache conversions',
    (directory, recursive, operationId) => this.cacheManager.clearFullSize(directory, recursive, operationId),
    'Delete full-size cache conversions from the chosen scope? This cannot be undone.'
  );

  protected readonly deleteThumbnailsCache = () => this.clearCache(
    'Delete thumbnails',
    (directory, recursive, operationId) => this.cacheManager.clearThumbnails(directory, recursive, operationId),
    'Delete thumbnail files from the chosen scope? This cannot be undone.'
  );

  private readonly clearCache = async (
    operation: string,
    clear: (directory?: string, recursive?: boolean, operationId?: string) => Promise<CacheClearResult>,
    confirmationMessage: string
  ) => {
    if (this.isClearing()) return;

    const global = this.deleteCacheGlobal();
    const directory = global ? undefined : this.currentFolderPath().trim();
    const recursive = !global && this.recursiveDelete();
    if (!global && !directory) {
      this.clearError.set('Select a gallery folder, or enable Delete cache global.');
      return;
    }

    const scope = global
      ? 'EVERY registered folder'
      : recursive
        ? 'the current folder and all its subfolders'
        : 'the current folder only';
    if (!window.confirm(confirmationMessage.replace('the chosen scope', scope))) {
      return;
    }

    this.isClearing.set(true);
    const operationId = crypto.randomUUID();
    this.activeDeleteOperationId = operationId;
    this.deleteCancelRequested.set(false);
    this.lastClearResult.set(null);
    this.clearError.set(null);
    const startedAt = performance.now();
    const started = new Date().toLocaleString();
    this.deleteCacheSummary.set(`${operation} started: ${started}\nScope: ${scope}\nWaiting for completion…`);

    try {
      const result = await clear(directory, recursive, operationId);
      const durationMs = Math.round(performance.now() - startedAt);
      this.lastClearResult.set(result);
      this.deleteCacheSummary.set([
        result.cancelled ? `${operation} cancelled` : `${operation} completed`,
        `Scope: ${scope}`,
        `Deleted: ${result.entries} cache entries`,
        `Space freed: ${result.bytes} bytes`,
        `Duration: ${durationMs} ms`
      ].join('\n'));
    } catch (error) {
      const durationMs = Math.round(performance.now() - startedAt);
      const message = error instanceof Error ? error.message : String(error);
      this.clearError.set(message);
      this.deleteCacheSummary.set([
        `${operation} failed`,
        `Scope: ${scope}`,
        `Error: ${message}`,
        `Duration: ${durationMs} ms`
      ].join('\n'));
    } finally {
      this.activeDeleteOperationId = null;
      this.deleteCancelRequested.set(false);
      this.isClearing.set(false);
      await this.updateCacheInfo(global ? undefined : directory || null, recursive);
      await this.updateBuildCacheInfo(this.currentFolderPath().trim() || null, this.recursiveBuild());
    }
  };

}
