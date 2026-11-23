import { inject, Injectable, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { BehaviorSubject, combineLatest, distinctUntilChanged, firstValueFrom, from, map, Observable, of, shareReplay, switchMap, take, tap, catchError } from 'rxjs';
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

  private readonly selectedPath$ = new BehaviorSubject<string | null>(null);
  private readonly totalFileCount$ = toObservable(this.galleryState.totalFileCount);
  private readonly cacheRevision$ = toObservable(this.cacheManager.cacheRevision);

  // Resolve the selected path against the database's complete, sorted result set.
  // This keeps navigation independent of how many thumbnail pages are resident.
  private readonly selectedIndex$: Observable<number> = combineLatest([
    this.selectedPath$,
    this.galleryState.selectedLocation(),
    this.galleryState.sortMode(),
    this.galleryState.includeUnsupportedFiles(),
    this.galleryState.includeFilesRecursive()
  ]).pipe(
    switchMap(([path]) => {
      if (path === null) return of(-1);
      const loadedPosition = this.galleryState.getLoadedGalleryFilePosition(path);
      if (loadedPosition !== null) return of(loadedPosition - 1);
      return from(this.galleryState.getGalleryFilePosition(path)).pipe(
        map(position => position > 0 ? position - 1 : -1),
        catchError(error => {
          console.error('Failed to resolve selected gallery file position', path, error);
          return of(-1);
        })
      );
    }),
    // imagePosition, hasPrevious and hasNext all consume this same index.
    // Share the database lookup instead of running one per subscriber.
    shareReplay({ bufferSize: 1, refCount: true })
  );

  // Resolve the selected file only when the selection changes. Cache revisions
  // only invalidate the image URL; they must not repeat the database position
  // lookup and page query for the same selected file.
  private readonly selectedFile$ = this.selectedPath$.pipe(
    distinctUntilChanged(),
    switchMap(path => {
      if (path === null) return of(null);
      const loadedPosition = this.galleryState.getLoadedGalleryFilePosition(path);
      if (loadedPosition !== null) {
        return of(this.galleryState.getLoadedGalleryFileAtPosition(loadedPosition));
      }
      return from(this.galleryState.getGalleryFilePosition(path)).pipe(
        switchMap(position => position > 0
          ? from(this.galleryState.getGalleryFileAtPosition(position))
          : of(null)),
        catchError(error => {
          console.error('Failed to load selected gallery file', path, error);
          return of(null);
        })
      );
    }),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  private readonly selectedImage$: Observable<SelectedImage | null> = combineLatest([
    this.selectedFile$,
    this.cacheRevision$
  ]).pipe(
    map(([image, cacheRevision]) => image ? {
      path: image.path,
      url: imageUrl(image.path, cacheRevision),
      size: image.size,
      modifiedAt: image.modifiedAt
    } : null)
  );

  /* Getters */
  readonly selectedImage = () => this.selectedImage$;

  readonly imagePosition = () => combineLatest([this.selectedIndex$, this.totalFileCount$])
    .pipe(map(([index, total]) => ({
      position: index >= 0 && index < total ? index + 1 : 0,
      total
    })));

  readonly hasPrevious = () => this.selectedIndex$.pipe(map(index => index > 0));

  readonly hasNext = () => combineLatest([this.selectedIndex$, this.totalFileCount$])
    .pipe(map(([index, total]) => index >= 0 && index < total - 1));

  /* Modifiers */
  readonly previous = async (): Promise<void> => {
    const index = await firstValueFrom(this.selectedIndex$.pipe(take(1)));
    if (index <= 0) return;
    const image = await this.galleryState.getGalleryFileAtPosition(index);
    if (image) this.selectedPath$.next(image.path);
  };

  readonly next = async (): Promise<void> => {
    const [index, total] = await firstValueFrom(combineLatest([
      this.selectedIndex$, this.totalFileCount$
    ]).pipe(take(1)));
    if (index < 0 || index >= total - 1) return;
    const image = await this.galleryState.getGalleryFileAtPosition(index + 2);
    if (image) this.selectedPath$.next(image.path);
  };

  readonly selectPosition = (position: number): void => {
    const total = this.galleryState.totalFileCount();
    const target = Math.max(1, Math.min(total, Math.trunc(position)));
    if (total <= 0 || !Number.isFinite(target)) {
      this.selectedPath$.next(null);
      return;
    }
    void this.galleryState.getGalleryFileAtPosition(target).then(image => {
      this.selectedPath$.next(image?.path ?? null);
    }).catch(error => console.error('Failed to select gallery position', target, error));
  };

  readonly selectImage = (path: string): Observable<boolean> => from(
    this.galleryState.getGalleryFilePosition(path)
  ).pipe(
    map(position => position > 0),
    tap(found => this.selectedPath$.next(found ? path : null)),
    catchError(error => {
      console.error('Failed to select gallery image', path, error);
      this.selectedPath$.next(null);
      return of(false);
    })
  );

  readonly deleteImage = async (path: string): Promise<boolean> => {
    const deletedPosition = await this.galleryState.getGalleryFilePosition(path);
    if (deletedPosition <= 0 || !await this.galleryState.deleteImage(path)) return false;

    if (this.selectedPath$.value === path) {
      const nextTotal = this.galleryState.totalFileCount();
      const replacement = nextTotal > 0
        ? await this.galleryState.getGalleryFileAtPosition(Math.min(deletedPosition, nextTotal))
        : null;
      this.selectedPath$.next(replacement?.path ?? null);
    }

    return true;
  };
}
