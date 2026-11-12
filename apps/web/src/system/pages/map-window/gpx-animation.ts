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
  car: '🚗', carFront: '🚘', suv: '🚙',
  taxi: '🚕', taxiFront: '🚖', autoRickshaw: '🛺',
  racecar: '🏎️', van: '🚐', pickup: '🛻',
  ambulance: '🚑', police: '🚓', policeFront: '🚔', firetruck: '🚒',
  bus: '🚌', busFront: '🚍', trolleybus: '🚎',
  truck: '🚚', delivery: '🚛', tractor: '🚜',
  plane: '✈️', smallPlane: '🛩️', helicopter: '🚁', flyingSaucer: '🛸',
  train: '🚆', locomotive: '🚂', railCar: '🚃', tram: '🚋',
  mountainRailway: '🚞', monorail: '🚝', highSpeedTrain: '🚄',
  bulletTrain: '🚅', lightRail: '🚈', metro: '🚇',
  bicycle: '🚲', motorcycle: '🏍️', scooter: '🛵',
  boat: '🚤', motorYacht: '🛥️', ferry: '⛴️', cruiseShip: '🛳️',
  canoe: '🛶', ship: '🚢', sailboat: '⛵', cableCar: '🚡', rocket: '🚀'
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

/**
 * Converts compass bearings (0° north, 90° east) to each glyph's artwork axis.
 * Side-view vehicle emoji in Segoe UI Emoji face left, so +90° aligns them
 * with a northbound heading. Front-facing and top-down glyphs already point up.
 */
const GPX_SYMBOL_ORIENTATION_OFFSETS: Readonly<Record<string, number>> = {
  walker: 0,
  carFront: 0, taxiFront: 0, policeFront: 0, busFront: 0,
  plane: 0, smallPlane: 0, helicopter: 0, flyingSaucer: 0,
  bicycle: 90, motorcycle: 90, scooter: 90,
  boat: 0, motorYacht: 0, ferry: 0, cruiseShip: 0, canoe: 0, ship: 0, sailboat: 0,
  cableCar: 0, rocket: 0
};

export function gpxSymbolOrientationOffset(figureType: string): number {
  return Object.hasOwn(GPX_SYMBOL_ORIENTATION_OFFSETS, figureType)
    ? GPX_SYMBOL_ORIENTATION_OFFSETS[figureType]
    : 90;
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
  const flipVertical = false;
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
