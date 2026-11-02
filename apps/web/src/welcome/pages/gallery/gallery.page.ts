import { CdkMenu, CdkMenuItem } from '@angular/cdk/menu';
import { Dialog } from '@angular/cdk/dialog';
import { AsyncPipe, DOCUMENT } from '@angular/common';
import { afterNextRender, ChangeDetectionStrategy, Component, HostListener, inject, signal, viewChild } from '@angular/core';
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
import { map, switchMap } from 'rxjs';
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

  private readonly dialogs = inject(Dialogs);

  private readonly dialog = inject(Dialog);

  private readonly processManager = inject(ProcessManager);

  private readonly galleryLocations = inject(GalleryLocations);

  readonly router = inject(Router);

  readonly viewNavigator = inject(ViewNavigator);

  readonly overlayService = inject(OverlayService);

  protected readonly tree = viewChild.required(TreeComponent);

  protected readonly defaultSortMode = defaultSortMode();

  protected readonly defaultThumbnailSize = defaultThumbnailSize;

  private readonly readControlsSidebarVisible = (): boolean => {
    try { return globalThis.localStorage.getItem('light-matter.gallerySidebarVisible') === 'true'; }
    catch { return false; }
  };
  protected readonly controlsSidebarVisible = signal(this.readControlsSidebarVisible());
  protected readonly gallerySidebarTabs = [{ id: 'general', label: 'General' }, { id: 'capture', label: 'Capture' }, { id: 'cache', label: 'Cache' }];
  private readonly readActiveGallerySidebarTab = (): string => {
    try {
      const saved = globalThis.localStorage.getItem('light-matter.activeGallerySidebarTab');
      return this.gallerySidebarTabs.some(tab => tab.id === saved) ? saved! : 'general';
    } catch { return 'general'; }
  };
  protected readonly activeGallerySidebarTab = signal(this.readActiveGallerySidebarTab());
  protected readonly setActiveGallerySidebarTab = (tab: string): void => {
    if (!this.gallerySidebarTabs.some(item => item.id === tab)) return;
    this.activeGallerySidebarTab.set(tab);
    if (tab === 'cache') this.expandGalleryCache();
    try { globalThis.localStorage.setItem('light-matter.activeGallerySidebarTab', tab); } catch { /* Keep the session selection. */ }
  };
  private readonly expandGalleryCache = (): void => {
    // The cache panel's summary is opened by its mode input; changing tabs recreates the panel.
  };
  private readonly readStoredControlsSidebarWidth = (): number => {
    try {
      const stored = Number(globalThis.localStorage.getItem('light-matter.gallerySidebarWidth'));
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
      try { view.localStorage.setItem('light-matter.gallerySidebarWidth', String(Math.round(this.controlsSidebarWidth()))); } catch { /* Keep session width. */ }
    };
    view.addEventListener('pointermove', move);
    view.addEventListener('pointerup', end, { once: true });
  };
  protected readonly toggleControlsSidebar = (): void => {
    const next = !this.controlsSidebarVisible();
    this.controlsSidebarVisible.set(next);
    try { globalThis.localStorage.setItem('light-matter.gallerySidebarVisible', String(next)); } catch { /* Keep session state. */ }
  };

  protected readonly openCaptureWindow = async (): Promise<void> => {
    await this.desktopApi?.CapturePreviewWindow.open();
  };

  @HostListener('document:keyup', ['$event'])
  protected readonly onCaptureShortcut = (event: KeyboardEvent): void => {
    if (!event.shiftKey || event.key.toLowerCase() !== 'c'
      || event.ctrlKey || event.altKey || event.metaKey) return;
    const target = event.target;
    if (target instanceof HTMLElement
      && target.matches('input:not([type="checkbox"]), textarea, [contenteditable="true"]')) return;
    // ImageView owns the same shortcut while its overlay is active.
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
    });

  }


  /* Event handlers */
  protected readonly onSortByChange = (value: SortType) => this.galleryState.changeSorting({ sortBy: value });

  protected readonly onSortDirChange = (value: SortDirection) => this.galleryState.changeSorting({ sortDir: value });

  protected readonly onThumbSizeChange = (value: ThumbnailSize) => this.galleryState.changeThumbnailSize(value);

  protected readonly onAddLocation = async () => {
    const result = await this.dialogs.openFolder();

    if (result.success) {
      this.galleryLocations.addLocation(result.data);
    }
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
