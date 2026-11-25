export interface GpxTrackPoint {
  latitude: number;
  longitude: number;
  elevation: number | null;
  timestamp: string | null;
  inViewport?: boolean;
}

export interface RouteWaypoint {
  latitude: number;
  longitude: number;
  name?: string;
  active?: boolean;
}

export function parseGpxPoint(point: Element): [number, number] | null {
  const latitude = Number(point.getAttribute('lat')), longitude = Number(point.getAttribute('lon'));
  return Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
    ? [latitude, longitude] : null;
}

export function parseGpxTrackPoint(point: Element): GpxTrackPoint | null {
  const coordinates = parseGpxPoint(point);
  if (!coordinates) return null;
  const elevationText = Array.from(point.children).find(child => child.localName === 'ele')?.textContent?.trim();
  const timestamp = Array.from(point.children).find(child => child.localName === 'time')?.textContent?.trim() || null;
  const elevation = elevationText ? Number(elevationText) : null;
  return { latitude: coordinates[0], longitude: coordinates[1], elevation: elevationText && Number.isFinite(elevation) ? elevation : null, timestamp };
}

export function parseGpxTrackData(content: string): [number, number][][] {
  const xml = new DOMParser().parseFromString(content, 'application/xml');
  if (xml.getElementsByTagName('parsererror').length) throw new Error('The selected file is not valid GPX/XML.');
  const elements = Array.from(xml.getElementsByTagName('*'));
  let segments = elements.filter(element => element.localName === 'trkseg')
    .map(segment => Array.from(segment.getElementsByTagName('*')).filter(point => point.localName === 'trkpt')
      .map(parseGpxPoint).filter((point): point is [number, number] => point !== null))
    .filter(segment => segment.length > 0);
  if (!segments.length) {
    const points = elements.filter(element => element.localName === 'trkpt' || element.localName === 'rtept')
      .map(parseGpxPoint).filter((point): point is [number, number] => point !== null);
    if (points.length) segments = [points];
  }
  if (!segments.length) throw new Error('No valid track or route points were found in the GPX file.');
  return segments;
}

export function parseGpxTrackSegmentNames(content: string): string[] {
  const xml = new DOMParser().parseFromString(content, 'application/xml');
  const segments = Array.from(xml.getElementsByTagName('*')).filter(element => element.localName === 'trkseg');
  if (segments.length) return segments.map((segment, index) => {
    let parent = segment.parentElement;
    while (parent && parent.localName !== 'trk') parent = parent.parentElement;
    const name = parent ? Array.from(parent.children).find(child => child.localName === 'name')?.textContent?.trim() : '';
    const trackIndex = parent ? Array.from(xml.getElementsByTagName('*')).filter(element => element.localName === 'trk').indexOf(parent) : index;
    return name || `Track ${trackIndex + 1}`;
  });
  const route = Array.from(xml.getElementsByTagName('*')).find(element => element.localName === 'rte');
  const routeName = route ? Array.from(route.children).find(child => child.localName === 'name')?.textContent?.trim() : '';
  return [routeName || 'Route'];
}

export function parseGpxTrackPointData(content: string): GpxTrackPoint[][] {
  const xml = new DOMParser().parseFromString(content, 'application/xml');
  const segments = Array.from(xml.getElementsByTagName('*')).filter(element => element.localName === 'trkseg')
    .map(segment => Array.from(segment.getElementsByTagName('*')).filter(point => point.localName === 'trkpt')
      .map(parseGpxTrackPoint).filter((point): point is GpxTrackPoint => point !== null))
    .filter(segment => segment.length > 0);
  if (segments.length) return segments;
  const points = Array.from(xml.getElementsByTagName('*'))
    .filter(point => point.localName === 'trkpt' || point.localName === 'rtept')
    .map(parseGpxTrackPoint).filter((point): point is GpxTrackPoint => point !== null);
  return points.length ? [points] : [];
}

export function parseRoutingWaypointsFromGpx(content: string): RouteWaypoint[] | null {
  const xml = new DOMParser().parseFromString(content, 'application/xml');
  if (xml.getElementsByTagName('parsererror').length) return null;
  const comments: string[] = [];
  const walker = xml.createTreeWalker(xml, NodeFilter.SHOW_COMMENT);
  let node: Node | null;
  while ((node = walker.nextNode())) comments.push(node.textContent ?? '');

  for (const comment of comments) {
    const marker = 'LumaScope routing-waypoints v1';
    const markerIndex = comment.indexOf(marker);
    if (markerIndex >= 0) {
      try {
        const metadata = JSON.parse(comment.slice(markerIndex + marker.length).trim()) as { version?: number; points?: unknown };
        if (metadata.version !== 1 || !Array.isArray(metadata.points)) continue;
        const points = metadata.points.flatMap((entry: unknown) => {
          if (!entry || typeof entry !== 'object') return [];
          const value = entry as Record<string, unknown>;
          const latitude = Number(value['latitude']), longitude = Number(value['longitude']);
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
            || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return [];
          return [{
            latitude, longitude, active: value['active'] !== false,
            ...(typeof value['name'] === 'string' && value['name'].trim() ? { name: value['name'].trim() } : {})
          }];
        });
        return points.length ? points : null;
      } catch { /* Try the legacy text comment below. */ }
    }
  }

  // Backward compatibility with the former human-readable comment format.
  for (const comment of comments) {
    if (!comment.includes('Routing points (complete list')) continue;
    const points: RouteWaypoint[] = [];
    const pattern = /^\s*\d+\. \[(ACTIVE|INACTIVE)\] (.*?) \| latitude=(-?\d+(?:\.\d+)?) \| longitude=(-?\d+(?:\.\d+)?)/gm;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(comment))) {
      const latitude = Number(match[3]), longitude = Number(match[4]);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
        || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) continue;
      const name = match[2] === '(no resolved location name)' ? '' : match[2].trim();
      points.push({ latitude, longitude, active: match[1] === 'ACTIVE', ...(name ? { name } : {}) });
    }
    if (points.length) return points;
  }
  return null;
}
