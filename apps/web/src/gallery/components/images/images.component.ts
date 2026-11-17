import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { CacheDirectoryStats, FileInfo, SortType, defaultThumbnailSize, allSortTypes, ThumbnailSize } from 'internal-api';
import { GalleryViewMode } from './images.component.types';

@Component({
  selector: 'app-images',
  templateUrl: './images.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ImagesComponent {
  readonly images = input.required<FileInfo[] | null>();
  readonly cacheStats = input<CacheDirectoryStats>({ total: 0, thumbnails: 0, fullSizeConversions: 0, gps: 0, hdr: 0, location: 0, thumbnailPaths: [], fullSizePaths: [] });
  readonly folderPath = input<string | null>(null);
  readonly sortBy = input<SortType>(allSortTypes[0]);
  readonly thumbSize = input<ThumbnailSize>(defaultThumbnailSize);
  readonly viewMode = input<GalleryViewMode>('thumbnails');
  readonly sortDirection = input<'asc' | 'desc'>('desc');
  readonly verifyCacheFiles = input(false);
  readonly selected = output<FileInfo>();
  readonly hovered = output<FileInfo | null>();
  readonly cacheUpdated = output<string>();

  // Keep the public API expected by ImageGridComponent while the component
  // implementation is intentionally minimized for startup isolation.
  readonly cacheRunActive = signal(false);
  readonly cacheRunProgress = signal({ completed: 0, total: 0 });
  readonly cacheRunCurrentOperation = signal('');

  readonly cancelCacheRun = (): void => {};

  readonly refreshGallery = (): void => {};

  readonly cacheAllImages = async (_directory?: string): Promise<void> => {};

  readonly cacheAllImagesRecursive = async (_directory?: string): Promise<void> => {};

  constructor() {
    console.warn('[Images] MINIMAL COMPONENT CONSTRUCTOR COMPLETE');
  }
}
