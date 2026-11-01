import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, OnDestroy, OnInit, signal, viewChild } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Desktop } from 'internal-api';
import { ThemeService } from '../../services/theme/theme.service';

interface MapMarker { setLatLng(position: [number, number]): MapMarker; getLatLng(): { lat: number; lng: number }; }
interface MapBounds { isValid(): boolean; }
interface MapInstance {
  setView(center: [number, number], zoom: number): MapInstance;
  invalidateSize(): MapInstance;
  getZoom(): number;
  setZoom(zoom: number): MapInstance;
  on(event: 'zoomend', callback: () => void): MapInstance;
  fitBounds(bounds: [[number, number], [number, number]], options?: { padding?: [number, number]; maxZoom?: number; animate?: boolean }): MapInstance;
  remove(): void;
}
interface LeafletMapApi {
  map(element: HTMLElement, options?: { zoomControl?: boolean; keyboard?: boolean; minZoom?: number; maxZoom?: number }): MapInstance;
  tileLayer(url: string, options: { attribution: string; maxZoom: number; maxNativeZoom?: number }): { addTo(map: MapInstance): { remove(): void } };
  polyline(points: [number, number][], options: { color: string; weight: number; opacity: number; lineCap: string; lineJoin: string }): { addTo(map: MapInstance): { remove(): void } };
  marker(position: [number, number]): MapMarker & { addTo(map: MapInstance): MapMarker };
}
type MapStyle = 'standard' | 'satellite' | 'cycling' | 'topographic' | 'humanitarian';
type MapColor = 'original' | 'light' | 'extra-light' | 'ultra-light' | 'dark' | 'grayscale' | 'pastel' | 'contrast' | 'night';

@Component({
  selector: 'app-map-window',
  standalone: true,
  template: `
    <main class="map-window" [class.light-theme]="themeService.current() === 'light'" [style.opacity]="windowOpacity() / 100">
      <header class="map-titlebar">
        <div class="map-title"><span class="map-title-icon">⌖</span><strong>Image location</strong></div>
        <span class="titlebar-location-address" [title]="locationAddress()">{{ locationAddress() }}</span>
        <label class="always-on-top-setting titlebar-always-on-top" title="Keep the map window above the main window">
          <input type="checkbox" [checked]="alwaysOnTop()" (change)="changeAlwaysOnTop($any($event.target).checked)"> Always on top
        </label>
        <div class="map-title-actions">
          <span class="map-coordinates">{{ coordinateLabel() }} @if (bearingLabel()) { · {{ bearingLabel() }} }</span>
          <button type="button" class="map-toolbar-button" (click)="copyCoordinates()" title="Copy GPS coordinates" aria-label="Copy GPS coordinates">⧉</button>
          <button type="button" class="map-toolbar-button" (click)="centerMarker()" title="Center map on image location" aria-label="Center map on image location">◎</button>
          <button type="button" class="settings-toggle" [class.active]="settingsOpen()" (click)="toggleSettings()"
                  [attr.aria-expanded]="settingsOpen()" title="Show or hide map settings" aria-label="Map settings">⚙ <span>Settings</span></button>
        </div>
      </header>
      @if (settingsOpen()) {
        <section class="map-settings" aria-label="Map settings">
          <div class="settings-group">
            <label>Coordinate format
              <select [value]="coordinateFormat()" (change)="changeCoordinateFormat($any($event.target).value)">
                <option value="dms">Degrees / minutes / seconds</option>
                <option value="decimal">Decimal degrees</option>
              </select>
            </label>
            <label>Open location in
              <select (change)="openLocationIn($any($event.target).value); $any($event.target).value = ''">
                <option value="">Select web app…</option>
                <option value="google-earth">Google Earth</option>
                <option value="google-maps">Google Maps</option>
                <option value="bing-maps">Bing Maps</option>
                <option value="openstreetmap">OpenStreetMap</option>
                <option value="apple-maps">Apple Maps</option>
              </select>
            </label>
            <label>Map style
              <select [value]="mapStyle()" (change)="changeMapStyle($any($event.target).value)">
                <option value="standard">Standard</option><option value="satellite">Satellite</option>
                <option value="cycling">Cycling (CyclOSM)</option><option value="topographic">Topographic</option>
                <option value="humanitarian">Humanitarian (HOT)</option>
              </select>
            </label>
            <label>Color
              <select [value]="mapColor()" (change)="changeMapColor($any($event.target).value)">
                <option value="original">Original</option><option value="light">Light</option>
                <option value="extra-light">Extra light</option><option value="ultra-light">Ultra light</option>
                <option value="dark">Dark</option><option value="grayscale">Grayscale</option>
                <option value="pastel">Pastel</option><option value="contrast">High contrast</option><option value="night">Night</option>
              </select>
            </label>
          </div>
          <div class="settings-group opacity-settings">
            <strong class="settings-row-title">Opacity:</strong>
            <label class="range-setting">Map
              <input type="range" min="0" max="100" step="1" [value]="mapOpacity()" (input)="changeMapOpacity($any($event.target).value)">
              <span class="range-value">{{ mapOpacity() }}%</span>
            </label>
            <span class="opacity-divider" aria-hidden="true"></span>
            <label class="range-setting">Track
              <input type="range" min="0" max="100" step="1" [value]="gpxOpacity()" (input)="changeGpxOpacity($any($event.target).value)">
              <span class="range-value">{{ gpxOpacity() }}%</span>
            </label>
            <span class="opacity-divider" aria-hidden="true"></span>
            <label class="range-setting window-opacity-setting">Window
              <input type="range" min="0" max="100" step="1" [value]="windowOpacity()" (input)="changeWindowOpacity($any($event.target).value)" title="Window opacity">
              <span class="range-value">{{ windowOpacity() }}%</span>
            </label>
          </div>
          <div class="settings-group zoom-settings">
            <div class="zoom-control">
              <div class="zoom-buttons">
                <button type="button" class="zoom-step" (click)="adjustZoom(-1)" aria-label="Zoom out">−</button>
                <button type="button" class="zoom-step" (click)="adjustZoom(1)" aria-label="Zoom in">+</button>
              </div>
              <input type="range" min="1" max="20" step="1" [value]="zoomLevel()" (input)="changeZoom($any($event.target).value)" aria-label="Map zoom">
              <span class="zoom-value">{{ zoomLevel() }}</span>
            </div>
          </div>
          <div class="settings-group gpx-settings">
            <strong class="settings-row-title">GPX track:</strong>
            <button type="button" (click)="importGpxTrack()">Import GPX…</button>
            <div class="color-picker">
              <button type="button" class="color-picker-trigger" (click)="toggleColorMenu()" [attr.aria-expanded]="colorMenuOpen()" aria-label="GPX track color and visibility">
                @if (gpxVisible()) {
                  <span class="color-swatch" [style.background]="gpxColor()" [style.color]="selectedGpxTextColor()">{{ gpxColor() }}</span>
                  <span>{{ selectedGpxColorName() }}</span>
                } @else { <span>Off</span> }
                <span class="color-picker-chevron">▾</span>
              </button>
              @if (colorMenuOpen()) {
                <div class="color-picker-menu" role="listbox" aria-label="GPX track colors">
                  <button type="button" class="color-option" role="option" [attr.aria-selected]="!gpxVisible()" (click)="changeGpxColor('off')"><span class="color-swatch color-swatch-off">—</span><span>Off</span></button>
                  @for (color of gpxColors; track color.value) {
                    <button type="button" class="color-option" role="option" [attr.aria-selected]="gpxColor() === color.value && gpxVisible()" (click)="changeGpxColor(color.value)">
                      <span class="color-swatch" [style.background]="color.value" [style.color]="color.textColor">{{ color.value }}</span><span>{{ color.name }}</span>
                    </button>
                  }
                </div>
              }
            </div>
            @if (gpxFileName()) { <span class="gpx-filename" [title]="gpxFileName()">{{ gpxFileName() }}</span> }
            @if (gpxError()) { <span class="gpx-error">{{ gpxError() }}</span> }
          </div>
          <div class="settings-group address-settings">
            <strong class="settings-row-title">Location:</strong>
            <span class="location-address">{{ locationAddress() || 'Looking up address…' }}</span>
          </div>
        </section>
      }
      <div #map class="map"></div>
    </main>
  `,
  styles: [`
    :host{display:block;width:100%;height:100%;min-width:0;min-height:0;color:var(--color-content-default-high,#eee);font:13px/1.4 inherit}
    .map-window{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:var(--color-surface-default-low,#202124)}
    .map-titlebar{-webkit-app-region:drag;height:38px;min-height:38px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 10px;background:var(--color-surface-default-low,#292a2d);border-bottom:1px solid var(--color-content-default-low,#444);box-sizing:border-box}
    .map-title,.map-title-actions{display:flex;align-items:center;gap:10px;min-width:0}.map-title{font-size:13px}.map-title-icon{font-size:18px;color:#8ab4f8}
    .map-titlebar button,.map-titlebar select,.map-titlebar label,.map-titlebar input{-webkit-app-region:no-drag}
    .titlebar-location-address{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--color-content-default-medium,#aaa);font-size:11px}
    .titlebar-always-on-top{display:flex;align-items:center;gap:5px;white-space:nowrap;font-size:12px}
    .titlebar-always-on-top input{accent-color:#8ab4f8}
    .map-title-actions{margin-left:auto}.map-coordinates{font-size:11px;color:var(--color-content-default-medium,#aaa);white-space:nowrap}
    button,select{font:inherit;color:var(--color-content-default-high,#eee);background:var(--color-surface-default-high,#383a3f);border:1px solid var(--color-content-default-low,#555);border-radius:4px;padding:4px 8px}
    button{cursor:pointer}button:hover,.settings-toggle.active{background:var(--color-surface-default-medium,#4b5260);border-color:#8ab4f8}
    .settings-toggle{height:28px;white-space:nowrap}.settings-toggle span{margin-left:3px}
    .map-settings{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:8px 10px;background:var(--color-surface-default-low,#252629);border-bottom:1px solid var(--color-content-default-low,#444);box-sizing:border-box}
    .settings-group{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding-right:10px;border-right:1px solid var(--color-content-default-low,#454545)}
    .settings-group:last-child{border-right:0;padding-right:0}.settings-group>label{display:flex;align-items:center;gap:6px;white-space:nowrap}
    select{max-width:170px}.range-setting{min-width:150px}.range-setting input{width:100px;accent-color:#8ab4f8}.range-setting span{color:var(--color-content-default-medium,#aaa);min-width:34px;text-align:right}
    .settings-row-title{flex:0 0 auto;white-space:nowrap}
    .zoom-settings{flex:1;min-width:260px}
    .always-on-top-setting input{accent-color:#8ab4f8}
    .zoom-buttons{display:flex;gap:4px}.zoom-buttons button{width:28px;height:27px;padding:0;font-size:18px}
    .address-settings{flex:0 0 100%;width:100%;border-right:0;border-top:1px solid var(--color-content-default-low,#454545);padding:7px 0 0;gap:8px}
    .location-address{min-width:0;overflow-wrap:anywhere;color:var(--color-content-default-medium,#aaa)}
    .gpx-settings{flex:0 0 100%;width:100%;border-right:0;border-top:1px solid var(--color-content-default-low,#454545);padding:7px 0 0;gap:8px}
    .gpx-filename{max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--color-content-default-medium,#aaa)}.gpx-error{color:#ff8a80}
    .color-picker{position:relative}.color-picker-trigger{display:flex;align-items:center;gap:7px;min-width:132px}.color-picker-chevron{margin-left:auto}
    .color-picker-menu{position:absolute;z-index:1000;top:calc(100% + 4px);left:0;min-width:185px;padding:4px;background:var(--color-surface-default-high,#383a3f);border:1px solid var(--color-content-default-low,#555);border-radius:5px;box-shadow:0 5px 18px #0005}
    .color-option{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:0;background:transparent}.color-option[aria-selected=true]{outline:1px solid #8ab4f8}
    .color-swatch{display:inline-flex;align-items:center;justify-content:center;min-width:78px;padding:3px 6px;border-radius:3px;font:11px/1.3 ui-monospace,monospace;font-weight:600}
    .color-swatch-off{background:var(--color-surface-default-medium,#555);color:var(--color-content-default-high,#fff)}
    .map{flex:1 1 auto;width:100%;min-height:0;background:transparent}
    .zoom-control{display:flex;align-items:center;gap:8px;flex:1;min-width:210px}.zoom-buttons{display:flex;gap:4px;flex:0 0 auto}
    .zoom-control input{flex:1;min-width:70px;accent-color:#8ab4f8}
    .zoom-step{width:28px;height:27px;padding:0;font-size:18px}
    .zoom-value{min-width:22px;text-align:right;font-variant-numeric:tabular-nums}
    .map-toolbar-button{width:27px;height:27px;padding:0;font-size:16px}
    .opacity-settings{order:2;width:100%;flex:0 0 100%;border-right:0;border-top:1px solid var(--color-content-default-low,#454545);padding:7px 0 0;gap:12px}
    .opacity-settings .settings-row-title{flex:0 0 auto}
    .opacity-settings .range-setting{display:flex;align-items:center;gap:7px;flex:1;min-width:150px}
    .opacity-settings .range-setting input{flex:1;width:auto;min-width:55px}
    .opacity-settings .range-value{flex:0 0 38px;min-width:38px;text-align:right;color:var(--color-content-default-medium,#aaa);font-variant-numeric:tabular-nums}
    .opacity-divider{align-self:stretch;width:1px;min-height:24px;background:var(--color-content-default-low,#555);margin:0 3px}
    .window-opacity-setting{flex:1.1}
    :host ::ng-deep .leaflet-control-attribution{opacity:.28;transition:opacity .18s ease}
    :host ::ng-deep .leaflet-control-attribution:hover{opacity:1}
    :host-context(html[data-theme='light']) .map-titlebar{background:#f1f2f4;border-color:#d0d3d8}
    :host-context(html[data-theme='light']) .map-settings{background:#f7f7f8;border-color:#d0d3d8}
    :host-context(html[data-theme='light']) button,:host-context(html[data-theme='light']) select{color:#202124;background:#fff;border-color:#c5c8ce}
    :host-context(html[data-theme='light']) button:hover,:host-context(html[data-theme='light']) .settings-toggle.active{background:#e4eaf3;border-color:#477fc4}
    :host-context(html[data-theme='light']) .map-coordinates,:host-context(html[data-theme='light']) .range-setting span,:host-context(html[data-theme='light']) .gpx-filename{color:#555}
    :host-context(html[data-theme='light']) .map-toolbar-button{color:#202124;background:#fff;border-color:#c5c8ce}
    @media(max-width:650px){.map-coordinates{display:none}.map-settings{align-items:flex-start}.settings-group{width:100%;border-right:0;border-bottom:1px solid var(--color-content-default-low,#454545);padding:0 0 7px}.settings-group:last-child{border-bottom:0}.range-setting{flex:1}.range-setting input{flex:1}}
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class MapWindow implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  protected readonly themeService = inject(ThemeService);
  private readonly mapElement = viewChild.required<ElementRef<HTMLElement>>('map');
  private map: MapInstance | null = null;
  private marker: MapMarker | null = null;
  private leaflet: LeafletMapApi | null = null;
  private readonly desktop = (window as unknown as { desktop?: Desktop }).desktop;
  private unsubscribeLocation: (() => void) | null = null;
  private tileLayer: { remove(): void } | null = null;
  private trackLayers: Array<{ remove(): void }> = [];
  private gpxSegments: [number, number][][] = [];
  private readonly storagePrefix = 'light-matter.mapWindow.';
  protected readonly settingsOpen = signal(false);
  protected readonly colorMenuOpen = signal(false);
  protected readonly alwaysOnTop = signal(this.readSetting('alwaysOnTop', 'false') === 'true');
  protected readonly mapStyle = signal<MapStyle>(this.readSetting('style', 'standard') as MapStyle);
  protected readonly mapColor = signal<MapColor>(this.readSetting('color', 'original') as MapColor);
  protected readonly mapOpacity = signal(this.readNumber('opacity', 100, 0, 100));
  protected readonly windowOpacity = signal(this.readNumber('windowOpacity', 100, 0, 100));
  protected readonly zoomLevel = signal(this.readNumber('zoom', 13, 1, 20));
  protected readonly gpxColor = signal(this.readSetting('gpxColor', '#ff3b30'));
  protected readonly gpxOpacity = signal(this.readNumber('gpxOpacity', 100, 0, 100));
  protected readonly gpxVisible = signal(this.readSetting('gpxVisible', 'true') === 'true');
  protected readonly gpxFileName = signal(this.readSetting('gpxFileName', ''));
  protected readonly gpxError = signal('');
  protected readonly coordinateFormat = signal<'dms' | 'decimal'>(this.readSetting('coordinateFormat', 'dms') === 'decimal' ? 'decimal' : 'dms');
  protected readonly coordinateLabel = signal('');
  protected readonly locationAddress = signal('');
  protected readonly bearing = signal<number | null>(null);
  protected readonly bearingLabel = computed(() => this.bearing() === null ? '' : String(Math.round(this.bearing()!)) + '° ' + this.compassDirection(this.bearing()!));
  protected readonly gpxColors = [
    { name: 'Red', value: '#ff3b30', textColor: '#ffffff' }, { name: 'Orange', value: '#ff9500', textColor: '#171717' },
    { name: 'Yellow', value: '#ffd60a', textColor: '#171717' }, { name: 'Green', value: '#34c759', textColor: '#102014' },
    { name: 'Blue', value: '#0a84ff', textColor: '#ffffff' }, { name: 'Magenta', value: '#bf5af2', textColor: '#ffffff' }
  ] as const;

  ngOnInit(): void {
    document.documentElement.style.backgroundColor = 'transparent';
    document.body.style.backgroundColor = 'transparent';
    document.documentElement.style.colorScheme = this.themeService.current();
    this.applyAlwaysOnTop();
    const bearingParameter = this.route.snapshot.queryParamMap.get('bearing');
    const initialBearing = bearingParameter === null ? NaN : Number(bearingParameter);
    this.bearing.set(Number.isFinite(initialBearing) && initialBearing >= 0 && initialBearing < 360 ? initialBearing : null);
    const latitude = Number(this.route.snapshot.queryParamMap.get('lat'));
    const longitude = Number(this.route.snapshot.queryParamMap.get('lon'));
    if (Number.isFinite(latitude) && Number.isFinite(longitude)
      && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180) {
      this.coordinateLabel.set(this.formatCoordinates(latitude, longitude));
      void this.lookupLocationAddress(latitude, longitude);
      void this.initialize(latitude, longitude);
    }
  }

  ngOnDestroy(): void {
    this.unsubscribeLocation?.();
    window.removeEventListener('resize', this.onResize);
    this.map?.remove();
    this.map = null;
  }

  private readonly onResize = (): void => { this.map?.invalidateSize(); };

  protected readonly copyCoordinates = async (): Promise<void> => {
    const marker = this.marker?.getLatLng(); if (!marker) return;
    try { await navigator.clipboard.writeText(marker.lat.toFixed(6) + ', ' + marker.lng.toFixed(6)); }
    catch (error) { console.error('Failed to copy GPS coordinates', error); }
  };
  protected readonly centerMarker = (): void => {
    const marker = this.marker?.getLatLng();
    if (marker) this.map?.setView([marker.lat, marker.lng], this.map.getZoom());
  };
  private formatCoordinateDms(value: number, latitude: boolean): string {
    const hemisphere = latitude ? (value < 0 ? 'S' : 'N') : (value < 0 ? 'W' : 'E');
    const absolute = Math.abs(value);
    const degrees = Math.floor(absolute);
    const minutesFull = (absolute - degrees) * 60;
    const minutes = Math.floor(minutesFull);
    const seconds = ((minutesFull - minutes) * 60).toFixed(2).padStart(5, '0');
    return `${degrees}° ${String(minutes).padStart(2, '0')}′ ${seconds}″ ${hemisphere}`;
  }

  private formatCoordinates(latitude: number, longitude: number): string {
    if (this.coordinateFormat() === 'decimal') {
      const latHemisphere = latitude < 0 ? 'S' : 'N';
      const lonHemisphere = longitude < 0 ? 'W' : 'E';
      return `${Math.abs(latitude).toFixed(5)}° ${latHemisphere}, ${Math.abs(longitude).toFixed(5)}° ${lonHemisphere}`;
    }
    return `${this.formatCoordinateDms(latitude, true)}, ${this.formatCoordinateDms(longitude, false)}`;
  }

  protected readonly changeCoordinateFormat = (value: string): void => {
    if (value !== 'dms' && value !== 'decimal') return;
    this.coordinateFormat.set(value);
    this.saveSetting('coordinateFormat', value);
    const marker = this.marker?.getLatLng();
    if (marker) this.coordinateLabel.set(this.formatCoordinates(marker.lat, marker.lng));
  };

  private async lookupLocationAddress(latitude: number, longitude: number): Promise<void> {
    this.locationAddress.set('Looking up address…');
    try {
      const url = new URL('https://nominatim.openstreetmap.org/reverse');
      url.search = new URLSearchParams({
        format: 'jsonv2', lat: String(latitude), lon: String(longitude), zoom: '18', addressdetails: '1'
      }).toString();
      const response = await fetch(url.toString(), { headers: { 'Accept-Language': navigator.language || 'en' } });
      if (!response.ok) throw new Error('Reverse geocoding request failed.');
      const result = await response.json() as { display_name?: string };
      this.locationAddress.set(result.display_name?.trim() || 'No street address available for this location.');
    } catch {
      this.locationAddress.set('Address lookup unavailable.');
    }
  }

  protected readonly openLocationIn = (provider: string): void => {
    const marker = this.marker?.getLatLng();
    if (!marker) return;
    const lat = marker.lat;
    const lon = marker.lng;
    const urls: Record<string, string> = {
      'google-earth': `https://earth.google.com/web/@${lat},${lon},1000a,1000d,35y,0h,0t,0r`,
      'google-maps': `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`,
      'bing-maps': `https://www.bing.com/maps?cp=${lat}~${lon}&lvl=16`,
      openstreetmap: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`,
      'apple-maps': `https://maps.apple.com/?ll=${lat},${lon}`
    };
    const url = urls[provider];
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  };

  private compassDirection(degrees: number): string {
    return ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'][Math.round(degrees / 22.5) % 16];
  }
  protected readonly toggleSettings = (): void => { this.settingsOpen.update(open => !open); };
  protected readonly toggleColorMenu = (): void => { this.colorMenuOpen.update(open => !open); };
  protected readonly selectedGpxColorName = (): string => this.gpxColors.find(color => color.value === this.gpxColor())?.name ?? 'Red';
  protected readonly selectedGpxTextColor = (): string => this.gpxColors.find(color => color.value === this.gpxColor())?.textColor ?? '#ffffff';
  protected readonly changeAlwaysOnTop = (enabled: boolean): void => {
    this.alwaysOnTop.set(enabled);
    this.saveSetting('alwaysOnTop', enabled);
    this.applyAlwaysOnTop();
  };
  private applyAlwaysOnTop(): void {
    void this.desktop?.MapWindow.setAlwaysOnTop(this.alwaysOnTop());
  }

  private readSetting(key: string, fallback: string): string {
    try { return localStorage.getItem(this.storagePrefix + key) ?? fallback; } catch { return fallback; }
  }
  private readNumber(key: string, fallback: number, min: number, max: number): number {
    const value = Number(this.readSetting(key, String(fallback)));
    return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  }
  private saveSetting(key: string, value: string | number | boolean): void {
    try { localStorage.setItem(this.storagePrefix + key, String(value)); } catch { /* Keep the current session setting. */ }
  }
  private validZoom(value: number): number { return Math.max(1, Math.min(20, Math.round(value))); }

  private async initialize(latitude: number, longitude: number): Promise<void> {
    this.leaflet = await this.loadLeaflet();
    const center: [number, number] = [latitude, longitude];
    this.map = this.leaflet.map(this.mapElement().nativeElement, { zoomControl: false, keyboard: false, minZoom: 1, maxZoom: 20 })
      .setView(center, this.validZoom(this.zoomLevel()));
    this.map.on('zoomend', () => {
      const zoom = this.validZoom(this.map?.getZoom() ?? this.zoomLevel());
      this.zoomLevel.set(zoom);
      this.saveSetting('zoom', zoom);
    });
    this.marker = this.leaflet.marker(center).addTo(this.map);
    this.applyMapStyle();
    this.applyMapColor();
    this.applyMapOpacity();
    await this.restoreGpxTrack();
    this.unsubscribeLocation = this.desktop?.MapWindow.onLocationChanged(location => {
      const next: [number, number] = [location.latitude, location.longitude];
      this.coordinateLabel.set(this.formatCoordinates(location.latitude, location.longitude));
      void this.lookupLocationAddress(location.latitude, location.longitude);
      this.bearing.set(typeof location.bearing === 'number' && Number.isFinite(location.bearing) ? location.bearing : null);
      this.marker?.setLatLng(next);
      this.map?.setView(next, this.map.getZoom());
    }) ?? null;
    window.addEventListener('resize', this.onResize);
  }

  private readonly styles: Record<MapStyle, { url: string; attribution: string; maxZoom: number; maxNativeZoom?: number }> = {
    standard: { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 20, maxNativeZoom: 19 },
    satellite: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attribution: 'Tiles &copy; Esri', maxZoom: 20, maxNativeZoom: 19 },
    cycling: { url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', attribution: '&copy; OpenStreetMap contributors · CyclOSM', maxZoom: 20 },
    topographic: { url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', attribution: '&copy; OpenStreetMap contributors · OpenTopoMap', maxZoom: 20, maxNativeZoom: 17 },
    humanitarian: { url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', attribution: '&copy; OpenStreetMap contributors · HOT', maxZoom: 20, maxNativeZoom: 19 }
  };
  private readonly filters: Record<MapColor, string> = {
    original: 'none', light: 'brightness(1.12) saturate(.82)', 'extra-light': 'brightness(1.3) saturate(.72) contrast(.94)',
    'ultra-light': 'brightness(1.48) saturate(.64) contrast(.9)', dark: 'brightness(.68) contrast(1.16) saturate(.82)',
    grayscale: 'grayscale(1)', pastel: 'saturate(.62) brightness(1.12) contrast(.88)',
    contrast: 'saturate(1.35) contrast(1.22)', night: 'brightness(.48) contrast(1.35) saturate(.72) hue-rotate(12deg)'
  };

  protected readonly changeMapStyle = (value: string): void => {
    if (!(value in this.styles)) return;
    this.mapStyle.set(value as MapStyle); this.saveSetting('style', value); this.applyMapStyle();
  };
  protected readonly changeMapColor = (value: string): void => {
    if (!(value in this.filters)) return;
    this.mapColor.set(value as MapColor); this.saveSetting('color', value); this.applyMapColor();
  };
  protected readonly changeWindowOpacity = (value: string | number): void => {
    const opacity = Number(value); if (!Number.isFinite(opacity)) return;
    const next = Math.max(0, Math.min(100, Math.round(opacity)));
    this.windowOpacity.set(next);
    this.saveSetting('windowOpacity', next);
  };
  protected readonly changeMapOpacity = (value: string | number): void => {
    const opacity = Number(value); if (!Number.isFinite(opacity)) return;
    const next = Math.max(0, Math.min(100, Math.round(opacity)));
    this.mapOpacity.set(next); this.saveSetting('opacity', next); this.applyMapOpacity();
  };
  protected readonly changeZoom = (value: string | number): void => {
    const zoom = Number(value); if (!Number.isFinite(zoom)) return;
    const next = this.validZoom(zoom); this.zoomLevel.set(next); this.saveSetting('zoom', next); this.map?.setZoom(next);
  };
  protected readonly adjustZoom = (direction: -1 | 1): void => {
    this.changeZoom((this.map?.getZoom() ?? this.zoomLevel()) + direction);
  };
  protected readonly changeGpxOpacity = (value: string | number): void => {
    const opacity = Number(value); if (!Number.isFinite(opacity)) return;
    const next = Math.max(0, Math.min(100, Math.round(opacity)));
    this.gpxOpacity.set(next); this.saveSetting('gpxOpacity', next); this.applyGpxTrack();
  };
  protected readonly gpxSelection = (): string => this.gpxVisible() ? this.gpxColor() : 'off';
  protected readonly changeGpxColor = (value: string): void => {
    if (value === 'off') { this.gpxVisible.set(false); this.saveSetting('gpxVisible', false); }
    else if (this.gpxColors.some(color => color.value === value)) {
      this.gpxColor.set(value); this.gpxVisible.set(true);
      this.saveSetting('gpxColor', value); this.saveSetting('gpxVisible', true);
    } else return;
    this.colorMenuOpen.set(false);
    this.applyGpxTrack();
  };
  protected readonly importGpxTrack = (): void => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.gpx,application/gpx+xml,application/xml,text/xml';
    input.addEventListener('change', () => {
      const file = input.files?.[0]; if (!file) return;
      void file.text().then(content => {
        this.setGpxTrackData(content, file.name, true);
        const path = this.desktop?.getPathForFile(file);
        if (path) { this.saveSetting('gpxPath', path); this.saveSetting('gpxFileName', file.name); }
      }).catch(error => this.gpxError.set(error instanceof Error ? error.message : 'Could not read the GPX file.'));
    }, { once: true });
    input.click();
  };

  private async restoreGpxTrack(): Promise<void> {
    const path = this.readSetting('gpxPath', '');
    const fileName = this.readSetting('gpxFileName', this.gpxFileName());
    if (!path || !fileName || !this.desktop) return;
    const result = await this.desktop.FileSystem.readText(path);
    if (!result.success) { this.gpxError.set('The previously imported GPX file is no longer available.'); return; }
    try { this.setGpxTrackData(result.data, fileName, false); }
    catch (error) { this.gpxError.set(error instanceof Error ? error.message : 'Could not restore the GPX track.'); }
  }

  private setGpxTrackData(content: string, fileName: string, fitTrack: boolean): void {
    const xml = new DOMParser().parseFromString(content, 'application/xml');
    if (xml.getElementsByTagName('parsererror').length) throw new Error('The selected file is not valid GPX/XML.');
    const elements = Array.from(xml.getElementsByTagName('*'));
    let segments = elements.filter(element => element.localName === 'trkseg')
      .map(segment => Array.from(segment.getElementsByTagName('*')).filter(point => point.localName === 'trkpt')
        .map(point => this.parseGpxPoint(point)).filter((point): point is [number, number] => point !== null))
      .filter(segment => segment.length > 0);
    if (!segments.length) {
      const points = elements.filter(element => element.localName === 'trkpt' || element.localName === 'rtept')
        .map(point => this.parseGpxPoint(point)).filter((point): point is [number, number] => point !== null);
      if (points.length) segments = [points];
    }
    if (!segments.length) throw new Error('No valid track or route points were found in the GPX file.');
    this.gpxSegments = segments; this.gpxFileName.set(fileName); this.gpxError.set('');
    this.applyGpxTrack();
    if (fitTrack && this.map) {
      const points = segments.flat();
      const bounds: [[number, number], [number, number]] = [
        [Math.min(...points.map(point => point[0])), Math.min(...points.map(point => point[1]))],
        [Math.max(...points.map(point => point[0])), Math.max(...points.map(point => point[1]))]
      ];
      this.map.fitBounds(bounds, { padding: [24, 24], maxZoom: 16, animate: false });
      this.zoomLevel.set(this.map.getZoom()); this.saveSetting('zoom', this.map.getZoom());
    }
  }
  private parseGpxPoint(point: Element): [number, number] | null {
    const latitude = Number(point.getAttribute('lat')), longitude = Number(point.getAttribute('lon'));
    return Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
      ? [latitude, longitude] : null;
  }
  private applyMapStyle(): void {
    if (!this.map || !this.leaflet) return;
    this.tileLayer?.remove();
    const style = this.styles[this.mapStyle()];
    this.tileLayer = this.leaflet.tileLayer(style.url, style).addTo(this.map);
    this.applyMapColor();
  }
  private applyMapColor(): void {
    const pane = this.mapElement().nativeElement.querySelector<HTMLElement>('.leaflet-tile-pane');
    if (pane) pane.style.filter = this.filters[this.mapColor()];
  }
  private applyMapOpacity(): void {
    const pane = this.mapElement().nativeElement.querySelector<HTMLElement>('.leaflet-tile-pane');
    if (pane) pane.style.opacity = String(this.mapOpacity() / 100);
  }
  private applyGpxTrack(): void {
    for (const layer of this.trackLayers) layer.remove();
    this.trackLayers = [];
    if (!this.map || !this.leaflet || !this.gpxVisible()) return;
    for (const segment of this.gpxSegments) {
      if (segment.length < 2) continue;
      this.trackLayers.push(this.leaflet.polyline(segment, {
        color: this.gpxColor(), weight: 4, opacity: .92 * this.gpxOpacity() / 100, lineCap: 'round', lineJoin: 'round'
      }).addTo(this.map));
    }
  }

  private loadLeaflet(): Promise<LeafletMapApi> {
    const existing = (window as Window & { L?: LeafletMapApi }).L;
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      if (!document.getElementById('light-matter-map-css')) {
        const link = document.createElement('link'); link.id = 'light-matter-map-css'; link.rel = 'stylesheet';
        link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'; document.head.appendChild(link);
      }
      const script = document.createElement('script'); script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      script.onload = () => {
        const api = (window as Window & { L?: LeafletMapApi }).L;
        if (api) resolve(api); else reject(new Error('Leaflet loaded without exposing its API.'));
      };
      script.onerror = () => reject(new Error('Unable to load Leaflet.'));
      document.head.appendChild(script);
    });
  }
}
