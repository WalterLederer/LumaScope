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

  readonly verifyCacheFiles = input(false);

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

  readonly viewMode = signal<GalleryViewMode>(this.readStoredViewMode());
  readonly detailScrollTop = signal(0);
  readonly detailViewportHeight = signal(1200);
  readonly detailHeaderHeight = signal(0);

  protected readonly onGalleryScroll = (event: Event): void => {
    const viewport = event.currentTarget as HTMLElement;
    const header = viewport.querySelector<HTMLElement>('.detail-native-table thead');
    this.detailScrollTop.set(viewport.scrollTop);
    this.detailViewportHeight.set(viewport.clientHeight);
    this.detailHeaderHeight.set(header?.getBoundingClientRect().height ?? 0);
    if ((this.viewMode() === 'details' || this.viewMode() === 'details-no-thumbnails')
      && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < viewport.clientHeight * 1.5) {
      this.galleryState.loadNextGalleryPage();
    }
  };

  protected readonly setViewMode = (mode: GalleryViewMode): void => {
    this.viewMode.set(mode);
    const viewport = this.scrollBox()?.nativeElement;
    if (viewport) viewport.scrollTop = 0;
    this.detailScrollTop.set(0);
    this.detailHeaderHeight.set(0);
    try { this.document.defaultView?.localStorage.setItem('galleryViewMode', mode); }
    catch { /* Keep the selected view for the current session. */ }
  };

  /* Outputs */
  readonly selected = output<FileInfo>();
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
  readonly includeUnsupportedFiles = toSignal(this.galleryState.includeUnsupportedFiles(), { initialValue: false });
  readonly includeFilesRecursive = toSignal(this.galleryState.includeFilesRecursive(), { initialValue: false });

  protected readonly setIncludeUnsupportedFiles = (value: boolean): void => {
    this.galleryState.setIncludeUnsupportedFiles(value);
  };

  protected readonly setIncludeFilesRecursive = (value: boolean): void => {
    this.galleryState.setIncludeFilesRecursive(value);
  };
  private readonly processManager = inject(ProcessManager);

  readonly cacheStats = signal<CacheDirectoryStats>({ total: 0, thumbnails: 0, fullSizeConversions: 0, gps: 0, hdr: 0, location: 0, thumbnailPaths: [], fullSizePaths: [] });

  private cacheStatsRequest = 0;
  private cachePathUpdateRevision = 0;
  private readonly thumbnailCachePaths = new Set<string>();
  private readonly fullSizeCachePaths = new Set<string>();

  readonly refreshDirectoryCacheStats = async (): Promise<void> => {
    const images = this.images() ?? [];
    const request = ++this.cacheStatsRequest;
    const pathUpdateRevision = this.cachePathUpdateRevision;
    if (images.length === 0) {
      this.thumbnailCachePaths.clear();
      this.fullSizeCachePaths.clear();
      this.cacheStats.set({ total: 0, thumbnails: 0, fullSizeConversions: 0, gps: 0, hdr: 0, location: 0, thumbnailPaths: [], fullSizePaths: [] });
      return;
    }
    try {
      // The database statistics endpoint is scoped to one parent folder and
      // accepts bounded batches. Group recursive results by parent and query
      // in chunks so large folders never exceed the IPC/SQLite request limit.
      this.thumbnailCachePaths.clear();
      this.fullSizeCachePaths.clear();
      const filesByParent = new Map<string, string[]>();
      for (const image of images) {
        const parent = image.parent;
        const paths = filesByParent.get(parent) ?? [];
        paths.push(image.path);
        filesByParent.set(parent, paths);
      }
      let gps = 0;
      let hdr = 0;
      let location = 0;
      for (const paths of filesByParent.values()) {
        for (let offset = 0; offset < paths.length; offset += 500) {
          const stats = await this.cacheManager.getDirectoryCacheStats(paths.slice(offset, offset + 500), this.verifyCacheFiles());
          if (request !== this.cacheStatsRequest) return;
          if (pathUpdateRevision !== this.cachePathUpdateRevision) {
            void this.refreshDirectoryCacheStats();
            return;
          }
          gps += stats.gps;
          hdr += stats.hdr;
          location += stats.location;
          stats.thumbnailPaths.forEach(path => this.thumbnailCachePaths.add(path));
          stats.fullSizePaths.forEach(path => this.fullSizeCachePaths.add(path));
        }
      }
      if (request !== this.cacheStatsRequest) return;
      if (pathUpdateRevision !== this.cachePathUpdateRevision) {
        void this.refreshDirectoryCacheStats();
        return;
      }
      this.cacheStats.set({
        total: images.length,
        thumbnails: this.thumbnailCachePaths.size,
        fullSizeConversions: this.fullSizeCachePaths.size,
        gps,
        hdr,
        location,
        thumbnailPaths: [],
        fullSizePaths: []
      });
    } catch (error) {
      console.error('Failed to refresh gallery cache statistics', error);
    }
  };

  readonly onCacheUpdated = (sourceName: string): void => {
    if (!sourceName) {
      void this.refreshDirectoryCacheStats();
      return;
    }
    if (!(this.images() ?? []).some(image => image.path === sourceName)) return;
    // Re-read the complete visible folder just like the thumbnail counter:
    // this keeps HDR, GPS and location totals in sync as metadata is written.
    this.cachePathUpdateRevision++;
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

  private readonly galleryCacheBuild = inject(GalleryCacheBuild);

  readonly cacheRunActive = computed(() => this.imagesComponent()?.cacheRunActive() ?? false);
  readonly cacheRunProgress = computed(() => this.imagesComponent()?.cacheRunProgress() ?? { completed: 0, total: 0 });
  readonly cacheRunCurrentOperation = computed(() => this.imagesComponent()?.cacheRunCurrentOperation() ?? '');

  readonly cancelCacheRun = (): void => {
    this.imagesComponent()?.cancelCacheRun();
  };

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
  };

  /* Constructor */
  constructor() {
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
        start: (directory, importGpx) => images.cacheAllImages(directory, importGpx),
        startRecursive: (directory, importGpx) => images.cacheAllImagesRecursive(directory, importGpx),
        cancel: () => images.cancelCacheRun(),
        refreshDetailCacheStatus: () => {
          if (this.viewMode() === 'details') images.refreshGallery();
          void this.refreshDirectoryCacheStats();
        }
      });

      onCleanup(unregister);
    });

    effect(() => {
      this.images();
      this.selectedLocation();
      this.cacheManager.cacheRevision();
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
      this.selectedLocation();
      const scrollBox = this.scrollBox();

      if (scrollBox === undefined) {
        return;
      }

      scrollBox.nativeElement.scrollTo(0, 0);
    });
  }
}
