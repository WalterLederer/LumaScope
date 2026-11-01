import { ChangeDetectionStrategy, Component, ElementRef, inject, OnDestroy, OnInit, signal, viewChild } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Desktop } from 'internal-api';
import { ThemeService } from '../../services/theme/theme.service';

interface MapMarker { setLatLng(position: [number, number]): MapMarker; }
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
    <main class="map-window" [class.light-theme]="themeService.current() === 'light'">
      <header class="map-titlebar">
        <div class="map-title"><span class="map-title-icon">⌖</span><strong>Image location</strong></div>
        <div class="map-title-actions">
          <span class="map-coordinates">{{ coordinateLabel() }}</span>
          <button type="button" class="settings-toggle" [class.active]="settingsOpen()" (click)="toggleSettings()"
                  [attr.aria-expanded]="settingsOpen()" title="Show or hide map settings" aria-label="Map settings">⚙ <span>Settings</span></button>
        </div>
      </header>
      @if (settingsOpen()) {
        <section class="map-settings" aria-label="Map settings">
          <div class="settings-group">
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
            <label class="range-setting">Map opacity <span>{{ mapOpacity() }}%</span>
              <input type="range" min="0" max="100" step="1" [value]="mapOpacity()" (input)="changeMapOpacity($any($event.target).value)">
            </label>
          </div>
          <div class="settings-group">
            <label class="always-on-top-setting"><input type="checkbox" [checked]="alwaysOnTop()" (change)="changeAlwaysOnTop($any($event.target).checked)"> Always on top</label>
            <label class="range-setting">Zoom <span>{{ zoomLevel() }}</span>
              <input type="range" min="1" max="20" step="1" [value]="zoomLevel()" (input)="changeZoom($any($event.target).value)">
            </label>
            <div class="zoom-buttons">
              <button type="button" (click)="adjustZoom(-1)" aria-label="Zoom out">−</button>
              <button type="button" (click)="adjustZoom(1)" aria-label="Zoom in">+</button>
            </div>
          </div>
          <div class="settings-group gpx-settings">
            <strong>GPX track</strong>
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
            <label class="range-setting">Track opacity <span>{{ gpxOpacity() }}%</span>
              <input type="range" min="0" max="100" step="1" [value]="gpxOpacity()" (input)="changeGpxOpacity($any($event.target).value)">
            </label>
            @if (gpxFileName()) { <span class="gpx-filename" [title]="gpxFileName()">{{ gpxFileName() }}</span> }
            @if (gpxError()) { <span class="gpx-error">{{ gpxError() }}</span> }
          </div>
        </section>
      }
      <div #map class="map"></div>
    </main>
  `,
  styles: [
    :host{display:block;width:100%;height:100%;min-width:0;min-height:0;color:var(--color-content-default-high,#eee);font:13px/1.4 inherit}
    .map-window{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:transparent}
    .map-titlebar{height:38px;min-height:38px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 10px;background:var(--color-surface-default-low,#292a2d);border-bottom:1px solid var(--color-content-default-low,#444);box-sizing:border-box}
    .map-title,.map-title-actions{display:flex;align-items:center;gap:10px;min-width:0}.map-title{font-size:13px}.map-title-icon{font-size:18px;color:#8ab4f8}
    .map-title-actions{margin-left:auto}.map-coordinates{font-size:11px;color:var(--color-content-default-medium,#aaa);white-space:nowrap}
    button,select{font:inherit;color:var(--color-content-default-high,#eee);background:var(--color-surface-default-high,#383a3f);border:1px solid var(--color-content-default-low,#555);border-radius:4px;padding:4px 8px}
    button{cursor:pointer}button:hover,.settings-toggle.active{background:var(--color-surface-default-medium,#4b5260);border-color:#8ab4f8}
    .settings-toggle{height:28px;white-space:nowrap}.settings-toggle span{margin-left:3px}
    .map-settings{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:8px 10px;background:var(--color-surface-default-low,#252629);border-bottom:1px solid var(--color-content-default-low,#444);box-sizing:border-box}
    .settings-group{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding-right:10px;border-right:1px solid var(--color-content-default-low,#454545)}
    .settings-group:last-child{border-right:0;padding-right:0}.settings-group>label{display:flex;align-items:center;gap:6px;white-space:nowrap}
    select{max-width:170px}.range-setting{min-width:150px}.range-setting input{width:100px;accent-color:#8ab4f8}.range-setting span{color:var(--color-content-default-medium,#aaa);min-width:34px;text-align:right}
    .always-on-top-setting input{accent-color:#8ab4f8}
    .zoom-buttons{display:flex;gap:4px}.zoom-buttons button{width:28px;height:27px;padding:0;font-size:18px}
    .gpx-settings{gap:7px}.gpx-settings strong{white-space:nowrap}.gpx-filename{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--color-content-default-medium,#aaa)}.gpx-error{color:#ff8a80}
    .color-picker{position:relative}.color-picker-trigger{display:flex;align-items:center;gap:7px;min-width:132px}.color-picker-chevron{margin-left:auto}
    .color-picker-menu{position:absolute;z-index:1000;top:calc(100% + 4px);left:0;min-width:185px;padding:4px;background:var(--color-surface-default-high,#383a3f);border:1px solid var(--color-content-default-low,#555);border-radius:5px;box-shadow:0 5px 18px #0005}
    .color-option{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:0;background:transparent}.color-option[aria-selected=true]{outline:1px solid #8ab4f8}
    .color-swatch{display:inline-flex;align-items:center;justify-content:center;min-width:78px;padding:3px 6px;border-radius:3px;font:11px/1.3 ui-monospace,monospace;font-weight:600}
    .color-swatch-off{background:var(--color-surface-default-medium,#555);color:var(--color-content-default-high,#fff)}
    .map{flex:1 1 auto;width:100%;min-height:0;background:transparent}
    :host-context(html[data-theme='light']) .map-titlebar{background:#f1f2f4;border-color:#d0d3d8}
    :host-context(html[data-theme='light']) .map-settings{background:#f7f7f8;border-color:#d0d3d8}
    :host-context(html[data-theme='light']) button,:host-context(html[data-theme='light']) select{color:#202124;background:#fff;border-color:#c5c8ce}
    :host-context(html[data-theme='light']) button:hover,:host-context(html[data-theme='light']) .settings-toggle.active{background:#e4eaf3;border-color:#477fc4}
    :host-context(html[data-theme='light']) .map-coordinates,:host-context(html[data-theme='light']) .range-setting span,:host-context(html[data-theme='light']) .gpx-filename{color:#555}
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
  protected readonly zoomLevel = signal(this.readNumber('zoom', 13, 1, 20));
  protected readonly gpxColor = signal(this.readSetting('gpxColor', '#ff3b30'));
  protected readonly gpxOpacity = signal(this.readNumber('gpxOpacity', 100, 0, 100));
  protected readonly gpxVisible = signal(this.readSetting('gpxVisible', 'true') === 'true');
  protected readonly gpxFileName = signal(this.readSetting('gpxFileName', ''));
  protected readonly gpxError = signal('');
  protected readonly coordinateLabel = signal('');
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
    const latitude = Number(this.route.snapshot.queryParamMap.get('lat'));
    const longitude = Number(this.route.snapshot.queryParamMap.get('lon'));
    if (Number.isFinite(latitude) && Number.isFinite(longitude)
      && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180) {
      this.coordinateLabel.set(`${latitude.toFixed(5)}, ${longitude.toFixed(5)}`);
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
      this.coordinateLabel.set(`${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`);
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
