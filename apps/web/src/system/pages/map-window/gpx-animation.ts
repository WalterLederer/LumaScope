export interface GpxSymbolSettings {
  rotation: number;
  flipHorizontal: boolean;
}

export interface GpxSymbolTransformOptions {
  figureType: string;
  bearing: number;
  settings: GpxSymbolSettings;
  size?: number;
  autoFlipDirection?: boolean;
}

export const GPX_VEHICLE_SYMBOLS: Readonly<Record<string, string>> = {
  car: '🚗', taxi: '🚕', racecar: '🏎️', van: '🚐', pickup: '🛻',
  ambulance: '🚑', police: '🚓', firetruck: '🚒', bus: '🚌',
  truck: '🚚', delivery: '🚛', plane: '✈️', helicopter: '🚁',
  train: '🚆', bicycle: '🚲', motorcycle: '🏍️', scooter: '🛵',
  tractor: '🚜', boat: '🚤', ship: '🚢', sailboat: '⛵', rocket: '🚀'
};

export const GPX_SYMBOLS: Readonly<Record<string, string>> = {
  walker: '🚶',
  ...GPX_VEHICLE_SYMBOLS
};

export function normalizeGpxSymbolSettings(
  value: Record<string, Partial<GpxSymbolSettings> & { flipVertical?: boolean }>
): Record<string, GpxSymbolSettings> {
  const result: Record<string, GpxSymbolSettings> = {};
  for (const [symbol, settings] of Object.entries(value)) {
    const rotation = Number(settings?.rotation ?? 0);
    result[symbol] = {
      rotation: Number.isFinite(rotation) ? ((Math.round(rotation) % 360) + 360) % 360 : 0,
      flipHorizontal: settings?.flipHorizontal === true || settings?.flipVertical === true
    };
  }
  return result;
}

/** Converts a compass bearing (0° north, 90° east) to the artwork's local axis. */
export function gpxSymbolOrientationOffset(figureType: string): number {
  return figureType === 'walker' ? 0 : -90;
}

/** Returns one canonical CSS transform for preview, Leaflet and MapLibre DOM markers. */
export function buildGpxSymbolTransform(options: GpxSymbolTransformOptions): string {
  const {
    figureType, bearing, settings, size = 1,
    autoFlipDirection = false
  } = options;
  const rotation = gpxSymbolOrientationOffset(figureType) + settings.rotation;
  // Compass bearings use 90° for east and 270° for west. Mirror the artwork
  // when its direction points left, then apply the user's per-symbol correction.
  const movingLeft = Math.sin(bearing * Math.PI / 180) < -0.01;
  const flipHorizontal = autoFlipDirection
    ? settings.flipHorizontal !== movingLeft
    : settings.flipHorizontal;
  const flipVertical = figureType !== 'walker';
  return [
    `rotate(${bearing + rotation}deg)`,
    flipVertical ? 'scaleY(-1)' : '',
    flipHorizontal ? 'scaleX(-1)' : '',
    `scale(${size})`
  ].filter(Boolean).join(' ');
}

export function gpxAnimationDuration(speed: number): string {
  return `${0.72 / Math.max(0.01, speed)}s`;
}
