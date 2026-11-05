import { ChangeDetectionStrategy, Component, ElementRef, computed, HostListener, inject, OnDestroy, OnInit, signal, viewChild } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Desktop, lookupReverseGeocoding } from 'internal-api';
import { ThemeService } from '../../services/theme/theme.service';
import { OfflineMapRenderer, buildPhotoMarkerPreviewHtml, type OfflinePhotoMarker, type OfflineMapStyle } from './offline-map-renderer';

interface MapMarker { setLatLng(position: [number, number]): MapMarker; setOpacity(opacity: number): MapMarker; setIcon(icon: unknown): MapMarker; getLatLng(): { lat: number; lng: number }; on(event: 'click', callback: () => void): MapMarker; bindTooltip(content: string, options?: { direction?: string; className?: string; opacity?: number }): MapMarker; }
interface MapBounds { isValid(): boolean; }
interface MapMarkerGroup { addTo(map: MapInstance): MapMarkerGroup; addLayer(marker: MapMarker): MapMarkerGroup; clearLayers(): MapMarkerGroup; eachLayer(callback: (layer: MapMarker) => void): MapMarkerGroup; refreshClusters?(): MapMarkerGroup; remove(): void; }
interface MapMarkerCluster { getChildCount(): number; }
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
  marker(position: [number, number], options?: { icon?: unknown }): MapMarker & { addTo(map: MapInstance | MapMarkerGroup): MapMarker };
  divIcon(options: { className: string; html: string; iconSize: [number, number]; iconAnchor: [number, number] }): unknown;
  markerClusterGroup(options?: { chunkedLoading?: boolean; showCoverageOnHover?: boolean; spiderfyOnMaxZoom?: boolean; iconCreateFunction?: (cluster: MapMarkerCluster) => unknown }): MapMarkerGroup;
}
type MapStyle = 'standard' | 'satellite' | 'cycling' | 'topographic' | 'humanitarian';
type MapColor = 'original' | 'light' | 'extra-light' | 'ultra-light' | 'dark' | 'grayscale' | 'pastel' | 'contrast' | 'night';
type MarkerShape = 'double-circle' | 'hexagon' | 'circle' | 'square';
type CurrentMarkerShape = 'pin' | 'circle' | 'square' | 'diamond';

@Component({
  selector: 'app-map-window',
  standalone: true,
  host: { '[class.overlay-mode]': 'overlayMode' },
  template: `
    <main class="map-window" [class.light-theme]="themeService.current() === 'light'">
      <header class="map-titlebar">
        <button type="button" class="settings-toggle" [class.active]="settingsOpen()" (click)="toggleSettings()"
                [attr.aria-expanded]="settingsOpen()" title="Show or hide map settings" aria-label="Map settings">{{ settingsOpen() ? 'v Settings' : '> Settings' }}</button>
        <div class="map-title"><span class="map-title-icon">⌖</span></div>
        <label class="always-on-top-setting titlebar-always-on-top" title="Keep the map window above the main window">
          <input type="checkbox" [checked]="alwaysOnTop()" (change)="changeAlwaysOnTop($any($event.target).checked)"> Always on top
        </label>
        @if (overlayMode) {
          <button type="button" class="overlay-close-button" (click)="closeOverlayWindow()" title="Close overlay" aria-label="Close overlay">×</button>
        }
      </header>
      @if (settingsOpen()) {
        <section class="map-settings" aria-label="Map settings">
          <details class="settings-group location-settings" open>
            <summary>Location</summary>
            <div class="location-settings-content">
              <div class="location-coordinate-display"><span>{{ coordinateLabel() }} @if (bearingLabel()) { · {{ bearingLabel() }} }</span></div>
              <div class="address-settings">
                <span class="settings-row-title">Address:</span>
                <span class="location-address" role="status" [class.location-address-error]="locationAddress().startsWith('Reverse geocoding failed:')">{{ locationAddress() || 'Looking up address…' }}</span>
              </div>
              <div class="location-actions">
                <button type="button" class="map-toolbar-button" (click)="copyCoordinates()" title="Copy GPS coordinates" aria-label="Copy GPS coordinates"><span aria-hidden="true">⧉</span> Copy GPS coordinates</button>
                <button type="button" class="map-toolbar-button" (click)="centerMarker()" title="Center map on image location" aria-label="Center map on image location"><span aria-hidden="true">◎</span> Center</button>
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
              </div>
              <div class="marker-current-appearance-settings">
                <span>Location Icon:</span>
                <label>Shape
                  <select [value]="currentMarkerShape()" (change)="changeCurrentMarkerShape($any($event.target).value)">
                    <option value="pin">Location pin</option><option value="circle">Circle</option><option value="square">Square</option><option value="diamond">Diamond</option>
                  </select>
                </label>
                <label>Color</label>
                <div class="color-picker">
                  <button type="button" class="color-picker-trigger" (click)="toggleCurrentMarkerColorMenu()" [attr.aria-expanded]="currentMarkerColorMenuOpen()" aria-label="Current location marker color">
                    <span class="color-swatch" [style.background]="currentMarkerColor()" [style.color]="selectedCurrentMarkerTextColor()">{{ currentMarkerColor() }}</span>
                    <span>{{ selectedCurrentMarkerColorName() }}</span>
                    <span class="color-picker-chevron">▾</span>
                  </button>
                  @if (currentMarkerColorMenuOpen()) {
                    <div class="color-picker-menu" role="listbox" aria-label="Current location marker colors">
                      @for (color of gpxColors; track color.value) {
                        <button type="button" class="color-option" role="option" [attr.aria-selected]="currentMarkerColor() === color.value" (click)="changeCurrentMarkerColor(color.value)"><span class="color-swatch" [style.background]="color.value" [style.color]="color.textColor">{{ color.value }}</span><span>{{ color.name }}</span></button>
                      }
                    </div>
                  }
                </div>
              </div>
            </div>
          </details>
          <details class="settings-group map-source-settings" open>
            <summary>Map Source</summary>
            <div class="map-source-content">
              <label><span>Source:</span>
                <select class="map-source-select" [value]="mapSource()" (change)="changeMapSource($any($event.target).value)">
                  <option value="online">Online — {{ mapStyle() === 'standard' ? 'OpenStreetMap' : mapStyle() === 'satellite' ? 'Esri World Imagery' : mapStyle() === 'cycling' ? 'CyclOSM' : mapStyle() === 'topographic' ? 'OpenTopoMap' : 'Humanitarian OpenStreetMap Team (HOT)' }}</option><option value="offline">Offline — Austria Shortbread (MBTiles)</option>
                </select>
              </label>
              @if (mapSource() === 'online') {
                <label class="online-map-style-control"><span>Style:</span>
                  <select [value]="mapStyle()" (change)="changeMapStyle($any($event.target).value)">
                    <option value="standard">Standard</option><option value="satellite">Satellite</option>
                    <option value="cycling">Cycling (CyclOSM)</option><option value="topographic">Topographic</option>
                    <option value="humanitarian">Humanitarian (HOT)</option>
                  </select>
                </label>
              } @else {
                <label><span>Offline Style:</span>
                  <select [value]="offlineMapStyle()" (change)="changeOfflineMapStyle($any($event.target).value)">
                    <option value="lumascope">LumaScope</option>
                    <option value="versatiles-colorful">VersaTiles Colorful</option>
                    <option value="versatiles-neutrino">VersaTiles Neutrino</option>
                  </select>
                </label>
              }
              <label><span>Color:</span>
                <select [value]="mapColor()" (change)="changeMapColor($any($event.target).value)">
                  <option value="original">Original</option><option value="light">Light</option>
                  <option value="extra-light">Extra light</option><option value="ultra-light">Ultra light</option>
                  <option value="dark">Dark</option><option value="grayscale">Grayscale</option>
                  <option value="pastel">Pastel</option><option value="contrast">High contrast</option><option value="night">Night</option>
                </select>
              </label>
              <div class="mbtiles-selection">
                <button type="button" (click)="openMbtilesDownload()" title="URL: https://download.geofabrik.de/europe/austria.html&#10;DOWNLOAD .mbtile format: experimental vector tile package conforming to Shortbread schema for use with MapLibre and other MVT capable software">Download MBTiles…</button>
                <button type="button" (click)="chooseOfflineMap()">Select MBTiles…</button>
                <span class="offline-map-status" role="status">{{ offlineMapStatusText() }}</span>
                @if (offlineMapStatus()?.filePath) {
                  <code class="mbtiles-full-path" [title]="offlineMapStatus()!.filePath!">{{ offlineMapStatus()!.filePath }}</code>
                }
              </div>
            </div>
          </details>
          <details class="settings-group opacity-settings">
            <summary>View</summary>
            <div class="opacity-content">
              <div class="zoom-control">
                <span class="zoom-label">Zoom</span>
                <div class="zoom-buttons">
                  <button type="button" class="zoom-step" (click)="adjustZoom(-1)" aria-label="Zoom out">−</button>
                  <button type="button" class="zoom-step" (click)="adjustZoom(1)" aria-label="Zoom in">+</button>
                </div>
                <input type="range" min="1" max="20" step="1" [value]="zoomLevel()" (input)="changeZoom($any($event.target).value)" aria-label="Map zoom">
                <span class="zoom-value">{{ zoomLevel() }}</span>
              </div>
              <div class="range-setting">
                <label class="visibility-toggle"><input type="checkbox" [checked]="mapVisible()" (change)="changeMapVisibility($any($event.target).checked)" aria-label="Show map"> Map</label>
                <input type="range" min="0" max="100" step="1" [value]="mapOpacity()" (input)="changeMapOpacity($any($event.target).value)">
                <span class="range-value">{{ mapOpacity() }}%</span>
              </div>
              <div class="range-setting">
                <label class="visibility-toggle"><input type="checkbox" [checked]="gpxVisible()" (change)="changeTrackVisibility($any($event.target).checked)" aria-label="Show track"> Track</label>
                <input type="range" min="0" max="100" step="1" [value]="gpxOpacity()" (input)="changeGpxOpacity($any($event.target).value)">
                <span class="range-value">{{ gpxOpacity() }}%</span>
              </div>
              <div class="range-setting">
                <label class="visibility-toggle"><input type="checkbox" [checked]="markersVisible()" (change)="changeMarkersVisibility($any($event.target).checked)" aria-label="Show markers"> Markers</label>
                <input type="range" min="0" max="100" step="1" [value]="markerOpacity()" (input)="changeMarkerOpacity($any($event.target).value)">
                <span class="range-value">{{ markerOpacity() }}%</span>
              </div>
              <div class="range-setting">
                <label class="visibility-toggle"><input type="checkbox" [checked]="locationVisible()" (change)="changeLocationVisibility($any($event.target).checked)" aria-label="Show location"> Location</label>
                <input type="range" min="0" max="100" step="1" [value]="locationOpacity()" (input)="changeLocationOpacity($any($event.target).value)">
                <span class="range-value">{{ locationOpacity() }}%</span>
              </div>
            </div>
          </details>

          <details class="settings-group gpx-settings">
            <summary>GPX track</summary>
            <div class="gpx-settings-content">
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
          </details>
          <details class="settings-group marker-settings" [open]="markerSectionOpen()" (toggle)="onMarkerSectionToggle($event)">
            <summary>Marker <span class="marker-description">Show all geotagged images in this folder</span></summary>
            <div class="marker-settings-content">
              <div class="marker-appearance-settings">
                <span>Cluster Icons:</span>
                <label>Shape
                  <select [value]="markerShape()" (change)="changeMarkerShape($any($event.target).value)">
                    <option value="double-circle">Double circles</option><option value="hexagon">Hexagon</option><option value="circle">Circle</option><option value="square">Square</option>
                  </select>
                </label>
                <label>Color</label>
                <div class="color-picker">
                  <button type="button" class="color-picker-trigger" (click)="toggleMarkerColorMenu()" [attr.aria-expanded]="markerColorMenuOpen()" aria-label="Folder marker color and visibility">
                    @if (markerColorVisible()) {
                      <span class="color-swatch" [style.background]="markerColor() === 'dynamic' ? '#34c759' : markerColor()" [style.color]="selectedMarkerTextColor()">{{ markerColor() === 'dynamic' ? 'Dynamic' : markerColor() }}</span>
                      <span>{{ selectedMarkerColorName() }}</span>
                    } @else { <span>Off</span> }
                    <span class="color-picker-chevron">▾</span>
                  </button>
                  @if (markerColorMenuOpen()) {
                    <div class="color-picker-menu" role="listbox" aria-label="Folder marker colors">
                      <button type="button" class="color-option" role="option" [attr.aria-selected]="!markerColorVisible()" (click)="changeMarkerColor('off')"><span class="color-swatch color-swatch-off">—</span><span>Off</span></button>
                      <button type="button" class="color-option" role="option" [attr.aria-selected]="markerColor() === 'dynamic' && markerColorVisible()" (click)="changeMarkerColor('dynamic')"><span class="color-swatch" style="background:linear-gradient(90deg,#34c759 0 33%,#ffd60a 33% 66%,#ff3b30 66%);color:#171717">↗</span><span>Dynamic</span></button>
                      @for (color of gpxColors; track color.value) {
                        <button type="button" class="color-option" role="option" [attr.aria-selected]="markerColor() === color.value && markerColorVisible()" (click)="changeMarkerColor(color.value)"><span class="color-swatch" [style.background]="color.value" [style.color]="color.textColor">{{ color.value }}</span><span>{{ color.name }}</span></button>
                      }
                    </div>
                  }
                </div>
              </div>
              @if (directoryMarkersEnabled()) {
                <div class="marker-progress-row">
                  <div class="marker-progress-text">Database records: <strong>{{ markerFilesChecked() }} / {{ markerFilesTotal() }}</strong></div>
                  <progress class="marker-progress" [max]="markerFilesTotal() || 1" [value]="markerFilesChecked()"></progress>
                </div>
                <div class="marker-statistics"><span>GPS markers found: <strong>{{ markerCount() }}</strong></span></div>
                <div class="marker-status" role="status">{{ markerStatus() }}</div>
              }
            </div>
          </details>

        </section>
      }
      <div #map class="map" [class.map-hidden]="!coordinatesAvailable()"></div>
      @if (!coordinatesAvailable()) {
        <div class="map-unavailable" role="status">GPS coordinates are not available for this image.</div>
      }
      @if (overlayMode) {
        <div class="overlay-resize-handle resize-n" (pointerdown)="startOverlayResize($event, 'n')"></div>
        <div class="overlay-resize-handle resize-e" (pointerdown)="startOverlayResize($event, 'e')"></div>
        <div class="overlay-resize-handle resize-s" (pointerdown)="startOverlayResize($event, 's')"></div>
        <div class="overlay-resize-handle resize-w" (pointerdown)="startOverlayResize($event, 'w')"></div>
        <div class="overlay-resize-handle resize-ne" (pointerdown)="startOverlayResize($event, 'ne')"></div>
        <div class="overlay-resize-handle resize-se" (pointerdown)="startOverlayResize($event, 'se')"></div>
        <div class="overlay-resize-handle resize-sw" (pointerdown)="startOverlayResize($event, 'sw')"></div>
        <div class="overlay-resize-handle resize-nw" (pointerdown)="startOverlayResize($event, 'nw')"></div>
      }
    </main>
  `,
  styles: [`
    :host{display:block;width:100%;height:100%;min-width:0;min-height:0;color:var(--color-content-default-high,#eee);font:13px/1.4 inherit}
    .map-window{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:var(--color-surface-default-low,#202124)}
    :host(.overlay-mode) .map-window{background:transparent;border:1px solid rgba(255,255,255,.48);border-radius:8px;overflow:hidden;box-shadow:0 8px 28px rgba(0,0,0,.28)}
    :host(.overlay-mode) .map-titlebar{background:rgba(32,33,36,.88);border-bottom-color:rgba(255,255,255,.22)}
    :host(.overlay-mode) .map-settings{background:rgba(32,33,36,.96)}
    .overlay-close-button{margin-left:auto;width:28px;height:28px;padding:0;font-size:21px;line-height:1}
    .overlay-resize-handle{position:absolute;z-index:1300;touch-action:none;-webkit-app-region:no-drag}
    .resize-n,.resize-s{left:10px;right:10px;height:6px;cursor:ns-resize}.resize-n{top:0}.resize-s{bottom:0}
    .resize-e,.resize-w{top:10px;bottom:10px;width:6px;cursor:ew-resize}.resize-e{right:0}.resize-w{left:0}
    .resize-ne,.resize-sw,.resize-nw,.resize-se{width:12px;height:12px}
    .resize-ne{top:0;right:0;cursor:nesw-resize}.resize-sw{bottom:0;left:0;cursor:nesw-resize}
    .resize-nw{top:0;left:0;cursor:nwse-resize}.resize-se{right:0;bottom:0;cursor:nwse-resize}
    .map-titlebar{position:relative;z-index:1100;-webkit-app-region:drag;height:38px;min-height:38px;display:flex;align-items:center;justify-content:flex-start;gap:12px;padding:0 10px;background:var(--color-surface-default-low,#292a2d);border-bottom:1px solid var(--color-content-default-low,#444);box-sizing:border-box}
    .map-title{display:flex;align-items:center;gap:8px;min-width:0;flex:0 0 auto;font-size:13px}.map-title-icon{font-size:18px;color:#8ab4f8}
    .map-titlebar button,.map-titlebar select,.map-titlebar label,.map-titlebar input{-webkit-app-region:no-drag}
    .titlebar-always-on-top{display:flex;align-items:center;gap:5px;white-space:nowrap;font-size:12px}
    .titlebar-always-on-top input{accent-color:#8ab4f8}
    .map-coordinates{font-size:11px;color:var(--color-content-default-medium,#aaa);white-space:nowrap;min-width:0;overflow:hidden;text-overflow:ellipsis}
    button,select{font:inherit;color:var(--color-content-default-high,#eee);background:var(--color-surface-default-high,#383a3f);border:1px solid var(--color-content-default-low,#555);border-radius:4px;padding:4px 8px}
    button{cursor:pointer}button:hover,.settings-toggle.active{background:var(--color-surface-default-medium,#4b5260);border-color:#8ab4f8}
    .settings-toggle{height:28px;white-space:nowrap;flex:0 0 auto}
    .map-settings{position:relative;z-index:1000;display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:8px 10px;background:var(--color-surface-default-low,#252629);border-bottom:0;box-sizing:border-box}
    .settings-group{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding-right:10px;border-right:1px solid var(--color-content-default-low,#454545)}
    .map-source-settings,.opacity-settings{display:flex;flex-direction:column;align-items:stretch;gap:7px;min-width:180px;padding:5px 10px}
    .map-source-settings{border:0;padding:5px 0;box-shadow:none;margin:0}
    .gpx-settings{display:flex;flex-direction:column;align-items:stretch;gap:7px;min-width:150px;padding:5px 10px}
    .gpx-settings>summary{cursor:pointer;font-weight:700;white-space:nowrap;list-style:disclosure-closed}
    .gpx-settings[open]>summary{margin-bottom:2px}
    .gpx-settings-content{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
    .opacity-content .zoom-control{grid-column:1/-1;width:100%}
    .address-settings{display:flex;align-items:flex-start;flex-wrap:wrap;gap:6px;flex:1 1 100%;min-width:0;padding-top:7px;border-top:1px solid var(--color-content-default-low,#454545)}

    .map-source-settings>summary,.opacity-settings>summary{cursor:pointer;font-weight:700;white-space:nowrap;list-style:disclosure-closed}
    .map-source-settings[open]>summary,.opacity-settings[open]>summary{margin-bottom:2px}
    .map-source-content,.opacity-content{display:flex;align-items:center;flex-wrap:wrap;gap:8px 14px;min-width:0}
    .map-source-content>label{display:flex;align-items:center;gap:6px;white-space:nowrap}.map-source-content>.online-map-style-control{display:flex;visibility:visible}
    .map-source-select{width:340px;max-width:none}
    .mbtiles-selection{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:5px 8px;flex:1 1 100%;min-width:0}
    .mbtiles-full-path{grid-column:1/-1;display:block;max-width:100%;overflow-wrap:anywhere;white-space:normal;color:var(--color-content-default-medium,#aaa);font-size:11px}
    .opacity-content{display:grid;grid-template-columns:repeat(2,minmax(150px,1fr));width:min(520px,100%)}
    .opacity-content .range-setting{display:flex;align-items:center;gap:7px;min-width:0}
    .opacity-content .range-setting>input[type="range"]{flex:1;width:auto;min-width:65px}
    .opacity-content .range-setting .visibility-toggle{display:flex;align-items:center;gap:5px;white-space:nowrap;font-weight:400;min-width:76px}
    .opacity-content .visibility-toggle input{margin:0;accent-color:#8ab4f8}

    .settings-group:last-child{border-right:0;padding-right:0}.map-style-settings{flex:0 0 100%;width:100%;border-right:0}.offline-map-status{max-width:340px;overflow-wrap:anywhere;color:var(--color-content-default-medium,#aaa);font-size:11px}.settings-group>label{display:flex;align-items:center;gap:6px;white-space:nowrap}
    .location-settings{flex:0 0 100%;width:100%;border-right:0;border-bottom:1px solid var(--color-content-default-low,#454545);padding:0 0 7px;gap:8px}.location-settings>summary{cursor:pointer;font-weight:700;white-space:nowrap}.location-settings[open]>summary{margin-bottom:2px}.location-settings-content{display:flex;flex:1 1 100%;flex-wrap:wrap;align-items:center;gap:8px 16px;min-width:0}.location-coordinate-display{display:flex;flex:1 1 100%;align-items:baseline;gap:8px;min-width:0}.location-coordinate-display span{min-width:0;overflow-wrap:anywhere}.location-settings .address-settings{flex:1 1 100%;width:100%;padding:0;border:0}.location-actions{display:flex;align-items:center;flex-wrap:wrap;gap:6px;flex:1 1 100%}.location-actions>label{display:flex;align-items:center;gap:6px;white-space:nowrap}
    select{max-width:170px}.range-setting{min-width:150px}.range-setting input{width:100px;accent-color:#8ab4f8}.range-setting span{color:var(--color-content-default-medium,#aaa);min-width:34px;text-align:right}
    .settings-row-title{flex:0 0 auto;white-space:nowrap}.location-address{min-width:0;overflow-wrap:anywhere}.location-address-error{color:#ff8a80}
    .zoom-settings{flex:1;min-width:260px}
    .marker-appearance-settings{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:8px;padding-top:0;border-top:0;flex:0 0 100%;width:100%}
    .marker-appearance-settings>label{display:flex;align-items:center;gap:6px;white-space:nowrap}
    .location-settings .marker-current-appearance-settings{display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:1 1 100%;min-width:0}.location-settings .marker-current-appearance-settings>label{display:flex;align-items:center;gap:6px;white-space:nowrap}
    .always-on-top-setting input{accent-color:#8ab4f8}
    .zoom-buttons{display:flex;gap:4px}.zoom-buttons button{width:28px;height:27px;padding:0;font-size:18px}
    .marker-settings{flex:0 0 100%;width:100%;border-right:0;border-top:1px solid var(--color-content-default-low,#454545);border-bottom:0;padding:7px 0 0;gap:8px}
    .marker-settings summary{cursor:pointer;font-weight:700;font-size:13px;line-height:1.4;white-space:nowrap}
    .location-settings>summary,.map-source-settings>summary,.opacity-settings>summary,.gpx-settings>summary{font-size:13px;font-weight:700;line-height:1.4}
    .marker-settings summary .marker-description{margin-left:8px;color:var(--color-content-default-medium,#aaa);font-size:12px;font-weight:400}
    .marker-settings-content{display:flex;flex:1 1 100%;flex-wrap:wrap;align-items:center;gap:8px 16px;min-width:0}
    .marker-progress-text,.marker-statistics,.marker-status{color:var(--color-content-default-medium,#aaa);font-size:12px;font-variant-numeric:tabular-nums}
    .marker-progress-row{display:flex;flex:1 1 100%;align-items:center;gap:10px;min-width:0}
    .marker-progress{flex:1 1 auto;width:auto;height:6px;accent-color:#8ab4f8}.marker-statistics{display:flex;flex-wrap:wrap;gap:14px}
    .location-address{min-width:0;overflow-wrap:anywhere;color:var(--color-content-default-medium,#aaa)}
    .gpx-settings{flex:0 0 100%;width:100%;border-right:0;border-top:1px solid var(--color-content-default-low,#454545);border-bottom:0;padding:7px 0 0;gap:8px}
    .gpx-filename{max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--color-content-default-medium,#aaa)}.gpx-error{color:#ff8a80}
    .color-picker{position:relative}.color-picker-trigger{display:flex;align-items:center;gap:7px;min-width:132px}.color-picker-chevron{margin-left:auto}
    .color-picker-menu{position:absolute;z-index:1000;top:calc(100% + 4px);left:0;min-width:185px;padding:4px;background:var(--color-surface-default-high,#383a3f);border:1px solid var(--color-content-default-low,#555);border-radius:5px;box-shadow:0 5px 18px #0005}
    .color-option{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:0;background:transparent}.color-option[aria-selected=true]{outline:1px solid #8ab4f8}
    .color-swatch{display:inline-flex;align-items:center;justify-content:center;min-width:78px;padding:3px 6px;border-radius:3px;font:11px/1.3 ui-monospace,monospace;font-weight:600}
    .color-swatch-off{background:var(--color-surface-default-medium,#555);color:var(--color-content-default-high,#fff)}
    .map{position:relative;z-index:auto;overflow:visible;flex:1 1 auto;width:100%;min-height:0;background:transparent}
    .map-hidden{display:none!important}
    .map-unavailable{flex:1;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;color:var(--color-content-default-medium,#aaa);font-size:14px}
    .zoom-control{display:flex;align-items:center;gap:8px;flex:1;min-width:210px}.zoom-buttons{display:flex;gap:4px;flex:0 0 auto}
    .zoom-label{flex:0 0 auto;white-space:nowrap}
    .zoom-control input{flex:1;min-width:70px;accent-color:#8ab4f8}
    .zoom-step{width:28px;height:27px;padding:0;font-size:18px}
    .zoom-value{min-width:22px;text-align:right;font-variant-numeric:tabular-nums}
    .map-toolbar-button{width:auto;min-width:92px;height:30px;padding:4px 12px;font-size:13px;white-space:nowrap}.location-actions>.map-toolbar-button:first-child{min-width:158px}
    .opacity-settings{order:2;width:100%;flex:0 0 100%;border-right:0;border-top:1px solid var(--color-content-default-low,#454545);padding:7px 0 0;gap:12px}
    .opacity-settings .settings-row-title{flex:0 0 auto}
    .opacity-settings .range-setting{display:flex;align-items:center;gap:7px;flex:1;min-width:150px}
    .opacity-settings .range-setting input{flex:1;width:auto;min-width:55px}
    .opacity-settings .range-value{flex:0 0 38px;min-width:38px;text-align:right;color:var(--color-content-default-medium,#aaa);font-variant-numeric:tabular-nums}
    .opacity-divider{align-self:stretch;width:1px;min-height:24px;background:var(--color-content-default-low,#555);margin:0 3px}
    :host ::ng-deep .leaflet-marker-pane{z-index:400!important}
    :host ::ng-deep .leaflet-tooltip-pane{z-index:1200}
    :host ::ng-deep .folder-marker-tooltip{background:var(--color-surface-default-high,#303238);border:1px solid #777;border-radius:6px;color:var(--color-content-default-high,#fff);box-shadow:0 3px 12px #0008;padding:5px 7px}
    :host ::ng-deep .leaflet-marker-icon.lumascope-marker-cluster{opacity:var(--marker-opacity,1)!important;transition:opacity .12s ease}
    :host ::ng-deep .folder-marker-tooltip .leaflet-tooltip-content{margin:0}
    :host ::ng-deep .folder-marker-preview{display:flex;flex-direction:column;gap:4px;max-width:190px}
    :host ::ng-deep .folder-marker-preview img{display:block;width:180px;height:120px;object-fit:cover;border-radius:3px;background:#222}
    :host ::ng-deep .folder-marker-preview span{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}
    :host ::ng-deep .maplibregl-popup.folder-marker-tooltip .maplibregl-popup-content{padding:5px 7px;background:var(--color-surface-default-high,#303238);border:1px solid #777;border-radius:6px;color:var(--color-content-default-high,#fff);box-shadow:0 3px 12px #0008}
    :host ::ng-deep .maplibregl-popup.folder-marker-tooltip .maplibregl-popup-tip{border-top-color:var(--color-surface-default-high,#303238)}
    :host ::ng-deep .leaflet-control-attribution{opacity:.28;transition:opacity .18s ease}
    :host ::ng-deep .leaflet-control-attribution:hover{opacity:1}
    :host-context(html[data-theme='light']) .map-titlebar{background:#f1f2f4;border-color:#d0d3d8}
    :host-context(html[data-theme='light']) .map-settings{background:#f7f7f8;border-color:#d0d3d8}
    :host-context(html[data-theme='light']) button,:host-context(html[data-theme='light']) select{color:#202124;background:#fff;border-color:#c5c8ce}
    :host-context(html[data-theme='light']) button:hover,:host-context(html[data-theme='light']) .settings-toggle.active{background:#e4eaf3;border-color:#477fc4}
    :host-context(html[data-theme='light']) .map-coordinates,:host-context(html[data-theme='light']) .range-setting span,:host-context(html[data-theme='light']) .gpx-filename{color:#555}
    :host-context(html[data-theme='light']) .map-toolbar-button{color:#202124;background:#fff;border-color:#c5c8ce}
    @media(max-width:650px){.map-coordinates{display:none}.map-settings{align-items:flex-start}.settings-group{width:100%;border-right:0;border-bottom:1px solid var(--color-content-default-low,#454545);padding:0 0 7px}.settings-group:last-child{border-bottom:0}.range-setting{flex:1}.range-setting input{flex:1}.opacity-content{grid-template-columns:minmax(0,1fr)}}
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class MapWindow implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  protected readonly overlayMode = this.route.snapshot.queryParamMap.get('overlay') === '1';
  private overlayResizeStart: { edge: string; pointerX: number; pointerY: number; bounds: { x: number; y: number; width: number; height: number } } | null = null;
  protected readonly themeService = inject(ThemeService);
  private readonly mapElement = viewChild.required<ElementRef<HTMLElement>>('map');
  private map: MapInstance | null = null;
  private offlineRenderer: OfflineMapRenderer | null = null;
  private currentLatitude: number | null = null;
  private currentLongitude: number | null = null;
  private marker: MapMarker | null = null;
  private directoryMarkerGroup: MapMarkerGroup | null = null;
  private readonly directoryMarkers: MapMarker[] = [];
  private currentImagePath: string | null = null;
  private markerScanGeneration = 0;
  private leaflet: LeafletMapApi | null = null;
  private readonly desktop = (window as unknown as { desktop?: Desktop }).desktop;
  private unsubscribeLocation: (() => void) | null = null;
  private locationUpdateVersion = 0;
  private locationLookupVersion = 0;
  private mapInitialization: Promise<void> | null = null;
  private mapSourceGeneration = 0;
  private tileLayer: { remove(): void } | null = null;
  private trackLayers: Array<{ remove(): void }> = [];
  private gpxSegments: [number, number][][] = [];
  private readonly storagePrefix = 'light-matter.mapWindow.';
  protected readonly settingsOpen = signal(false);
  protected readonly colorMenuOpen = signal(false);
  protected readonly alwaysOnTop = signal(this.readSetting('alwaysOnTop', 'false') === 'true');
  protected readonly mapStyle = signal<MapStyle>(this.readSetting('style', 'standard') as MapStyle);
  protected readonly mapSource = signal<'online' | 'offline'>(this.readSetting('source', 'online') === 'offline' ? 'offline' : 'online');
  protected readonly offlineMapStyle = signal<OfflineMapStyle>(this.readSetting('offlineStyle', 'lumascope') as OfflineMapStyle);
  protected readonly offlineMapStatus = signal<import('internal-api').OfflineMapStatus | null>(null);
  protected readonly offlineMapStatusText = computed(() => {
    const status = this.offlineMapStatus();
    if (!status) return 'Checking offline map…';
    if (status.error) return status.error;
    return status.available ? (status.name ?? 'Offline map ready') + ' · zoom ' + status.minZoom + '–' + status.maxZoom : 'No MBTiles selected';
  });
  protected readonly mapColor = signal<MapColor>(this.readSetting('color', 'original') as MapColor);
  protected readonly mapOpacity = signal(this.readNumber('opacity', 100, 0, 100));
  protected readonly mapVisible = signal(this.readSetting('mapVisible', 'true') === 'true');
  protected readonly zoomLevel = signal(this.readNumber('zoom', 13, 1, 20));
  protected readonly gpxColor = signal(this.readSetting('gpxColor', '#ff3b30'));
  protected readonly gpxOpacity = signal(this.readNumber('gpxOpacity', 100, 0, 100));
  protected readonly markerOpacity = signal(this.readNumber('markerOpacity', 100, 0, 100));
  protected readonly markersVisible = signal(this.readSetting('markersVisible', 'true') === 'true');
  protected readonly locationOpacity = signal(this.readNumber('locationOpacity', 100, 0, 100));
  protected readonly locationVisible = signal(this.readSetting('locationVisible', 'true') === 'true');
  protected readonly markerShape = signal<MarkerShape>(this.readSetting('markerShape', 'double-circle') as MarkerShape);
  protected readonly currentMarkerShape = signal<CurrentMarkerShape>(this.readSetting('currentMarkerShape', 'pin') as CurrentMarkerShape);
  protected readonly currentMarkerColor = signal(this.readSetting('currentMarkerColor', '#ff3b30'));
  protected readonly markerColor = signal(this.readSetting('markerColor', 'dynamic'));
  protected readonly markerColorVisible = signal(this.readSetting('markerColorVisible', 'true') === 'true');
  protected readonly markerColorMenuOpen = signal(false);
  protected readonly currentMarkerColorMenuOpen = signal(false);
  protected readonly gpxVisible = signal(this.readSetting('gpxVisible', 'true') === 'true');
  protected readonly gpxFileName = signal(this.readSetting('gpxFileName', ''));
  protected readonly gpxError = signal('');
  protected readonly markerSectionOpen = signal(this.readSetting('markerSectionOpen', 'false') === 'true');
  protected readonly directoryMarkersEnabled = signal(false);
  protected readonly markerFilesChecked = signal(0);
  protected readonly markerFilesTotal = signal(0);
  protected readonly markerCount = signal(0);
  protected readonly markerStatus = signal('');
  protected readonly coordinateLabel = signal('GPS coordinates unavailable');
  protected readonly coordinatesAvailable = signal(false);
  protected readonly locationAddress = signal('');
  protected readonly bearing = signal<number | null>(null);
  protected readonly bearingLabel = computed(() => this.bearing() === null ? '' : String(Math.round(this.bearing()!)) + '° ' + this.compassDirection(this.bearing()!));
  protected readonly gpxColors = [
    { name: 'Red', value: '#ff3b30', textColor: '#ffffff' }, { name: 'Orange', value: '#ff9500', textColor: '#171717' },
    { name: 'Yellow', value: '#ffd60a', textColor: '#171717' }, { name: 'Green', value: '#34c759', textColor: '#102014' },
    { name: 'Blue', value: '#0a84ff', textColor: '#ffffff' }, { name: 'Magenta', value: '#bf5af2', textColor: '#ffffff' }
  ] as const;

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const target = event.target;
    if (target instanceof Element && target.closest('.color-picker')) return;
    this.colorMenuOpen.set(false);
    this.markerColorMenuOpen.set(false);
    this.currentMarkerColorMenuOpen.set(false);
  }

  @HostListener('document:pointermove', ['$event'])
  onOverlayResizeMove(event: PointerEvent): void {
    const start = this.overlayResizeStart;
    if (!this.overlayMode || !start) return;
    const dx = event.screenX - start.pointerX, dy = event.screenY - start.pointerY;
    let { x, y, width, height } = start.bounds;
    if (start.edge.includes('e')) width += dx;
    if (start.edge.includes('s')) height += dy;
    if (start.edge.includes('w')) { x += dx; width -= dx; }
    if (start.edge.includes('n')) { y += dy; height -= dy; }
    if (width < 420) { if (start.edge.includes('w')) x -= 420 - width; width = 420; }
    if (height < 320) { if (start.edge.includes('n')) y -= 320 - height; height = 320; }
    void this.desktop?.MapOverlayWindow.setBounds({ x, y, width, height });
  }

  @HostListener('document:pointerup')
  onOverlayResizeEnd(): void { this.overlayResizeStart = null; }

  protected readonly startOverlayResize = async (event: PointerEvent, edge: string): Promise<void> => {
    if (!this.overlayMode) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = await this.desktop?.MapOverlayWindow.getBounds();
    if (!bounds) return;
    this.overlayResizeStart = { edge, pointerX: event.screenX, pointerY: event.screenY, bounds };
  };

  protected readonly closeOverlayWindow = (): void => { void this.desktop?.MapOverlayWindow.close(); };

  @HostListener('window:keyup', ['$event'])
  onDocumentKeyup(event: KeyboardEvent): void {
    // The location window is a separate Electron window, so the main image-view
    // keyboard listener cannot receive shortcuts while this window has focus.
    if (event.key.toLowerCase() === 's'
      && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      void this.desktop?.CapturePreviewWindow.open();
    }
  }

  ngOnInit(): void {
    document.documentElement.style.backgroundColor = 'transparent';
    document.body.style.backgroundColor = 'transparent';
    document.documentElement.style.colorScheme = this.themeService.current();
    this.applyAlwaysOnTop();
    this.currentImagePath = this.route.snapshot.queryParamMap.get('imagePath');
    void this.desktop?.OfflineMap.getStatus().then(status => this.offlineMapStatus.set(status)).catch(error => console.error('Could not read offline map status:', error));
    const bearingParameter = this.route.snapshot.queryParamMap.get('bearing');
    const initialBearing = bearingParameter === null ? NaN : Number(bearingParameter);
    this.bearing.set(Number.isFinite(initialBearing) && initialBearing >= 0 && initialBearing < 360 ? initialBearing : null);
    const latitudeParameter = this.route.snapshot.queryParamMap.get('lat');
    const longitudeParameter = this.route.snapshot.queryParamMap.get('lon');
    const latitude = latitudeParameter === null ? NaN : Number(latitudeParameter);
    const longitude = longitudeParameter === null ? NaN : Number(longitudeParameter);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)
      && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180) {
      this.coordinatesAvailable.set(true);
      this.currentLatitude = latitude; this.currentLongitude = longitude;
      this.coordinateLabel.set(this.formatCoordinates(latitude, longitude));
      void this.lookupLocationAddress(latitude, longitude);
      void this.initialize(latitude, longitude);
    } else {
      this.locationAddress.set('This image does not contain GPS coordinates.');
    }
    const applyLocation = (location: { latitude: number | null; longitude: number | null; bearing?: number | null; imagePath?: string | null }): void => {
      const previousImagePath = this.currentImagePath;
      this.currentLatitude = location.latitude; this.currentLongitude = location.longitude;
      this.currentImagePath = location.imagePath ?? null;
      if (this.directoryMarkersEnabled() && previousImagePath?.toLowerCase() !== this.currentImagePath?.toLowerCase()) void this.scanDirectoryMarkers();
      const nextLatitude = location.latitude;
      const nextLongitude = location.longitude;
      if (!Number.isFinite(nextLatitude) || !Number.isFinite(nextLongitude)
        || nextLatitude! < -90 || nextLatitude! > 90 || nextLongitude! < -180 || nextLongitude! > 180) {
        this.locationLookupVersion++;
        this.mapSourceGeneration++;
        this.mapInitialization = null;
        this.coordinatesAvailable.set(false);
        this.coordinateLabel.set('GPS coordinates unavailable');
        this.locationAddress.set('This image does not contain GPS coordinates.');
        this.map?.remove();
        this.map = null;
        this.offlineRenderer?.remove(); this.offlineRenderer = null;
        this.marker = null;
        this.clearDirectoryMarkers();
        return;
      }
      this.coordinatesAvailable.set(true);
      this.coordinateLabel.set(this.formatCoordinates(nextLatitude!, nextLongitude!));
      void this.lookupLocationAddress(nextLatitude!, nextLongitude!);
      this.bearing.set(typeof location.bearing === 'number' && Number.isFinite(location.bearing) ? location.bearing : null);
      if (this.offlineRenderer) {
        this.offlineRenderer.updateCurrentLocation(nextLatitude!, nextLongitude!);
        this.offlineRenderer.map.easeTo({ center: [nextLongitude!, nextLatitude!] });
      } else if (!this.map) {
        void this.initialize(nextLatitude!, nextLongitude!);
      } else {
        this.marker?.setLatLng([nextLatitude!, nextLongitude!]);
        this.map.setView([nextLatitude!, nextLongitude!], this.map.getZoom());
      }
    };
    this.unsubscribeLocation = this.desktop?.MapWindow.onLocationChanged(location => {
      this.locationUpdateVersion++;
      applyLocation(location);
    }) ?? null;

    // The initial open event can arrive before this window subscribes. Read the
    // main-process snapshot after registering the listener to close that race.
    const initialLocationVersion = this.locationUpdateVersion;
    void this.desktop?.MapWindow.getLocation().then(location => {
      if (this.locationUpdateVersion === initialLocationVersion) applyLocation(location);
    }).catch(error => console.error('Could not retrieve initial map location:', error));
  }

  ngOnDestroy(): void {
    this.mapSourceGeneration++;
    this.mapInitialization = null;
    this.unsubscribeLocation?.();
    this.markerScanGeneration++;
    this.clearDirectoryMarkers();
    window.removeEventListener('resize', this.onResize);
    this.map?.remove();
    this.map = null;
    this.offlineRenderer?.remove(); this.offlineRenderer = null;
  }

  private readonly onResize = (): void => { this.map?.invalidateSize(); this.offlineRenderer?.resize(); };

  protected readonly copyCoordinates = async (): Promise<void> => {
    const marker = this.marker?.getLatLng();
    const latitude = marker?.lat ?? this.currentLatitude, longitude = marker?.lng ?? this.currentLongitude;
    if (latitude === null || longitude === null) return;
    try { await navigator.clipboard.writeText(latitude.toFixed(6) + ', ' + longitude.toFixed(6)); }
    catch (error) { console.error('Failed to copy GPS coordinates', error); }
  };
  protected readonly centerMarker = (): void => {
    const marker = this.marker?.getLatLng();
    const latitude = marker?.lat ?? this.currentLatitude, longitude = marker?.lng ?? this.currentLongitude;
    if (latitude !== null && longitude !== null) {
      if (this.offlineRenderer) {
        // Reassert the fixed geographic coordinate before centering. This also
        // recreates the DOM marker if a prior style/shape update detached it.
        this.offlineRenderer.setCurrentLocation(
          latitude, longitude, this.currentMarkerColor(),
          (this.locationVisible() ? this.locationOpacity() / 100 : 0), this.currentMarkerShape()
        );
        this.offlineRenderer.map.jumpTo({ center: [longitude, latitude] });
      } else if (this.map) this.map.setView([latitude, longitude], this.map.getZoom());
    }
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
    const dms = `${this.formatCoordinateDms(latitude, true)}, ${this.formatCoordinateDms(longitude, false)}`;
    const latHemisphere = latitude < 0 ? 'S' : 'N';
    const lonHemisphere = longitude < 0 ? 'W' : 'E';
    const decimal = `${Math.abs(latitude).toFixed(5)}° ${latHemisphere}, ${Math.abs(longitude).toFixed(5)}° ${lonHemisphere}`;
    return `Coordinates: ${dms}  |  Decimal: ${decimal}`;
  }

  private async lookupLocationAddress(latitude: number, longitude: number): Promise<void> {
    const lookupVersion = ++this.locationLookupVersion;
    const imagePath = this.currentImagePath;
    this.locationAddress.set('Looking up address…');
    try {
      let displayName: string | null = null;
      if (imagePath && this.desktop) {
        displayName = await this.desktop.CacheManager.resolvePhotoLocation(imagePath, latitude, longitude);
      } else {
        const result = await lookupReverseGeocoding(latitude, longitude, navigator.language || 'en');
        displayName = result?.displayName ?? null;
      }
      if (lookupVersion !== this.locationLookupVersion) return;
      this.locationAddress.set(displayName || 'No street address available for this location.');
    } catch (error) {
      if (lookupVersion !== this.locationLookupVersion) return;
      console.error('Could not resolve and save the photo location:', error);
      this.locationAddress.set(`Reverse geocoding failed: ${error instanceof Error ? error.message : String(error)}`);
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
  protected readonly toggleSettings = (): void => {
    this.settingsOpen.update(open => !open);

    // Let Angular update the settings section and flex layout before Leaflet measures the map.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.map?.invalidateSize();
        this.offlineRenderer?.resize();
      });
    });
  };
  protected readonly toggleColorMenu = (): void => {
    const open = !this.colorMenuOpen();
    this.markerColorMenuOpen.set(false);
    this.colorMenuOpen.set(open);
  };
  protected readonly selectedGpxColorName = (): string => this.gpxColors.find(color => color.value === this.gpxColor())?.name ?? 'Red';
  protected readonly toggleMarkerColorMenu = (): void => {
    const open = !this.markerColorMenuOpen();
    this.colorMenuOpen.set(false);
    this.currentMarkerColorMenuOpen.set(false);
    this.markerColorMenuOpen.set(open);
  };
  protected readonly toggleCurrentMarkerColorMenu = (): void => {
    const open = !this.currentMarkerColorMenuOpen();
    this.colorMenuOpen.set(false);
    this.markerColorMenuOpen.set(false);
    this.currentMarkerColorMenuOpen.set(open);
  };
  protected readonly selectedCurrentMarkerColorName = (): string => this.gpxColors.find(color => color.value === this.currentMarkerColor())?.name ?? 'Red';
  protected readonly selectedCurrentMarkerTextColor = (): string => this.gpxColors.find(color => color.value === this.currentMarkerColor())?.textColor ?? '#ffffff';
  protected readonly selectedMarkerColorName = (): string => this.markerColor() === 'dynamic' ? 'Dynamic' : this.gpxColors.find(color => color.value === this.markerColor())?.name ?? 'Green';
  protected readonly selectedMarkerTextColor = (): string => this.gpxColors.find(color => color.value === this.markerColor())?.textColor ?? '#102014';
  protected readonly changeMarkerShape = (value: string): void => {
    if (value !== 'double-circle' && value !== 'hexagon' && value !== 'circle' && value !== 'square') return;
    this.markerShape.set(value); this.saveSetting('markerShape', value); this.directoryMarkerGroup?.refreshClusters?.();
  };
  protected readonly changeCurrentMarkerShape = (value: string): void => {
    if (value !== 'pin' && value !== 'circle' && value !== 'square' && value !== 'diamond') return;
    this.currentMarkerShape.set(value); this.saveSetting('currentMarkerShape', value);
    this.marker?.setIcon(this.createCurrentLocationIcon());
    if (this.offlineRenderer && this.currentLatitude !== null && this.currentLongitude !== null) this.offlineRenderer.setCurrentLocation(this.currentLatitude, this.currentLongitude, this.currentMarkerColor(), (this.locationVisible() ? this.locationOpacity() / 100 : 0), this.currentMarkerShape());
  };
  protected readonly changeCurrentMarkerColor = (value: string): void => {
    if (!this.gpxColors.some(color => color.value === value)) return;
    this.currentMarkerColor.set(value); this.saveSetting('currentMarkerColor', value);
    this.currentMarkerColorMenuOpen.set(false);
    this.marker?.setIcon(this.createCurrentLocationIcon());
    if (this.offlineRenderer && this.currentLatitude !== null && this.currentLongitude !== null) this.offlineRenderer.setCurrentLocation(this.currentLatitude, this.currentLongitude, this.currentMarkerColor(), (this.locationVisible() ? this.locationOpacity() / 100 : 0), this.currentMarkerShape());
  };
  protected readonly changeMarkerColor = (value: string): void => {
    if (value === 'off') { this.markerColorVisible.set(false); this.saveSetting('markerColorVisible', false); }
    else if (value === 'dynamic') {
      this.markerColor.set(value); this.markerColorVisible.set(true);
      this.saveSetting('markerColor', value); this.saveSetting('markerColorVisible', true);
    } else if (this.gpxColors.some(color => color.value === value)) {
      this.markerColor.set(value); this.markerColorVisible.set(true);
      this.saveSetting('markerColor', value); this.saveSetting('markerColorVisible', true);
    } else return;
    this.markerColorMenuOpen.set(false); this.directoryMarkerGroup?.refreshClusters?.();
    this.offlineRenderer?.setPhotoClusterStyle(this.markerColor(), this.markerColorVisible());
  };
  protected readonly selectedGpxTextColor = (): string => this.gpxColors.find(color => color.value === this.gpxColor())?.textColor ?? '#ffffff';
  protected readonly changeAlwaysOnTop = (enabled: boolean): void => {
    this.alwaysOnTop.set(enabled);
    this.saveSetting('alwaysOnTop', enabled);
    this.applyAlwaysOnTop();
  };
  private applyAlwaysOnTop(): void {
    if (this.overlayMode) void this.desktop?.MapOverlayWindow.setAlwaysOnTop(this.alwaysOnTop());
    else void this.desktop?.MapWindow.setAlwaysOnTop(this.alwaysOnTop());
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

  protected readonly onMarkerSectionToggle = (event: Event): void => {
    const section = event.currentTarget;
    if (!(section instanceof HTMLDetailsElement)) return;
    this.markerSectionOpen.set(section.open);
    this.saveSetting('markerSectionOpen', section.open);
    if (section.open) {
      this.directoryMarkersEnabled.set(true);
      void this.scanDirectoryMarkers();
    }
  };
  private clearDirectoryMarkers(): void {
    this.directoryMarkerGroup?.clearLayers();
    this.directoryMarkers.length = 0;
    this.offlineRenderer?.setPhotoMarkers([], path => { void this.desktop?.MapWindow.selectImage(path); }, (this.markersVisible() ? this.markerOpacity() / 100 : 0));
    this.markerCount.set(0);
  }
  private createImageMarkerIcon(selected: boolean): unknown {
    if (selected) return this.createCurrentLocationIcon();
    const size = 13, color = '#2688e8';
    return this.leaflet!.divIcon({ className: 'folder-image-marker', html: `<span style=\"display:block;width:${size}px;height:${size}px;border:2px solid #fff;border-radius:50%;background:${color};box-shadow:0 1px 5px #0009\"></span>`, iconSize: [size + 4, size + 4], iconAnchor: [(size + 4) / 2, (size + 4) / 2] });
  }
  private createCurrentLocationIcon(): unknown {
    const color = this.currentMarkerColor();
    const shape = this.currentMarkerShape();
    let svg: string, size: [number, number], anchor: [number, number];
    if (shape === 'pin') {
      svg = `<path d=\"M24 2C12.4 2 4 10.5 4 21c0 14 20 35 20 35s20-21 20-35C44 10.5 35.6 2 24 2Z\" fill=\"${color}\" stroke=\"#fff\" stroke-width=\"3\"/><circle cx=\"24\" cy=\"21\" r=\"7.5\" fill=\"#fff\" stroke=\"#222\" stroke-width=\"1.5\"/>`;
      size = [36, 42]; anchor = [18, 42];
    } else {
      const shapeMarkup = shape === 'circle'
        ? '<circle cx="20" cy="20" r="16"'
        : shape === 'square'
          ? '<rect x="4" y="4" width="32" height="32" rx="3"'
          : '<polygon points="20,2 38,20 20,38 2,20"';
      svg = `${shapeMarkup} fill=\"${color}\" stroke=\"#fff\" stroke-width=\"3\"/><circle cx=\"20\" cy=\"20\" r=\"6\" fill=\"#fff\" stroke=\"#222\" stroke-width=\"1.5\"/>`;
      size = [36, 36]; anchor = [18, 18];
    }
    const html = `<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"${size[0]}\" height=\"${size[1]}\" viewBox=\"${shape === 'pin' ? '0 0 48 58' : '0 0 40 40'}\" style=\"display:block;filter:drop-shadow(0 1px 3px #000b)\">${svg}</svg>`;
    return this.leaflet!.divIcon({ className: 'current-location-marker', html, iconSize: size, iconAnchor: anchor });
  }
  private escapeMarkerHtml(value: string): string {
    return value.replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character] ?? character);
  }

  private renderDirectoryMarkers(
    markers: Array<{ path: string; fileName: string; latitude: number; longitude: number }>,
    imagePath: string
  ): void {
    this.clearDirectoryMarkers();
    for (const item of markers) {
      if (item.path.toLowerCase() === imagePath.toLowerCase()) continue;
      const marker = this.leaflet!.marker([item.latitude, item.longitude], {
        icon: this.createImageMarkerIcon(false)
      }).setOpacity((this.markersVisible() ? this.markerOpacity() / 100 : 0));
      marker.bindTooltip(buildPhotoMarkerPreviewHtml(item.path, item.fileName), {
        direction: 'top', className: 'folder-marker-tooltip', opacity: 1
      });
      marker.on('click', () => { void this.desktop?.MapWindow.selectImage(item.path); });
      this.directoryMarkers.push(marker);
      this.directoryMarkerGroup?.addLayer(marker);
      this.markerCount.update(value => value + 1);
    }
  }

  private async scanDirectoryMarkers(): Promise<void> {
    const generation = ++this.markerScanGeneration, imagePath = this.currentImagePath, desktop = this.desktop;
    if (!imagePath || !desktop || (!this.directoryMarkerGroup && !this.offlineRenderer)) {
      this.clearDirectoryMarkers();
      this.markerStatus.set('No image folder is available.');
      return;
    }
    this.clearDirectoryMarkers();
    this.markerStatus.set('Reading location database…');
    try {
      const directory = await desktop.FileSystem.dirname(imagePath);
      if (generation !== this.markerScanGeneration || !this.directoryMarkersEnabled()) return;
      const records = await desktop.CacheManager.getDirectoryPhotoLocations(directory);
      if (generation !== this.markerScanGeneration || !this.directoryMarkersEnabled()) return;
      const markers = records
        .filter(record => record.latitude !== null && record.longitude !== null
          && Number.isFinite(record.latitude) && Number.isFinite(record.longitude)
          && Math.abs(record.latitude) <= 90 && Math.abs(record.longitude) <= 180)
        .map(record => ({
          path: record.path,
          fileName: record.fileName,
          latitude: record.latitude!,
          longitude: record.longitude!
        }));

      this.markerFilesTotal.set(records.length);
      this.markerFilesChecked.set(records.length);
      if (this.offlineRenderer) {
        const offlineMarkers: OfflinePhotoMarker[] = markers.filter(item => item.path.toLowerCase() !== imagePath.toLowerCase()).map(item => ({ ...item }));
        this.markerCount.set(offlineMarkers.length);
        this.offlineRenderer.setPhotoMarkers(offlineMarkers, path => { void this.desktop?.MapWindow.selectImage(path); }, (this.markersVisible() ? this.markerOpacity() / 100 : 0));
        this.offlineRenderer.setPhotoClusterStyle(this.markerColor(), this.markerColorVisible());
      } else this.renderDirectoryMarkers(markers, imagePath);
      this.markerStatus.set('Loaded ' + records.length + ' database records; ' + markers.length + ' GPS locations found.');
    } catch (error) {
      if (generation === this.markerScanGeneration) this.markerStatus.set(error instanceof Error ? error.message : 'Location database query failed.');
    }
  }
  private async initialize(latitude: number, longitude: number): Promise<void> {
    const generation = this.mapSourceGeneration;
    if (this.mapSource() === 'offline') {
      if (this.offlineRenderer) { this.offlineRenderer.updateCurrentLocation(latitude, longitude); return; }
      if (this.mapInitialization) await this.mapInitialization;
      if (generation !== this.mapSourceGeneration || this.mapSource() !== 'offline') return;
      if (this.offlineRenderer || this.map) return;
      const initialization = this.createOfflineMap(latitude, longitude, generation);
      this.mapInitialization = initialization;
      try { await initialization; } finally { if (this.mapInitialization === initialization) this.mapInitialization = null; }
      return;
    }
    // The initial route parameters and the main-process location snapshot can
    // arrive almost simultaneously. Serialize initialization so Leaflet never
    // creates two maps on the same container while its library is still loading.
    if (this.map) {
      this.marker?.setLatLng([latitude, longitude]);
      this.map.setView([latitude, longitude], this.map.getZoom());
      return;
    }
    if (this.mapInitialization) {
      await this.mapInitialization;
      if (generation !== this.mapSourceGeneration || this.mapSource() !== 'online') return;
      // TypeScript cannot see that createMap() assigns this.map across the await.
      const map = this.map as MapInstance | null;
      if (map) {
        this.marker?.setLatLng([latitude, longitude]);
        map.setView([latitude, longitude], map.getZoom());
      }
      return;
    }

    const initialization = this.createMap(latitude, longitude, generation);
    this.mapInitialization = initialization;
    try {
      await initialization;
    } finally {
      if (this.mapInitialization === initialization) this.mapInitialization = null;
    }
  }

  private async createOfflineMap(latitude: number, longitude: number, generation: number): Promise<void> {
    const status = await this.desktop?.OfflineMap.getStatus();
    if (generation !== this.mapSourceGeneration || this.mapSource() !== 'offline') return;
    this.offlineMapStatus.set(status ?? null);
    if (!status?.available) {
      this.locationAddress.set(status?.error ?? 'Select a valid Austria MBTiles file in Map settings.');
      this.mapSource.set('online'); this.saveSetting('source', 'online');
      await this.createMap(latitude, longitude, generation);
      return;
    }
    const renderer = new OfflineMapRenderer(
      this.mapElement().nativeElement,
      [longitude, latitude],
      this.validZoom(this.zoomLevel()),
      message => {
        if (generation !== this.mapSourceGeneration) return;
        this.offlineMapStatus.update(current => current ? { ...current, error: message } : current);
        this.locationAddress.set('Offline map rendering error: ' + message);
      },
      this.offlineMapStyle()
    );
    this.offlineRenderer = renderer;
    try {
      await renderer.ready;
    } catch (error) {
      renderer.remove();
      if (this.offlineRenderer === renderer) this.offlineRenderer = null;
      if (generation === this.mapSourceGeneration) {
        const message = error instanceof Error ? error.message : String(error);
        this.offlineMapStatus.set({ ...status, error: message });
        this.locationAddress.set('Offline map could not be initialized: ' + message);
        console.error('[OfflineMap] Initialization failed:', error);
      }
      return;
    }
    if (generation !== this.mapSourceGeneration || this.mapSource() !== 'offline') {
      renderer.remove();
      if (this.offlineRenderer === renderer) this.offlineRenderer = null;
      return;
    }
    const latestLatitude = this.currentLatitude ?? latitude;
    const latestLongitude = this.currentLongitude ?? longitude;
    renderer.setCurrentLocation(latestLatitude, latestLongitude, this.currentMarkerColor(), (this.locationVisible() ? this.locationOpacity() / 100 : 0), this.currentMarkerShape());
    renderer.map.jumpTo({ center: [latestLongitude, latestLatitude] });
    this.applyMapColor(); this.applyMapOpacity();
    const syncOfflineZoom = (): void => {
      const zoom = Math.round(this.validZoom(renderer.map.getZoom()));
      if (zoom !== this.zoomLevel()) {
        this.zoomLevel.set(zoom);
        this.saveSetting('zoom', zoom);
      }
    };
    renderer.map.on('zoom', syncOfflineZoom);
    renderer.map.on('zoomend', syncOfflineZoom);
    syncOfflineZoom();
    if (this.directoryMarkersEnabled()) void this.scanDirectoryMarkers();
    await this.restoreGpxTrack();
    window.addEventListener('resize', this.onResize);
  }

  private async createMap(latitude: number, longitude: number, generation: number): Promise<void> {
    this.offlineRenderer?.remove(); this.offlineRenderer = null;
    const leaflet = await this.loadLeaflet();
    if (generation !== this.mapSourceGeneration || this.mapSource() !== 'online') return;
    this.leaflet = leaflet;
    const center: [number, number] = [latitude, longitude];
    this.map = this.leaflet.map(this.mapElement().nativeElement, { zoomControl: false, keyboard: false, minZoom: 1, maxZoom: 20 })
      .setView(center, this.validZoom(this.zoomLevel()));
    this.mapElement().nativeElement.style.setProperty('--marker-opacity', String((this.markersVisible() ? this.markerOpacity() / 100 : 0)));
    this.map.on('zoomend', () => {
      const zoom = this.validZoom(this.map?.getZoom() ?? this.zoomLevel());
      this.zoomLevel.set(zoom);
      this.saveSetting('zoom', zoom);
    });
    this.marker = this.leaflet.marker(center, { icon: this.createCurrentLocationIcon() }).addTo(this.map).setOpacity((this.locationVisible() ? this.locationOpacity() / 100 : 0));
    this.directoryMarkerGroup = this.leaflet.markerClusterGroup({
      chunkedLoading: true, showCoverageOnHover: false, spiderfyOnMaxZoom: true,
      iconCreateFunction: cluster => {
        const count = cluster.getChildCount();
        const size = count < 10 ? 40 : count < 100 ? 48 : 56;
        const fontSize = count < 100 ? 15 : 14;
        const shape = this.markerShape();
        const fill = this.markerColorVisible() ? this.markerColor() : 'transparent';
        const dynamicFill = count < 10 ? '#34c759' : count < 100 ? '#ffd60a' : '#ff3b30';
        const markerFill = this.markerColor() === 'dynamic' ? dynamicFill : fill;
        const shapeMarkup = shape === 'double-circle'
          ? `<circle cx="28" cy="28" r="25" fill="${markerFill}" stroke="#fff" stroke-width="2.5"/><circle cx="28" cy="28" r="18" fill="none" stroke="#fff" stroke-width="1.5" opacity=".9"/>`
          : shape === 'hexagon'
            ? `<polygon points="28,2 51,15 51,41 28,54 5,41 5,15" fill="${markerFill}" stroke="#fff" stroke-width="2.5"/>`
            : shape === 'circle'
              ? `<circle cx="28" cy="28" r="25" fill="${markerFill}" stroke="#fff" stroke-width="2.5"/>`
              : `<rect x="3" y="3" width="50" height="50" rx="3" fill="${markerFill}" stroke="#fff" stroke-width="2.5"/>`;
        const html = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 56 56" opacity="${this.markerColorVisible() ? 1 : 0}">${shapeMarkup}<text x="28" y="33" text-anchor="middle" font-family="Segoe UI,Arial,sans-serif" font-size="${fontSize}" font-weight="700" fill="#fff">${count}</text></svg>`;
        return this.leaflet!.divIcon({ className: 'lumascope-marker-cluster', html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
      }
    }).addTo(this.map);
    if (this.directoryMarkersEnabled()) void this.scanDirectoryMarkers();
    this.applyMapStyle();
    this.applyMapColor();
    this.applyMapOpacity();
    await this.restoreGpxTrack();
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

  protected readonly changeMapSource = (value: string): void => {
    if (value !== 'online' && value !== 'offline') return;
    this.mapSourceGeneration++;
    this.mapInitialization = null;
    this.mapSource.set(value); this.saveSetting('source', value);
    if (this.currentLatitude !== null && this.currentLongitude !== null) {
      this.map?.remove(); this.map = null; this.marker = null; this.directoryMarkerGroup = null;
      this.offlineRenderer?.remove(); this.offlineRenderer = null; this.clearDirectoryMarkers();
      void this.initialize(this.currentLatitude, this.currentLongitude);
    }
  };
  protected readonly changeOfflineMapStyle = (value: string): void => {
    if (value !== 'lumascope' && value !== 'versatiles-colorful' && value !== 'versatiles-neutrino') return;
    if (value === this.offlineMapStyle()) return;
    this.offlineMapStyle.set(value);
    this.saveSetting('offlineStyle', value);
    if (this.mapSource() !== 'offline' || this.currentLatitude === null || this.currentLongitude === null) return;
    this.mapSourceGeneration++;
    this.mapInitialization = null;
    this.offlineRenderer?.remove();
    this.offlineRenderer = null;
    void this.initialize(this.currentLatitude, this.currentLongitude);
  };
  protected readonly chooseOfflineMap = async (): Promise<void> => {
    if (!this.desktop) return;
    const status = await this.desktop.OfflineMap.chooseFile(); this.offlineMapStatus.set(status);
    if (status.available) this.changeMapSource('offline');
  };
  protected readonly openMbtilesDownload = async (): Promise<void> => {
    await this.desktop?.ProcessManager.openExternal('https://download.geofabrik.de/europe/austria.html');
  };
  protected readonly changeMapStyle = (value: string): void => {
    if (!(value in this.styles)) return;
    this.mapStyle.set(value as MapStyle); this.saveSetting('style', value); this.applyMapStyle();
  };
  protected readonly changeMapColor = (value: string): void => {
    if (!(value in this.filters)) return;
    this.mapColor.set(value as MapColor); this.saveSetting('color', value); this.applyMapColor();
  };
  protected readonly changeMapVisibility = (visible: boolean): void => {
    this.mapVisible.set(visible); this.saveSetting('mapVisible', visible); this.applyMapOpacity();
  };
  protected readonly changeTrackVisibility = (visible: boolean): void => {
    this.gpxVisible.set(visible); this.saveSetting('gpxVisible', visible); this.applyGpxTrack();
  };
  protected readonly changeMarkersVisibility = (visible: boolean): void => {
    this.markersVisible.set(visible); this.saveSetting('markersVisible', visible);
    const opacity = visible ? this.markerOpacity() / 100 : 0;
    this.mapElement().nativeElement.style.setProperty('--marker-opacity', String(opacity));
    for (const folderMarker of this.directoryMarkers) folderMarker.setOpacity(opacity);
    this.directoryMarkerGroup?.refreshClusters?.();
    this.offlineRenderer?.setPhotoOpacity(opacity);
  };
  protected readonly changeLocationVisibility = (visible: boolean): void => {
    this.locationVisible.set(visible); this.saveSetting('locationVisible', visible);
    const opacity = visible ? this.locationOpacity() / 100 : 0;
    this.marker?.setOpacity(opacity);
    this.offlineRenderer?.setCurrentOpacity(opacity);
  };
  protected readonly changeMapOpacity = (value: string | number): void => {
    const opacity = Number(value); if (!Number.isFinite(opacity)) return;
    const next = Math.max(0, Math.min(100, Math.round(opacity)));
    this.mapOpacity.set(next); this.saveSetting('opacity', next); this.applyMapOpacity();
  };
  protected readonly changeZoom = (value: string | number): void => {
    const zoom = Number(value); if (!Number.isFinite(zoom)) return;
    const next = this.validZoom(zoom); this.zoomLevel.set(next); this.saveSetting('zoom', next); this.map?.setZoom(next); this.offlineRenderer?.map.setZoom(next);
  };
  protected readonly adjustZoom = (direction: -1 | 1): void => {
    this.changeZoom((this.offlineRenderer?.map.getZoom() ?? this.map?.getZoom() ?? this.zoomLevel()) + direction);
  };
  protected readonly changeMarkerOpacity = (value: string | number): void => {
    const opacity = Number(value); if (!Number.isFinite(opacity)) return;
    const next = Math.max(0, Math.min(100, Math.round(opacity)));
    this.markerOpacity.set(next); this.saveSetting('markerOpacity', next);
    const markerOpacity = this.markersVisible() ? next / 100 : 0;
    this.mapElement().nativeElement.style.setProperty('--marker-opacity', String(markerOpacity));
    for (const folderMarker of this.directoryMarkers) folderMarker.setOpacity(markerOpacity);
    this.directoryMarkerGroup?.refreshClusters?.();
    this.offlineRenderer?.setPhotoOpacity(markerOpacity);
  };
  protected readonly changeLocationOpacity = (value: string | number): void => {
    const opacity = Number(value); if (!Number.isFinite(opacity)) return;
    const next = Math.max(0, Math.min(100, Math.round(opacity)));
    this.locationOpacity.set(next); this.saveSetting('locationOpacity', next);
    const opacityValue = this.locationVisible() ? next / 100 : 0;
    this.marker?.setOpacity(opacityValue);
    this.offlineRenderer?.setCurrentOpacity(opacityValue);
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
    if (fitTrack && this.offlineRenderer) {
      const points = segments.flat();
      const longitudes = points.map(point => point[1]), latitudes = points.map(point => point[0]);
      this.offlineRenderer.map.fitBounds([[Math.min(...longitudes), Math.min(...latitudes)], [Math.max(...longitudes), Math.max(...latitudes)]], { padding: 24, maxZoom: 16, duration: 0 });
      this.zoomLevel.set(this.offlineRenderer.map.getZoom()); this.saveSetting('zoom', this.offlineRenderer.map.getZoom());
    } else if (fitTrack && this.map) {
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
    const mapLibreCanvas = this.mapElement().nativeElement.querySelector<HTMLElement>('.maplibregl-canvas');
    if (mapLibreCanvas) mapLibreCanvas.style.filter = this.filters[this.mapColor()];
    const pane = this.mapElement().nativeElement.querySelector<HTMLElement>('.leaflet-tile-pane');
    if (pane) pane.style.filter = this.filters[this.mapColor()];
  }
  private applyMapOpacity(): void {
    const opacity = this.mapVisible() ? this.mapOpacity() / 100 : 0;
    this.offlineRenderer?.setBasemapOpacity(opacity);
    const pane = this.mapElement().nativeElement.querySelector<HTMLElement>('.leaflet-tile-pane');
    if (pane) pane.style.opacity = String(opacity);
  }
  private applyGpxTrack(): void {
    if (this.offlineRenderer) {
      this.offlineRenderer.setTrack(this.gpxVisible() ? this.gpxSegments : [], this.gpxColor(), .92 * this.gpxOpacity() / 100);
      return;
    }
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
        if (!api) { reject(new Error('Leaflet loaded without exposing its API.')); return; }
        const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css'; document.head.appendChild(css);
        const theme = document.createElement('link'); theme.rel = 'stylesheet'; theme.href = 'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css'; document.head.appendChild(theme);
        const plugin = document.createElement('script'); plugin.src = 'https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js';
        plugin.onload = () => resolve(api); plugin.onerror = () => reject(new Error('Unable to load Leaflet marker clustering.')); document.head.appendChild(plugin);
      };
      script.onerror = () => reject(new Error('Unable to load Leaflet.'));
      document.head.appendChild(script);
    });
  }
}
