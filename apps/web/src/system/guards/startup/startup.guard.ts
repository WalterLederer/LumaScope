import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import 'internal-api';
import { firstValueFrom, map, switchMap } from 'rxjs';
import { GalleryState } from '../../../gallery/services/gallery-state/gallery-state';
import { FileSystem } from '../../../ipc/file-system';
import { ProcessManager } from '../../../ipc/process-manager';
import { ViewNavigator } from '../../../viewer/services/view-navigator/view-navigator';

export const startupGuard: CanActivateFn = async () => {
  const router = inject(Router);
  const viewNavigator = inject(ViewNavigator);
  const fileSystem = inject(FileSystem);
  const galleryState = inject(GalleryState);
  const processManager = inject(ProcessManager);

  console.warn('[StartupGuard] START');
  console.warn('[StartupGuard] Requesting argv');
  const argv = await processManager.argv();
  console.warn('[StartupGuard] argv resolved', { positionalCount: argv._.length, positionalTypes: argv._.map(value => typeof value) });
  const isPackaged = await processManager.isPackaged();
  console.warn('[StartupGuard] isPackaged resolved', isPackaged);

  if (isPackaged && argv._.length === 1 && typeof argv._[0] === 'string') {
    console.warn('[StartupGuard] Standalone image argument detected');
    const image = argv._[0];
    const dir = await fileSystem.dirname(image);
    console.warn('[StartupGuard] Image directory resolved');

    viewNavigator.standalone.set(true);

    console.warn('[StartupGuard] Navigating to standalone image');
    return firstValueFrom(
      galleryState.navigateTo(dir)
        .pipe(
          switchMap(() => viewNavigator.selectImage(image)),
          map(() => {
            console.warn('[StartupGuard] Standalone navigation completed');
            return router.createUrlTree([ '/view' ]);
          })
        )
    );
  }

  console.warn('[StartupGuard] Redirecting to /welcome');
  return router.createUrlTree([ '/welcome' ]);
};
