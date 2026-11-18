import { ChangeDetectionStrategy, Component, EventEmitter, Input, OnChanges, OnInit, Output, SimpleChanges, signal } from '@angular/core';
import { Desktop } from 'internal-api';

@Component({
  selector: 'app-gpx-database-import',
  standalone: true,
  template: `
    <details class="gpx-database-section app-disclosure">
      <summary>GPX -&gt; DB</summary>
      <div class="gpx-database-import-row">
        <button type="button" class="offline-map-add-button" (click)="importAllGpxTracks()" [disabled]="busy()">
          {{ busy() ? 'Importing GPX tracks…' : 'Add all GPX tracks from folder to DB…' }}
        </button>
        <button type="button" class="routing-help-button" (click)="refreshStats()" [disabled]="busy()" title="Refresh GPX database information" aria-label="Refresh GPX database information"><span aria-hidden="true">⟳</span></button>
        <span class="gpx-database-statistics" title="Stored in the cache database for this drive">
          Database: {{ stats().files.toLocaleString() }} GPX files · {{ stats().segments.toLocaleString() }} segments · {{ stats().points.toLocaleString() }} points
        </span>
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
  @Output() readonly help = new EventEmitter<void>();

  private readonly desktop = (window as unknown as { desktop?: Desktop }).desktop;
  private effectiveDatabaseKey: string | undefined;
  protected readonly stats = signal({ files: 0, segments: 0, points: 0 });
  protected readonly busy = signal(false);
  protected readonly status = signal('');

  ngOnInit(): void {
    this.effectiveDatabaseKey = this.databaseKey;
    void this.refreshStats();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['databaseKey'] && !changes['databaseKey'].firstChange) {
      this.effectiveDatabaseKey = this.databaseKey;
      void this.refreshStats();
    }
  }

  protected readonly refreshStats = async (): Promise<void> => {
    if (!this.desktop) return;
    try {
      this.stats.set(await this.desktop.CacheManager.getGpxDatabaseStats(this.effectiveDatabaseKey));
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
      this.effectiveDatabaseKey = result.folder && /^[a-z]:[\\\\/]/i.test(result.folder)
        ? result.folder.slice(0, 2) : this.databaseKey;
      this.stats.set({ files: result.files, segments: result.segments, points: result.points });
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
