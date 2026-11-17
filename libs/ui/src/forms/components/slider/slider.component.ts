import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  forwardRef,
  inject,
  input,
  output,
  effect,
  signal,
  viewChild
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NG_VALUE_ACCESSOR } from '@angular/forms';
import { distinctUntilChanged, finalize, map } from 'rxjs';
import { allVariants, Variant } from '../../../content';
import { MouseMovement, MouseTrackerService } from '../../../dom';
import { FormElementDirective } from '../../directives/form-element/form-element.directive';

@Component({
  selector: 'ui-slider',
  imports: [],
  templateUrl: './slider.component.html',
  styleUrl: './slider.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      multi: true,
      useExisting: forwardRef(() => SliderComponent)
    }
  ],
  host: {
    '[style.--position]': 'stylePosition()',
    '[style.--track-color]': 'trackColor()',
    '[style.--indicator-color]': 'indicatorColor()',
    '[attr.role]': "'slider'",
    '[attr.tabindex]': 'disabled || isDisabled() ? -1 : 0',
    '[attr.aria-valuemin]': 'min()',
    '[attr.aria-valuemax]': 'max()',
    '[attr.aria-valuenow]': 'currentValue()',
    '[attr.aria-disabled]': 'disabled || isDisabled()',
    '[class.disabled]': 'disabled || isDisabled()',
    '(keydown)': 'onKeyDown($event)'
  }
})
export class SliderComponent extends FormElementDirective<number> {
  readonly min = input(0);

  readonly max = input(100);

  readonly step = input(1);

  readonly value = input<number | undefined>(undefined);

  readonly valueChange = output<number>();

  readonly valueCommit = output<number>();

  readonly color = input<string | undefined>(undefined);

  readonly isDisabled = input(false);

  readonly variant = input<Variant>(allVariants[0]);

  protected readonly currentValue = signal(0);

  constructor() {
    effect(() => {
      const value = this.value();
      if (value !== undefined && Number.isFinite(value)) this.currentValue.set(this.normalizeValue(value));
    });
  }

  protected readonly position = computed(() => (this.currentValue() - this.min()) / (this.max() - this.min()));

  protected readonly stylePosition = computed(() => `${this.position() * 100}%`);

  private readonly mouseTrackerService = inject(MouseTrackerService);

  private readonly destroyRef = inject(DestroyRef);

  private readonly trackRef = viewChild<unknown, ElementRef<HTMLDivElement>>('track', { read: ElementRef });

  protected readonly trackColor = computed(() => this.color() ?? `var(--color-element-${this.variant()}-low)`);

  protected readonly indicatorColor = computed(() => this.color() ?? `var(--color-contrast-${this.variant()}-lowest)`);

  override readonly writeValue = (value: number) => {
    this.currentValue.set(value);
  };

  protected readonly onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) {
      return;
    }

    const track = this.trackRef()?.nativeElement;
    if (!track) {
      return;
    }

    const bounds = track.getBoundingClientRect();
    const width = bounds.width;
    if (width <= 0) {
      return;
    }

    if (this.disabled || this.isDisabled()) return;

    const min = this.min();
    const max = this.max();
    const origin = Math.max(0, Math.min(width, event.clientX - bounds.left));
    const initialValue = this.normalizeValue(min + (max - min) * (origin / width));

    this.currentValue.set(initialValue);
    this.onChange(initialValue);
    this.valueChange.emit(initialValue);
    this.onTouched();

    this.mouseTrackerService
      .mouseDown(event)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        map(state => this.getX(origin, state, width)),
        map(x => x / width),
        map(x => this.normalizeValue((max - min) * x + min)),
        distinctUntilChanged(),
        finalize(() => this.valueCommit.emit(this.currentValue()))
      )
      .subscribe(value => {
        this.currentValue.set(value);
        this.onChange(value);
        this.valueChange.emit(value);
      });
  };

  protected readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.disabled || this.isDisabled()) return;
    const increment = this.step() > 0 ? this.step() : 1;
    const pageIncrement = Math.max(increment, (this.max() - this.min()) / 10);
    let next = this.currentValue();
    switch (event.key) {
      case 'ArrowRight': case 'ArrowUp': next += increment; break;
      case 'ArrowLeft': case 'ArrowDown': next -= increment; break;
      case 'PageUp': next += pageIncrement; break;
      case 'PageDown': next -= pageIncrement; break;
      case 'Home': next = this.min(); break;
      case 'End': next = this.max(); break;
      default: return;
    }
    event.preventDefault();
    next = this.normalizeValue(next);
    if (next === this.currentValue()) return;
    this.currentValue.set(next);
    this.onChange(next);
    this.valueChange.emit(next);
    this.onTouched();
    this.valueCommit.emit(next);
  };

  private readonly normalizeValue = (value: number): number => {
    const min = this.min();
    const max = this.max();
    const step = this.step();
    const bounded = Math.max(min, Math.min(max, value));
    return step > 0 ? Math.max(min, Math.min(max, min + Math.round((bounded - min) / step) * step)) : bounded;
  };

  private readonly getX = (origin: number, state: MouseMovement, width: number): number => {
    const x = origin + state.dx;

    if (x < 0) {
      return 0;
    }

    if (x > width) {
      return width;
    }

    return x;
  };
}
