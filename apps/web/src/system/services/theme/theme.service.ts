import { DOCUMENT } from '@angular/common';
import { inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Configuration } from '../configuration/configuration';

export type AppTheme = 'dark' | 'light';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);

  private readonly configuration = inject(Configuration);

  readonly current = signal<AppTheme>(this.readInitialTheme());

  private readInitialTheme(): AppTheme {
    try {
      const stored = this.document.defaultView?.localStorage.getItem('theme');
      if (stored === 'light' || stored === 'dark') return stored;
    } catch { /* Fall back to the document theme when storage is unavailable. */ }
    return this.document.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark';
  }

  constructor() {
    this.document.defaultView?.addEventListener('storage', event => {
      if (event.key === 'theme' && (event.newValue === 'light' || event.newValue === 'dark')) {
        this.setTheme(event.newValue);
      }
    });

    this.configuration.config()
      .pipe(takeUntilDestroyed())
      .subscribe(config => this.setTheme(config.system.theme ?? 'dark'));
  }

  readonly toggle = () => {
    this.configuration.updateSystemConfig({
      theme: this.current() === 'dark' ? 'light' : 'dark'
    });
  };

  private readonly setTheme = (theme: AppTheme) => {
    this.current.set(theme);
    this.document.documentElement.dataset['theme'] = theme;
    try { this.document.defaultView?.localStorage.setItem('theme', theme); } catch { /* Theme remains active for this window. */ }
  };
}
