export type ThumbnailSize = 'extraSmallMinus' | 'zoom108' | 'zoom120' | 'zoom132' | 'extraSmall' | 'zoom156' | 'extraSmallPlus' | 'zoom180' | 'small' | 'zoom204' | 'smallPlus' | 'zoom228' | 'smallMedium' | 'zoom252' | 'smallMediumPlus' | 'zoom276' | 'medium' | 'zoom300' | 'mediumPlus' | 'zoom324' | 'mediumLarge' | 'zoom348' | 'mediumLargePlus' | 'zoom372' | 'zoom384' | 'zoom396' | 'zoom408' | 'zoom420' | 'zoom432' | 'zoom444' | 'zoom456' | 'zoom468' | 'zoom480' | 'zoom492' | 'zoom504' | 'large';
export const allThumbnailSizes = [ 'extraSmallMinus', 'zoom108', 'zoom120', 'zoom132', 'extraSmall', 'zoom156', 'extraSmallPlus', 'zoom180', 'small', 'zoom204', 'smallPlus', 'zoom228', 'smallMedium', 'zoom252', 'smallMediumPlus', 'zoom276', 'medium', 'zoom300', 'mediumPlus', 'zoom324', 'mediumLarge', 'zoom348', 'mediumLargePlus', 'zoom372', 'zoom384', 'zoom396', 'zoom408', 'zoom420', 'zoom432', 'zoom444', 'zoom456', 'zoom468', 'zoom480', 'zoom492', 'zoom504', 'large' ] as const;
export const defaultThumbnailSize: ThumbnailSize = 'small';
export const thumbnailDimensions: Record<ThumbnailSize, {
  width: number;
  height: number;
}> = {
  extraSmallMinus: { width: 96, height: 64 },
  zoom108: { width: 108, height: 72 },
  zoom120: { width: 120, height: 80 },
  zoom132: { width: 132, height: 88 },
  extraSmall: { width: 144, height: 96 },
  zoom156: { width: 156, height: 104 },
  extraSmallPlus: { width: 168, height: 112 },
  zoom180: { width: 180, height: 120 },
  small: { width: 192, height: 128 },
  zoom204: { width: 204, height: 136 },
  smallPlus: { width: 216, height: 144 },
  zoom228: { width: 228, height: 152 },
  smallMedium: { width: 240, height: 160 },
  zoom252: { width: 252, height: 168 },
  smallMediumPlus: { width: 264, height: 176 },
  zoom276: { width: 276, height: 184 },
  medium: { width: 288, height: 192 },
  zoom300: { width: 300, height: 200 },
  mediumPlus: { width: 312, height: 208 },
  zoom324: { width: 324, height: 216 },
  mediumLarge: { width: 336, height: 224 },
  zoom348: { width: 348, height: 232 },
  mediumLargePlus: { width: 360, height: 240 },
  zoom372: { width: 372, height: 248 },
  zoom384: { width: 384, height: 256 },
  zoom396: { width: 396, height: 264 },
  zoom408: { width: 408, height: 272 },
  zoom420: { width: 420, height: 280 },
  zoom432: { width: 432, height: 288 },
  zoom444: { width: 444, height: 296 },
  zoom456: { width: 456, height: 304 },
  zoom468: { width: 468, height: 312 },
  zoom480: { width: 480, height: 320 },
  zoom492: { width: 492, height: 328 },
  zoom504: { width: 504, height: 336 },
  large: { width: 512, height: 341 }
};
export const getThumbnailSize = (width?: number, height?: number): ThumbnailSize => {
  const match = Object.entries(thumbnailDimensions).find(([, dimensions]) => dimensions.width === width && dimensions.height === height);
  return (match?.[0] as ThumbnailSize | undefined) ?? 'small';
};
export const defaultThumbWidth = 192;
export const defaultThumbHeight = 128;
export interface AppConfigV1 {
  version: 1;
  gallery: AppConfigV1Gallery;
  system: AppConfigV1System;
}
export interface AppConfigV1Gallery {
  locations: string[];
  thumbWidth?: number;
  thumbHeight?: number;
  sortBy?: 'date' | 'name' | 'size';
  sortDir?: 'asc' | 'desc';
  selectedLocation?: string;
}
export interface AppConfigV1System {
  minimiseOnStart: boolean;
  theme?: 'dark' | 'light';
  devToolsOpen?: boolean;
  histogramVisible?: boolean;
  exifVisible?: boolean;
  comparisonMode?: 'hdr' | 'sdr' | 'side-by-side' | 'stacked' | 'dual-side-by-side' | 'dual-stacked';
  comparisonSplit?: number;
  /** Expanded/collapsed sections in the gallery's general-settings sidebar. */
  gallerySidebarSections?: Record<string, boolean>;
  /** Expanded/collapsed sections in the image-view controls sidebar. */
  imageSidebarSections?: Record<string, boolean>;
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}
export interface CacheConfigV1 {
  version: 1;
}
export const isAppConfig: (input: unknown) => input is AppConfigV1 = (() => {
  const _io0 = (input: any): boolean =>
    1 === input.version && ('object' === typeof input.gallery && null !== input.gallery && _io1(input.gallery))
    && ('object' === typeof input.system && null !== input.system && _io2(input.system));
  const _io1 = (input: any): boolean =>
    Array.isArray(input.locations) && input.locations.every((elem: any) => 'string' === typeof elem)
    && (undefined === input.thumbWidth || 'number' === typeof input.thumbWidth)
    && (undefined === input.thumbHeight || 'number' === typeof input.thumbHeight)
    && (undefined === input.sortBy || 'date' === input.sortBy || 'name' === input.sortBy || 'size' === input.sortBy)
    && (undefined === input.sortDir || 'asc' === input.sortDir || 'desc' === input.sortDir)
    && (undefined === input.selectedLocation || 'string' === typeof input.selectedLocation);
  const _io2 = (input: any): boolean =>
    'boolean' === typeof input.minimiseOnStart
    && (undefined === input.theme || 'dark' === input.theme || 'light' === input.theme)
    && (undefined === input.devToolsOpen || 'boolean' === typeof input.devToolsOpen)
    && (undefined === input.histogramVisible || 'boolean' === typeof input.histogramVisible)
    && (undefined === input.exifVisible || 'boolean' === typeof input.exifVisible)
    && (undefined === input.comparisonMode || 'hdr' === input.comparisonMode || 'sdr' === input.comparisonMode || 'side-by-side' === input.comparisonMode || 'stacked' === input.comparisonMode || 'dual-side-by-side' === input.comparisonMode || 'dual-stacked' === input.comparisonMode)
    && (undefined === input.comparisonSplit || 'number' === typeof input.comparisonSplit && input.comparisonSplit >= 1 && input.comparisonSplit <= 99)
    && (undefined === input.gallerySidebarSections || 'object' === typeof input.gallerySidebarSections && null !== input.gallerySidebarSections && Object.values(input.gallerySidebarSections).every((elem: any) => 'boolean' === typeof elem))
    && (undefined === input.imageSidebarSections || 'object' === typeof input.imageSidebarSections && null !== input.imageSidebarSections && Object.values(input.imageSidebarSections).every((elem: any) => 'boolean' === typeof elem))
    && (undefined === input.bounds || 'object' === typeof input.bounds && null !== input.bounds && _io3(input.bounds));
  const _io3 = (input: any): boolean =>
    'number' === typeof input.x && 'number' === typeof input.y && 'number' === typeof input.width
    && 'number' === typeof input.height;
  return (input: any): input is AppConfigV1 => 'object' === typeof input && null !== input && _io0(input);
})();
export const isCacheConfig: (input: unknown) => input is CacheConfigV1 = (() => {
  const _io0 = (input: any): boolean => 1 === input.version;
  return (input: any): input is CacheConfigV1 => 'object' === typeof input && null !== input && _io0(input);
})();
