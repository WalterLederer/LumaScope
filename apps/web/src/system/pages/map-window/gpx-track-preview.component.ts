import { createGpxTrackRenderStyle } from './gpx-track-render-style';
import { Component, input } from '@angular/core';

export interface GpxTrackPreviewData {
  path: string;
  color?: string;
  colorMode?: 'fixed' | 'track-based' | 'speed' | 'elevation';
  speedPalette?: string;
  customColor1?: string;
  customColor2?: string;
  customColor3?: string;
  speedMinKmh?: number;
  speedMaxKmh?: number;
  elevationMinM?: number;
  elevationMaxM?: number;
  lineStyle?: string;
  lineWidth?: number;
  trackOutlineStrength?: number;
  trackShadowStrength?: number;
  showDirection?: boolean;
  directionStyle?: 'classic' | 'chevron' | 'triangle' | 'thin' | 'large-classic' | 'large-chevron' | 'large-triangle';
  directionIntervalPx?: number;
  directionArrowSizePx?: number;
  directionArrowOutlineWidthPx?: number;
  arrowShadowStrength?: number;
}

@Component({
  selector: 'app-gpx-track-preview',
  standalone: true,
  styles: [':host{display:block;min-width:0;}'],
  template: `
    <div class="gpx-track-style-preview" [class.gpx-track-settings-preview]="variant() === 'settings'">
      <svg viewBox="0 0 150 24" aria-hidden="true">
        <defs>
          <linearGradient [attr.id]="gradientId()" x1="0" y1="0" x2="1" y2="0">
            @for (stop of colorStops(); track stop.offset) {
              <stop [attr.offset]="stop.offset" [attr.stop-color]="stop.color"/>
            }
          </linearGradient>
        </defs>
        <path d="M3 17 L22 6 L42 14 L62 5 L82 16 L102 7 L122 15 L147 5"
          fill="none" stroke="#080808"
          [attr.stroke-width]="renderStyle().outlineWidth"
          [attr.stroke-opacity]="renderStyle().outlineOpacity"
          [attr.stroke-dasharray]="dashPattern()" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M3 17 L22 6 L42 14 L62 5 L82 16 L102 7 L122 15 L147 5"
          fill="none" stroke="#000000"
          [attr.stroke-width]="renderStyle().shadowWidth + 4"
          [attr.stroke-opacity]="Math.min(1, renderStyle().shadowOpacity * 1.2)"
          [style.filter]="'blur(' + Math.max(0.75, renderStyle().shadowBlur * 0.75) + 'px)'"
          [attr.stroke-dasharray]="dashPattern()" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M3 17 L22 6 L42 14 L62 5 L82 16 L102 7 L122 15 L147 5"
          fill="none"
          [attr.stroke]="track().colorMode === 'speed' || track().colorMode === 'elevation' || track().colorMode === 'track-based' ? 'url(#' + gradientId() + ')' : (track().color || '#3388ff')"
          [attr.stroke-width]="renderStyle().lineWidth"
          [attr.stroke-opacity]="renderStyle().lineOpacity"
          [attr.stroke-dasharray]="dashPattern()" stroke-linecap="round" stroke-linejoin="round"/>
        @if (track().showDirection) {
          @for (arrow of arrowPositions(); track $index) {
            <text class="gpx-preview-direction-arrow" text-anchor="middle" dominant-baseline="central"
              [attr.x]="arrow.x" [attr.y]="arrow.y"
              [attr.font-size]="renderStyle().arrowSize"
              [attr.fill]="track().colorMode === 'speed' || track().colorMode === 'elevation' || track().colorMode === 'track-based' ? 'url(#' + gradientId() + ')' : (track().color || '#3388ff')"
              [attr.stroke]="renderStyle().arrowOutlineColor"
              [attr.stroke-width]="renderStyle().arrowOutlineWidth"
              [style.paint-order]="'stroke fill'"
              [attr.opacity]="renderStyle().arrowOpacity"
              [style.filter]="arrowShadowFilter()"
              [attr.transform]="'rotate(' + arrow.angle + ' ' + arrow.x + ' ' + arrow.y + ')'">{{ arrowGlyph() }}</text>
          }
        }
      </svg>
      <span>{{ description() }}</span>
    </div>
  `
})
export class GpxTrackPreviewComponent {
  readonly track = input.required<GpxTrackPreviewData>();
  readonly opacity = input(100);
  readonly variant = input<'list' | 'settings'>('list');

  readonly renderStyle = () => createGpxTrackRenderStyle(this.track(), this.opacity());
  readonly arrowShadowFilter = (): string => { const style = this.renderStyle(); return style.arrowShadowOpacity > 0 ? 'drop-shadow(' + style.arrowShadowOffset + 'px ' + style.arrowShadowOffset + 'px ' + style.arrowShadowBlur + 'px rgba(0,0,0,' + style.arrowShadowOpacity + '))' : 'none'; };

  readonly gradientId = () => 'gpx-preview-' + this.variant() + '-' + this.pathId(this.track().path);

  readonly colorStops = (): Array<{ offset: string; color: string }> => {
    const track = this.track();
    if (track.colorMode === 'track-based') {
      return [{ offset: '0%', color: '#e53935' }, { offset: '33.32%', color: '#e53935' }, { offset: '33.34%', color: '#1e88e5' }, { offset: '66.65%', color: '#1e88e5' }, { offset: '66.67%', color: '#43a047' }, { offset: '100%', color: '#43a047' }];
    }
    if (track.speedPalette === 'custom-2') {
      return [{ offset: '0%', color: track.customColor1 || '#2878ff' }, { offset: '100%', color: track.customColor3 || '#f04444' }];
    }
    if (track.speedPalette === 'custom-3') {
      return [{ offset: '0%', color: track.customColor1 || '#2878ff' }, { offset: '50%', color: track.customColor2 || '#18c99a' }, { offset: '100%', color: track.customColor3 || '#f04444' }];
    }
    const palettes: Record<string, Array<{ offset: string; color: string }>> = {
      'cool-warm': [{ offset: '0%', color: '#2573be' }, { offset: '50%', color: '#46beaa' }, { offset: '100%', color: '#dc4637' }],
      viridis: [{ offset: '0%', color: '#440154' }, { offset: '25%', color: '#3b528b' }, { offset: '50%', color: '#21918c' }, { offset: '75%', color: '#5ec962' }, { offset: '100%', color: '#fde725' }],
      plasma: [{ offset: '0%', color: '#0d0887' }, { offset: '25%', color: '#7e03a8' }, { offset: '50%', color: '#cc4778' }, { offset: '75%', color: '#f89540' }, { offset: '100%', color: '#f0f921' }],
      inferno: [{ offset: '0%', color: '#000004' }, { offset: '25%', color: '#57106e' }, { offset: '50%', color: '#bc3754' }, { offset: '75%', color: '#f98e09' }, { offset: '100%', color: '#fcffa4' }],
      terrain: [{ offset: '0%', color: '#183a8f' }, { offset: '25%', color: '#27a9c2' }, { offset: '50%', color: '#4caf50' }, { offset: '75%', color: '#d8c66a' }, { offset: '100%', color: '#8c4b2d' }],
      spectrum: [{ offset: '0%', color: '#285adc' }, { offset: '25%', color: '#00bedc' }, { offset: '50%', color: '#28be5a' }, { offset: '75%', color: '#ffd200' }, { offset: '100%', color: '#eb2d23' }]
    };
    return palettes[track.speedPalette ?? 'spectrum'] ?? palettes['spectrum'];
  };

  readonly dashPattern = (): string => this.renderStyle().lineDashArray ?? '';

  readonly arrowGlyph = (): string => this.renderStyle().arrowGlyph;

  readonly arrowSize = (): number => this.renderStyle().arrowSize;

  readonly arrowPositions = (): Array<{ x: number; y: number; angle: number }> => {
    const points: Array<[number, number]> = [[3, 17], [22, 6], [42, 14], [62, 5], [82, 16], [102, 7], [122, 15], [147, 5]];
    const total = points.slice(1).reduce((sum, point, index) => sum + Math.hypot(point[0] - points[index][0], point[1] - points[index][1]), 0);
    const spacing = this.renderStyle().arrowInterval;
    const result: Array<{ x: number; y: number; angle: number }> = [];
    for (let distance = spacing; distance < total - 2; distance += spacing) {
      let remaining = distance;
      for (let i = 1; i < points.length; i++) {
        const start = points[i - 1], end = points[i];
        const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
        if (remaining <= length) {
          const fraction = remaining / length;
          result.push({ x: start[0] + (end[0] - start[0]) * fraction, y: start[1] + (end[1] - start[1]) * fraction, angle: Math.atan2(end[1] - start[1], end[0] - start[0]) * 180 / Math.PI });
          break;
        }
        remaining -= length;
      }
    }
    return result;
  };

  readonly shadowFilter = (strength?: number): string => this.arrowShadowFilter();

  readonly description = (): string => {
    const track = this.track();
    return track.colorMode === 'speed'
      ? 'Speed ' + (track.speedMinKmh ?? 0) + '–' + (track.speedMaxKmh ?? 120) + ' km/h · ' + (track.lineWidth || 4) + ' px'
      : track.colorMode === 'elevation'
        ? 'Elevation ' + (track.elevationMinM ?? 0) + '–' + (track.elevationMaxM ?? 3000) + ' m · ' + (track.lineWidth || 4) + ' px'
        : (track.color || '#3388ff') + ' · ' + (track.lineWidth || 4) + ' px';
  };

  private readonly pathId = (path: string): string => {
    let hash = 0;
    for (let i = 0; i < path.length; i++) hash = (hash * 31 + path.charCodeAt(i)) | 0;
    return Math.abs(hash).toString(36);
  };
}
