import { inject, Injectable } from '@angular/core';
import { distinctUntilChanged, map, shareReplay, take } from 'rxjs';
import { Configuration } from '../../../system/services/configuration/configuration';

@Injectable({ providedIn: 'root' })
export class GalleryLocations {
  private readonly configuration = inject(Configuration);

  constructor() {
    // Apply the persisted auto-sort preference to favorites loaded from the config file.
    this.configuration.config().pipe(take(1)).subscribe(config => {
      if (!(config.gallery.autoSortFavorites ?? true)) return;
      const sorted = [...config.gallery.locations].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
      );
      if (sorted.some((location, index) => location !== config.gallery.locations[index])) {
        this.updateLocations(new Set(sorted));
      }
    });
  }

  private readonly locations$ = this.configuration.config().pipe(
    map(config => config.gallery.locations),
    distinctUntilChanged((previous, current) => previous.length === current.length && previous.every((path, index) => path === current[index])),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  readonly locations = () => this.locations$;

  readonly autoSortFavorites = () => this.configuration.config().pipe(
    map(config => config.gallery.autoSortFavorites ?? true),
    distinctUntilChanged()
  );

  readonly setAutoSortFavorites = (enabled: boolean): void => {
    this.configuration.updateGalleryConfig({ autoSortFavorites: enabled });
    if (enabled) this.sortLocationsByPath();
  };

  readonly addLocation = (location: string): void => {
    this.configuration.config().pipe(take(1)).subscribe(config => {
      const locations = new Set(config.gallery.locations);
      locations.add(location);
      const ordered = [...locations];
      if (config.gallery.autoSortFavorites ?? true) {
        ordered.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
      }
      this.updateLocations(new Set(ordered));
    });
  };

  readonly removeLocation = (location: string) =>
    this.locations$
      .pipe(
        take(1),
        map(locations => {
          const set = new Set(locations);
          set.delete(location);
          return set;
        })
      )
      .subscribe(this.updateLocations);

  readonly moveLocation = (location: string, direction: 'up' | 'down') =>
    this.locations$
      .pipe(take(1))
      .subscribe(locations => {
        const reordered = [...locations];
        const index = reordered.indexOf(location);
        const targetIndex = index + (direction === 'up' ? -1 : 1);
        if (index < 0 || targetIndex < 0 || targetIndex >= reordered.length) return;
        [reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];
        this.updateLocations(new Set(reordered));
      });

  readonly sortLocationsByPath = () =>
    this.locations$
      .pipe(take(1))
      .subscribe(locations => this.updateLocations(new Set(
        [...locations].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
      )));

  private readonly updateLocations = (locations: Set<string>) =>
    this.configuration.updateGalleryConfig({ locations: Array.from(locations) });
}
