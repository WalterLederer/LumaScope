import { CdkMenu, CdkMenuItem, CdkMenuTrigger } from '@angular/cdk/menu';
import { DatePipe, DecimalPipe, DOCUMENT } from '@angular/common';
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
import { imageDynamicRange } from '../../../viewer/utils/image-dynamic-range';
import { GalleryViewMode } from '../images/images.component.types';

@Component({
  selector: 'app-image-grid',
  imports: [
    ImagesComponent,
    DatePipe,
    DecimalPipe,
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

  private readonly document = inject(DOCUMENT);

  private readonly readStoredViewMode = (): GalleryViewMode => {
    try {
      const stored = this.document.defaultView?.localStorage.getItem('light-matter.galleryViewMode');
      return stored === 'tiles' || stored === 'details' ? stored : 'thumbnails';
    } catch { return 'thumbnails'; }
  };

  readonly viewMode = signal<GalleryViewMode>(this.readStoredViewMode());

  protected readonly setViewMode = (mode: GalleryViewMode): void => {
    this.viewMode.set(mode);
    try { this.document.defaultView?.localStorage.setItem('light-matter.galleryViewMode', mode); }
    catch { /* Keep the selected view for the current session. */ }
  };

  /* Outputs */
  readonly selected = output<FileInfo>();

  readonly sortByChanged = output<SortType>();

  readonly sortDirChanged = output<SortDirection>();

  readonly thumbSizeChanged = output<ThumbnailSize>();

  readonly hoveredImage = signal<FileInfo | null>(null);

  readonly hoveredTags = signal<ExifTags | null>(null);

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

  readonly cacheStats = signal<CacheDirectoryStats>({ total: 0, thumbnails: 0, fullSizeConversions: 0, thumbnailPaths: [], fullSizePaths: [] });

  private cacheStatsRequest = 0;
  private readonly thumbnailCachePaths = new Set<string>();
  private readonly fullSizeCachePaths = new Set<string>();

  readonly refreshDirectoryCacheStats = async (): Promise<void> => {
    const images = this.images() ?? [];
    const request = ++this.cacheStatsRequest;
    if (images.length === 0) {
      this.thumbnailCachePaths.clear();
      this.fullSizeCachePaths.clear();
      this.cacheStats.set({ total: 0, thumbnails: 0, fullSizeConversions: 0, thumbnailPaths: [], fullSizePaths: [] });
      return;
    }
    try {
      const stats = await this.cacheManager.getDirectoryCacheStats(images.map(image => image.path));
      if (request !== this.cacheStatsRequest) return;
      this.thumbnailCachePaths.clear();
      this.fullSizeCachePaths.clear();
      stats.thumbnailPaths.forEach(path => this.thumbnailCachePaths.add(path));
      stats.fullSizePaths.forEach(path => this.fullSizeCachePaths.add(path));
      this.cacheStats.set({
        total: stats.total,
        thumbnails: this.thumbnailCachePaths.size,
        fullSizeConversions: this.fullSizeCachePaths.size,
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
    void this.cacheManager.getDirectoryCacheStats([sourceName]).then(stats => {
      if (!(this.images() ?? []).some(image => image.path === sourceName)) return;
      stats.thumbnailPaths.includes(sourceName)
        ? this.thumbnailCachePaths.add(sourceName)
        : this.thumbnailCachePaths.delete(sourceName);
      stats.fullSizePaths.includes(sourceName)
        ? this.fullSizeCachePaths.add(sourceName)
        : this.fullSizeCachePaths.delete(sourceName);
      this.cacheStats.update(current => ({
        total: current.total,
        thumbnails: this.thumbnailCachePaths.size,
        fullSizeConversions: this.fullSizeCachePaths.size,
        thumbnailPaths: [],
        fullSizePaths: []
      }));
    }).catch(error => console.error('Failed to update gallery cache count', error));
  };



  private readonly destroyRef = inject(DestroyRef);

  protected readonly thumbSizeSlider = new FormControl(0, { nonNullable: true });

  protected readonly thumbnailSliderMax = allThumbnailSizes.length - 1;

  readonly thumbnailZoomFactor = computed(() => {
    const width = thumbnailDimensions[this.thumbSize()].width;
    const factor = this.viewMode() === 'details'
      ? (24 + ((width - 96) / (512 - 96)) * 296) / (24 + ((192 - 96) / (512 - 96)) * 296)
      : width / thumbnailDimensions.small.width;
    return `${factor.toFixed(1)}×`;
  });

  private readonly thumbnailSliderSizes: ThumbnailSize[] = [...allThumbnailSizes];

  private hoverClearTimer: ReturnType<typeof setTimeout> | null = null;

  /* State */
  private readonly scrollBox = viewChild<ElementRef<HTMLDivElement>>('scrollBox');

  private readonly imagesComponent = viewChild(ImagesComponent);

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
