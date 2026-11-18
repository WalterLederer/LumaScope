import { Component, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Title } from '@angular/platform-browser';
import { RouterModule } from '@angular/router';
import { OverlayComponent } from '@light-matter/ui';
import { supportedFileExtensions } from 'internal-api';
import { firstValueFrom } from 'rxjs';
import { GalleryLocations } from '../gallery/services/gallery-locations/gallery-locations';
import { GalleryState } from '../gallery/services/gallery-state/gallery-state';
import { FileSystem } from '../ipc/file-system';
import { ThemeService } from '../system/services/theme/theme.service';
import { CaptureHotkeyService } from '../capture/capture-hotkey.service';
import { Keyboard } from '../system/services/keyboard/keyboard';
import { ViewNavigator } from '../viewer/services/view-navigator/view-navigator';

@Component({
  imports: [ RouterModule, OverlayComponent ],
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.scss',
  host: {
    '(dragover)': 'onDragOver($event)',
    '(drop)': 'onDrop($event)'
  }
})
export class App {
  private readonly title = inject(Title);

  private readonly fileSystem = inject(FileSystem);

  private readonly galleryLocations = inject(GalleryLocations);

  private readonly galleryState = inject(GalleryState);

  private readonly viewNavigator = inject(ViewNavigator);


  private readonly themeService = inject(ThemeService);

  private readonly keyboard = inject(Keyboard);

  // Register the desktop global-shortcut listeners as soon as the main renderer starts.
  // The capture panel itself may not be mounted until its detached window is opened.
  private readonly captureHotkeyService = inject(CaptureHotkeyService);

  constructor() {
    this.setAppTitle();
    this.keyboard.keydown().pipe(takeUntilDestroyed()).subscribe(event => {
      if (event.repeat || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.code !== 'KeyL' && event.code !== 'KeyS') return;
      event.preventDefault();
      if (event.code === 'KeyL') {
        // The map window may never have been opened before, so no previous
        // location is guaranteed to exist. Still open the window without a
        // starting position in that case.
        void window.desktop.MapWindow.getLocation().then(location =>
          window.desktop.MapWindow.open(
            location?.latitude ?? null,
            location?.longitude ?? null,
            location?.bearing ?? undefined,
            location?.imagePath ?? null
          )
        ).catch(() => window.desktop.MapWindow.open(null, null));
      } else {
        void window.desktop.CapturePreviewWindow.open();
      }
    });
  }

  setAppTitle = () => this.title.setTitle('LumaScope');

  protected readonly onDragOver = (event: DragEvent) => {
    if (event.dataTransfer?.types.includes('Files')) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }
  };

  protected readonly onDrop = async (event: DragEvent) => {
    if (!event.dataTransfer?.files.length) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const file = Array.from(event.dataTransfer.files).find(droppedFile => {
      const path = window.desktop.getPathForFile(droppedFile);
      const name = path.split(/[\\/]/).pop() ?? '';
      const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
      return extension !== name && supportedFileExtensions.includes(extension);
    });

    if (!file) {
      return;
    }

    const path = window.desktop.getPathForFile(file);
    const directory = await this.fileSystem.dirname(path);
    const navigation = this.galleryState.navigateTo(directory);
    this.galleryLocations.addLocation(directory);

    await firstValueFrom(navigation);
    await firstValueFrom(this.viewNavigator.selectImage(path));

    // ImageView is the persistent application view; selecting an image updates it directly.
  };
}
