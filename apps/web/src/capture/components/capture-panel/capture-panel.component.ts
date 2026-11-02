import { ChangeDetectionStrategy, Component, DestroyRef, effect, ElementRef, HostListener, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CaptureFormat, CaptureMonitor, CapturePreview, CaptureTarget, CaptureWindow } from 'internal-api';
import { filter, take } from 'rxjs';
import { CaptureService } from '../../../ipc/capture';
import { CapturePreviewStore } from '../../capture-preview-store';
import { CaptureHotkeyService } from '../../capture-hotkey.service';
import { GalleryLocations } from '../../../gallery/services/gallery-locations/gallery-locations';
import { GalleryState } from '../../../gallery/services/gallery-state/gallery-state';

// Half-float lookup used to convert the captured FP16/scRGB frame directly to SDR.
const halfFloatLookup = (() => {
  const values = new Float32Array(0x10000);
  for (let bits = 0; bits < values.length; bits++) {
    const sign = (bits & 0x8000) === 0 ? 1 : -1;
    const exponent = (bits >>> 10) & 0x1f;
    const mantissa = bits & 0x03ff;
    values[bits] = exponent === 0
      ? sign * mantissa * Math.pow(2, -24)
      : exponent === 0x1f
        ? mantissa === 0 ? sign * Infinity : NaN
        : sign * (1 + mantissa / 1024) * Math.pow(2, exponent - 15);
  }
  return values;
})();

type CaptureSourceRow = {
  value: string;
  kind: 'monitor' | 'window' | 'top-window' | 'rectangle';
  favoriteKey: string;
  favorite: boolean;
  exe: string;
  title: string;
  size: string;
  displayMode: string;
  status: string;
  minimized: boolean;
  unavailable: boolean;
};

@Component({
  selector: 'app-capture-panel',
  templateUrl: './capture-panel.component.html',
  styleUrl: './capture-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CapturePanelComponent {
  private readonly captureService = inject(CaptureService);
  private readonly capturePreviewStore = inject(CapturePreviewStore);
  private readonly captureHotkeyService = inject(CaptureHotkeyService);
  private readonly galleryState = inject(GalleryState);
  private readonly galleryLocations = inject(GalleryLocations);
  private readonly destroyRef = inject(DestroyRef);
  private readonly hostElement = inject(ElementRef<HTMLElement>);

  protected readonly monitors = signal<CaptureMonitor[]>([]);
  protected readonly windows = signal<CaptureWindow[]>([]);
  protected readonly selectedTarget = signal('top-window');
  protected readonly sourceMenuOpen = signal(false);
  protected readonly sourceMenuStyle = signal('position: fixed;');
  protected readonly favoriteKeys = signal<string[]>(this.readFavoriteKeys());
  protected readonly unavailableTargets = signal<string[]>([]);
  protected readonly destinationFolder = signal(this.readSavedDestinationFolder());
  protected readonly loadingSources = signal(false);
  protected readonly capturing = signal(false);
  protected readonly previewing = signal(false);
  protected readonly previewFrame = signal<CapturePreview | null>(null);
  protected readonly captureBrightness = signal<number>(this.readSavedCaptureBrightness());
  protected readonly previewSize = signal('');
  protected readonly sdrPreviewCanvas = viewChild<ElementRef<HTMLCanvasElement>>('sdrPreviewCanvas');
  protected readonly previewCanvas = viewChild<ElementRef<HTMLCanvasElement>>('previewCanvas');
  private previewDevice: { destroy(): void } | null = null;
  private previewTexture: { destroy(): void } | null = null;
  private previewContext: { unconfigure(): void; configure(options: any): void; getCurrentTexture(): any } | null = null;
  private previewRequestId = 0;
  protected readonly selectedFormat = signal<CaptureFormat>(this.readSavedFormat());
  protected readonly includeLightMatterWindows = signal(this.readSavedIncludeLightMatterWindows());
  protected readonly setIncludeLightMatterWindows = (enabled: boolean): void => {
    this.includeLightMatterWindows.set(enabled);
    try { localStorage.setItem('capture.includeLightMatterWindows', String(enabled)); }
    catch { /* keep the current-session preference if storage is unavailable */ }
    this.previewFrame.set(null);
    this.previewSize.set('');
    this.status.set('');
  };
  protected readonly sdrDiagnostics = signal<{
    maxR: number; maxG: number; maxB: number;
    above05: number; above1: number; above2: number; above4: number;
    whitePixels: number; brightnessFactor: number; captureRange: 'SDR-range' | 'HDR-range'; maxLuminance: number; p95: number; p99: number; p999: number; p9999: number; diagnosticP95: number; diagnosticP99: number; diagnosticP999: number; diagnosticP9999: number; above3: number; above31: number; above32: number; above324: number; pixelCount: number;
  } | null>(null);
  private readonly sdrBrightnessFactor = 2.7;
  protected readonly applyGammaCorrectionOnSave = signal(false);
  protected readonly setApplyGammaCorrectionOnSave = (enabled: boolean): void => this.applyGammaCorrectionOnSave.set(enabled);
  protected readonly gammaCorrectionValue = signal<number>(this.readSavedGammaCorrection());
  protected readonly encoderQuality = signal<number>(this.readSavedEncoderQuality());
  protected readonly setEncoderQuality = (value: number): void => {
    if (!Number.isFinite(value)) return;
    const quality = Math.min(100, Math.max(0, Math.round(value)));
    this.encoderQuality.set(quality);
    try { localStorage.setItem('capture.encoderQuality', String(quality)); }
    catch { /* keep the current-session preference if storage is unavailable */ }
  };
  protected readonly setGammaCorrectionValue = (value: number): void => {
    if (!Number.isFinite(value)) return;
    const gamma = Math.min(2.2, Math.max(0.1, value));
    this.gammaCorrectionValue.set(gamma);
    try { localStorage.setItem('capture.gamma', String(gamma)); }
    catch { /* keep the current-session preference if storage is unavailable */ }
  };
  protected readonly status = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly lastOutputPath = signal('');

  protected readonly sourceRows = (): CaptureSourceRow[] => {
    const favorites = new Set(this.favoriteKeys());
    const monitors: CaptureSourceRow[] = this.monitors().map(monitor => {
      const value = `monitor:${monitor.index}`;
      const favoriteKey = value;
      return {
        value, kind: 'monitor', favoriteKey, favorite: favorites.has(favoriteKey),
        exe: `Monitor ${monitor.index}`,
        title: monitor.name || monitor.deviceName || `Monitor ${monitor.index}`,
        size: `${monitor.width} × ${monitor.height}`,
        displayMode: monitor.isHdr === undefined ? 'Unknown' : monitor.isHdr ? 'HDR' : 'SDR',
        status: `${monitor.isHdr === undefined ? 'Mode unknown' : monitor.isHdr ? 'HDR' : 'SDR'}${monitor.refreshRate ? ` · ${monitor.refreshRate} Hz` : ''}`,
        minimized: false,
        unavailable: this.unavailableTargets().includes(value)
      };
    });
    const windows: CaptureSourceRow[] = this.windows().map(window => {
      const resolvedMonitorIndex = window.monitorIndex !== undefined && window.monitorIndex >= 0
        ? window.monitorIndex
        : this.monitors().find(monitor => this.normalizeDisplayName(monitor.deviceName) === this.normalizeDisplayName(window.monitorDeviceName))?.index ?? -1;
      const value = `window:${window.handle}`;
      const executablePath = (window.executablePath ?? window.processName ?? 'Unknown executable').trim();
      const favoriteKey = `window:${executablePath.toLowerCase()}|${window.title.trim().toLowerCase()}`;
      return {
        value, kind: 'window', favoriteKey, favorite: favorites.has(favoriteKey),
        exe: this.windowExecutableName(window),
        title: window.title,
        size: `${window.width} × ${window.height}`,
        displayMode: this.windowDisplayMode({ ...window, monitorIndex: resolvedMonitorIndex }),
        status: window.isMinimized
          ? '[Minimized]'
          : window.width < 100
            || window.height < 100
            || this.unavailableTargets().includes(value)
              ? '[Not capturable]'
              : '',
        minimized: !!window.isMinimized,
        unavailable: window.width < 100 || window.height < 100 || !!window.isMinimized || this.unavailableTargets().includes(value)
      };
    });
    // Sort by an explicit capturability tier first. Favorites and source type
    // must never pull disabled rows back above capturable sources.
    const capturabilityTier = (row: CaptureSourceRow): number =>
      row.status.startsWith('[Not capturable]') ? 2 :
      row.minimized ? 1 :
      row.unavailable ? 2 : 0;
    const topWindow: CaptureSourceRow = {
      value: 'top-window', kind: 'top-window', favoriteKey: 'top-window',
      favorite: favorites.has('top-window'), exe: 'Top Window',
      title: this.includeLightMatterWindows() ? 'Capture the application window' : 'Foreground window after hiding the application',
      size: 'Automatic', displayMode: '—',
      status: this.includeLightMatterWindows() ? 'Application windows remain visible' : 'Automatically detected when capturing',
      minimized: false, unavailable: false
    };
    const rectangle: CaptureSourceRow = {
      value: 'rectangle', kind: 'rectangle', favoriteKey: 'rectangle',
      favorite: favorites.has('rectangle'), exe: 'Rectangle',
      title: 'Select an area directly on the screen',
      size: 'Custom', displayMode: 'HDR',
      status: 'Drag to select · Esc to cancel',
      minimized: false, unavailable: false
    };
    return [topWindow, rectangle, ...[...monitors, ...windows].sort((a, b) =>
      capturabilityTier(a) - capturabilityTier(b) ||
      Number(b.favorite) - Number(a.favorite) ||
      Number(b.kind === 'monitor') - Number(a.kind === 'monitor') ||
      a.exe.localeCompare(b.exe, undefined, { sensitivity: 'base' }) ||
      a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
    )];
  };


  private readonly normalizeDisplayName = (name?: string): string => (name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

  private readonly windowDisplayMode = (window: CaptureWindow): string => {
    if (window.isMinimized || window.width < 100 || window.height < 100 || window.monitorIndex === undefined || window.monitorIndex < 0) return '—';
    const monitor = this.monitors().find(item => item.index === window.monitorIndex);
    return monitor?.isHdr === undefined ? 'Unknown' : monitor.isHdr ? 'HDR' : 'SDR';
  };

  protected readonly toggleSourceMenu = (): void => {
    if (this.sourceMenuOpen()) {
      this.sourceMenuOpen.set(false);
      return;
    }
    const trigger = this.hostElement.nativeElement.querySelector('.capture-source-trigger');
    if (trigger) {
      const rect = trigger.getBoundingClientRect();
      const viewportPadding = 16;
      const maxWidth = Math.max(320, window.innerWidth - viewportPadding * 2);
      const width = Math.min(900, maxWidth);
      const left = Math.max(viewportPadding, Math.min(rect.right - width, window.innerWidth - width - viewportPadding));
      this.sourceMenuStyle.set(`position:fixed;top:${Math.min(rect.bottom + 3, window.innerHeight - 120)}px;left:${left}px;width:${width}px;max-width:calc(100vw - ${viewportPadding * 2}px);`);
    }
    this.sourceMenuOpen.set(true);
  };

  @HostListener('document:click', ['$event'])
  protected readonly closeSourceMenuOnOutsideClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element) || !this.hostElement.nativeElement.querySelector('.capture-source-picker')?.contains(target)) {
      this.sourceMenuOpen.set(false);
    }
  };

  @HostListener('document:keydown.escape')
  protected readonly closeSourceMenuOnEscape = (): void => {
    this.sourceMenuOpen.set(false);
  };

  @HostListener('window:keydown', ['$event'])
  protected readonly focusLocationWindowOnShortcut = (event: KeyboardEvent): void => {
    if (event.code !== 'KeyL' || event.repeat || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.matches('input:not([type="checkbox"]), textarea, select, [contenteditable="true"]')) return;
    event.preventDefault();

    const mapWindow = window.desktop?.MapWindow;
    if (!mapWindow) return;
    void mapWindow.isOpen().then(isOpen => {
      if (isOpen) return mapWindow.focus();
      return mapWindow.open(null, null);
    });
  };

  protected readonly selectSourceRow = (value: string): void => {
    const row = this.sourceRows().find(item => item.value === value);
    if (row?.minimized || row?.unavailable) return;
    this.sourceMenuOpen.set(false);
    this.changeTarget(value);
  };

  protected readonly toggleFavorite = (row: CaptureSourceRow, event: MouseEvent): void => {
    event.stopPropagation();
    const next = new Set(this.favoriteKeys());
    if (next.has(row.favoriteKey)) next.delete(row.favoriteKey);
    else next.add(row.favoriteKey);
    const keys = [...next];
    this.favoriteKeys.set(keys);
    try { localStorage.setItem('capture.source.favorites', JSON.stringify(keys)); }
    catch { /* keep the current-session preference if storage is unavailable */ }
  };

  private readSavedIncludeLightMatterWindows(): boolean {
    try { return localStorage.getItem('capture.includeLightMatterWindows') === 'true'; }
    catch { return false; }
  }

  private readSavedGammaCorrection(): number {
    try {
      const value = Number(localStorage.getItem('capture.gamma'));
      if (Number.isFinite(value) && value >= 0.1 && value <= 2.2) return value;
    } catch { /* use the default when storage is unavailable */ }
    return 1.3;
  }

  private readSavedCaptureBrightness(): number {
    try {
      const value = Number(localStorage.getItem('capture.brightness'));
      if (Number.isFinite(value) && value >= 0.25 && value <= 4) return value;
    } catch { /* use the default when storage is unavailable */ }
    return 1;
  }

  protected readonly setCaptureBrightness = (value: number): void => {
    if (!Number.isFinite(value)) return;
    const brightness = Math.min(4, Math.max(0.25, value));
    this.captureBrightness.set(brightness);
    try { localStorage.setItem('capture.brightness', String(brightness)); }
    catch { /* keep the current-session preference if storage is unavailable */ }
  };

  private readSavedEncoderQuality(): number {
    try {
      const value = Number(localStorage.getItem('capture.encoderQuality'));
      if (Number.isInteger(value) && value >= 0 && value <= 100) return value;
    } catch { /* use the default when storage is unavailable */ }
    return 90;
  }

  private readSavedFormat(): CaptureFormat {
    try {
      const value = localStorage.getItem('capture.format');
      if (value === 'exr' || value === 'jxr' || value === 'uhdr') return value;
    } catch { /* use the default when storage is unavailable */ }
    return 'exr';
  }

  protected readonly changeFormat = (value: string): void => {
    if (value !== 'exr' && value !== 'jxr' && value !== 'uhdr') return;
    const format = value as CaptureFormat;
    this.selectedFormat.set(format);
    try { localStorage.setItem('capture.format', format); }
    catch { /* keep the current-session preference if storage is unavailable */ }
  };

  private readFavoriteKeys(): string[] {
    try {
      const value: unknown = JSON.parse(localStorage.getItem('capture.source.favorites') ?? '[]');
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    } catch { return []; }
  }

  protected readonly selectedSourceLabel = (): string => {
    const target = this.selectedCaptureTarget();
    if (!target) return 'None';
    if (target.kind === 'top-window') return this.includeLightMatterWindows()
      ? 'Top Window · Application capture window'
      : 'Top Window · Foreground window after hiding the application';
    if (target.kind === 'rectangle') return 'Rectangle · Select area directly on screen';
    if (target.kind === 'monitor') {
      const monitor = this.monitors().find(item => item.index === target.index);
      return monitor
        ? `Monitor ${monitor.index} · ${monitor.name || monitor.deviceName || 'Unknown monitor'} · ${monitor.width} × ${monitor.height}${monitor.refreshRate ? ` · ${monitor.refreshRate} Hz` : ''}`
        : `Monitor ${target.index}`;
    }
    const window = this.windows().find(item => item.handle === target.handle);
    return window
      ? `${this.windowExecutableName(window)} · ${window.title} · ${window.width} × ${window.height}`
      : `Window ${target.handle}`;
  };

  protected readonly windowExecutableName = (window: CaptureWindow): string => {
    const path = (window.executablePath ?? '').trim();
    const executable = path.split(/[\\/]/).pop()?.trim();
    const processName = (window.processName ?? '').trim();
    // Some capture backends return a placeholder instead of the real executable.
    // Never show the bare "Windows application -" prefix as if it were a filename.
    const usable = (value: string | undefined): value is string =>
      !!value && !/^Windows application\s*-?\s*$/i.test(value) && value !== 'Unknown executable';
    if (usable(executable)) return executable;
    if (usable(processName)) return processName;
    return 'Unknown executable';
  };
  private readonly setPreviewFrame = (frame: CapturePreview): void => {
    // Keep the captured FP16 frame untouched for the HDR preview and downstream capture actions.
    this.previewFrame.set(frame);
    this.capturePreviewStore.setFrame(frame);
  };

  protected readonly changeTarget = (value: string): void => {
    const row = this.sourceRows().find(item => item.value === value);
    if (row?.minimized || row?.unavailable) return;
    this.disposeHdrPreview();
    this.selectedTarget.set(value);
    this.sourceMenuOpen.set(false);
    this.previewFrame.set(null);
    this.previewSize.set('');
    this.status.set('');
    this.error.set(null);
    this.lastOutputPath.set('');
  };

  constructor() {
    this.galleryState.selectedLocation()
      .pipe(
        filter((path): path is string => path !== null && path.length > 0),
        take(1),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(path => {
        if (!this.destinationFolder()) this.destinationFolder.set(path);
      });

    effect(() => {
      const action = this.captureHotkeyService.pendingAction();
      if (!action) return;
      this.captureHotkeyService.consume();
      if (action === 'top-window') void this.copyToClipboardTopWindow(true);
      else void this.copyToClipboardRectangle();
    });
    this.destroyRef.onDestroy(() => this.disposeHdrPreview());
    effect(() => {
      const frame = this.previewFrame();
      const canvas = this.previewCanvas()?.nativeElement;
      if (frame && canvas) void this.renderHdrPreview(canvas, frame);
    });
    effect(() => {
      const frame = this.previewFrame();
      const brightness = this.captureBrightness();
      const canvas = this.sdrPreviewCanvas()?.nativeElement;
      if (frame && canvas) void this.renderSdrPreview(canvas, frame, brightness);
    });
    void this.loadSources(true);
  }

  protected readonly loadSources = async (restoreSavedSelection = false): Promise<void> => {
    this.loadingSources.set(true);
    this.error.set(null);
    try {
      const sources = await this.captureService.listSources();
      this.monitors.set(sources.monitors);
      this.windows.set(sources.windows);
      if (sources.sourceErrors?.length) this.error.set(sources.sourceErrors.join('\n'));
      const saved = restoreSavedSelection ? this.readSavedSource() : null;
      let restored = false;
      if (saved?.kind === 'top-window') {
        this.selectedTarget.set('top-window');
        restored = true;
      } else if (saved?.kind === 'rectangle') {
        this.selectedTarget.set('rectangle');
        restored = true;
      } else if (saved?.kind === 'monitor' && sources.monitors.some(item => item.index === saved.index)) {
        this.selectedTarget.set(`monitor:${saved.index}`);
        restored = true;
      } else if (saved?.kind === 'window') {
        const matchingWindow = sources.windows.find(item => item.executablePath && item.executablePath.toLowerCase() === saved.executablePath.toLowerCase());
        if (matchingWindow) {
          this.selectedTarget.set(`window:${matchingWindow.handle}`);
          restored = true;
        }
      }
      if (!restored && this.selectedTarget() !== 'top-window' && !sources.monitors.some(monitor => this.selectedTarget() === `monitor:${monitor.index}`) &&
          !sources.windows.some(window => this.selectedTarget() === `window:${window.handle}`)) {
        const firstMonitor = sources.monitors[0];
        const firstWindow = sources.windows[0];
        this.selectedTarget.set(firstMonitor ? `monitor:${firstMonitor.index}` : firstWindow ? `window:${firstWindow.handle}` : '');
      }
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.loadingSources.set(false);
    }
  };

  private readSavedSource(): { kind: 'top-window' } | { kind: 'rectangle' } | { kind: 'monitor'; index: number } | { kind: 'window'; executablePath: string } | null {
    try {
      const value = JSON.parse(localStorage.getItem('capture.source') ?? 'null');
      if (value?.kind === 'top-window') return value;
      if (value?.kind === 'rectangle') return value;
      if (value?.kind === 'monitor' && Number.isSafeInteger(value.index)) return value;
      if (value?.kind === 'window' && typeof value.executablePath === 'string') return value;
    } catch { /* ignore invalid saved preference */ }
    return null;
  }

  private saveSelectedSource(): void {
    const target = this.selectedCaptureTarget();
    if (!target) return;
    if (target.kind === 'top-window') {
      localStorage.setItem('capture.source', JSON.stringify({ kind: 'top-window' }));
      return;
    }
    if (target.kind === 'rectangle') {
      localStorage.setItem('capture.source', JSON.stringify({ kind: 'rectangle' }));
      return;
    }
    if (target.kind === 'monitor') {
      localStorage.setItem('capture.source', JSON.stringify({ kind: 'monitor', index: target.index }));
      return;
    }
    const window = this.windows().find(item => item.handle === target.handle);
    if (window?.executablePath) {
      localStorage.setItem('capture.source', JSON.stringify({ kind: 'window', executablePath: window.executablePath }));
    }
  }

  private readSavedDestinationFolder(): string {
    try { return localStorage.getItem('capture.destinationFolder') ?? ''; }
    catch { return ''; }
  }

  protected readonly chooseFolder = async (): Promise<void> => {
    const folder = await this.captureService.chooseFolder(this.destinationFolder() || undefined);
    if (folder) {
      this.destinationFolder.set(folder);
      try { localStorage.setItem('capture.destinationFolder', folder); } catch { /* keep current-session preference */ }
      this.error.set(null);
    }
  };

  private selectedCaptureTarget(): CaptureTarget | null {
    const value = this.selectedTarget();
    if (value === 'top-window') return { kind: 'top-window', includeLightMatterWindows: this.includeLightMatterWindows() };
    if (value === 'rectangle') return { kind: 'rectangle' };
    const separator = value.indexOf(':');
    if (separator < 0) return null;
    const kind = value.slice(0, separator);
    const id = Number(value.slice(separator + 1));
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    if (kind === 'monitor') return { kind: 'monitor', index: id };
    if (kind === 'window') return { kind: 'window', handle: id };
    return null;
  }

  protected readonly previewNow = async (targetOverride?: CaptureTarget): Promise<void> => {
    const target = targetOverride ?? this.selectedCaptureTarget();
    if (!target) {
      this.error.set('Select a rectangle, top window, monitor, or application window.');
      return;
    }
    const requestId = ++this.previewRequestId;
    this.previewing.set(true);
    this.error.set(null);
    this.status.set('Capturing source preview…');
    try {
      const preview = await this.captureService.preview(target);
      if (requestId !== this.previewRequestId) return;
      this.setPreviewFrame(preview);
      this.previewSize.set(`${preview.width} × ${preview.height}`);
      this.status.set(`Capture ready · ${preview.width} × ${preview.height}`);
      if (!targetOverride) this.saveSelectedSource();
    } catch (error) {
      if (requestId !== this.previewRequestId) return;
      this.previewFrame.set(null);
      this.status.set('');
      const message = error instanceof Error ? error.message : String(error);
      if (target.kind === 'window' && /0x80070057|Falscher Parameter|invalid parameter/i.test(message)) {
        this.unavailableTargets.update(keys => keys.includes(`window:${target.handle}`) ? keys : [...keys, `window:${target.handle}`]);
      }
      this.error.set(message);
    } finally {
      if (requestId === this.previewRequestId) this.previewing.set(false);
    }
  };

  private readonly renderHdrPreview = async (canvas: HTMLCanvasElement, frame: CapturePreview): Promise<void> => {
    try {
      const gpu = (navigator as Navigator & { gpu?: any }).gpu;
      if (!gpu) throw new Error('WebGPU is unavailable; HDR preview cannot be displayed.');
      this.disposeHdrPreview();
      canvas.width = frame.width;
      canvas.height = frame.height;
      const adapter = await gpu.requestAdapter();
      if (!adapter) throw new Error('No WebGPU adapter is available for the HDR preview.');
      const device: any = await adapter.requestDevice();
      const context = canvas.getContext('webgpu') as any;
      if (!context) {
        device.destroy();
        throw new Error('Could not create a WebGPU canvas for the HDR preview.');
      }
      context.configure({ device, format: 'rgba16float', colorSpace: 'srgb', alphaMode: 'opaque', toneMapping: { mode: 'extended' } });
      const texture = device.createTexture({
        size: { width: frame.width, height: frame.height },
        format: 'rgba16float',
        usage: 4 | 2
      });
      device.queue.writeTexture({ texture }, frame.pixels, { bytesPerRow: frame.width * 8, rowsPerImage: frame.height }, { width: frame.width, height: frame.height, depthOrArrayLayers: 1 });
      const shader = device.createShaderModule({ code: `
        @group(0) @binding(0) var sourceTexture: texture_2d<f32>;
        struct VertexOutput { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };
        @vertex fn vs(@builtin(vertex_index) index: u32) -> VertexOutput {
          var positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
          var output: VertexOutput;
          let p = positions[index];
          output.position = vec4<f32>(p, 0.0, 1.0);
          output.uv = vec2<f32>((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
          return output;
        }
        // WGSL helper functions must be declared at module scope.
        fn linearToExtendedSrgb(value: vec3<f32>) -> vec3<f32> {
          let low = value * 12.92;
          let high = 1.055 * pow(max(value, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.4)) - vec3<f32>(0.055);
          return select(high, low, value <= vec3<f32>(0.0031308));
        }
        @fragment fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
          let dims = vec2<i32>(textureDimensions(sourceTexture));
          let coords = vec2<i32>(clamp(input.uv * vec2<f32>(dims), vec2<f32>(0.0), vec2<f32>(dims - vec2<i32>(1, 1))));
          // Convert the captured scRGB reference white (80 nits) to the
          // 203-nit display reference and encode it as extended sRGB.
          let linearColor = max(textureLoad(sourceTexture, coords, 0).rgb * 0.4, vec3<f32>(0.0));
          return vec4<f32>(linearToExtendedSrgb(linearColor), 1.0);
        }
      ` });
      const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module: shader, entryPoint: 'vs' }, fragment: { module: shader, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] }, primitive: { topology: 'triangle-list' } });
      const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: texture.createView() }] });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
      this.previewDevice = device;
      this.previewTexture = texture;
      this.previewContext = context;
      this.status.set(`HDR capture ready · ${frame.width} × ${frame.height} · WebGPU FP16/scRGB`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.error.set(message);
      console.error('[HDR Capture] WebGPU preview failed:', error);
    }
  };

  private readonly disposeHdrPreview = (): void => {
    try { this.previewContext?.unconfigure(); } catch { /* already unconfigured */ }
    this.previewTexture?.destroy();
    this.previewDevice?.destroy();
    this.previewTexture = null;
    this.previewDevice = null;
    this.previewContext = null;
  };

  private readonly applySdrToneMapping = (imageData: ImageData, frame: CapturePreview, previewBrightness = 1): void => {
    this.applyLegacySdrToneMapping(imageData, frame, previewBrightness);
  };

  private readonly applyLegacySdrToneMapping = (imageData: ImageData, frame: CapturePreview, previewBrightness = 1): void => {
    const pixels = imageData.data;
    const source = frame.pixels;
    const pixelCount = frame.width * frame.height;

    // Build a logarithmic luminance histogram from the captured linear-light
    // RGB values. Black remains exactly zero; no statistical black lift is used.
    const histogram = new Uint32Array(32768);
    const diagnosticHistogram = new Uint32Array(65536);
    const diagnosticRange = 4;
    const logMin = Math.log(0.000001);
    const logMax = Math.log(65504);
    const logRange = logMax - logMin;
    const luminances = new Float32Array(pixelCount);
    let zeroLuminancePixels = 0;
    let maxLuminance = 0;
    let above3 = 0;
    let above31 = 0;
    let above32 = 0;
    let above324 = 0;
    let maxR = 0;
    let maxG = 0;
    let maxB = 0;
    let above05 = 0;
    let above1 = 0;
    let above2 = 0;
    let above4 = 0;

    for (let pixel = 0; pixel < pixelCount; pixel++) {
      const offset = pixel * 4;
      const r = halfFloatLookup[source[offset]];
      const g = halfFloatLookup[source[offset + 1]];
      const b = halfFloatLookup[source[offset + 2]];
      const positiveR = Number.isFinite(r) ? Math.max(0, r) : r === Infinity ? 65504 : 0;
      const positiveG = Number.isFinite(g) ? Math.max(0, g) : g === Infinity ? 65504 : 0;
      const positiveB = Number.isFinite(b) ? Math.max(0, b) : b === Infinity ? 65504 : 0;
      const peak = Math.max(positiveR, positiveG, positiveB);
      maxR = Math.max(maxR, positiveR);
      maxG = Math.max(maxG, positiveG);
      maxB = Math.max(maxB, positiveB);
      if (peak > 0.5) above05++;
      if (peak > 1) above1++;
      if (peak > 2) above2++;
      if (peak > 4) above4++;

      const luminance = positiveR * 0.2126 + positiveG * 0.7152 + positiveB * 0.0722;
      luminances[pixel] = luminance;
      maxLuminance = Math.max(maxLuminance, luminance);
      if (luminance > 3) above3++;
      if (luminance > 3.1) above31++;
      if (luminance > 3.2) above32++;
      if (luminance > 3.24) above324++;
      const diagnosticBin = Math.min(diagnosticHistogram.length - 1,
        Math.max(0, Math.floor(luminance / diagnosticRange * diagnosticHistogram.length)));
      diagnosticHistogram[diagnosticBin]++;
      if (luminance > 0) {
        const bin = Math.min(histogram.length - 1, Math.max(0,
          Math.floor((Math.log(Math.min(luminance, 65504)) - logMin) / logRange * histogram.length)));
        histogram[bin]++;
      } else {
        zeroLuminancePixels++;
      }
    }

    const percentile = (fraction: number): number => {
      const target = Math.max(1, Math.ceil(pixelCount * fraction));
      let cumulative = zeroLuminancePixels;
      if (cumulative >= target) return 0;
      for (let bin = 0; bin < histogram.length; bin++) {
        cumulative += histogram[bin];
        if (cumulative >= target) {
          return Math.exp(logMin + ((bin + 0.5) / histogram.length) * logRange);
        }
      }
      return maxLuminance;
    };

    const p95 = percentile(0.95);
    const p99 = percentile(0.99);
    const p999 = percentile(0.999);
    const p9999 = percentile(0.9999);
    const diagnosticPercentile = (fraction: number): number => {
      const target = Math.max(1, Math.ceil(pixelCount * fraction));
      let cumulative = 0;
      for (let bin = 0; bin < diagnosticHistogram.length; bin++) {
        cumulative += diagnosticHistogram[bin];
        if (cumulative >= target) {
          return (bin + 0.5) / diagnosticHistogram.length * diagnosticRange;
        }
      }
      return maxLuminance;
    };
    const diagnosticP95 = diagnosticPercentile(0.95);
    const diagnosticP99 = diagnosticPercentile(0.99);
    const diagnosticP999 = diagnosticPercentile(0.999);
    const diagnosticP9999 = diagnosticPercentile(0.9999);
    const blackPoint = 0;
    const whitePoint = Math.max(0.000001, p999);
    const shoulderStart = whitePoint;
    const shoulderEnd = Math.max(shoulderStart, maxLuminance);
    const shoulderRange = shoulderEnd - shoulderStart;
    const linearHighlightFraction = 0.92;
    // SDR-only desktop captures can be represented above 1.0 in scRGB,
    // depending on the Windows HDR/SDR white-level setting. Avoid applying
    // the HDR brightness boost when the upper luminance range stays <= 4.0.
    const isSdrRangeCapture = maxLuminance <= 4.0 && p999 <= 4.0;
    const brightnessFactor = (isSdrRangeCapture
      ? 1 / linearHighlightFraction
      : this.sdrBrightnessFactor) * previewBrightness;
    const captureRange = isSdrRangeCapture ? 'SDR-range' as const : 'HDR-range' as const;
    const shoulderHeight = 1 - linearHighlightFraction;
    const normalizedShoulderRange = shoulderRange > 0
      ? linearHighlightFraction * shoulderRange / (shoulderStart * shoulderHeight)
      : 0;

    // Use an exponential highlight shoulder that starts at 92% SDR white and
    // reaches exact white at the captured maximum. The lower 0..P99.9 range
    // is linearly stretched, preserving black and the relative RGB ratios.
    let curvature = 0;
    if (normalizedShoulderRange > 1.000001) {
      let low = 0;
      let high = Math.max(2, normalizedShoulderRange * 2);
      for (let iteration = 0; iteration < 48; iteration++) {
        const middle = (low + high) * 0.5;
        const ratio = middle / (1 - Math.exp(-middle));
        if (ratio < normalizedShoulderRange) low = middle;
        else high = middle;
      }
      curvature = (low + high) * 0.5;
    }
    const exponentialDenominator = curvature > 0 ? 1 - Math.exp(-curvature) : 1;

    let whitePixels = 0;
    for (let pixel = 0; pixel < pixelCount; pixel++) {
      const offset = pixel * 4;
      const r = halfFloatLookup[source[offset]];
      const g = halfFloatLookup[source[offset + 1]];
      const b = halfFloatLookup[source[offset + 2]];
      const positiveR = Number.isFinite(r) ? Math.max(0, r) : r === Infinity ? 65504 : 0;
      const positiveG = Number.isFinite(g) ? Math.max(0, g) : g === Infinity ? 65504 : 0;
      const positiveB = Number.isFinite(b) ? Math.max(0, b) : b === Infinity ? 65504 : 0;
      const luminance = luminances[pixel];

      let mappedLuminance = 0;
      if (luminance > blackPoint && whitePoint > blackPoint) {
        if (luminance <= shoulderStart || shoulderRange <= 0) {
          mappedLuminance = linearHighlightFraction * (luminance - blackPoint) / (whitePoint - blackPoint);
        } else {
          const t = Math.min(1, (luminance - shoulderStart) / shoulderRange);
          const shoulder = curvature > 0
            ? (1 - Math.exp(-curvature * t)) / exponentialDenominator
            : t;
          mappedLuminance = linearHighlightFraction + shoulderHeight * shoulder;
        }
      }

      // Apply one fixed linear-light brightness factor after tone mapping.
      // Zero remains exactly zero and RGB channel ratios are preserved until clipping.
      const scale = luminance > 0 ? mappedLuminance / luminance : 0;
      const outputR = Math.min(1, Math.max(0, positiveR * scale * brightnessFactor));
      const outputG = Math.min(1, Math.max(0, positiveG * scale * brightnessFactor));
      const outputB = Math.min(1, Math.max(0, positiveB * scale * brightnessFactor));
      const toSrgb = (linear: number): number => linear <= 0.0031308
        ? linear * 12.92
        : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
      pixels[offset] = Math.round(Math.min(1, Math.max(0, toSrgb(outputR))) * 255);
      pixels[offset + 1] = Math.round(Math.min(1, Math.max(0, toSrgb(outputG))) * 255);
      pixels[offset + 2] = Math.round(Math.min(1, Math.max(0, toSrgb(outputB))) * 255);
      pixels[offset + 3] = 255;
      if (pixels[offset] === 255 && pixels[offset + 1] === 255 && pixels[offset + 2] === 255) whitePixels++;
    }

    this.sdrDiagnostics.set({
      maxR, maxG, maxB, above05, above1, above2, above4, whitePixels,
      brightnessFactor, captureRange, maxLuminance, p95, p99, p999, p9999,
      diagnosticP95, diagnosticP99, diagnosticP999, diagnosticP9999,
      above3, above31, above32, above324, pixelCount
    });
  };

  private readonly renderSdrImage = (
    canvas: HTMLCanvasElement,
    frame: CapturePreview,
    previewBrightness = 1
  ): void => {
    canvas.width = frame.width;
    canvas.height = frame.height;
    const context = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
    if (!context) throw new Error('Could not create the SDR image canvas.');
    const imageData = context.createImageData(frame.width, frame.height);
    this.applySdrToneMapping(imageData, frame, previewBrightness);
    context.putImageData(imageData, 0, 0);
  };

  private readonly renderSdrPreview = (
    canvas: HTMLCanvasElement,
    frame: CapturePreview,
    brightness: number
  ): void => {
    try {
      this.renderSdrImage(canvas, frame, brightness);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.error.set(message);
      console.error('[HDR Capture] SDR preview rendering failed:', error);
    }
  };

  private readonly createSdrClipboardPng = async (frame: CapturePreview): Promise<Uint8Array> => {
    const canvas = document.createElement('canvas');
    this.renderSdrImage(canvas, frame);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(result => result
        ? resolve(result)
        : reject(new Error('Could not encode the adjusted SDR image as PNG.')), 'image/png');
    });
    return new Uint8Array(await blob.arrayBuffer());
  };

  protected readonly copyToClipboard = async (targetOverride?: CaptureTarget, playFeedback = false): Promise<void> => {
    if (this.capturing() || this.previewing()) return;
    if (!targetOverride && !this.selectedCaptureTarget()) {
      this.error.set('Select a rectangle, monitor, or application window.');
      return;
    }
    this.error.set(null);
    await this.previewNow(targetOverride);
    const frame = this.previewFrame();
    if (!frame) return;

    this.capturing.set(true);
    try {
      this.status.set('Preparing SDR clipboard image…');
      const pngData = await this.createSdrClipboardPng(frame);
      const result = await this.captureService.copyPreviewToClipboard(pngData, playFeedback);
      this.lastOutputPath.set('Windows Clipboard');
      this.status.set(`Copied ${result.width} × ${result.height} SDR preview to Windows Clipboard`);
    } catch (error) {
      this.status.set('');
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.capturing.set(false);
    }
  };

  protected readonly copyPreviewToClipboardNow = async (): Promise<void> => {
    if (this.capturing() || this.previewing()) return;
    const frame = this.previewFrame();
    if (!frame) {
      this.error.set('Generate a preview before copying it.');
      return;
    }
    this.error.set(null);
    this.capturing.set(true);
    try {
      this.status.set('Preparing corrected SDR preview for clipboard…');
      const pngData = await this.createSdrClipboardPng(frame);
      const result = await this.captureService.copyPreviewToClipboard(pngData);
      this.lastOutputPath.set('Windows Clipboard');
      this.status.set(`Copied corrected ${result.width} × ${result.height} SDR preview to Windows Clipboard`);
    } catch (error) {
      this.status.set('');
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.capturing.set(false);
    }
  };

  protected readonly copyToClipboardTopWindow = async (playFeedback = false): Promise<void> => {
    await this.copyToClipboard({ kind: 'top-window' }, playFeedback);
  };

  protected readonly copyToClipboardRectangle = async (): Promise<void> => {
    await this.copyToClipboard({ kind: 'rectangle' });
  };

  protected readonly savePreviewNow = async (): Promise<void> => {
    const target = this.selectedCaptureTarget();
    const frame = this.previewFrame();
    const folder = this.destinationFolder();
    const format = this.selectedFormat();
    if (!frame) {
      this.error.set('Generate a preview before saving it.');
      return;
    }
    if (!target) {
      this.error.set('Select a capture source first.');
      return;
    }
    if (!folder) {
      this.error.set('Choose a destination folder first.');
      return;
    }
    this.error.set(null);
    this.capturing.set(true);
    this.status.set('Saving existing preview frame…');
    try {
      const result = await this.captureService.capture(
        target, folder, format,
        this.applyGammaCorrectionOnSave() ? this.gammaCorrectionValue() : 1,
        this.encoderQuality(), frame
      );
      this.galleryLocations.addLocation(folder);
      this.lastOutputPath.set(result.path);
      this.status.set(`Saved preview ${result.width} × ${result.height} HDR · ${result.path}`);
    } catch (error) {
      this.status.set('');
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.capturing.set(false);
    }
  };

  protected readonly captureNow = async (): Promise<void> => {
    const target = this.selectedCaptureTarget();
    const folder = this.destinationFolder();
    const format = this.selectedFormat();
    if (!target) {
      this.error.set('Select a rectangle, monitor, or application window.');
      return;
    }
    if (!folder) {
      this.error.set('Choose a destination folder first.');
      return;
    }
    this.error.set(null);
    await this.previewNow();
    if (!this.previewFrame()) return;

    this.capturing.set(true);
    this.status.set('Saving captured HDR frame…');
    try {
      const result = await this.captureService.capture(
        target,
        folder,
        format,
        this.applyGammaCorrectionOnSave() ? this.gammaCorrectionValue() : 1,
        this.encoderQuality()
      );
      this.galleryLocations.addLocation(folder);
      this.lastOutputPath.set(result.path);
      this.status.set(`Saved ${result.width} × ${result.height} HDR · ${result.path}`);
    } catch (error) {
      this.status.set('');
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.capturing.set(false);
    }
  };
}
