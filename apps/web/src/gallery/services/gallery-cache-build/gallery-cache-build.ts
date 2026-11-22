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
  readonly directory: string;
  readonly cancel: () => void;
}

interface GalleryCacheBuildController {
  readonly cacheRunActive: Signal<boolean>;
  readonly cacheRunProgress: Signal<CacheBuildProgress>;
  readonly cacheRunCurrentOperation: Signal<string>;
  readonly start: (directory: string, importGpx: boolean) => Promise<void>;
  readonly startRecursive: (directory: string, importGpx: boolean) => Promise<void>;
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
  private readonly pendingStarts: Array<{ directory: string; importGpx: boolean; recursive: boolean }> = [];
  private readonly activeDirectory = signal<string | null>(null);
  readonly cacheRunDirectory = computed(() =>
    this.activeDirectory() ?? this.activity()?.directory ?? this.queuedRequest()?.directory ?? null
  );
  private readonly queuedRequest = signal<{ directory: string; recursive: boolean } | null>(null);

  private readonly normalizeDirectory = (directory: string): string =>
    directory.replace(/[\\/]+/g, '\\\\').replace(/\\+$/, '').toLocaleLowerCase();

  private readonly executeBuild = async (
    controller: GalleryCacheBuildController,
    request: { directory: string; importGpx: boolean; recursive: boolean }
  ): Promise<void> => {
    this.activeDirectory.set(request.directory);
    try {
      if (request.recursive) await controller.startRecursive(request.directory, request.importGpx);
      else await controller.start(request.directory, request.importGpx);
    } finally {
      if (this.activeDirectory() === request.directory) this.activeDirectory.set(null);
    }
  };

  private readonly readVerifyCacheFiles = (): boolean => {
    try { return this.document.defaultView?.localStorage.getItem('verifyCacheFiles') === 'true'; }
    catch { return false; }
  };

  readonly verifyCacheFiles = signal(this.readVerifyCacheFiles());
  readonly cacheRunActive = computed(() => {
    const activity = this.activity();
    return (activity?.active() ?? this.controller()?.cacheRunActive() ?? false) || this.queuedRequest() !== null;
  });
  readonly cacheRunProgress = computed(() => {
    const activity = this.activity();
    return activity?.active() ? activity.progress() : this.controller()?.cacheRunProgress() ?? { completed: 0, total: 0 };
  });
  readonly cacheRunCurrentOperation = computed(() => {
    const activity = this.activity();
    if (activity?.active()) return activity.currentOperation();
    const queued = this.queuedRequest();
    if (queued) return `Preparing database scan for ${queued.directory}…`;
    return this.controller()?.cacheRunCurrentOperation() ?? '';
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
      if (!current || current.cacheRunActive() || this.activity()?.active()) return;

      const pending = this.pendingController();
      if (pending) {
        this.controller.set(pending);
        this.pendingController.set(null);
        this.retiredController.set(false);
      } else if (this.retiredController() && this.pendingStarts.length === 0) {
        this.controller.set(null);
        this.retiredController.set(false);
      }

      const ready = this.controller();
      if (!ready || ready.cacheRunActive() || this.activity()?.active() || this.pendingStarts.length === 0) return;
      const next = this.pendingStarts.shift()!;
      this.queuedRequest.set(this.pendingStarts[0] ? { directory: this.pendingStarts[0].directory, recursive: this.pendingStarts[0].recursive } : null);
      void this.executeBuild(ready, next).catch(error =>
        console.error('Queued favorite-folder cache build failed', next.directory, error)
      );
    });
  }

  readonly setVerifyCacheFiles = (enabled: boolean): void => {
    this.verifyCacheFiles.set(enabled);
    try { this.document.defaultView?.localStorage.setItem('verifyCacheFiles', String(enabled)); }
    catch { /* Keep the session setting. */ }
  };

  private readonly queueCacheBuild = async (directory: string, importGpx: boolean, recursive: boolean): Promise<void> => {
    const controller = this.controller();
    const normalizedDirectory = this.normalizeDirectory(directory);
    if (this.activeDirectory() && this.normalizeDirectory(this.activeDirectory()!) === normalizedDirectory) return;
    if (this.pendingStarts.some(item => this.normalizeDirectory(item.directory) === normalizedDirectory)) return;

    // Startup can restore a folder before ImageGrid has mounted and registered
    // its controller. Queue the request instead of silently losing the build.
    if (!controller || this.cacheRunActive()) {
      this.pendingStarts.push({ directory, importGpx, recursive });
      if (!this.queuedRequest()) this.queuedRequest.set({ directory, recursive });
      return;
    }

    await this.executeBuild(controller, { directory, importGpx, recursive });
  };

  readonly startCacheBuild = async (directory: string, importGpx = true): Promise<void> =>
    this.queueCacheBuild(directory, importGpx, false);

  readonly startRecursiveCacheBuild = async (directory: string, importGpx: boolean): Promise<void> =>
    this.queueCacheBuild(directory, importGpx, true);
  readonly cancelCacheBuild = (): void => {
    this.pendingStarts.length = 0;
    this.queuedRequest.set(null);
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
