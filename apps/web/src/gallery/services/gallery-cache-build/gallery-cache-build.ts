import { computed, inject, Injectable, Signal, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';

interface CacheBuildProgress {
  completed: number;
  total: number;
}

interface GalleryCacheBuildController {
  readonly cacheRunActive: Signal<boolean>;
  readonly cacheRunProgress: Signal<CacheBuildProgress>;
  readonly cacheRunCurrentOperation: Signal<string>;
  readonly start: (directory: string) => void;
  readonly startRecursive: (directory: string) => void;
  readonly cancel: () => void;
  readonly refreshDetailCacheStatus: () => void;
}

@Injectable({ providedIn: 'root' })
export class GalleryCacheBuild {
  private readonly document = inject(DOCUMENT);
  private readonly controller = signal<GalleryCacheBuildController | null>(null);

  private readonly readVerifyCacheFiles = (): boolean => {
    try { return this.document.defaultView?.localStorage.getItem('verifyCacheFiles') === 'true'; }
    catch { return false; }
  };

  readonly verifyCacheFiles = signal(this.readVerifyCacheFiles());
  readonly cacheRunActive = computed(() => this.controller()?.cacheRunActive() ?? false);
  readonly cacheRunProgress = computed(() => this.controller()?.cacheRunProgress() ?? { completed: 0, total: 0 });
  readonly cacheRunCurrentOperation = computed(() => this.controller()?.cacheRunCurrentOperation() ?? '');

  readonly setVerifyCacheFiles = (enabled: boolean): void => {
    this.verifyCacheFiles.set(enabled);
    try { this.document.defaultView?.localStorage.setItem('verifyCacheFiles', String(enabled)); }
    catch { /* Keep the session setting. */ }
  };

  readonly startCacheBuild = (directory: string): void => this.controller()?.start(directory);
  readonly startRecursiveCacheBuild = (directory: string): void => this.controller()?.startRecursive(directory);
  readonly cancelCacheBuild = (): void => this.controller()?.cancel();
  readonly refreshDetailCacheStatus = (): void => this.controller()?.refreshDetailCacheStatus();

  readonly register = (controller: GalleryCacheBuildController): (() => void) => {
    this.controller.set(controller);
    return () => {
      if (this.controller() === controller) this.controller.set(null);
    };
  };
}
