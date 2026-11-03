import { Injectable } from '@angular/core';
import { CacheClearResult, CacheInfo, DesktopCacheManager } from 'internal-api';

@Injectable({ providedIn: 'root' })
export class CacheManager implements DesktopCacheManager {
  readonly clear = (): Promise<CacheClearResult> => window.desktop.CacheManager.clear();

  readonly clearFullSize = (): Promise<CacheClearResult> => window.desktop.CacheManager.clearFullSize();

  readonly clearThumbnails = (): Promise<CacheClearResult> => window.desktop.CacheManager.clearThumbnails();

  readonly deleteImage = (sourceName: string): Promise<CacheClearResult> =>
    window.desktop.CacheManager.deleteImage(sourceName);

  readonly cacheSize = () => window.desktop.CacheManager.cacheSize();

  readonly cacheInfo = (): Promise<CacheInfo> => window.desktop.CacheManager.cacheInfo();

  readonly imageCachePath = (sourceName: string): Promise<string | null> =>
    window.desktop.CacheManager.imageCachePath(sourceName);

  readonly openCacheFolder = () => window.desktop.CacheManager.openCacheFolder();

  readonly getSidecarVolumes = () => window.desktop.CacheManager.getSidecarVolumes();

  readonly setSidecarVolumeEnabled = (volumeRoot: string, enabled: boolean) =>
    window.desktop.CacheManager.setSidecarVolumeEnabled(volumeRoot, enabled);
}
