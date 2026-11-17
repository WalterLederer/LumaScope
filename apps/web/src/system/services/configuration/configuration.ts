import { inject, Injectable } from '@angular/core';
import { updateSubject } from '@light-matter/ui';
import {
  AppConfigV1,
  AppConfigV1Gallery,
  AppConfigV1System,
  defaultThumbHeight,
  defaultThumbWidth,
  isAppConfig,
  SystemPathMapping
} from 'internal-api';
import { ReplaySubject } from 'rxjs';
import { FileSystem } from '../../../ipc/file-system';
import { ProcessManager } from '../../../ipc/process-manager';

// Some constants to be used across the application,
// but which should not be modified by the user.
const staticConfig = {
  imageZoom: {
    min: 1,
    max: 800,
    scroll: {
      minStep: 5,
      maxStep: 25,
      coefficient: 0.1
    }
  }
};

@Injectable({ providedIn: 'root' })
export class Configuration {
  private readonly fileSystem = inject(FileSystem);

  private readonly processManager = inject(ProcessManager);

  private readonly config$ = new ReplaySubject<AppConfigV1>(1);

  private _defaultConfig?: AppConfigV1;

  private _configPath?: string;

  private pendingPreferences: Partial<NonNullable<AppConfigV1['preferences']>> = {};

  constructor() {
    this.init();
  }

  readonly config = () => this.config$.asObservable();

  readonly constants = () => staticConfig;

  readonly updateGalleryConfig = (options: Partial<AppConfigV1Gallery>) => {
    updateSubject(this.config$, config => {
      const result = structuredClone(config);
      result.gallery = { ...result.gallery, ...options };
      return result;
    })
      .subscribe();

    // Persist only the changed section through the main-process settings queue.
    // Never write a stale renderer snapshot over settings saved by other windows.
    this.processManager.setAppSettingsSection('gallery', options).catch(error => {
      console.error('[Configuration] Failed to save gallery settings:', error);
    });
  };

  readonly applyPreferencesConfig = (options: Partial<NonNullable<AppConfigV1['preferences']>>) => {
    this.pendingPreferences = { ...this.pendingPreferences, ...options };
    updateSubject(this.config$, config => {
      const result = structuredClone(config);
      result.preferences = { ...result.preferences, ...options };
      return result;
    }).subscribe();
  };

  readonly updatePreferencesConfig = (options: Partial<NonNullable<AppConfigV1['preferences']>>) => {
    this.applyPreferencesConfig(options);
    this.processManager.setAppSettingsSection('preferences', options).catch(error => {
      console.error('[Configuration] Failed to save preferences:', error);
    });
  };

  readonly updateSystemConfig = (options: Partial<AppConfigV1System>) => {
    updateSubject(this.config$, config => {
      const result = structuredClone(config);
      result.system = { ...result.system, ...options };
      return result;
    })
      .subscribe();

    this.processManager.setAppSettingsSection('system', options).catch(error => {
      console.error('[Configuration] Failed to save system settings:', error);
    });
  };

  private readonly init = async () => {
    const paths = await this.processManager.getSystemPaths();
    this._defaultConfig = this.defaultConfig(paths);
    this._configPath = paths.appConfig;
    const existing = await this.fileSystem.readJson<AppConfigV1 | unknown>(this._configPath);

    if (!existing.success || !isAppConfig(existing.data)) {
      this.config$.next({
        ...this._defaultConfig,
        preferences: { ...this._defaultConfig.preferences, ...this.pendingPreferences }
      });
      return;
    }

    const storedPreferences = existing.data.preferences;
    const legacyBrightnessMigration = storedPreferences?.themeTotalBrightness === undefined
      && storedPreferences?.themeColorBrightness !== undefined
      ? { themeTotalBrightness: storedPreferences.themeColorBrightness }
      : {};

    this.config$.next({
      ...this._defaultConfig,
      ...existing.data,
      preferences: {
        ...this._defaultConfig.preferences,
        ...storedPreferences,
        ...legacyBrightnessMigration,
        ...this.pendingPreferences
      }
    });
  };

  private readonly defaultConfig = (paths: SystemPathMapping): AppConfigV1 => {
    return {
      version: 1,
      gallery: {
        locations: [ paths.pictures ],
        thumbWidth: defaultThumbWidth,
        thumbHeight: defaultThumbHeight
      },
      system: {
        minimiseOnStart: false,
        theme: 'light'
      },
      preferences: {
        buttonStyle: 'blue',
        buttonColor: 'blue',
        zoomSliderColor: '#14b8a6',
        themeColorSaturation: 100,
        themeTotalBrightness: 100,
        themeBackgroundBrightness: 100,
        disclosureStyle: 'classic',
        tabBarStyle: 'classic'
      }
    };
  };
}
