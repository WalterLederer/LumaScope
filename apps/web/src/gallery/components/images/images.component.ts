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
import { BackgroundReverseGeocodingStatus, CacheDirectoryStats, CacheImageStatus, ExifTags, supportedFileExtensions, formatOsDateTime } from 'internal-api';
import { ExifService } from '../../../ipc/exif';
import { FileSystem } from '../../../ipc/file-system';
import { CacheManager } from '../../../ipc/cache-manager';
import { GalleryCacheBuild } from '../../services/gallery-cache-build/gallery-cache-build';
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
    '[style.--detail-thumb-height.px]': 'detailThumbnailHeight()'
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
  private cacheStatusRequest = 0;
  private cacheAbortController: AbortController | null = null;
  private readonly cacheStatusPathRequests = new Map<string, number>();
  readonly cacheStatuses = signal<Map<string, CacheImageStatus>>(new Map());
  readonly cacheStatusLoading = signal(false);
  readonly cacheRunActive = signal(false);
  readonly cacheRunProgress = signal({ completed: 0, total: 0 });
  readonly cacheRunCurrentOperation = signal('');
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
  readonly refreshGallery = (): void => {
    this.manualRefresh.update(value => value + 1);
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
    this.activeDetailSortColumn() !== column ? '' : this.activeDetailSortDirection() === 'asc' ? '▲' : '▼';

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

  readonly detailSummary = computed(() => {
    const images = this.images() ?? [];
    const dates = images.map(image => image.modifiedAt).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    const gpsDates = images.map(image => this.cacheStatuses().get(image.path)?.gpsTimestamp).filter((value): value is number => Number.isFinite(value));
    const sizes = images.map(image => image.size).filter(value => Number.isFinite(value));
    const dimensionValues = images.map(image => {
      const tags = this.metadata().get(image.path);
      const width = Number(tags?.ImageWidth) || 0;
      const height = Number(tags?.ImageHeight) || 0;
      return { width, height, area: width * height };
    }).filter(value => value.width > 0 && value.height > 0);

    const minDate = dates.length ? formatOsDateTime(dates.reduce((min, value) => Math.min(min, value), Infinity)) : '—';
    const maxDate = dates.length ? formatOsDateTime(dates.reduce((max, value) => Math.max(max, value), -Infinity)) : '—';
    const formatSize = (bytes: number) => {
      if (bytes < 1024) return `${bytes} B`;
      const units = ['KB', 'MB', 'GB', 'TB'];
      let value = bytes / 1024;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
      return `${value.toFixed(1)} ${units[unit]}`;
    };
    const minSize = sizes.length ? formatSize(sizes.reduce((min, value) => Math.min(min, value), Infinity)) : '—';
    const maxSize = sizes.length ? formatSize(sizes.reduce((max, value) => Math.max(max, value), -Infinity)) : '—';
    const minDimensions = dimensionValues.length
      ? dimensionValues.reduce((min, value) => value.area < min.area ? value : min)
      : null;
    const maxDimensions = dimensionValues.length
      ? dimensionValues.reduce((max, value) => value.area > max.area ? value : max)
      : null;
    return {
      date: [minDate, maxDate],
      gpsDate: gpsDates.length
        ? [formatOsDateTime(gpsDates.reduce((min, value) => Math.min(min, value), Infinity) * 1000), formatOsDateTime(gpsDates.reduce((max, value) => Math.max(max, value), -Infinity) * 1000)]
        : ['—', '—'],
      size: [minSize, maxSize],
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

  protected startColumnResize(event: PointerEvent, columnIndex: number): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget as HTMLElement;
    const header = handle.closest('.detail-header') as HTMLElement | null;
    const table = header?.closest('.detail-table') as HTMLElement | null;
    const cell = header?.children.item(columnIndex) as HTMLElement | null;
    if (!table || !cell) return;
    const startX = event.clientX;
    const startWidth = cell.getBoundingClientRect().width;
    const minimumWidth = columnIndex === 0 ? 84 : columnIndex >= 10 ? 80 : 40;
    const pointerId = event.pointerId;
    handle.setPointerCapture(pointerId);
    const onMove = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== pointerId) return;
      const width = Math.max(minimumWidth, Math.round(startWidth + moveEvent.clientX - startX));
      table.style.setProperty("--detail-col-" + columnIndex + "-width", width + "px");
    };
    const cleanup = (): void => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
    };
    const onUp = (upEvent: PointerEvent): void => {
      if (upEvent.pointerId !== pointerId) return;
      cleanup();
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
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
  readonly cacheAllImages = async (directory?: string): Promise<void> => {
    if (this.cacheRunActive()) return;
    const controller = new AbortController();
    this.cacheAbortController = controller;
    this.cacheRunActive.set(true);
    this.cacheRunProgress.set({ completed: 0, total: 0 });
    try {
      let images = this.images() ?? [];
      let reconciledRecords = 0;
      const folder = directory?.trim() || this.folderPath();
      if (folder) {
        this.cacheRunCurrentOperation.set(`Reading images in ${folder}`);
        const result = await this.fileSystem.readImages(folder, this.sortBy(), this.sortDirection());
        if (!result.success) throw new Error(result.errorMessage || `Could not read folder: ${folder}`);
        images = result.data;
        if (this.verifyCacheFiles() && !controller.signal.aborted) {
          this.cacheRunCurrentOperation.set(`Removing stale photo database records in ${folder}`);
          reconciledRecords = await this.cacheManager.reconcilePhotoRecords(folder, images.map(image => image.path), false);
        }
      }
      await this.runCacheForImages(images, true, controller.signal);
      if (folder && this.verifyCacheFiles() && !controller.signal.aborted) {
        await this.cacheManager.appendBuildLog(`Photo database reconciliation: removed ${reconciledRecords} stale records in ${folder}`);
      }
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

  readonly cacheAllImagesRecursive = async (directory?: string): Promise<void> => {
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
      const visitedDirectories = new Set<string>([rootPath]);
      const pendingDirectories = [rootPath];
      let enumerationComplete = true;

      while (pendingDirectories.length > 0 && !controller.signal.aborted) {
        const directory = pendingDirectories.shift()!;
        this.cacheRunCurrentOperation.set(`Enumerating subfolders in ${directory}`);
        const directoriesResult = await this.fileSystem.readDirectories(directory);
        if (controller.signal.aborted) break;
        if (!directoriesResult.success) {
          console.warn('Failed to enumerate gallery subfolders', directory, directoriesResult.errorMessage);
          enumerationComplete = false;
          continue;
        }

        for (const child of directoriesResult.data) {
          if (!visitedDirectories.has(child.path)) {
            visitedDirectories.add(child.path);
            pendingDirectories.push(child.path);
          }
        }

        for (const child of directoriesResult.data) {
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
                const thumbnailResponse = await fetch(thumbUrl(image.path, 512, 512), { cache: 'no-store', signal });
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
                const fullSizeResponse = await fetch(imageUrl(image.path), { cache: 'no-store', signal });
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
