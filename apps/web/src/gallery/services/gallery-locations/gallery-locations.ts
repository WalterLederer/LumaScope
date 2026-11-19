import { inject, Injectable } from '@angular/core';
import { distinctUntilChanged, map, shareReplay, take } from 'rxjs';
import { Configuration } from '../../../system/services/configuration/configuration';

@Injectable({ providedIn: 'root' })
export class GalleryLocations {
  private readonly configuration = inject(Configuration);

  private readonly locations$ = this.configuration.config().pipe(
    map(config => config.gallery.locations),
    distinctUntilChanged((previous, current) => previous.length === current.length && previous.every((path, index) => path === current[index])),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  readonly locations = () => this.locations$;

  readonly addLocation = (location: string) =>
    this.locations$
      .pipe(
        take(1),
        map(locations => new Set(locations).add(location))
      )
      .subscribe(this.updateLocations);

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
