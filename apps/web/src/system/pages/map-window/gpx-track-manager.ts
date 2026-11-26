export interface GpxTrackFile { path: string; name: string; sizeBytes: number; lastModified: number; databasePath?: string; missing?: boolean; readError?: boolean; active?: boolean; color?: string; colorMode?: 'fixed' | 'track-based' | 'speed' | 'elevation'; speedPalette?: 'spectrum' | 'cool-warm' | 'viridis' | 'plasma' | 'inferno' | 'terrain' | 'custom-2' | 'custom-3'; customColor1?: string; customColor2?: string; customColor3?: string; speedMinKmh?: number; speedMaxKmh?: number; elevationMinM?: number; elevationMaxM?: number; lineStyle?: 'solid' | 'dashed' | 'dotted' | 'long-dashed' | 'short-dashed' | 'dash-dot' | 'dash-dot-dot'; lineWidth?: number; showDirection?: boolean; directionIntervalPx?: number; directionArrowSizePx?: number; directionArrowOutlineWidthPx?: number; trackShadowStrength?: number; arrowShadowStrength?: number; trackOutlineStrength?: number; directionStyle?: 'classic' | 'chevron' | 'triangle' | 'thin' | 'large-classic' | 'large-chevron' | 'large-triangle'; }

interface GpxFileEntry {
  isDirectory: boolean;
  name: string;
  path: string;
  size: number;
  modifiedAt?: number;
  createdAt?: number;
}

interface GpxFileSystem {
  dirname(path: string): Promise<string>;
  readDir(path: string): Promise<GpxFileEntry[]>;
}

export async function readGpxFileMetadata(
  fileSystem: GpxFileSystem | undefined,
  path: string
): Promise<{ size: number; modifiedAt: number } | null> {
  if (!fileSystem) return null;
  try {
    const directory = await fileSystem.dirname(path);
    const fileName = path.split(/[\\/]/).pop()?.toLowerCase();
    if (!fileName) return null;
    const entries = await fileSystem.readDir(directory);
    const file = entries.find(entry => !entry.isDirectory && entry.name.toLowerCase() === fileName);
    return file ? { size: file.size, modifiedAt: file.modifiedAt ?? file.createdAt ?? 0 } : null;
  } catch {
    return null;
  }
}

export async function findTimestampPrefixedGpxPath(
  fileSystem: GpxFileSystem | undefined,
  path: string
): Promise<string | null> {
  if (!fileSystem || !path) return null;
  try {
    const directory = await fileSystem.dirname(path);
    const storedName = path.split(/[\\/]/).pop() ?? '';
    if (!storedName || !/\.gpx$/i.test(storedName)) return null;
    const entries = await fileSystem.readDir(directory);
    const matches = entries.filter(entry => {
      if (entry.isDirectory || !/\.gpx$/i.test(entry.name)) return false;
      const separator = entry.name.indexOf('__');
      if (separator <= 0) return false;
      const prefix = entry.name.slice(0, separator);
      const datePrefix = /^\d{4}[-_.]\d{2}[-_.]\d{2}(?:[ T_-]+\d{2}[-_.]\d{2}[-_.]\d{2})?$/;
      return datePrefix.test(prefix)
        && entry.name.slice(separator + 2).toLowerCase() === storedName.toLowerCase();
    });
    // Never select an arbitrary file if more than one dated copy matches.
    return matches.length === 1 ? matches[0].path : null;
  } catch {
    return null;
  }
}

export function serializeGpxTracks(
  tracks: GpxTrackFile[],
  colors: ReadonlyArray<{ value: string }>,
  fallbackColor: string
): Array<Record<string, unknown>> {
  return tracks.filter(track => !track.path.startsWith('memory:')).map(track => ({
    path: track.path,
    name: track.name,
    sizeBytes: Number.isFinite(track.sizeBytes) ? track.sizeBytes : 0,
    lastModified: Number.isFinite(track.lastModified) ? track.lastModified : 0,
    active: track.active !== false,
    color: colors.some(item => item.value === track.color) ? track.color : fallbackColor,
    colorMode: track.colorMode === 'speed' || track.colorMode === 'elevation' || track.colorMode === 'track-based' ? track.colorMode : 'fixed',
    speedPalette: ['cool-warm', 'viridis', 'plasma', 'inferno', 'terrain', 'custom-2', 'custom-3'].includes(track.speedPalette ?? '') ? track.speedPalette : 'spectrum',
    speedMinKmh: Number.isFinite(track.speedMinKmh) ? Math.max(0, Math.min(299, track.speedMinKmh!)) : 0,
    speedMaxKmh: Number.isFinite(track.speedMaxKmh) ? Math.max(1, Math.min(300, track.speedMaxKmh!)) : 120,
    elevationMinM: Number.isFinite(track.elevationMinM) ? Math.max(-12000, Math.min(100000, track.elevationMinM!)) : 0,
    elevationMaxM: Number.isFinite(track.elevationMaxM) ? Math.max((track.elevationMinM ?? 0) + 1, Math.min(100001, track.elevationMaxM!)) : 3000,
    lineStyle: ['solid', 'dashed', 'dotted', 'long-dashed', 'short-dashed', 'dash-dot', 'dash-dot-dot'].includes(track.lineStyle ?? '') ? track.lineStyle : 'solid',
    lineWidth: [1, 2, 3, 4, 5, 6, 8, 10].includes(track.lineWidth ?? 4) ? track.lineWidth ?? 4 : 4,
    showDirection: track.showDirection === true,
    directionIntervalPx: Math.max(20, Math.min(200, Math.round((track.directionIntervalPx ?? 120) / 10) * 10)),
    directionArrowSizePx: Math.max(8, Math.min(40, track.directionArrowSizePx ?? (track.directionStyle?.startsWith('large-') ? 24 : 16))),
    directionArrowOutlineWidthPx: Math.max(0, Math.min(6, track.directionArrowOutlineWidthPx ?? 2)),
    trackShadowStrength: Math.max(0, Math.min(100, track.trackShadowStrength ?? 0)),
    arrowShadowStrength: Math.max(0, Math.min(100, track.arrowShadowStrength ?? 0)),
    trackOutlineStrength: Math.max(0, Math.min(100, track.trackOutlineStrength ?? 0)),
    directionStyle: ['classic', 'chevron', 'triangle', 'thin', 'large-classic', 'large-chevron', 'large-triangle'].includes(track.directionStyle ?? '') ? track.directionStyle : 'classic'
  }));
}
