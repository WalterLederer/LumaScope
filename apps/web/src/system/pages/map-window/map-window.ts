import { ChangeDetectionStrategy, Component, ElementRef, inject, OnDestroy, OnInit, viewChild } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Desktop } from 'internal-api';

interface DetachedMapState {
  style?: string; color?: string; opacity?: number; zoom?: number;
  gpxSegments?: [number, number][][]; gpxVisible?: boolean; gpxColor?: string; gpxOpacity?: number; gpxFileName?: string | null;
}

interface MapMarker {
  setLatLng(position: [number, number]): MapMarker;
}
interface MapInstance {
  setView(center: [number, number], zoom: number): MapInstance;
  invalidateSize(): MapInstance;
  getZoom(): number;
  setZoom(zoom: number): MapInstance;
  remove(): void;
}
interface LeafletMapApi {
  map(element: HTMLElement, options?: { zoomControl?: boolean; keyboard?: boolean }): MapInstance;
  tileLayer(url: string, options: { attribution: string; maxZoom: number; maxNativeZoom?: number }): { addTo(map: MapInstance): { remove(): void } };
  polyline(points: [number, number][], options: { color: string; weight: number; opacity: number; lineCap: string; lineJoin: string }): { addTo(map: MapInstance): unknown };
  marker(position: [number, number]): MapMarker & { addTo(map: MapInstance): MapMarker };
}

@Component({
  selector: 'app-map-window',
  standalone: true,
  template: '<main class="map-window"><div #map class="map"></div></main>',
  styles: [':host{display:block;width:100%;height:100%}.map-window,.map{width:100%;height:100%;min-height:0}.map{background:#202124}'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class MapWindow implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly mapElement = viewChild.required<ElementRef<HTMLElement>>('map');
  private map: MapInstance | null = null;
  private marker: MapMarker | null = null;
  private readonly desktop = (window as unknown as { desktop?: Desktop }).desktop;
  private unsubscribeLocation: (() => void) | null = null;
  private readonly onStorage = (event: StorageEvent): void => { if (event.key === 'light-matter.detachedMapState') this.applySharedState(); };
  private tileLayer: { remove(): void } | null = null;
  private trackLayers: Array<{ remove(): void }> = [];
  private state: DetachedMapState = {};

  ngOnInit(): void {
    const latitude = Number(this.route.snapshot.queryParamMap.get('lat'));
    const longitude = Number(this.route.snapshot.queryParamMap.get('lon'));
    if (Number.isFinite(latitude) && Number.isFinite(longitude)
      && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180) {
      void this.initialize(latitude, longitude);
    }
  }

  ngOnDestroy(): void {
    this.unsubscribeLocation?.();
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('storage', this.onStorage);
    this.map?.remove();
    this.map = null;
  }

  private readonly onResize = (): void => {
    this.map?.invalidateSize();
  };

  private async initialize(latitude: number, longitude: number): Promise<void> {
    const leaflet = await this.loadLeaflet();
    const center: [number, number] = [latitude, longitude];
    this.readSharedState();
    this.map = leaflet.map(this.mapElement().nativeElement, { zoomControl: true, keyboard: false }).setView(center, this.validZoom(this.state.zoom));
    this.applySharedState();
    this.marker = leaflet.marker(center).addTo(this.map);
    window.addEventListener('storage', this.onStorage);
    this.unsubscribeLocation = this.desktop?.MapWindow.onLocationChanged(location => {
      const next: [number, number] = [location.latitude, location.longitude];
      this.marker?.setLatLng(next);
      this.map?.setView(next, this.map.getZoom());
    }) ?? null;
    window.addEventListener('resize', this.onResize);
  }

  private validZoom(value?: number): number { return Number.isFinite(value) ? Math.max(1, Math.min(20, Number(value))) : 13; }

  private readSharedState(): void {
    try { this.state = JSON.parse(localStorage.getItem('light-matter.detachedMapState') ?? '{}') as DetachedMapState; }
    catch { this.state = {}; }
  }

  private applySharedState(): void {
    this.readSharedState();
    if (!this.map) return;
    const styles: Record<string, { url: string; attribution: string; maxZoom: number; maxNativeZoom?: number }> = {
      standard: { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '&copy; OpenStreetMap contributors', maxZoom: 20, maxNativeZoom: 19 },
      satellite: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attribution: 'Tiles &copy; Esri', maxZoom: 20, maxNativeZoom: 19 },
      cycling: { url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', attribution: '&copy; OpenStreetMap contributors · CyclOSM', maxZoom: 20 },
      topographic: { url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', attribution: 'OpenStreetMap contributors · OpenTopoMap', maxZoom: 20, maxNativeZoom: 17 },
      humanitarian: { url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', attribution: '&copy; OpenStreetMap contributors · HOT', maxZoom: 20, maxNativeZoom: 19 }
    };
    const style = styles[this.state.style ?? 'standard'] ?? styles['standard'];
    this.tileLayer?.remove();
    const leaflet = (window as Window & { L?: LeafletMapApi }).L;
    this.tileLayer = leaflet?.tileLayer(style.url, style).addTo(this.map) ?? null;
    const pane = this.mapElement().nativeElement.querySelector<HTMLElement>('.leaflet-tile-pane');
    const filters: Record<string, string> = { original: 'none', light: 'brightness(1.12) saturate(.82)', 'extra-light': 'brightness(1.3) saturate(.72) contrast(.94)', 'ultra-light': 'brightness(1.48) saturate(.64) contrast(.9)', dark: 'brightness(.68) contrast(1.16) saturate(.82)', grayscale: 'grayscale(1)', pastel: 'saturate(.62) brightness(1.12) contrast(.88)', contrast: 'saturate(1.35) contrast(1.22)', night: 'brightness(.48) contrast(1.35) saturate(.72) hue-rotate(12deg)' };
    if (pane) { pane.style.filter = filters[this.state.color ?? 'original'] ?? 'none'; pane.style.opacity = String(Math.max(0, Math.min(100, this.state.opacity ?? 100)) / 100); }
    for (const layer of this.trackLayers) layer.remove();
    this.trackLayers = [];
    if (leaflet && this.state.gpxVisible && Array.isArray(this.state.gpxSegments)) {
      for (const segment of this.state.gpxSegments) if (Array.isArray(segment) && segment.length > 1) {
        this.trackLayers.push(leaflet.polyline(segment, { color: this.state.gpxColor ?? '#ff3b30', weight: 4, opacity: .92 * Math.max(0, Math.min(100, this.state.gpxOpacity ?? 100)) / 100, lineCap: 'round', lineJoin: 'round' }).addTo(this.map) as { remove(): void });
      }
    }
    this.map.setZoom(this.validZoom(this.state.zoom));
  }

  private loadLeaflet(): Promise<LeafletMapApi> {
    const existing = (window as Window & { L?: LeafletMapApi }).L;
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      if (!document.getElementById('light-matter-map-css')) {
        const link = document.createElement('link');
        link.id = 'light-matter-map-css';
        link.rel = 'stylesheet';
        link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
        document.head.appendChild(link);
      }
      const script = document.createElement('script');
      script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      script.onload = () => {
        const api = (window as Window & { L?: LeafletMapApi }).L;
        if (api) resolve(api);
        else reject(new Error('Leaflet loaded without exposing its API.'));
      };
      script.onerror = () => reject(new Error('Unable to load Leaflet.'));
      document.head.appendChild(script);
    });
  }
}
