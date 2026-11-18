import { inject, Injectable } from '@angular/core';
import { Dialog } from '@angular/cdk/dialog';
import { ConfirmationDialogComponent } from '@light-matter/ui';
import { filter, firstValueFrom, map } from 'rxjs';
import { ViewNavigator } from './view-navigator';

@Injectable({ providedIn: 'root' })
export class ImageFileActions {
  private readonly dialog = inject(Dialog);
  private readonly viewNavigator = inject(ViewNavigator);

  readonly confirmAndDelete = async (path: string): Promise<boolean | null> => {
    const confirmed = await firstValueFrom(
      ConfirmationDialogComponent.open(this.dialog, {
        title: 'Delete image?',
        description: `Do you want to permanently delete "${path}" from disk?`,
        defaultAction: 'cancel'
      }).pipe(filter(confirmed => confirmed === true), map(() => true)),
      { defaultValue: null }
    );
    return confirmed === null ? null : this.viewNavigator.deleteImage(path);
  };
}
