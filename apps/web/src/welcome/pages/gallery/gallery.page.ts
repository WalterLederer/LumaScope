import { CdkMenu, CdkMenuItem } from '@angular/cdk/menu';
import { Dialog } from '@angular/cdk/dialog';
import { AsyncPipe, DOCUMENT } from '@angular/common';
import { afterNextRender, ChangeDetectionStrategy, Component, HostListener, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import {
  ActionButtonComponent,
  ConfirmationDialogComponent,
  IconComponent,
  OverlayService,
  PopupMenuComponent,
  SidePanelComponent,
  TextComponent,
  ToolbarComponent,
  TreeComponent,
  TreeLoadRequest,
  TreeNode,
  VerticalStackComponent
} from '@light-matter/ui';
import { defaultThumbnailSize, Desktop, FileInfo, SortDirection, SortType, ThumbnailSize } from 'internal-api';
import { combineLatest, filter, map, pairwise, switchMap } from 'rxjs';
import { ImageGridComponent } from '../../../gallery/components/image-grid/image-grid.component';
import { GalleryLocations } from '../../../gallery/services/gallery-locations/gallery-locations';
import { GalleryState } from '../../../gallery/services/gallery-state/gallery-state';
import { ProcessManager } from '../../../ipc/process-manager';
import { defaultSortMode, treeNode } from '../../../gallery/services/gallery-state/gallery-state.types';
import { Dialogs } from '../../../ipc/dialogs';
import { SettingsPanelComponent } from '../../../settings/components/settings-dialog/settings-dialog.component';
import { DefaultPipe } from '../../../system/pipes/default/default.pipe';
import { ImageView } from '../../../viewer/pages/image-view/image-view';
import { ViewNavigator } from '../../../viewer/services/view-navigator/view-navigator';

@Component({
  selector: 'app-gallery',
  imports: [
    AsyncPipe,
    ImageGridComponent,
    SettingsPanelComponent,
    SidePanelComponent,
    TreeComponent,
    ActionButtonComponent,
    CdkMenu,
    CdkMenuItem,
    IconComponent,
    PopupMenuComponent,
    TextComponent,
    DefaultPipe,
    VerticalStackComponent,
    ToolbarComponent
  ],
  templateUrl: './gallery.page.html',
  styleUrl: './gallery.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class GalleryPage {
  /* DI */
  private readonly document = inject(DOCUMENT);

  private readonly desktopApi = (this.document.defaultView as unknown as { desktop?: Desktop } | null)?.desktop;

  private readonly galleryState = inject(GalleryState);

  protected readonly galleryCacheBuild = inject(GalleryCacheBuild);

  private readonly dialogs = inject(Dialogs);

  private readonly dialog = inject(Dialog);

  private readonly processManager = inject(ProcessManager);

  private readonly galleryLocations = inject(GalleryLocations);

  readonly router = inject(Router);

  readonly viewNavigator = inject(ViewNavigator);

  readonly overlayService = inject(OverlayService);

  protected readonly tree = viewChild.required(TreeComponent);

  protected readonly imageGrid = viewChild(ImageGridComponent);
  protected readonly setVerifyCacheFiles = (enabled: boolean): void => this.galleryCacheBuild.setVerifyCacheFiles(enabled);

  protected readonly defaultSortMode = defaultSortMode();

  protected readonly defaultThumbnailSize = defaultThumbnailSize;

  private readonly readControlsSidebarVisible = (): boolean => {
    try { return globalThis.localStorage.getItem('gallerySidebarVisible') === 'true'; }
    catch { return false; }
  };
  protected readonly controlsSidebarVisible = signal(this.readControlsSidebarVisible());
  protected readonly gallerySidebarTabs = [{ id: 'general', label: 'General' }, { id: 'capture', label: 'Capture' }];
  private readonly readActiveGallerySidebarTab = (): string => {
    try {
      const saved = globalThis.localStorage.getItem('activeGallerySidebarTab');
      return this.gallerySidebarTabs.some(tab => tab.id === saved) ? saved! : 'general';
    } catch { return 'general'; }
  };
  protected readonly activeGallerySidebarTab = signal(this.readActiveGallerySidebarTab());
  protected readonly setActiveGallerySidebarTab = (tab: string): void => {
    if (!this.gallerySidebarTabs.some(item => item.id === tab)) return;
    this.activeGallerySidebarTab.set(tab);
    try { globalThis.localStorage.setItem('activeGallerySidebarTab', tab); } catch { /* Keep the session selection. */ }
  };
  private readonly readStoredControlsSidebarWidth = (): number => {
    try {
      const stored = Number(globalThis.localStorage.getItem('gallerySidebarWidth'));
      return Number.isFinite(stored) && stored >= 280 ? stored : 320;
    } catch { return 320; }
  };
  protected readonly controlsSidebarWidth = signal(this.readStoredControlsSidebarWidth());
  protected readonly startControlsSidebarResize = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const view = globalThis.window;
    const startX = event.clientX;
    const startWidth = this.controlsSidebarWidth();
    const move = (moveEvent: PointerEvent) => this.controlsSidebarWidth.set(Math.max(280, Math.min(view.innerWidth * 0.7, startWidth + startX - moveEvent.clientX)));
    const end = () => {
      view.removeEventListener('pointermove', move);
      view.removeEventListener('pointerup', end);
      try { view.localStorage.setItem('gallerySidebarWidth', String(Math.round(this.controlsSidebarWidth()))); } catch { /* Keep session width. */ }
    };
    view.addEventListener('pointermove', move);
    view.addEventListener('pointerup', end, { once: true });
  };
  protected readonly toggleControlsSidebar = (): void => {
    const next = !this.controlsSidebarVisible();
    this.controlsSidebarVisible.set(next);
    try { globalThis.localStorage.setItem('gallerySidebarVisible', String(next)); } catch { /* Keep session state. */ }
  };

  protected readonly openCaptureWindow = async (): Promise<void> => {
    await this.desktopApi?.CapturePreviewWindow.open();
  };

  @HostListener('document:keyup', ['$event'])
  protected readonly onCaptureShortcut = (event: KeyboardEvent): void => {
    const key = event.key.toLowerCase();
    if (event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
    if (!(key === 's' && !event.shiftKey) && !(key === 'c' && event.shiftKey)) return;
    const target = event.target;
    if (target instanceof HTMLElement
      && target.matches('input:not([type="checkbox"]), textarea, select, [contenteditable="true"]')) return;
    // ImageView owns the shortcut while its overlay is active.
    if (this.document.querySelector('app-image-view')) return;
    event.preventDefault();
    void this.openCaptureWindow();
  };

  /* State */
  readonly galleryRoot$ = this.galleryState.galleryRoot().pipe(
    switchMap(async root => {
      const children = await Promise.all((root.children ?? []).map(async node => {
        const response = await this.galleryState.getDirContents(node.id);
        return {
          ...node,
          // Only show the expand indicator when the directory actually contains subdirectories.
          // Leave the value undefined on read failure so the user can still try to expand it.
          hasChildren: response.success ? response.data.length > 0 : undefined
        };
      }));
      return { ...root, children };
    })
  );

  readonly hoveredFolderPath = signal<string | null>(null);

  protected readonly galleryLocationError = signal<string | null>(null);

  protected readonly onTreeNodeHovered = (node: TreeNode<string> | null): void => {
    this.hoveredFolderPath.set(node?.id || null);
  };

  readonly selectedLocation$ = this.galleryState.selectedLocation();

  readonly images$ = this.galleryState.images();

  readonly sortMode$ = this.galleryState.sortMode();

  readonly thumbSize$ = this.galleryState.thumbSize();

  constructor() {
    console.warn('[GalleryPage] CONSTRUCTOR START');
    afterNextRender(() => console.warn('[GalleryPage] AFTER NEXT RENDER'));

    // Keep the native window title in sync with the active gallery directory.
    this.selectedLocation$.subscribe(location => {
      this.processManager.setWindowTitle(location ?? '').catch(() => undefined);
      // Selecting a gallery folder also selects its drive-local cache database.
      if (location) void this.desktopApi?.CacheManager.getDirectoryPhotoLocations(location).catch(() => undefined);
    });

    // Refresh cache details only when returning from the image viewer.
    combineLatest([this.overlayService.isVisible(), this.overlayService.component()])
      .pipe(
        pairwise(),
        filter(([[wasVisible], [isVisible, component]]) =>
          wasVisible && !isVisible && component === ImageView
        ),
        takeUntilDestroyed()
      )
      .subscribe(() => this.imageGrid()?.refreshDetailCacheStatus());

  }


  /* Event handlers */
  protected readonly onSortByChange = (value: SortType) => this.galleryState.changeSorting({ sortBy: value });

  protected readonly onSortDirChange = (value: SortDirection) => this.galleryState.changeSorting({ sortDir: value });

  protected readonly onThumbSizeChange = (value: ThumbnailSize) => this.galleryState.changeThumbnailSize(value);

  protected readonly onAddLocation = async () => {
    this.galleryLocationError.set(null);
    const result = await this.dialogs.openFolder();

    if (!result.success) return;

    const validation = await this.desktopApi?.FileSystem.prepareGalleryLocation(result.data);
    if (!validation) {
      this.galleryLocationError.set('Could not validate the selected folder.');
      return;
    }
    if (!validation.success) {
      this.galleryLocationError.set(validation.errorMessage);
      return;
    }

    this.galleryLocations.addLocation(result.data);
  };

  protected readonly onRemoveLocation = async (data: TreeNode<string>) =>
    ConfirmationDialogComponent
      .open(
        this.dialog,
        {
          title: 'Confirm location removal',
          description: `Are you sure you want to remove "${data.id}" from gallery locations?`
        }
      )
      .subscribe(() => this.galleryLocations.removeLocation(data.id));

  protected readonly loadTreeNode = async (state: TreeLoadRequest<string>) => {
    const result = await this.galleryState.getDirContents(state.node.id);
    const node = structuredClone(state.node);

    if (result.success) {
      node.children = await Promise.all(result.data.map(async location => {
        const childContents = await this.galleryState.getDirContents(location.path);
        return {
          ...treeNode(location.path, true),
          // Determine expandability for every nested directory, not just gallery roots.
          // Preserve the indicator on read failure so the directory can still be expanded.
          hasChildren: childContents.success ? childContents.data.length > 0 : undefined
        };
      }));
      node.hasChildren = node.children.length > 0;
    }

    this.tree().updateNode(node);
  };

  protected readonly selectLocation = (node: TreeNode<string>) =>
    this.galleryState
      .navigateTo(node.id)
      .subscribe();

  protected readonly onImageSelected = (file: FileInfo) =>
    this.viewNavigator
      .selectImage(file.path)
      .subscribe(() => this.overlayService.show(ImageView));
}
