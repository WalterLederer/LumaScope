import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, input, signal } from '@angular/core';
import { ProcessMemorySnapshot } from 'internal-api';
import { ProcessManager } from '../../../ipc/process-manager';

interface RendererDiagnosticsSnapshot {
  domElements: number;
  mapDomElements: number;
  mapTiles: number;
  mapMarkers: number;
  canvasElements: number;
  thumbnailComponents: number;
  detailRows: number;
  hexRows: number;
  heapUsedBytes: number | null;
  heapTotalBytes: number | null;
  heapLimitBytes: number | null;
}

@Component({
  selector: 'app-renderer-memory-panel',
  standalone: true,
  templateUrl: './renderer-memory-panel.component.html',
  styleUrl: './renderer-memory-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class RendererMemoryPanelComponent {
  readonly enabled = input(true);
  readonly windowLabel = input('Current window');
  protected readonly diagnostics = signal<RendererDiagnosticsSnapshot>({
    domElements: 0, mapDomElements: 0, mapTiles: 0, mapMarkers: 0, canvasElements: 0,
    thumbnailComponents: 0, detailRows: 0, hexRows: 0,
    heapUsedBytes: null, heapTotalBytes: null, heapLimitBytes: null
  });
  protected readonly processMemory = signal<ProcessMemorySnapshot>({ processes: [], error: null });
  protected readonly totalProcessMemoryBytes = computed(() => this.processMemory().processes.reduce((sum, entry) => sum + entry.workingSetBytes, 0));
  protected readonly updatedAt = signal('');
  private readonly processManager = inject(ProcessManager);
  private readonly destroyRef = inject(DestroyRef);
  private refreshInProgress = false;

  constructor() {
    effect(() => {
      if (this.enabled()) void this.refresh();
    });
    const timer = setInterval(() => {
      if (this.enabled()) void this.refresh();
    }, 2000);
    this.destroyRef.onDestroy(() => clearInterval(timer));
  }

  protected readonly formatBytes = (bytes: number | null): string => {
    if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes < 1024) return bytes + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2) + ' ' + units[unit];
  };

  protected readonly refresh = async (): Promise<void> => {
    if (this.refreshInProgress) return;
    this.refreshInProgress = true;
    try {
      const memory = (performance as Performance & {
        memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number; jsHeapSizeLimit?: number };
      }).memory;
      this.diagnostics.set({
        domElements: document.getElementsByTagName('*').length,
        mapDomElements: document.querySelectorAll('.leaflet-container *, .maplibregl-map *').length,
        mapTiles: document.querySelectorAll('.leaflet-tile').length,
        mapMarkers: document.querySelectorAll('.leaflet-marker-icon, .maplibregl-marker').length,
        canvasElements: document.getElementsByTagName('canvas').length,
        thumbnailComponents: document.querySelectorAll('app-thumbnail').length,
        detailRows: document.querySelectorAll('.detail-native-table tbody tr:not(.detail-virtual-spacer)').length,
        hexRows: document.querySelectorAll('.image-hex-viewer .hex-data-row').length,
        heapUsedBytes: Number.isFinite(memory?.usedJSHeapSize) ? memory!.usedJSHeapSize! : null,
        heapTotalBytes: Number.isFinite(memory?.totalJSHeapSize) ? memory!.totalJSHeapSize! : null,
        heapLimitBytes: Number.isFinite(memory?.jsHeapSizeLimit) ? memory!.jsHeapSizeLimit! : null
      });
      try {
        this.processMemory.set(await this.processManager.getProcessMemoryUsage());
      } catch (error) {
        this.processMemory.update(current => ({ ...current, error: error instanceof Error ? error.message : String(error) }));
      }
      this.updatedAt.set(new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date()));
    } finally {
      this.refreshInProgress = false;
    }
  };
}
