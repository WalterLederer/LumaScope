import { Injectable } from '@angular/core';
import { DesktopDialogs } from 'internal-api';

@Injectable({ providedIn: 'root' })
export class Dialogs implements DesktopDialogs {
  readonly openFolder = () => window.desktop.Dialogs.openFolder();
  readonly saveFile = (defaultPath?: string) => window.desktop.Dialogs.saveFile(defaultPath);
}
