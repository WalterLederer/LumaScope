import { ChangeDetectionStrategy, Component, EventEmitter, Input, OnChanges, OnInit, Output, SimpleChanges, signal } from '@angular/core';
import { Desktop } from 'internal-api';
import { formatNumber } from '../../../ui/utils/format-number';

@Component({
  selector: 'app-gpx-database-import',
  standalone: true,
  template: `
    <details class="gpx-database-section app-disclosure">
      <summary class="gpx-database-summary">GPX → DB<button type="button" class="routing-help-button gpx-database-help" (click)="$event.preventDefault(); help.emit()" title="Open GPX cache documentation" aria-label="Open GPX cache documentation"><span aria-hidden="true">?</span></button></summary>
      <div class="gpx-database-import-row">
        <button type="button" class="offline-map-add-button" (click)="importAllGpxTracks()" [disabled]="busy()">
          {{ busy() ? 'Importing GPX tracks…' : 'Add all GPX tracks from folder to DB…' }}
        </button>
        <button type="button" class="routing-help-button" (click)="refreshStats()" [disabled]="busy()" title="Refresh all favorite cache database summaries" aria-label="Refresh all favorite cache database summaries"><span aria-hidden="true">⟳</span></button>
        <div class="gpx-database-statistics-list" aria-live="polite">
          <strong class="gpx-database-statistics-heading">Favorite cache databases and selected drive</strong>
          @if (!databaseKeysReady || statsLoading()) {
            <span class="gpx-database-statistics">Loading favorite cache databases…</span>
          } @else {
          @for (item of databaseStats(); track item.key) {
            <span class="gpx-database-statistics" title="GPX data and cache summary for this favorite drive">
              {{ item.key }} · {{ item.path }} · DB {{ formatNumber(item.databaseBytes) }} bytes · Cache {{ formatNumber(item.cacheEntries) }} files / {{ formatNumber(item.cacheBytes) }} bytes · Full-size {{ formatNumber(item.fullSizeEntries) }} / {{ formatNumber(item.fullSizeBytes) }} bytes · Thumbnails {{ formatNumber(item.thumbnailEntries) }} / {{ formatNumber(item.thumbnailBytes) }} bytes · Sidecar {{ formatNumber(item.sidecarEntries) }} / {{ formatNumber(item.sidecarBytes) }} bytes · GPS {{ formatNumber(item.gpsEntries) }} / {{ formatNumber(item.gpsBytes) }} bytes · GPX {{ formatNumber(item.files) }} files / {{ formatNumber(item.segments) }} segments / {{ formatNumber(item.points) }} points / {{ formatNumber(item.timestampedPoints) }} timestamped
            </span>
          } @empty {
            <span class="gpx-database-statistics">No favorite cache databases found.</span>
          }
          }
        </div>
      </div>
      @if (status()) {
        <span class="offline-map-status gpx-database-import-status" [class.gpx-database-import-progress]="busy()" role="status" aria-live="polite">{{ status() }}</span>
      }
    </details>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class GpxDatabaseImportComponent implements OnInit, OnChanges {
  protected readonly formatNumber = formatNumber;
  @Input() databaseKey: string | undefined;
  @Input() databaseKeys: string[] = [];
  @Input() databaseKeysReady = false;
  @Output() readonly help = new EventEmitter<void>();
  @Output() readonly imported = new EventEmitter<string>();

  private readonly desktop = (window as unknown as { desktop?: Desktop }).desktop;
  private effectiveDatabaseKey: string | undefined;
  protected readonly databaseStats = signal<Array<{ key: string; path: string; databaseBytes: number; cacheEntries: number; cacheBytes: number; fullSizeEntries: number; fullSizeBytes: number; thumbnailEntries: number; thumbnailBytes: number; sidecarEntries: number; sidecarBytes: number; gpsEntries: number; gpsBytes: number; files: number; segments: number; points: number; timestampedPoints: number }>>([]);
  protected readonly busy = signal(false);
  protected readonly statsLoading = signal(false);
  private statsRequestId = 0;
  protected readonly status = signal('');

  ngOnInit(): void {
    this.effectiveDatabaseKey = this.databaseKey;
    if (this.databaseKeysReady) void this.refreshStats();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['databaseKey'] || changes['databaseKeys'] || changes['databaseKeysReady']) {
      this.effectiveDatabaseKey = this.databaseKey;
      if (this.databaseKeysReady) void this.refreshStats();
    }
  }

  protected readonly refreshStats = async (): Promise<void> => {
    if (!this.desktop || !this.databaseKeysReady) return;
    const requestId = ++this.statsRequestId;
    this.statsLoading.set(true);
    try {
      const keys = [...new Set([...(this.databaseKeys ?? []), this.effectiveDatabaseKey].filter((key): key is string => !!key && /^[a-z]:$/i.test(key)).map(key => key.toUpperCase()))].sort();
      if (keys.length === 0) {
        if (requestId === this.statsRequestId) this.databaseStats.set([]);
        return;
      }
      const stats = await Promise.all(keys.map(async key => {
        const [gpx, summary] = await Promise.all([
          this.desktop!.CacheManager.getGpxDatabaseStats(key),
          this.desktop!.CacheManager.getCacheSummary(key)
        ]);
        const database = summary.databases.find(item => item.key === key);
        return {
          key,
          path: database?.path ?? key + '\\.cache\\LumaScope.cache.sqlite',
          databaseBytes: database?.bytes ?? 0,
          cacheEntries: summary.total.entries,
          cacheBytes: summary.total.bytes,
          fullSizeEntries: summary.fullSize.entries,
          fullSizeBytes: summary.fullSize.bytes,
          thumbnailEntries: summary.thumbnails.entries,
          thumbnailBytes: summary.thumbnails.bytes,
          sidecarEntries: summary.sidecar.entries,
          sidecarBytes: summary.sidecar.bytes,
          gpsEntries: summary.gps.entries,
          gpsBytes: summary.gps.bytes,
          ...gpx
        };
      }));
      if (requestId === this.statsRequestId) this.databaseStats.set(stats);
    } catch (error) {
      if (requestId === this.statsRequestId) this.status.set(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === this.statsRequestId) this.statsLoading.set(false);
    }
  };

  protected readonly importAllGpxTracks = async (): Promise<void> => {
    if (!this.desktop || this.busy()) return;
    this.busy.set(true);
    this.status.set('IMPORTING GPX TRACKS — PLEASE WAIT…');
    try {
      const result = await this.desktop.CacheManager.importGpxFolder();
      if (result.cancelled) {
        this.status.set('Import cancelled.');
        return;
      }
      this.effectiveDatabaseKey = result.folder && /^[a-z]:[\\/]/i.test(result.folder)
        ? result.folder.slice(0, 2) : this.databaseKey;
      if (this.effectiveDatabaseKey) this.imported.emit(this.effectiveDatabaseKey.toUpperCase());
      await this.refreshStats();
      this.status.set(
        `Imported ${result.imported.toLocaleString()} · unchanged ${result.unchanged.toLocaleString()} · duplicates ${result.duplicates.toLocaleString()} · errors ${result.errors.toLocaleString()}`
      );
    } catch (error) {
      this.status.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy.set(false);
    }
  };
}
