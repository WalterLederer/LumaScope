import { DOCUMENT } from '@angular/common';
import { inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonColor, ButtonStyle, Desktop, DisclosureStyle, TabBarStyle } from 'internal-api';
import { Configuration } from '../configuration/configuration';

export type AppTheme = 'dark' | 'light';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);

  private readonly configuration = inject(Configuration);

  private readonly desktop = (this.document.defaultView as (Window & { desktop?: Desktop }) | null)?.desktop;

  readonly current = signal<AppTheme>(this.readInitialTheme());

  readonly buttonStyle = signal<ButtonStyle>('blue');

  readonly buttonColor = signal<ButtonColor>('#287fc4');

  readonly zoomSliderColor = signal('#14b8a6');

  readonly sliderColor = signal('#287fc4');

  readonly themeColorSaturation = signal(100);

  readonly themeTotalBrightness = signal(100);

  readonly themeBackgroundBrightness = signal(100);

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
    this.desktop?.ProcessManager.onAppSettingsChanged((section, values) => {
      if (section !== 'preferences') return;
      this.configuration.applyPreferencesConfig(values as Parameters<Configuration['applyPreferencesConfig']>[0]);
    });

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
        this.applyButtonColor(config.preferences?.buttonColor ?? 'blue');
        this.applyZoomSliderColor(config.preferences?.zoomSliderColor ?? '#14b8a6');
        this.applySliderColor(config.preferences?.sliderColor ?? '#287fc4');
        this.applyThemeColorSaturation(config.preferences?.themeColorSaturation ?? 100);
        this.applyThemeTotalBrightness(config.preferences?.themeTotalBrightness ?? config.preferences?.themeColorBrightness ?? 100);
        this.applyThemeBackgroundBrightness(config.preferences?.themeBackgroundBrightness ?? 100);
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

  readonly setButtonColor = (color: ButtonColor) => {
    this.applyButtonColor(color);
    this.configuration.updatePreferencesConfig({ buttonColor: color });
  };

  readonly buttonColorSliderValue = () => this.colorSliderValue(this.buttonColor(), 29);

  private colorSliderValue(color: string, fallback: number): number {
    const match = /^#([0-9a-f]{6})$/i.exec(color);
    if (!match) return fallback;
    const value = Number.parseInt(match[1], 16);
    const red = (value >> 16) & 255;
    const green = (value >> 8) & 255;
    const blue = value & 255;
    const max = Math.max(red, green, blue) / 255;
    const min = Math.min(red, green, blue) / 255;
    const delta = max - min;
    let hue = 0;
    if (delta !== 0) {
      if (max === red / 255) hue = 60 * (((green - blue) / 255 / delta) % 6);
      else if (max === green / 255) hue = 60 * ((blue - red) / 255 / delta + 2);
      else hue = 60 * ((red - green) / 255 / delta + 4);
    }
    return Math.round((((hue + 360) % 360) / 360) * 49);
  }

  readonly setButtonColorFromSlider = (value: number) => {
    const index = Math.max(0, Math.min(49, Math.round(Number(value) || 0)));
    const hue = index * 360 / 50;
    this.setButtonColor(this.hslToHex(hue, 100, 50));
  };

  readonly sliderColorValue = () => this.colorSliderValue(this.sliderColor(), 29);

  readonly setSliderColorFromSlider = (value: number) => {
    const index = Math.max(0, Math.min(49, Math.round(Number(value) || 0)));
    this.applySliderColor(this.hslToHex(index * 360 / 50, 100, 50));
    this.configuration.updatePreferencesConfig({ sliderColor: this.sliderColor() });
  };

  readonly zoomSliderColorValue = () => {
    const match = /^#([0-9a-f]{6})$/i.exec(this.zoomSliderColor());
    if (!match) return 24;
    const value = Number.parseInt(match[1], 16);
    const red = (value >> 16) & 255, green = (value >> 8) & 255, blue = value & 255;
    const max = Math.max(red, green, blue) / 255, min = Math.min(red, green, blue) / 255;
    const delta = max - min;
    let hue = 0;
    if (delta !== 0) {
      if (max === red / 255) hue = 60 * (((green - blue) / 255 / delta) % 6);
      else if (max === green / 255) hue = 60 * ((blue - red) / 255 / delta + 2);
      else hue = 60 * ((red - green) / 255 / delta + 4);
    }
    return Math.round((((hue + 360) % 360) / 360) * 49);
  };

  readonly setZoomSliderColorFromSlider = (value: number) => {
    const index = Math.max(0, Math.min(49, Math.round(Number(value) || 0)));
    const hue = index * 360 / 50;
    const color = this.hslToHex(hue, 100, 50);
    this.zoomSliderColor.set(color);
    this.document.documentElement.style.setProperty('--zoom-slider-color', color);
    this.configuration.updatePreferencesConfig({ zoomSliderColor: color });
  };

  private hslToHex(hue: number, saturation: number, lightness: number): string {
    const s = saturation / 100;
    const l = lightness / 100;
    const chroma = (1 - Math.abs(2 * l - 1)) * s;
    const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
    const m = l - chroma / 2;
    const [r, g, b] = hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0] : hue < 180 ? [0, chroma, x] : hue < 240 ? [0, x, chroma] : hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
    return '#' + [r, g, b].map(channel => Math.round((channel + m) * 255).toString(16).padStart(2, '0')).join('');
  }

  readonly setThemeColorSaturation = (saturation: number) => {
    const value = Math.max(0, Math.min(200, Math.round(Number(saturation) || 0)));
    this.applyThemeColorSaturation(value);
    this.configuration.updatePreferencesConfig({ themeColorSaturation: value });
  };

  readonly setThemeTotalBrightness = (brightness: number) => {
    const value = Math.max(50, Math.min(150, Math.round(Number(brightness) || 50)));
    this.applyThemeTotalBrightness(value);
    this.configuration.updatePreferencesConfig({ themeTotalBrightness: value });
  };

  readonly setThemeBackgroundBrightness = (brightness: number) => {
    const value = Math.max(50, Math.min(150, Math.round(Number(brightness) || 50)));
    this.applyThemeBackgroundBrightness(value);
    this.configuration.updatePreferencesConfig({ themeBackgroundBrightness: value });
  };

  readonly setDisclosureStyle = (style: DisclosureStyle) => {
    this.applyDisclosureStyle(style);
    this.configuration.updatePreferencesConfig({ disclosureStyle: style });
  };

  readonly setTabBarStyle = (style: TabBarStyle) => {
    this.applyTabBarStyle(style);
    this.configuration.updatePreferencesConfig({ tabBarStyle: style });
  };

  private applySliderColor(color: string): void {
    const normalized = /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : '#287fc4';
    this.sliderColor.set(normalized);
    this.document.documentElement.style.setProperty('--slider-color', normalized);
  }

  private applyZoomSliderColor(color: string): void {
    const normalized = /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : '#14b8a6';
    this.zoomSliderColor.set(normalized);
    this.document.documentElement.style.setProperty('--zoom-slider-color', normalized);
  }

  private applyButtonColor(color: ButtonColor): void {
    const legacyColors: Record<string, string> = {
      blue: '#287fc4', cyan: '#087b9f', green: '#197847', teal: '#0e706c',
      orange: '#a64e12', red: '#a83749', purple: '#5d449c', gray: '#4f5d6e'
    };
    const normalized = /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : legacyColors[color] ?? '#287fc4';
    const root = this.document.documentElement;
    this.buttonColor.set(normalized);
    root.dataset['buttonColor'] = normalized;
    root.style.setProperty('--theme-button-color', normalized);
    root.style.setProperty('--button-border', 'color-mix(in srgb, var(--theme-button-color) 70%, white)');
    root.style.setProperty('--button-gradient', 'linear-gradient(145deg, color-mix(in srgb, var(--theme-button-color) 78%, white) 0%, var(--theme-button-color) 52%, color-mix(in srgb, var(--theme-button-color) 72%, black) 100%)');
    root.style.setProperty('--button-shadow', 'color-mix(in srgb, var(--theme-button-color) 70%, black)');
    root.style.setProperty('--button-focus', 'color-mix(in srgb, var(--theme-button-color) 45%, white)');
    root.style.setProperty('--button-text', 'var(--theme-button-color)');
    root.style.setProperty('--button-border-strong', 'var(--theme-button-color)');
    root.style.setProperty('--button-soft-bg', 'color-mix(in srgb, var(--theme-button-color) 14%, white)');
    root.style.setProperty('--button-soft-text', 'color-mix(in srgb, var(--theme-button-color) 78%, black)');
    root.style.setProperty('--button-soft-border', 'color-mix(in srgb, var(--theme-button-color) 30%, white)');
    root.style.setProperty('--button-rounded-bg', 'var(--theme-button-color)');
    root.style.setProperty('--button-rounded-hover', 'color-mix(in srgb, var(--theme-button-color) 85%, black)');
    root.style.setProperty('--button-rounded-active', 'color-mix(in srgb, var(--theme-button-color) 70%, black)');
  }

  private applyThemeColorSaturation(saturation: number): void {
    const value = Math.max(0, Math.min(200, saturation));
    this.themeColorSaturation.set(value);
    this.document.documentElement.style.setProperty('--theme-color-saturation', `${value}%`);
  }

  private applyThemeTotalBrightness(brightness: number): void {
    const value = Math.max(50, Math.min(150, brightness));
    this.themeTotalBrightness.set(value);
    this.document.documentElement.style.setProperty('--theme-total-brightness', `${value}%`);
  }

  private applyThemeBackgroundBrightness(brightness: number): void {
    const value = Math.max(50, Math.min(150, brightness));
    const root = this.document.documentElement;
    this.themeBackgroundBrightness.set(value);
    root.style.setProperty('--theme-background-brightness', `${value}%`);
    root.style.setProperty('--theme-background-overlay-color', value < 100 ? '#000' : '#fff');
    root.style.setProperty('--theme-background-overlay-opacity', String(Math.abs(value - 100) / 100));
  }

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
