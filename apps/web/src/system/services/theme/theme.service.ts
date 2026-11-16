import { DOCUMENT } from '@angular/common';
import { inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonStyle, Desktop, DisclosureStyle, TabBarStyle } from 'internal-api';
import { Configuration } from '../configuration/configuration';

export type AppTheme = 'dark' | 'light';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);

  private readonly configuration = inject(Configuration);

  private readonly desktop = (this.document.defaultView as (Window & { desktop?: Desktop }) | null)?.desktop;

  readonly current = signal<AppTheme>(this.readInitialTheme());

  readonly buttonStyle = signal<ButtonStyle>('blue');

  readonly disclosureStyle = signal<DisclosureStyle>('classic');

  readonly tabBarStyle = signal<TabBarStyle>('classic');

  private readInitialTheme(): AppTheme {
    try {
      const stored = this.document.defaultView?.localStorage.getItem('theme');
      if (stored === 'light' || stored === 'dark') return stored;
    } catch { /* Fall back to the document theme when storage is unavailable. */ }
    return this.document.documentElement.dataset['theme'] === 'light' ? 'light' : 'light';
  }

  constructor() {
    this.desktop?.Theme.onChanged(theme => this.setTheme(theme, false));

    this.document.defaultView?.addEventListener('storage', event => {
      if (event.key === 'theme' && (event.newValue === 'light' || event.newValue === 'dark')) {
        this.setTheme(event.newValue, false);
      }
    });

    this.configuration.config()
      .pipe(takeUntilDestroyed())
      .subscribe(config => {
        this.setTheme(config.system.theme ?? 'light', false);
        const style = config.preferences?.buttonStyle ?? (config.system.flatStandardButtons ? 'flat' : 'blue');
        this.applyButtonStyle(style);
        this.applyDisclosureStyle(config.preferences?.disclosureStyle ?? 'classic');
        this.applyTabBarStyle(config.preferences?.tabBarStyle ?? 'classic');
      });
  }

  readonly toggle = () => {
    const theme: AppTheme = this.current() === 'dark' ? 'light' : 'dark';
    this.setTheme(theme);
    this.configuration.updateSystemConfig({ theme });
  };

  readonly setButtonStyle = (style: ButtonStyle) => {
    this.applyButtonStyle(style);
    this.configuration.updatePreferencesConfig({ buttonStyle: style });
  };

  readonly setDisclosureStyle = (style: DisclosureStyle) => {
    this.applyDisclosureStyle(style);
    this.configuration.updatePreferencesConfig({ disclosureStyle: style });
  };

  readonly setTabBarStyle = (style: TabBarStyle) => {
    this.applyTabBarStyle(style);
    this.configuration.updatePreferencesConfig({ tabBarStyle: style });
  };

  private applyTabBarStyle(style: TabBarStyle): void {
    this.tabBarStyle.set(style);
    this.document.documentElement.dataset['tabBarStyle'] = style;
  }

  private applyDisclosureStyle(style: DisclosureStyle): void {
    this.disclosureStyle.set(style);
    this.document.documentElement.dataset['disclosureStyle'] = style;
  }

  private applyButtonStyle(style: ButtonStyle): void {
    this.buttonStyle.set(style);
    this.document.documentElement.dataset['buttonStyle'] = style;
  }

  private readonly setTheme = (theme: AppTheme, broadcast = true) => {
    const changed = this.current() !== theme;
    this.current.set(theme);
    this.document.documentElement.dataset['theme'] = theme;
    this.document.documentElement.style.colorScheme = theme;
    try { this.document.defaultView?.localStorage.setItem('theme', theme); } catch { /* Theme remains active for this window. */ }
    if (broadcast && changed) this.desktop?.Theme.broadcast(theme);
  };
}
