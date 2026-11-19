import { CdkMenu, CdkMenuItem } from '@angular/cdk/menu';
import { Dialog } from '@angular/cdk/dialog';
import { AsyncPipe, DOCUMENT } from '@angular/common';
import { afterNextRender, ChangeDetectionStrategy, Component, HostListener, inject, input, output, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import {
  ConfirmationDialogComponent,
  IconComponent,
  PopupMenuComponent,
  SidePanelComponent,
  TextComponent,
  TreeComponent,
  TreeLoadRequest,
  TreeNode,
  VerticalStackComponent
} from '@light-matter/ui';
import { defaultThumbnailSize, Desktop, FileInfo, SortDirection, SortType, ThumbnailSize } from 'internal-api';
import { combineLatest, map, shareReplay, switchMap } from 'rxjs';
import { ImageGridComponent } from '../../../gallery/components/image-grid/image-grid.component';
import { GalleryLocations } from '../../../gallery/services/gallery-locations/gallery-locations';
import { GalleryState } from '../../../gallery/services/gallery-state/gallery-state';
import { GalleryCacheBuild } from '../../../gallery/services/gallery-cache-build/gallery-cache-build';
import { ProcessManager } from '../../../ipc/process-manager';
import { defaultSortMode, treeNode } from '../../../gallery/services/gallery-state/gallery-state.types';
import { Dialogs } from '../../../ipc/dialogs';
import { DefaultPipe } from '../../../system/pipes/default/default.pipe';
import { ViewNavigator } from '../../../viewer/services/view-navigator/view-navigator';
import { Keyboard } from '../../../system/services/keyboard/keyboard';

@Component({
  selector: 'app-gallery',
  imports: [
    AsyncPipe,
    ImageGridComponent,
    SidePanelComponent,
    TreeComponent,
    CdkMenu,
    CdkMenuItem,
    IconComponent,
    PopupMenuComponent,
    TextComponent,
    DefaultPipe,
    VerticalStackComponent,
  ],
  templateUrl: './gallery.page.html',
  styleUrl: './gallery.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class GalleryPage {
  /* DI */
  private readonly document = inject(DOCUMENT);

  private readonly keyboard = inject(Keyboard);

  private readonly desktopApi = (this.document.defaultView as unknown as { desktop?: Desktop } | null)?.desktop;

  private readonly galleryState = inject(GalleryState);

  protected readonly galleryCacheBuild = inject(GalleryCacheBuild);

  private readonly dialogs = inject(Dialogs);

  private readonly dialog = inject(Dialog);

  private readonly processManager = inject(ProcessManager);

  private readonly galleryLocations = inject(GalleryLocations);

  readonly router = inject(Router);

  readonly viewNavigator = inject(ViewNavigator);

  readonly imageSelected = output<FileInfo>();

  readonly locationSelected = output<void>();

  readonly showFolderTree = input(true);

  readonly showImageGrid = input(true);
  readonly selectedImagePath = input<string | null>(null);


  protected readonly tree = viewChild(TreeComponent);

  

  protected readonly defaultSortMode = defaultSortMode();

  protected readonly defaultThumbnailSize = defaultThumbnailSize;

  protected readonly openCaptureWindow = async (): Promise<void> => {
    await this.desktopApi?.CapturePreviewWindow.open();
  };

  @HostListener('document:keydown', ['$event'])
  protected readonly onMainWindowShortcut = (event: KeyboardEvent): void => {
    if (event.repeat || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.code !== 'KeyL' && event.code !== 'KeyS') return;
    if (this.keyboard.isTextInputTarget(event)) return;
    // The Image View has its own capture-phase handler while it is mounted.
    if (this.document.querySelector('app-image-view')) return;
    event.preventDefault();
    if (event.code === 'KeyL') {
      const api = this.desktopApi?.MapWindow;
      if (!api) return;
      void api.isOpen().then(isOpen => isOpen ? api.focus() : api.open(null, null));
    } else {
      void this.openCaptureWindow();
    }
  };

  @HostListener('document:keyup', ['$event'])
  protected readonly onCaptureShortcut = (event: KeyboardEvent): void => {
    const key = event.key.toLowerCase();
    if (event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
    if (!(key === 'c' && event.shiftKey)) return;
    if (this.keyboard.isTextInputTarget(event)) return;
    // The Image View owns the shortcut while it is active.
    if (this.document.querySelector('app-image-view')) return;
    event.preventDefault();
    void this.openCaptureWindow();
  };

  /* State */
  readonly selectedLocation$ = this.galleryState.selectedLocation();

  readonly autoSortFavorites$ = this.galleryLocations.autoSortFavorites();

  readonly galleryRoot$ = combineLatest([
    this.galleryState.galleryRoot(),
    this.selectedLocation$
  ]).pipe(
    switchMap(async ([root, selectedLocation]) => {
      const children = await Promise.all((root.children ?? []).map(async node => {
        const response = await this.galleryState.getDirContents(node.id);
        return {
          ...node,
          // Only show the expand indicator when the directory actually contains subdirectories.
          // Leave the value undefined on read failure so the user can still try to expand it.
          hasChildren: response.success ? response.data.length > 0 : undefined
        };
      }));

      const restoredRoot = { ...root, children };
      if (selectedLocation) {
        await this.restoreSelectedTreePath(restoredRoot, selectedLocation);
      }
      return restoredRoot;
    }),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  readonly hoveredFolderPath = signal<string | null>(null);

  protected readonly galleryLocationError = signal<string | null>(null);

  protected readonly onTreeNodeHovered = (node: TreeNode<string> | null): void => {
    this.hoveredFolderPath.set(node?.id || null);
  };

  readonly images$ = this.galleryState.images();

  readonly sortMode$ = this.galleryState.sortMode();

  readonly thumbSize$ = this.galleryState.thumbSize();

  constructor() {

    // Only the image-grid instance owns window title and cache refresh side effects.
    if (this.showImageGrid()) this.selectedLocation$.pipe(takeUntilDestroyed()).subscribe(location => {
      this.processManager.setWindowTitle(location ?? '').catch(() => undefined);
      // Selecting a gallery folder also selects its drive-local cache database.
      if (location) void this.desktopApi?.CacheManager.selectDatabaseForDirectory(location).catch(() => undefined);
    });

    if (this.showImageGrid()) afterNextRender(() => this.galleryCacheBuild.refreshDetailCacheStatus());

  }


  /**
   * Rebuilds and expands the path from its favourite root to the last selected
   * directory. The selected path itself is stored by GalleryState; the tree's
   * expanded nodes are transient and must be reconstructed after startup.
   */
  private readonly restoreSelectedTreePath = async (
    root: TreeNode<string>,
    selectedPath: string
  ): Promise<void> => {
    // Normalize both Windows and POSIX separators for path comparisons.
    const normalizePath = (value: string): string =>
      value.split('\\').join('/').replace(/\/+$/, '').toLocaleLowerCase();

    const normalizedSelection = normalizePath(selectedPath);
    const matchingRoots = (root.children ?? [])
      .filter(node => {
        const normalizedRoot = normalizePath(node.id);
        return normalizedSelection === normalizedRoot
          || normalizedSelection.startsWith(normalizedRoot + '/');
      })
      .sort((a, b) => normalizePath(b.id).length - normalizePath(a.id).length);

    const selectedRoot = matchingRoots[0];
    if (!selectedRoot) return;

    selectedRoot.isSelected = normalizePath(selectedRoot.id) === normalizedSelection;
    if (selectedRoot.isSelected) return;

    const normalizedRootPath = normalizePath(selectedRoot.id);
    const relativePath = normalizedSelection.slice(normalizedRootPath.length).replace(/^\//, '');
    const segments = relativePath.split('/').filter(Boolean);
    let parent = selectedRoot;
    let currentPath = selectedRoot.id;

    for (const segment of segments) {
      const response = await this.galleryState.getDirContents(currentPath);
      if (!response.success) return;

      const children = await Promise.all(response.data.map(async directory => {
        const childContents = await this.galleryState.getDirContents(directory.path);
        return {
          ...treeNode(directory.path, true),
          // Populate expandability for siblings too, so the restored branch behaves
          // exactly like a branch opened manually by the user.
          hasChildren: childContents.success ? childContents.data.length > 0 : undefined
        };
      }));

      parent.children = children;
      parent.hasChildren = children.length > 0;
      parent.isOpen = true;

      const nextPath = normalizePath(currentPath) + '/' + segment;
      const nextNode = children.find(node => normalizePath(node.id) === nextPath);
      if (!nextNode) return;

      nextNode.isSelected = normalizePath(nextNode.id) === normalizedSelection;
      parent = nextNode;
      currentPath = nextNode.id;
      if (nextNode.isSelected) return;
    }
  };

  /* Event handlers */
  protected readonly onSortByChange = (value: SortType) => this.galleryState.changeSorting({ sortBy: value });

  protected readonly onSortDirChange = (value: SortDirection) => this.galleryState.changeSorting({ sortDir: value });

  protected readonly onThumbSizeChange = (value: ThumbnailSize) => this.galleryState.changeThumbnailSize(value);

  protected readonly onTreeAction = (node: TreeNode<string>): void => {
    if (node.id === '') void this.onAddLocation();
    else void this.onRemoveLocation(node);
  };

  protected readonly onMoveFavorite = (event: { node: TreeNode<string>; direction: 'up' | 'down' }): void => {
    this.galleryLocations.moveLocation(event.node.id, event.direction);
  };

  protected readonly onSortFavoritesByPath = (): void => {
    this.galleryLocations.sortLocationsByPath();
  };

  protected readonly onAutoSortFavoritesChange = (event: Event): void => {
    this.galleryLocations.setAutoSortFavorites((event.target as HTMLInputElement).checked);
  };

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

  protected readonly onOpenLocationPath = async (data: TreeNode<string>): Promise<void> => {
    const error = await this.processManager.openPath(data.id);
    if (error) this.document.defaultView?.alert(error);
  };

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

    this.tree()?.updateNode(node);
  };

  protected readonly refreshSelectedFolder = (path: string): void => {
    this.galleryState.navigateTo(path).subscribe();
  };

  protected readonly selectLocation = (node: TreeNode<string>) =>
    this.galleryState
      .navigateTo(node.id)
      .subscribe(() => this.locationSelected.emit());

  protected readonly onImageSelected = (file: FileInfo) => {
    console.trace('[GalleryNavigationTrace] GalleryPage received thumbnail selection:', file.path);
    this.viewNavigator
      .selectImage(file.path)
      .subscribe(selected => {
        if (selected) this.imageSelected.emit(file);
      });
  };
}
