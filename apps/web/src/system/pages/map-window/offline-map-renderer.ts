import { Map as MapLibreMap, Marker, setWorkerUrl, type MapOptions, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

// Angular copies the worker and its shared module to the renderer root.
// Resolve against the page URL so this also works in the packaged file:// app.
setWorkerUrl(new URL('maplibre-gl-worker.mjs', document.baseURI).toString());

const AUSTRIA_BOUNDS: [number, number, number, number] = [9.52678, 46.36979, 17.16408, 49.02403];

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
    { id: 'land', type: 'fill', source: 'shortbread', 'source-layer': 'land', paint: { 'fill-color': '#e6e1d5' } },
    { id: 'ocean', type: 'fill', source: 'shortbread', 'source-layer': 'ocean', paint: { 'fill-color': '#a9d5e5' } },
    { id: 'water-polygons', type: 'fill', source: 'shortbread', 'source-layer': 'water_polygons', paint: { 'fill-color': '#a9d5e5' } },
    { id: 'water-lines', type: 'line', source: 'shortbread', 'source-layer': 'water_lines', paint: { 'line-color': '#a9d5e5', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 14, 2] } },
    { id: 'boundaries', type: 'line', source: 'shortbread', 'source-layer': 'boundaries', paint: { 'line-color': '#a58aa2', 'line-width': 1, 'line-dasharray': [2, 2] } },
    { id: 'dam-polygons', type: 'fill', source: 'shortbread', 'source-layer': 'dam_polygons', paint: { 'fill-color': '#91bdce', 'fill-outline-color': '#6f9eaf' } },
    { id: 'pier-polygons', type: 'fill', source: 'shortbread', 'source-layer': 'pier_polygons', paint: { 'fill-color': '#c9c4b8' } },
    { id: 'sites', type: 'fill', source: 'shortbread', 'source-layer': 'sites', minzoom: 10, paint: { 'fill-color': '#e3dfd4', 'fill-outline-color': '#c9c3b7', 'fill-opacity': 0.65 } },
    { id: 'street-polygons', type: 'fill', source: 'shortbread', 'source-layer': 'street_polygons', minzoom: 12, paint: { 'fill-color': '#f8f5ed', 'fill-outline-color': '#e5dfd4' } },
    { id: 'street-casing', type: 'line', source: 'shortbread', 'source-layer': 'streets', minzoom: 7, paint: { 'line-color': '#a9a294', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.9, 10, 2.4, 14, 7, 18, 13], 'line-opacity': 0.9 } },
    {
      id: 'streets', type: 'line', source: 'shortbread', 'source-layer': 'streets', minzoom: 8,
      paint: {
        'line-color': ['match', ['get', 'kind'], 'motorway', '#d66f67', 'trunk', '#d99b4c', 'primary', '#e1ad64', 'secondary', '#fff9ec', 'tertiary', '#fff9ec', '#f5f0e5'],
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
    { id: 'buildings', type: 'fill', source: 'shortbread', 'source-layer': 'buildings', minzoom: 13, paint: { 'fill-color': '#d4c9bd', 'fill-outline-color': '#c2b6aa', 'fill-opacity': 0.85 } },
    { id: 'pois', type: 'circle', source: 'shortbread', 'source-layer': 'pois', minzoom: 12, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 1.8, 18, 4], 'circle-color': '#a36b42', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 0.6 } },
    // Nearly transparent anchor layers let the renderer obtain label geometry
    // without requesting remote MapLibre glyph PBF files.
    { id: 'label-places-anchor', type: 'circle', source: 'shortbread', 'source-layer': 'place_labels', minzoom: 2, paint: { 'circle-radius': 2, 'circle-opacity': 0.01 } },
    { id: 'label-boundaries-anchor', type: 'circle', source: 'shortbread', 'source-layer': 'boundary_labels', minzoom: 3, paint: { 'circle-radius': 2, 'circle-opacity': 0.01 } },
    { id: 'label-streets-anchor', type: 'line', source: 'shortbread', 'source-layer': 'street_labels', minzoom: 11, paint: { 'line-width': 8, 'line-opacity': 0.01 } },
    { id: 'label-water-anchor', type: 'line', source: 'shortbread', 'source-layer': 'water_lines_labels', minzoom: 10, paint: { 'line-width': 6, 'line-opacity': 0.01 } },
    { id: 'label-water-polygons-anchor', type: 'circle', source: 'shortbread', 'source-layer': 'water_polygons_labels', minzoom: 4, paint: { 'circle-radius': 2, 'circle-opacity': 0.01 } },
    { id: 'label-street-polygons-anchor', type: 'circle', source: 'shortbread', 'source-layer': 'streets_polygons_labels', minzoom: 14, paint: { 'circle-radius': 2, 'circle-opacity': 0.01 } },
    { id: 'label-street-points-anchor', type: 'circle', source: 'shortbread', 'source-layer': 'street_labels_points', minzoom: 12, paint: { 'circle-radius': 2, 'circle-opacity': 0.01 } },
    { id: 'label-public-transport-anchor', type: 'circle', source: 'shortbread', 'source-layer': 'public_transport', minzoom: 12, paint: { 'circle-radius': 2, 'circle-opacity': 0.01 } },
    { id: 'label-pois-anchor', type: 'circle', source: 'shortbread', 'source-layer': 'pois', minzoom: 12, paint: { 'circle-radius': 2, 'circle-opacity': 0.01 } }
  ]
};

export class OfflineMapRenderer {
  readonly map: MapLibreMap;
  readonly ready: Promise<void>;
  private currentMarker: Marker | null = null;
  private readonly clusterLabels = new Map<number, Marker>();
  private readonly textLabels = new Map<string, Marker>();
  private photoOpacity = 1;
  private photoClustersVisible = true;
  private onPhotoSelected: ((path: string) => void) | null = null;
  private lastMapError: string | null = null;
  private labelSourceDiagnosticLogged = false;
  private vectorSourceDiagnosticLogged = false;
  private readonly resizeObserver: ResizeObserver;
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
      startCanvasHeight: canvas.height
    };
  };
  private readonly onDiagnosticPointerMove = (event: PointerEvent): void => {
    if (!this.dragDiagnostic || event.pointerId !== this.dragDiagnostic.pointerId) return;
    this.dragDiagnostic.lastX = event.clientX;
    this.dragDiagnostic.lastY = event.clientY;
  };
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
      lastObservedPointer: [start.lastX, start.lastY]
    });
  };

  constructor(container: HTMLElement, center: [number, number], zoom: number, private readonly onError?: (message: string) => void) {
    const options: MapOptions = {
      container, style: AUSTRIA_SHORTBREAD_STYLE, center, zoom,
      minZoom: 0, maxZoom: 20,
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
    // Temporary diagnostics: compare physical pointer movement with MapLibre's
    // container/canvas geometry and camera state for each completed drag.
    const mapContainer = this.map.getContainer();
    mapContainer.addEventListener('pointerdown', this.onDiagnosticPointerDown, true);
    window.addEventListener('pointermove', this.onDiagnosticPointerMove, true);
    window.addEventListener('pointerup', this.onDiagnosticPointerEnd, true);
    window.addEventListener('pointercancel', this.onDiagnosticPointerEnd, true);
    // Keep the WebGL canvas synchronized with layout changes in the settings panel.
    this.resizeObserver = new ResizeObserver(() => this.map.resize());
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
    this.map.on('idle', refreshOverlays);
    this.map.on('moveend', refreshOverlays);
    this.map.on('zoomend', refreshOverlays);
    this.map.on('click', 'photo-clusters', event => {
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
    this.map.on('click', 'photo-unclustered', event => {
      const path = event.features?.[0]?.properties?.['path'];
      if (typeof path === 'string') this.onPhotoSelected?.(path);
    });
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
        marker = new Marker({ element, anchor: 'center' }).addTo(this.map);
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
      { layerId: 'label-water-anchor', sourceLayer: 'water_lines_labels', kind: 'water' },
      { layerId: 'label-water-polygons-anchor', sourceLayer: 'water_polygons_labels', kind: 'water' },
      { layerId: 'label-street-polygons-anchor', sourceLayer: 'streets_polygons_labels', kind: 'street' },
      { layerId: 'label-street-points-anchor', sourceLayer: 'street_labels_points', kind: 'street' },
      { layerId: 'label-streets-anchor', sourceLayer: 'street_labels', kind: 'street' },
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
        const key = source.sourceLayer + ':' + text + ':' + (firstCoordinate?.[0]?.toFixed(5) ?? point[0].toFixed(5)) + ':' + (firstCoordinate?.[1]?.toFixed(5) ?? point[1].toFixed(5));
        candidates.push({ key, x: screenPoint.x, y: screenPoint.y, longitude: point[0], latitude: point[1], text, kind: placeKind, priority });
      }
    }

    candidates.sort((a, b) => a.priority - b.priority);
    const occupied: Array<[number, number, number, number]> = [];
    const seen = new Set<string>();
    const width = this.map.getContainer().clientWidth;
    const height = this.map.getContainer().clientHeight;

    for (const candidate of candidates) {
      if (visible.size >= 300) break;
      const { key, x, y, longitude, latitude, text, kind } = candidate;
      if (x < 0 || y < 0 || x > width || y > height) continue;
      const dedupeKey = `${kind}:${text}:${Math.round(x / 24)}:${Math.round(y / 24)}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const fontSize = kind === 'capital' ? 16 : kind === 'state_capital' ? 15 : kind === 'city' ? 15 : kind === 'town' ? 13 : kind === 'village' ? 12 : kind === 'street' ? 10 : kind === 'water' ? 11 : kind === 'boundary' ? 12 : kind === 'poi' ? 9 : 11;
      const labelWidth = Math.min(260, Math.max(24, text.length * fontSize * 0.56 + 8));
      const labelHeight = fontSize + 7;
      const box: [number, number, number, number] = [x - labelWidth / 2, y - labelHeight / 2, x + labelWidth / 2, y + labelHeight / 2];
      if (occupied.some(other => box[0] < other[2] + 4 && box[2] > other[0] - 4 && box[1] < other[3] + 3 && box[3] > other[1] - 3)) continue;
      occupied.push(box);
      visible.add(key);
      const existingMarker = this.textLabels.get(key);
      if (existingMarker) {
        existingMarker.setLngLat([longitude, latitude]);
        continue;
      }
      const element = document.createElement('span');
      element.textContent = text;
      const color = kind === 'street' ? '#625d55' : kind === 'water' ? '#397b9a' : kind === 'boundary' ? '#806b83' : kind === 'poi' ? '#73583d' : '#393832';
      const weight = kind === 'capital' || kind === 'state_capital' || kind === 'city' ? 700 : kind === 'town' ? 600 : 500;
      const style = kind === 'water' ? 'italic' : 'normal';
      element.style.cssText = `display:block;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${color};font:${style} ${weight} ${fontSize}px/1.2 Segoe UI,Arial,sans-serif;text-shadow:-1px -1px 0 #f1efe8,1px -1px 0 #f1efe8,-1px 1px 0 #f1efe8,1px 1px 0 #f1efe8,0 0 3px #f1efe8;pointer-events:none;text-align:center;`;
      const marker = new Marker({ element, anchor: 'center' }).setLngLat([longitude, latitude]).addTo(this.map);
      this.textLabels.set(key, marker);
    }
    for (const [key, marker] of this.textLabels) {
      if (visible.has(key)) continue;
      marker.remove();
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
    if (this.currentMarker) this.currentMarker.remove();
    this.currentMarker = new Marker({ element, anchor: shape === 'pin' ? 'bottom' : 'center' }).setLngLat([longitude, latitude]).addTo(this.map);
    this.currentMarker.getElement().style.zIndex = '10000';
    this.currentMarker.getElement().style.pointerEvents = 'none';
    this.currentMarker.getElement().style.display = 'block';
  }

  updateCurrentLocation(latitude: number, longitude: number): void {
    this.currentMarker?.setLngLat([longitude, latitude]);
  }

  setCurrentOpacity(opacity: number): void {
    const element = this.currentMarker?.getElement();
    if (element) element.style.opacity = String(opacity);
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
    this.currentMarker?.remove();
    for (const marker of this.clusterLabels.values()) marker.remove();
    this.clusterLabels.clear();
    for (const marker of this.textLabels.values()) marker.remove();
    this.textLabels.clear();
    this.map.remove();
  }
}
