import { ChangeDetectionStrategy, Component, ElementRef, inject, OnDestroy, OnInit, viewChild } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Desktop } from 'internal-api';

interface MapMarker {
  setLatLng(position: [number, number]): MapMarker;
}
interface MapInstance {
  setView(center: [number, number], zoom: number): MapInstance;
  invalidateSize(): MapInstance;
  remove(): void;
}
interface LeafletMapApi {
  map(element: HTMLElement, options?: { zoomControl?: boolean }): MapInstance;
  tileLayer(url: string, options: { attribution: string; maxZoom: number }): { addTo(map: MapInstance): void };
  marker(position: [number, number]): MapMarker & { addTo(map: MapInstance): void };
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
    this.map?.remove();
    this.map = null;
  }

  private readonly onResize = (): void => this.map?.invalidateSize();

  private async initialize(latitude: number, longitude: number): Promise<void> {
    const leaflet = await this.loadLeaflet();
    const center: [number, number] = [latitude, longitude];
    this.map = leaflet.map(this.mapElement().nativeElement, { zoomControl: true }).setView(center, 13);
    leaflet.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(this.map);
    this.marker = leaflet.marker(center).addTo(this.map);
    this.unsubscribeLocation = this.desktop?.MapWindow.onLocationChanged(location => {
      const next: [number, number] = [location.latitude, location.longitude];
      this.marker?.setLatLng(next);
      this.map?.setView(next, this.map.getZoom());
    }) ?? null;
    window.addEventListener('resize', this.onResize);
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
