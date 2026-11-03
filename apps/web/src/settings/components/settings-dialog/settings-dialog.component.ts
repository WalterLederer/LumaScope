import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { CacheClearResult, CacheInfo, ExternalProcessCall, GlobalShortcutStatus, supportedFileFormats } from 'internal-api';
import { CacheManager } from '../../../ipc/cache-manager';
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
  readonly mode = input<'all' | 'general' | 'cache'>('all');
  /* DI */
  readonly cacheManager = inject(CacheManager);

  private readonly processManager = inject(ProcessManager);

  /* State */
  protected readonly sidecarVolumes = signal<string[]>([]);

  protected readonly sidecarVolumeInput = signal('');

  protected readonly sidecarVolumeError = signal<string | null>(null);

  protected readonly sidecarVolumeLoading = signal(false);

  protected readonly cacheInfo = signal<CacheInfo>({
    path: '',
    entries: 0,
    bytes: 0,
    fullSize: { entries: 0, bytes: 0 },
    thumbnails: { entries: 0, bytes: 0 }
  });

  protected readonly isClearing = signal(false);

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
    // The bundled JPEG XR encoder is a known application helper. Its native
    // invocation is not always captured by the external-process event monitor.
    const jxrEncoder = 'jxr-wic-encoder.exe';
    const jxrEntry = programs.get(jxrEncoder) ?? { programName: jxrEncoder, functions: new Set<string>() };
    jxrEntry.functions.add('Encode an FP16 HDR capture as JPEG XR using the native Windows Imaging Component encoder');
    programs.set(jxrEncoder, jxrEntry);
    return [...programs.values()]
      .map(program => ({ programName: program.programName, function: [...program.functions].sort().join('; ') }))
      .sort((left, right) =>
        left.programName.localeCompare(right.programName, undefined, { sensitivity: 'base' })
      );
  });

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
      return globalThis.localStorage.getItem('light-matter.debugImageSwitching') === 'true';
    } catch {
      return false;
    }
  }

  protected readonly setDebugImageSwitching = (enabled: boolean) => {
    this.debugImageSwitching.set(enabled);
    try {
      globalThis.localStorage.setItem('light-matter.debugImageSwitching', String(enabled));
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

  protected readonly openFolderError = signal<string | null>(null);

  protected readonly supportedFormats = supportedFileFormats;

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
    const removeShortcutStatusListener = window.desktop.Capture.onGlobalShortcutStatusChanged(statuses => {
      this.globalShortcutStatuses.set(statuses);
      this.globalShortcutLoading.set(false);
      this.globalShortcutError.set(null);
    });
    destroyRef.onDestroy(removeShortcutStatusListener);
    this.loadGlobalShortcutStatus().then();
    this.loadExternalProcessCalls().then();
    this.updateCacheInfo().then();
    this.loadSidecarVolumes().then();
    this.loadDevToolsSetting().then();
    this.loadConfigPath().then();
  }

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

  /* Sidecar cache settings */
  private readonly loadSidecarVolumes = async (): Promise<void> => {
    try {
      this.sidecarVolumes.set(await this.cacheManager.getSidecarVolumes());
      this.sidecarVolumeError.set(null);
    } catch (error) {
      this.sidecarVolumeError.set(error instanceof Error ? error.message : String(error));
    }
  };

  protected readonly addSidecarVolume = async (): Promise<void> => {
    const input = this.sidecarVolumeInput().trim();
    const drive = input.endsWith('\\') || input.endsWith('/') ? input.slice(0, -1) : input;
    if (!/^[a-zA-Z]:$/.test(drive)) {
      this.sidecarVolumeError.set('Enter a drive root such as D:\\.');
      return;
    }
    await this.updateSidecarVolume(`${drive}\\`, true);
    if (this.sidecarVolumeError() === null) this.sidecarVolumeInput.set('');
  };

  protected readonly removeSidecarVolume = async (volumeRoot: string): Promise<void> =>
    this.updateSidecarVolume(volumeRoot, false);

  private readonly updateSidecarVolume = async (volumeRoot: string, enabled: boolean): Promise<void> => {
    if (this.sidecarVolumeLoading()) return;
    this.sidecarVolumeLoading.set(true);
    this.sidecarVolumeError.set(null);
    try {
      this.sidecarVolumes.set(await this.cacheManager.setSidecarVolumeEnabled(volumeRoot, enabled));
    } catch (error) {
      this.sidecarVolumeError.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.sidecarVolumeLoading.set(false);
    }
  };

  /* State modifiers */
  private readonly updateCacheInfo = async () => this.cacheInfo.set(await this.cacheManager.cacheInfo());

  protected readonly openCacheFolder = async () => {
    this.openFolderError.set(null);

    try {
      const error = await this.cacheManager.openCacheFolder();
      if (error) {
        this.openFolderError.set(error);
      }
    } catch (error) {
      this.openFolderError.set(error instanceof Error ? error.message : String(error));
    }
  };

  /* Event handlers */
  protected readonly deleteCache = () => this.clearCache(() => this.cacheManager.clear());

  protected readonly deleteFullSizeCache = () => this.clearCache(() => this.cacheManager.clearFullSize());

  protected readonly deleteThumbnailsCache = () => this.clearCache(() => this.cacheManager.clearThumbnails());

  private readonly clearCache = async (clear: () => Promise<CacheClearResult>) => {
    if (this.isClearing()) {
      return;
    }

    this.isClearing.set(true);
    this.lastClearResult.set(null);
    this.clearError.set(null);

    try {
      const result = await clear();
      await this.updateCacheInfo();
      this.lastClearResult.set(result);
    } catch (error) {
      this.clearError.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.isClearing.set(false);
    }
  };

}
