export type GpxRenderDirectionStyle = 'classic' | 'chevron' | 'triangle' | 'thin' | 'large-classic' | 'large-chevron' | 'large-triangle';

export interface GpxRenderSettings {
  lineWidth?: number;
  lineStyle?: string;
  trackOutlineStrength?: number;
  trackShadowStrength?: number;
  showDirection?: boolean;
  directionStyle?: GpxRenderDirectionStyle;
  directionIntervalPx?: number;
  directionArrowSizePx?: number;
  directionArrowOutlineWidthPx?: number;
  arrowShadowStrength?: number;
}

export interface GpxRenderStyle {
  lineWidth: number;
  lineOpacity: number;
  lineDashArray?: string;
  outlineColor: string;
  outlineWidth: number;
  outlineOpacity: number;
  shadowColor: string;
  shadowWidth: number;
  shadowBlur: number;
  shadowOpacity: number;
  arrowGlyph: string;
  arrowSize: number;
  arrowInterval: number;
  arrowOutlineColor: string;
  arrowOutlineWidth: number;
  arrowOpacity: number;
  arrowShadowColor: string;
  arrowShadowBlur: number;
  arrowShadowOffset: number;
  arrowShadowOpacity: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));

const DASHES: Record<string, string | undefined> = {
  solid: undefined,
  dashed: '10 7',
  dotted: '2 7',
  'long-dashed': '18 7',
  'short-dashed': '5 5',
  'dash-dot': '12 5 2 5',
  'dash-dot-dot': '12 4 2 4 2 4'
};

export function createGpxTrackRenderStyle(settings: GpxRenderSettings, opacityPercent = 100): GpxRenderStyle {
  const opacity = clamp(opacityPercent, 0, 100) / 100;
  const outline = clamp(settings.trackOutlineStrength ?? 0, 0, 100) / 100;
  const shadow = clamp(settings.trackShadowStrength ?? 0, 0, 100) / 100;
  const arrowShadow = clamp(settings.arrowShadowStrength ?? 0, 0, 100) / 100;
  const directionStyle = settings.directionStyle ?? 'classic';
  const glyph = directionStyle === 'chevron' || directionStyle === 'large-chevron' ? '❯'
    : directionStyle === 'triangle' || directionStyle === 'large-triangle' ? '▶'
    : directionStyle === 'thin' ? '➜' : '➤';
  return {
    lineWidth: clamp(settings.lineWidth ?? 4, 1, 32),
    lineOpacity: 0.92 * opacity,
    lineDashArray: DASHES[settings.lineStyle ?? 'solid'],
    outlineColor: '#080808',
    outlineWidth: clamp(settings.lineWidth ?? 4, 1, 32) + 2,
    outlineOpacity: 0.92 * opacity * outline,
    shadowColor: '#000000',
    shadowWidth: clamp(settings.lineWidth ?? 4, 1, 32) + 4,
    shadowBlur: 2,
    shadowOpacity: 0.8 * opacity * shadow,
    arrowGlyph: glyph,
    arrowSize: clamp(settings.directionArrowSizePx ?? (directionStyle.startsWith('large-') ? 24 : 18), 8, 40),
    arrowInterval: clamp(settings.directionIntervalPx ?? 120, 20, 200),
    arrowOutlineColor: '#000000',
    arrowOutlineWidth: clamp(settings.directionArrowOutlineWidthPx ?? 2, 0, 6),
    arrowOpacity: 0.92 * opacity,
    arrowShadowColor: '#000000',
    arrowShadowBlur: 2,
    arrowShadowOffset: 0.35,
    arrowShadowOpacity: arrowShadow * opacity
  };
}
