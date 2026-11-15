import { DOCUMENT } from '@angular/common';
import { inject, Injectable } from '@angular/core';
import { filter, fromEvent, share } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class Keyboard {
  private readonly document = inject(DOCUMENT);

  private readonly isTextInputTarget = (event: KeyboardEvent): boolean => {
    const target = event.target;
    if (!(target instanceof Element)) return false;
    return !!target.closest('input, textarea, select, [role="textbox"], [contenteditable="true"]');
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
