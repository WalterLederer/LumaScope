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
import { TextComponent, TitleComponent } from '@light-matter/ui';
import { toSignal } from '@angular/core/rxjs-interop';
import { BackgroundReverseGeocodingStatus, CacheDirectoryStats, CacheImageStatus, ExifTags, supportedFileExtensions, formatOsDateTime } from 'internal-api';
import { ExifService } from '../../../ipc/exif';
import { FileSystem } from '../../../ipc/file-system';
import { CacheManager } from '../../../ipc/cache-manager';
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

type DetailSortColumn = 'name' | 'date' | 'gpsDate' | 'dimensions' | 'size' | 'suffix' | 'hdr' | 'thumb' | 'fullSize' | 'gps' | 'location';

type DetailTableColorKey = 'date' | 'gpsDate' | 'dimensions' | 'size' | 'selectedRow' | 'oddRow' | 'evenRow';
interface DetailTablePreferences {
  date: string;
  gpsDate: string;
  dimensions: string;
  size: string;
  selectedRow: string;
  oddRow: string;
  evenRow: string;
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
    TimelineIndicatorsComponent,
    TextComponent
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
    '[style.--detail-date-progress-color]': 'detailPreferenceValues().date',
    '[style.--detail-gps-date-progress-color]': 'detailPreferenceValues().gpsDate',
    '[style.--detail-dimensions-progress-color]': 'detailPreferenceValues().dimensions',
    '[style.--detail-size-progress-color]': 'detailPreferenceValues().size',
    '[style.--detail-selected-row-color]': 'detailPreferenceValues().selectedRow',
    '[style.--detail-odd-row-color]': 'detailPreferenceValues().oddRow',
    '[style.--detail-even-row-color]': 'detailPreferenceValues().evenRow',
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
  private readonly exif = inject(ExifService);
  private readonly fileSystem = inject(FileSystem);
  private readonly cacheManager = inject(CacheManager);
  private readonly galleryCacheBuild = inject(GalleryCacheBuild);
  private readonly configuration = inject(Configuration);
  readonly appConfig = toSignal(this.configuration.config(), { initialValue: null });
  readonly detailPreferenceDraft = signal<DetailTablePreferences>({ ...defaultDetailTablePreferences });
  readonly detailPreferencesOpen = signal(false);
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
    if (folder) {
      try {
        const result = await this.fileSystem.readImages(folder, this.sortBy(), this.sortDirection());
        if (!result.success) throw new Error(result.errorMessage || `Could not read folder: ${folder}`);
        if (this.folderPath() !== folder) return;
        await this.cacheManager.reconcilePhotoRecords(folder, result.data.map(image => image.path), false);
      } catch (error) {
        console.error('Failed to reconcile Browse photo database before refreshing thumbnails', folder, error);
      }
    }
    this.manualRefresh.update(value => value + 1);
    if (folder && this.folderPath() === folder) this.folderRefreshRequested.emit(folder);
    this.cacheUpdated.emit('');
  };
  private observer: IntersectionObserver | null = null;
  private metadataRequest = 0;
  private readonly metadata = signal<Map<string, ExifTags>>(new Map());
  readonly locationDisplayNames = signal<Map<string, string>>(new Map());
  readonly reverseGeocodingStatus = signal<BackgroundReverseGeocodingStatus>({
    total: 0, resolved: 0, pending: 0, inProgress: 0, errors: 0,
    status: 'idle', paused: false, currentFilePath: null, currentDisplayName: null
  });

  /* Inputs */
  readonly images = input.required<FileInfo[] | null>();
  readonly selectedImagePath = input<string | null>(null);
  readonly activeSelectionPath = signal<string | null>(null);
  readonly cacheStats = input<CacheDirectoryStats>({ total: 0, thumbnails: 0, fullSizeConversions: 0, gps: 0, hdr: 0, location: 0, thumbnailPaths: [], fullSizePaths: [] });
  readonly folderPath = input<string | null>(null);
  readonly sortBy = input<SortType>(allSortTypes[0]);
  readonly thumbSize = input<ThumbnailSize>(defaultThumbnailSize);
  readonly viewMode = input<GalleryViewMode>('thumbnails');
  readonly sortDirection = input<'asc' | 'desc'>('desc');

  // Detail headers expose the current gallery sort initially, then own sorting after a header is clicked.
  readonly detailSortColumn = signal<DetailSortColumn | null>(null);
  readonly detailSortDirection = signal<'asc' | 'desc'>('asc');
  readonly activeDetailSortColumn = computed<DetailSortColumn>(() => this.detailSortColumn() ?? this.sortBy());
  readonly activeDetailSortDirection = computed<'asc' | 'desc'>(() =>
    this.detailSortColumn() === null ? this.sortDirection() : this.detailSortDirection()
  );
  readonly sortedDetailImages = computed(() => {
    const images = [...(this.images() ?? [])];
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
  private cacheStatusImageKey = '';

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


  protected openDetailPreferences(): void {
    this.folderActionsMenuOpen.set(false);
    this.detailPreferenceDraft.set({ ...this.detailPreferenceValues() });
    this.detailPreferencesOpen.set(true);
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
      galleryDetailAlternateRowColors: preferences.alternateRows,
      galleryDetailDateProgressEnabled: preferences.dateProgressEnabled,
      galleryDetailGpsDateProgressEnabled: preferences.gpsDateProgressEnabled,
      galleryDetailDimensionsProgressEnabled: preferences.dimensionsProgressEnabled,
      galleryDetailSizeProgressEnabled: preferences.sizeProgressEnabled,
      galleryDetailProgressTransparency: preferences.progressTransparency
    });
    this.detailPreferencesOpen.set(false);
  }


  readonly folderActionsMenuOpen = signal(false);
  readonly folderActionsMenuPosition = signal({ top: 8, left: 8 });

  protected toggleFolderActionsMenu(event: MouseEvent): void {
    event.stopPropagation();
    if (this.folderActionsMenuOpen()) {
      this.folderActionsMenuOpen.set(false);
      return;
    }

    const pointer = { top: event.clientY, left: event.clientX };
    this.folderActionsMenuPosition.set(pointer);
    this.folderActionsMenuOpen.set(true);
    requestAnimationFrame(() => {
      if (!this.folderActionsMenuOpen()) return;
      const menu = (this.elementRef.nativeElement as HTMLElement).querySelector<HTMLElement>('.folder-actions-menu');
      if (!menu) return;
      const rect = menu.getBoundingClientRect();
      this.folderActionsMenuPosition.set({
        top: Math.max(8, Math.min(pointer.top, window.innerHeight - rect.height - 8)),
        left: Math.max(8, Math.min(pointer.left, window.innerWidth - rect.width - 8))
      });
    });
  }

  private readonly closeFolderActionsMenuOnPointerDown = (event: PointerEvent): void => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('.folder-actions-menu, .folder-actions-menu-trigger')) return;
    this.folderActionsMenuOpen.set(false);
  };

  protected requestOpenFolderPath(): void {
    this.folderActionsMenuOpen.set(false);
    this.openFolderPathRequested.emit();
  }

  protected requestCopyFolderPath(): void {
    this.folderActionsMenuOpen.set(false);
    this.copyFolderPathRequested.emit();
  }

  protected requestCacheDisplayedFiles(): void {
    this.folderActionsMenuOpen.set(false);
    void this.cacheDisplayedFiles();
  }

  protected requestReCacheDisplayedFiles(): void {
    this.folderActionsMenuOpen.set(false);
    this.reCacheDisplayedFiles();
  }

  protected requestRefreshFolder(): void {
    this.folderActionsMenuOpen.set(false);
    void this.refreshGallery();
  }

  protected autofitDetailColumns(): void {
    this.folderActionsMenuOpen.set(false);
    const table = (this.elementRef.nativeElement as HTMLElement).querySelector<HTMLTableElement>('table.detail-native-table');
    if (!table) return;

    const widths: Record<number, number> = { 0: 0 };
    for (let column = 1; column <= 11; column++) {
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
    if (!table || columnIndex < 0 || columnIndex > 11) return;

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
    const cell = handle.closest('th') as HTMLElement | null;
    const table = handle.closest('table.detail-native-table') as HTMLTableElement | null;
    if (!table || !cell) return;

    const startX = event.clientX;
    const startWidth = cell.getBoundingClientRect().width;
    const minimumWidth = columnIndex === 0 ? 24 : columnIndex >= 10 ? 80 : 40;
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
        const elements = (this.elementRef.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('[data-image-path]');
        Array.from(elements).find(element => element.dataset['imagePath'] === next.path)
          ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
      let images = this.images() ?? [];
      let reconciledRecords = 0;
      const gpxFiles: string[] = [];
      const folder = directory?.trim() || this.folderPath();
      if (folder) {
        this.cacheRunCurrentOperation.set(`Reading images in ${folder}`);
        const result = await this.fileSystem.readImages(folder, this.sortBy(), this.sortDirection());
        if (!result.success) throw new Error(result.errorMessage || `Could not read folder: ${folder}`);
        images = result.data;
        if (importGpx) {
          try {
            const entries = await this.fileSystem.readDir(folder);
            gpxFiles.push(...entries.filter(entry => !entry.isDirectory && entry.ext.toLowerCase() === '.gpx').map(entry => entry.path));
          } catch (error) {
            await this.cacheManager.appendBuildLog(`GPX enumeration skipped for ${folder}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (this.verifyCacheFiles() && !controller.signal.aborted) {
          this.cacheRunCurrentOperation.set(`Removing stale photo database records in ${folder}`);
          reconciledRecords = await this.cacheManager.reconcilePhotoRecords(folder, images.map(image => image.path), false);
        }
      }
      await this.runCacheForImages(images, true, controller.signal);
      if (folder && this.verifyCacheFiles() && !controller.signal.aborted) {
        await this.cacheManager.appendBuildLog(`Photo database reconciliation: removed ${reconciledRecords} stale records in ${folder}`);
      }
      await this.importGpxFilesFoundDuringCacheBuild(gpxFiles, controller.signal, importGpx);
    } catch (error) {
      this.cacheRunCurrentOperation.set(`Cache build failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (this.cacheAbortController === controller) this.cacheAbortController = null;
      this.cacheRunActive.set(false);
      this.cacheUpdated.emit('');
    }
  };

  readonly cancelCacheRun = (): void => {
    this.cacheAbortController?.abort();
  };

  readonly cacheDisplayedFiles = async (): Promise<void> => {
    const images = this.displayedImages();
    if (this.galleryCacheBuild.cacheRunActive() || this.cacheRunActive() || images.length === 0) return;
    const controller = new AbortController();
    this.cacheAbortController = controller;
    this.cacheRunActive.set(true);
    this.cacheRunProgress.set({ completed: 0, total: images.length });
    const releaseActivity = this.galleryCacheBuild.trackActivity({
      active: this.cacheRunActive,
      progress: this.cacheRunProgress,
      currentOperation: this.cacheRunCurrentOperation,
      cancel: this.cancelCacheRun
    });
    try {
      await this.runCacheForImages(images, true, controller.signal);
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
    void this.reCacheImages(this.displayedImages());
  };

  private readonly reCacheImages = async (images: FileInfo[]): Promise<void> => {
    if (this.galleryCacheBuild.cacheRunActive() || this.cacheRunActive() || images.length === 0) return;
    const controller = new AbortController();
    this.cacheAbortController = controller;
    this.cacheRunActive.set(true);
    this.cacheRunProgress.set({ completed: 0, total: images.length });
    this.cacheRunCurrentOperation.set('Removing existing cache entries...');
    const releaseActivity = this.galleryCacheBuild.trackActivity({
      active: this.cacheRunActive,
      progress: this.cacheRunProgress,
      currentOperation: this.cacheRunCurrentOperation,
      cancel: this.cancelCacheRun
    });
    try {
      for (let index = 0; index < images.length; index++) {
        if (controller.signal.aborted) break;
        const image = images[index];
        this.cacheRunCurrentOperation.set(`Removing cache entries for file ${index + 1} / ${images.length}: ${image.name}`);
        await this.cacheManager.deleteImage(image.path);
        this.cacheRunProgress.set({ completed: index + 1, total: images.length });
      }
      if (!controller.signal.aborted) {
        await this.runCacheForImages(images, true, controller.signal);
      } else {
        this.cacheRunCurrentOperation.set('Cache rebuild cancelled while removing existing entries.');
      }
    } catch (error) {
      this.cacheRunCurrentOperation.set(`Cache rebuild failed: ${error instanceof Error ? error.message : String(error)}`);
      console.error('Failed to remove existing gallery cache entries', error);
    } finally {
      if (this.cacheAbortController === controller) this.cacheAbortController = null;
      this.cacheRunActive.set(false);
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
    try {
      const rootImages = await this.fileSystem.readImages(rootPath, this.sortBy(), this.sortDirection());
      if (!rootImages.success) throw new Error(rootImages.errorMessage || `Could not read folder: ${rootPath}`);
      const allImages: FileInfo[] = [...rootImages.data];
      const gpxFiles: string[] = [];
      const visitedDirectories = new Set<string>([rootPath]);
      const pendingDirectories = [rootPath];
      let enumerationComplete = true;

      while (pendingDirectories.length > 0 && !controller.signal.aborted) {
        const directory = pendingDirectories.shift()!;
        this.cacheRunCurrentOperation.set(`Enumerating files and subfolders in ${directory}`);
        let entries: FileInfo[];
        try {
          // This is the folder enumeration used by the recursive build: collect
          // GPX files and child folders from the same directory listing.
          entries = await this.fileSystem.readDir(directory);
        } catch (error) {
          console.warn('Failed to enumerate gallery folder', directory, error);
          enumerationComplete = false;
          continue;
        }
        if (importGpx) {
          gpxFiles.push(...entries.filter(entry => !entry.isDirectory && entry.ext.toLowerCase() === '.gpx').map(entry => entry.path));
        }
        if (controller.signal.aborted) break;
        const childDirectories = entries.filter(entry => entry.isDirectory && !['.cache', '.thumbnails'].includes(entry.name.toLowerCase()));

        for (const child of childDirectories) {
          if (!visitedDirectories.has(child.path)) {
            visitedDirectories.add(child.path);
            pendingDirectories.push(child.path);
          }
        }

        for (const child of childDirectories) {
          if (controller.signal.aborted) break;
          const imagesResult = await this.fileSystem.readImages(child.path, this.sortBy(), this.sortDirection());
          if (controller.signal.aborted) break;
          if (imagesResult.success) allImages.push(...imagesResult.data);
          else {
            console.warn('Failed to read images in gallery subfolder', child.path, imagesResult.errorMessage);
            enumerationComplete = false;
          }
        }
      }

      if (!controller.signal.aborted) {
        const uniqueImages = [...new Map(allImages.map(image => [image.path, image])).values()];
        let reconciledRecords: number | null = null;
        if (this.verifyCacheFiles() && enumerationComplete) {
          this.cacheRunCurrentOperation.set(`Removing stale photo database records under ${rootPath}`);
          reconciledRecords = await this.cacheManager.reconcilePhotoRecords(rootPath, uniqueImages.map(image => image.path), true);
        } else if (this.verifyCacheFiles() && !enumerationComplete) {
          await this.cacheManager.appendBuildLog('Recursive photo database reconciliation skipped because one or more folders could not be fully enumerated.');
        }
        await this.runCacheForImages(uniqueImages, true, controller.signal);
        if (reconciledRecords !== null && !controller.signal.aborted) {
          await this.cacheManager.appendBuildLog(`Recursive photo database reconciliation: removed ${reconciledRecords} stale records under ${rootPath}`);
        }
        await this.importGpxFilesFoundDuringCacheBuild(gpxFiles, controller.signal, importGpx);
      }
    } catch (error) {
      console.error('Failed to enumerate recursive gallery cache workload', error);
      this.cacheRunCurrentOperation.set(`Cache build failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (this.cacheAbortController === controller) this.cacheAbortController = null;
      if (controller.signal.aborted && !this.cacheRunCurrentOperation().startsWith('Cache build ')) {
        this.cacheRunCurrentOperation.set('Cache build cancelled during folder enumeration.');
      }
      this.cacheRunActive.set(false);
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

  private readonly runCacheForImages = async (images: FileInfo[], alreadyActive = false, signal?: AbortSignal): Promise<void> => {
    if (images.length === 0) {
      this.cacheRunCurrentOperation.set('No images found to cache.');
      return;
    }
    if (this.cacheRunActive() && !alreadyActive) return;

    if (!alreadyActive) this.cacheRunActive.set(true);
    this.cacheRunProgress.set({ completed: 0, total: images.length });
    this.cacheWorkerOperations.clear();
    this.cacheRunCurrentOperation.set('Preparing cache status for files...');
    const buildStartedAt = performance.now();
    let verificationSummary = '';
    let thumbnailsGenerated = 0;
    let fullSizeConversionsGenerated = 0;
    try {
      await this.cacheManager.resetBuildLog();
      await this.cacheManager.appendBuildLog('Cache build started: ' + formatOsDateTime(new Date()));
      await this.cacheManager.appendBuildLog('Verify cache files: ' + (this.verifyCacheFiles() ? 'enabled' : 'disabled'));
      const statusPreparationStartedAt = performance.now();
      const statuses: CacheImageStatus[] = [];
      const imagePaths = images.map(image => image.path);
      const sourceMetadata = images.map(image => ({ path: image.path, size: image.size, modifiedAt: image.modifiedAt ?? image.createdAt }));
      for (let offset = 0; offset < imagePaths.length; offset += 10000) {
        statuses.push(...await this.cacheManager.getImageCacheStatuses(
          imagePaths.slice(offset, offset + 10000),
          this.verifyCacheFiles(),
          sourceMetadata.slice(offset, offset + 10000)
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
      const summary = `Cache build ${signal?.aborted ? 'cancelled' : 'completed'}\n${verificationSummary}\nGenerated: ${thumbnailsGenerated} thumbnails, ${fullSizeConversionsGenerated} full-size conversions\nProcessed: ${this.cacheRunProgress().completed}/${images.length}\n${errorSummary}\nTotal time: ${Math.round(performance.now() - buildStartedAt)} ms`;
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
      this.cacheUpdated.emit('');
    }
  };



  constructor() {
    // Close the header menu before another list hamburger handles its pointer event.
    document.addEventListener('pointerdown', this.closeFolderActionsMenuOnPointerDown, true);
    this.destroyRef.onDestroy(() => {
      document.removeEventListener('pointerdown', this.closeFolderActionsMenuOnPointerDown, true);
    });

    try {
      if (typeof localStorage !== 'undefined') {
        const savedWidths = localStorage.getItem('lumascope.thumbnail-list.detail-column-widths');
        if (savedWidths) {
          const parsed: unknown = JSON.parse(savedWidths);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const validWidths: Record<number, number> = {};
            for (const [key, value] of Object.entries(parsed)) {
              const index = Number(key);
              if (Number.isInteger(index) && index >= 0 && index <= 11
                && typeof value === 'number' && Number.isFinite(value)
                && (index === 0 ? value >= -1000 && value <= 3000 : value >= 40 && value <= 3000)) {
                validWidths[index] = value;
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
      if (!folder) {
        this.unsupportedSuffixCount.set(0);
        this.unsupportedSuffixes.set([]);
        return;
      }
      let active = true;
      void this.fileSystem.readDir(folder).then(entries => {
        if (!active || this.folderPath() !== folder) return;
        const normalizeExtension = (extension: string): string => {
          const normalized = extension.trim().toLowerCase();
          return normalized.startsWith('.') ? normalized.slice(1) : normalized;
        };
        const unsupported = entries.filter(entry =>
          !entry.isDirectory && !supportedFileExtensions.includes(normalizeExtension(entry.ext))
        );
        this.unsupportedSuffixCount.set(unsupported.length);
        this.unsupportedSuffixes.set([...new Set(unsupported.map(entry =>
          normalizeExtension(entry.ext) || '(no extension)'
        ))].sort((a, b) => a.localeCompare(b)));
      }).catch(error => {
        if (!active || this.folderPath() !== folder) return;
        console.error('Failed to count unsupported image suffixes', error);
        this.unsupportedSuffixCount.set(0);
        this.unsupportedSuffixes.set([]);
      });
      onCleanup(() => { active = false; });
    });

    effect(() => {
      const selectedPath = this.selectedImagePath();
      const images = this.images() ?? [];
      if (!selectedPath || !images.some(image => image.path === selectedPath)) return;
      afterNextRender(() => {
        if (this.selectedImagePath() !== selectedPath) return;
        const elements = (this.elementRef.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('[data-image-path]');
        const selected = Array.from(elements).find(element => element.dataset['imagePath'] === selectedPath);
        selected?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }, { injector: this.injector });
    });

    effect(() => {
      const images = this.images() ?? [];
      const isDetails = this.viewMode() === 'details' || this.viewMode() === 'details-no-thumbnails';
      if (!isDetails || images.length === 0) return;
      const request = ++this.metadataRequest;
      const missing = images.filter(image => !this.metadata().has(image.path));
      if (missing.length === 0) return;
      void Promise.all(missing.map(async image => {
        try {
          const result = await this.exif.read(image.path);
          return result.success ? [image.path, result.data] as const : null;
        } catch {
          return null;
        }
      })).then(results => {
        if (request !== this.metadataRequest) return;
        this.metadata.update(current => {
          const next = new Map(current);
          for (const result of results) if (result) next.set(result[0], result[1]);
          return next;
        });
      });
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
      const imagePaths = images.map(image => image.path).sort((a, b) => a.localeCompare(b));
      const imageKey = imagePaths.join('\\0');

      // Ignore view-mode changes and list reordering. Refresh only for a new
      // folder or a changed set of files (for example, after deleting files).
      if (folder === this.cacheStatusFolderKey && imageKey === this.cacheStatusImageKey) return;
      this.cacheStatusFolderKey = folder;
      this.cacheStatusImageKey = imageKey;

      const request = ++this.cacheStatusRequest;
      if (!folder || images.length === 0) {
        this.cacheStatuses.set(new Map());
        this.gpsDateComparisons.set(new Map());
        this.cacheStatusLoading.set(false);
        return;
      }

      this.cacheStatuses.set(new Map());
      this.gpsDateComparisons.set(new Map());
      this.cacheStatusLoading.set(true);
      const pathRequestVersions = new Map(this.cacheStatusPathRequests);
      void this.cacheManager.getImageCacheStatuses(images.map(image => image.path)).then(statuses => {
        if (request !== this.cacheStatusRequest) return;
        const updated = new Map(statuses.map(status => [status.sourceName, status]));
        for (const [sourceName, requestVersion] of this.cacheStatusPathRequests) {
          if (requestVersion > (pathRequestVersions.get(sourceName) ?? 0) && updated.has(sourceName)) {
            const currentStatus = this.cacheStatuses().get(sourceName);
            if (currentStatus) updated.set(sourceName, currentStatus);
          }
        }
        this.cacheStatuses.set(updated);
        this.gpsDateComparisons.set(this.createGpsDateComparisons(images, updated));
      }).catch(error => {
        if (request !== this.cacheStatusRequest) return;
        console.error('Failed to retrieve gallery cache statuses', error);
        this.cacheStatuses.set(new Map());
        this.gpsDateComparisons.set(new Map());
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
