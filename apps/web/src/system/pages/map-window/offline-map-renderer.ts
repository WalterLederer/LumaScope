import { Map as MapLibreMap, setWorkerUrl, type MapOptions, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

// Keep the WebGL worker local to the packaged application. No CDN or runtime
// download is required when the offline map window is opened.
setWorkerUrl(new URL('maplibre-gl/dist/maplibre-gl-worker.mjs', import.meta.url).toString());

const AUSTRIA_BOUNDS: [number, number, number, number] = [9.52678, 46.36979, 17.16408, 49.02403];

/**
 * A self-contained MapLibre style for the Shortbread 1.0 vector tile schema.
 * This first renderer deliberately uses geometry layers only: no glyph, sprite,
 * remote style, or remote tile requests are made. Local labels can be added
 * once the offline glyph assets are bundled with the application.
 */
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
    {
      id: 'background',
      type: 'background',
      paint: { 'background-color': '#f1efe8' }
    },
    {
      id: 'ocean',
      type: 'fill',
      source: 'shortbread',
      'source-layer': 'ocean',
      paint: { 'fill-color': '#a9d5e5' }
    },
    {
      id: 'water-polygons',
      type: 'fill',
      source: 'shortbread',
      'source-layer': 'water_polygons',
      paint: { 'fill-color': '#a9d5e5' }
    },
    {
      id: 'water-lines',
      type: 'line',
      source: 'shortbread',
      'source-layer': 'water_lines',
      paint: { 'line-color': '#a9d5e5', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 14, 2] }
    },
    {
      id: 'land',
      type: 'fill',
      source: 'shortbread',
      'source-layer': 'land',
      paint: { 'fill-color': '#e8e5dc', 'fill-opacity': 0.55 }
    },
    {
      id: 'boundaries',
      type: 'line',
      source: 'shortbread',
      'source-layer': 'boundaries',
      paint: { 'line-color': '#a58aa2', 'line-width': 1, 'line-dasharray': [2, 2] }
    },
    {
      id: 'streets',
      type: 'line',
      source: 'shortbread',
      'source-layer': 'streets',
      minzoom: 13,
      paint: {
        'line-color': [
          'match', ['get', 'kind'],
          'motorway', '#e58a83',
          ['trunk', 'primary'], '#edbd79',
          ['secondary', 'tertiary'], '#f7f4ed',
          '#ffffff'
        ],
        'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.5, 14, 2],
        'line-opacity': 0.95
      }
    },
    {
      id: 'buildings',
      type: 'fill',
      source: 'shortbread',
      'source-layer': 'buildings',
      minzoom: 14,
      paint: { 'fill-color': '#d4c9bd', 'fill-outline-color': '#c2b6aa', 'fill-opacity': 0.85 }
    },
    {
      id: 'pois',
      type: 'circle',
      source: 'shortbread',
      'source-layer': 'pois',
      minzoom: 14,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 1.5, 18, 3],
        'circle-color': '#a36b42',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 0.6
      }
    }
  ]
};

export class OfflineMapRenderer {
  readonly map: MapLibreMap;

  constructor(container: HTMLElement, center: [number, number], zoom: number) {
    const options: MapOptions = {
      container,
      style: AUSTRIA_SHORTBREAD_STYLE,
      center,
      zoom,
      minZoom: 0,
      maxZoom: 18,
      attributionControl: { compact: false },
      cooperativeGestures: false,
      renderWorldCopies: false
    };
    this.map = new MapLibreMap(options);
  }

  resize(): void {
    this.map.resize();
  }

  remove(): void {
    this.map.remove();
  }
}
