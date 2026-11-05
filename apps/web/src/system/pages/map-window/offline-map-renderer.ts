import { Map as MapLibreMap, Marker, setWorkerUrl, type MapOptions, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

// Angular copies the worker and its shared module to the renderer root.
// Resolve against the page URL so this also works in the packaged file:// app.
setWorkerUrl(new URL('maplibre-gl-worker.mjs', document.baseURI).toString());

const AUSTRIA_BOUNDS: [number, number, number, number] = [9.52678, 46.36979, 17.16408, 49.02403];

export type OfflineMapStyle = 'lumascope' | 'versatiles-colorful' | 'versatiles-neutrino';

export function buildPhotoMarkerPreviewHtml(path: string, fileName: string): string {
  const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character] ?? character);
  const previewUrl = 'atom://app/thumbs?image=' + encodeURIComponent(path) + '&width=180&height=120';
  return '<div class="folder-marker-preview"><img src="' + previewUrl + '" alt="" loading="lazy"><span>'
    + escapeHtml(fileName) + '</span></div>';
}

export interface OfflinePhotoMarker {
  path: string;
  fileName: string;
  latitude: number;
  longitude: number;
}

export const AUSTRIA_SHORTBREAD_STYLE: StyleSpecification = {
  version: 8,
  name: 'LumaScope Shortbread Austria',
  sources: {
    shortbread: {
      type: 'vector',
      tiles: ['atom://app/offline-tiles/{z}/{x}/{y}'],
      minzoom: 0,
      maxzoom: 14,
      bounds: AUSTRIA_BOUNDS,
      attribution: '© OpenStreetMap contributors'
    }
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#f5f2ea' } },
    { id: 'land', type: 'fill', source: 'shortbread', 'source-layer': 'land', paint: { 'fill-color': ['match', ['get', 'kind'], 'forest', '#c8d9b8', 'grass', '#dce5c8', 'meadow', '#e2e8c9', 'orchard', '#d5e1b8', 'vineyard', '#d9dfb1', '#e6e1d5'], 'fill-opacity': 0.95 } },
    { id: 'ocean', type: 'fill', source: 'shortbread', 'source-layer': 'ocean', paint: { 'fill-color': '#a9d5e5' } },
    { id: 'water-polygons', type: 'fill', source: 'shortbread', 'source-layer': 'water_polygons', paint: { 'fill-color': '#a9d5e5' } },
    { id: 'water-lines', type: 'line', source: 'shortbread', 'source-layer': 'water_lines', paint: { 'line-color': '#a9d5e5', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 14, 2] } },
    { id: 'boundaries', type: 'line', source: 'shortbread', 'source-layer': 'boundaries', paint: { 'line-color': '#a58aa2', 'line-width': 1, 'line-dasharray': [2, 2] } },
    { id: 'dam-polygons', type: 'fill', source: 'shortbread', 'source-layer': 'dam_polygons', paint: { 'fill-color': '#91bdce', 'fill-outline-color': '#6f9eaf' } },
    { id: 'pier-polygons', type: 'fill', source: 'shortbread', 'source-layer': 'pier_polygons', paint: { 'fill-color': '#c9c4b8' } },
    { id: 'sites', type: 'fill', source: 'shortbread', 'source-layer': 'sites', minzoom: 10, paint: { 'fill-color': ['match', ['get', 'kind'], 'sports_centre', '#d8e5c9', 'university', '#e6dfc8', 'college', '#e6dfc8', 'school', '#e8e1c9', 'hospital', '#f0d9d5', 'parking', '#dedbd4', 'construction', '#e9d8b9', 'danger_area', '#e8d0c8', '#e3dfd4'], 'fill-outline-color': '#c9c3b7', 'fill-opacity': 0.82 } },
    { id: 'street-polygons', type: 'fill', source: 'shortbread', 'source-layer': 'street_polygons', minzoom: 12, paint: { 'fill-color': '#f8f5ed', 'fill-outline-color': '#e5dfd4' } },
    { id: 'street-casing', type: 'line', source: 'shortbread', 'source-layer': 'streets', minzoom: 5, paint: { 'line-color': '#b5ad9e', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.65, 10, 2.1, 14, 6, 18, 12], 'line-opacity': 0.9 } },
    {
      id: 'streets', type: 'line', source: 'shortbread', 'source-layer': 'streets', minzoom: 5,
      paint: {
        'line-color': ['match', ['get', 'kind'], 'motorway', '#d66f67', 'motorway_link', '#d9897f', 'trunk', '#d99b4c', 'trunk_link', '#e1b26e', 'primary', '#e1ad64', 'primary_link', '#e9c18a', 'secondary', '#fff8e8', 'secondary_link', '#fff8e8', 'tertiary', '#fffaf0', 'residential', '#fffdf7', 'unclassified', '#fffdf7', 'living_street', '#f8f1df', 'service', '#f3eddf', 'pedestrian', '#f1e8d5', 'track', '#d5c8a9', 'path', '#c9b994', 'footway', '#c9b994', 'cycleway', '#a9c5b5', 'steps', '#c9b994', 'rail', '#8f8b85', 'railway', '#8f8b85', 'runway', '#c7c2b8', '#f5f0e5'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.6, 10, 1.5, 14, 3.5, 18, 7],
        'line-opacity': 0.95
      }
    },
    { id: 'bridges', type: 'line', source: 'shortbread', 'source-layer': 'bridges', minzoom: 11, paint: { 'line-color': '#b89d7e', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1, 16, 4] } },
    { id: 'ferries', type: 'line', source: 'shortbread', 'source-layer': 'ferries', minzoom: 8, paint: { 'line-color': '#5797b3', 'line-width': 1.5, 'line-dasharray': [2, 2] } },
    { id: 'aerialways', type: 'line', source: 'shortbread', 'source-layer': 'aerialways', minzoom: 10, paint: { 'line-color': '#9a7b9c', 'line-width': 1.2, 'line-dasharray': [1, 2] } },
    { id: 'dam-lines', type: 'line', source: 'shortbread', 'source-layer': 'dam_lines', paint: { 'line-color': '#6f9eaf', 'line-width': 1.5 } },
    { id: 'pier-lines', type: 'line', source: 'shortbread', 'source-layer': 'pier_lines', paint: { 'line-color': '#b9b1a2', 'line-width': 1.5 } },
    { id: 'public-transport', type: 'circle', source: 'shortbread', 'source-layer': 'public_transport', minzoom: 12, paint: { 'circle-radius': 2.5, 'circle-color': '#765b9a', 'circle-stroke-color': '#fff', 'circle-stroke-width': 0.6 } },
    { id: 'buildings', type: 'fill', source: 'shortbread', 'source-layer': 'buildings', minzoom: 12, paint: { 'fill-color': '#d9cfc4', 'fill-outline-color': '#b9aa9b', 'fill-opacity': 0.92 } },
    { id: 'pois', type: 'circle', source: 'shortbread', 'source-layer': 'pois', minzoom: 12, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 1.8, 18, 4], 'circle-color': '#a36b42', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 0.6 } },
    // Nearly transparent anchor layers let the renderer obtain label geometry
    // without requesting remote MapLibre glyph PBF files.
    { id: 'label-places-anchor', type: 'circle', source: 'shortbread', 'source-layer': 'place_labels', minzoom: 2, paint: { 'circle-radius': 2, 'circle-opacity': 0.01 } },
    { id: 'label-boundaries-anchor', type: 'circle', source: 'shortbread', 'source-layer': 'boundary_labels', minzoom: 3, paint: { 'circle-radius': 2, 'circle-opacity': 0.01 } },
    { id: 'label-streets-anchor', type: 'line', source: 'shortbread', 'source-layer': 'street_labels', minzoom: 11, paint: { 'line-width': 8, 'line-opacity': 0.01 } },
    { id: 'label-water-anchor', type: 'line', source: 'shortbread', 'source-layer': 'water_lines_labels', minzoom: 10, paint: { 'line-width': 6, 'line-opacity': 0.01 } },
    { id: 'label-water-polygons-anchor', type: 'circle', source: 'shortbread', 'source-layer': 'water_polygons_labels', minzoom: 4, paint: { 'circle-radius': 2, 'circle-opacity': 0.01 } },
    { id: 'label-street-polygons-anchor', type: 'circle', source: 'shortbread', 'source-layer': 'streets_polygons_labels', minzoom: 14, paint: { 'circle-radius': 2, 'circle-opacity': 0.01 } },
    { id: 'label-street-points-anchor', type: 'circle', source: 'shortbread', 'source-layer': 'street_labels_points', minzoom: 14, paint: { 'circle-radius': 2, 'circle-opacity': 0.01 } },
    { id: 'label-public-transport-anchor', type: 'circle', source: 'shortbread', 'source-layer': 'public_transport', minzoom: 14, paint: { 'circle-radius': 2, 'circle-opacity': 0.01 } },
    { id: 'label-pois-anchor', type: 'circle', source: 'shortbread', 'source-layer': 'pois', minzoom: 14, paint: { 'circle-radius': 2, 'circle-opacity': 0.01 } }
  ]
};


export function createOfflineMapStyle(styleName: OfflineMapStyle, mapId: string, minZoom = 0, maxZoom = 14, bounds?: [number, number, number, number]): StyleSpecification {
  const style = JSON.parse(JSON.stringify(AUSTRIA_SHORTBREAD_STYLE)) as StyleSpecification;
  const source = style.sources?.['shortbread'];
  if (source && source.type === 'vector') { source.tiles = ['atom://app/offline-tiles/{z}/{x}/{y}?map=' + encodeURIComponent(mapId)]; source.minzoom = minZoom; source.maxzoom = maxZoom; if (bounds) source.bounds = bounds; }
  style.name = 'LumaScope ' + (styleName === 'lumascope' ? 'Shortbread' : styleName);
  const palette = styleName === 'versatiles-colorful'
    ? {
      background: '#f7f5ed', land: '#e7e3d7', forest: '#b9d7a2', grass: '#d8e8b8',
      water: '#8bc9e8', boundary: '#9b7db0', casing: '#a99b86', road: '#fffdf5',
      motorway: '#e56f62', primary: '#f2b85b', secondary: '#fff0c9', tertiary: '#fff9e8',
      building: '#d9c9b9', site: '#e9d9a8', poi: '#c47b45', transport: '#7758a6'
    }
    : styleName === 'versatiles-neutrino'
      ? {
        background: '#202b36', land: '#34434a', forest: '#354f45', grass: '#40544a',
        water: '#29485c', boundary: '#77808d', casing: '#596773', road: '#aab5bd',
        motorway: '#d18b82', primary: '#c6a77b', secondary: '#84939e', tertiary: '#647581',
        building: '#46545d', site: '#48565c', poi: '#c39b73', transport: '#a18cbd'
      }
      : {
        background: '#f5f2ea', land: '#e6e1d5', forest: '#c8d9b8', grass: '#dce5c8',
        water: '#a9d5e5', boundary: '#a58aa2', casing: '#b5ad9e', road: '#f5f0e5',
        motorway: '#d66f67', primary: '#e1ad64', secondary: '#fff8e8', tertiary: '#fffaf0',
        building: '#d9cfc4', site: '#e3dfd4', poi: '#a36b42', transport: '#765b9a'
      };
  const setPaint = (id: string, values: Record<string, unknown>): void => {
    const layer = style.layers.find(candidate => candidate.id === id);
    if (layer && 'paint' in layer && layer.paint !== undefined) Object.assign(layer.paint, values);
  };
  const landColor = ['match', ['get', 'kind'], 'forest', palette.forest, 'grass', palette.grass,
    'meadow', palette.grass, 'orchard', palette.grass, 'vineyard', palette.grass, palette.land];
  const roadColor = ['match', ['get', 'kind'],
    'motorway', palette.motorway, 'motorway_link', palette.motorway,
    'trunk', palette.primary, 'trunk_link', palette.primary, 'primary', palette.primary, 'primary_link', palette.primary,
    'secondary', palette.secondary, 'secondary_link', palette.secondary,
    'tertiary', palette.tertiary, 'residential', palette.road, 'unclassified', palette.road,
    'living_street', palette.road, 'service', palette.road, 'pedestrian', palette.road,
    'track', palette.casing, 'path', palette.casing, 'footway', palette.casing, 'cycleway', palette.grass,
    'steps', palette.casing, 'rail', palette.casing, 'railway', palette.casing, palette.road];
  setPaint('background', { 'background-color': palette.background });
  setPaint('land', { 'fill-color': landColor });
  setPaint('ocean', { 'fill-color': palette.water });
  setPaint('water-polygons', { 'fill-color': palette.water });
  setPaint('water-lines', { 'line-color': palette.water });
  setPaint('boundaries', { 'line-color': palette.boundary });
  setPaint('street-casing', { 'line-color': palette.casing });
  setPaint('streets', { 'line-color': roadColor });
  setPaint('buildings', { 'fill-color': palette.building, 'fill-outline-color': palette.casing });
  setPaint('sites', { 'fill-color': palette.site, 'fill-outline-color': palette.casing });
  setPaint('pois', { 'circle-color': palette.poi });
  setPaint('public-transport', { 'circle-color': palette.transport });
  style.name = styleName === 'lumascope' ? 'LumaScope' :
    styleName === 'versatiles-colorful' ? 'VersaTiles Colorful (local Shortbread palette)' :
    'VersaTiles Neutrino (local Shortbread palette)';
  return style;
}

export class OfflineMapRenderer {
  readonly map: MapLibreMap;
  readonly ready: Promise<void>;
  private currentMarkerElement: HTMLElement | null = null;
  private currentLocation: [number, number] | null = null;
  private readonly overlayElement: HTMLDivElement;
  private readonly clusterLabels = new Map<number, Marker>();
  private readonly textLabels = new Map<string, { element: HTMLSpanElement; coordinates: [number, number] }>();
  private photoOpacity = 1;
  private photoClustersVisible = true;
  private onPhotoSelected: ((path: string) => void) | null = null;
  private photoPreviewElement: HTMLDivElement | null = null;
  private activePhotoPreviewKey: string | null = null;
  private activePhotoPreviewCoordinates: [number, number] | null = null;
  private clusterPreviewRequestId = 0;
  private lastMapError: string | null = null;
  private labelSourceDiagnosticLogged = false;
  private vectorSourceDiagnosticLogged = false;
  private readonly resizeObserver: ResizeObserver;
  private lastPointerObservation: Record<string, unknown> | null = null;
  private dragEventCount = 0;
  private dragDiagnostic: {
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    startZoom: number;
    startCenter: [number, number];
    startContainerRect: DOMRect;
    startCanvasRect: DOMRect;
    startCanvasWidth: number;
    startCanvasHeight: number;
    pointerSamples: Array<Record<string, unknown>>;
    dragSamples: Array<Record<string, unknown>>;
    cameraSamples: Array<Record<string, unknown>>;
  } | null = null;
  private readonly onDiagnosticPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const container = this.map.getContainer();
    const canvas = this.map.getCanvas();
    this.dragDiagnostic = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      startZoom: this.map.getZoom(),
      startCenter: this.map.getCenter().toArray() as [number, number],
      startContainerRect: container.getBoundingClientRect(),
      startCanvasRect: canvas.getBoundingClientRect(),
      startCanvasWidth: canvas.width,
      startCanvasHeight: canvas.height,
      pointerSamples: [],
      dragSamples: [],
      cameraSamples: [this.getCameraDiagnosticSnapshot()]
    };
    this.dragDiagnostic.pointerSamples.push({
      timeMs: performance.now(),
      x: event.clientX,
      y: event.clientY,
      movementX: event.movementX,
      movementY: event.movementY,
      camera: this.getCameraDiagnosticSnapshot()
    });
  };
  private readonly onDiagnosticPointerMove = (event: PointerEvent): void => {
    this.lastPointerObservation = {
      timeMs: performance.now(), pointerId: event.pointerId,
      x: event.clientX, y: event.clientY,
      movementX: event.movementX, movementY: event.movementY,
      buttons: event.buttons, target: (event.target as HTMLElement | null)?.tagName ?? null
    };
    if (!this.dragDiagnostic || event.pointerId !== this.dragDiagnostic.pointerId) return;
    this.dragDiagnostic.lastX = event.clientX;
    this.dragDiagnostic.lastY = event.clientY;
    if (this.dragDiagnostic.pointerSamples.length < 300) {
      this.dragDiagnostic.pointerSamples.push({
        timeMs: performance.now(),
        x: event.clientX,
        y: event.clientY,
        movementX: event.movementX,
        movementY: event.movementY
      });
    }
  };
  private readonly onDiagnosticMapDragStart = (): void => {
    this.dragEventCount = 0;
    console.info('[OfflineMap][DragStart]', {
      timeMs: performance.now(),
      pointer: this.lastPointerObservation,
      center: this.map.getCenter().toArray(),
      zoom: this.map.getZoom(), pitch: this.map.getPitch(), bearing: this.map.getBearing()
    });
  };
  private readonly onDiagnosticMapDrag = (): void => {
    const sample = {
      timeMs: performance.now(),
      pointer: this.lastPointerObservation,
      trackedPointer: this.dragDiagnostic ? [this.dragDiagnostic.lastX, this.dragDiagnostic.lastY] : null,
      center: this.map.getCenter().toArray(),
      zoom: this.map.getZoom(), pitch: this.map.getPitch(), bearing: this.map.getBearing()
    };
    this.dragEventCount++;
    const diagnostic = this.dragDiagnostic;
    if (diagnostic && diagnostic.dragSamples.length < 300) diagnostic.dragSamples.push(sample);
  };
  private readonly onDiagnosticMapDragEnd = (): void => {
    console.info('[OfflineMap][DragEnd]', {
      timeMs: performance.now(), dragEventCount: this.dragEventCount,
      pointer: this.lastPointerObservation,
      center: this.map.getCenter().toArray(),
      zoom: this.map.getZoom(), pitch: this.map.getPitch(), bearing: this.map.getBearing()
    });
  };
  private readonly onDiagnosticMapMove = (): void => {
    const diagnostic = this.dragDiagnostic;
    if (!diagnostic || diagnostic.cameraSamples.length >= 300) return;
    diagnostic.cameraSamples.push(this.getCameraDiagnosticSnapshot());
  };
  private getCameraDiagnosticSnapshot(): Record<string, unknown> {
    return {
      timeMs: performance.now(),
      zoom: this.map.getZoom(),
      pitch: this.map.getPitch(),
      bearing: this.map.getBearing(),
      center: this.map.getCenter().toArray(),
      projection: this.map.getProjection()
    };
  }
  private readonly onDiagnosticPointerEnd = (event: PointerEvent): void => {
    const start = this.dragDiagnostic;
    if (!start || event.pointerId !== start.pointerId) return;
    this.dragDiagnostic = null;

    const container = this.map.getContainer();
    const canvas = this.map.getCanvas();
    const containerRect = container.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const endX = event.clientX;
    const endY = event.clientY;
    const startZoom = start.startZoom;
    const endZoom = this.map.getZoom();
    const startMapPoint: [number, number] = [
      start.startX - start.startContainerRect.left,
      start.startY - start.startContainerRect.top
    ];
    const endMapPoint: [number, number] = [
      endX - containerRect.left,
      endY - containerRect.top
    ];
    const startGeo = this.map.unproject(startMapPoint);
    const endGeo = this.map.unproject(endMapPoint);
    const center = this.map.getCenter().toArray();

    console.info('[OfflineMap][DragDiagnostic]', {
      pointer: { start: [start.startX, start.startY], end: [endX, endY],
        deltaCssPixels: [endX - start.startX, endY - start.startY] },
      zoom: { start: startZoom, end: endZoom,
        startIntegerLevel: Math.floor(startZoom), endIntegerLevel: Math.floor(endZoom),
        sourceMaxZoom: 14 },
      center: { start: start.startCenter, end: center },
      mapPoint: { start: startMapPoint, end: endMapPoint },
      geographicUnderPointer: {
        start: [startGeo.lng, startGeo.lat],
        end: [endGeo.lng, endGeo.lat]
      },
      container: {
        startClient: [container.clientWidth, container.clientHeight],
        startRect: [start.startContainerRect.width, start.startContainerRect.height],
        endClient: [container.clientWidth, container.clientHeight],
        endRect: [containerRect.width, containerRect.height],
        cssScale: [containerRect.width / Math.max(1, container.clientWidth),
          containerRect.height / Math.max(1, container.clientHeight)]
      },
      canvas: {
        startRect: [start.startCanvasRect.width, start.startCanvasRect.height],
        endRect: [canvasRect.width, canvasRect.height],
        backingStore: [start.startCanvasWidth, start.startCanvasHeight, canvas.width, canvas.height],
        backingScale: [canvas.width / Math.max(1, canvasRect.width),
          canvas.height / Math.max(1, canvasRect.height)]
      },
      devicePixelRatio: window.devicePixelRatio,
      lastObservedPointer: [start.lastX, start.lastY],
      dragSamples: start.dragSamples,
      cameraSamples: start.cameraSamples,
      pointerSamples: start.pointerSamples
    });
  };

  constructor(container: HTMLElement, center: [number, number], zoom: number, private readonly onError?: (message: string) => void, private readonly styleName: OfflineMapStyle = 'lumascope', private readonly mapId = '', private readonly minZoom = 0, private readonly maxZoom = 14, private readonly bounds?: [number, number, number, number]) {
    const options: MapOptions = {
      container, style: createOfflineMapStyle(styleName, mapId, minZoom, maxZoom, bounds),
      center, zoom,
      minZoom: 0, maxZoom: 20,
      // Lock the offline map to a flat 2D Mercator view for drag diagnostics.
      pitch: 0,
      bearing: 0,
      maxPitch: 0,
      dragRotate: false,
      touchPitch: false,
      // Disable MapLibre 6's partial overscaling strategy. Split overzoomed vector tiles
      // consistently above the MBTiles native maxzoom (14) to avoid unstable camera transforms.
      zoomLevelsToOverscale: 0,
      attributionControl: { compact: false },
      // Disable drag inertia: at high zoom levels it can make the map continue
      // moving far beyond the user's drag distance.
      reduceMotion: true,
      // Use the public MapLibre API to anchor wheel zoom to the map center.
      scrollZoom: { around: 'center' },
      cooperativeGestures: false, renderWorldCopies: false
    };
    this.map = new MapLibreMap(options);
    // Use a dedicated geographic overlay rather than MapLibre DOM Marker. The
    // overlay is positioned from MapLibre's current projection on every render,
    // avoiding marker CSS transforms that can drift relative to the tile canvas.
    this.overlayElement = document.createElement('div');
    this.overlayElement.className = 'offline-map-geographic-overlay';
    this.overlayElement.style.cssText = 'position:absolute;inset:0;overflow:visible;pointer-events:none;z-index:20;';
    this.map.getContainer().appendChild(this.overlayElement);
    this.map.on('render', this.updateOverlayPositions);
    // Temporary diagnostics: compare physical pointer movement with MapLibre's
    // container/canvas geometry and camera state for each completed drag.
    const mapContainer = this.map.getContainer();
    mapContainer.addEventListener('pointerdown', this.onDiagnosticPointerDown, true);
    window.addEventListener('pointermove', this.onDiagnosticPointerMove, true);
    window.addEventListener('pointerup', this.onDiagnosticPointerEnd, true);
    window.addEventListener('pointercancel', this.onDiagnosticPointerEnd, true);
    this.map.on('move', this.onDiagnosticMapMove);
    // MapLibre emits 'drag' after its drag-pan handler has updated the camera.
    // Pair this with the window-level pointer samples to compare input and output.
    this.map.on('dragstart', this.onDiagnosticMapDragStart);
    this.map.on('dragend', this.onDiagnosticMapDragEnd);
    // Log the exact layout transition when the settings panel changes the map viewport.
    // This helps distinguish stale canvas dimensions from incorrect drag coordinate mapping.
    let previousObservedSize: [number, number] | null = null;
    this.resizeObserver = new ResizeObserver(entries => {
      const entry = entries[0];
      const rect = container.getBoundingClientRect();
      const observedSize: [number, number] = [rect.width, rect.height];
      const changed = !previousObservedSize
        || previousObservedSize[0] !== observedSize[0]
        || previousObservedSize[1] !== observedSize[1];
      if (!changed) return;

      const previousSize = previousObservedSize;
      previousObservedSize = observedSize;
      const canvas = this.map.getCanvas();
      console.info('[OfflineMap][ResizeObserver]', {
        timeMs: performance.now(),
        previousContainerSize: previousSize,
        observedContentRect: entry ? [entry.contentRect.width, entry.contentRect.height] : null,
        containerClientSize: [container.clientWidth, container.clientHeight],
        containerRect: observedSize,
        canvasRectBeforeResize: (() => {
          const canvasRect = canvas.getBoundingClientRect();
          return [canvasRect.width, canvasRect.height];
        })(),
        canvasBackingStoreBeforeResize: [canvas.width, canvas.height]
      });

      this.map.resize();

      const resizedCanvasRect = canvas.getBoundingClientRect();
      console.info('[OfflineMap][ResizeComplete]', {
        timeMs: performance.now(),
        containerClientSize: [container.clientWidth, container.clientHeight],
        containerRect: [rect.width, rect.height],
        canvasRect: [resizedCanvasRect.width, resizedCanvasRect.height],
        canvasBackingStore: [canvas.width, canvas.height],
        mapCenter: this.map.getCenter().toArray(),
        zoom: this.map.getZoom()
      });
    });
    this.resizeObserver.observe(container);
    // Keep mouse-wheel zoom deliberately slow; the anchor is configured
    // through MapOptions.scrollZoom above (no private MapLibre fields).
    this.map.scrollZoom.setWheelZoomRate(1 / 1200);
    let mapErrorCount = 0;
    this.map.on('error', event => {
      this.lastMapError = event.error instanceof Error ? event.error.message : String(event.error);
      if (mapErrorCount++ < 50) {
        console.error('[OfflineMap] MapLibre error:', event.error);
        onError?.(this.lastMapError);
      }
    });
    this.map.on('load', () => console.info('[OfflineMap] MapLibre style loaded.'));
    this.ready = new Promise((resolve, reject) => {
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        const detail = this.lastMapError ? ` Last MapLibre error: ${this.lastMapError}` : ' No MapLibre error event was reported.';
        reject(new Error('MapLibre did not finish loading the offline map within 15 seconds.' + detail + ' Check whether [OfflineMap] Protocol request received appears in the application log.'));
      }, 15000);
      this.map.once('load', () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        try {
          this.initializePhotoLayers();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  private initializePhotoLayers(): void {
    this.map.addSource('photo-markers', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
      cluster: true,
      clusterMaxZoom: 15,
      clusterRadius: 48
    });
    this.map.addLayer({
      id: 'photo-clusters', type: 'circle', source: 'photo-markers', filter: ['has', 'point_count'],
      paint: {
        'circle-color': ['step', ['get', 'point_count'], '#34c759', 10, '#ffd60a', 100, '#ff3b30'],
        'circle-radius': ['step', ['get', 'point_count'], 19, 10, 23, 100, 27],
        'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2,
        'circle-opacity': 0.95
      }
    });
    this.map.addLayer({
      id: 'photo-unclustered', type: 'circle', source: 'photo-markers', filter: ['!', ['has', 'point_count']],
      paint: { 'circle-radius': 6, 'circle-color': '#2688e8', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2, 'circle-opacity': 1 }
    });
    this.map.addSource('gpx-track', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    this.map.addLayer({
      id: 'gpx-track-line', type: 'line', source: 'gpx-track',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ff3b30', 'line-width': 4, 'line-opacity': 0.92 }
    });
    // Reconcile overlays after tile/camera updates; retain existing DOM markers.
    const refreshOverlays = (): void => {
      this.refreshClusterLabels();
      this.refreshTextLabels();
      this.logVectorSourceDiagnostics();
    };
    // Re-run after source tiles finish loading as well as after camera movement.
    // This is important when switching online/offline: the first idle can occur
    // before the final Shortbread label tiles are queryable, while no drag follows.
    this.map.on('idle', refreshOverlays);
    this.map.on('moveend', refreshOverlays);
    this.map.on('zoomend', refreshOverlays);
    this.map.on('sourcedata', event => {
      if (event.sourceId === 'shortbread' && event.isSourceLoaded) refreshOverlays();
    });
    this.map.on('click', 'photo-clusters', event => {
      this.clusterPreviewRequestId++;
      this.clearPhotoPreview();
      const feature = event.features?.[0];
      const clusterId = feature?.properties?.['cluster_id'];
      const coordinates = feature?.geometry?.type === 'Point' ? feature.geometry.coordinates : null;
      if (typeof clusterId !== 'number' || !coordinates) return;
      const source = this.map.getSource('photo-markers');
      if (!source || !('getClusterExpansionZoom' in source)) return;
      void (source as import('maplibre-gl').GeoJSONSource)
        .getClusterExpansionZoom(clusterId)
        .then(zoom => this.map.easeTo({ center: coordinates as [number, number], zoom }))
        .catch(() => undefined);
    });
    this.map.on('mouseenter', 'photo-clusters', event => {
      const feature = event.features?.[0];
      const clusterId = feature?.properties?.['cluster_id'];
      const coordinates = feature?.geometry?.type === 'Point' ? feature.geometry.coordinates : null;
      if (typeof clusterId !== 'number' || !coordinates) return;
      const source = this.map.getSource('photo-markers');
      if (!source || !('getClusterLeaves' in source)) return;

      const requestId = ++this.clusterPreviewRequestId;
      void (source as import('maplibre-gl').GeoJSONSource)
        .getClusterLeaves(clusterId, 1, 0)
        .then(leaves => {
          if (requestId !== this.clusterPreviewRequestId) return;
          const properties = leaves[0]?.properties;
          const path = properties?.['path'];
          const fileName = properties?.['fileName'];
          if (typeof path !== 'string' || typeof fileName !== 'string') return;
          this.showPhotoPreview(path, fileName, coordinates as [number, number]);
        })
        .catch(() => undefined);
    });
    this.map.on('mouseleave', 'photo-clusters', () => {
      this.clusterPreviewRequestId++;
      this.clearPhotoPreview();
    });
    this.map.on('click', 'photo-unclustered', event => {
      const path = event.features?.[0]?.properties?.['path'];
      if (typeof path === 'string') {
        this.clearPhotoPreview();
        this.onPhotoSelected?.(path);
      }
    });
    // Use the geographic DOM overlay for previews. MapLibre Popup is attached
    // to the map container and can end up underneath the custom geographic overlay.
    // A DOM preview inside that overlay has a deterministic stacking order.
    this.map.on('mousemove', event => {
      const point = event.point;
      const features = this.map.queryRenderedFeatures(
        [[point.x - 12, point.y - 12], [point.x + 12, point.y + 12]],
        { layers: ['photo-unclustered'] }
      );
      const feature = features[0];
      const path = feature?.properties?.['path'];
      const fileName = feature?.properties?.['fileName'];
      if (typeof path !== 'string' || typeof fileName !== 'string' || feature?.geometry.type !== 'Point') {
        if (this.activePhotoPreviewKey !== null) this.clearPhotoPreview();
        return;
      }
      const coordinates = feature.geometry.coordinates as [number, number];
      if (this.activePhotoPreviewKey !== path || !this.photoPreviewElement) {
        this.showPhotoPreview(path, fileName, coordinates);
      } else {
        this.activePhotoPreviewCoordinates = coordinates;
        this.updatePhotoPreviewPosition();
      }
    });
    this.map.on('mouseout', () => this.clearPhotoPreview());
    this.map.on('mouseenter', 'photo-clusters', () => { this.map.getCanvas().style.cursor = 'pointer'; });
    this.map.on('mouseleave', 'photo-clusters', () => { this.map.getCanvas().style.cursor = ''; });
    this.map.on('mouseenter', 'photo-unclustered', () => { this.map.getCanvas().style.cursor = 'pointer'; });
    this.map.on('mouseleave', 'photo-unclustered', () => { this.map.getCanvas().style.cursor = ''; });
  }

  private logVectorSourceDiagnostics(): void {
    if (this.vectorSourceDiagnosticLogged) return;
    this.vectorSourceDiagnosticLogged = true;
    const sourceLayers = [
      'land', 'ocean', 'water_polygons', 'water_lines', 'boundaries',
      'streets', 'buildings', 'pois', 'place_labels', 'street_labels'
    ];
    const counts = sourceLayers.map(sourceLayer => ({
      layer: sourceLayer,
      count: this.map.querySourceFeatures('shortbread', { sourceLayer }).length
    }));
    console.info('[OfflineMap] Vector source feature counts:', counts);
    if (counts.every(item => item.count === 0)) {
      const message = 'Offline tiles are being retrieved, but MapLibre exposes no vector features from the Shortbread source. Check the MBTiles tile contents and vector-layer metadata.';
      console.error('[OfflineMap]', message);
      this.onError?.(message);
    }
  }

  private refreshClusterLabels(): void {
    if (!this.map.getLayer('photo-clusters')) return;
    if (!this.photoClustersVisible || this.photoOpacity <= 0) {
      for (const marker of this.clusterLabels.values()) marker.remove();
      this.clusterLabels.clear();
      return;
    }
    const visible = new Set<number>();
    const features = this.map.queryRenderedFeatures({ layers: ['photo-clusters'] });
    for (const feature of features) {
      if (feature.geometry.type !== 'Point') continue;
      const count = feature.properties?.['point_count'];
      const clusterId = feature.properties?.['cluster_id'];
      if (typeof count !== 'number' || typeof clusterId !== 'number') continue;
      visible.add(clusterId);
      let marker = this.clusterLabels.get(clusterId);
      if (!marker) {
        const element = document.createElement('span');
        element.style.cssText = 'display:flex;align-items:center;justify-content:center;min-width:24px;height:22px;padding:0 3px;box-sizing:border-box;color:#fff;font:700 12px/22px Segoe UI,Arial,sans-serif;text-shadow:0 1px 2px #000;text-align:center;white-space:nowrap;pointer-events:none;position:relative;z-index:10000;';
        marker = new Marker({ element, anchor: 'center' })
          .setLngLat(feature.geometry.coordinates as [number, number])
          .addTo(this.map);
        this.clusterLabels.set(clusterId, marker);
      }
      marker.getElement().textContent = String(count);
      marker.setLngLat(feature.geometry.coordinates as [number, number]);
    }
    for (const [clusterId, marker] of this.clusterLabels) {
      if (visible.has(clusterId)) continue;
      marker.remove();
      this.clusterLabels.delete(clusterId);
    }
  }


  private refreshTextLabels(): void {
    const visible = new Set<string>();
    const labelSources = [
      { layerId: 'label-places-anchor', sourceLayer: 'place_labels', kind: 'place' },
      { layerId: 'label-boundaries-anchor', sourceLayer: 'boundary_labels', kind: 'boundary' },
      { layerId: 'label-water-polygons-anchor', sourceLayer: 'water_polygons_labels', kind: 'water' },
      { layerId: 'label-street-polygons-anchor', sourceLayer: 'streets_polygons_labels', kind: 'street' },
      { layerId: 'label-street-points-anchor', sourceLayer: 'street_labels_points', kind: 'street' },
      { layerId: 'label-public-transport-anchor', sourceLayer: 'public_transport', kind: 'poi' },
      { layerId: 'label-pois-anchor', sourceLayer: 'pois', kind: 'poi' }
    ];
    const candidates: Array<{ key: string; x: number; y: number; longitude: number; latitude: number; text: string; kind: string; priority: number }> = [];

    for (const source of labelSources) {
      // Rendered features expose geographic coordinates. Raw source features can
      // retain vector-tile coordinates, which must not be passed to project()/Marker.
      const features = this.map.queryRenderedFeatures({ layers: [source.layerId] });
      for (const feature of features) {
        const properties = feature.properties ?? {};
        const text = String(properties['name_de'] || properties['name'] || properties['name_en'] || properties['ref'] || '').trim();
        if (!text) continue;

        const geometry = feature.geometry as unknown as { type: string; coordinates: unknown };
        let point: [number, number] | null = null;
        if (geometry.type === 'Point' && Array.isArray(geometry.coordinates)) {
          point = geometry.coordinates as [number, number];
        } else if (geometry.type === 'LineString' && Array.isArray(geometry.coordinates)) {
          point = this.getLineMidpoint(geometry.coordinates as [number, number][]);
        } else if (geometry.type === 'MultiLineString' && Array.isArray(geometry.coordinates)) {
          const lines = geometry.coordinates as [number, number][][];
          const longest = lines.reduce((best, line) => this.getProjectedLineLength(line) > this.getProjectedLineLength(best) ? line : best, []);
          point = this.getLineMidpoint(longest);
        }
        if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])
          || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) continue;

        const screenPoint = this.map.project(point);
        const width = this.map.getContainer().clientWidth;
        const height = this.map.getContainer().clientHeight;
        if (!Number.isFinite(screenPoint.x) || !Number.isFinite(screenPoint.y)
          || screenPoint.x < -260 || screenPoint.y < -30
          || screenPoint.x > width + 260 || screenPoint.y > height + 30) continue;

        const placeKind = String(properties['kind'] ?? source.kind);
        const priority = source.kind === 'place' ? 0 : source.kind === 'boundary' ? 1 : source.kind === 'water' ? 2 : source.kind === 'street' ? 3 : 4;
        const rawCoordinates = geometry.coordinates as unknown;
        const firstCoordinate = geometry.type === 'Point'
          ? rawCoordinates as [number, number]
          : geometry.type === 'MultiLineString'
            ? (rawCoordinates as [number, number][][])[0]?.[0]
            : (rawCoordinates as [number, number][])[0];
        // Vector-tile line features may be split into different fragments at
        // tile boundaries. Prefer the stable source feature ID over fragment
        // coordinates so the same road/river keeps one label identity.
        const featureId = feature.id;
        const key = source.sourceLayer + ':' + text + ':'
          + (featureId !== undefined ? 'id:' + String(featureId) + ':' : '')
          + (firstCoordinate?.[0]?.toFixed(5) ?? point[0].toFixed(5)) + ':'
          + (firstCoordinate?.[1]?.toFixed(5) ?? point[1].toFixed(5));
        candidates.push({ key, x: screenPoint.x, y: screenPoint.y, longitude: point[0], latitude: point[1], text, kind: placeKind, priority });
      }
    }

    candidates.sort((a, b) => a.priority - b.priority);
    const occupied: Array<[number, number, number, number]> = [];
    const seen = new Set<string>();
    const width = this.map.getContainer().clientWidth;
    const height = this.map.getContainer().clientHeight;

    for (const candidate of candidates) {
      const zoom = this.map.getZoom();
      const maxLabels = zoom < 8 ? 18 : zoom < 10 ? 28 : zoom < 12 ? 42 : zoom < 14 ? 60 : zoom < 16 ? 90 : 130;
      if (visible.size >= maxLabels) break;
      const { key, x, y, longitude, latitude, text, kind } = candidate;
      if (x < 0 || y < 0 || x > width || y > height) continue;
      const dedupeKey = `${kind}:${text}:${Math.round(x / 24)}:${Math.round(y / 24)}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const fontSize = kind === 'capital' ? 18 : kind === 'state_capital' ? 17 : kind === 'city' ? 17 : kind === 'town' ? 15 : kind === 'village' ? 14 : kind === 'street' ? 12 : kind === 'water' ? 13 : kind === 'boundary' ? 14 : kind === 'poi' ? 11 : 13;
      const labelWidth = Math.min(260, Math.max(24, text.length * fontSize * 0.56 + 8));
      const labelHeight = fontSize + 7;
      const box: [number, number, number, number] = [x - labelWidth / 2, y - labelHeight / 2, x + labelWidth / 2, y + labelHeight / 2];
      if (occupied.some(other => box[0] < other[2] + 4 && box[2] > other[0] - 4 && box[1] < other[3] + 3 && box[3] > other[1] - 3)) continue;
      occupied.push(box);
      visible.add(key);
      const existingLabel = this.textLabels.get(key);
      if (existingLabel) {
        existingLabel.element.textContent = text;
        continue;
      }
      const element = document.createElement('span');
      element.textContent = text;
      const darkStyle = this.styleName === 'versatiles-neutrino';
      const color = darkStyle ? (kind === 'water' ? '#9bcde4' : kind === 'boundary' ? '#c0a8d0' : '#f0f1f2')
        : kind === 'street' ? '#625d55' : kind === 'water' ? '#397b9a' : kind === 'boundary' ? '#806b83' : kind === 'poi' ? '#73583d' : '#393832';
      const halo = darkStyle ? '#202b36' : '#f1efe8';
      const weight = kind === 'capital' || kind === 'state_capital' || kind === 'city' ? 700 : kind === 'town' ? 600 : 500;
      const style = kind === 'water' ? 'italic' : 'normal';
      element.style.cssText = `display:block;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${color};font:${style} ${weight} ${fontSize}px/1.2 Segoe UI,Arial,sans-serif;text-shadow:-1px -1px 0 ${halo},1px -1px 0 ${halo},-1px 1px 0 ${halo},1px 1px 0 ${halo},0 0 3px ${halo};pointer-events:none;text-align:center;`;
      element.style.position = 'absolute';
      element.style.left = '0';
      element.style.top = '0';
      element.style.transform = 'translate(-50%, -50%)';
      const coordinates: [number, number] = [longitude, latitude];
      this.overlayElement.appendChild(element);
      this.textLabels.set(key, { element, coordinates });
    }
    for (const [key, marker] of this.textLabels) {
      if (visible.has(key)) continue;
      // This refresh runs on MapLibre 'idle': visible tiles and label queries
      // are settled. Remove labels no longer selected at the current zoom so
      // zooming out cannot accumulate stale labels from earlier zoom levels.
      marker.element.remove();
      this.textLabels.delete(key);
    }
    if (!this.labelSourceDiagnosticLogged) {
      this.labelSourceDiagnosticLogged = true;
      console.info('[OfflineMap] Rendered label features:', labelSources.map(source => ({
        layer: source.sourceLayer,
        count: this.map.queryRenderedFeatures({ layers: [source.layerId] }).length
      })));
    }
  }

  private getProjectedLineLength(coordinates: [number, number][]): number {
    if (coordinates.length < 2) return 0;
    let length = 0;
    let previous = this.map.project(coordinates[0]);
    for (let i = 1; i < coordinates.length; i++) {
      const current = this.map.project(coordinates[i]);
      length += Math.hypot(current.x - previous.x, current.y - previous.y);
      previous = current;
    }
    return length;
  }

  private getLineMidpoint(coordinates: [number, number][]): [number, number] | null {
    if (coordinates.length < 2) return coordinates[0] ?? null;
    const projected = coordinates.map(coordinate => this.map.project(coordinate));
    const segmentLengths: number[] = [];
    let totalLength = 0;
    for (let i = 1; i < projected.length; i++) {
      const length = Math.hypot(projected[i].x - projected[i - 1].x, projected[i].y - projected[i - 1].y);
      segmentLengths.push(length);
      totalLength += length;
    }
    if (!Number.isFinite(totalLength) || totalLength <= 0) return coordinates[0];

    let remaining = totalLength / 2;
    for (let i = 0; i < segmentLengths.length; i++) {
      const length = segmentLengths[i];
      if (remaining <= length || i === segmentLengths.length - 1) {
        const ratio = length > 0 ? Math.min(1, remaining / length) : 0;
        const start = coordinates[i];
        const end = coordinates[i + 1];
        return [
          start[0] + (end[0] - start[0]) * ratio,
          start[1] + (end[1] - start[1]) * ratio
        ];
      }
      remaining -= length;
    }
    return coordinates[coordinates.length - 1];
  }

  private showPhotoPreview(path: string, fileName: string, coordinates: [number, number]): void {
    this.clearPhotoPreview();
    const preview = document.createElement('div');
    preview.className = 'folder-marker-tooltip offline-photo-marker-preview';
    preview.innerHTML = buildPhotoMarkerPreviewHtml(path, fileName);
    preview.style.cssText = [
      'position:absolute',
      'z-index:10001',
      'pointer-events:none',
      'padding:5px 7px',
      'background:var(--color-surface-default-high,#303238)',
      'border:1px solid #777',
      'border-radius:6px',
      'color:var(--color-content-default-high,#fff)',
      'box-shadow:0 3px 12px #0008',
      'transform:translate(-50%,calc(-100% - 14px))',
      'width:max-content'
    ].join(';');
    this.photoPreviewElement = preview;
    this.activePhotoPreviewKey = path;
    this.activePhotoPreviewCoordinates = coordinates;
    this.overlayElement.appendChild(preview);
    this.updatePhotoPreviewPosition();
  }

  private updatePhotoPreviewPosition(): void {
    if (!this.photoPreviewElement || !this.activePhotoPreviewCoordinates) return;
    const point = this.map.project(this.activePhotoPreviewCoordinates);
    this.photoPreviewElement.style.left = `${point.x}px`;
    this.photoPreviewElement.style.top = `${point.y}px`;
  }

  private clearPhotoPreview(): void {
    this.photoPreviewElement?.remove();
    this.photoPreviewElement = null;
    this.activePhotoPreviewKey = null;
    this.activePhotoPreviewCoordinates = null;
    this.clearPhotoPreview();
  }

  private readonly updateOverlayPositions = (): void => {
    if (this.currentMarkerElement && this.currentLocation) {
      const point = this.map.project(this.currentLocation);
      this.currentMarkerElement.style.left = `${point.x}px`;
      this.currentMarkerElement.style.top = `${point.y}px`;
    }
    for (const label of this.textLabels.values()) {
      const point = this.map.project(label.coordinates);
      label.element.style.left = `${point.x}px`;
      label.element.style.top = `${point.y}px`;
    }
    this.updatePhotoPreviewPosition();
  };

  setCurrentLocation(latitude: number, longitude: number, color: string, opacity: number, shape: 'pin' | 'circle' | 'square' | 'diamond' = 'pin'): void {
    const element = document.createElement('div');
    element.className = 'offline-current-location-marker';
    const shapeMarkup = shape === 'pin'
      ? `<path d="M24 2C12.4 2 4 10.5 4 21c0 14 20 35 20 35s20-21 20-35C44 10.5 35.6 2 24 2Z" fill="${color}" stroke="#fff" stroke-width="3"/><circle cx="24" cy="21" r="7.5" fill="#fff" stroke="#222" stroke-width="1.5"/>`
      : shape === 'circle'
        ? `<circle cx="20" cy="20" r="16" fill="${color}" stroke="#fff" stroke-width="3"/><circle cx="20" cy="20" r="6" fill="#fff" stroke="#222" stroke-width="1.5"/>`
        : shape === 'square'
          ? `<rect x="4" y="4" width="32" height="32" rx="3" fill="${color}" stroke="#fff" stroke-width="3"/><circle cx="20" cy="20" r="6" fill="#fff" stroke="#222" stroke-width="1.5"/>`
          : `<polygon points="20,2 38,20 20,38 2,20" fill="${color}" stroke="#fff" stroke-width="3"/><circle cx="20" cy="20" r="6" fill="#fff" stroke="#222" stroke-width="1.5"/>`;
    const width = shape === 'pin' ? 36 : 36;
    const height = shape === 'pin' ? 44 : 36;
    element.style.cssText = `width:${width}px;height:${height}px;display:block;pointer-events:none;filter:drop-shadow(0 1px 3px #000b);opacity:${opacity};`;
    element.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${shape === 'pin' ? '0 0 48 58' : '0 0 40 40'}" style="display:block;overflow:visible">${shapeMarkup}</svg>`;
    if (this.currentMarkerElement) this.currentMarkerElement.remove();
    element.style.position = 'absolute';
    element.style.left = '0';
    element.style.top = '0';
    element.style.transform = shape === 'pin' ? 'translate(-50%, -100%)' : 'translate(-50%, -50%)';
    element.style.zIndex = '10000';
    this.currentMarkerElement = element;
    this.currentLocation = [longitude, latitude];
    this.overlayElement.appendChild(element);
    this.updateOverlayPositions();
  }

  updateCurrentLocation(latitude: number, longitude: number): void {
    this.currentLocation = [longitude, latitude];
    this.updateOverlayPositions();
  }

  setCurrentOpacity(opacity: number): void {
    if (this.currentMarkerElement) this.currentMarkerElement.style.opacity = String(opacity);
  }

  setPhotoMarkers(markers: OfflinePhotoMarker[], onSelected: (path: string) => void, opacity: number): void {
    this.onPhotoSelected = onSelected;
    const source = this.map.getSource('photo-markers') as import('maplibre-gl').GeoJSONSource | undefined;
    if (!source) return;
    source.setData({
      type: 'FeatureCollection',
      features: markers.map(marker => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [marker.longitude, marker.latitude] },
        properties: { path: marker.path, fileName: marker.fileName }
      }))
    });
    this.photoOpacity = opacity;
    this.map.setPaintProperty('photo-unclustered', 'circle-opacity', opacity);
    this.map.setPaintProperty('photo-unclustered', 'circle-stroke-opacity', opacity);
    this.map.setPaintProperty('photo-clusters', 'circle-opacity', this.photoClustersVisible ? 0.95 * opacity : 0);
    this.map.setPaintProperty('photo-clusters', 'circle-stroke-opacity', this.photoClustersVisible ? opacity : 0);
    this.map.setPaintProperty('photo-clusters', 'circle-stroke-width', this.photoClustersVisible ? 2 : 0);
  }

  setBasemapOpacity(opacity: number): void {
    const layers = [
      ['background', 'background-opacity'], ['land', 'fill-opacity'], ['ocean', 'fill-opacity'],
      ['water-polygons', 'fill-opacity'], ['water-lines', 'line-opacity'], ['boundaries', 'line-opacity'],
      ['dam-polygons', 'fill-opacity'], ['pier-polygons', 'fill-opacity'], ['sites', 'fill-opacity'], ['street-polygons', 'fill-opacity'],
      ['street-casing', 'line-opacity'], ['streets', 'line-opacity'], ['bridges', 'line-opacity'], ['ferries', 'line-opacity'], ['aerialways', 'line-opacity'],
      ['dam-lines', 'line-opacity'], ['pier-lines', 'line-opacity'], ['public-transport', 'circle-opacity'],
      ['buildings', 'fill-opacity'], ['pois', 'circle-opacity']
    ] as const;
    for (const [id, property] of layers) if (this.map.getLayer(id)) this.map.setPaintProperty(id, property, opacity);
  }

  setPhotoClusterStyle(color: string, visible: boolean): void {
    if (!this.map.getLayer('photo-clusters')) return;
    const fill = !visible ? 'transparent' : color === 'dynamic'
      ? ['step', ['get', 'point_count'], '#34c759', 10, '#ffd60a', 100, '#ff3b30']
      : color;
    this.photoClustersVisible = visible;
    this.map.setPaintProperty('photo-clusters', 'circle-color', fill as never);
    this.map.setPaintProperty('photo-clusters', 'circle-opacity', visible ? 0.95 * this.photoOpacity : 0);
    this.map.setPaintProperty('photo-clusters', 'circle-stroke-opacity', visible ? this.photoOpacity : 0);
    this.map.setPaintProperty('photo-clusters', 'circle-stroke-width', visible ? 2 : 0);
    if (!visible) {
      for (const marker of this.clusterLabels.values()) marker.remove();
      this.clusterLabels.clear();
    }
  }

  setPhotoOpacity(opacity: number): void {
    this.photoOpacity = opacity;
    if (!this.map.getLayer('photo-unclustered')) return;
    this.map.setPaintProperty('photo-unclustered', 'circle-opacity', opacity);
    this.map.setPaintProperty('photo-unclustered', 'circle-stroke-opacity', opacity);
    this.map.setPaintProperty('photo-clusters', 'circle-opacity', this.photoClustersVisible ? 0.95 * opacity : 0);
    this.map.setPaintProperty('photo-clusters', 'circle-stroke-opacity', this.photoClustersVisible ? opacity : 0);
    this.map.setPaintProperty('photo-clusters', 'circle-stroke-width', this.photoClustersVisible ? 2 : 0);
    if (opacity <= 0) {
      for (const marker of this.clusterLabels.values()) marker.remove();
      this.clusterLabels.clear();
    }
  }

  setTrack(segments: [number, number][][], color: string, opacity: number): void {
    const source = this.map.getSource('gpx-track') as import('maplibre-gl').GeoJSONSource | undefined;
    if (!source) return;
    source.setData({
      type: 'FeatureCollection',
      features: segments.filter(segment => segment.length >= 2).map(segment => ({
        type: 'Feature' as const,
        geometry: { type: 'LineString' as const, coordinates: segment.map(([latitude, longitude]) => [longitude, latitude]) },
        properties: {}
      }))
    });
    this.map.setPaintProperty('gpx-track-line', 'line-color', color);
    this.map.setPaintProperty('gpx-track-line', 'line-opacity', opacity);
  }

  resize(): void { this.map.resize(); }
  remove(): void {
    this.resizeObserver.disconnect();
    this.map.getContainer().removeEventListener('pointerdown', this.onDiagnosticPointerDown, true);
    window.removeEventListener('pointermove', this.onDiagnosticPointerMove, true);
    window.removeEventListener('pointerup', this.onDiagnosticPointerEnd, true);
    window.removeEventListener('pointercancel', this.onDiagnosticPointerEnd, true);
    this.map.off('move', this.onDiagnosticMapMove);
    this.map.off('dragstart', this.onDiagnosticMapDragStart);
    this.map.off('dragend', this.onDiagnosticMapDragEnd);
    this.map.off('render', this.updateOverlayPositions);
    this.currentMarkerElement?.remove();
    this.currentMarkerElement = null;
    this.currentLocation = null;
    for (const marker of this.clusterLabels.values()) marker.remove();
    this.clusterLabels.clear();
    for (const marker of this.textLabels.values()) marker.element.remove();
    this.textLabels.clear();
    this.overlayElement.remove();
    this.map.remove();
  }
}
