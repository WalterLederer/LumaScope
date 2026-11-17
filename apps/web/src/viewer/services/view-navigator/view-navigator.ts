import { inject, Injectable, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { BehaviorSubject, combineLatest, filter, firstValueFrom, map, Observable, take, tap } from 'rxjs';
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

  // Keep the selected file stable when sorting or refreshing changes its index.
  private readonly selectedPath$ = new BehaviorSubject<string | null>(null);

  private readonly selectedImage$: Observable<SelectedImage | null> = combineLatest([
    this.images$,
    this.selectedPath$,
    this.cacheRevision$
  ]).pipe(
    map(([images, selectedPath, cacheRevision]) => {
      if (selectedPath === null) return null;
      const image = images.find(item => item.path === selectedPath);
      if (!image) return null;

      return {
        path: image.path,
        url: imageUrl(image.path, cacheRevision),
        size: image.size,
        modifiedAt: image.modifiedAt
      };
    })
  );

  private readonly selectedIndex$ = combineLatest([this.images$, this.selectedPath$])
    .pipe(map(([images, selectedPath]) => selectedPath === null
      ? -1
      : images.findIndex(image => image.path === selectedPath)));

  private readonly hasPrevious$ = this.selectedIndex$
    .pipe(map(index => index > 0));

  private readonly hasNext$ = combineLatest([this.images$, this.selectedIndex$])
    .pipe(map(([images, index]) => index >= 0 && index < images.length - 1));

  /* Getters */
  readonly selectedImage = () => this.selectedImage$;

  readonly imagePosition = () => combineLatest([this.images$, this.selectedIndex$])
    .pipe(map(([images, index]) => ({
      position: index >= 0 && index < images.length ? index + 1 : 0,
      total: images.length
    })));

  readonly hasPrevious = () => this.hasPrevious$;

  readonly hasNext = () => this.hasNext$;

  /* Modifiers */
  readonly previous = () => combineLatest([this.images$, this.selectedIndex$])
    .pipe(
      take(1),
      filter(([_, index]) => index > 0),
      map(([images, index]) => images[index - 1].path)
    )
    .subscribe(path => this.selectedPath$.next(path));

  readonly next = () => combineLatest([this.images$, this.selectedIndex$])
    .pipe(
      take(1),
      filter(([images, index]) => index >= 0 && index < images.length - 1),
      map(([images, index]) => images[index + 1].path)
    )
    .subscribe(path => this.selectedPath$.next(path));

  readonly selectPosition = (position: number) => this.images$
    .pipe(
      take(1),
      map(images => images[Math.max(0, Math.min(images.length - 1, Math.trunc(position) - 1))]?.path ?? null)
    )
    .subscribe(path => this.selectedPath$.next(path));

  readonly selectImage = (path: string) => this.images$
    .pipe(
      take(1),
      map(images => images.some(image => image.path === path)),
      tap(found => this.selectedPath$.next(found ? path : null))
    );

  readonly deleteImage = async (path: string): Promise<boolean> => {
    const images = await firstValueFrom(this.images$.pipe(take(1)));
    const deletedIndex = images.findIndex(image => image.path === path);

    if (deletedIndex < 0 || !await this.galleryState.deleteImage(path)) {
      return false;
    }

    if (this.selectedPath$.value === path) {
      const remainingImages = await firstValueFrom(this.images$.pipe(take(1)));
      const replacement = remainingImages[Math.min(deletedIndex, remainingImages.length - 1)];
      this.selectedPath$.next(replacement?.path ?? null);
    }

    return true;
  };
}
