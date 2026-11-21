import { inject, Injectable, signal } from '@angular/core';
import { TreeNode, updateSubject } from '@light-matter/ui';
import { FileInfo, getThumbnailSize, thumbnailDimensions, ThumbnailSize } from 'internal-api';
import { BehaviorSubject, defer, filter, map, Observable, distinctUntilChanged, finalize, shareReplay, startWith, switchMap, take, tap } from 'rxjs';
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
  private readonly galleryLoading$ = new BehaviorSubject(false);
  private navigationRequest = 0;
  private readonly navigationHistory: string[] = [];
  private navigationHistoryIndex = -1;
  readonly canNavigateBack = signal(false);
  readonly canNavigateForward = signal(false);

  private readonly updateNavigationHistoryState = (): void => {
    this.canNavigateBack.set(this.navigationHistoryIndex > 0);
    this.canNavigateForward.set(this.navigationHistoryIndex >= 0 && this.navigationHistoryIndex < this.navigationHistory.length - 1);
  };

  readonly navigateBack = (): void => {
    if (!this.canNavigateBack()) return;
    this.navigationHistoryIndex--;
    const path = this.navigationHistory[this.navigationHistoryIndex];
    this.updateNavigationHistoryState();
    this.navigateTo(path, false).subscribe();
  };

  readonly navigateForward = (): void => {
    if (!this.canNavigateForward()) return;
    this.navigationHistoryIndex++;
    const path = this.navigationHistory[this.navigationHistoryIndex];
    this.updateNavigationHistoryState();
    this.navigateTo(path, false).subscribe();
  };
  private readonly galleryPageSize = 250;
  private readonly galleryWindowSize = 1000;
  private galleryLoadedCount = 0;
  readonly galleryWindowStart = signal(0);
  private galleryTotalCount = 0;
  readonly totalFileCount = signal(0);
  private galleryPageLoading = false;
  private pendingGalleryWindowOffset: number | null = null;
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
        this.refreshLoadedGalleryPages(currentFolder);
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
  readonly galleryLoading = () => this.galleryLoading$.asObservable();
  readonly includeUnsupportedFiles = () => this.includeUnsupportedFiles$.asObservable();
  readonly includeFilesRecursive = () => this.includeFilesRecursive$.asObservable();
  readonly includeFilesRecursiveValue = (): boolean => this.includeFilesRecursive$.value;

  readonly getGalleryFilePosition = async (sourcePath: string): Promise<number> => {
    const directory = this.selectedLocation$.value;
    if (!directory) return 0;
    const sort = this.sortMode$.value;
    return this.cacheManager.getGalleryFilePosition(
      directory, sourcePath, this.includeFilesRecursive$.value,
      this.includeUnsupportedFiles$.value, sort.sortBy, sort.sortDir
    );
  };

  readonly getGalleryFileAtPosition = async (position: number): Promise<FileInfo | null> => {
    const directory = this.selectedLocation$.value;
    if (!directory || !Number.isFinite(position) || position < 1) return null;
    const sort = this.sortMode$.value;
    return this.cacheManager.getGalleryFileAtPosition(
      directory, this.includeFilesRecursive$.value,
      this.includeUnsupportedFiles$.value, sort.sortBy, sort.sortDir, position
    );
  };

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
  readonly navigateTo = (path: string, recordHistory = true): Observable<boolean> => {
    if (recordHistory && this.navigationHistory[this.navigationHistoryIndex] !== path) {
      this.navigationHistory.splice(this.navigationHistoryIndex + 1);
      this.navigationHistory.push(path);
      this.navigationHistoryIndex = this.navigationHistory.length - 1;
      this.updateNavigationHistoryState();
    }
    const request = ++this.navigationRequest;
    this.selectedLocation$.next(path);
    this.galleryLoading$.next(true);
    this.galleryLoadedCount = 0;
    this.galleryWindowStart.set(0);
    this.galleryTotalCount = 0;
    this.totalFileCount.set(0);
    this.galleryPageLoading = false;
    this.pendingGalleryWindowOffset = null;
    this.images$.next([]);
    this.configuration.updateGalleryConfig({ selectedLocation: path });

    return this.sortMode$
      .pipe(
        take(1),
        switchMap(sortMode => defer(() => {
          const startedAt = Date.now();
          console.info('[GalleryDB] WAIT open database', { directory: path });
          return this.cacheManager.selectDatabaseForDirectory(path).then(() => {
            console.info('[GalleryDB] DONE open database', { durationMs: Date.now() - startedAt });
            console.info('[GalleryDB] WAIT first page', {
              recursive: this.includeFilesRecursive$.value,
              includeUnsupported: this.includeUnsupportedFiles$.value,
              sort: `${sortMode.sortBy} ${sortMode.sortDir}`,
              limit: this.galleryWindowSize
            });
            return this.cacheManager.getGalleryFilesPage(path, this.includeFilesRecursive$.value, this.includeUnsupportedFiles$.value, sortMode.sortBy, sortMode.sortDir, 0, this.galleryWindowSize);
          }).then(page => {
            console.info('[GalleryDB] DONE first page', {
              rows: page.files.length,
              durationMs: Date.now() - startedAt,
              morePagesPossible: page.files.length === this.galleryWindowSize
            });
            return page;
          });
        })),
        tap(page => {
          if (request !== this.navigationRequest) return;
          this.galleryWindowStart.set(0);
          this.galleryLoadedCount = page.files.length;
          this.galleryTotalCount = page.totalCount >= 0
            ? page.totalCount
            : page.files.length < this.galleryWindowSize ? page.files.length : -1;
          this.totalFileCount.set(this.galleryTotalCount >= 0 ? this.galleryTotalCount : page.files.length);
          this.images$.next(page.files);
        }),
        map(() => true),
        finalize(() => {
          if (request === this.navigationRequest) this.galleryLoading$.next(false);
        })
      );
  };

  readonly loadNextGalleryPage = (): void => {
    const directory = this.selectedLocation$.value;
    if (!directory || this.galleryPageLoading || (this.galleryTotalCount >= 0 && this.galleryLoadedCount >= this.galleryTotalCount)) return;
    const request = this.navigationRequest;
    const offset = this.galleryLoadedCount;
    const sort = this.sortMode$.value;
    this.galleryPageLoading = true;
    console.info('[GalleryDB] WAIT next page', { offset, limit: this.galleryPageSize });
    void this.cacheManager.getGalleryFilesPage(
      directory, this.includeFilesRecursive$.value, this.includeUnsupportedFiles$.value,
      sort.sortBy, sort.sortDir, offset, this.galleryPageSize
    ).then(page => {
      console.info('[GalleryDB] DONE next page', { offset, rows: page.files.length });
      if (request !== this.navigationRequest || directory !== this.selectedLocation$.value) return;
      this.galleryLoadedCount = offset + page.files.length;
      if (page.totalCount >= 0) this.galleryTotalCount = page.totalCount;
      else if (page.files.length < this.galleryPageSize) this.galleryTotalCount = this.galleryLoadedCount;
      this.totalFileCount.set(this.galleryTotalCount >= 0 ? this.galleryTotalCount : this.galleryLoadedCount);
      if (page.files.length > 0) this.images$.next([...this.images$.value, ...page.files]);
    }).catch(error => {
      console.error('Failed to load the next gallery database page', directory, error);
    }).finally(() => {
      if (request === this.navigationRequest) this.galleryPageLoading = false;
    });
  };

  /**
   * Load a bounded slice of the full database result set. The absolute
   * offset is retained separately so the view can render virtual spacers
   * while the renderer only holds this window in memory.
   */
  readonly loadGalleryWindow = (requestedOffset: number): void => {
    const directory = this.selectedLocation$.value;
    if (!directory) return;
    const total = this.galleryTotalCount >= 0 ? this.galleryTotalCount : this.totalFileCount();
    const maxOffset = Math.max(0, total - 1);
    const safeOffset = Number.isFinite(requestedOffset) ? Math.trunc(requestedOffset) : 0;
    const offset = Math.max(0, Math.min(maxOffset, safeOffset));
    if (this.galleryPageLoading) {
      this.pendingGalleryWindowOffset = offset;
      return;
    }
    if (offset === this.galleryWindowStart() && this.images$.value.length > 0) return;
    const request = this.navigationRequest;
    const sort = this.sortMode$.value;
    this.galleryPageLoading = true;
    void this.cacheManager.getGalleryFilesPage(
      directory, this.includeFilesRecursive$.value, this.includeUnsupportedFiles$.value,
      sort.sortBy, sort.sortDir, offset, this.galleryWindowSize
    ).then(page => {
      if (request !== this.navigationRequest || directory !== this.selectedLocation$.value) return;
      this.galleryWindowStart.set(offset);
      this.galleryLoadedCount = page.files.length;
      if (page.totalCount >= 0) this.galleryTotalCount = page.totalCount;
      this.totalFileCount.set(this.galleryTotalCount >= 0 ? this.galleryTotalCount : Math.max(this.galleryWindowStart() + page.files.length, this.totalFileCount()));
      this.images$.next(page.files);
    }).catch(error => {
      console.error('Failed to load a bounded gallery window', { directory, offset, error });
    }).finally(() => {
      if (request === this.navigationRequest) {
        this.galleryPageLoading = false;
        const pendingOffset = this.pendingGalleryWindowOffset;
        this.pendingGalleryWindowOffset = null;
        if (pendingOffset !== null && pendingOffset !== this.galleryWindowStart()) {
          this.loadGalleryWindow(pendingOffset);
        }
      }
    });
  };

  private readonly refreshLoadedGalleryPages = async (directory: string): Promise<void> => {
    const request = ++this.navigationRequest;
    this.galleryPageLoading = false;
    const sort = this.sortMode$.value;
    const offset = this.galleryWindowStart();
    try {
      const page = await this.cacheManager.getGalleryFilesPage(
        directory, this.includeFilesRecursive$.value, this.includeUnsupportedFiles$.value,
        sort.sortBy, sort.sortDir, offset, this.galleryWindowSize
      );
      if (request !== this.navigationRequest) return;
      this.galleryLoadedCount = page.files.length;
      this.galleryTotalCount = page.totalCount >= 0 ? page.totalCount : offset + page.files.length;
      this.totalFileCount.set(this.galleryTotalCount);
      this.images$.next(page.files);
    } catch (error) {
      console.error('Failed to refresh the current gallery window', directory, error);
    }
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
    if (this.galleryTotalCount >= 0) this.galleryTotalCount = Math.max(0, this.galleryTotalCount - 1);
    this.totalFileCount.set(this.galleryTotalCount >= 0 ? this.galleryTotalCount : Math.max(0, this.totalFileCount() - 1));
    return true;
  };

  /* Misc */
  readonly getDirContents = async (path: string) => await this.fileSystem.readDirectories(path);
}
