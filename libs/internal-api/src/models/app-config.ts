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
  preferences?: AppConfigV1Preferences;
}
export interface AppConfigV1Gallery {
  locations: string[];
  /** Automatically sort favorite folders by full path when adding one. Defaults to true. */
  autoSortFavorites?: boolean;
  thumbWidth?: number;
  thumbHeight?: number;
  sortBy?: 'date' | 'gpsDate' | 'name' | 'path' | 'size';
  sortDir?: 'asc' | 'desc';
  selectedLocation?: string;
}
export type ButtonStyle = 'blue' | 'flat' | 'outlined' | 'soft' | 'rounded';
export const allButtonStyles: readonly ButtonStyle[] = ['blue', 'flat', 'outlined', 'soft', 'rounded'];

export type ButtonColor = string;


export type DisclosureStyle = 'classic' | 'plain-triangle' | 'chevron' | 'plus-minus' | 'square' | 'circle' | 'arrow' | 'caret' | 'bracket' | 'none';
export const allDisclosureStyles: readonly DisclosureStyle[] = ['classic', 'plain-triangle', 'chevron', 'plus-minus', 'square', 'circle', 'arrow', 'caret', 'bracket', 'none'];

export type TabBarStyle = 'classic' | 'underline' | 'pills' | 'segmented' | 'boxed' | 'minimal' | 'flat' | 'contrast' | 'soft' | 'rounded';
export const allTabBarStyles: readonly TabBarStyle[] = ['classic', 'underline', 'pills', 'segmented', 'boxed', 'minimal', 'flat', 'contrast', 'soft', 'rounded'];

export interface AppConfigV1Preferences {
  theme?: 'dark' | 'light';
  /** Appearance of expandable section markers. Defaults to the colored classic triangle. */
  disclosureStyle?: DisclosureStyle;
  /** Appearance of application tab bars. Defaults to the connected classic style. */
  tabBarStyle?: TabBarStyle;
  /** Global action-button appearance. Defaults to the original blue style. */
  buttonStyle?: ButtonStyle;
  /** Accent color used by action buttons and tab bars. Defaults to blue. */
  buttonColor?: ButtonColor;
  /** Saturation of the selected theme color, from 0 (grayscale) to 200 (vivid). Defaults to 100. */
  themeColorSaturation?: number;
  /** Accent color used by zoom sliders. Defaults to teal. */
  zoomSliderColor?: string;
  /** Accent color used by standard sliders, independent of the theme and zoom slider colors. */
  sliderColor?: string;
  /** Total brightness applied to themed foreground and background controls. Defaults to 100%. */
  themeTotalBrightness?: number;
  /** Brightness applied only to themed control backgrounds. Defaults to 100%. */
  themeBackgroundBrightness?: number;
  /** Legacy total-brightness setting retained for existing configuration files. */
  themeColorBrightness?: number;
  /** Progress-bar fill colors used by the gallery detail table. */
  galleryDetailDateProgressColor?: string;
  galleryDetailGpsDateProgressColor?: string;
  galleryDetailDimensionsProgressColor?: string;
  galleryDetailSizeProgressColor?: string;
  /** Background tint used for the selected gallery detail row. */
  galleryDetailSelectedRowColor?: string;
  /** Background colors for odd and even gallery detail rows. */
  galleryDetailOddRowColor?: string;
  galleryDetailEvenRowColor?: string;
  /** Background color used for gallery detail rows while the name filter is active. */
  galleryDetailFilteredRowColor?: string;
  /** Whether the gallery detail table alternates odd/even row colors. */
  galleryDetailAlternateRowColors?: boolean;
  /** Per-column visibility switches for gallery detail progress bars. */
  galleryDetailDateProgressEnabled?: boolean;
  galleryDetailGpsDateProgressEnabled?: boolean;
  galleryDetailDimensionsProgressEnabled?: boolean;
  galleryDetailSizeProgressEnabled?: boolean;
  /** Progress-bar background opacity in percent (0-100). */
  galleryDetailProgressTransparency?: number;
}

export interface AppConfigV1System {
  minimiseOnStart: boolean;
  theme?: 'dark' | 'light';
  /** Legacy setting migrated to preferences.buttonStyle when loading older configurations. */
  flatStandardButtons?: boolean;
  devToolsOpen?: boolean;
  histogramVisible?: boolean;
  exifVisible?: boolean;
  comparisonMode?: 'hdr' | 'sdr' | 'side-by-side' | 'stacked' | 'dual-side-by-side' | 'dual-stacked';
  comparisonSplit?: number;
  /** Expanded/collapsed sections in the gallery's general-settings sidebar. */
  gallerySidebarSections?: Record<string, boolean>;
  /** Left/right position of the gallery detail-table and favorites-folder actions column. */
  galleryDetailActionsColumnPosition?: 'left' | 'right';
  /** Expanded/collapsed sections in the image-view controls sidebar. */
  imageSidebarSections?: Record<string, boolean>;
  /** Reusable GPX track appearance presets shown in the Track Settings dialog. */
  gpxTrackSettingsFavorites?: Array<{ name: string; settings: Record<string, unknown> }>;
  /** Reusable gallery detail-table appearance presets shown in the Preferences dialog. */
  galleryDetailPreferencesFavorites?: Array<{ name: string; settings: Record<string, unknown> }>;
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
    && ('object' === typeof input.system && null !== input.system && _io2(input.system))
    && (undefined === input.preferences || 'object' === typeof input.preferences && null !== input.preferences && _io4(input.preferences));
  const _io1 = (input: any): boolean =>
    Array.isArray(input.locations) && input.locations.every((elem: any) => 'string' === typeof elem)
    && (undefined === input.autoSortFavorites || 'boolean' === typeof input.autoSortFavorites)
    && (undefined === input.thumbWidth || 'number' === typeof input.thumbWidth)
    && (undefined === input.thumbHeight || 'number' === typeof input.thumbHeight)
    && (undefined === input.sortBy || 'date' === input.sortBy || 'gpsDate' === input.sortBy || 'name' === input.sortBy || 'path' === input.sortBy || 'size' === input.sortBy)
    && (undefined === input.sortDir || 'asc' === input.sortDir || 'desc' === input.sortDir)
    && (undefined === input.selectedLocation || 'string' === typeof input.selectedLocation);
  const _io2 = (input: any): boolean =>
    'boolean' === typeof input.minimiseOnStart
    && (undefined === input.theme || 'dark' === input.theme || 'light' === input.theme)
    && (undefined === input.flatStandardButtons || 'boolean' === typeof input.flatStandardButtons)
    && (undefined === input.devToolsOpen || 'boolean' === typeof input.devToolsOpen)
    && (undefined === input.histogramVisible || 'boolean' === typeof input.histogramVisible)
    && (undefined === input.exifVisible || 'boolean' === typeof input.exifVisible)
    && (undefined === input.comparisonMode || 'hdr' === input.comparisonMode || 'sdr' === input.comparisonMode || 'side-by-side' === input.comparisonMode || 'stacked' === input.comparisonMode || 'dual-side-by-side' === input.comparisonMode || 'dual-stacked' === input.comparisonMode)
    && (undefined === input.comparisonSplit || 'number' === typeof input.comparisonSplit && input.comparisonSplit >= 1 && input.comparisonSplit <= 99)
    && (undefined === input.gallerySidebarSections || 'object' === typeof input.gallerySidebarSections && null !== input.gallerySidebarSections && Object.values(input.gallerySidebarSections).every((elem: any) => 'boolean' === typeof elem))
    && (undefined === input.imageSidebarSections || 'object' === typeof input.imageSidebarSections && null !== input.imageSidebarSections && Object.values(input.imageSidebarSections).every((elem: any) => 'boolean' === typeof elem))
    && (undefined === input.gpxTrackSettingsFavorites || Array.isArray(input.gpxTrackSettingsFavorites) && input.gpxTrackSettingsFavorites.every((elem: any) => 'object' === typeof elem && null !== elem && 'string' === typeof elem.name && 'object' === typeof elem.settings && null !== elem.settings && !Array.isArray(elem.settings)))
    && (undefined === input.galleryDetailPreferencesFavorites || Array.isArray(input.galleryDetailPreferencesFavorites) && input.galleryDetailPreferencesFavorites.every((elem: any) => 'object' === typeof elem && null !== elem && 'string' === typeof elem.name && 'object' === typeof elem.settings && null !== elem.settings && !Array.isArray(elem.settings)))
    && (undefined === input.bounds || 'object' === typeof input.bounds && null !== input.bounds && _io3(input.bounds));
  const _io3 = (input: any): boolean =>
    'number' === typeof input.x && 'number' === typeof input.y && 'number' === typeof input.width
    && 'number' === typeof input.height;
  const _io4 = (input: any): boolean =>
    (undefined === input.theme || 'dark' === input.theme || 'light' === input.theme)
    && (undefined === input.buttonStyle || 'blue' === input.buttonStyle || 'flat' === input.buttonStyle || 'outlined' === input.buttonStyle || 'soft' === input.buttonStyle || 'rounded' === input.buttonStyle)
    && (undefined === input.buttonColor || 'blue' === input.buttonColor || 'cyan' === input.buttonColor || 'green' === input.buttonColor || 'teal' === input.buttonColor || 'orange' === input.buttonColor || 'red' === input.buttonColor || 'purple' === input.buttonColor || 'gray' === input.buttonColor || typeof input.buttonColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.buttonColor))
    && (undefined === input.themeColorSaturation || 'number' === typeof input.themeColorSaturation && input.themeColorSaturation >= 0 && input.themeColorSaturation <= 200)
    && (undefined === input.zoomSliderColor || typeof input.zoomSliderColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.zoomSliderColor))
    && (undefined === input.sliderColor || typeof input.sliderColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.sliderColor))
    && (undefined === input.themeTotalBrightness || 'number' === typeof input.themeTotalBrightness && input.themeTotalBrightness >= 50 && input.themeTotalBrightness <= 150)
    && (undefined === input.themeBackgroundBrightness || 'number' === typeof input.themeBackgroundBrightness && input.themeBackgroundBrightness >= 50 && input.themeBackgroundBrightness <= 150)
    && (undefined === input.themeColorBrightness || 'number' === typeof input.themeColorBrightness && input.themeColorBrightness >= 50 && input.themeColorBrightness <= 150)
    && (undefined === input.galleryDetailDateProgressColor || typeof input.galleryDetailDateProgressColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.galleryDetailDateProgressColor))
    && (undefined === input.galleryDetailGpsDateProgressColor || typeof input.galleryDetailGpsDateProgressColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.galleryDetailGpsDateProgressColor))
    && (undefined === input.galleryDetailDimensionsProgressColor || typeof input.galleryDetailDimensionsProgressColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.galleryDetailDimensionsProgressColor))
    && (undefined === input.galleryDetailSizeProgressColor || typeof input.galleryDetailSizeProgressColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.galleryDetailSizeProgressColor))
    && (undefined === input.galleryDetailSelectedRowColor || typeof input.galleryDetailSelectedRowColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.galleryDetailSelectedRowColor))
    && (undefined === input.galleryDetailOddRowColor || typeof input.galleryDetailOddRowColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.galleryDetailOddRowColor))
    && (undefined === input.galleryDetailEvenRowColor || typeof input.galleryDetailEvenRowColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.galleryDetailEvenRowColor))
    && (undefined === input.galleryDetailFilteredRowColor || typeof input.galleryDetailFilteredRowColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.galleryDetailFilteredRowColor))
    && (undefined === input.galleryDetailAlternateRowColors || typeof input.galleryDetailAlternateRowColors === 'boolean')
    && (undefined === input.galleryDetailDateProgressEnabled || typeof input.galleryDetailDateProgressEnabled === 'boolean')
    && (undefined === input.galleryDetailGpsDateProgressEnabled || typeof input.galleryDetailGpsDateProgressEnabled === 'boolean')
    && (undefined === input.galleryDetailDimensionsProgressEnabled || typeof input.galleryDetailDimensionsProgressEnabled === 'boolean')
    && (undefined === input.galleryDetailSizeProgressEnabled || typeof input.galleryDetailSizeProgressEnabled === 'boolean')
    && (undefined === input.galleryDetailProgressTransparency || typeof input.galleryDetailProgressTransparency === 'number' && input.galleryDetailProgressTransparency >= 0 && input.galleryDetailProgressTransparency <= 100)
    && (undefined === input.disclosureStyle || 'classic' === input.disclosureStyle || 'plain-triangle' === input.disclosureStyle || 'chevron' === input.disclosureStyle || 'plus-minus' === input.disclosureStyle || 'square' === input.disclosureStyle || 'circle' === input.disclosureStyle || 'arrow' === input.disclosureStyle || 'caret' === input.disclosureStyle || 'bracket' === input.disclosureStyle || 'none' === input.disclosureStyle)
    && (undefined === input.tabBarStyle || 'classic' === input.tabBarStyle || 'underline' === input.tabBarStyle || 'pills' === input.tabBarStyle || 'segmented' === input.tabBarStyle || 'boxed' === input.tabBarStyle || 'minimal' === input.tabBarStyle || 'flat' === input.tabBarStyle || 'contrast' === input.tabBarStyle || 'soft' === input.tabBarStyle || 'rounded' === input.tabBarStyle);
  return (input: any): input is AppConfigV1 => 'object' === typeof input && null !== input && _io0(input);
})();
export const isCacheConfig: (input: unknown) => input is CacheConfigV1 = (() => {
  const _io0 = (input: any): boolean => 1 === input.version;
  return (input: any): input is CacheConfigV1 => 'object' === typeof input && null !== input && _io0(input);
})();
