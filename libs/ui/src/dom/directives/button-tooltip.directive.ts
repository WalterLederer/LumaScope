import { Directive, ElementRef, inject } from '@angular/core';

/**
 * Supplies a native tooltip for buttons that do not already define one.
 * The accessible label is preferred; visible button text is used as a fallback.
 */
@Directive({
  selector: 'button:not([title])',
  standalone: true,
  host: {
    '[attr.title]': 'tooltip'
  }
})
export class ButtonTooltipDirective {
  private readonly element = inject(ElementRef<HTMLButtonElement>);

  protected get tooltip(): string {
    const button = this.element.nativeElement;
    const accessibleName = button.getAttribute('aria-label')?.trim();
    if (accessibleName) return accessibleName;

    const visibleText = (button.innerText || button.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
    return visibleText || 'Button action';
  }
}
