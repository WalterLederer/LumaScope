import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal
} from '@angular/core';
import { TextComponent, TitleComponent } from '@light-matter/ui';
import { CacheImageStatus, ExifTags } from 'internal-api';
import { ExifService } from '../../../ipc/exif';
import { FileSystem } from '../../../ipc/file-system';
import { CacheManager } from '../../../ipc/cache-manager';
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
    '[style.--thumb-width.px]': 'dimensions().width',
    '[style.--thumb-height.px]': 'dimensions().height',
    '[style.--detail-thumb-width.px]': 'detailThumbnailWidth()',
    '[style.--detail-thumb-height.px]': 'detailThumbnailHeight()'
  }
})
export class ImagesComponent {
  private readonly elementRef = inject(ElementRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly exif = inject(ExifService);
  private readonly fileSystem = inject(FileSystem);
  private readonly cacheManager = inject(CacheManager);
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
    this.cacheRunCurrentOperation.set([...this.cacheWorkerOperations.values()].at(-1) ?? '');
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

  /* Inputs */
  readonly images = input.required<FileInfo[] | null>();
  readonly folderPath = input<string | null>(null);
  readonly sortBy = input<SortType>(allSortTypes[0]);
  readonly thumbSize = input<ThumbnailSize>(defaultThumbnailSize);
  readonly viewMode = input<GalleryViewMode>('thumbnails');
  readonly sortDirection = input<'asc' | 'desc'>('desc');

  private readonly readStoredDetailSortColumn = (): 'name' | 'date' | 'dimensions' | 'size' | 'suffix' | 'hdr' | 'thumb' | 'cacheStatus' | 'cacheLocation' | 'fullSize' => {
    try {
      const stored = globalThis.localStorage.getItem('light-matter.detailSortColumn');
      return stored === 'name' || stored === 'date' || stored === 'dimensions' || stored === 'size' || stored === 'suffix' || stored === 'hdr' || stored === 'thumb' || stored === 'fullSize' ? stored : stored === 'cacheStatus' || stored === 'cacheLocation' ? 'thumb' : 'date';
    } catch { return 'date'; }
  };

  private readonly readStoredDetailSortDirection = (): 'asc' | 'desc' => {
    try {
      const stored = globalThis.localStorage.getItem('light-matter.detailSortDirection');
      return stored === 'asc' || stored === 'desc' ? stored : this.sortDirection();
    } catch { return this.sortDirection(); }
  };

  readonly detailSortColumn = signal<'name' | 'date' | 'dimensions' | 'size' | 'suffix' | 'hdr' | 'thumb' | 'cacheStatus' | 'cacheLocation' | 'fullSize'>(this.readStoredDetailSortColumn());
  readonly detailSortDirection = signal<'asc' | 'desc'>(this.readStoredDetailSortDirection());

  readonly sortedDetailImages = computed(() => {
    const images = [...(this.images() ?? [])];
    const column = this.detailSortColumn();
    const direction = this.detailSortDirection() === 'asc' ? 1 : -1;
    const metadata = this.metadata();

    const compareText = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    const dimensions = (path: string) => {
      const tags = metadata.get(path);
      const width = Number(tags?.ImageWidth) || 0;
      const height = Number(tags?.ImageHeight) || 0;
      return { width, height };
    };
    const hdr = (path: string) => {
      const tags = metadata.get(path) ?? null;
      const bits = tags?.BitsPerSample ?? tags?.BitDepth ?? tags?.ImagePixelDepth ?? null;
      return imageDynamicRange(path, tags, bits === null ? null : String(bits));
    };

    images.sort((a, b) => {
      let result = 0;
      switch (column) {
        case 'name':
          result = compareText(a.name, b.name);
          break;
        case 'date':
          result = (a.modifiedAt ?? a.createdAt) - (b.modifiedAt ?? b.createdAt);
          break;
        case 'size':
          result = a.size - b.size;
          break;
        case 'dimensions': {
          const left = dimensions(a.path);
          const right = dimensions(b.path);
          result = left.width - right.width || left.height - right.height;
          break;
        }
        case 'suffix':
          result = compareText(this.getSuffix(a.name), this.getSuffix(b.name));
          break;
        case 'hdr':
          result = compareText(hdr(a.path), hdr(b.path));
          break;
        case 'cacheStatus': {
          const rank = (status: CacheImageStatus | undefined) => status?.thumbnail?.status === 'valid' ? 0 : status?.thumbnail?.status === 'stale' ? 1 : 2;
          result = rank(this.cacheStatuses().get(a.path)) - rank(this.cacheStatuses().get(b.path));
          break;
        }
        case 'cacheLocation': {
          const location = (status: CacheImageStatus | undefined) => status?.thumbnail?.storageType ?? '';
          result = compareText(location(this.cacheStatuses().get(a.path)), location(this.cacheStatuses().get(b.path)));
          break;
        }
        case 'fullSize': {
          const rank = (status: CacheImageStatus | undefined) => !status?.fullSizeRequired ? 0 : status.fullSize?.status === 'valid' ? 1 : status.fullSize?.status === 'stale' ? 2 : 3;
          result = rank(this.cacheStatuses().get(a.path)) - rank(this.cacheStatuses().get(b.path));
          break;
        }
      }
      return result * direction || compareText(a.name, b.name);
    });
    return images;
  });

  /* Computed */
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
    return groupImagesByYearAndMonth(this.images());
  });

  /* Signals */
  readonly activeSectionId = signal<string | null>(null);

  /* Outputs */
  readonly selected = output<FileInfo>();

  readonly hovered = output<FileInfo | null>();

  readonly cacheUpdated = output<string>();
  readonly cacheAllImages = async (): Promise<void> => {
    if (this.cacheRunActive()) return;
    const controller = new AbortController();
    this.cacheAbortController = controller;
    this.cacheRunActive.set(true);
    await this.runCacheForImages(this.images() ?? [], true, controller.signal);
    if (this.cacheAbortController === controller) this.cacheAbortController = null;
    this.cacheRunActive.set(false);
  };

  readonly cancelCacheRun = (): void => {
    this.cacheAbortController?.abort();
  };

  readonly cacheAllImagesRecursive = async (): Promise<void> => {
    if (this.cacheRunActive()) return;
    const rootPath = this.folderPath() ?? this.images()?.[0]?.parent ?? null;
    if (!rootPath) return;

    const controller = new AbortController();
    this.cacheAbortController = controller;
    this.cacheRunActive.set(true);
    try {
      const allImages: FileInfo[] = [...(this.images() ?? [])];
      const visitedDirectories = new Set<string>([rootPath]);
      const pendingDirectories = [rootPath];

      while (pendingDirectories.length > 0 && !controller.signal.aborted) {
        const directory = pendingDirectories.shift()!;
        this.cacheRunCurrentOperation.set(`Enumerating subfolders in ${directory}`);
        const directoriesResult = await this.fileSystem.readDirectories(directory);
        if (controller.signal.aborted) break;
        if (!directoriesResult.success) {
          console.warn('Failed to enumerate gallery subfolders', directory, directoriesResult.errorMessage);
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
          else console.warn('Failed to read images in gallery subfolder', child.path, imagesResult.errorMessage);
        }
      }

      if (!controller.signal.aborted) {
        const uniqueImages = [...new Map(allImages.map(image => [image.path, image])).values()];
        await this.runCacheForImages(uniqueImages, true, controller.signal);
      }
    } catch (error) {
      console.error('Failed to enumerate recursive gallery cache workload', error);
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
    this.cacheRunCurrentOperation.set('Preparing cache status for files...');
    const buildStartedAt = performance.now();
    let verificationSummary = '';
    let thumbnailsGenerated = 0;
    let fullSizeConversionsGenerated = 0;
    try {
      await this.cacheManager.resetBuildLog();
      await this.cacheManager.appendBuildLog('Cache build started: ' + new Date().toISOString());
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
                if (!thumbnailResponse.ok) throw new Error(`Thumbnail generation failed for ${image.path}`);
                thumbnailsGenerated++;
                await thumbnailResponse.body?.cancel();
              }
              if (!signal?.aborted && status?.fullSizeRequired && !fullSizeValid) {
                this.setCacheWorkerOperation(workerId, `Full-Size conversion for file ${image.path}`);
                await appendLog(`[${index + 1}/${images.length}] FULL-SIZE: ${image.path}`);
                const fullSizeResponse = await fetch(imageUrl(image.path), { cache: 'no-store', signal });
                if (!fullSizeResponse.ok) throw new Error(`Full-size conversion failed for ${image.path}`);
                fullSizeConversionsGenerated++;
                await fullSizeResponse.body?.cancel();
              }
            }
          } catch (error) {
            if (!signal?.aborted) {
              console.error('Failed to cache gallery image', image.path, error);
              await appendLog(`[${index + 1}/${images.length}] ERROR: ${image.path} :: ${error instanceof Error ? error.message : String(error)}`);
            }
          } finally {
            this.setCacheWorkerOperation(workerId, null);
            this.cacheRunProgress.update(progress => ({ ...progress, completed: progress.completed + 1 }));
          }
        }
      };
      await Promise.all([worker(0), worker(1)]);
      if (logBuffer.length > 0) {
        const chunk = logBuffer.splice(0).join('\n');
        logWrite = logWrite.then(() => this.cacheManager.appendBuildLog(chunk));
      }
      await logWrite;
      const summary = `Cache build ${signal?.aborted ? 'cancelled' : 'completed'}\n${verificationSummary}\nGenerated: ${thumbnailsGenerated} thumbnails, ${fullSizeConversionsGenerated} full-size conversions\nProcessed: ${this.cacheRunProgress().completed}/${images.length}\nTotal time: ${Math.round(performance.now() - buildStartedAt)} ms`;
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


  async sortDetailsBy(column: 'name' | 'date' | 'dimensions' | 'size' | 'suffix' | 'hdr' | 'thumb' | 'cacheStatus' | 'cacheLocation' | 'fullSize'): Promise<void> {
    if (this.detailSortColumn() === column) {
      this.detailSortDirection.update(direction => direction === 'asc' ? 'desc' : 'asc');
    } else {
      this.detailSortColumn.set(column);
      this.detailSortDirection.set(column === 'name' ? 'asc' : 'desc');
    }

    try {
      globalThis.localStorage.setItem('light-matter.detailSortColumn', this.detailSortColumn());
      globalThis.localStorage.setItem('light-matter.detailSortDirection', this.detailSortDirection());
    } catch { /* Keep the selected detail sort for the current session. */ }

    if (column !== 'dimensions' && column !== 'hdr') return;

    const images = this.images() ?? [];
    const request = ++this.metadataRequest;
    const missing = images.filter(image => !this.metadata().has(image.path));
    const results = await Promise.all(missing.map(async image => {
      try {
        const result = await this.exif.read(image.path);
        return result.success ? [image.path, result.data] as const : null;
      } catch {
        return null;
      }
    }));

    if (request !== this.metadataRequest) return;
    this.metadata.update(current => {
      const next = new Map(current);
      for (const result of results) {
        if (result) next.set(result[0], result[1]);
      }
      return next;
    });
  }

  private getSuffix(name: string): string {
    const fileName = name.split(/[\\/]/).pop() ?? name;
    const dotIndex = fileName.lastIndexOf('.');
    return dotIndex > 0 && dotIndex < fileName.length - 1
      ? fileName.slice(dotIndex + 1).toLocaleLowerCase()
      : '';
  }

  readonly refreshCacheStatus = (sourceName: string): void => {
    if ((this.viewMode() !== 'details' && this.viewMode() !== 'details-no-thumbnails') || !(this.images() ?? []).some(image => image.path === sourceName)) return;
    const request = (this.cacheStatusPathRequests.get(sourceName) ?? 0) + 1;
    this.cacheStatusPathRequests.set(sourceName, request);
    void this.cacheManager.getImageCacheStatuses([sourceName]).then(([status]) => {
      if (this.cacheStatusPathRequests.get(sourceName) !== request || !status) return;
      this.cacheStatuses.update(current => new Map(current).set(sourceName, status));
    }).catch(error => {
      console.error('Failed to refresh thumbnail cache status', error);
    });
  };

  sortIndicator(column: 'name' | 'date' | 'dimensions' | 'size' | 'suffix' | 'hdr' | 'thumb' | 'cacheStatus' | 'cacheLocation' | 'fullSize'): string {
    if (this.detailSortColumn() !== column) return '';
    return this.detailSortDirection() === 'asc' ? ' ▲' : ' ▼';
  }

  constructor() {
    effect(() => {
      const images = this.images() ?? [];
      this.thumbnailRefreshToken();
      const request = ++this.cacheStatusRequest;
      if ((this.viewMode() !== 'details' && this.viewMode() !== 'details-no-thumbnails') || images.length === 0) {
        this.cacheStatuses.set(new Map());
        this.cacheStatusLoading.set(false);
      } else {
        this.cacheStatusLoading.set(true);
        const pathRequestVersions = new Map(this.cacheStatusPathRequests);
        void this.cacheManager.getImageCacheStatuses(images.map(image => image.path)).then(statuses => {
          if (request !== this.cacheStatusRequest) return;
          this.cacheStatuses.update(current => {
            const updated = new Map(statuses.map(status => [status.sourceName, status]));
            for (const [sourceName, requestVersion] of this.cacheStatusPathRequests) {
              if (requestVersion > (pathRequestVersions.get(sourceName) ?? 0) && current.has(sourceName)) {
                const currentStatus = current.get(sourceName);
                if (currentStatus) updated.set(sourceName, currentStatus);
              }
            }
            return updated;
          });
        }).catch(error => {
          if (request !== this.cacheStatusRequest) return;
          console.error('Failed to retrieve gallery cache statuses', error);
          this.cacheStatuses.set(new Map());
        }).finally(() => {
          if (request === this.cacheStatusRequest) this.cacheStatusLoading.set(false);
        });
      }
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
