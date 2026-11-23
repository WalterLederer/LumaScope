import { CdkMenu, CdkMenuItem, CdkMenuTrigger } from '@angular/cdk/menu';
import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { distinctUntilChanged, fromEvent, map } from 'rxjs';
import {
  ActionButtonComponent,
  IconComponent,
  PopupMenuComponent,
  SliderComponent,
  StopPropagation,
  TextComponent,
  TitleComponent,
  ToolbarComponent, ButtonTooltipDirective} from '@light-matter/ui';
import { CacheDirectoryStats, ExifTags, formatOsDateTime as formatSystemDateTime } from 'internal-api';
import {
  allSortDirections,
  allSortTypes,
  allThumbnailSizes,
  defaultThumbnailSize,
  FileInfo,
  SortDirection,
  SortType,
  thumbnailDimensions,
  ThumbnailSize
} from 'internal-api';
import { ImagesComponent } from '../images/images.component';
import { ExifService } from '../../../ipc/exif';
import { CacheManager } from '../../../ipc/cache-manager';
import { ProcessManager } from '../../../ipc/process-manager';
import { GalleryCacheBuild } from '../../services/gallery-cache-build/gallery-cache-build';
import { imageDynamicRange } from '../../../viewer/utils/image-dynamic-range';
import { GalleryViewMode } from '../images/images.component.types';
import { GalleryState } from '../../services/gallery-state/gallery-state';
import { formatNumber } from '../../../ui/utils/format-number';

@Component({
  selector: 'app-image-grid',
  imports: [
    ImagesComponent,
    ToolbarComponent,
    TitleComponent,
    ActionButtonComponent,
    IconComponent,
    StopPropagation,
    CdkMenuTrigger,
    CdkMenu,
    CdkMenuItem,
    PopupMenuComponent,
    TextComponent,
    SliderComponent,
    ReactiveFormsModule,
    ButtonTooltipDirective
  ],
  templateUrl: './image-grid.component.html',
  styleUrl: './image-grid.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ImageGridComponent {
  /* Inputs */
  readonly images = input.required<FileInfo[] | null>();

  readonly selectedImagePath = input<string | null>(null);

  readonly selectedLocation = input.required<string | null>();

  readonly hoveredFolderPath = input<string | null>(null);

  readonly sortBy = input<SortType>(allSortTypes[0]);

  readonly sortDirection = input<SortDirection>(allSortDirections[0]);

  readonly thumbSize = input<ThumbnailSize>(defaultThumbnailSize);

  private readonly document = inject(DOCUMENT);

  private readonly readStoredViewMode = (): GalleryViewMode => {
    try {
      const stored = this.document.defaultView?.localStorage.getItem('galleryViewMode');
      return stored === 'tiles' || stored === 'details' || stored === 'details-no-thumbnails' ? stored : 'thumbnails';
    } catch { return 'thumbnails'; }
  };

  private readonly readStoredDetailFontSize = (): number => {
    try {
      const stored = Number(this.document.defaultView?.localStorage.getItem('galleryDetailFontSize'));
      return Number.isFinite(stored) && stored >= 10 && stored <= 24 ? Math.round(stored) : 12;
    } catch { return 12; }
  };

  readonly formatNumber = formatNumber;
  readonly viewMode = signal<GalleryViewMode>(this.readStoredViewMode());
  readonly detailScrollTop = signal(0);
  readonly detailViewportHeight = signal(1200);
  readonly detailHeaderHeight = signal(0);
  readonly thumbnailColumns = signal(1);
  readonly thumbnailRowHeight = signal(160);
  private thumbnailGeometryInitialized = false;

  private readonly updateThumbnailGridGeometry = (viewport: HTMLElement): void => {
    const grid = viewport.querySelector<HTMLElement>('.images');
    const tiles = Array.from(viewport.querySelectorAll<HTMLElement>('.images > app-thumbnail'));
    const first = tiles[0];
    if (!first) return;
    const firstTop = first.offsetTop;
    const nextRow = tiles.find(tile => tile.offsetTop > firstTop);
    const styles = this.document.defaultView?.getComputedStyle(grid ?? first);
    const rowGap = Number.parseFloat(styles?.rowGap ?? '') || 0;
    const measuredHeight = first.getBoundingClientRect().height;
    const rowHeight = nextRow ? nextRow.offsetTop - firstTop : measuredHeight + rowGap;
    const columns = Math.max(1, tiles.filter(tile => tile.offsetTop === firstTop).length);
    const nextRowHeight = Math.max(1, rowHeight);
    const previousColumns = Math.max(1, this.thumbnailColumns());
    const previousRowHeight = Math.max(1, this.thumbnailRowHeight());
    const geometryChanged = previousColumns !== columns || Math.abs(previousRowHeight - nextRowHeight) > 0.5;

    if (this.thumbnailGeometryInitialized && geometryChanged && viewport.scrollTop > 0) {
      // Keep the first image row anchored when the viewport width or thumbnail
      // size changes the number or height of grid rows.
      const previousRowPosition = viewport.scrollTop / previousRowHeight;
      const previousImageIndex = Math.floor(previousRowPosition) * previousColumns;
      const nextRowPosition = previousImageIndex / columns + (previousRowPosition % 1);
      const nextScrollTop = Math.max(0, nextRowPosition * nextRowHeight);
      viewport.scrollTop = nextScrollTop;
      this.detailScrollTop.set(nextScrollTop);
    }

    if (this.thumbnailColumns() !== columns) this.thumbnailColumns.set(columns);
    if (Math.abs(this.thumbnailRowHeight() - nextRowHeight) > 0.5) this.thumbnailRowHeight.set(nextRowHeight);
    this.thumbnailGeometryInitialized = true;
  };

  protected readonly onGalleryScroll = (event: Event): void => {
    const viewport = event.currentTarget as HTMLElement;
    const header = viewport.querySelector<HTMLElement>('.detail-native-table thead');
    this.detailScrollTop.set(viewport.scrollTop);
    this.detailViewportHeight.set(viewport.clientHeight);
    this.detailHeaderHeight.set(header?.getBoundingClientRect().height ?? 0);

    const images = this.images() ?? [];
    const windowStart = this.galleryState.galleryWindowStart();
    const viewMode = this.viewMode();

    if (viewMode === 'details' || viewMode === 'details-no-thumbnails') {
      // Ignore the virtual spacer rows: their height can represent thousands of files.
      // Measuring one as a data row corrupts the scroll-to-index calculation and
      // prevents the next 1,000-file window from being requested.
      const firstRow = viewport.querySelector<HTMLElement>('.detail-native-table tbody tr.detail-virtual-row');
      const rowHeight = firstRow?.getBoundingClientRect().height ?? 36;
      const globalIndex = Math.max(0, Math.floor(Math.max(0, viewport.scrollTop - this.detailHeaderHeight()) / Math.max(1, rowHeight)));
      const threshold = Math.max(80, Math.floor(images.length * 0.2));
      if (globalIndex < windowStart + threshold || globalIndex > windowStart + images.length - threshold) {
        this.galleryState.loadGalleryWindow(Math.max(0, globalIndex - Math.floor(images.length / 2)));
      }
      return;
    }

    this.updateThumbnailGridGeometry(viewport);
    const rowHeight = this.thumbnailRowHeight();
    const columns = this.thumbnailColumns();
    const targetIndex = Math.max(0, Math.floor(viewport.scrollTop / Math.max(1, rowHeight)) * columns);
    const threshold = Math.max(100, Math.floor(images.length * 0.2));
    if (targetIndex < windowStart + threshold || targetIndex > windowStart + images.length - threshold) {
      const desiredStart = Math.max(0, targetIndex - Math.floor(images.length / 2));
      const alignedStart = Math.floor(desiredStart / Math.max(1, columns)) * Math.max(1, columns);
      this.galleryState.loadGalleryWindow(alignedStart);
    }
  };

  protected readonly setViewMode = (mode: GalleryViewMode): void => {
    this.viewMode.set(mode);
    // A view-mode change does not change the folder query. Reuse the loaded
    // window, or return to its first window if the user had scrolled far away.
    this.galleryState.loadGalleryWindow(0);
    const viewport = this.scrollBox()?.nativeElement;
    if (viewport) viewport.scrollTop = 0;
    this.detailScrollTop.set(0);
    this.detailHeaderHeight.set(0);
    try { this.document.defaultView?.localStorage.setItem('galleryViewMode', mode); }
    catch { /* Keep the selected view for the current session. */ }
  };

  /* Outputs */
  readonly selected = output<FileInfo>();
  readonly activeSelectionChanged = output<string | null>();
  readonly folderRefreshRequested = output<string>();

  readonly sortByChanged = output<SortType>();

  readonly sortDirChanged = output<SortDirection>();

  readonly thumbSizeChanged = output<ThumbnailSize>();

  readonly hoveredImage = signal<FileInfo | null>(null);

  readonly hoveredTags = signal<ExifTags | null>(null);

  readonly hoverStatusText = computed(() => {
    const image = this.hoveredImage();
    if (!image) return '';
    const tags = this.hoveredTags();
    const width = this.formatPixelDimension(tags?.ImageWidth);
    const height = this.formatPixelDimension(tags?.ImageHeight);
    const dimensions = width !== 'undefined' && height !== 'undefined' && width !== '' && height !== '' ? `${width} × ${height}` : '';
    const date = image.modifiedAt ?? image.createdAt;
    const modified = Number.isFinite(date) ? this.formatOsDateTime(date) : '';
    const size = this.formatFileSize(image.size);
    const bits = tags?.BitsPerSample ?? tags?.BitDepth ?? tags?.ImagePixelDepth ?? null;
    const range = imageDynamicRange(image.path, tags, bits === null ? null : `${bits}-bit`);
    const latitude = tags?.GPSLatitude;
    const longitude = tags?.GPSLongitude;
    const gps = latitude !== undefined && longitude !== undefined
      ? `GPS: ${String(latitude)}${tags?.GPSLatitudeRef ? ` ${String(tags.GPSLatitudeRef)}` : ''}, ${String(longitude)}${tags?.GPSLongitudeRef ? ` ${String(tags.GPSLongitudeRef)}` : ''}`
      : '';
    const locationTags = tags as Record<string, unknown> | null;
    const locationParts = [
      locationTags?.['Sublocation'],
      locationTags?.['Sub-location'],
      locationTags?.['Location'],
      locationTags?.['City'],
      locationTags?.['State'],
      locationTags?.['Country']
    ]
      .filter(value => value !== undefined && value !== null && String(value).trim() !== '')
      .map(value => String(value).trim());
    const location = locationParts.length ? `Location: ${[...new Set(locationParts)].join(', ')}` : '';
    return [image.path, modified, size, dimensions, range, gps, location].filter(Boolean).join('  ·  ');
  });

  protected readonly formatOsDateTime = (value: number | Date): string => formatSystemDateTime(value);

  private readonly formatFileSize = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return `${value.toFixed(1)} ${units[unit]}`;
  };

  protected readonly imageDynamicRange = imageDynamicRange;

  protected readonly formatPixelDimension = (value: unknown): string => {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value).toString();
    const text = String(value ?? '').trim();
    // EXIF values may already contain locale-style grouping (for example "3,840").
    const normalized = /^\d{1,3}(?:,\d{3})+$/.test(text) ? text.replace(/,/g, '') : text;
    const numeric = Number(normalized);
    return Number.isFinite(numeric) ? Math.trunc(numeric).toString() : text;
  };


  private readonly exif = inject(ExifService);

  private readonly cacheManager = inject(CacheManager);
  private readonly galleryState = inject(GalleryState);
  readonly galleryWindowStart = this.galleryState.galleryWindowStart;
  readonly totalFileCount = this.galleryState.totalFileCount;
  readonly includeUnsupportedFiles = toSignal(this.galleryState.includeUnsupportedFiles(), { initialValue: false });
  readonly galleryLoading = toSignal(this.galleryState.galleryLoading(), { initialValue: false });
  readonly galleryRefreshing = toSignal(this.galleryState.galleryRefreshing(), { initialValue: false });
  readonly includeFilesRecursive = toSignal(this.galleryState.includeFilesRecursive(), { initialValue: false });

  protected readonly setIncludeUnsupportedFiles = (value: boolean): void => {
    this.galleryState.setIncludeUnsupportedFiles(value);
  };

  protected readonly setIncludeFilesRecursive = (value: boolean): void => {
    this.galleryState.setIncludeFilesRecursive(value);
  };
  private readonly processManager = inject(ProcessManager);

  readonly cacheStats = signal<CacheDirectoryStats>({ total: 0, thumbnails: 0, fullSizeConversions: 0, fullSizeConversionTotal: 0, gps: 0, hdr: 0, location: 0, thumbnailPaths: [], fullSizePaths: [] });

  readonly cacheCompleteness = signal<{ total: number; thumbnails: number } | null>(null);
  private cacheCompletenessScope = '';
  private cacheCompletenessRequest = 0;

  private readonly refreshCacheCompleteness = async (folder: string, recursive: boolean): Promise<void> => {
    const request = ++this.cacheCompletenessRequest;
    try {
      // This is a database-only aggregate; it does not stat or inspect physical
      // thumbnail/full-size cache files.
      const stats = await this.cacheManager.getGalleryCacheStats(
        folder, recursive, false, '', 'ImageGrid.refreshCacheCompleteness'
      );
      if (request !== this.cacheCompletenessRequest || folder !== this.selectedLocation()) return;
      this.cacheCompleteness.set(stats.total > 0
        ? { total: stats.total, thumbnails: stats.thumbnails }
        : null);
    } catch (error) {
      if (request === this.cacheCompletenessRequest) {
        this.cacheCompleteness.set(null);
        console.error('Failed to retrieve gallery cache completeness', folder, error);
      }
    }
  };

  readonly buildCurrentFolderCache = async (): Promise<void> => {
    const folder = this.selectedLocation()?.trim();
    if (!folder || this.cacheRunActive()) return;
    this.cacheCompleteness.set(null);
    this.cacheCompletenessScope = '';
    try {
      if (this.includeFilesRecursive()) {
        await this.galleryCacheBuild.startManualRecursiveCacheBuild(folder, true);
      } else {
        await this.galleryCacheBuild.startManualCacheBuild(folder, true);
      }
    } finally {
      this.cacheCompletenessScope = `${folder.toLocaleLowerCase()}|${this.includeFilesRecursive()}`;
      await this.refreshCacheCompleteness(folder, this.includeFilesRecursive());
    }
  };

  private cacheStatsRequest = 0;
  private cachePathUpdateRevision = 0;
  private cacheStatsFolder: string | null = null;
  private cacheStatsScope = '';
  private cacheStatsScanActive = false;
  private cacheStatsScanComplete = false;
  private lastCacheRevision: number | null = null;

  private readonly resetDirectoryCacheStats = (): void => {
    this.cacheStatsRequest++;
    this.cacheStatsScanActive = false;
    this.cacheStatsScanComplete = false;
  };

  readonly refreshDirectoryCacheStats = async (): Promise<void> => {
    const mode = this.viewMode();
    if (mode !== 'details' && mode !== 'details-no-thumbnails') {
      this.resetDirectoryCacheStats();
      return;
    }
    const folder = this.selectedLocation();
    const scope = [folder ?? '', this.includeUnsupportedFiles(), this.includeFilesRecursive(),
      this.nameFilterActive(), this.nameFilter()].join('|');
    if (this.cacheStatsFolder !== folder || this.cacheStatsScope !== scope) {
      this.resetDirectoryCacheStats();
    }
    this.cacheStatsFolder = folder;
    this.cacheStatsScope = scope;

    if (!folder || this.galleryLoading() || this.cacheStatsScanActive || this.cacheStatsScanComplete) return;
    const request = ++this.cacheStatsRequest;
    const pathUpdateRevision = this.cachePathUpdateRevision;
    this.cacheStatsScanActive = true;
    try {
      // Cache counters are secondary UI metadata. Let Electron finish showing
      // the initial window before running this synchronous SQLite aggregation
      // in the main process.
      await new Promise<void>(resolve => setTimeout(resolve, 20000));
      if (request !== this.cacheStatsRequest || pathUpdateRevision !== this.cachePathUpdateRevision) return;
      const stats = await this.cacheManager.getGalleryCacheStats(
        folder, this.includeFilesRecursive(), this.includeUnsupportedFiles(),
        this.nameFilterActive() ? this.nameFilter() : '', 'ImageGrid.refreshDirectoryCacheStats'
      );
      if (request !== this.cacheStatsRequest) return;
      if (pathUpdateRevision !== this.cachePathUpdateRevision) {
        this.resetDirectoryCacheStats();
        void this.refreshDirectoryCacheStats();
        return;
      }
      this.cacheStats.set(stats);
      this.cacheStatsScanComplete = true;
    } catch (error) {
      console.error('Failed to refresh gallery cache statistics', error);
    } finally {
      if (request === this.cacheStatsRequest) this.cacheStatsScanActive = false;
    }
  };

  readonly onCacheUpdated = (sourceName: string): void => {
    if (sourceName) {
      // Thumbnail completion events are not database mutations. The cache
      // manager's revision signal below is the authoritative invalidation
      // trigger for actual cache writes.
      return;
    }
    this.cachePathUpdateRevision++;
    this.resetDirectoryCacheStats();
    void this.refreshDirectoryCacheStats();
  };



  private readonly destroyRef = inject(DestroyRef);

  protected readonly thumbSizeSlider = new FormControl(0, { nonNullable: true });
  readonly detailFontSize = signal(this.readStoredDetailFontSize());
  readonly nameFilter = signal('');
  readonly nameFilterActive = signal(false);
  protected readonly detailFontSizeSlider = new FormControl(this.detailFontSize(), { nonNullable: true });
  protected readonly detailFontSizeMin = 10;
  protected readonly detailFontSizeMax = 24;

  protected readonly thumbnailSliderMax = allThumbnailSizes.length - 1;

  readonly thumbnailZoomFactor = computed(() => {
    const width = thumbnailDimensions[this.thumbSize()].width;
    const factor = this.viewMode() === 'details' || this.viewMode() === 'details-no-thumbnails'
      ? (24 + ((width - 96) / (512 - 96)) * 296) / (24 + ((192 - 96) / (512 - 96)) * 296)
      : width / thumbnailDimensions.small.width;
    return `${factor.toFixed(1)}×`;
  });

  private readonly thumbnailSliderSizes: ThumbnailSize[] = [...allThumbnailSizes];

  private hoverClearTimer: ReturnType<typeof setTimeout> | null = null;

  /* State */
  private readonly scrollBox = viewChild<ElementRef<HTMLDivElement>>('scrollBox');

  private readonly imagesComponent = viewChild(ImagesComponent);
  readonly filteredRowColor = computed(() => this.imagesComponent()?.detailPreferenceValues().filteredRow ?? '#e8f1fb');

  private readonly galleryCacheBuild = inject(GalleryCacheBuild);

  readonly cacheRunActive = computed(() => this.galleryCacheBuild.cacheRunActive() || (this.imagesComponent()?.cacheRunActive() ?? false));
  readonly cacheRunProgress = computed(() => this.imagesComponent()?.cacheRunActive() ? this.imagesComponent()!.cacheRunProgress() : this.galleryCacheBuild.cacheRunProgress());
  readonly cacheRunCurrentOperation = computed(() => this.imagesComponent()?.cacheRunActive() ? this.imagesComponent()!.cacheRunCurrentOperation() : this.galleryCacheBuild.cacheRunCurrentOperation());
  readonly cacheRunDirectory = computed(() => this.galleryCacheBuild.cacheRunDirectory());

  readonly refreshGallery = (): void => {
    this.imagesComponent()?.refreshGallery();
  };

  protected readonly openDetailPreferences = (): void => {
    this.imagesComponent()?.openDetailPreferences();
  };

  readonly openSelectedFolderPath = async (): Promise<void> => {
    const folder = this.selectedLocation()?.trim();
    if (!folder) return;
    const error = await this.processManager.openPath(folder);
    if (error) this.document.defaultView?.alert(error);
  };

  readonly copySelectedFolderPath = async (): Promise<void> => {
    const folder = this.selectedLocation()?.trim();
    if (!folder) return;
    try {
      await navigator.clipboard.writeText(folder);
    } catch (error) {
      console.error('Could not copy selected folder path:', error);
    }
  };

  readonly cacheAllImages = async (directory: string, importGpx: boolean): Promise<void> => {
    const images = this.imagesComponent();
    if (images) await images.cacheAllImages(directory, importGpx);
  };

  readonly cacheAllImagesRecursive = (directory: string, importGpx: boolean): void => {
    void this.imagesComponent()?.cacheAllImagesRecursive(directory, importGpx);
  };

  readonly refreshDetailCacheStatus = (): void => {
    if (this.viewMode() === 'details') this.imagesComponent()?.refreshGallery();
    void this.refreshDirectoryCacheStats();
  };

  readonly onThumbnailHovered = async (image: FileInfo | null) => {
    if (image === null) {
      if (this.hoverClearTimer !== null) {
        clearTimeout(this.hoverClearTimer);
      }

      this.hoverClearTimer = setTimeout(() => {
        this.hoverClearTimer = null;
        this.hoveredImage.set(null);
        this.hoveredTags.set(null);
      }, 120);
      return;
    }

    if (this.hoverClearTimer !== null) {
      clearTimeout(this.hoverClearTimer);
      this.hoverClearTimer = null;
    }

    if (this.hoveredImage()?.path === image.path) {
      return;
    }

    this.hoveredImage.set(image);
    this.hoveredTags.set(null);

    const currentPath = image.path;
    const result = await this.exif.read(currentPath);

    if (this.hoveredImage()?.path === currentPath && result.success) {
      this.hoveredTags.set(result.data);
    }
  };

  protected readonly adjustThumbnailSize = (direction: -1 | 1) => {
    const next = Math.max(0, Math.min(this.thumbnailSliderMax, this.thumbSizeSlider.value + direction));
    this.thumbSizeSlider.setValue(next);
  };

  protected readonly adjustDetailFontSize = (direction: -1 | 1): void => {
    const next = Math.max(this.detailFontSizeMin, Math.min(this.detailFontSizeMax, this.detailFontSizeSlider.value + direction));
    this.detailFontSizeSlider.setValue(next);
  };

  protected readonly setDetailFontSize = (value: number): void => {
    const next = Math.max(this.detailFontSizeMin, Math.min(this.detailFontSizeMax, Math.round(value)));
    this.detailFontSizeSlider.setValue(next);
  };

  protected readonly updateNameFilter = (value: string): void => {
    this.nameFilter.set(value);
    this.nameFilterActive.set(value.trim().length > 0);
    this.galleryState.setNameFilter(value);
    const viewport = this.scrollBox()?.nativeElement;
    if (viewport) viewport.scrollTop = 0;
  };

  protected readonly setNameFilterEnabled = (active: boolean): void => {
    this.nameFilterActive.set(active);
    this.galleryState.setNameFilterActive(active);
    const viewport = this.scrollBox()?.nativeElement;
    if (viewport) viewport.scrollTop = 0;
  };

  /* Constructor */
  constructor() {
    effect(onCleanup => {
      this.images();
      this.thumbSize();
      const mode = this.viewMode();
      const viewport = this.scrollBox()?.nativeElement;
      if (!viewport || mode === 'details' || mode === 'details-no-thumbnails') return;

      const updateGeometry = (): void => {
        this.detailScrollTop.set(viewport.scrollTop);
        this.detailViewportHeight.set(viewport.clientHeight);
        this.updateThumbnailGridGeometry(viewport);
      };
      updateGeometry();

      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(updateGeometry);
      observer.observe(viewport);
      const firstTile = viewport.querySelector<HTMLElement>('.images > app-thumbnail');
      if (firstTile) observer.observe(firstTile);
      onCleanup(() => observer.disconnect());
    });

    const normalizeDirectory = (value: string): string =>
      value.replace(/[\\/]+/g, '\\\\').replace(/\\+$/, '').toLocaleLowerCase();
    const unsubscribeDirectoryLocations = this.cacheManager.onDirectoryPhotoLocationsChanged(changedDirectory => {
      const currentDirectory = this.selectedLocation();
      if (!currentDirectory || normalizeDirectory(changedDirectory) !== normalizeDirectory(currentDirectory)) return;
      // Reverse geocoding can add location names while thumbnails are being
      // brought into view. Refresh the aggregate header counters immediately.
      void this.refreshDirectoryCacheStats();
    });
    this.destroyRef.onDestroy(unsubscribeDirectoryLocations);

    effect(onCleanup => {
      const images = this.imagesComponent();
      if (!images) return;

      const unregister = this.galleryCacheBuild.register({
        cacheRunActive: images.cacheRunActive,
        cacheRunProgress: images.cacheRunProgress,
        cacheRunCurrentOperation: images.cacheRunCurrentOperation,
        start: async (directory, importGpx, verifyCacheFiles) => {
          await images.cacheAllImages(directory, importGpx, verifyCacheFiles);
          // scanGalleryDirectory emits the gallery-files-changed notification
          // after indexing. GalleryState coalesces it into one page refresh;
          // do not start a second full navigation here.
        },
        startRecursive: async (directory, importGpx, verifyCacheFiles) => {
          await images.cacheAllImagesRecursive(directory, importGpx, verifyCacheFiles);
          // Recursive indexing suppresses per-folder notifications and emits
          // one final notification when the complete scan finishes. GalleryState
          // performs the single required refresh from that notification.
        },
        cancel: () => images.cancelCacheRun(),
        refreshDetailCacheStatus: () => {
          if (this.viewMode() === 'details') images.refreshGallery();
          void this.refreshDirectoryCacheStats();
        }
      });

      onCleanup(unregister);
    });

    effect(() => {
      const revision = this.cacheManager.cacheRevision();
      if (this.lastCacheRevision !== null && revision !== this.lastCacheRevision) {
        this.resetDirectoryCacheStats();
      }
      this.lastCacheRevision = revision;
      this.images();
      this.selectedLocation();
      this.viewMode();
      this.totalFileCount();
      this.galleryLoading();
      void this.refreshDirectoryCacheStats();
    });

    fromEvent<KeyboardEvent>(this.document, 'keyup')
      .pipe(takeUntilDestroyed())
      .subscribe(event => {
        if (event.ctrlKey || event.altKey || event.metaKey) return;
        const target = event.target;
        if (target instanceof HTMLElement && target.matches('input, textarea, select, [contenteditable="true"]')) return;
        if (event.key === '+' || event.key === '=' || event.key === 'Add') {
          event.preventDefault();
          this.adjustThumbnailSize(1);
        } else if (event.key === '-' || event.key === '_' || event.key === 'Subtract') {
          event.preventDefault();
          this.adjustThumbnailSize(-1);
        }
      });

    this.detailFontSizeSlider.valueChanges
      .pipe(
        map(value => Math.max(this.detailFontSizeMin, Math.min(this.detailFontSizeMax, Math.round(value)))),
        distinctUntilChanged(),
        takeUntilDestroyed()
      )
      .subscribe(value => {
        if (this.detailFontSizeSlider.value !== value) {
          this.detailFontSizeSlider.setValue(value, { emitEvent: false });
        }
        this.detailFontSize.set(value);
        try {
          this.document.defaultView?.localStorage.setItem('galleryDetailFontSize', String(value));
        } catch {
          /* Keep the selected font size for the current session if storage is unavailable. */
        }
      });

    this.thumbSizeSlider.valueChanges
      .pipe(
        map(value => Math.max(0, Math.min(this.thumbnailSliderMax, Math.round(value)))),
        distinctUntilChanged(),
        takeUntilDestroyed()
      )
      .subscribe(index => {
        if (this.thumbSizeSlider.value !== index) {
          this.thumbSizeSlider.setValue(index, { emitEvent: false });
        }

        this.thumbSizeChanged.emit(this.thumbnailSliderSizes[index]);
      });

    effect(() => {
      const index = this.thumbnailSliderSizes.indexOf(this.thumbSize());
      if (index >= 0 && this.thumbSizeSlider.value !== index) {
        this.thumbSizeSlider.setValue(index, { emitEvent: false });
      }
    });

    this.destroyRef.onDestroy(() => {
      if (this.hoverClearTimer !== null) {
        clearTimeout(this.hoverClearTimer);
      }
    });

    effect(() => {
      const folder = this.selectedLocation();
      const recursive = this.includeFilesRecursive();
      const scope = folder ? `${folder.toLocaleLowerCase()}|${recursive}` : '';
      if (this.cacheCompletenessScope !== scope) {
        this.cacheCompletenessScope = scope;
        this.cacheCompleteness.set(null);
      }
      const scrollBox = this.scrollBox();

      if (scrollBox === undefined) {
        return;
      }

      scrollBox.nativeElement.scrollTo(0, 0);
    });
  }
}
