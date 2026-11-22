import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  OnDestroy,
  output,
  signal
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { CdkMenu, CdkMenuItem, CdkMenuTrigger } from '@angular/cdk/menu';
import { CaptionComponent, ButtonTooltipDirective} from '@light-matter/ui';
import { CacheImageStatus, ExifTags, FileInfo, thumbnailDimensions, formatGpsCoordinates, formatOsDateTime as formatSystemDateTime } from 'internal-api';
import { ExifService } from '../../../ipc/exif';
import { FileSystem } from '../../../ipc/file-system';
import { ProcessManager } from '../../../ipc/process-manager';
import { ImageFileActions } from '../../../viewer/services/view-navigator/image-file-actions';
import { GalleryViewMode } from '../../../gallery/components/images/images.component.types';
import { distinctUntilChanged, Subscription } from 'rxjs';
import { DevicePixelRatioService } from '../../../system/services/device-pixel-ratio/device-pixel-ratio.service';
import { ThumbnailLoaderService } from '../../../system/services/thumbnail-loader/thumbnail-loader.service';
import { thumbUrl } from '../../../viewer/utils/image-url';
import { imageDynamicRange } from '../../../viewer/utils/image-dynamic-range';

const supportedThumbnailExtensions = new Set([
  'avif', 'bmp', 'gif', 'heic', 'heif', 'jpe', 'jpeg', 'jpg',
  'jxl', 'jxr', 'exr', 'ohsp', 'png', 'raw', 'dng', 'rw2',
  'hdr', 'svg', 'tif', 'tiff', 'webp'
]);

@Component({
  selector: 'app-thumbnail, tr[app-thumbnail]',
  imports: [
    CaptionComponent,
    ButtonTooltipDirective,
    CdkMenu,
    CdkMenuItem,
    CdkMenuTrigger
  ],
  templateUrl: './thumbnail.component.html',
  styleUrl: './thumbnail.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[style.--fit]': 'fit()',
    '[class.view-tiles]': "viewMode() === 'tiles'",
    '[class.view-details]': "viewMode() === 'details'",
    '[class.view-details-no-thumbnails]': "viewMode() === 'details-no-thumbnails'",
    '(mouseenter)': 'hovered.emit(image())',
    '(mouseleave)': 'hovered.emit(null)',
    '(click)': 'rowSelected.emit(image())'
  }
})
export class ThumbnailComponent implements OnDestroy {
  private static startupConstructionCount = 0;
  private static readonly fileTypeIconCache = new Map<string, Promise<string | null>>();

  /* DI */
  private readonly devicePixelRatioService = inject(DevicePixelRatioService);

  private readonly thumbnailLoader = inject(ThumbnailLoaderService);

  private readonly elementRef = inject(ElementRef);

  private readonly exif = inject(ExifService);

  private readonly fileSystem = inject(FileSystem);

  private readonly processManager = inject(ProcessManager);

  private readonly imageFileActions = inject(ImageFileActions);

  /* Inputs/outputs */
  readonly image = input.required<FileInfo>();
  readonly rowNumber = input<number | null>(null);
  readonly detailProgress = input<{ date: number | null; gpsDate: number | null; dimensions: number | null; size: number | null } | null>(null);
  readonly metadataLoaded = output<ExifTags>();


  readonly formatOsDateTime = (value: number | Date | null | undefined): string => {
    if (value === null || value === undefined || !Number.isFinite(value instanceof Date ? value.getTime() : value)) return '—';
    return formatSystemDateTime(value);
  };

  readonly formatDetailDateTime = (value: number | Date | null | undefined): string => {
    if (value === null || value === undefined || !Number.isFinite(value instanceof Date ? value.getTime() : value)) return '—';
    return formatSystemDateTime(value, '—', 'compact');
  };

  readonly viewMode = input<GalleryViewMode>('thumbnails');
  readonly actionsColumnPosition = input<'left' | 'right'>('left');

  readonly cacheStatus = input<CacheImageStatus | null>(null);

  readonly locationDisplayName = input<string | null>(null);
  readonly detailPath = input<string>('');

  readonly gpsDateLabel = computed(() => {
    const timestamp = this.cacheStatus()?.gpsTimestamp;
    if (timestamp === null || timestamp === undefined || !Number.isFinite(timestamp)) return '—';
    const modifiedAt = this.image().modifiedAt;
    if (typeof modifiedAt === 'number' && Number.isFinite(modifiedAt)
      && Math.floor(timestamp) === Math.floor(modifiedAt / 1000)) return '=';
    return this.formatDetailDateTime(timestamp * 1000);
  });

  readonly gpsCoordinates = computed(() => {
    const status = this.cacheStatus();
    if (status?.latitude === null || status?.latitude === undefined || status.longitude === null || status.longitude === undefined) return '—';
    return formatGpsCoordinates(status.latitude, status.longitude);
  });

  readonly cacheStatusLoading = input(false);

  readonly refreshToken = input(0);

  readonly clicked = output<FileInfo>();

  readonly rowSelected = output<FileInfo>();

  readonly hovered = output<FileInfo | null>();

  readonly cacheUpdated = output<string>();

  readonly cacheFolderRequested = output<void>();

  readonly reCacheFileRequested = output<FileInfo>();

  readonly reCacheFolderRequested = output<void>();

  readonly requestCacheFolder = (): void => {
    this.cacheFolderRequested.emit();
  };

  readonly requestReCacheFile = (): void => {
    const image = this.image();
    this.reCacheFileRequested.emit(image);
  };

  readonly requestReCacheFolder = (): void => {
    this.reCacheFolderRequested.emit();
  };

  readonly copyImagePath = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(this.image().path);
    } catch (error) {
      console.error('Could not copy image path:', error);
    }
  };

  readonly openImagePath = async (): Promise<void> => {
    const folder = await this.fileSystem.dirname(this.image().path);
    const error = await this.processManager.openPath(folder);
    if (error) window.alert(error);
  };

  readonly openImageFile = async (): Promise<void> => {
    const error = await this.processManager.openPath(this.image().path);
    if (error) window.alert(error);
  };

  readonly exportHex = async (): Promise<void> => {
    const result = await this.fileSystem.exportHex(this.image().path);
    if (!result.success) window.alert(result.errorMessage ?? 'HEX export failed.');
  };

  readonly deleteImageFile = async (): Promise<void> => {
    const deleted = await this.imageFileActions.confirmAndDelete(this.image().path);
    if (deleted === false) window.alert('The image could not be deleted.');
  };

  /* State */
  private readonly pixelRatio = toSignal(
    this.devicePixelRatioService
      .pixelRatio()
      .pipe(distinctUntilChanged())
  );

  readonly url = computed(() => {
    const image = this.image();
    const pixelRatio = this.pixelRatio() || 1;
    const maxPreview = thumbnailDimensions.large;
    return thumbUrl(image.path, maxPreview.width / pixelRatio, maxPreview.height / pixelRatio, this.refreshToken());
  });

  readonly isLoading = signal<boolean>(true);

  readonly isCaching = signal<boolean>(true);

  readonly isCacheStatusReady = signal<boolean>(false);

  readonly isVisible = signal<boolean>(false);

  readonly hasError = signal<boolean>(false);

  readonly thumbnailError = signal<string | null>(null);

  readonly imageTags = signal<ExifTags | null>(null);

  readonly imageInfoReady = signal<boolean>(false);

  readonly dynamicRange = computed(() => {
    const tags = this.imageTags();
    const bits = tags?.BitsPerSample ?? tags?.BitDepth ?? tags?.ImagePixelDepth ?? null;
    return imageDynamicRange(this.image().path, tags, bits === null ? null : `${bits}-bit`);
  });

  readonly imageInfoError = signal<string | null>(null);

  readonly dynamicRangeLabel = computed(() => {
    if (!this.imageInfoReady()) return 'Checking…';
    return this.imageInfoError() ? 'Error' : this.dynamicRange();
  });

  readonly imageDimensions = computed(() => {
    if (!this.imageInfoReady()) return 'Checking…';
    if (this.imageInfoError()) return 'Error';
    const tags = this.imageTags();
    const width = Number(tags?.ImageWidth);
    const height = Number(tags?.ImageHeight);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return '—';
    const bitsPerSample = String((tags as unknown as Record<string, unknown> | null)?.['BitsPerSample'] ?? '')
      .split(/[,\s/]+/)
      .map(value => Number.parseInt(value, 10))
      .find(value => Number.isFinite(value) && value > 0);
    const dimensions = `${Math.trunc(width)} × ${Math.trunc(height)}`;
    return bitsPerSample ? `${dimensions} × ${bitsPerSample}` : dimensions;
  });

  readonly imageSuffix = computed(() => {
    const name = this.image().name.split(/[\\/]/).pop() ?? this.image().name;
    const dotIndex = name.lastIndexOf('.');
    return dotIndex > 0 && dotIndex < name.length - 1
      ? name.slice(dotIndex + 1).toLocaleLowerCase()
      : '—';
  });

  readonly isSupportedThumbnail = computed(() => supportedThumbnailExtensions.has(this.imageSuffix()));

  readonly fileTypeIcon = signal<string | null>(null);

  private readonly loadFileTypeIcon = effect(() => {
    const file = this.image();
    if (this.isSupportedThumbnail()) {
      this.fileTypeIcon.set(null);
      return;
    }
    const key = this.imageSuffix() || '(no-extension)';
    let request = ThumbnailComponent.fileTypeIconCache.get(key);
    if (!request) {
      request = this.processManager.getFileTypeIcon(file.path).catch(() => null);
      ThumbnailComponent.fileTypeIconCache.set(key, request);
    }
    void request.then(icon => {
      if (this.image().path === file.path) this.fileTypeIcon.set(icon);
    });
  });

  readonly formattedFileSize = computed(() => {
    const bytes = Math.max(0, Number(this.image().size) || 0);
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex++;
    }

    return `${value.toLocaleString('de-AT', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${units[unitIndex]}`;
  });

  private cacheEntryLabel(entry: CacheImageStatus['thumbnail']): string {
    if (entry?.status === 'valid') {
      return '✓';
    }
    return entry?.status === 'stale' ? 'Invalid' : 'Missing';
  }

  readonly thumbCacheLabel = computed(() => {
    if (this.cacheStatusLoading()) return 'Checking…';
    const status = this.cacheStatus();
    if (!status) return 'Unknown';
    return this.image().path.toLowerCase().endsWith('.ohsp')
      ? this.cacheEntryLabel(status.fullSize ?? null)
      : this.cacheEntryLabel(status.thumbnail ?? null);
  });

  readonly cacheLocationTitle = computed(() => {
    const status = this.cacheStatus();
    return [
      this.image().path.toLowerCase().endsWith('.ohsp')
        ? 'Thumbnail: uses the full-size OHSP image'
        : status?.thumbnail ? `Thumbnail: ${status.thumbnail.path}` : 'Thumbnail: no DB entry',
      status?.fullSize ? `Full-size: ${status.fullSize.path}` : status?.fullSizeRequired ? 'Full-size: no DB entry' : 'Full-size: not required'
    ].join('\\n');
  });

  readonly fullSizeConversionLabel = computed(() => {
    if (this.cacheStatusLoading()) return 'Checking…';
    const status = this.cacheStatus();
    if (!status) return 'Unknown';
    if (!status.fullSizeRequired) return '-';
    return this.cacheEntryLabel(status.fullSize ?? null);
  });

  readonly imageFileInfo = computed(() => {
    const dimensions = this.imageDimensions();
    return dimensions === '—'
      ? this.formattedFileSize()
      : `${this.formattedFileSize()} (${dimensions})`;
  });

  private infoRequest = 0;

  // Preserve the complete source image in thumbnail and tile previews.
  protected readonly fit = signal('contain');

  private loaderSubscription: Subscription | null = null;

  private intersectionObserver: IntersectionObserver | null = null;

  private readonly withTimeout = <T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${operation} timed out after ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
      promise.then(
        value => { clearTimeout(timer); resolve(value); },
        error => { clearTimeout(timer); reject(error); }
      );
    });

  /* Constructor */
  constructor() {
    const startupCount = ++ThumbnailComponent.startupConstructionCount;
    if (startupCount === 1 || startupCount % 50 === 0) {
      console.warn('[Thumbnail] CONSTRUCTOR PROGRESS', { count: startupCount });
    }
    effect(() => {
      const image = this.image();
      this.refreshToken();
      if (!this.isVisible() || this.viewMode() === 'thumbnails') return;
      const request = ++this.infoRequest;
      this.imageInfoReady.set(false);
      this.imageInfoError.set(null);
      this.imageTags.set(null);
      void (async () => {
        try {
          const result = await this.withTimeout(this.exif.read(image.path), 15000, 'EXIF metadata check');
          if (request !== this.infoRequest || this.image().path !== image.path) return;
          if (!result.success) {
            this.imageTags.set(null);
            this.imageInfoError.set(result.errorMessage || 'ExifTool returned no metadata.');
          } else {
            this.imageTags.set(result.data);
            if (this.viewMode() === 'details' || this.viewMode() === 'details-no-thumbnails') {
              this.metadataLoaded.emit(result.data);
            }
          }
        } catch (error) {
          if (request !== this.infoRequest || this.image().path !== image.path) return;
          this.imageTags.set(null);
          this.imageInfoError.set(error instanceof Error ? error.message : String(error));
        } finally {
          if (request === this.infoRequest && this.image().path === image.path) this.imageInfoReady.set(true);
        }
      })();
    });

    effect(onCleanup => {
      this.hasError.set(false);
      this.thumbnailError.set(null);
      this.isLoading.set(true);
      this.isCaching.set(true);
      this.isCacheStatusReady.set(false);
      if (!this.isSupportedThumbnail()) {
        this.isCaching.set(false);
        this.isCacheStatusReady.set(true);
        this.isLoading.set(false);
        return;
      }
      if (!this.isVisible()) return;

      let cancelled = false;
      let preflightTimer: ReturnType<typeof setTimeout> | null = null;
      let loadTimer: ReturnType<typeof setTimeout> | null = null;
      const controller = new AbortController();
      this.loaderSubscription?.unsubscribe();
      onCleanup(() => {
        cancelled = true;
        if (preflightTimer) clearTimeout(preflightTimer);
        if (loadTimer) clearTimeout(loadTimer);
        controller.abort();
        this.loaderSubscription?.unsubscribe();
      });

      const imageUrl = this.url();
      void (async () => {
        let cached = false;
        try {
          const statusUrl = new URL(imageUrl);
          statusUrl.searchParams.set('status', '1');
          preflightTimer = setTimeout(() => controller.abort(), 8000);
          const response = await fetch(statusUrl.toString(), { cache: 'no-store', signal: controller.signal });
          if (!response.ok) throw new Error(`Cache check failed: HTTP ${response.status} ${response.statusText}`.trim());
          const status = await response.json() as { cached?: boolean };
          cached = status.cached === true;
        } catch (error) {
          if (!cancelled) {
            this.thumbnailError.set(error instanceof Error && error.name === 'AbortError'
              ? 'Thumbnail cache check timed out after 8 seconds.'
              : `Thumbnail cache check failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        } finally {
          if (preflightTimer) clearTimeout(preflightTimer);
        }
        if (cancelled) return;

        this.isCaching.set(!cached);
        this.isCacheStatusReady.set(true);
        this.loaderSubscription = this.thumbnailLoader.add(imageUrl, () => {
          // Queue wait time is not image-loading time; start the timeout only
          // when one of the loader's four concurrent slots is actually available.
          loadTimer = setTimeout(() => {
            if (cancelled || !this.isLoading()) return;
            this.thumbnailError.set('Thumbnail image loading timed out after 120 seconds.');
            this.hasError.set(true);
            this.isLoading.set(false);
            this.loaderSubscription?.unsubscribe();
          }, 120000);
        }).subscribe({
          next: success => {
            this.hasError.set(!success);
            if (!success) this.thumbnailError.set('Thumbnail image request failed (image load error).');
            if (success) this.cacheUpdated.emit(this.image().path);
          },
          complete: () => {
            if (loadTimer) clearTimeout(loadTimer);
            this.isLoading.set(false);
          }
        });
      })();
    });

    this.intersectionObserver = new IntersectionObserver(entries => {
      if (entries.length === 0 || entries[0].intersectionRatio <= 0) {
        return;
      }

      this.intersectionObserver?.disconnect();
      this.isVisible.set(true);
    });

    this.intersectionObserver.observe(this.elementRef.nativeElement);
  }

  ngOnDestroy() {
    this.infoRequest++;
    this.intersectionObserver?.disconnect();
    this.loaderSubscription?.unsubscribe();
  }
}
