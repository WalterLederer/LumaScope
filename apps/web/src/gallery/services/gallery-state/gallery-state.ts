import { inject, Injectable, signal } from '@angular/core';
import { TreeNode, updateSubject } from '@light-matter/ui';
import { FileInfo, getThumbnailSize, thumbnailDimensions, ThumbnailSize } from 'internal-api';
import { BehaviorSubject, defer, filter, map, Observable, distinctUntilChanged, finalize, of, shareReplay, startWith, switchMap, take, tap } from 'rxjs';
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
  private readonly galleryRefreshing$ = new BehaviorSubject(false);
  private navigationRequest = 0;
  private navigationInFlight: { key: string; request: number; observable: Observable<boolean> } | null = null;
  private loadedNavigationKey: string | null = null;
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
  // Keep the first renderer workload bounded; subsequent pages load on demand.
  private readonly galleryWindowSize = 250;
  private galleryLoadedCount = 0;
  readonly galleryWindowStart = signal(0);
  private galleryTotalCount = 0;
  readonly totalFileCount = signal(0);
  readonly totalFileCountKnown = signal(false);
  readonly unfilteredFileCount = signal<number | null>(null);
  private galleryPageLoading = false;
  private pendingGalleryWindowOffset: number | null = null;
  private galleryFilesRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private deferredGalleryCountTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly includeUnsupportedFiles$ = new BehaviorSubject(false);
  private readonly dataSource$ = new BehaviorSubject<'filesystem' | 'database'>('filesystem');
  private filesystemFiles: FileInfo[] = [];
  private readonly includeFilesRecursive$ = new BehaviorSubject(false);
  private readonly nameFilter$ = new BehaviorSubject('');
  private readonly nameFilterActive$ = new BehaviorSubject(false);

  private readonly sortMode$ = new BehaviorSubject<SortMode>(defaultSortMode());

  constructor() {
    this.cacheManager.onGalleryFilesChanged(changedDirectory => {
      const selected = this.selectedLocation$.value;
      if (!selected) return;
      const normalize = (value: string): string => value.replace(/[\\/]+/g, '\\\\').replace(/\\+$/, '').toLocaleLowerCase();
      const root = normalize(selected);
      const changed = normalize(changedDirectory);
      const inScope = changed === root || (this.dataSource$.value === 'database' && this.includeFilesRecursive$.value && changed.startsWith(root + '\\\\'));
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
        const configuredSort = config.gallery.sortBy ?? defaultSort.sortBy;
        this.sortMode$.next({
          sortBy: config.gallery.dataSource !== 'database' && configuredSort === 'gpsDate' ? 'date' : configuredSort,
          sortDir: config.gallery.sortDir ?? defaultSort.sortDir
        });

        this.dataSource$.next(config.gallery.dataSource === 'database' ? 'database' : 'filesystem');
        this.includeFilesRecursive$.next(config.gallery.includeFilesRecursive ?? false);
        this.includeUnsupportedFiles$.next(config.gallery.includeUnsupportedFiles ?? false);

        // Resolve the initial gallery location exactly once, after the
        // persisted configuration (including favorites) has been loaded.
        // galleryRoot$ is deliberately side-effect free; it only builds the tree.
        const initialLocation = config.gallery.selectedLocation || config.gallery.locations[0] || null;
        if (initialLocation !== null) {
          this.navigateTo(initialLocation).subscribe();
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

        return root;
      }),
      shareReplay({ bufferSize: 1, refCount: true })
    );

  /* Getters */
  readonly locations = () => this.locations$;

  readonly thumbSize = () => this.thumbSize$;

  readonly images = () => this.images$.asObservable();
  readonly galleryLoading = () => this.galleryLoading$.asObservable();
  readonly galleryRefreshing = () => this.galleryRefreshing$.asObservable();
  readonly includeUnsupportedFiles = () => this.includeUnsupportedFiles$.asObservable();
  readonly dataSource = () => this.dataSource$.asObservable();
  readonly dataSourceValue = (): 'filesystem' | 'database' => this.dataSource$.value;
  readonly includeFilesRecursive = () => this.includeFilesRecursive$.asObservable();
  readonly includeFilesRecursiveValue = (): boolean => this.includeFilesRecursive$.value;

  readonly getGalleryFileByPath = async (sourcePath: string): Promise<FileInfo | null> => {
    if (this.dataSource$.value === 'filesystem') {
      return this.filesystemFiles.find(file => file.path.toLocaleLowerCase() === sourcePath.toLocaleLowerCase()) ?? null;
    }
    const directory = this.selectedLocation$.value;
    return directory ? this.cacheManager.getGalleryFileByPath(directory, sourcePath, this.includeFilesRecursive$.value) : null;
  };

  readonly getGalleryFilePosition = async (sourcePath: string): Promise<number> => {
    const directory = this.selectedLocation$.value;
    if (!directory) return 0;
    if (this.dataSource$.value === 'filesystem') {
      const index = this.getFilteredFilesystemFiles().findIndex(file => file.path.toLocaleLowerCase() === sourcePath.toLocaleLowerCase());
      return index < 0 ? 0 : index + 1;
    }
    const sort = this.sortMode$.value;
    return this.cacheManager.getGalleryFilePosition(
      directory, sourcePath, this.includeFilesRecursive$.value,
      this.includeUnsupportedFiles$.value, sort.sortBy, sort.sortDir
    );
  };

  readonly getLoadedGalleryFileAtPosition = (position: number): FileInfo | null => {
    if (!Number.isFinite(position) || position < 1) return null;
    const index = Math.trunc(position) - 1 - this.galleryWindowStart();
    return index >= 0 && index < this.images$.value.length
      ? this.images$.value[index]
      : null;
  };

  readonly getLoadedGalleryFilePosition = (sourcePath: string): number | null => {
    const index = this.dataSource$.value === 'filesystem'
      ? this.getFilteredFilesystemFiles().findIndex(image => image.path.toLocaleLowerCase() === sourcePath.toLocaleLowerCase())
      : this.images$.value.findIndex(image => image.path.toLocaleLowerCase() === sourcePath.toLocaleLowerCase());
    if (index < 0) return null;
    if (this.dataSource$.value === 'filesystem') {
      return index >= this.galleryWindowStart() && index < this.galleryWindowStart() + this.images$.value.length ? index + 1 : null;
    }
    return this.galleryWindowStart() + index + 1;
  };

  readonly getGalleryFileAtPosition = async (position: number): Promise<FileInfo | null> => {
    const loaded = this.getLoadedGalleryFileAtPosition(position);
    if (loaded) return loaded;
    const directory = this.selectedLocation$.value;
    if (!directory || !Number.isFinite(position) || position < 1) return null;
    if (this.dataSource$.value === 'filesystem') return this.getFilteredFilesystemFiles()[Math.trunc(position) - 1] ?? null;
    const sort = this.sortMode$.value;
    return this.cacheManager.getGalleryFileAtPosition(
      directory, this.includeFilesRecursive$.value,
      this.includeUnsupportedFiles$.value, sort.sortBy, sort.sortDir, position
    );
  };

  readonly setNameFilter = (value: string): void => {
    const normalized = typeof value === 'string' ? value.trim() : '';
    const valueChanged = this.nameFilter$.value !== normalized;
    const activeChanged = this.nameFilterActive$.value !== (normalized.length > 0);
    if (!valueChanged && !activeChanged) return;
    this.nameFilter$.next(normalized);
    this.nameFilterActive$.next(normalized.length > 0);
    const path = this.selectedLocation$.value;
    if (path) this.navigateTo(path, false).subscribe();
  };

  readonly setNameFilterActive = (active: boolean): void => {
    if (this.nameFilterActive$.value === active) return;
    this.nameFilterActive$.next(active);
    const path = this.selectedLocation$.value;
    if (path) this.navigateTo(path, false).subscribe();
  };

  readonly setDataSource = (value: 'filesystem' | 'database'): void => {
    if ((value !== 'filesystem' && value !== 'database') || this.dataSource$.value === value) return;
    this.dataSource$.next(value);
    const currentSort = this.sortMode$.value;
    const sortBy = value === 'filesystem' && currentSort.sortBy === 'gpsDate' ? 'date' : currentSort.sortBy;
    if (sortBy !== currentSort.sortBy) this.sortMode$.next({ ...currentSort, sortBy });
    this.configuration.updateGalleryConfig({ dataSource: value, ...(sortBy !== currentSort.sortBy ? { sortBy } : {}) });
    const path = this.selectedLocation$.value;
    if (path) this.navigateTo(path, false, true).subscribe();
  };

  readonly setIncludeUnsupportedFiles = (value: boolean): void => {
    if (this.includeUnsupportedFiles$.value === value) return;
    this.includeUnsupportedFiles$.next(value);
    this.unfilteredFileCount.set(null);
    this.configuration.updateGalleryConfig({ includeUnsupportedFiles: value });
    const path = this.selectedLocation$.value;
    if (path) this.navigateTo(path).subscribe();
  };

  readonly setIncludeFilesRecursive = (value: boolean): void => {
    if (this.includeFilesRecursive$.value === value) return;
    this.includeFilesRecursive$.next(value);
    this.unfilteredFileCount.set(null);
    this.configuration.updateGalleryConfig({ includeFilesRecursive: value });
    const path = this.selectedLocation$.value;
    if (path) this.navigateTo(path).subscribe();
  };

  readonly galleryRoot = () => this.galleryRoot$;

  readonly selectedLocation = () => this.selectedLocation$.pipe(distinctUntilChanged());

  readonly sortMode = () => this.sortMode$.asObservable();

  /* Modifiers */
  readonly navigateTo = (path: string, recordHistory = true, forceReload = false): Observable<boolean> => {
    if (recordHistory && this.navigationHistory[this.navigationHistoryIndex] !== path) {
      this.navigationHistory.splice(this.navigationHistoryIndex + 1);
      this.navigationHistory.push(path);
      this.navigationHistoryIndex = this.navigationHistory.length - 1;
      this.updateNavigationHistoryState();
    }
    const sort = this.sortMode$.value;
    const navigationKey = JSON.stringify([
      path, this.dataSource$.value, this.includeFilesRecursive$.value, this.includeUnsupportedFiles$.value,
      sort.sortBy, sort.sortDir, this.nameFilterActive$.value ? this.nameFilter$.value : ''
    ]);
    if (!forceReload && this.navigationInFlight?.key === navigationKey) {
      console.info('[GalleryDB] SKIP duplicate navigation | reason=in-flight | folder=' + path);
      return this.navigationInFlight.observable;
    }
    if (!forceReload && this.selectedLocation$.value === path
      && this.loadedNavigationKey === navigationKey && !this.galleryLoading$.value) {
      console.info('[GalleryDB] SKIP duplicate navigation | reason=already-loaded | folder=' + path);
      return of(true);
    }

    const request = ++this.navigationRequest;
    const folderChanged = this.selectedLocation$.value !== path;
    if (folderChanged) this.unfilteredFileCount.set(null);
    if (this.deferredGalleryCountTimer !== null) clearTimeout(this.deferredGalleryCountTimer);
    this.deferredGalleryCountTimer = null;
    this.selectedLocation$.next(path);
    this.galleryLoading$.next(true);
    this.galleryRefreshing$.next(false);
    this.galleryLoadedCount = 0;
    this.galleryWindowStart.set(0);
    this.galleryTotalCount = 0;
    this.totalFileCount.set(0);
    this.totalFileCountKnown.set(false);
    this.galleryPageLoading = false;
    this.pendingGalleryWindowOffset = null;
    this.images$.next([]);
    this.loadedNavigationKey = null;
    this.configuration.updateGalleryConfig({ selectedLocation: path });

    let sharedNavigation: Observable<boolean>;
    sharedNavigation = this.sortMode$
      .pipe(
        take(1),
        switchMap(sortMode => defer(() => {
          const startedAt = Date.now();
          if (this.dataSource$.value === 'filesystem') {
            console.info('[GalleryFS] START folder enumeration', { directory: path, recursive: false });
            return this.fileSystem.readImages(path, sortMode.sortBy, sortMode.sortDir, this.includeUnsupportedFiles$.value, false)
              .then(response => {
                if (!response.success) throw new Error(response.errorMessage || `Could not read folder: ${path}`);
                this.filesystemFiles = response.data;
                const files = this.getFilteredFilesystemFiles();
                console.info('[GalleryFS] DONE folder enumeration', { directory: path, files: response.data.length, displayed: files.length, durationMs: Date.now() - startedAt });
                return { files: files.slice(0, this.galleryWindowSize), totalCount: files.length };
              });
          }
          console.info('[GalleryDB] WAIT open database', { directory: path });
          return this.cacheManager.selectDatabaseForDirectory(path).then(() =>
            this.cacheManager.getGalleryFilesPage(path, this.includeFilesRecursive$.value, this.includeUnsupportedFiles$.value, sortMode.sortBy, sortMode.sortDir, 0, this.galleryWindowSize, (this.nameFilterActive$.value ? this.nameFilter$.value : ''), 'GalleryState.navigateTo', true)
          );
        })),
        tap(page => {
          if (request !== this.navigationRequest) return;
          this.galleryWindowStart.set(0);
          this.galleryLoadedCount = page.files.length;
          this.galleryTotalCount = page.totalCount >= 0
            ? page.totalCount
            : page.files.length < this.galleryWindowSize ? page.files.length : -1;
          this.totalFileCount.set(this.galleryTotalCount >= 0 ? this.galleryTotalCount : page.files.length);
          this.totalFileCountKnown.set(this.galleryTotalCount >= 0);
          if (!this.nameFilterActive$.value && this.galleryTotalCount >= 0) {
            this.unfilteredFileCount.set(this.galleryTotalCount);
          } else if (this.nameFilterActive$.value && this.unfilteredFileCount() === null) {
            void this.loadUnfilteredFileCount(path, request);
          }
          this.images$.next(page.files);
          this.loadedNavigationKey = navigationKey;
          if (this.dataSource$.value === 'database' && page.totalCount < 0 && page.files.length === this.galleryWindowSize) {
            // Defer the expensive COUNT until the initial Gallery window is visible.
            this.deferredGalleryCountTimer = setTimeout(() => {
              this.deferredGalleryCountTimer = null;
              if (request !== this.navigationRequest || this.selectedLocation$.value !== path) return;
              console.info('[GalleryDB] START deferred count', {
                rendererPage: typeof window !== 'undefined' ? window.location.href : 'unknown',
                rendererTimeOrigin: typeof performance !== 'undefined' ? performance.timeOrigin : null,
                folder: path
              });
              void this.cacheManager.getGalleryFilesPage(path, this.includeFilesRecursive$.value, this.includeUnsupportedFiles$.value, this.sortMode$.value.sortBy, this.sortMode$.value.sortDir, 0, 1, this.nameFilterActive$.value ? this.nameFilter$.value : '', 'GalleryState.deferredCount').then(countPage => {
                if (request !== this.navigationRequest || this.selectedLocation$.value !== path) return;
                if (countPage.totalCount >= 0) {
                  this.galleryTotalCount = countPage.totalCount;
                  this.totalFileCount.set(countPage.totalCount);
                  this.totalFileCountKnown.set(true);
                  if (!this.nameFilterActive$.value) this.unfilteredFileCount.set(countPage.totalCount);
                }
              }).catch(error => console.error('Failed to refresh deferred gallery count', path, error));
            }, 25000);
          }
        }),
        map(() => true),
        finalize(() => {
          if (request === this.navigationRequest) this.galleryLoading$.next(false);
          if (this.navigationInFlight?.request === request) this.navigationInFlight = null;
        }),
        shareReplay({ bufferSize: 1, refCount: false })
      );
    this.navigationInFlight = { key: navigationKey, request, observable: sharedNavigation };
    return sharedNavigation;
  };

  private readonly loadUnfilteredFileCount = async (directory: string, request: number): Promise<void> => {
    if (this.dataSource$.value === 'filesystem') {
      if (request === this.navigationRequest) this.unfilteredFileCount.set(this.filesystemFiles.length);
      return;
    }
    const sort = this.sortMode$.value;
    try {
      const page = await this.cacheManager.getGalleryFilesPage(
        directory, this.includeFilesRecursive$.value, this.includeUnsupportedFiles$.value,
        sort.sortBy, sort.sortDir, 0, 1, '', 'GalleryState.unfilteredFileCount'
      );
      if (request !== this.navigationRequest || directory !== this.selectedLocation$.value) return;
      if (page.totalCount >= 0) this.unfilteredFileCount.set(page.totalCount);
    } catch (error) {
      console.error('Failed to determine the unfiltered gallery file count', directory, error);
    }
  };

  readonly loadNextGalleryPage = (): void => {
    const directory = this.selectedLocation$.value;
    if (!directory || this.galleryPageLoading || (this.galleryTotalCount >= 0 && this.galleryLoadedCount >= this.galleryTotalCount)) return;
    if (this.dataSource$.value === 'filesystem') {
      this.loadGalleryWindow(this.galleryWindowStart() + this.galleryWindowSize);
      return;
    }
    const request = this.navigationRequest;
    const offset = this.galleryLoadedCount;
    const sort = this.sortMode$.value;
    this.galleryPageLoading = true;
    console.info('[GalleryDB] WAIT next page', { offset, limit: this.galleryPageSize });
    void this.cacheManager.getGalleryFilesPage(
      directory, this.includeFilesRecursive$.value, this.includeUnsupportedFiles$.value,
      sort.sortBy, sort.sortDir, offset, this.galleryPageSize, (this.nameFilterActive$.value ? this.nameFilter$.value : ''), 'GalleryState.loadNextPage'
    ).then(page => {
      console.info('[GalleryDB] DONE next page', { offset, rows: page.files.length });
      if (request !== this.navigationRequest || directory !== this.selectedLocation$.value) return;
      this.galleryLoadedCount = offset + page.files.length;
      if (page.totalCount >= 0) this.galleryTotalCount = page.totalCount;
      else if (page.files.length < this.galleryPageSize) this.galleryTotalCount = this.galleryLoadedCount;
      this.totalFileCount.set(this.galleryTotalCount >= 0 ? this.galleryTotalCount : this.galleryLoadedCount);
      this.totalFileCountKnown.set(this.galleryTotalCount >= 0);
      if (!this.nameFilterActive$.value && this.galleryTotalCount >= 0) {
        this.unfilteredFileCount.set(this.galleryTotalCount);
      } else if (this.nameFilterActive$.value && this.unfilteredFileCount() === null) {
        void this.loadUnfilteredFileCount(directory, request);
      }
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
    const maxOffset = Math.max(0, total - this.galleryWindowSize);
    const safeOffset = Number.isFinite(requestedOffset) ? Math.trunc(requestedOffset) : 0;
    const offset = Math.max(0, Math.min(maxOffset, safeOffset));
    if (this.galleryPageLoading) {
      this.pendingGalleryWindowOffset = offset;
      return;
    }
    if (offset === this.galleryWindowStart() && this.images$.value.length > 0) return;
    const request = this.navigationRequest;
    if (this.dataSource$.value === 'filesystem') {
      const files = this.getFilteredFilesystemFiles();
      this.galleryWindowStart.set(offset);
      this.galleryLoadedCount = Math.min(this.galleryWindowSize, Math.max(0, files.length - offset));
      this.images$.next(files.slice(offset, offset + this.galleryWindowSize));
      this.galleryTotalCount = files.length;
      this.totalFileCount.set(files.length);
      this.totalFileCountKnown.set(true);
      this.unfilteredFileCount.set(this.filesystemFiles.length);
      return;
    }
    const sort = this.sortMode$.value;
    this.galleryPageLoading = true;
    void this.cacheManager.getGalleryFilesPage(
      directory, this.includeFilesRecursive$.value, this.includeUnsupportedFiles$.value,
      sort.sortBy, sort.sortDir, offset, this.galleryWindowSize, (this.nameFilterActive$.value ? this.nameFilter$.value : ''), 'GalleryState.loadGalleryWindow'
    ).then(page => {
      if (request !== this.navigationRequest || directory !== this.selectedLocation$.value) return;
      this.galleryWindowStart.set(offset);
      this.galleryLoadedCount = page.files.length;
      if (page.totalCount >= 0) this.galleryTotalCount = page.totalCount;
      this.totalFileCount.set(this.galleryTotalCount >= 0 ? this.galleryTotalCount : Math.max(this.galleryWindowStart() + page.files.length, this.totalFileCount()));
      this.totalFileCountKnown.set(this.galleryTotalCount >= 0);
      if (!this.nameFilterActive$.value && this.galleryTotalCount >= 0) {
        this.unfilteredFileCount.set(this.galleryTotalCount);
      } else if (this.nameFilterActive$.value && this.unfilteredFileCount() === null) {
        void this.loadUnfilteredFileCount(directory, request);
      }
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
    if (this.dataSource$.value === 'filesystem') {
      this.navigateTo(directory, false, true).subscribe();
      return;
    }
    const request = ++this.navigationRequest;
    this.galleryRefreshing$.next(true);
    this.galleryPageLoading = false;
    this.pendingGalleryWindowOffset = null;
    const sort = this.sortMode$.value;
    const offset = this.galleryWindowStart();
    try {
      const page = await this.cacheManager.getGalleryFilesPage(
        directory, this.includeFilesRecursive$.value, this.includeUnsupportedFiles$.value,
        sort.sortBy, sort.sortDir, offset, this.galleryWindowSize, (this.nameFilterActive$.value ? this.nameFilter$.value : ''), 'GalleryState.refreshLoadedPages'
      );
      if (request !== this.navigationRequest) return;
      this.galleryLoadedCount = page.files.length;
      if (page.totalCount >= 0) this.galleryTotalCount = page.totalCount;
      this.totalFileCount.set(this.galleryTotalCount >= 0 ? this.galleryTotalCount : offset + page.files.length);
      this.totalFileCountKnown.set(this.galleryTotalCount >= 0);
      if (!this.nameFilterActive$.value && this.galleryTotalCount >= 0) {
        this.unfilteredFileCount.set(this.galleryTotalCount);
      } else if (this.nameFilterActive$.value && this.unfilteredFileCount() === null) {
        void this.loadUnfilteredFileCount(directory, request);
      }
      this.images$.next(page.files);
    } catch (error) {
      console.error('Failed to refresh the current gallery window', directory, error);
    } finally {
      if (request === this.navigationRequest) this.galleryRefreshing$.next(false);
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

    if (this.dataSource$.value === 'database') {
      try {
        await this.cacheManager.removeGalleryFile(path);
      } catch (error) {
        console.error('Failed to remove deleted gallery file from the cache database', path, error);
      }
    }
    this.filesystemFiles = this.filesystemFiles.filter(image => image.path !== path);
    this.images$.next(this.images$.value.filter(image => image.path !== path));
    if (this.galleryTotalCount >= 0) this.galleryTotalCount = Math.max(0, this.galleryTotalCount - 1);
    this.totalFileCount.set(this.galleryTotalCount >= 0 ? this.galleryTotalCount : Math.max(0, this.totalFileCount() - 1));
    this.totalFileCountKnown.set(this.galleryTotalCount >= 0);
    if (this.unfilteredFileCount() !== null) {
      this.unfilteredFileCount.set(Math.max(0, this.unfilteredFileCount()! - 1));
    }
    return true;
  };

  private readonly getFilteredFilesystemFiles = (): FileInfo[] => {
    const terms = this.nameFilterActive$.value ? this.nameFilter$.value.toLocaleLowerCase().split(' ').filter(Boolean) : [];
    return terms.length ? this.filesystemFiles.filter(file => terms.every(term => file.name.toLocaleLowerCase().includes(term))) : this.filesystemFiles;
  };

  /* Misc */
  readonly getDirContents = async (path: string) => await this.fileSystem.readDirectories(path);
}
