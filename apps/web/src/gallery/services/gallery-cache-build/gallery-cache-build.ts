import { computed, effect, inject, Injectable, Signal, signal, untracked } from '@angular/core';
import { DOCUMENT } from '@angular/common';

interface CacheBuildProgress {
  completed: number;
  total: number;
}

interface GalleryCacheBuildActivity {
  readonly active: Signal<boolean>;
  readonly progress: Signal<CacheBuildProgress>;
  readonly currentOperation: Signal<string>;
  readonly cancel: () => void;
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
  private readonly pendingController = signal<GalleryCacheBuildController | null>(null);
  private readonly retiredController = signal(false);
  private readonly activity = signal<GalleryCacheBuildActivity | null>(null);

  private readonly readVerifyCacheFiles = (): boolean => {
    try { return this.document.defaultView?.localStorage.getItem('verifyCacheFiles') === 'true'; }
    catch { return false; }
  };

  readonly verifyCacheFiles = signal(this.readVerifyCacheFiles());
  readonly cacheRunActive = computed(() => {
    const activity = this.activity();
    return activity?.active() ?? this.controller()?.cacheRunActive() ?? false;
  });
  readonly cacheRunProgress = computed(() => {
    const activity = this.activity();
    return activity?.active() ? activity.progress() : this.controller()?.cacheRunProgress() ?? { completed: 0, total: 0 };
  });
  readonly cacheRunCurrentOperation = computed(() => {
    const activity = this.activity();
    return activity?.active() ? activity.currentOperation() : this.controller()?.cacheRunCurrentOperation() ?? '';
  });
  readonly cacheRunErrorCount = computed(() => {
    const output = this.cacheRunCurrentOperation();
    const summary = output.match(/Failed files:\s*(\d+)/i);
    if (summary) return Number(summary[1]);
    return (output.match(/\] ERROR:/g) ?? []).length;
  });

  constructor() {
    // A cache build can outlive the Gallery component that started it. Keep
    // that controller as the source of progress/cancellation until it finishes,
    // then hand control to the currently mounted Gallery instance.
    effect(() => {
      const current = this.controller();
      if (!current || current.cacheRunActive()) return;

      const pending = this.pendingController();
      if (pending) {
        this.controller.set(pending);
        this.pendingController.set(null);
        this.retiredController.set(false);
      } else if (this.retiredController()) {
        this.controller.set(null);
        this.retiredController.set(false);
      }
    });
  }

  readonly setVerifyCacheFiles = (enabled: boolean): void => {
    this.verifyCacheFiles.set(enabled);
    try { this.document.defaultView?.localStorage.setItem('verifyCacheFiles', String(enabled)); }
    catch { /* Keep the session setting. */ }
  };

  readonly startCacheBuild = (directory: string): void => this.controller()?.start(directory);
  readonly startRecursiveCacheBuild = (directory: string): void => this.controller()?.startRecursive(directory);
  readonly cancelCacheBuild = (): void => {
    const activity = this.activity();
    if (activity?.active()) activity.cancel();
    else this.controller()?.cancel();
  };

  /** Expose cache work started by detail-list actions in the shared Cache tab. */
  readonly trackActivity = (activity: GalleryCacheBuildActivity): (() => void) => {
    this.activity.set(activity);
    return () => {
      if (this.activity() === activity) this.activity.set(null);
    };
  };
  readonly refreshDetailCacheStatus = (): void => this.controller()?.refreshDetailCacheStatus();

  readonly register = (controller: GalleryCacheBuildController): (() => void) => untracked(() => {
    const current = this.controller();
    if (current && current !== controller && current.cacheRunActive()) {
      // Do not replace an active build with a newly mounted, idle ImageGrid.
      this.pendingController.set(controller);
    } else {
      this.controller.set(controller);
      this.pendingController.set(null);
      this.retiredController.set(false);
    }

    // Registration is an imperative operation. Its internal signal reads must
    // not become dependencies of the calling component's registration effect.
    return () => untracked(() => {
      if (this.pendingController() === controller) {
        this.pendingController.set(null);
      }
      if (this.controller() !== controller) return;

      if (controller.cacheRunActive()) {
        // The asynchronous build still owns its signals and cancel callback.
        // Retain them until the run completes, even after its view is destroyed.
        this.retiredController.set(true);
      } else {
        const pending = this.pendingController();
        this.controller.set(pending);
        this.pendingController.set(null);
        this.retiredController.set(false);
      }
    });
  });
}
