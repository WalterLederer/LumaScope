import { CdkMenu, CdkMenuItem, CdkMenuTrigger } from '@angular/cdk/menu';
import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
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
  ToolbarComponent
} from '@light-matter/ui';
import { CacheDirectoryStats, ExifTags } from 'internal-api';
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
import { GalleryCacheBuild } from '../../services/gallery-cache-build/gallery-cache-build';
import { imageDynamicRange } from '../../../viewer/utils/image-dynamic-range';
import { GalleryViewMode } from '../images/images.component.types';

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
  ],
  templateUrl: './image-grid.component.html',
  styleUrl: './image-grid.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ImageGridComponent {
  /* Inputs */
  readonly images = input.required<FileInfo[] | null>();

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

  readonly viewMode = signal<GalleryViewMode>(this.readStoredViewMode());

  protected readonly setViewMode = (mode: GalleryViewMode): void => {
    this.viewMode.set(mode);
    try { this.document.defaultView?.localStorage.setItem('galleryViewMode', mode); }
    catch { /* Keep the selected view for the current session. */ }
  };

  /* Outputs */
  readonly selected = output<FileInfo>();

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

  protected readonly formatOsDateTime = (value: number | Date): string => {
    const date = value instanceof Date ? value : new Date(value);
    const datePart = new Intl.DateTimeFormat('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
    const timePart = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(date);
    return `${datePart} ${timePart}`;
  };

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
      const stats = await this.cacheManager.getDirectoryCacheStats(images.map(image => image.path), this.verifyCacheFiles());
      if (request !== this.cacheStatsRequest) return;
      if (pathUpdateRevision !== this.cachePathUpdateRevision) {
        void this.refreshDirectoryCacheStats();
        return;
      }
      this.thumbnailCachePaths.clear();
      this.fullSizeCachePaths.clear();
      stats.thumbnailPaths.forEach(path => this.thumbnailCachePaths.add(path));
      stats.fullSizePaths.forEach(path => this.fullSizeCachePaths.add(path));
      this.cacheStats.set({
        total: stats.total,
        thumbnails: this.thumbnailCachePaths.size,
        fullSizeConversions: this.fullSizeCachePaths.size,
        gps: stats.gps,
        hdr: stats.hdr,
        location: stats.location,
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

  readonly cacheAllImages = (directory: string): void => {
    void this.imagesComponent()?.cacheAllImages(directory);
  };

  readonly cacheAllImagesRecursive = (directory: string): void => {
    void this.imagesComponent()?.cacheAllImagesRecursive(directory);
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

  /* Constructor */
  constructor() {
    effect(onCleanup => {
      const images = this.imagesComponent();
      if (!images) return;
      const unregister = this.galleryCacheBuild.register({
        cacheRunActive: images.cacheRunActive,
        cacheRunProgress: images.cacheRunProgress,
        cacheRunCurrentOperation: images.cacheRunCurrentOperation,
        // Capture the actual ImagesComponent instance. The ImageGrid can be
        // destroyed during navigation while its asynchronous cache run continues.
        // These direct references keep progress and cancellation connected to that run.
        start: directory => { void images.cacheAllImages(directory); },
        startRecursive: directory => { void images.cacheAllImagesRecursive(directory); },
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

    console.warn('[ImageGrid] CONSTRUCTOR START');
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
