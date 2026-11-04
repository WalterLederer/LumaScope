import { Map as MapLibreMap, Marker, setWorkerUrl, type MapOptions, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

setWorkerUrl(new URL('maplibre-gl/dist/maplibre-gl-worker.mjs', import.meta.url).toString());

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
    { id: 'background', type: 'background', paint: { 'background-color': '#f1efe8' } },
    { id: 'land', type: 'fill', source: 'shortbread', 'source-layer': 'land', paint: { 'fill-color': '#e8e5dc' } },
    { id: 'ocean', type: 'fill', source: 'shortbread', 'source-layer': 'ocean', paint: { 'fill-color': '#a9d5e5' } },
    { id: 'water-polygons', type: 'fill', source: 'shortbread', 'source-layer': 'water_polygons', paint: { 'fill-color': '#a9d5e5' } },
    { id: 'water-lines', type: 'line', source: 'shortbread', 'source-layer': 'water_lines', paint: { 'line-color': '#a9d5e5', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 14, 2] } },
    { id: 'boundaries', type: 'line', source: 'shortbread', 'source-layer': 'boundaries', paint: { 'line-color': '#a58aa2', 'line-width': 1, 'line-dasharray': [2, 2] } },
    {
      id: 'streets', type: 'line', source: 'shortbread', 'source-layer': 'streets', minzoom: 8,
      paint: {
        'line-color': ['match', ['get', 'kind'], 'motorway', '#e58a83', 'trunk', '#edbd79', 'primary', '#edbd79', 'secondary', '#f7f4ed', 'tertiary', '#f7f4ed', '#ffffff'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.35, 14, 2],
        'line-opacity': 0.95
      }
    },
    { id: 'buildings', type: 'fill', source: 'shortbread', 'source-layer': 'buildings', minzoom: 13, paint: { 'fill-color': '#d4c9bd', 'fill-outline-color': '#c2b6aa', 'fill-opacity': 0.85 } },
    { id: 'pois', type: 'circle', source: 'shortbread', 'source-layer': 'pois', minzoom: 14, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 1.5, 18, 3], 'circle-color': '#a36b42', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 0.6 } },
    // Nearly transparent anchor layers let the renderer obtain label geometry
    // without requesting remote MapLibre glyph PBF files.
    { id: 'label-places-anchor', type: 'circle', source: 'shortbread', 'source-layer': 'place_labels', minzoom: 4, paint: { 'circle-radius': 2, 'circle-opacity': 0.01 } },
    { id: 'label-boundaries-anchor', type: 'circle', source: 'shortbread', 'source-layer': 'boundary_labels', minzoom: 3, paint: { 'circle-radius': 2, 'circle-opacity': 0.01 } },
    { id: 'label-streets-anchor', type: 'line', source: 'shortbread', 'source-layer': 'street_labels', minzoom: 11, paint: { 'line-width': 8, 'line-opacity': 0.01 } },
    { id: 'label-water-anchor', type: 'line', source: 'shortbread', 'source-layer': 'water_lines_labels', minzoom: 10, paint: { 'line-width': 6, 'line-opacity': 0.01 } },
    { id: 'label-water-polygons-anchor', type: 'circle', source: 'shortbread', 'source-layer': 'water_polygons_labels', minzoom: 4, paint: { 'circle-radius': 2, 'circle-opacity': 0.01 } },
    { id: 'label-street-polygons-anchor', type: 'circle', source: 'shortbread', 'source-layer': 'streets_polygons_labels', minzoom: 14, paint: { 'circle-radius': 2, 'circle-opacity': 0.01 } },
    { id: 'label-street-points-anchor', type: 'circle', source: 'shortbread', 'source-layer': 'street_labels_points', minzoom: 12, paint: { 'circle-radius': 2, 'circle-opacity': 0.01 } },
    { id: 'label-public-transport-anchor', type: 'circle', source: 'shortbread', 'source-layer': 'public_transport', minzoom: 13, paint: { 'circle-radius': 2, 'circle-opacity': 0.01 } },
    { id: 'label-pois-anchor', type: 'circle', source: 'shortbread', 'source-layer': 'pois', minzoom: 14, paint: { 'circle-radius': 2, 'circle-opacity': 0.01 } }
  ]
};

export class OfflineMapRenderer {
  readonly map: MapLibreMap;
  readonly ready: Promise<void>;
  private currentMarker: Marker | null = null;
  private readonly clusterLabels: Marker[] = [];
  private readonly textLabels: Marker[] = [];
  private photoOpacity = 1;
  private photoClustersVisible = true;
  private onPhotoSelected: ((path: string) => void) | null = null;

  constructor(container: HTMLElement, center: [number, number], zoom: number) {
    const options: MapOptions = {
      container, style: AUSTRIA_SHORTBREAD_STYLE, center, zoom,
      minZoom: 0, maxZoom: 18, attributionControl: { compact: false },
      cooperativeGestures: false, renderWorldCopies: false
    };
    this.map = new MapLibreMap(options);
    let mapErrorCount = 0;
    this.map.on('error', event => {
      if (mapErrorCount++ < 20) console.error('[OfflineMap] MapLibre error:', event.error);
    });
    this.map.on('load', () => console.info('[OfflineMap] MapLibre style loaded.'));
    this.ready = new Promise((resolve, reject) => {
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('MapLibre did not finish loading the offline map within 15 seconds. Check the OfflineMap protocol and tile requests in the application log.'));
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
    this.map.on('idle', () => {
      this.refreshClusterLabels();
      this.refreshTextLabels();
    });
    this.map.on('moveend', () => {
      this.refreshClusterLabels();
      this.refreshTextLabels();
    });
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

  private refreshClusterLabels(): void {
    for (const marker of this.clusterLabels) marker.remove();
    this.clusterLabels.length = 0;
    if (!this.map.getLayer('photo-clusters')) return;
    const features = this.map.queryRenderedFeatures({ layers: ['photo-clusters'] });
    for (const feature of features) {
      if (feature.geometry.type !== 'Point') continue;
      const count = feature.properties?.['point_count'];
      if (typeof count !== 'number') continue;
      const element = document.createElement('span');
      element.textContent = String(count);
      element.style.cssText = 'display:block;color:#fff;font:700 12px/1 Segoe UI,Arial,sans-serif;text-shadow:0 1px 2px #000;text-align:center;pointer-events:none;';
      const marker = new Marker({ element, anchor: 'center' })
        .setLngLat(feature.geometry.coordinates as [number, number]).addTo(this.map);
      this.clusterLabels.push(marker);
    }
  }


  private refreshTextLabels(): void {
    for (const marker of this.textLabels) marker.remove();
    this.textLabels.length = 0;

    const layers = [
      'label-places-anchor',
      'label-boundaries-anchor',
      'label-water-anchor',
      'label-water-polygons-anchor',
      'label-street-polygons-anchor',
      'label-street-points-anchor',
      'label-public-transport-anchor',
      'label-pois-anchor',
      'label-streets-anchor'
    ];
    const features = this.map.queryRenderedFeatures({ layers });
    const candidates: Array<{ x: number; y: number; longitude: number; latitude: number; text: string; kind: string; priority: number }> = [];

    for (const feature of features) {
      const properties = feature.properties ?? {};
      const layerId = feature.layer.id;
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
      if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;

      // queryRenderedFeatures() returns geographic coordinates, not screen pixels.
      // Keep the original coordinates for the DOM marker and project a copy for
      // viewport and collision calculations.
      const screenPoint = this.map.project(point);
      if (!Number.isFinite(screenPoint.x) || !Number.isFinite(screenPoint.y)) continue;

      const isStreet = layerId === 'label-streets-anchor' || layerId === 'label-street-polygons-anchor' || layerId === 'label-street-points-anchor';
      const isWater = layerId === 'label-water-anchor' || layerId === 'label-water-polygons-anchor';
      const isBoundary = layerId === 'label-boundaries-anchor';
      const isPoi = layerId === 'label-public-transport-anchor' || layerId === 'label-pois-anchor';
      const placeKind = String(properties['kind'] ?? '');
      const priority = isStreet ? 3 : isWater ? 2 : isBoundary ? 1 : isPoi ? 4 : 0;
      candidates.push({
        x: screenPoint.x, y: screenPoint.y,
        longitude: point[0], latitude: point[1],
        text, kind: isStreet ? 'street' : isWater ? 'water' : isBoundary ? 'boundary' : isPoi ? 'poi' : placeKind,
        priority
      });
    }

    candidates.sort((a, b) => a.priority - b.priority);
    const occupied: Array<[number, number, number, number]> = [];
    const seen = new Set<string>();
    const width = this.map.getContainer().clientWidth;
    const height = this.map.getContainer().clientHeight;

    for (const candidate of candidates) {
      if (this.textLabels.length >= 180) break;
      const { x, y, longitude, latitude, text, kind } = candidate;
      if (x < 0 || y < 0 || x > width || y > height) continue;
      const key = `${kind}:${text}:${Math.round(x / 24)}:${Math.round(y / 24)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const fontSize = kind === 'capital' ? 16 : kind === 'state_capital' ? 15 : kind === 'city' ? 15 : kind === 'town' ? 13 : kind === 'village' ? 12 : kind === 'street' ? 10 : kind === 'water' ? 11 : kind === 'boundary' ? 12 : kind === 'poi' ? 9 : 11;
      const labelWidth = Math.min(260, Math.max(24, text.length * fontSize * 0.56 + 8));
      const labelHeight = fontSize + 7;
      const box: [number, number, number, number] = [x - labelWidth / 2, y - labelHeight / 2, x + labelWidth / 2, y + labelHeight / 2];
      if (occupied.some(other => box[0] < other[2] + 4 && box[2] > other[0] - 4 && box[1] < other[3] + 3 && box[3] > other[1] - 3)) continue;
      occupied.push(box);

      const element = document.createElement('span');
      element.textContent = text;
      const color = kind === 'street' ? '#625d55' : kind === 'water' ? '#397b9a' : kind === 'boundary' ? '#806b83' : kind === 'poi' ? '#73583d' : '#393832';
      const weight = kind === 'capital' || kind === 'state_capital' || kind === 'city' ? 700 : kind === 'town' ? 600 : 500;
      const style = kind === 'water' ? 'italic' : 'normal';
      element.style.cssText = `display:block;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${color};font:${style} ${weight} ${fontSize}px/1.2 Segoe UI,Arial,sans-serif;text-shadow:-1px -1px 0 #f1efe8,1px -1px 0 #f1efe8,-1px 1px 0 #f1efe8,1px 1px 0 #f1efe8,0 0 3px #f1efe8;pointer-events:none;text-align:center;`;
      const marker = new Marker({ element, anchor: 'center' })
        .setLngLat([longitude, latitude])
        .addTo(this.map);
      this.textLabels.push(marker);
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
    const clip = shape === 'diamond' ? 'polygon(50% 0,100% 50%,50% 100%,0 50%)' : shape === 'pin' ? 'polygon(50% 100%,8% 38%,8% 18%,20% 4%,50% 0,80% 4%,92% 18%,92% 38%)' : 'none';
    element.style.cssText = `width:24px;height:24px;border:3px solid #fff;border-radius:${shape === 'circle' ? '50%' : shape === 'square' ? '3px' : '0'};clip-path:${clip};background:${color};box-shadow:0 1px 6px #000b;opacity:${opacity};`;
    if (this.currentMarker) this.currentMarker.remove();
    this.currentMarker = new Marker({ element, anchor: 'center' }).setLngLat([longitude, latitude]).addTo(this.map);
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
    this.map.setPaintProperty('photo-clusters', 'circle-opacity', this.photoClustersVisible ? 0.95 * opacity : 0);
  }

  setBasemapOpacity(opacity: number): void {
    const layers = [
      ['background', 'background-opacity'], ['land', 'fill-opacity'], ['ocean', 'fill-opacity'],
      ['water-polygons', 'fill-opacity'], ['water-lines', 'line-opacity'], ['boundaries', 'line-opacity'],
      ['streets', 'line-opacity'], ['buildings', 'fill-opacity'], ['pois', 'circle-opacity']
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
  }

  setPhotoOpacity(opacity: number): void {
    this.photoOpacity = opacity;
    if (!this.map.getLayer('photo-unclustered')) return;
    this.map.setPaintProperty('photo-unclustered', 'circle-opacity', opacity);
    this.map.setPaintProperty('photo-clusters', 'circle-opacity', this.photoClustersVisible ? 0.95 * opacity : 0);
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
    this.currentMarker?.remove();
    for (const marker of this.clusterLabels) marker.remove();
    this.clusterLabels.length = 0;
    for (const marker of this.textLabels) marker.remove();
    this.textLabels.length = 0;
    this.map.remove();
  }
}
