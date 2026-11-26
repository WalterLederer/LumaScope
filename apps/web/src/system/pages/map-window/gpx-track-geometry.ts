export type GpxCoordinate = [number, number];

export interface GpxGeometryPoint {
  latitude: number;
  longitude: number;
  timestamp: string | null;
  inViewport?: boolean;
}

export interface GpxViewportBounds {
  south: number;
  north: number;
  west: number;
  east: number;
}

export interface GpxViewportChunk {
  coordinates: GpxCoordinate[];
  sourceSegmentIndex: number;
  south: number;
  north: number;
  west: number;
  east: number;
  totalLength: number;
}

export interface GpxViewportChunkCache {
  source: GpxCoordinate[][];
  chunks: GpxViewportChunk[];
  totalLength: number;
}

export function getVisibleGpxSegments(
  source: GpxCoordinate[][],
  pointSegments: GpxGeometryPoint[][],
  databaseTrack: boolean,
  timeRange: { start: number; end: number } | null
): GpxCoordinate[][] {
  if (!timeRange) return source;
  const visible: GpxCoordinate[][] = [];
  source.forEach((sourceSegment, index) => {
    const segment = pointSegments[index];
    if (databaseTrack && !segment?.some(point => {
      const timestamp = point.timestamp ? Date.parse(point.timestamp) / 1000 : null;
      return point.inViewport !== false && (timestamp === null || !Number.isFinite(timestamp)
        || (timestamp >= timeRange.start && timestamp <= timeRange.end));
    })) return;
    // Routes without timestamps (e.g. routes returned by openrouteservice)
    // are independent of the GPX time slider and must remain visible.
    if (!segment?.some(point => point.timestamp && Number.isFinite(Date.parse(point.timestamp)))) {
      if (sourceSegment.length >= 2) visible.push(sourceSegment);
      return;
    }
    let run: GpxCoordinate[] = [];
    const flush = (): void => { if (run.length >= 2) visible.push(run); run = []; };
    for (const point of segment) {
      const timestamp = point.timestamp ? Date.parse(point.timestamp) / 1000 : Number.NaN;
      if (!Number.isFinite(timestamp) || (timestamp >= timeRange.start && timestamp <= timeRange.end)) {
        run.push([point.latitude, point.longitude]);
      } else flush();
    }
    flush();
  });
  return visible;
}

export async function buildGpxViewportChunkCache(segments: GpxCoordinate[][]): Promise<GpxViewportChunkCache> {
  const chunks: GpxViewportChunk[] = [];
  let totalLength = 0;
  const chunkPointCount = 256;
  let processedChunks = 0;
  for (let sourceSegmentIndex = 0; sourceSegmentIndex < segments.length; sourceSegmentIndex++) {
    const source = segments[sourceSegmentIndex];
    if (!source || source.length < 2) continue;
    for (let start = 0; start < source.length - 1; start += chunkPointCount - 1) {
      const coordinates = source.slice(start, Math.min(source.length, start + chunkPointCount));
      if (coordinates.length < 2) continue;
      let south = Number.POSITIVE_INFINITY, north = Number.NEGATIVE_INFINITY;
      let west = Number.POSITIVE_INFINITY, east = Number.NEGATIVE_INFINITY;
      let chunkLength = 0;
      for (let i = 0; i < coordinates.length; i++) {
        const [latitude, longitude] = coordinates[i];
        south = Math.min(south, latitude); north = Math.max(north, latitude);
        west = Math.min(west, longitude); east = Math.max(east, longitude);
        if (i > 0) {
          const [previousLatitude, previousLongitude] = coordinates[i - 1];
          const radians = Math.PI / 180;
          const dLat = (latitude - previousLatitude) * radians;
          const dLon = (longitude - previousLongitude) * radians;
          const meanLat = (latitude + previousLatitude) * 0.5 * radians;
          const a = Math.sin(dLat * 0.5) ** 2 + Math.cos(meanLat) ** 2 * Math.sin(dLon * 0.5) ** 2;
          chunkLength += 6371008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
        }
      }
      totalLength += chunkLength;
      chunks.push({ coordinates, sourceSegmentIndex, south, north, west, east, totalLength: chunkLength });
      // Yield regularly so preparing a very long track never monopolizes the UI thread.
      if (++processedChunks % 128 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  }
  return { source: segments, chunks, totalLength };
}

export function selectGpxViewportChunks(
  cache: GpxViewportChunkCache,
  bounds: GpxViewportBounds | null
): Array<{ coordinates: GpxCoordinate[]; sourceSegmentIndex: number }> {
  if (!bounds) return cache.chunks.map(chunk => ({ coordinates: chunk.coordinates, sourceSegmentIndex: chunk.sourceSegmentIndex }));
  // A small margin avoids visible gaps while panning and retains nearby geometry just outside the viewport.
  const latitudePadding = Math.max(0.0005, (bounds.north - bounds.south) * 0.05);
  const longitudePadding = Math.max(0.0005, (bounds.east - bounds.west) * 0.05);
  const minLatitude = bounds.south - latitudePadding, maxLatitude = bounds.north + latitudePadding;
  const minLongitude = bounds.west - longitudePadding, maxLongitude = bounds.east + longitudePadding;
  return cache.chunks
    .filter(chunk => chunk.north >= minLatitude && chunk.south <= maxLatitude
      && chunk.east >= minLongitude && chunk.west <= maxLongitude)
    .map(chunk => ({ coordinates: chunk.coordinates, sourceSegmentIndex: chunk.sourceSegmentIndex }));
}

export function clippedGpxSegmentLength(
  a: GpxCoordinate,
  b: GpxCoordinate,
  south: number,
  north: number,
  west: number,
  east: number
): number {
  const dLat = b[0] - a[0], dLon = b[1] - a[1];
  let t0 = 0, t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const ratio = q / p;
    if (p < 0) { if (ratio > t1) return false; if (ratio > t0) t0 = ratio; }
    else { if (ratio < t0) return false; if (ratio < t1) t1 = ratio; }
    return true;
  };
  if (!clip(-dLon, a[1] - west) || !clip(dLon, east - a[1]) || !clip(-dLat, a[0] - south) || !clip(dLat, north - a[0]) || t1 <= t0) return 0;
  const latitude1 = a[0] + dLat * t0, latitude2 = a[0] + dLat * t1;
  const longitude1 = a[1] + dLon * t0, longitude2 = a[1] + dLon * t1;
  const radians = Math.PI / 180;
  const deltaLatitude = (latitude2 - latitude1) * radians;
  const deltaLongitude = (longitude2 - longitude1) * radians;
  const meanLatitude = (latitude1 + latitude2) * 0.5 * radians;
  const haversine = Math.sin(deltaLatitude * 0.5) ** 2 + Math.cos(meanLatitude) ** 2 * Math.sin(deltaLongitude * 0.5) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(Math.max(0, 1 - haversine)));
}

export function calculateGpxRenderedPercent(cache: GpxViewportChunkCache, bounds: GpxViewportBounds): number {
  let visibleLength = 0;
  for (const chunk of cache.chunks) {
    if (chunk.north < bounds.south || chunk.south > bounds.north || chunk.east < bounds.west || chunk.west > bounds.east) continue;
    for (let i = 1; i < chunk.coordinates.length; i++) {
      visibleLength += clippedGpxSegmentLength(chunk.coordinates[i - 1], chunk.coordinates[i], bounds.south, bounds.north, bounds.west, bounds.east);
    }
  }
  return Math.max(0, Math.min(100, Math.round(visibleLength / cache.totalLength * 1000) / 10));
}
