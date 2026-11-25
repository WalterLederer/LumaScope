/// <reference lib="webworker" />

type GpxTrackPoint = {
  latitude: number;
  longitude: number;
  elevation: number | null;
  timestamp: string | null;
};
type ParsedGpx = {
  coordinates: [number, number][][];
  pointData: GpxTrackPoint[][];
  segmentNames: string[];
};
type WorkerRequest = { content: string };
type WorkerResponse =
  | { type: 'progress'; processed: number; total: number }
  | { type: 'complete'; total: number; result: ParsedGpx }
  | { type: 'error'; error: string };

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

function localName(qualifiedName: string): string {
  const separator = qualifiedName.lastIndexOf(':');
  return separator >= 0 ? qualifiedName.slice(separator + 1) : qualifiedName;
}

function decodeXmlText(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_match, entity: string) => {
    const normalized = entity.toLowerCase();
    if (normalized === 'amp') return '&';
    if (normalized === 'lt') return '<';
    if (normalized === 'gt') return '>';
    if (normalized === 'quot') return '"';
    if (normalized === 'apos') return "'";
    const numeric = normalized.startsWith('#x')
      ? Number.parseInt(normalized.slice(2), 16)
      : Number.parseInt(normalized.slice(1), 10);
    return Number.isFinite(numeric) && numeric >= 0 && numeric <= 0x10ffff
      ? String.fromCodePoint(numeric) : '';
  });
}

function readAttribute(tag: string, name: string): string | null {
  const doubleQuoted = tag.match(new RegExp('(?:^|\\s)' + name + '\\s*=\\s*"([^"]*)"', 'i'));
  if (doubleQuoted) return doubleQuoted[1];
  const singleQuoted = tag.match(new RegExp("(?:^|\\\\s)" + name + "\\\\s*=\\\\s*'([^']*)'", 'i'));
  return singleQuoted?.[1] ?? null;
}

function parse(content: string): ParsedGpx {
  const total = (content.match(/<(?:[a-z0-9_-]+:)?(?:trkpt|rtept)\b/gi) ?? []).length;
  if (!total) throw new Error('No GPX track or route points were found.');
  const coordinates: [number, number][][] = [];
  const pointData: GpxTrackPoint[][] = [];
  const segmentNames: string[] = [];
  const stack: Array<{ name: string; text: string }> = [];
  let currentTrack: { name: string; groups: number[] } | null = null;
  let currentRoute: number | null = null;
  let currentSegment: number | null = null;
  let currentPoint: GpxTrackPoint | null = null;
  let processed = 0;

  const addGroup = (name: string): number => {
    coordinates.push([]);
    pointData.push([]);
    segmentNames.push(name);
    return coordinates.length - 1;
  };

  const closeElement = (name: string): void => {
    const node = stack.pop();
    const parent = stack[stack.length - 1];
    if (!node) return;
    if ((name === 'ele' || name === 'time') && currentPoint && (parent?.name === 'trkpt' || parent?.name === 'rtept')) {
      if (name === 'ele') {
        const value = Number(node.text.trim());
        currentPoint.elevation = Number.isFinite(value) ? value : null;
      } else {
        currentPoint.timestamp = node.text.trim() || null;
      }
    } else if (name === 'name' && parent?.name === 'trk' && currentTrack) {
      const trackName = decodeXmlText(node.text).trim();
      if (trackName) {
        currentTrack.name = trackName;
        for (const groupIndex of currentTrack.groups) segmentNames[groupIndex] = trackName;
      }
    } else if (name === 'name' && parent?.name === 'rte' && currentRoute !== null) {
      const routeName = decodeXmlText(node.text).trim();
      if (routeName) segmentNames[currentRoute] = routeName;
    }
    if (name === 'trkpt' || name === 'rtept') {
      processed++;
      currentPoint = null;
      if (processed % 250 === 0) {
        workerScope.postMessage({ type: 'progress', processed, total } satisfies WorkerResponse);
      }
    } else if (name === 'trkseg') {
      currentSegment = null;
    } else if (name === 'trk') {
      currentTrack = null;
      currentSegment = null;
    } else if (name === 'rte') {
      currentRoute = null;
    }
  };

  const tokens = content.match(/<[^>]*>|[^<]+/g) ?? [];
  for (const token of tokens) {
    if (token.startsWith('<!--') || token.startsWith('<?') || /^<!DOCTYPE/i.test(token)) continue;
    if (token.startsWith('<![CDATA[') || token === ']]>') continue;
    if (token.startsWith('</')) {
      const closingName = localName(token.slice(2).trim().replace(/>$/, '').split(/[\s/]/)[0] ?? '');
      closeElement(closingName);
      continue;
    }
    if (token.startsWith('<')) {
      if (token.startsWith('<!')) continue;
      const qualifiedName = token.slice(1).trim().split(/[\s/>]/)[0] ?? '';
      if (!qualifiedName) continue;
      const name = localName(qualifiedName);
      const selfClosing = /\/\s*>$/.test(token);
      if (name === 'trk') {
        currentTrack = { name: 'Track ' + (coordinates.length + 1), groups: [] };
      } else if (name === 'trkseg') {
        const groupIndex = addGroup(currentTrack?.name || 'Track ' + (coordinates.length + 1));
        currentSegment = groupIndex;
        currentTrack?.groups.push(groupIndex);
      } else if (name === 'rte') {
        currentRoute = addGroup('Route');
      } else if (name === 'trkpt' || name === 'rtept') {
        const latitude = Number(readAttribute(token, 'lat'));
        const longitude = Number(readAttribute(token, 'lon'));
        if (Number.isFinite(latitude) && Math.abs(latitude) <= 90
          && Number.isFinite(longitude) && Math.abs(longitude) <= 180) {
          if (name === 'trkpt' && currentSegment === null && currentTrack) {
            currentSegment = addGroup(currentTrack.name);
            currentTrack.groups.push(currentSegment);
          }
          const groupIndex = name === 'rtept'
            ? (currentRoute ?? (currentRoute = addGroup('Route')))
            : (currentSegment ?? (currentSegment = addGroup(currentTrack?.name || 'Track')));
          currentPoint = { latitude, longitude, elevation: null, timestamp: null };
          coordinates[groupIndex].push([latitude, longitude]);
          pointData[groupIndex].push(currentPoint);
        } else {
          currentPoint = null;
        }
      }
      stack.push({ name, text: '' });
      if (selfClosing) closeElement(name);
      continue;
    }
    if (stack.length) stack[stack.length - 1].text += token;
  }

  const validGroups = coordinates.map((segment, index) => ({ segment, index }))
    .filter(item => item.segment.length > 0);
  if (!validGroups.length) throw new Error('No valid track or route points were found in the GPX file.');
  return {
    coordinates: validGroups.map(item => item.segment),
    pointData: validGroups.map(item => pointData[item.index]),
    segmentNames: validGroups.map(item => segmentNames[item.index] || 'Track')
  };
}

workerScope.onmessage = (event: MessageEvent<WorkerRequest>): void => {
  try {
    const result = parse(event.data.content);
    const total = (event.data.content.match(/<(?:[a-z0-9_-]+:)?(?:trkpt|rtept)\b/gi) ?? []).length;
    workerScope.postMessage({ type: 'complete', total, result } satisfies WorkerResponse);
  } catch (error) {
    workerScope.postMessage({
      type: 'error',
      error: error instanceof Error ? error.message : String(error)
    } satisfies WorkerResponse);
  }
};
