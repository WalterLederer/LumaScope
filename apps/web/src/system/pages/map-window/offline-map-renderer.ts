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
    { id: 'pois', type: 'circle', source: 'shortbread', 'source-layer': 'pois', minzoom: 14, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 1.5, 18, 3], 'circle-color': '#a36b42', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 0.6 } }
  ]
};

export class OfflineMapRenderer {
  readonly map: MapLibreMap;
  readonly ready: Promise<void>;
  private currentMarker: Marker | null = null;
  private onPhotoSelected: ((path: string) => void) | null = null;

  constructor(container: HTMLElement, center: [number, number], zoom: number) {
    const options: MapOptions = {
      container, style: AUSTRIA_SHORTBREAD_STYLE, center, zoom,
      minZoom: 0, maxZoom: 18, attributionControl: { compact: false },
      cooperativeGestures: false, renderWorldCopies: false
    };
    this.map = new MapLibreMap(options);
    this.ready = new Promise(resolve => {
      this.map.once('load', () => {
        this.initializePhotoLayers();
        resolve();
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
    this.map.on('click', 'photo-clusters', event => {
      const feature = event.features?.[0];
      const clusterId = feature?.properties?.['cluster_id'];
      const coordinates = feature?.geometry?.type === 'Point' ? feature.geometry.coordinates : null;
      if (typeof clusterId !== 'number' || !coordinates) return;
      const source = this.map.getSource('photo-markers');
      if (!source || !('getClusterExpansionZoom' in source)) return;
      (source as import('maplibre-gl').GeoJSONSource).getClusterExpansionZoom(clusterId, (error, zoom) => {
        if (!error && zoom !== undefined) this.map.easeTo({ center: coordinates as [number, number], zoom });
      });
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
    this.map.setPaintProperty('photo-unclustered', 'circle-opacity', opacity);
    this.map.setPaintProperty('photo-clusters', 'circle-opacity', opacity);
  }

  setBasemapOpacity(opacity: number): void {
    const layers: Array<[string, string]> = [
      ['background', 'background-opacity'], ['land', 'fill-opacity'], ['ocean', 'fill-opacity'],
      ['water-polygons', 'fill-opacity'], ['water-lines', 'line-opacity'], ['boundaries', 'line-opacity'],
      ['streets', 'line-opacity'], ['buildings', 'fill-opacity'], ['pois', 'circle-opacity']
    ];
    for (const [id, property] of layers) if (this.map.getLayer(id)) this.map.setPaintProperty(id, property, opacity);
  }

  setPhotoOpacity(opacity: number): void {
    if (!this.map.getLayer('photo-unclustered')) return;
    this.map.setPaintProperty('photo-unclustered', 'circle-opacity', opacity);
    this.map.setPaintProperty('photo-clusters', 'circle-opacity', opacity);
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
  remove(): void { this.currentMarker?.remove(); this.map.remove(); }
}
