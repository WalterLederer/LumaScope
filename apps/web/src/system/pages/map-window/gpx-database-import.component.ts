import { ChangeDetectionStrategy, Component, EventEmitter, Input, OnChanges, OnInit, Output, SimpleChanges, signal } from '@angular/core';
import { Desktop } from 'internal-api';

@Component({
  selector: 'app-gpx-database-import',
  standalone: true,
  template: `
    <details class="gpx-database-section app-disclosure">
      <summary>GPX → DB</summary>
      <div class="gpx-database-import-row">
        <button type="button" class="offline-map-add-button" (click)="importAllGpxTracks()" [disabled]="busy()">
          {{ busy() ? 'Importing GPX tracks…' : 'Add all GPX tracks from folder to DB…' }}
        </button>
        <button type="button" class="routing-help-button" (click)="refreshStats()" [disabled]="busy()" title="Refresh GPX database information" aria-label="Refresh GPX database information"><span aria-hidden="true">⟳</span></button>
        <div class="gpx-database-statistics-list" aria-live="polite">
          @for (item of databaseStats(); track item.key) {
            <span class="gpx-database-statistics" title="GPX data in this drive's cache database">
              {{ item.key }}: {{ item.files.toLocaleString() }} GPX files · {{ item.segments.toLocaleString() }} segments · {{ item.points.toLocaleString() }} points
            </span>
          } @empty {
            <span class="gpx-database-statistics">No favorite-drive cache databases selected.</span>
          }
        </div>
        <button type="button" class="routing-help-button gpx-database-help" (click)="help.emit()" title="Open GPX cache documentation" aria-label="Open GPX cache documentation"><span aria-hidden="true">?</span></button>
      </div>
      @if (status()) {
        <span class="offline-map-status gpx-database-import-status" [class.gpx-database-import-progress]="busy()" role="status" aria-live="polite">{{ status() }}</span>
      }
    </details>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class GpxDatabaseImportComponent implements OnInit, OnChanges {
  @Input() databaseKey: string | undefined;
  @Input() databaseKeys: string[] = [];
  @Output() readonly help = new EventEmitter<void>();

  private readonly desktop = (window as unknown as { desktop?: Desktop }).desktop;
  private effectiveDatabaseKey: string | undefined;
  protected readonly databaseStats = signal<Array<{ key: string; files: number; segments: number; points: number }>>([]);
  protected readonly busy = signal(false);
  protected readonly status = signal('');

  ngOnInit(): void {
    this.effectiveDatabaseKey = this.databaseKey;
    void this.refreshStats();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if ((changes['databaseKey'] && !changes['databaseKey'].firstChange) || (changes['databaseKeys'] && !changes['databaseKeys'].firstChange)) {
      this.effectiveDatabaseKey = this.databaseKey;
      void this.refreshStats();
    }
  }

  protected readonly refreshStats = async (): Promise<void> => {
    if (!this.desktop) return;
    try {
      const keys = [...new Set([...(this.databaseKeys ?? []), this.effectiveDatabaseKey].filter((key): key is string => !!key && /^[a-z]:$/i.test(key)).map(key => key.toUpperCase()))].sort();
      const stats = await Promise.all(keys.map(async key => ({ key, ...await this.desktop!.CacheManager.getGpxDatabaseStats(key) })));
      this.databaseStats.set(stats);
    } catch (error) {
      this.status.set(error instanceof Error ? error.message : String(error));
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
