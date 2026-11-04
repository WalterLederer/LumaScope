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
import { CaptionComponent } from '@light-matter/ui';
import { CacheImageStatus, ExifTags, FileInfo, thumbnailDimensions } from 'internal-api';
import { DatePipe } from '@angular/common';
import { ExifService } from '../../../ipc/exif';
import { GalleryViewMode } from '../../../gallery/components/images/images.component.types';
import { distinctUntilChanged, Subscription } from 'rxjs';
import { DevicePixelRatioService } from '../../../system/services/device-pixel-ratio/device-pixel-ratio.service';
import { ThumbnailLoaderService } from '../../../system/services/thumbnail-loader/thumbnail-loader.service';
import { thumbUrl } from '../../../viewer/utils/image-url';
import { imageDynamicRange } from '../../../viewer/utils/image-dynamic-range';

@Component({
  selector: 'app-thumbnail',
  imports: [
    CaptionComponent,
    DatePipe
  ],
  templateUrl: './thumbnail.component.html',
  styleUrl: './thumbnail.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[style.--fit]': 'fit()',
    '[class.view-tiles]': "viewMode() === 'tiles'",
    '[class.view-details]': "viewMode() === 'details'",
    '(mouseenter)': 'hovered.emit(image())',
    '(mouseleave)': 'hovered.emit(null)'
  }
})
export class ThumbnailComponent implements OnDestroy {
  /* DI */
  private readonly devicePixelRatioService = inject(DevicePixelRatioService);

  private readonly thumbnailLoader = inject(ThumbnailLoaderService);

  private readonly elementRef = inject(ElementRef);

  private readonly exif = inject(ExifService);

  /* Inputs/outputs */
  readonly image = input.required<FileInfo>();

  readonly viewMode = input<GalleryViewMode>('thumbnails');

  readonly cacheStatus = input<CacheImageStatus | null>(null);

  readonly gpsCoordinates = computed(() => {
    const status = this.cacheStatus();
    if (status?.latitude === null || status?.latitude === undefined || status.longitude === null || status.longitude === undefined) return '—';
    return `${status.latitude.toFixed(6)}, ${status.longitude.toFixed(6)}`;
  });

  readonly cacheStatusLoading = input(false);

  readonly refreshToken = input(0);

  readonly clicked = output<FileInfo>();

  readonly hovered = output<FileInfo | null>();

  readonly cacheUpdated = output<string>();

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

  readonly imageTags = signal<ExifTags | null>(null);

  readonly imageInfoReady = signal<boolean>(false);

  readonly dynamicRange = computed(() => {
    const tags = this.imageTags();
    const bits = tags?.BitsPerSample ?? tags?.BitDepth ?? tags?.ImagePixelDepth ?? null;
    return imageDynamicRange(this.image().path, tags, bits === null ? null : `${bits}-bit`);
  });

  readonly dynamicRangeLabel = computed(() => this.imageInfoReady() ? this.dynamicRange() : '—');

  readonly imageDimensions = computed(() => {
    const tags = this.imageTags();
    const width = Number(tags?.ImageWidth);
    const height = Number(tags?.ImageHeight);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return '—';
    }

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
      return entry.storageType === 'parallel' ? 'Parallel folder' : 'Sidecar cache';
    }
    return entry?.status === 'stale' ? 'Invalid' : 'Missing';
  }

  readonly thumbCacheLabel = computed(() => {
    if (this.cacheStatusLoading()) return 'Checking…';
    const status = this.cacheStatus();
    return status ? this.cacheEntryLabel(status.thumbnail ?? null) : 'Unknown';
  });

  readonly cacheLocationTitle = computed(() => {
    const status = this.cacheStatus();
    return [
      status?.thumbnail ? `Thumbnail: ${status.thumbnail.path}` : 'Thumbnail: no DB entry',
      status?.fullSize ? `Full-size: ${status.fullSize.path}` : status?.fullSizeRequired ? 'Full-size: no DB entry' : 'Full-size: not required'
    ].join('\\n');
  });

  readonly fullSizeConversionLabel = computed(() => {
    if (this.cacheStatusLoading()) return 'Checking…';
    const status = this.cacheStatus();
    if (!status) return 'Unknown';
    if (!status.fullSizeRequired) return 'Not required';
    return this.cacheEntryLabel(status.fullSize ?? null);
  });

  readonly imageFileInfo = computed(() => {
    const dimensions = this.imageDimensions();
    return dimensions === '—'
      ? this.formattedFileSize()
      : `${this.formattedFileSize()} (${dimensions})`;
  });

  private infoRequest = 0;

  protected readonly fit = signal('cover');

  private loaderSubscription: Subscription | null = null;

  private intersectionObserver: IntersectionObserver | null = null;

  /* Constructor */
  constructor() {
    effect(() => {
      const image = this.image();
      if (!this.isVisible() || this.viewMode() === 'thumbnails') return;
      const request = ++this.infoRequest;
      this.imageInfoReady.set(false);
      this.imageTags.set(null);
      void this.exif.read(image.path).then(result => {
        if (request !== this.infoRequest || this.image().path !== image.path) return;
        this.imageTags.set(result.success ? result.data : null);
        this.imageInfoReady.set(true);
      }).catch(() => {
        if (request === this.infoRequest) {
          this.imageTags.set(null);
          this.imageInfoReady.set(true);
        }
      });
    });

    effect(onCleanup => {
      this.hasError.set(false);
      this.isLoading.set(true);
      this.isCaching.set(true);
      this.isCacheStatusReady.set(false);

      if (!this.isVisible()) {
        return;
      }

      let cancelled = false;
      this.loaderSubscription?.unsubscribe();
      onCleanup(() => {
        cancelled = true;
        this.loaderSubscription?.unsubscribe();
      });

      const imageUrl = this.url();

      // Check the actual cache file, not just its database record. Missing or stale
      // entries are generated by the protocol handler and must show "Caching...".
      void (async () => {
        let cached = false;
        try {
          const statusUrl = new URL(imageUrl);
          statusUrl.searchParams.set('status', '1');
          const response = await fetch(statusUrl.toString(), { cache: 'no-store' });
          if (response.ok) {
            const status = await response.json() as { cached?: boolean };
            cached = status.cached === true;
          }
        } catch {
          // If the preflight fails, prefer the truthful conservative state.
          cached = false;
        }

        if (cancelled) return;
        this.isCaching.set(!cached);
        this.isCacheStatusReady.set(true);

        this.loaderSubscription = this.thumbnailLoader
          .add(imageUrl)
          .subscribe({
            next: success => {
              this.hasError.set(!success);
              if (success && this.viewMode() === 'details') {
                this.cacheUpdated.emit(this.image().path);
              }
            },
            complete: () => this.isLoading.set(false)
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
