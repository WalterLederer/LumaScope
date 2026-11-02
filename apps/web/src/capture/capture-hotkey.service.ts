import { Injectable, signal } from '@angular/core';

export type CaptureHotkeyAction = 'top-window' | 'rectangle';

@Injectable({ providedIn: 'root' })
export class CaptureHotkeyService {
  readonly pendingAction = signal<CaptureHotkeyAction | null>(null);

  constructor() {
    window.desktop.Capture.onTopWindowClipboardHotkey(() => {
      this.pendingAction.set('top-window');
    });
    window.desktop.Capture.onRectangleClipboardHotkey(() => {
      this.pendingAction.set('rectangle');
    });
  }

  consume(): CaptureHotkeyAction | null {
    const action = this.pendingAction();
    this.pendingAction.set(null);
    return action;
  }
}
