import { DOCUMENT } from '@angular/common';
import { inject, Injectable } from '@angular/core';
import { filter, fromEvent, share } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class Keyboard {
  private readonly document = inject(DOCUMENT);

  /**
   * Detect text-entry focus without relying on instanceof checks, which can
   * fail for controls originating in another window or Shadow DOM.
   */
  isTextInputTarget = (event: KeyboardEvent): boolean => {
    const isTextEntry = (candidate: EventTarget | null): boolean => {
      if (!candidate || typeof candidate !== 'object') return false;
      const element = candidate as {
        nodeType?: number;
        tagName?: string;
        type?: string;
        isContentEditable?: boolean;
        matches?: (selector: string) => boolean;
        parentElement?: Element | null;
        getRootNode?: () => { host?: Element };
      };
      if (element.nodeType !== 1) return false;

      const tagName = element.tagName?.toLowerCase();
      if (tagName === 'textarea' || tagName === 'select') return true;
      if (tagName === 'input') {
        const type = (element.type ?? 'text').toLowerCase();
        return !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'range', 'color', 'image'].includes(type);
      }
      if (element.isContentEditable) return true;
      if (element.matches?.('[role="textbox"], [contenteditable]:not([contenteditable="false"]), [data-keyboard-shortcuts="off"]')) return true;
      return false;
    };

    // Use the actual event target, not document.activeElement. Clicking a
    // non-focusable photo or canvas does not move focus, so activeElement may
    // still be an old text field and incorrectly suppress global shortcuts.
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    return path.some(item => isTextEntry(item));
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
