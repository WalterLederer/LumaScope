import { inject, Injectable, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { BehaviorSubject, combineLatest, filter, firstValueFrom, map, Observable, pairwise, take, tap, withLatestFrom } from 'rxjs';
import { GalleryState } from '../../../gallery/services/gallery-state/gallery-state';
import { CacheManager } from '../../../ipc/cache-manager';
import { imageUrl } from '../../utils/image-url';
import { SelectedImage } from './view-navigator.types';

@Injectable({ providedIn: 'root' })
export class ViewNavigator {
  /* DI */
  private readonly galleryState = inject(GalleryState);
  private readonly cacheManager = inject(CacheManager);

  /* State */
  readonly standalone = signal(false);

  private readonly images$ = this.galleryState.images();
  private readonly cacheRevision$ = toObservable(this.cacheManager.cacheRevision);

  private readonly selectedIndex$ = new BehaviorSubject(-1);

  constructor() {
    // Sorting or refreshing the gallery can reorder the image array. Keep the
    // selected file stable by translating its old index to its new index.
    // Otherwise the same numeric index would silently select a different file
    // and ImageView would interpret that as an explicit image selection.
    this.images$
      .pipe(pairwise(), withLatestFrom(this.selectedIndex$))
      .subscribe(([[previousImages, currentImages], selectedIndex]) => {
        if (selectedIndex < 0 || selectedIndex >= previousImages.length) return;
        const selectedPath = previousImages[selectedIndex].path;
        const nextIndex = currentImages.findIndex(image => image.path === selectedPath);
        if (nextIndex >= 0 && nextIndex !== selectedIndex) {
          this.selectedIndex$.next(nextIndex);
        }
      });
  }

  private readonly selectedImage$: Observable<SelectedImage | null> = combineLatest([
    this.images$,
    this.selectedIndex$,
    this.cacheRevision$
  ])
    .pipe(
      map(([ images, index, cacheRevision ]) => {
        if (index < 0 || index >= images.length) {
          return null;
        }

        return {
          path: images[index].path,
          url: imageUrl(images[index].path, cacheRevision),
          size: images[index].size,
          modifiedAt: images[index].modifiedAt
        };
      })
    );

  private readonly hasPrevious$ = combineLatest([ this.images$, this.selectedIndex$ ])
    .pipe(map(([ _, index ]) => index > 0));

  private readonly hasNext$ = combineLatest([ this.images$, this.selectedIndex$ ])
    .pipe(map(([ images, index ]) => index >= 0 && index < images.length - 1));

  /* Getters */
  readonly selectedImage = () => this.selectedImage$;

  readonly imagePosition = () => combineLatest([ this.images$, this.selectedIndex$ ])
    .pipe(map(([ images, index ]) => ({ position: index >= 0 && index < images.length ? index + 1 : 0, total: images.length })));

  readonly hasPrevious = () => this.hasPrevious$;

  readonly hasNext = () => this.hasNext$;

  /* Modifiers */
  readonly previous = () =>
    combineLatest([ this.hasPrevious$, this.selectedIndex$ ])
      .pipe(
        take(1),
        filter(([ hasPrevious ]) => hasPrevious),
        map(([ _, selectedIndex ]) => selectedIndex - 1)
      )
      .subscribe(selectedIndex => this.selectedIndex$.next(selectedIndex));

  readonly next = () =>
    combineLatest([ this.hasNext$, this.selectedIndex$ ])
      .pipe(
        take(1),
        filter(([ hasNext ]) => hasNext),
        map(([ _, selectedIndex ]) => selectedIndex + 1)
      )
      .subscribe(selectedIndex => this.selectedIndex$.next(selectedIndex));

  readonly selectPosition = (position: number) =>
    this.images$
      .pipe(take(1), map(images => Math.max(0, Math.min(images.length - 1, Math.trunc(position) - 1))))
      .subscribe(index => this.selectedIndex$.next(index));

  readonly selectImage = (path: string) =>
    this.images$
      .pipe(
        take(1),
        map(images => images.findIndex(image => image.path === path)),
        tap(index => this.selectedIndex$.next(index)),
        map(index => index >= 0)
      );

  readonly deleteImage = async (path: string): Promise<boolean> => {
    const images = await firstValueFrom(this.images$.pipe(take(1)));
    const deletedIndex = images.findIndex(image => image.path === path);

    if (deletedIndex < 0 || !await this.galleryState.deleteImage(path)) {
      return false;
    }

    const selectedIndex = this.selectedIndex$.value;

    if (deletedIndex < selectedIndex) {
      this.selectedIndex$.next(selectedIndex - 1);
    } else if (deletedIndex === selectedIndex && deletedIndex >= images.length - 1) {
      this.selectedIndex$.next(Math.max(0, selectedIndex - 1));
    }

    return true;
  };
}
