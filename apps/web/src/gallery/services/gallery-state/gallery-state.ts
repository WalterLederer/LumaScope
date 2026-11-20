import { inject, Injectable } from '@angular/core';
import { TreeNode, updateSubject } from '@light-matter/ui';
import { FileInfo, getThumbnailSize, thumbnailDimensions, ThumbnailSize } from 'internal-api';
import { BehaviorSubject, defer, filter, map, Observable, distinctUntilChanged, shareReplay, startWith, switchMap, take, tap } from 'rxjs';
import { FileSystem } from '../../../ipc/file-system';
import { CacheManager } from '../../../ipc/cache-manager';
import { Configuration } from '../../../system/services/configuration/configuration';
import { GalleryLocations } from '../gallery-locations/gallery-locations';
import { defaultSortMode, formatCompactPath, galleryRoot, SortMode, treeNode } from './gallery-state.types';

@Injectable({ providedIn: 'root' })
export class GalleryState {
  /* DI */
  private readonly galleryLocations = inject(GalleryLocations);

  private readonly configuration = inject(Configuration);

  private readonly fileSystem = inject(FileSystem);
  private readonly cacheManager = inject(CacheManager);

  /* State */
  private readonly locations$ = this.galleryLocations.locations();

  private readonly thumbSize$ = this.configuration.config().pipe(
    map(config => getThumbnailSize(config.gallery.thumbWidth, config.gallery.thumbHeight))
  );

  private readonly selectedLocation$ = new BehaviorSubject<string | null>(null);

  private readonly images$ = new BehaviorSubject<FileInfo[]>([]);
  private navigationRequest = 0;
  private galleryFilesRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly includeUnsupportedFiles$ = new BehaviorSubject(false);
  private readonly includeFilesRecursive$ = new BehaviorSubject(false);

  private readonly sortMode$ = new BehaviorSubject<SortMode>(defaultSortMode());

  constructor() {
    this.cacheManager.onGalleryFilesChanged(changedDirectory => {
      const selected = this.selectedLocation$.value;
      if (!selected) return;
      const normalize = (value: string): string => value.replace(/[\\/]+/g, '\\\\').replace(/\\+$/, '').toLocaleLowerCase();
      const root = normalize(selected);
      const changed = normalize(changedDirectory);
      const inScope = changed === root || (this.includeFilesRecursive$.value && changed.startsWith(root + '\\\\'));
      if (!inScope) return;
      // Coalesce a burst of folder notifications into one database read.
      if (this.galleryFilesRefreshTimer !== null) clearTimeout(this.galleryFilesRefreshTimer);
      this.galleryFilesRefreshTimer = setTimeout(() => {
        this.galleryFilesRefreshTimer = null;
        const currentFolder = this.selectedLocation$.value;
        if (!currentFolder) return;
        const request = ++this.navigationRequest;
        const sort = this.sortMode$.value;
        void this.cacheManager.getGalleryFiles(currentFolder, this.includeFilesRecursive$.value, this.includeUnsupportedFiles$.value, sort.sortBy, sort.sortDir)
          .then(images => { if (request === this.navigationRequest) this.images$.next(images); })
          .catch(error => console.error('Failed to refresh database-backed gallery files', currentFolder, error));
      }, 150);
    });
    this.configuration.config()
      .pipe(take(1))
      .subscribe(config => {
        const defaultSort = defaultSortMode();
        this.sortMode$.next({
          sortBy: config.gallery.sortBy ?? defaultSort.sortBy,
          sortDir: config.gallery.sortDir ?? defaultSort.sortDir
        });

        const savedLocation = config.gallery.selectedLocation;
        if (savedLocation) this.selectedLocation$.next(savedLocation);

        const selectedLocation = this.selectedLocation$.value;
        if (selectedLocation !== null) {
          this.navigateTo(selectedLocation).subscribe({
          });
        }
      });
  }

  private readonly galleryRoot$: Observable<TreeNode<string>> = this.locations$
    .pipe(
      startWith([]),
      map(locations => {
        const root = galleryRoot();
        const selectedLocation = this.selectedLocation$.value ?? locations[0] ?? null;
        const driveRoot = (path: string): string => {
          const normalized = path.replace(/\\/g, '/');
          const drive = normalized.match(/^([a-z]:)/i);
          if (drive) return drive[1].toLocaleUpperCase();
          if (normalized.startsWith('//')) return normalized.split('/').slice(0, 4).join('/').toLocaleLowerCase();
          return normalized.startsWith('/') ? '/' : (normalized.split('/')[0] ?? '').toLocaleLowerCase();
        };
        let previousDriveRoot: string | null = null;
        root.children = locations.map((location, index) => {
          const currentDriveRoot = driveRoot(location);
          const node = treeNode(location, false);
          node.groupStart = index > 0 && currentDriveRoot !== previousDriveRoot;
          previousDriveRoot = currentDriveRoot;
          node.label = formatCompactPath(location);
          node.title = location;
          node.canMoveUp = index > 0;
          node.canMoveDown = index < locations.length - 1;
          node.isSelected = location === selectedLocation;
          return node;
        });

        if (this.selectedLocation$.value === null && locations[0] !== undefined) {
          this.navigateTo(locations[0]).subscribe({
          });
        }

        return root;
      }),
      shareReplay({ bufferSize: 1, refCount: true })
    );

  /* Getters */
  readonly locations = () => this.locations$;

  readonly thumbSize = () => this.thumbSize$;

  readonly images = () => this.images$.asObservable();
  readonly includeUnsupportedFiles = () => this.includeUnsupportedFiles$.asObservable();
  readonly includeFilesRecursive = () => this.includeFilesRecursive$.asObservable();
  readonly includeFilesRecursiveValue = (): boolean => this.includeFilesRecursive$.value;

  readonly setIncludeUnsupportedFiles = (value: boolean): void => {
    if (this.includeUnsupportedFiles$.value === value) return;
    this.includeUnsupportedFiles$.next(value);
    const path = this.selectedLocation$.value;
    if (path) this.navigateTo(path).subscribe();
  };

  readonly setIncludeFilesRecursive = (value: boolean): void => {
    if (this.includeFilesRecursive$.value === value) return;
    this.includeFilesRecursive$.next(value);
    const path = this.selectedLocation$.value;
    if (path) this.navigateTo(path).subscribe();
  };

  readonly galleryRoot = () => this.galleryRoot$;

  readonly selectedLocation = () => this.selectedLocation$.pipe(distinctUntilChanged());

  readonly sortMode = () => this.sortMode$.asObservable();

  /* Modifiers */
  readonly navigateTo = (path: string): Observable<boolean> => {
    const request = ++this.navigationRequest;
    this.selectedLocation$.next(path);
    this.configuration.updateGalleryConfig({ selectedLocation: path });

    return this.sortMode$
      .pipe(
        take(1),
        switchMap(sortMode => defer(() =>
          this.cacheManager.selectDatabaseForDirectory(path).then(() =>
            this.cacheManager.getGalleryFiles(path, this.includeFilesRecursive$.value, this.includeUnsupportedFiles$.value, sortMode.sortBy, sortMode.sortDir)
          )
        )),
        tap(images => {
          if (request === this.navigationRequest) this.images$.next(images);
        }),
        map(() => true)
      );
  };

  readonly changeSorting = (sortMode: Partial<SortMode>) =>
    updateSubject(this.sortMode$, sortMode)
      .pipe(
        tap(() => {
          const current = this.sortMode$.value;
          this.configuration.updateGalleryConfig({ sortBy: current.sortBy, sortDir: current.sortDir });
        }),
        switchMap(() => this.selectedLocation$.pipe(take(1))),
        filter(path => path !== null)
      )
      .subscribe(path => this.navigateTo(path).subscribe());

  readonly changeThumbnailSize = (size: ThumbnailSize) => {
    const dimensions = thumbnailDimensions[size];

    this.configuration.updateGalleryConfig({
      thumbWidth: dimensions.width,
      thumbHeight: dimensions.height
    });
  };

  readonly deleteImage = async (path: string): Promise<boolean> => {
    const response = await this.fileSystem.deleteFile(path);

    if (!response.success) {
      return false;
    }

    try {
      await this.cacheManager.removeGalleryFile(path);
    } catch (error) {
      console.error('Failed to remove deleted gallery file from the cache database', path, error);
    }
    this.images$.next(this.images$.value.filter(image => image.path !== path));
    return true;
  };

  /* Misc */
  readonly getDirContents = async (path: string) => await this.fileSystem.readDirectories(path);
}
