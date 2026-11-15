import { DOCUMENT } from '@angular/common';
import { inject, Injectable } from '@angular/core';
import { filter, fromEvent, share } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class Keyboard {
  private readonly document = inject(DOCUMENT);

  private readonly isTextInputTarget = (event: KeyboardEvent): boolean => {
    // composedPath() also sees the actual control when the event crosses a
    // Shadow DOM boundary and its target is retargeted to a custom element.
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    return path.some(item => {
      if (!(item instanceof Element)) return false;
      if (item instanceof HTMLInputElement || item instanceof HTMLTextAreaElement ||
          item instanceof HTMLSelectElement) return true;
      if (item instanceof HTMLElement && item.isContentEditable) return true;
      return item.matches('input, textarea, select, [role="textbox"], [contenteditable]');
    });
  };

  // Global shortcuts must not run while the user is entering text or choosing
  // a value in a native form control. Keep capture-phase handling for all
  // other targets so shortcuts retain their existing priority.
  private readonly keydown$ = fromEvent<KeyboardEvent>(this.document, 'keydown', { capture: true })
    .pipe(filter(event => !this.isTextInputTarget(event)), share());

  private readonly keyup$ = fromEvent<KeyboardEvent>(this.document, 'keyup')
    .pipe(filter(event => !this.isTextInputTarget(event)), share());

  readonly keydown = () => this.keydown$;

  readonly keyup = () => this.keyup$;
}
