import { CdkMenu, CdkMenuItem, CdkMenuTrigger } from '@angular/cdk/menu';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  Injector,
  HostListener,
  output,
  signal
} from '@angular/core';
import { TextComponent, TitleComponent, ButtonTooltipDirective} from '@light-matter/ui';
import { toSignal } from '@angular/core/rxjs-interop';
import { BackgroundReverseGeocodingStatus, CacheDirectoryStats, CacheImageStatus, ExifTags, supportedFileExtensions, formatOsDateTime } from 'internal-api';
import { FileSystem } from '../../../ipc/file-system';
import { CacheManager } from '../../../ipc/cache-manager';
import { ExifService } from '../../../ipc/exif';
import { GalleryCacheBuild } from '../../services/gallery-cache-build/gallery-cache-build';
import { Configuration } from '../../../system/services/configuration/configuration';
import { imageDynamicRange } from '../../../viewer/utils/image-dynamic-range';
import {
  allSortTypes,
  defaultThumbnailSize,
  FileInfo,
  SortType,
  thumbnailDimensions,
  ThumbnailSize
} from 'internal-api';
import { ThumbnailComponent } from '../../../ui/components/thumbnail/thumbnail.component';
import { TimelineIndicatorsComponent } from '../timeline-indicators/timeline-indicators.component';
import { imageUrl, thumbUrl } from '../../../viewer/utils/image-url';
import { GalleryViewMode, groupImagesByYearAndMonth, YearGroup } from './images.component.types';

type DetailSortColumn = 'name' | 'date' | 'gpsDate' | 'dimensions' | 'size' | 'suffix' | 'hdr' | 'thumb' | 'fullSize' | 'gps' | 'location' | 'path';

type DetailTableColorKey = 'date' | 'gpsDate' | 'dimensions' | 'size' | 'selectedRow' | 'oddRow' | 'evenRow' | 'filteredRow';
interface DetailTablePreferences {
  date: string;
  gpsDate: string;
  dimensions: string;
  size: string;
  selectedRow: string;
  oddRow: string;
  evenRow: string;
  filteredRow: string;
  alternateRows: boolean;
  dateProgressEnabled: boolean;
  gpsDateProgressEnabled: boolean;
  dimensionsProgressEnabled: boolean;
  sizeProgressEnabled: boolean;
  progressTransparency: number;
}
const defaultDetailTablePreferences: DetailTablePreferences = {
  date: '#d18b24',
  gpsDate: '#287fc4',
  dimensions: '#16a085',
  size: '#8e63ce',
  selectedRow: '#d18b24',
  oddRow: '#ffffff',
  evenRow: '#f5f5f5',
  filteredRow: '#e8f1fb',
  alternateRows: true,
  dateProgressEnabled: true,
  gpsDateProgressEnabled: true,
  dimensionsProgressEnabled: true,
  sizeProgressEnabled: true,
  progressTransparency: 78
};

@Component({
  selector: 'app-images',
  imports: [
    ThumbnailComponent,
    TitleComponent,
    CdkMenu,
    CdkMenuItem,
    CdkMenuTrigger,
    TimelineIndicatorsComponent,
    TextComponent ,
    ButtonTooltipDirective
  ],
  templateUrl: './images.component.html',
  styleUrl: './images.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'tabindex': '0',
    '[style.--thumb-width.px]': 'dimensions().width',
    '[style.--thumb-height.px]': 'dimensions().height',
    '[style.--detail-thumb-width.px]': 'detailThumbnailWidth()',
    '[style.--detail-thumb-height.px]': 'detailThumbnailHeight()',
    '[style.--detail-row-height.px]': 'detailVirtualRowHeight()',
    '[style.--detail-date-progress-color]': 'detailPreferenceValues().date',
    '[style.--detail-gps-date-progress-color]': 'detailPreferenceValues().gpsDate',
    '[style.--detail-dimensions-progress-color]': 'detailPreferenceValues().dimensions',
    '[style.--detail-size-progress-color]': 'detailPreferenceValues().size',
    '[style.--detail-selected-row-color]': 'detailPreferenceValues().selectedRow',
    '[style.--detail-odd-row-color]': 'detailPreferenceValues().oddRow',
    '[style.--detail-even-row-color]': 'detailPreferenceValues().evenRow',
    '[style.--detail-filtered-row-color]': 'detailPreferenceValues().filteredRow',
    '[class.detail-filter-active]': 'nameFilterActive()',
    '[style.--detail-progress-opacity]': '(100 - detailPreferenceValues().progressTransparency) + "%"',
    '[class.detail-alternate-rows]': 'detailPreferenceValues().alternateRows',
    '[class.detail-progress-date-disabled]': '!detailPreferenceValues().dateProgressEnabled',
    '[class.detail-progress-gps-date-disabled]': '!detailPreferenceValues().gpsDateProgressEnabled',
    '[class.detail-progress-dimensions-disabled]': '!detailPreferenceValues().dimensionsProgressEnabled',
    '[class.detail-progress-size-disabled]': '!detailPreferenceValues().sizeProgressEnabled'
  }
})
export class ImagesComponent {
  private readonly elementRef = inject(ElementRef);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly fileSystem = inject(FileSystem);
  private readonly cacheManager = inject(CacheManager);
  private readonly exif = inject(ExifService);
  private readonly galleryCacheBuild = inject(GalleryCacheBuild);
  private readonly configuration = inject(Configuration);
  readonly appConfig = toSignal(this.configuration.config(), { initialValue: null });
  readonly detailPreferenceDraft = signal<DetailTablePreferences>({ ...defaultDetailTablePreferences });
  readonly detailPreferencesOpen = signal(false);
  readonly detailPreferenceFavorites = signal<Array<{ name: string; settings: DetailTablePreferences }>>([]);
  private readonly defaultDetailPreferenceFavorite = {
    name: 'Default',
    settings: { ...defaultDetailTablePreferences }
  };
  readonly detailPreferenceFavoriteName = signal('');
  readonly detailPreferenceFavoriteSelection = signal('');
  readonly detailPreferenceValues = computed<DetailTablePreferences>(() => {
    const preferences = this.appConfig()?.preferences;
    return {
      date: preferences?.galleryDetailDateProgressColor ?? defaultDetailTablePreferences.date,
      gpsDate: preferences?.galleryDetailGpsDateProgressColor ?? defaultDetailTablePreferences.gpsDate,
      dimensions: preferences?.galleryDetailDimensionsProgressColor ?? defaultDetailTablePreferences.dimensions,
      size: preferences?.galleryDetailSizeProgressColor ?? defaultDetailTablePreferences.size,
      selectedRow: preferences?.galleryDetailSelectedRowColor ?? defaultDetailTablePreferences.selectedRow,
      oddRow: preferences?.galleryDetailOddRowColor ?? defaultDetailTablePreferences.oddRow,
      evenRow: preferences?.galleryDetailEvenRowColor ?? defaultDetailTablePreferences.evenRow,
      filteredRow: preferences?.galleryDetailFilteredRowColor ?? defaultDetailTablePreferences.filteredRow,
      alternateRows: preferences?.galleryDetailAlternateRowColors ?? defaultDetailTablePreferences.alternateRows,
      dateProgressEnabled: preferences?.galleryDetailDateProgressEnabled ?? defaultDetailTablePreferences.dateProgressEnabled,
      gpsDateProgressEnabled: preferences?.galleryDetailGpsDateProgressEnabled ?? defaultDetailTablePreferences.gpsDateProgressEnabled,
      dimensionsProgressEnabled: preferences?.galleryDetailDimensionsProgressEnabled ?? defaultDetailTablePreferences.dimensionsProgressEnabled,
      sizeProgressEnabled: preferences?.galleryDetailSizeProgressEnabled ?? defaultDetailTablePreferences.sizeProgressEnabled,
      progressTransparency: preferences?.galleryDetailProgressTransparency ?? defaultDetailTablePreferences.progressTransparency
    };
  });

  private cacheStatusRequest = 0;
  private cacheAbortController: AbortController | null = null;
  private readonly cacheStatusPathRequests = new Map<string, number>();
  readonly cacheStatuses = signal<Map<string, CacheImageStatus>>(new Map());
  readonly cacheStatusLoading = signal(false);
  readonly cacheRunActive = signal(false);
  readonly cacheRunProgress = signal({ completed: 0, total: 0 });
  readonly cacheRunCurrentOperation = signal('');
  readonly cacheFolderActionActive = computed(() => this.cacheRunActive() || this.galleryCacheBuild.cacheRunActive());
  readonly cacheFolderActionProgress = computed(() =>
    this.cacheRunActive() ? this.cacheRunProgress() : this.galleryCacheBuild.cacheRunProgress()
  );
  readonly stopCacheFolderAction = (): void => this.galleryCacheBuild.cancelCacheBuild();
  readonly verifyCacheFiles = input(false);
  private readonly cacheWorkerOperations = new Map<number, string>();
  private readonly setCacheWorkerOperation = (workerId: number, operation: string | null): void => {
    if (operation) this.cacheWorkerOperations.set(workerId, operation);
    else this.cacheWorkerOperations.delete(workerId);
    const currentOperations = [...this.cacheWorkerOperations.values()];
    const previousOutput = this.cacheRunCurrentOperation();
    const retainedErrors = previousOutput.split('\\n').filter(line => line.includes('] ERROR:'));
    this.cacheRunCurrentOperation.set([...currentOperations, ...retainedErrors].join('\\n'));
  };
  private readonly manualRefresh = signal(0);
  readonly thumbnailRefreshToken = computed(() => this.cacheManager.cacheRevision() + this.manualRefresh());
  readonly folderRefreshRequested = output<string>();
  readonly refreshGallery = async (): Promise<void> => {
    const folder = this.folderPath();
    this.manualRefresh.update(value => value + 1);
    if (folder) this.folderRefreshRequested.emit(folder);
    this.cacheUpdated.emit('');
  };
  private observer: IntersectionObserver | null = null;
  private readonly metadata = signal<Map<string, ExifTags>>(new Map());
  readonly locationDisplayNames = signal<Map<string, string>>(new Map());
  readonly reverseGeocodingStatus = signal<BackgroundReverseGeocodingStatus>({
    total: 0, resolved: 0, pending: 0, inProgress: 0, errors: 0,
    status: 'idle', paused: false, currentFilePath: null, currentDisplayName: null
  });

  /* Inputs */
  readonly images = input.required<FileInfo[] | null>();
  readonly nameFilter = input('');
  readonly nameFilterActive = input(false);
  readonly nameFilterChanged = output<string>();
  readonly nameFilterActiveChanged = output<boolean>();
  readonly detailFontSize = input(12);
  readonly detailFontSizeChanged = output<number>();
  readonly selectedImagePath = input<string | null>(null);
  readonly activeSelectionPath = signal<string | null>(null);
  readonly cacheStats = input<CacheDirectoryStats>({ total: 0, thumbnails: 0, fullSizeConversions: 0, gps: 0, hdr: 0, location: 0, thumbnailPaths: [], fullSizePaths: [] });
  readonly folderPath = input<string | null>(null);
  readonly includeUnsupportedFiles = input(false);
  readonly includeFilesRecursive = input(false);
  readonly sortBy = input<SortType>(allSortTypes[0]);
  readonly thumbSize = input<ThumbnailSize>(defaultThumbnailSize);
  readonly viewMode = input<GalleryViewMode>('thumbnails');
  readonly sortDirection = input<'asc' | 'desc'>('desc');
  readonly detailScrollTop = input(0);
  readonly detailViewportHeight = input(1200);
  readonly detailHeaderHeight = input(0);
  readonly windowStart = input(0);
  readonly totalFileCount = input(0);
  readonly thumbnailColumns = input(1);
  readonly thumbnailRowHeight = input(160);

  // Detail headers expose the current gallery sort initially, then own sorting after a header is clicked.
  readonly detailSortColumn = signal<DetailSortColumn | null>(null);
  readonly detailSortDirection = signal<'asc' | 'desc'>('asc');
  readonly activeDetailSortColumn = computed<DetailSortColumn>(() => this.detailSortColumn() ?? this.sortBy());
  readonly activeDetailSortDirection = computed<'asc' | 'desc'>(() =>
    this.detailSortColumn() === null ? this.sortDirection() : this.detailSortDirection()
  );
  readonly sortedDetailImages = computed(() => {
    const filter = this.nameFilterActive() ? this.nameFilter().trim().toLocaleLowerCase() : '';
    const images = (this.images() ?? []).filter(image =>
      !filter || image.name.toLocaleLowerCase().includes(filter)
    );
    // GalleryState supplies the selected global sort directly from SQLite.
    // Avoid sorting the complete 100k+ file list again unless a detail header
    // has explicitly selected a different sort column.
    if (this.detailSortColumn() === null) return images;
    const column = this.activeDetailSortColumn();
    const direction = this.activeDetailSortDirection() === 'asc' ? 1 : -1;
    const valueFor = (image: FileInfo): string | number | null => {
      const status = this.cacheStatuses().get(image.path);
      const tags = this.metadata().get(image.path);
      switch (column) {
        case 'name': return image.name;
        case 'date': return typeof image.modifiedAt === 'number' && Number.isFinite(image.modifiedAt) ? image.modifiedAt : null;
        case 'gpsDate': return typeof status?.gpsTimestamp === 'number' && Number.isFinite(status.gpsTimestamp) ? status.gpsTimestamp : null;
        case 'dimensions': {
          const width = Number(tags?.ImageWidth) || 0;
          const height = Number(tags?.ImageHeight) || 0;
          return width > 0 && height > 0 ? width * height : null;
        }
        case 'size': return Number.isFinite(image.size) ? image.size : null;
        case 'suffix': return this.getSuffix(image.name);
        case 'hdr': {
          const bits = tags?.BitsPerSample ?? tags?.BitDepth ?? tags?.ImagePixelDepth ?? null;
          return imageDynamicRange(image.path, tags ?? null, bits === null ? null : String(bits));
        }
        case 'thumb': return status?.thumbnail?.status ?? null;
        case 'fullSize': return status ? (status.fullSizeRequired ? status.fullSize?.status ?? 'missing' : 'not required') : null;
        case 'gps': return status?.latitude != null && status.longitude != null ? status.latitude * 1000 + status.longitude : null;
        case 'location': return this.locationDisplayNames().get(image.path) ?? null;
        case 'path': return this.relativeDetailPath(image);
      }
    };
    return images.sort((a, b) => {
      const left = valueFor(a), right = valueFor(b);
      if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1;
      const comparison = typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' });
      return comparison * direction;
    });
  });

  protected readonly sortDetailBy = (column: DetailSortColumn): void => {
    const currentColumn = this.activeDetailSortColumn();
    const currentDirection = this.activeDetailSortDirection();
    this.detailSortColumn.set(column);
    this.detailSortDirection.set(currentColumn === column
      ? currentDirection === 'asc' ? 'desc' : 'asc'
      : 'asc');
  };

  protected readonly detailSortIndicator = (column: DetailSortColumn): string =>
    this.activeDetailSortColumn() !== column ? '↕' : this.activeDetailSortDirection() === 'asc' ? '▲' : '▼';

  protected readonly detailSortAriaSort = (column: DetailSortColumn): 'ascending' | 'descending' | 'none' =>
    this.activeDetailSortColumn() !== column ? 'none' : this.activeDetailSortDirection() === 'asc' ? 'ascending' : 'descending';

  /* Computed */
  readonly suffixFileCounts = computed(() => {
    const counts = new Map<string, number>();
    for (const image of this.images() ?? []) {
      const suffix = this.getSuffix(image.name);
      if (suffix) counts.set(suffix, (counts.get(suffix) ?? 0) + 1);
    }
    return [...counts.entries()].sort(([left], [right]) =>
      left.localeCompare(right, undefined, { sensitivity: 'base' })
    );
  });
  readonly distinctSuffixes = computed(() => this.suffixFileCounts().map(([suffix]) => suffix));
  readonly distinctSuffixCount = computed(() => this.distinctSuffixes().length);
  readonly distinctSuffixTooltip = computed(() => {
    const suffixes = this.suffixFileCounts();
    const count = suffixes.length;
    const details = suffixes.map(([suffix, fileCount]) =>
      `${suffix} (${fileCount} ${fileCount === 1 ? 'file' : 'files'})`
    );
    return `${count} suffix${count === 1 ? '' : 'es'} found: ${details.join(', ')}`;
  });
  readonly unsupportedSuffixCount = signal(0);
  readonly unsupportedSuffixes = signal<string[]>([]);
  private getSuffix(name: string): string {
    const fileName = name.split(/[\\\\/]/).pop() ?? name;
    const dotIndex = fileName.lastIndexOf('.');
    return dotIndex > 0 && dotIndex < fileName.length - 1
      ? fileName.slice(dotIndex + 1).toLocaleLowerCase()
      : '';
  }

  protected readonly refreshCacheStatus = async (sourcePath: string): Promise<void> => {
    if (!sourcePath) return;
    const requestVersion = (this.cacheStatusPathRequests.get(sourcePath) ?? 0) + 1;
    this.cacheStatusPathRequests.set(sourcePath, requestVersion);
    try {
      const statuses = await this.cacheManager.getImageCacheStatuses([sourcePath]);
      if (this.cacheStatusPathRequests.get(sourcePath) !== requestVersion) return;
      this.cacheStatuses.update(current => {
        const next = new Map(current);
        const status = statuses.find(item => item.sourceName === sourcePath);
        if (status) next.set(sourcePath, status);
        else next.delete(sourcePath);
        return next;
      });
    } catch (error) {
      console.error('Failed to refresh gallery cache status', sourcePath, error);
    }
  };

  readonly fullSizeConversionTotal = computed(() => {
    const statuses = this.cacheStatuses();
    return (this.images() ?? []).filter(image => statuses.get(image.path)?.fullSizeRequired === true).length;
  });
  readonly gpsDateComparisons = signal<Map<string, boolean | null>>(new Map());
  readonly gpsDateDifferenceCount = computed(() =>
    [...this.gpsDateComparisons().values()].filter(differs => differs === true).length
  );

  private createGpsDateComparisons(
    images: FileInfo[],
    statuses: Map<string, CacheImageStatus>
  ): Map<string, boolean | null> {
    const comparisons = new Map<string, boolean | null>();
    for (const image of images) {
      const gpsTimestamp = statuses.get(image.path)?.gpsTimestamp;
      const modifiedAt = image.modifiedAt;
      if (gpsTimestamp === null || gpsTimestamp === undefined || !Number.isFinite(gpsTimestamp)
        || typeof modifiedAt !== 'number' || !Number.isFinite(modifiedAt)) {
        comparisons.set(image.path, null);
        continue;
      }
      // GPS timestamps are stored in whole seconds; compare at the same precision.
      comparisons.set(image.path, Math.floor(gpsTimestamp) !== Math.floor(modifiedAt / 1000));
    }
    return comparisons;
  }

  private cacheStatusFolderKey = '';
  private cacheStatusImagesRef: FileInfo[] | null = null;
  private cacheStatusRefreshToken = -1;
  private cacheStatusImageMetadata = new Map<string, string>();

  readonly detailValueRanges = computed(() => {
    const images = this.images() ?? [];
    const statuses = this.cacheStatuses();
    const metadata = this.metadata();
    let minDate = Infinity, maxDate = -Infinity;
    let minGpsDate = Infinity, maxGpsDate = -Infinity;
    let minSize = Infinity, maxSize = -Infinity;
    let minDimensionArea = Infinity, maxDimensionArea = -Infinity;

    for (const image of images) {
      const date = image.modifiedAt;
      if (typeof date === 'number' && Number.isFinite(date)) {
        minDate = Math.min(minDate, date);
        maxDate = Math.max(maxDate, date);
      }
      const gpsDate = statuses.get(image.path)?.gpsTimestamp;
      if (typeof gpsDate === 'number' && Number.isFinite(gpsDate)) {
        minGpsDate = Math.min(minGpsDate, gpsDate);
        maxGpsDate = Math.max(maxGpsDate, gpsDate);
      }
      const size = image.size;
      if (typeof size === 'number' && Number.isFinite(size)) {
        minSize = Math.min(minSize, size);
        maxSize = Math.max(maxSize, size);
      }
      const tags = metadata.get(image.path);
      const width = Number(tags?.ImageWidth) || 0;
      const height = Number(tags?.ImageHeight) || 0;
      if (width > 0 && height > 0) {
        const area = width * height;
        minDimensionArea = Math.min(minDimensionArea, area);
        maxDimensionArea = Math.max(maxDimensionArea, area);
      }
    }

    return {
      date: Number.isFinite(minDate) ? [minDate, maxDate] as const : null,
      gpsDate: Number.isFinite(minGpsDate) ? [minGpsDate, maxGpsDate] as const : null,
      dimensions: Number.isFinite(minDimensionArea) ? [minDimensionArea, maxDimensionArea] as const : null,
      size: Number.isFinite(minSize) ? [minSize, maxSize] as const : null
    };
  });

  readonly detailProgressByPath = computed(() => {
    const images = this.images() ?? [];
    const statuses = this.cacheStatuses();
    const metadata = this.metadata();
    const ranges = this.detailValueRanges();
    const percentage = (value: number | null | undefined, range: readonly [number, number] | null): number | null => {
      if (typeof value !== 'number' || !Number.isFinite(value) || !range) return null;
      const [min, max] = range;
      return max === min ? 50 : Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
    };

    const result = new Map<string, { date: number | null; gpsDate: number | null; dimensions: number | null; size: number | null }>();
    for (const image of images) {
      const gpsDate = statuses.get(image.path)?.gpsTimestamp;
      const tags = metadata.get(image.path);
      const width = Number(tags?.ImageWidth) || 0;
      const height = Number(tags?.ImageHeight) || 0;
      const area = width > 0 && height > 0 ? width * height : null;
      result.set(image.path, {
        date: percentage(image.modifiedAt, ranges.date),
        gpsDate: percentage(gpsDate, ranges.gpsDate),
        dimensions: percentage(area, ranges.dimensions),
        size: percentage(image.size, ranges.size)
      });
    }
    return result;
  });

  readonly detailSummary = computed(() => {
    const images = this.images() ?? [];
    const ranges = this.detailValueRanges();
    const dimensionValues = images.map(image => {
      const tags = this.metadata().get(image.path);
      const width = Number(tags?.ImageWidth) || 0;
      const height = Number(tags?.ImageHeight) || 0;
      return { width, height, area: width * height };
    }).filter(value => value.width > 0 && value.height > 0);

    const formatSize = (bytes: number) => {
      if (bytes < 1024) return `${bytes} B`;
      const units = ['KB', 'MB', 'GB', 'TB'];
      let value = bytes / 1024;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
      return `${value.toFixed(1)} ${units[unit]}`;
    };
    const minDimensions = dimensionValues.length
      ? dimensionValues.reduce((min, value) => value.area < min.area ? value : min)
      : null;
    const maxDimensions = dimensionValues.length
      ? dimensionValues.reduce((max, value) => value.area > max.area ? value : max)
      : null;
    return {
      date: ranges.date
        ? [formatOsDateTime(ranges.date[0]), formatOsDateTime(ranges.date[1])]
        : ['—', '—'],
      gpsDate: ranges.gpsDate
        ? [formatOsDateTime(ranges.gpsDate[0] * 1000), formatOsDateTime(ranges.gpsDate[1] * 1000)]
        : ['—', '—'],
      size: ranges.size
        ? [formatSize(ranges.size[0]), formatSize(ranges.size[1])]
        : ['—', '—'],
      dimensions: [
        minDimensions ? `${minDimensions.width} × ${minDimensions.height}` : '—',
        maxDimensions ? `${maxDimensions.width} × ${maxDimensions.height}` : '—'
      ]
    };
  });
  readonly dimensions = computed(() => thumbnailDimensions[this.thumbSize()]);
  readonly detailThumbnailWidth = computed(() => {
    const width = this.dimensions().width;
    return Math.round(24 + ((width - 96) / (512 - 96)) * 296);
  });
  readonly detailThumbnailHeight = computed(() => Math.round(this.detailThumbnailWidth() * 0.75));
  readonly detailVirtualRowHeight = computed(() => Math.max(
    34,
    Math.ceil(this.detailFontSize() * 1.25 + 16),
    this.viewMode() === 'details-no-thumbnails' ? 0 : this.detailThumbnailHeight() + 10
  ));
  private readonly detailVirtualOverscan = 12;
  readonly detailVirtualCount = computed(() =>
    Math.max(1, Math.ceil(Math.max(200, this.detailViewportHeight()) / this.detailVirtualRowHeight()) + this.detailVirtualOverscan * 2)
  );
  readonly detailVirtualStart = computed(() => {
    const bodyOffset = Math.max(0, this.detailScrollTop() - this.detailHeaderHeight());
    const globalRequested = Math.max(0, Math.floor(bodyOffset / this.detailVirtualRowHeight()) - this.detailVirtualOverscan);
    const localRequested = Math.max(0, globalRequested - this.windowStart());
    return Math.min(localRequested, Math.max(0, this.sortedDetailImages().length - this.detailVirtualCount()));
  });
  readonly visibleDetailImages = computed(() =>
    this.sortedDetailImages().slice(this.detailVirtualStart(), this.detailVirtualStart() + this.detailVirtualCount())
  );
  readonly detailVirtualTopSpacer = computed(() =>
    (this.windowStart() + this.detailVirtualStart()) * this.detailVirtualRowHeight()
  );
  readonly detailVirtualBottomSpacer = computed(() => {
    const renderedTotal = this.windowStart() > 0
      ? this.totalFileCount()
      : this.sortedDetailImages().length;
    return Math.max(0,
      renderedTotal - this.windowStart() - this.detailVirtualStart() - this.visibleDetailImages().length
    ) * this.detailVirtualRowHeight();
  });
  readonly thumbnailVirtualTopSpacer = computed(() =>
    Math.floor(this.windowStart() / Math.max(1, this.thumbnailColumns())) * this.thumbnailRowHeight()
  );
  readonly thumbnailVirtualBottomSpacer = computed(() => {
    const columns = Math.max(1, this.thumbnailColumns());
    const totalRows = Math.ceil(this.totalFileCount() / columns);
    const renderedEndRow = Math.ceil((this.windowStart() + (this.images()?.length ?? 0)) / columns);
    return Math.max(0, totalRows - renderedEndRow) * this.thumbnailRowHeight();
  });
  readonly isDateSorted = computed(() => this.sortBy() === 'date');
  readonly groupedImages = computed<YearGroup[]>(() => {
    if (!this.isDateSorted()) {
      return [];
    }
    const images = this.images();
    const groups = groupImagesByYearAndMonth(images);
    return groups;
  });

  /* Signals */
  readonly activeSectionId = signal<string | null>(null);

  private readonly displayedImages = computed(() =>
    this.viewMode() === 'details' || this.viewMode() === 'details-no-thumbnails'
      ? this.sortedDetailImages()
      : (this.images() ?? [])
  );

  protected onDetailMetadataLoaded(path: string, tags: ExifTags): void {
    this.metadata.update(current => {
      if (current.get(path) === tags) return current;
      const next = new Map(current);
      next.set(path, tags);
      return next;
    });
  }

  protected readonly selectThumbnail = (image: FileInfo): void => {
    this.activeSelectionPath.set(image.path);
    (this.elementRef.nativeElement as HTMLElement).focus({ preventScroll: true });
    this.selected.emit(image);
  };

  protected readonly onDetailRowSelected = (image: FileInfo): void => {
    this.activeSelectionPath.set(image.path);
    (this.elementRef.nativeElement as HTMLElement).focus({ preventScroll: true });
  };

  readonly detailColumnWidths = signal<Record<number, number>>({});
  readonly detailActionsColumnPosition = computed<'left' | 'right'>(() =>
    this.appConfig()?.system.galleryDetailActionsColumnPosition === 'right' ? 'right' : 'left'
  );
  protected readonly toggleDetailActionsColumnPosition = (): void => {
    const nextPosition = this.detailActionsColumnPosition() === 'left' ? 'right' : 'left';
    this.configuration.updateSystemConfig({ galleryDetailActionsColumnPosition: nextPosition });
  };

  protected readonly relativeDetailPath = (image: FileInfo): string => {
    const root = (this.folderPath() ?? '').replace(/[\\/]+$/, '');
    const parent = (image.parent ?? '').replace(/[\\/]+$/, '');
    if (!root || !parent) return parent || '';
    const normalizedRoot = root.replace(/\\/g, '/').toLocaleLowerCase();
    const normalizedParent = parent.replace(/\\/g, '/');
    if (normalizedParent.toLocaleLowerCase() === normalizedRoot) return '.';
    if (normalizedParent.toLocaleLowerCase().startsWith(normalizedRoot + '/')) {
      return normalizedParent.slice(normalizedRoot.length + 1).replace(/\//g, '\\');
    }
    return parent;
  };


  openDetailPreferences(): void {
    this.detailPreferenceDraft.set({ ...this.detailPreferenceValues() });
    const favorites = this.appConfig()?.system.galleryDetailPreferencesFavorites ?? [this.defaultDetailPreferenceFavorite];
    this.detailPreferenceFavorites.set(favorites as Array<{ name: string; settings: DetailTablePreferences }>);
    this.detailPreferenceFavoriteName.set('');
    this.detailPreferenceFavoriteSelection.set('');
    this.detailPreferencesOpen.set(true);
    requestAnimationFrame(() => {
      const host = this.elementRef.nativeElement as HTMLElement;
      const dialog = host.querySelector<HTMLElement>('.detail-preferences-dialog');
      const okButton = dialog?.querySelector<HTMLButtonElement>('.detail-preferences-ok');
      okButton?.focus();
    });
  }

  protected readonly onDetailPreferencesFooterKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const current = event.currentTarget as HTMLButtonElement;
    const buttons = Array.from(current.closest('footer')?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []);
    const index = buttons.indexOf(current);
    if (index < 0) return;
    event.preventDefault();
    event.stopPropagation();
    buttons[event.key === 'ArrowRight' ? Math.min(buttons.length - 1, index + 1) : Math.max(0, index - 1)].focus();
  };

  protected applyDetailPreferenceFavorite(name: string): void {
    this.detailPreferenceFavoriteSelection.set(name);
    const favorite = this.detailPreferenceFavorites().find(item => item.name === name);
    if (favorite) this.detailPreferenceDraft.set({ ...defaultDetailTablePreferences, ...favorite.settings });
  }

  protected addDetailPreferenceFavorite(): void {
    const name = this.detailPreferenceFavoriteName().trim();
    if (!name) return;
    const favorite = { name, settings: { ...this.detailPreferenceDraft() } };
    const favorites = [...this.detailPreferenceFavorites()];
    const existingIndex = favorites.findIndex(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (existingIndex >= 0) favorites[existingIndex] = favorite;
    else favorites.push(favorite);
    this.detailPreferenceFavorites.set(favorites);
    this.detailPreferenceFavoriteSelection.set(name);
    this.configuration.updateSystemConfig({ galleryDetailPreferencesFavorites: favorites as unknown as Array<{ name: string; settings: Record<string, unknown> }> });
  }

  protected removeDetailPreferenceFavorite(): void {
    const selectedName = this.detailPreferenceFavoriteSelection();
    if (!selectedName) return;
    const favorites = this.detailPreferenceFavorites().filter(item => item.name !== selectedName);
    this.detailPreferenceFavorites.set(favorites);
    this.detailPreferenceFavoriteSelection.set('');
    this.configuration.updateSystemConfig({ galleryDetailPreferencesFavorites: favorites as unknown as Array<{ name: string; settings: Record<string, unknown> }> });
  }

  protected updateDetailPreferenceColor(key: DetailTableColorKey, value: string): void {
    if (!/^#[0-9a-fA-F]{6}$/.test(value)) return;
    this.detailPreferenceDraft.update(current => ({ ...current, [key]: value }));
  }

  protected updateDetailPreferenceToggle(key: 'alternateRows' | 'dateProgressEnabled' | 'gpsDateProgressEnabled' | 'dimensionsProgressEnabled' | 'sizeProgressEnabled', value: boolean): void {
    this.detailPreferenceDraft.update(current => ({ ...current, [key]: value }));
  }

  protected updateDetailProgressTransparency(value: number): void {
    this.detailPreferenceDraft.update(current => ({ ...current, progressTransparency: Math.max(0, Math.min(100, value)) }));
  }

  protected cancelDetailPreferences(): void {
    this.detailPreferencesOpen.set(false);
  }

  protected saveDetailPreferences(): void {
    const preferences = this.detailPreferenceDraft();
    this.configuration.updatePreferencesConfig({
      galleryDetailDateProgressColor: preferences.date,
      galleryDetailGpsDateProgressColor: preferences.gpsDate,
      galleryDetailDimensionsProgressColor: preferences.dimensions,
      galleryDetailSizeProgressColor: preferences.size,
      galleryDetailSelectedRowColor: preferences.selectedRow,
      galleryDetailOddRowColor: preferences.oddRow,
      galleryDetailEvenRowColor: preferences.evenRow,
      galleryDetailFilteredRowColor: preferences.filteredRow,
      galleryDetailAlternateRowColors: preferences.alternateRows,
      galleryDetailDateProgressEnabled: preferences.dateProgressEnabled,
      galleryDetailGpsDateProgressEnabled: preferences.gpsDateProgressEnabled,
      galleryDetailDimensionsProgressEnabled: preferences.dimensionsProgressEnabled,
      galleryDetailSizeProgressEnabled: preferences.sizeProgressEnabled,
      galleryDetailProgressTransparency: preferences.progressTransparency
    });
    this.detailPreferencesOpen.set(false);
  }


  protected requestOpenFolderPath(): void {
    this.openFolderPathRequested.emit();
  }

  protected requestCopyFolderPath(): void {
    this.copyFolderPathRequested.emit();
  }

  protected requestCacheDisplayedFiles(): void {
    void this.cacheDisplayedFiles();
  }

  protected requestReCacheDisplayedFiles(): void {
    this.reCacheDisplayedFiles();
  }

  protected requestRefreshFolder(): void {
    void this.refreshGallery();
  }

  protected autofitDetailColumns(): void {
    const table = (this.elementRef.nativeElement as HTMLElement).querySelector<HTMLTableElement>('table.detail-native-table');
    if (!table) return;

    const widths: Record<number, number> = { 0: 0 };
    for (let column = 1; column <= 12; column++) {
      const width = this.measureDetailColumnWidth(table, column);
      if (width !== null) widths[column] = width;
    }

    this.detailColumnWidths.set(widths);
    this.saveDetailColumnWidths();
  }

  protected autofitDetailColumn(event: MouseEvent, columnIndex: number): void {
    event.preventDefault();
    event.stopPropagation();

    const table = (this.elementRef.nativeElement as HTMLElement).querySelector<HTMLTableElement>('table.detail-native-table');
    if (!table || columnIndex < 0 || columnIndex > 12) return;

    // The thumbnail column follows the current thumbnail zoom level. Reset
    // only its manual width adjustment rather than changing the zoom setting.
    const width = columnIndex === 0 ? 0 : this.measureDetailColumnWidth(table, columnIndex);
    if (width === null) return;

    this.detailColumnWidths.update(current => ({ ...current, [columnIndex]: width }));
    this.saveDetailColumnWidths();
  }

  private measureDetailColumnWidth(table: HTMLTableElement, column: number): number | null {
    const context = table.ownerDocument.createElement('canvas').getContext('2d');
    if (!context) return null;

    const headers = Array.from(table.querySelectorAll<HTMLTableCellElement>('thead tr.detail-header-labels > th'));
    const rows = Array.from(table.querySelectorAll<HTMLElement>('tbody.images > tr'));
    let maximum = 40;
    const cells = [headers[column], ...rows.map(row => row.children.item(column) as HTMLElement | null)];
    for (const cell of cells) {
      if (!cell) continue;
      const style = table.ownerDocument.defaultView?.getComputedStyle(cell);
      context.font = style?.font ?? '12px sans-serif';
      // Measure visible cell content only. Tooltip titles can contain entire
      // inventories (for example every suffix in the folder) and must not
      // dictate the actual column width.
      const text = (cell.textContent ?? '').replace(/\\s+/g, ' ').trim();
      if (text) maximum = Math.max(maximum, context.measureText(text).width + 24);
    }

    // Compact metadata columns should remain compact even when a status
    // label or an unusually long suffix is present.
    const maximumWidth = column === 6 ? 100 : column === 8 ? 110 : 1600;
    return Math.min(maximumWidth, Math.ceil(maximum));
  }

  private saveDetailColumnWidths(): void {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('lumascope.thumbnail-list.detail-column-widths', JSON.stringify(this.detailColumnWidths()));
      }
    } catch (error) {
      console.warn('Could not save thumbnail-list column widths', error);
    }
  }

  protected startColumnResize(event: PointerEvent, columnIndex: number): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const handle = event.currentTarget as HTMLElement;
    const cell = handle.closest('th') as HTMLTableCellElement | null;
    const table = handle.closest('table.detail-native-table') as HTMLTableElement | null;
    if (!table || !cell) return;

    const startX = event.clientX;
    // The table can distribute surplus viewport width across COL tracks.
    // Neither the rendered COL nor TH width is therefore a reliable resize
    // baseline. Use the configured width (persisted override or template
    // default) so the first pointer movement starts without a width jump.
    const defaultWidths: Record<number, number> = {
      1: 210, 2: 150, 3: 150, 4: 130, 5: 100, 6: 75,
      7: 65, 8: 65, 9: 150, 10: 150, 11: 240, 12: 220
    };
    const configuredWidth = this.detailColumnWidths()[columnIndex];
    const startWidth = columnIndex === 0
      ? Math.max(52, this.detailThumbnailWidth() + 20 + (configuredWidth ?? 0))
      : configuredWidth ?? defaultWidths[columnIndex] ?? cell.getBoundingClientRect().width;
    const minimumWidth = columnIndex === -1 ? 44 : columnIndex === 0 ? 52 : columnIndex >= 10 ? 80 : 40;
    const pointerId = event.pointerId;
    const document = table.ownerDocument;
    const initialThumbWidth = this.detailThumbnailWidth();

    const onMove = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== pointerId) return;
      const width = Math.max(minimumWidth, Math.round(startWidth + moveEvent.clientX - startX));
      const storedWidth = columnIndex === 0
        ? width - initialThumbWidth
        : width;
      this.detailColumnWidths.update(current => ({ ...current, [columnIndex]: storedWidth }));
      this.saveDetailColumnWidths();
    };
    const cleanup = (): void => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
    };
    const onUp = (upEvent: PointerEvent): void => {
      if (upEvent.pointerId !== pointerId) return;
      this.saveDetailColumnWidths();
      cleanup();
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  }
  @HostListener('document:keydown', ['$event'])
  protected onThumbnailListKeydown(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.matches('input, textarea, select, button, a, [contenteditable="true"], [role="menuitem"]')) return;
    const host = this.elementRef.nativeElement as HTMLElement;
    if (target instanceof Node && !host.contains(target)
      && target !== host.ownerDocument.body && target !== host.ownerDocument.documentElement) return;

    const images = this.displayedImages();
    if (images.length === 0) return;
    const currentIndex = images.findIndex(image => image.path === this.activeSelectionPath());
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const baseIndex = currentIndex < 0 ? (delta > 0 ? -1 : 0) : currentIndex;
      const nextIndex = Math.max(0, Math.min(images.length - 1, baseIndex + delta));
      const next = images[nextIndex];
      this.activeSelectionPath.set(next.path);
      queueMicrotask(() => {
        const host = this.elementRef.nativeElement as HTMLElement;
        const elements = host.querySelectorAll<HTMLElement>('[data-image-path]');
        const rendered = Array.from(elements).find(element => element.dataset['imagePath'] === next.path);
        const viewport = host.closest<HTMLElement>('.wrapper');
        if (viewport && (this.viewMode() === 'details' || this.viewMode() === 'details-no-thumbnails')) {
          const header = viewport.querySelector<HTMLElement>('.detail-native-table thead');
          const headerBottom = header?.getBoundingClientRect().bottom ?? viewport.getBoundingClientRect().top;
          const viewportRect = viewport.getBoundingClientRect();
          if (rendered) {
            const rowRect = rendered.getBoundingClientRect();
            if (rowRect.top < headerBottom) {
              viewport.scrollTop -= headerBottom - rowRect.top;
            } else if (rowRect.bottom > viewportRect.bottom) {
              viewport.scrollTop += rowRect.bottom - viewportRect.bottom;
            }
          } else {
            const headerHeight = header?.getBoundingClientRect().height ?? 0;
            viewport.scrollTop = headerHeight + nextIndex * this.detailVirtualRowHeight();
          }
        }
      });
      return;
    }
    if (event.key === 'Enter' && currentIndex >= 0) {
      event.preventDefault();
      event.stopPropagation();
      this.selected.emit(images[currentIndex]);
    }
  }

  /* Outputs */
  readonly selected = output<FileInfo>();

  readonly hovered = output<FileInfo | null>();

  readonly cacheUpdated = output<string>();
  readonly openFolderPathRequested = output<void>();
  readonly copyFolderPathRequested = output<void>();
  private readonly importGpxFilesFoundDuringCacheBuild = async (filePaths: string[], signal: AbortSignal, enabled: boolean): Promise<void> => {
    if (!enabled) return;
    const uniquePaths = [...new Map(filePaths.map(path => [path.toLocaleLowerCase(), path])).values()];
    if (uniquePaths.length === 0 || signal.aborted) return;

    const cacheSummary = this.cacheRunCurrentOperation();
    this.cacheRunCurrentOperation.set(`Importing ${uniquePaths.length} GPX files into the cache database…`);
    try {
      await this.cacheManager.appendBuildLog(`GPX database import started: ${uniquePaths.length} file(s) found during cache build.`).catch(() => undefined);
      // Reuse the same importer as “Add all GPX tracks from folder to DB…”.
      const result = await this.cacheManager.importGpxFiles(uniquePaths);
      const summary = `GPX database import completed: imported ${result.imported}, unchanged ${result.unchanged}, duplicates ${result.duplicates}, errors ${result.errors}.`;
      await this.cacheManager.appendBuildLog(summary).catch(() => undefined);
      this.cacheRunCurrentOperation.set([cacheSummary, summary].filter(Boolean).join('\n'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const summary = `GPX database import failed: ${message}`;
      await this.cacheManager.appendBuildLog(summary).catch(() => undefined);
      this.cacheRunCurrentOperation.set([cacheSummary, summary].filter(Boolean).join('\n'));
    }
  };

  readonly cacheAllImages = async (directory?: string, importGpx = true): Promise<void> => {
    if (this.cacheRunActive()) return;
    const controller = new AbortController();
    this.cacheAbortController = controller;
    this.cacheRunActive.set(true);
    this.cacheRunProgress.set({ completed: 0, total: 0 });
    try {
      const folder = directory?.trim() || this.folderPath();
      let processedImages = 0;
      let resetLog = true;
      let reconciledRecords = 0;
      if (folder) {
        this.cacheRunCurrentOperation.set(`Reading images in ${folder}`);
        const entries = await this.fileSystem.readDir(folder);
        const files = entries.filter(entry => !entry.isDirectory);
        await this.cacheManager.registerGalleryFiles(folder, files);
        for (let offset = 0; offset < files.length && !controller.signal.aborted; offset += 500) {
          const batch = files.slice(offset, offset + 500);
          const images = batch.filter(file => supportedFileExtensions.includes(file.ext.toLowerCase().replace(/^\\./, '')));
          if (images.length > 0) {
            await this.runCacheForImages(images, true, controller.signal, {
              resetLog, progressOffset: processedImages, progressTotal: processedImages + images.length, suppressRefresh: true
            });
            processedImages += images.length;
            resetLog = false;
          }
          if (importGpx) {
            const gpxFiles = batch.filter(file => file.ext.toLowerCase() === '.gpx').map(file => file.path);
            if (gpxFiles.length > 0) await this.importGpxFilesFoundDuringCacheBuild(gpxFiles, controller.signal, true);
          }
        }
        if (this.verifyCacheFiles() && !controller.signal.aborted) {
          this.cacheRunCurrentOperation.set(`Removing stale photo database records in ${folder}`);
          reconciledRecords = await this.cacheManager.reconcilePhotoRecordsFromDisk(folder, false);
          await this.cacheManager.appendBuildLog(`Photo database reconciliation: removed ${reconciledRecords} stale records in ${folder}`);
        }
      } else {
        const images = (this.images() ?? []).filter(file => supportedFileExtensions.includes(file.ext.toLowerCase().replace('.', '')));
        await this.runCacheForImages(images, true, controller.signal);
        processedImages = images.length;
      }
      if (processedImages === 0 && !controller.signal.aborted) {
        await this.cacheManager.resetBuildLog();
        await this.cacheManager.appendBuildLog('Cache build completed: no supported images found.');
        this.cacheRunCurrentOperation.set('No supported images found to cache.');
      }
      if (!controller.signal.aborted) this.cacheRunProgress.set({ completed: processedImages, total: processedImages });
    } catch (error) {
      this.cacheRunCurrentOperation.set(`Cache build failed: ${error instanceof Error ? error.message : String(error)}`);
      console.error('Failed to cache gallery images', error);
    } finally {
      if (this.cacheAbortController === controller) this.cacheAbortController = null;
      this.cacheRunActive.set(false);
      this.manualRefresh.update(value => value + 1);
      this.cacheUpdated.emit('');
    }
  };

  readonly cancelCacheRun = (): void => {
    this.cacheAbortController?.abort();
  };

  private readonly forEachDisplayedGalleryBatch = async (
    callback: (images: FileInfo[], offset: number, total: number, resetLog: boolean) => Promise<void>,
    signal: AbortSignal,
    progressBase = 0,
    progressMultiplier = 1
  ): Promise<{ total: number; scanned: number; matched: number }> => {
    const folder = this.folderPath();
    if (!folder) return { total: 0, scanned: 0, matched: 0 };
    const recursive = this.includeFilesRecursive();
    const includeUnsupported = this.includeUnsupportedFiles();
    const sortBy = this.sortBy();
    const sortDir = this.sortDirection();
    const filter = (this.viewMode() === 'details' || this.viewMode() === 'details-no-thumbnails')
      && this.nameFilterActive() ? this.nameFilter().trim().toLocaleLowerCase() : '';
    let offset = 0;
    let total = this.totalFileCount();
    let resetLog = true;
    let matched = 0;
    while (!signal.aborted) {
      const page = await this.cacheManager.getGalleryFilesPage(
        folder, recursive, includeUnsupported, sortBy, sortDir, offset, 500
      );
      if (page.totalCount >= 0) total = page.totalCount;
      if (offset === 0) this.cacheRunProgress.set({ completed: progressBase, total: total * progressMultiplier });
      if (page.files.length === 0) break;
      const batch = page.files.filter(image =>
        (!filter || image.name.toLocaleLowerCase().includes(filter))
        && supportedFileExtensions.includes(image.ext.toLowerCase().replace('.', ''))
      );
      if (batch.length > 0) {
        matched += batch.length;
        await callback(batch, offset, total, resetLog);
        resetLog = false;
      }
      offset += page.files.length;
      // Progress includes filtered-out and unsupported rows too, because they
      // have been scanned and intentionally skipped.
      this.cacheRunProgress.update(progress => ({ ...progress, completed: Math.min(total * progressMultiplier, progressBase + offset) }));
      if (page.files.length < 500) break;
    }
    return { total, scanned: offset, matched };
  };

  readonly cacheDisplayedFiles = async (): Promise<void> => {
    if (this.galleryCacheBuild.cacheRunActive() || this.cacheRunActive() || !this.folderPath()) return;
    const controller = new AbortController();
    this.cacheAbortController = controller;
    this.cacheRunActive.set(true);
    this.cacheRunCurrentOperation.set('Preparing displayed gallery cache batches...');
    const releaseActivity = this.galleryCacheBuild.trackActivity({
      active: this.cacheRunActive,
      progress: this.cacheRunProgress,
      currentOperation: this.cacheRunCurrentOperation,
      cancel: this.cancelCacheRun
    });
    try {
      const result = await this.forEachDisplayedGalleryBatch(async (batch, offset, total, resetLog) => {
        await this.runCacheForImages(batch, true, controller.signal, {
          resetLog, progressOffset: offset, progressTotal: total, suppressRefresh: true
        });
      }, controller.signal);
      if (result.matched === 0) this.cacheRunCurrentOperation.set('No displayed images found to cache.');
      else if (!controller.signal.aborted) {
        await this.cacheManager.appendBuildLog(`Displayed gallery cache operation completed: scanned ${result.scanned} / ${result.total} files`);
      }
    } catch (error) {
      this.cacheRunCurrentOperation.set(`Cache build failed: ${error instanceof Error ? error.message : String(error)}`);
      console.error('Failed to cache displayed gallery files', error);
    } finally {
      if (this.cacheAbortController === controller) this.cacheAbortController = null;
      this.cacheRunActive.set(false);
      releaseActivity();
      this.cacheUpdated.emit('');
    }
  };

  readonly reCacheFile = (image: FileInfo): void => {
    void this.reCacheImages([image]);
  };

  readonly reCacheDisplayedFiles = (): void => {
    void this.reCacheDisplayedGalleryScope();
  };

  private readonly reCacheDisplayedGalleryScope = async (): Promise<void> => {
    if (this.galleryCacheBuild.cacheRunActive() || this.cacheRunActive() || !this.folderPath()) return;
    const controller = new AbortController();
    this.cacheAbortController = controller;
    this.cacheRunActive.set(true);
    this.cacheRunCurrentOperation.set('Removing existing displayed gallery cache entries...');
    const releaseActivity = this.galleryCacheBuild.trackActivity({
      active: this.cacheRunActive,
      progress: this.cacheRunProgress,
      currentOperation: this.cacheRunCurrentOperation,
      cancel: this.cancelCacheRun
    });
    let total = 0;
    try {
      await this.cacheManager.resetBuildLog();
      await this.cacheManager.appendBuildLog('Displayed gallery Re-Cache started: ' + formatOsDateTime(new Date()));
      const deletion = await this.forEachDisplayedGalleryBatch(async (batch, offset, count) => {
        total = count;
        for (let index = 0; index < batch.length && !controller.signal.aborted; index++) {
          const image = batch[index];
          this.cacheRunCurrentOperation.set(`Removing cache entries for file ${offset + index + 1} / ${count}: ${image.name}`);
          await this.cacheManager.deleteImage(image.path);
        }
      }, controller.signal, 0, 2);
      total = deletion.total;
      if (!controller.signal.aborted && deletion.matched > 0) {
        await this.cacheManager.appendBuildLog('Existing cache entries removed; rebuilding thumbnails and full-size conversions.');
        await this.forEachDisplayedGalleryBatch(async (batch, offset, count) => {
          await this.runCacheForImages(batch, true, controller.signal, {
            resetLog: false, progressOffset: count + offset, progressTotal: count * 2, suppressRefresh: true
          });
        }, controller.signal, total, 2);
      }
      if (deletion.matched === 0) this.cacheRunCurrentOperation.set('No displayed images found to re-cache.');
      else if (controller.signal.aborted) this.cacheRunCurrentOperation.set('Displayed gallery Re-Cache cancelled.');
      else await this.cacheManager.appendBuildLog(`Displayed gallery Re-Cache completed: ${deletion.scanned} / ${total} files scanned`);
    } catch (error) {
      this.cacheRunCurrentOperation.set(`Cache rebuild failed: ${error instanceof Error ? error.message : String(error)}`);
      console.error('Failed to re-cache displayed gallery files', error);
    } finally {
      if (this.cacheAbortController === controller) this.cacheAbortController = null;
      this.cacheRunActive.set(false);
      this.manualRefresh.update(value => value + 1);
      releaseActivity();
      this.cacheUpdated.emit('');
    }
  };

  private readonly reCacheImages = async (images: FileInfo[]): Promise<void> => {
    const cacheImages = images.filter(image => supportedFileExtensions.includes(image.ext.toLowerCase().replace('.', '')));
    if (this.galleryCacheBuild.cacheRunActive() || this.cacheRunActive() || cacheImages.length === 0) return;
    const controller = new AbortController();
    this.cacheAbortController = controller;
    this.cacheRunActive.set(true);
    this.cacheRunProgress.set({ completed: 0, total: cacheImages.length });
    this.cacheRunCurrentOperation.set('Removing existing cache entries...');
    const releaseActivity = this.galleryCacheBuild.trackActivity({
      active: this.cacheRunActive,
      progress: this.cacheRunProgress,
      currentOperation: this.cacheRunCurrentOperation,
      cancel: this.cancelCacheRun
    });
    let cacheBuildStarted = false;
    try {
      for (let index = 0; index < cacheImages.length; index++) {
        if (controller.signal.aborted) break;
        const image = cacheImages[index];
        this.cacheRunCurrentOperation.set(`Removing cache entries for file ${index + 1} / ${cacheImages.length}: ${image.name}`);
        await this.cacheManager.deleteImage(image.path);
        this.cacheRunProgress.set({ completed: index + 1, total: cacheImages.length });
      }
      if (!controller.signal.aborted) {
        cacheBuildStarted = true;
        await this.runCacheForImages(cacheImages, true, controller.signal);
      } else {
        this.cacheRunCurrentOperation.set('Cache rebuild cancelled while removing existing entries.');
      }
    } catch (error) {
      this.cacheRunCurrentOperation.set(`Cache rebuild failed: ${error instanceof Error ? error.message : String(error)}`);
      console.error('Failed to remove existing gallery cache entries', error);
    } finally {
      if (this.cacheAbortController === controller) this.cacheAbortController = null;
      this.cacheRunActive.set(false);
      if (!cacheBuildStarted) this.manualRefresh.update(value => value + 1);
      releaseActivity();
      this.cacheUpdated.emit('');
    }
  };

  readonly cacheAllImagesRecursive = async (directory?: string, importGpx = true): Promise<void> => {
    if (this.cacheRunActive()) return;
    const rootPath = directory?.trim() || this.folderPath() || this.images()?.[0]?.parent || null;
    if (!rootPath) return;

    const controller = new AbortController();
    this.cacheAbortController = controller;
    this.cacheRunActive.set(true);
    this.cacheRunProgress.set({ completed: 0, total: 0 });
    const visitedDirectories = new Set<string>([rootPath.toLocaleLowerCase()]);
    const pendingDirectories: string[] = [rootPath];
    let processedImages = 0;
    let resetLog = true;
    let enumerationComplete = true;
    let reconciledRecords = 0;
    let pendingGpxFiles: string[] = [];
    try {
      while (pendingDirectories.length > 0 && !controller.signal.aborted) {
        const directoryPath = pendingDirectories.shift()!;
        this.cacheRunCurrentOperation.set(`Enumerating files and subfolders in ${directoryPath}`);
        let entries: FileInfo[];
        try {
          entries = await this.fileSystem.readDir(directoryPath);
        } catch (error) {
          console.warn('Failed to enumerate gallery folder', directoryPath, error);
          enumerationComplete = false;
          continue;
        }
        const childDirectories = entries.filter(entry =>
          entry.isDirectory && !['.cache', '.thumbnails'].includes(entry.name.toLowerCase())
        );
        for (const child of childDirectories) {
          const key = child.path.toLocaleLowerCase();
          if (!visitedDirectories.has(key)) {
            visitedDirectories.add(key);
            pendingDirectories.push(child.path);
          }
        }

        const files = entries.filter(entry => !entry.isDirectory);
        await this.cacheManager.registerGalleryFiles(directoryPath, files);
        for (let offset = 0; offset < files.length && !controller.signal.aborted; offset += 500) {
          const batch = files.slice(offset, offset + 500);
          const images = batch.filter(file => supportedFileExtensions.includes(file.ext.toLowerCase().replace(/^\\./, '')));
          if (images.length > 0) {
            await this.runCacheForImages(images, true, controller.signal, {
              resetLog, progressOffset: processedImages, progressTotal: processedImages + images.length, suppressRefresh: true
            });
            processedImages += images.length;
            resetLog = false;
          }
          if (importGpx) {
            pendingGpxFiles.push(...batch.filter(file => file.ext.toLowerCase() === '.gpx').map(file => file.path));
            if (pendingGpxFiles.length >= 500) {
              await this.importGpxFilesFoundDuringCacheBuild(pendingGpxFiles, controller.signal, true);
              pendingGpxFiles = [];
            }
          }
        }
      }

      if (!controller.signal.aborted && this.verifyCacheFiles() && enumerationComplete) {
        this.cacheRunCurrentOperation.set(`Removing stale photo database records under ${rootPath}`);
        reconciledRecords = await this.cacheManager.reconcilePhotoRecordsFromDisk(rootPath, true);
        await this.cacheManager.appendBuildLog(`Recursive photo database reconciliation: removed ${reconciledRecords} stale records under ${rootPath}`);
      } else if (this.verifyCacheFiles() && !enumerationComplete) {
        await this.cacheManager.appendBuildLog('Recursive photo database reconciliation skipped because one or more folders could not be fully enumerated.');
      }

      if (pendingGpxFiles.length > 0 && !controller.signal.aborted) {
        await this.importGpxFilesFoundDuringCacheBuild(pendingGpxFiles, controller.signal, importGpx);
      }
      if (processedImages === 0 && !controller.signal.aborted) {
        await this.cacheManager.resetBuildLog();
        await this.cacheManager.appendBuildLog('Recursive cache build completed: no supported images found.');
        this.cacheRunCurrentOperation.set('No supported images found to cache.');
      }
      if (!controller.signal.aborted) this.cacheRunProgress.set({ completed: processedImages, total: processedImages });
    } catch (error) {
      console.error('Failed to enumerate recursive gallery cache workload', error);
      this.cacheRunCurrentOperation.set(`Cache build failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (this.cacheAbortController === controller) this.cacheAbortController = null;
      if (controller.signal.aborted && !this.cacheRunCurrentOperation().startsWith('Cache build ')) {
        this.cacheRunCurrentOperation.set('Cache build cancelled during folder enumeration.');
      }
      this.cacheRunActive.set(false);
      this.manualRefresh.update(value => value + 1);
      this.cacheUpdated.emit('');
    }
  };

  private readonly fetchCacheResource = async (url: string, buildSignal?: AbortSignal): Promise<Response> => {
    const requestController = new AbortController();
    let timedOut = false;
    const abortFromBuild = (): void => requestController.abort();
    if (buildSignal?.aborted) abortFromBuild();
    else buildSignal?.addEventListener('abort', abortFromBuild, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      requestController.abort();
    }, 120000);
    try {
      return await fetch(url, { cache: 'no-store', signal: requestController.signal });
    } catch (error) {
      if (timedOut) throw new Error('Cache request timed out after 120 seconds.');
      throw error;
    } finally {
      clearTimeout(timeout);
      buildSignal?.removeEventListener('abort', abortFromBuild);
    }
  };

  private readonly runCacheForImages = async (
    images: FileInfo[],
    alreadyActive = false,
    signal?: AbortSignal,
    batchOptions?: { resetLog?: boolean; progressOffset?: number; progressTotal?: number; suppressRefresh?: boolean }
  ): Promise<void> => {
    if (images.length === 0) {
      this.cacheRunCurrentOperation.set('No images found to cache.');
      return;
    }
    if (this.cacheRunActive() && !alreadyActive) return;

    if (!alreadyActive) this.cacheRunActive.set(true);
    this.cacheRunProgress.set({ completed: batchOptions?.progressOffset ?? 0, total: batchOptions?.progressTotal ?? images.length });
    this.cacheWorkerOperations.clear();
    this.cacheRunCurrentOperation.set('Preparing cache status for files...');
    const buildStartedAt = performance.now();
    let verificationSummary = '';
    let thumbnailsGenerated = 0;
    let fullSizeConversionsGenerated = 0;
    try {
      if (batchOptions?.resetLog !== false) {
        await this.cacheManager.resetBuildLog();
        await this.cacheManager.appendBuildLog('Cache build started: ' + formatOsDateTime(new Date()));
        await this.cacheManager.appendBuildLog('Verify cache files: ' + (this.verifyCacheFiles() ? 'enabled' : 'disabled'));
      } else {
        await this.cacheManager.appendBuildLog('Cache batch started: ' + formatOsDateTime(new Date()));
      }
      const statusPreparationStartedAt = performance.now();
      let gpsMetadataVerified = 0;
      const gpsMetadataErrors: string[] = [];
      if (this.verifyCacheFiles()) {
        this.cacheRunCurrentOperation.set('Verifying GPS metadata against image files...');
        let nextGpsIndex = 0;
        const gpsWorker = async (): Promise<void> => {
          while (nextGpsIndex < images.length && !signal?.aborted) {
            const index = nextGpsIndex++;
            const result = await this.exif.refreshGpsMetadata(images[index].path);
            if (result.success) gpsMetadataVerified++;
            else gpsMetadataErrors.push(`${images[index].path}: ${result.errorMessage}`);
          }
        };
        await Promise.all(Array.from({ length: Math.min(8, images.length) }, () => gpsWorker()));
        await this.cacheManager.appendBuildLog(
          `GPS metadata verification: synchronized ${gpsMetadataVerified} files, errors ${gpsMetadataErrors.length}`
        );
        for (const error of gpsMetadataErrors) {
          await this.cacheManager.appendBuildLog(`GPS metadata verification failed: ${error}`);
        }
      }
      const statuses: CacheImageStatus[] = [];
      const imagePaths = images.map(image => image.path);
      const sourceMetadata = images.map(image => ({ path: image.path, size: image.size, modifiedAt: image.modifiedAt ?? image.createdAt }));
      for (let offset = 0; offset < imagePaths.length; offset += 500) {
        statuses.push(...await this.cacheManager.getImageCacheStatuses(
          imagePaths.slice(offset, offset + 500),
          this.verifyCacheFiles(),
          sourceMetadata.slice(offset, offset + 500)
        ));
      }
      const verificationTimeMs = Math.round(performance.now() - statusPreparationStartedAt);
      const sourceFilesVerified = statuses.filter(status => status.verification?.sourceChecked).length;
      const thumbnailsVerified = statuses.filter(status => status.verification?.thumbnailChecked).length;
      const fullSizeFilesVerified = statuses.filter(status => status.verification?.fullSizeChecked).length;
      const invalidCacheEntries = statuses.reduce((total, status) => total + (status.verification?.invalidEntries ?? 0), 0);
      verificationSummary = [
        `Files: ${images.length}`,
        this.verifyCacheFiles()
          ? `Verified: ${sourceFilesVerified} source, ${thumbnailsVerified} thumbnails, ${fullSizeFilesVerified} full-size files`
          : 'Verification: disabled',
        this.verifyCacheFiles() ? `Missing/invalid cache entries: ${invalidCacheEntries}` : '',
        this.verifyCacheFiles() ? `GPS metadata synchronized: ${gpsMetadataVerified}, errors: ${gpsMetadataErrors.length}` : '',
        `Verification time: ${verificationTimeMs} ms`
      ].filter(Boolean).join('\n');
      await this.cacheManager.appendBuildLog('Cache verification summary:\n' + verificationSummary);
      if (signal?.aborted) {
        const summary = `Cache build cancelled during status preparation\n${verificationSummary}\nGenerated: 0 thumbnails, 0 full-size conversions\nTotal time: ${Math.round(performance.now() - buildStartedAt)} ms`;
        await this.cacheManager.appendBuildLog(summary);
        this.cacheRunCurrentOperation.set(summary);
        return;
      }
      const statusByPath = new Map(statuses.map(status => [status.sourceName, status]));
      const logBuffer: string[] = [];
      let logWrite = Promise.resolve();
      const appendLog = (line: string): Promise<void> => {
        logBuffer.push(line);
        if (logBuffer.length < 100) return Promise.resolve();
        const chunk = logBuffer.splice(0).join('\n');
        logWrite = logWrite.then(() => this.cacheManager.appendBuildLog(chunk));
        return logWrite;
      };
      let nextIndex = 0;
      const cacheBuildErrors: string[] = [];
      const worker = async (workerId: number): Promise<void> => {
        while (nextIndex < images.length && !signal?.aborted) {
          const index = nextIndex++;
          const image = images[index];
          try {
            const status = statusByPath.get(image.path);
            const thumbnailValid = status?.thumbnail?.status === 'valid';
            const fullSizeValid = !status?.fullSizeRequired || status.fullSize?.status === 'valid';
            if (thumbnailValid && fullSizeValid) {
              await appendLog(`[${index + 1}/${images.length}] SKIP (cache status complete): ${image.path}`);
            } else {
              if (!thumbnailValid) {
                this.setCacheWorkerOperation(workerId, `Thumbnail generation for file ${image.path}`);
                await appendLog(`[${index + 1}/${images.length}] THUMBNAIL: ${image.path}`);
                const thumbnailResponse = await this.fetchCacheResource(thumbUrl(image.path, 512, 512), signal);
                if (!thumbnailResponse.ok) {
                  const responseDetails = (await thumbnailResponse.text()).trim();
                  throw new Error(`Thumbnail generation failed (HTTP ${thumbnailResponse.status}${responseDetails ? `: ${responseDetails}` : ''})`);
                }
                thumbnailsGenerated++;
                await thumbnailResponse.body?.cancel();
              }
              if (!signal?.aborted && status?.fullSizeRequired && !fullSizeValid) {
                this.setCacheWorkerOperation(workerId, `Full-Size conversion for file ${image.path}`);
                await appendLog(`[${index + 1}/${images.length}] FULL-SIZE: ${image.path}`);
                const fullSizeResponse = await this.fetchCacheResource(imageUrl(image.path), signal);
                if (!fullSizeResponse.ok) {
                  const responseDetails = (await fullSizeResponse.text()).trim();
                  throw new Error(responseDetails
                    ? `Full-size conversion failed: ${responseDetails}`
                    : `Full-size conversion failed (HTTP ${fullSizeResponse.status} ${fullSizeResponse.statusText}).`);
                }
                fullSizeConversionsGenerated++;
                await fullSizeResponse.body?.cancel();
              }
            }
          } catch (error) {
            if (!signal?.aborted) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              console.error('Failed to cache gallery image', image.path, error);
              const failure = `[${index + 1}/${images.length}] ERROR: ${image.path} :: ${errorMessage}`;
              cacheBuildErrors.push(failure);
              const currentOperations = [...this.cacheWorkerOperations.values()];
              const retainedErrors = this.cacheRunCurrentOperation().split('\\n').filter(line => line.includes('] ERROR:'));
              this.cacheRunCurrentOperation.set([...currentOperations, ...retainedErrors, failure].join('\\n'));
              await appendLog(failure);
            }
          } finally {
            this.setCacheWorkerOperation(workerId, null);
            this.cacheRunProgress.update(progress => ({ ...progress, completed: progress.completed + 1 }));
          }
        }
      };
      // Full-size RAW development can allocate very large WASM images.
      // Run cache jobs sequentially to avoid two simultaneous full-size decodes
      // exhausting the renderer/worker memory budget.
      await worker(0);
      if (logBuffer.length > 0) {
        const chunk = logBuffer.splice(0).join('\n');
        logWrite = logWrite.then(() => this.cacheManager.appendBuildLog(chunk));
      }
      await logWrite;
      const errorSummary = cacheBuildErrors.length
        ? `Failed files: ${cacheBuildErrors.length}\n${cacheBuildErrors.join('\n')}`
        : 'Failed files: 0';
      const summary = `Cache build ${signal?.aborted ? 'cancelled' : 'completed'}\n${verificationSummary}\nGenerated: ${thumbnailsGenerated} thumbnails, ${fullSizeConversionsGenerated} full-size conversions\nProcessed in this batch: ${images.length}; overall progress: ${this.cacheRunProgress().completed}/${this.cacheRunProgress().total}\n${errorSummary}\nTotal time: ${Math.round(performance.now() - buildStartedAt)} ms`;
      await this.cacheManager.appendBuildLog(summary);
      this.cacheRunCurrentOperation.set(summary);
    } catch (error) {
      console.error('Failed to start folder cache generation', error);
      const summary = `Cache build failed\n${error instanceof Error ? error.message : String(error)}${verificationSummary ? `\n${verificationSummary}` : ''}\nGenerated: ${thumbnailsGenerated} thumbnails, ${fullSizeConversionsGenerated} full-size conversions\nTotal time: ${Math.round(performance.now() - buildStartedAt)} ms`;
      await this.cacheManager.appendBuildLog(summary).catch(() => undefined);
      this.cacheRunCurrentOperation.set(summary);
    } finally {
      this.cacheWorkerOperations.clear();
      if (!alreadyActive) {
        if (this.cacheAbortController?.signal === signal) this.cacheAbortController = null;
        this.cacheRunActive.set(false);
      }
      if (!batchOptions?.suppressRefresh) {
        this.manualRefresh.update(value => value + 1);
        this.cacheUpdated.emit('');
      }
    }
  };



  constructor() {
    try {
      if (typeof localStorage !== 'undefined') {
        const savedWidths = localStorage.getItem('lumascope.thumbnail-list.detail-column-widths');
        if (savedWidths) {
          const parsed: unknown = JSON.parse(savedWidths);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const validWidths: Record<number, number> = {};
            for (const [key, value] of Object.entries(parsed)) {
              const index = Number(key);
              if (Number.isInteger(index) && index >= -1 && index <= 12
                && typeof value === 'number' && Number.isFinite(value)
                && (index === 0 ? value >= -1000 && value <= 3000 : index === -1 ? value >= 44 && value <= 3000 : value >= 40 && value <= 3000)) {
                validWidths[index] = index === -1 ? 44 : value;
              }
            }
            this.detailColumnWidths.set(validWidths);
          }
        }
      }
    } catch (error) {
      console.warn('Could not restore thumbnail-list column widths', error);
    }

    const refreshReverseGeocodingStatus = (): void => {
      void this.cacheManager.getBackgroundReverseGeocodingStatus().then(status => {
        this.reverseGeocodingStatus.set(status);
      }).catch(error => console.error('Failed to retrieve Browse reverse-geocoding status', error));
    };
    refreshReverseGeocodingStatus();
    const unsubscribeReverseGeocoding = this.cacheManager.onBackgroundReverseGeocodingStatusChanged(refreshReverseGeocodingStatus);
    this.destroyRef.onDestroy(unsubscribeReverseGeocoding);

    effect(onCleanup => {
      const folder = this.folderPath();
      const recursive = this.includeFilesRecursive();
      if (!folder) {
        this.unsupportedSuffixCount.set(0);
        this.unsupportedSuffixes.set([]);
        return;
      }
      let active = true;
      const refreshUnsupportedSummary = async (): Promise<void> => {
        try {
          const summary = await this.cacheManager.getGalleryUnsupportedSummary(folder, recursive);
          if (!active || this.folderPath() !== folder || this.includeFilesRecursive() !== recursive) return;
          this.unsupportedSuffixCount.set(summary.count);
          this.unsupportedSuffixes.set(summary.suffixes);
        } catch (error) {
          if (!active || this.folderPath() !== folder) return;
          console.error('Failed to read unsupported-file summary from the cache database', error);
          this.unsupportedSuffixCount.set(0);
          this.unsupportedSuffixes.set([]);
        }
      };
      void refreshUnsupportedSummary();
      const normalize = (value: string): string => value.replace(/[\\/]+/g, '\\\\').replace(/\\+$/, '').toLocaleLowerCase();
      let refreshTimer: ReturnType<typeof setTimeout> | null = null;
      const unsubscribe = this.cacheManager.onGalleryFilesChanged(changedDirectory => {
        const root = normalize(folder);
        const changed = normalize(changedDirectory);
        if (changed !== root && !(recursive && changed.startsWith(root + '\\\\'))) return;
        if (refreshTimer !== null) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
          refreshTimer = null;
          void refreshUnsupportedSummary();
        }, 150);
      });
      onCleanup(() => {
        active = false;
        if (refreshTimer !== null) clearTimeout(refreshTimer);
        unsubscribe();
      });
    });

    effect(() => {
      const selectedPath = this.selectedImagePath();
      const images = this.images() ?? [];
      if (!selectedPath || !images.some(image => image.path === selectedPath)) return;
      afterNextRender(() => {
        if (this.selectedImagePath() !== selectedPath) return;
        const host = this.elementRef.nativeElement as HTMLElement;
        const elements = host.querySelectorAll<HTMLElement>('[data-image-path]');
        const rendered = Array.from(elements).find(element => element.dataset['imagePath'] === selectedPath);
        const isDetails = this.viewMode() === 'details' || this.viewMode() === 'details-no-thumbnails';
        if (isDetails) {
          const viewport = host.closest<HTMLElement>('.wrapper');
          if (!viewport) return;
          const header = viewport.querySelector<HTMLElement>('.detail-native-table thead');
          const headerBottom = header?.getBoundingClientRect().bottom ?? viewport.getBoundingClientRect().top;
          const viewportBottom = viewport.getBoundingClientRect().bottom;
          if (rendered) {
            // scrollIntoView({ block: 'nearest' }) treats the sticky table header
            // as part of the visible area, so a row hidden underneath it is not
            // scrolled. Compare against the header's bottom edge explicitly.
            const rowRect = rendered.getBoundingClientRect();
            if (rowRect.top < headerBottom) {
              viewport.scrollTop -= headerBottom - rowRect.top;
            } else if (rowRect.bottom > viewportBottom) {
              viewport.scrollTop += rowRect.bottom - viewportBottom;
            }
            return;
          }
          // The target may be outside the currently rendered virtual window.
          // Move the scrollport to its sorted row position; the virtual window
          // will then render that row on the next scroll update.
          const index = this.sortedDetailImages().findIndex(image => image.path === selectedPath);
          if (index >= 0) {
            const headerHeight = header?.getBoundingClientRect().height ?? 0;
            viewport.scrollTop = headerHeight + index * this.detailVirtualRowHeight();
          }
          return;
        }
        if (rendered) rendered.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }, { injector: this.injector });
    });

    effect(onCleanup => {
      const folder = this.folderPath();
      const isDetails = this.viewMode() === 'details' || this.viewMode() === 'details-no-thumbnails';
      if (!folder || !isDetails) {
        this.locationDisplayNames.set(new Map());
        return;
      }
      let active = true;
      const refreshLocations = async (): Promise<void> => {
        try {
          const rows = await this.cacheManager.getDirectoryPhotoLocations(folder);
          if (!active || this.folderPath() !== folder) return;
          this.locationDisplayNames.set(new Map(rows
            .filter(row => typeof row.displayName === 'string' && row.displayName.trim().length > 0)
            .map(row => [row.path, row.displayName!])));
        } catch (error) {
          console.error('Failed to read cached gallery location names', error);
        }
      };
      void refreshLocations();
      const unsubscribe = this.cacheManager.onDirectoryPhotoLocationsChanged(changedDirectory => {
        const normalize = (value: string): string => value.replace(/[\\/]+/g, '\\\\').replace(/\\+$/, '').toLocaleLowerCase();
        if (normalize(changedDirectory) === normalize(folder)) void refreshLocations();
      });
      onCleanup(() => { active = false; unsubscribe(); });
    });

    effect(() => {
      const folder = this.folderPath() ?? '';
      const images = this.images() ?? [];
      const refreshToken = this.manualRefresh();
      // GalleryState replaces the array whenever the indexed DB contents change.
      // Comparing array identity avoids sorting/joining 100k paths just to detect a refresh.
      if (folder === this.cacheStatusFolderKey && images === this.cacheStatusImagesRef && refreshToken === this.cacheStatusRefreshToken) return;
      const folderChanged = folder !== this.cacheStatusFolderKey;
      const forceReload = folderChanged || refreshToken !== this.cacheStatusRefreshToken;
      this.cacheStatusFolderKey = folder;
      this.cacheStatusImagesRef = images;
      this.cacheStatusRefreshToken = refreshToken;

      const request = ++this.cacheStatusRequest;
      if (!folder || images.length === 0) {
        this.cacheStatuses.set(new Map());
        this.gpsDateComparisons.set(new Map());
        this.cacheStatusLoading.set(false);
        return;
      }

      const currentPaths = new Set(images.map(image => image.path));
      const currentMetadata = new Map(images.map(image => [
        image.path,
        `${image.size}|${image.modifiedAt ?? image.createdAt}`
      ] as const));
      const changedPaths = new Set(images
        .filter(image => this.cacheStatusImageMetadata.get(image.path) !== currentMetadata.get(image.path))
        .map(image => image.path));
      const updatedStatuses = forceReload ? new Map<string, CacheImageStatus>() : new Map(
        [...this.cacheStatuses()].filter(([path]) => currentPaths.has(path) && !changedPaths.has(path))
      );
      const updatedComparisons = forceReload ? new Map<string, boolean | null>() : new Map(
        [...this.gpsDateComparisons()].filter(([path]) => currentPaths.has(path) && !changedPaths.has(path))
      );
      this.cacheStatusImageMetadata = currentMetadata;
      const isSupported = (image: FileInfo): boolean =>
        supportedFileExtensions.includes(image.ext.toLowerCase().replace('.', ''));
      const missingImages = images.filter(image => isSupported(image)
        && (!updatedStatuses.has(image.path) || changedPaths.has(image.path)));
      for (const image of images) {
        if (!isSupported(image) && !updatedComparisons.has(image.path)) updatedComparisons.set(image.path, null);
      }
      this.cacheStatuses.set(updatedStatuses);
      this.gpsDateComparisons.set(updatedComparisons);
      if (missingImages.length === 0) {
        this.cacheStatusLoading.set(false);
        return;
      }

      this.cacheStatusLoading.set(true);
      const pathRequestVersions = new Map(this.cacheStatusPathRequests);
      void (async (): Promise<void> => {
        for (let offset = 0; offset < missingImages.length; offset += 500) {
          if (request !== this.cacheStatusRequest) return;
          const batch = missingImages.slice(offset, offset + 500);
          const statuses = await this.cacheManager.getImageCacheStatuses(batch.map(image => image.path));
          if (request !== this.cacheStatusRequest) return;
          const batchStatuses = new Map(statuses.map(status => [status.sourceName, status]));
          const nextStatuses = new Map(this.cacheStatuses());
          for (const [sourceName, status] of batchStatuses) {
            const requestVersion = this.cacheStatusPathRequests.get(sourceName) ?? 0;
            const currentStatus = nextStatuses.get(sourceName);
            if (requestVersion > (pathRequestVersions.get(sourceName) ?? 0) && currentStatus) continue;
            nextStatuses.set(sourceName, status);
          }
          this.cacheStatuses.set(nextStatuses);
          const nextComparisons = new Map(this.gpsDateComparisons());
          this.createGpsDateComparisons(batch, batchStatuses).forEach((value, path) => nextComparisons.set(path, value));
          this.gpsDateComparisons.set(nextComparisons);
        }
      })().catch(error => {
        if (request !== this.cacheStatusRequest) return;
        console.error('Failed to retrieve gallery cache statuses', error);
      }).finally(() => {
        if (request === this.cacheStatusRequest) this.cacheStatusLoading.set(false);
      });
    });

    effect(() => {
      const isDate = this.isDateSorted();
      const groups = this.groupedImages();

      if (!isDate || groups.length === 0) {
        this.activeSectionId.set(null);
        this.cleanupObserver();
        return;
      }

      if (!this.activeSectionId() || !groups.some(g => g.months.some(m => m.sectionId === this.activeSectionId()))) {
        this.activeSectionId.set(groups[0]?.months[0]?.sectionId ?? null);
      }

      queueMicrotask(() => {
        this.setupObserver();
      });
    });

    effect(() => {
      const images = this.displayedImages();
      const activePath = this.activeSelectionPath();
      const openedPath = this.selectedImagePath();
      if (images.length === 0) {
        this.activeSelectionPath.set(null);
        return;
      }
      if (activePath && images.some(image => image.path === activePath)) return;
      this.activeSelectionPath.set(
        openedPath && images.some(image => image.path === openedPath) ? openedPath : images[0].path
      );
    });

    this.destroyRef.onDestroy(() => {
      this.cacheStatusRequest++;
      this.cleanupObserver();
    });
  }

  scrollToSection(sectionId: string): void {
    this.activeSectionId.set(sectionId);
    const element = (this.elementRef.nativeElement as HTMLElement).querySelector(`#${sectionId}`);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  private setupObserver(): void {
    this.cleanupObserver();

    if (typeof window === 'undefined' || !('IntersectionObserver' in window)) {
      return;
    }

    const hostElement = this.elementRef.nativeElement as HTMLElement;
    const root = hostElement.closest('.wrapper');

    this.observer = new IntersectionObserver(
      entries => {
        const visibleEntries = entries.filter(e => e.isIntersecting);
        if (visibleEntries.length > 0) {
          visibleEntries.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
          const topVisible = visibleEntries[0];
          const sectionId = topVisible.target.getAttribute('id') ?? topVisible.target.getAttribute('data-section-id');
          if (sectionId) {
            this.activeSectionId.set(sectionId);
          }
        }
      },
      {
        root: root ?? null,
        threshold: [ 0, 0.2, 0.5, 1.0 ],
        rootMargin: '0px 0px -40% 0px'
      }
    );

    const sections = hostElement.querySelectorAll('.month-group');
    sections.forEach(section => {
      this.observer?.observe(section);
    });
  }

  private cleanupObserver(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }
}
