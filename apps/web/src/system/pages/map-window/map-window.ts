import { ChangeDetectionStrategy, Component, ElementRef, computed, HostListener, inject, OnDestroy, OnInit, signal, viewChild } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Desktop, lookupReverseGeocoding, type OsmAndHillshadeDatabase } from 'internal-api';
import { ThemeService } from '../../services/theme/theme.service';
import { OfflineMapRenderer, buildPhotoMarkerPreviewHtml, createOsmAndMapStyle, createOsmAndAtlasMapStyle, registerOsmAndAtlasTileProtocol, registerOsmAndHillshadeTileProtocol, registerOsmAndTileProtocol, type OfflinePhotoMarker, type OfflineMapStyle } from './offline-map-renderer';

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

interface MapErrorEntry {
  id: number;
  timestamp: string;
  source: string;
  renderer: string;
  style: string;
  message: string;
  occurrences: number;
  lastSeenAt: number;
}

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
<nav class="settings-tabs" role="tablist" aria-label="Location settings">
  <button type="button" role="tab" class="settings-tab" [class.active]="activeSettingsTab() === 'location'" [attr.aria-selected]="activeSettingsTab() === 'location'" (click)="selectSettingsTab('location')">Location</button>
  <button type="button" role="tab" class="settings-tab" [class.active]="activeSettingsTab() === 'track'" [attr.aria-selected]="activeSettingsTab() === 'track'" (click)="selectSettingsTab('track')">Track</button>
  <button type="button" role="tab" class="settings-tab" [class.active]="activeSettingsTab() === 'marker'" [attr.aria-selected]="activeSettingsTab() === 'marker'" (click)="selectSettingsTab('marker')">Marker</button>
  <button type="button" role="tab" class="settings-tab" [class.active]="activeSettingsTab() === 'view'" [attr.aria-selected]="activeSettingsTab() === 'view'" (click)="selectSettingsTab('view')">View</button>
  <span class="settings-tabs-spacer" aria-hidden="true"></span>
  <button type="button" role="tab" class="settings-tab settings-tab-map-group" [class.active]="activeSettingsTab() === 'offlineMaps'" [attr.aria-selected]="activeSettingsTab() === 'offlineMaps'" (click)="selectSettingsTab('offlineMaps')">OfflineMaps</button>
  <button type="button" role="tab" class="settings-tab settings-tab-map-group" [class.active]="activeSettingsTab() === 'hillshade'" [attr.aria-selected]="activeSettingsTab() === 'hillshade'" (click)="selectSettingsTab('hillshade')">Hillshade</button>
  <button type="button" role="tab" class="settings-tab settings-tab-map-group" [class.active]="activeSettingsTab() === 'cache'" [attr.aria-selected]="activeSettingsTab() === 'cache'" (click)="selectSettingsTab('cache')">Cache</button>
  <button type="button" role="tab" class="settings-tab settings-tab-map-group" [class.active]="activeSettingsTab() === 'memory'" [attr.aria-selected]="activeSettingsTab() === 'memory'" (click)="selectSettingsTab('memory')">Memory</button>
  <button type="button" role="tab" class="settings-tab settings-tab-map-group" [class.active]="activeSettingsTab() === 'download'" [attr.aria-selected]="activeSettingsTab() === 'download'" (click)="selectSettingsTab('download')">Download</button>
  <button type="button" role="tab" class="settings-tab settings-tab-map-group" [class.active]="activeSettingsTab() === 'errors'" [class.has-errors]="mapErrors().length > 0" [attr.aria-selected]="activeSettingsTab() === 'errors'" (click)="selectSettingsTab('errors')">Error @if (mapErrors().length > 0) { <span class="settings-tab-error-count">{{ mapErrors().length }}</span> }</button>
</nav>
<div class="settings-tab-panels">
<div class="settings-tab-panel" role="tabpanel" [hidden]="activeSettingsTab() !== 'location'">
<div class="settings-tab-content location-tab">
            
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
          </div>

</div>
<div class="settings-tab-panel" role="tabpanel" [hidden]="activeSettingsTab() !== 'track'">
<div class="settings-tab-content track-tab">
            
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
          </div>

</div>
<div class="settings-tab-panel" role="tabpanel" [hidden]="activeSettingsTab() !== 'marker'">
<div class="settings-tab-content marker-tab">
            
            <div class="marker-settings-content">
              <label class="marker-enable-toggle marker-setting-row"><input type="checkbox" [checked]="directoryMarkersEnabled()" (change)="changeDirectoryMarkersEnabled($any($event.target).checked)"> Show marker</label>
              <div class="marker-appearance-settings">
                <div class="marker-setting-row">
                  <span>Cluster Icons:</span>
                  <label>Shape
                    <select [value]="markerShape()" (change)="changeMarkerShape($any($event.target).value)">
                      <option value="double-circle">Double circles</option><option value="hexagon">Hexagon</option><option value="circle">Circle</option><option value="square">Square</option>
                    </select>
                  </label>
                </div>
                <div class="marker-setting-row">
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
              </div>
              @if (directoryMarkersEnabled()) {
                <details class="marker-summary-section">
                  <summary>Summary</summary>
                  <div class="marker-summary-content">
                    <div class="marker-progress-row">
                      <div class="marker-progress-text">Database records: <strong>{{ markerFilesChecked() }} / {{ markerFilesTotal() }}</strong></div>
                      <progress class="marker-progress" [max]="markerFilesTotal() || 1" [value]="markerFilesChecked()"></progress>
                    </div>
                    <div class="marker-statistics"><span>GPS markers found: <strong>{{ markerCount() }}</strong></span></div>
                    <div class="marker-status" role="status">{{ markerStatus() }}</div>
                  </div>
                </details>
              }
            </div>
          </div>

</div>
<div class="settings-tab-panel" role="tabpanel" [hidden]="activeSettingsTab() !== 'view'">
<div class="settings-tab-content view-tab">
  <div class="view-primary-controls">
  <div class="view-source-controls">
    <div class="map-source-content">
      <div class="map-source-picker">
        <span class="map-source-picker-label">Source</span>
        <button type="button" class="map-source-picker-trigger" [attr.aria-expanded]="mapSourceMenuOpen()" aria-haspopup="true" (click)="mapSourceMenuOpen.update(open => !open)">
          {{ selectedMapSourceType() }}
        </button>
        @if (mapSourceMenuOpen()) {
          <div class="map-source-picker-menu" role="dialog" aria-label="Select map source">
            <table class="map-source-picker-table">
              <thead><tr><th>Type</th><th>Suffix</th><th>Online/Offline</th></tr></thead>
              <tbody>
                <tr><td><button type="button" (click)="selectMapSource('online')">Online map</button></td><td>—</td><td>Online</td></tr>
                <tr><td><button type="button" (click)="selectMapSource('offline')">MBTiles</button></td><td>.mbtiles</td><td>Offline</td></tr>
                <tr><td><button type="button" (click)="selectMapSource('osmand')">OsmAnd (no labels)</button></td><td>.obf</td><td>Offline</td></tr>
                <tr><td><button type="button" (click)="selectMapSource('osmand-atlas')">OsmAnd Atlas</button></td><td>.obf</td><td>Offline</td></tr>
              </tbody>
            </table>
          </div>
        }
      </div>
      @if (mapSource() === 'online') {
        <label class="online-map-style-control"><span>Style</span>
          <select [value]="mapStyle()" (change)="changeMapStyle($any($event.target).value)">
            <option value="standard">Standard</option><option value="satellite">Satellite</option>
            <option value="cycling">Cycling (CyclOSM)</option><option value="topographic">Topographic</option>
            <option value="humanitarian">Humanitarian (HOT)</option>
          </select>
        </label>
      }
    </div>
  </div>
  <div class="view-style-controls">
    @if (mapSource() === 'osmand' || mapSource() === 'osmand-atlas') {
      <label class="offline-style-control"><span>OsmAnd Style</span>
        <select (change)="changeOsmAndStyle($any($event.target).value)" [disabled]="osmAndStyles().length === 0">
          @for (style of osmAndStyles(); track style.fileName) {
            <option [value]="style.fileName" [selected]="style.fileName === osmAndStyle()">{{ style.label }}</option>
          }
        </select>
      </label>
    }
    @if (mapSource() === 'offline') {
      <label class="offline-style-control"><span>MBTiles Style</span>
        <select [value]="offlineMapStyle()" (change)="changeOfflineMapStyle($any($event.target).value)">
          <option value="lumascope">LumaScope</option>
          <option value="versatiles-colorful">VersaTiles Colorful</option>
          <option value="versatiles-neutrino">VersaTiles Neutrino</option>
        </select>
      </label>
    }
  </div>
  <label class="view-map-color"><span>Color</span>
    <select [value]="mapColor()" (change)="changeMapColor($any($event.target).value)">
      <option value="original">Original</option><option value="light">Light</option>
      <option value="extra-light">Extra light</option><option value="ultra-light">Ultra light</option>
      <option value="dark">Dark</option><option value="grayscale">Grayscale</option>
      <option value="pastel">Pastel</option><option value="contrast">High contrast</option><option value="night">Night</option>
    </select>
  </label>
  </div>
  <details class="zoom-settings-section">
    <summary>
      <span>Zoom</span>
      <span class="zoom-summary-control">
        <span class="zoom-buttons">
          <button type="button" class="zoom-step" (click)="adjustZoom(-1)" aria-label="Zoom out">−</button>
          <button type="button" class="zoom-step" (click)="adjustZoom(1)" aria-label="Zoom in">+</button>
        </span>
        <input type="range" min="1" max="20" step="1" [value]="zoomLevel()" (input)="changeZoom($any($event.target).value)" aria-label="Map zoom">
        <span class="zoom-value">{{ zoomLevel() }}</span>
      </span>
    </summary>
    <div class="atlas-density-zoom-row">
      <div class="range-setting atlas-density-setting" [class.setting-unavailable]="mapSource() !== 'osmand-atlas'">
        <label for="atlas-display-density">Display density factor</label>
        <input id="atlas-display-density" type="range" min="1" max="3" step="0.05"
          [value]="atlasDisplayDensityFactor()"
          (input)="previewAtlasDisplayDensity($any($event.target).value)"
          (change)="changeAtlasDisplayDensity($any($event.target).value)"
          [disabled]="mapSource() !== 'osmand-atlas'"
          aria-label="OsmAnd Atlas display density">
        <span class="range-value">{{ atlasDisplayDensityFactor() }}×</span>
        <button type="button" class="map-toolbar-button" (click)="resetAtlasDisplayDensity()" [disabled]="mapSource() !== 'osmand-atlas'" title="Reset to Windows display scaling">Windows</button>
      </div>
    </div>
  </details>
  <details class="opacity-settings" [open]="opacitySectionOpen()" (toggle)="onLocationDetailsToggle($event)">
    <summary>
      <span>Opacity</span>
    </summary>
    <div class="opacity-content">
      <div class="range-setting">
        <label class="visibility-toggle">Map <input type="checkbox" [checked]="mapVisible()" (change)="changeMapVisibility($any($event.target).checked)" aria-label="Show map"></label>
        <input class="opacity-slider" type="range" min="0" max="100" step="1" [value]="mapOpacity()" (input)="changeMapOpacity($any($event.target).value)">
        <span class="range-value">{{ mapOpacity() }}%</span>
      </div>
      <div class="range-setting">
        <label class="visibility-toggle">Track <input type="checkbox" [checked]="gpxVisible()" (change)="changeTrackVisibility($any($event.target).checked)" aria-label="Show track"></label>
        <input class="opacity-slider" type="range" min="0" max="100" step="1" [value]="gpxOpacity()" (input)="changeGpxOpacity($any($event.target).value)">
        <span class="range-value">{{ gpxOpacity() }}%</span>
      </div>
      <div class="range-setting">
        <label class="visibility-toggle">Markers <input type="checkbox" [checked]="markersVisible()" (change)="changeMarkersVisibility($any($event.target).checked)" aria-label="Show markers"></label>
        <input class="opacity-slider" type="range" min="0" max="100" step="1" [value]="markerOpacity()" (input)="changeMarkerOpacity($any($event.target).value)">
        <span class="range-value">{{ markerOpacity() }}%</span>
      </div>
      <div class="range-setting">
        <label class="visibility-toggle">Location <input type="checkbox" [checked]="locationVisible()" (change)="changeLocationVisibility($any($event.target).checked)" aria-label="Show location"></label>
        <input class="opacity-slider" type="range" min="0" max="100" step="1" [value]="locationOpacity()" (input)="changeLocationOpacity($any($event.target).value)">
        <span class="range-value">{{ locationOpacity() }}%</span>
      </div>
      <div class="range-setting overlay-opacity-setting" [class.setting-unavailable]="!overlayMode">
        <label for="overlay-opacity">Window</label>
        <input id="overlay-opacity" class="opacity-slider" type="range" min="0" max="100" step="1" [value]="overlayOpacity()" (input)="changeOverlayOpacity($any($event.target).value)" [disabled]="!overlayMode" aria-label="Window opacity">
        <span class="range-value">{{ overlayOpacity() }}%</span>
      </div>
      <div class="range-setting" [class.setting-unavailable]="mapSource() !== 'offline'">
        <label class="visibility-toggle">Labels <input type="checkbox" [checked]="labelsVisible()" (change)="changeLabelsVisibility($any($event.target).checked)" [disabled]="mapSource() !== 'offline'" aria-label="Show labels"></label>
        <input id="map-label-opacity" class="opacity-slider" type="range" min="0" max="100" step="1"
          [value]="labelOpacity()" (input)="changeLabelOpacity($any($event.target).value)"
          [disabled]="mapSource() !== 'offline'" aria-label="Map label opacity">
        <span class="range-value">{{ labelOpacity() }}%</span>
      </div>
      <div class="range-setting" [class.setting-unavailable]="activeHillshadeDatabaseCount() === 0">
        <label class="visibility-toggle">Hillshade <input type="checkbox" [checked]="hillshadeVisible()" (change)="changeHillshadeVisibility($any($event.target).checked)" [disabled]="activeHillshadeDatabaseCount() === 0 || mapSource() === 'online'" aria-label="Show Hillshade"></label>
        <input id="hillshade-opacity" class="opacity-slider" type="range" min="0" max="100" step="1"
          [value]="hillshadeOpacity()" (input)="changeHillshadeOpacity($any($event.target).value)"
          [disabled]="activeHillshadeDatabaseCount() === 0 || !hillshadeVisible() || mapSource() === 'online'" aria-label="Hillshade opacity">
        <span class="range-value">{{ hillshadeOpacity() }}%</span>
      </div>
    </div>
  </details>
  <details class="view-rerender-section" [open]="renderSectionOpen()" (toggle)="onLocationDetailsToggle($event)" [style.background]="renderActiveCount() > 0 ? 'rgba(180, 45, 45, 0.13)' : 'rgba(45, 150, 75, 0.10)'">
    <summary>
      <span>Render</span>
      <span class="map-cache-progress render-progress-always" [class.is-inactive]="renderActiveCount() === 0 && !rerenderVisibleTilesBusy()" [attr.aria-disabled]="renderActiveCount() === 0 && !rerenderVisibleTilesBusy()">
        <progress [value]="renderActiveCount() === 0 && !rerenderVisibleTilesBusy() ? 0 : renderProgressValue()" [max]="renderProgressMaximum()" aria-label="Map tile rendering progress"></progress>
        @if (renderActiveCount() === 0 && !rerenderVisibleTilesBusy()) {
          <span>Rendering inactive</span>
        } @else {
          <span>{{ renderActiveCount() }} / {{ renderTotalCount() }} tile requests remaining</span>
        }
      </span>
    </summary>
    <div class="map-cache-actions view-rerender-actions">
      <label class="visibility-toggle"><input type="checkbox" [checked]="renderVisualsEnabled()" (change)="changeRenderVisualsEnabled($any($event.target).checked)"> Show tile rendering overlay and dimming</label>
      <button type="button" (click)="rerenderVisibleTiles()" [disabled]="(mapSource() !== 'osmand-atlas' && mapSource() !== 'osmand') || rerenderVisibleTilesBusy()">
        {{ rerenderVisibleTilesBusy() ? 'Rerendering…' : 'Rerender visible tiles' }}
      </button>
      <span class="offline-map-status">{{ rerenderVisibleTilesStatus() || (mapSource() === 'osmand-atlas' ? 'Rerenders visible OsmAnd tiles without reading cached PNGs.' : mapSource() === 'osmand' ? 'Rerenders visible no-label tiles without reading cached PNGs.' : 'Select an OsmAnd renderer to rerender visible tiles.') }}</span>
    </div>
  </details>
</div>
</div>
<div class="settings-tab-panel" role="tabpanel" [hidden]="activeSettingsTab() !== 'hillshade'">
  <div class="settings-tab-content offline-maps-tab-content">
    <div class="mbtiles-selection offline-map-toolbar">
      <button type="button" class="offline-map-add-button" (click)="addHillshadeDatabases()">Add Hillshade files...</button>
      <span class="offline-map-status" role="status">{{ hillshadeDatabaseCount() }} Hillshade database(s) loaded · {{ activeHillshadeDatabaseCount() }} active</span>
    </div>
    <table class="offline-maps-table">
      <thead><tr><th>Active</th><th>Hillshade database</th><th>Status</th><th></th></tr></thead>
      <tbody>
        @for (database of hillshadeDatabases(); track database.id) {
          <tr [class.mbtiles-map-disabled]="!database.enabled || !database.available">
            <td><input type="checkbox" [checked]="database.enabled" [disabled]="!database.available" (change)="setHillshadeDatabaseEnabled(database.id, $any($event.target).checked)" aria-label="Activate Hillshade database"></td>
            <td>{{ database.path.split(/[\\/]/).pop() }}</td>
            <td>{{ database.available ? (database.enabled ? 'Active' : 'Inactive') : 'File not found' }}</td>
            <td><button type="button" class="mbtiles-remove-button" (click)="removeHillshadeDatabase(database.id)">Remove</button></td>
          </tr>
        } @empty {
          <tr><td colspan="4">No Hillshade databases added.</td></tr>
        }
      </tbody>
    </table>
    <div class="offline-map-status">Enabled databases are rendered as separate transparent raster layers. The Hillshade opacity slider in View applies to all active databases.</div>
  </div>
</div>
<div class="settings-tab-panel" role="tabpanel" [hidden]="activeSettingsTab() !== 'offlineMaps'">
<div class="settings-tab-content offline-maps-tab-content">
  <details class="map-cache-section offline-map-updates-section">
    <summary class="map-cache-heading">Updates</summary>
    <div class="map-cache-actions offline-map-update-actions">
      <button type="button" class="offline-map-add-button" (click)="checkForOfflineMapUpdates()" [disabled]="offlineMaps().length === 0 || offlineMapUpdateCheckBusy()">{{ offlineMapUpdateCheckBusy() ? 'Checking…' : 'Check for updates' }}</button>
      <span class="offline-map-status" role="status">{{ offlineMapUpdateCheckStatus() || offlineMapCatalogueSummary() }}</span>
    </div>
  </details>
  <div class="mbtiles-selection offline-map-toolbar">
                <label class="offline-map-preset-control">OBF preset:
                  <select [value]="offlineMapPreset()" (change)="changeOfflineMapPreset($any($event.target).value)">
                    <option value="austria">Austria</option>
                    <option value="europe">Europe</option>
                    <option value="all">All</option>
                    <option value="custom">Custom</option>
                    <option value="custom-no-world-map">Custom (no world map)</option>
                  </select>
                </label>
                <button class="offline-map-add-button" type="button" (click)="chooseOfflineMap()">Add offline maps...</button>
                <button class="offline-map-add-button offline-map-clear-button" type="button" (click)="clearOfflineMapsList()" [disabled]="offlineMaps().length === 0">Clear maps list</button>
                <button class="offline-map-add-button offline-map-bulk-button" type="button" (click)="setAllOfflineMapsEnabled(true)" [disabled]="offlineMaps().length === 0">Activate all</button>
                <button class="offline-map-add-button offline-map-bulk-button" type="button" (click)="setAllOfflineMapsEnabled(false)" [disabled]="offlineMaps().length === 0">Deactivate all</button>
                <label class="offline-map-list-filter">Filter:
                  <select [value]="offlineMapListFilter()" (change)="offlineMapListFilter.set($any($event.target).value)">
                    <option value="all">All</option>
                    <option value="inUse">InUse</option>
                    <option value="active">Active</option>
                    <option value="updates">Updates</option>
                    <option value="current">Current (no update needed)</option>
                    <option value="noMatch">No matching download</option>
                  </select>
                </label>
                <span class="offline-map-status" role="status">{{ offlineMaps().length + ' map(s) loaded · ' + activeOfflineMapCount() + ' map(s) active · ' + inUseOfflineMapCount() + ' map(s) in use · ' + filteredOfflineMaps().length + ' map(s) filtered' }}
                @if (coordinatesAvailable() && mapSource() === 'offline' && !activeOfflineMapId()) { · No offline map covers this location; using the online map }
                </span>
              </div>
</div>
</div>
<div class="settings-tab-panel" role="tabpanel" [hidden]="activeSettingsTab() !== 'cache'">
  <div class="settings-tab-content cache-tab">
    <div class="map-cache-section">
      <div class="map-cache-heading">OsmAnd map tiles</div>
      <div class="map-cache-row"><span>Location</span><code>{{ osmAndTileCache().path }}</code></div>
      <div class="map-cache-row"><span>PNG tiles</span><strong>{{ osmAndTileCache().entries.toLocaleString() }}</strong></div>
      <div class="map-cache-row"><span>Storage used</span><strong>{{ formatOfflineMapSize(osmAndTileCache().bytes) }}</strong></div>
      <div class="map-cache-actions">
        <span class="offline-map-status">{{ osmAndTileCache().available ? 'Persistent cache' : 'Cache will be created on first render' }}</span>
        <button type="button" (click)="refreshOsmAndTileCache()">Refresh</button>
      </div>
      <div class="map-cache-actions">
        <button type="button" (click)="rerenderVisibleTiles()" [disabled]="(mapSource() !== 'osmand-atlas' && mapSource() !== 'osmand') || rerenderVisibleTilesBusy()">
          {{ rerenderVisibleTilesBusy() ? 'Rerendering…' : 'Rerender visible tiles' }}
        </button>
        <span class="offline-map-status">{{ rerenderVisibleTilesStatus() || (mapSource() === 'osmand-atlas' ? 'Rerenders visible OsmAnd tiles without reading cached PNGs.' : mapSource() === 'osmand' ? 'Rerenders visible no-label tiles without reading cached PNGs.' : 'Select an OsmAnd renderer to rerender visible tiles.') }}</span>
      </div>
      @if (rerenderVisibleTilesBusy()) {
        <div class="map-cache-progress">
          <progress [value]="rerenderVisibleTilesProgress().completed" [max]="rerenderVisibleTilesProgress().total"></progress>
          <span>{{ rerenderVisibleTilesProgress().total - rerenderVisibleTilesProgress().completed }} / {{ rerenderVisibleTilesProgress().total }} visible tiles remaining</span>
        </div>
      }
    </div>
  </div>
</div>
<div class="settings-tab-panel" role="tabpanel" [hidden]="activeSettingsTab() !== 'memory'">
  <div class="settings-tab-content cache-tab">
    <div class="map-cache-section">
      <div class="map-cache-heading">Process memory</div>
      <div class="map-cache-row"><span>Total (Working Set)</span><strong>{{ formatOfflineMapSize(totalProcessMemoryBytes()) }}</strong></div>
      <div class="map-cache-row"><span>Last updated</span><strong>{{ memoryUpdatedAt() || '—' }}</strong></div>
      <table class="offline-maps-table memory-process-table">
        <colgroup><col style="width:42%"><col style="width:14%"><col style="width:24%"><col style="width:20%"></colgroup>
        <thead><tr><th>Process</th><th>PID</th><th>Working Set</th><th>Private</th></tr></thead>
        <tbody>
          @for (entry of processMemory().processes; track entry.pid) {
            <tr>
              <td>{{ entry.name }}</td>
              <td>{{ entry.pid }}</td>
              <td>{{ formatOfflineMapSize(entry.workingSetBytes) }}</td>
              <td>{{ entry.privateBytes === null ? '—' : formatOfflineMapSize(entry.privateBytes) }}</td>
            </tr>
          }
        </tbody>
      </table>
      @if (processMemory().processes.length === 1) {
        <span class="offline-map-status">No OsmAnd helper processes are currently running.</span>
      }
      @if (processMemory().error) {
        <span class="offline-map-import-error">Could not read complete helper memory data: {{ processMemory().error }}</span>
      }
      <div class="map-cache-actions">
        <span class="offline-map-status">Automatically refreshes every 2 seconds while the Memory tab is open</span>
        <button type="button" (click)="refreshProcessMemory()">Refresh</button>
      </div>
    </div>
  </div>
</div>
<div class="settings-tab-panel" role="tabpanel" [hidden]="activeSettingsTab() !== 'download'">
  <div class="settings-tab-content download-tab">
    <details class="map-cache-section download-section">
      <summary class="map-cache-heading">Download sources</summary>
      <div class="map-cache-actions">
        <span class="offline-map-status">Configure the catalogue URLs used to discover offline maps.</span>
        <button type="button" (click)="addDownloadSource()">Add URL</button>
      </div>
      <div class="mbtiles-map-table-wrap">
        <table class="mbtiles-map-table download-source-table">
          <thead><tr><th>URL</th><th>Filetype</th><th>Use for updates</th><th></th></tr></thead>
          <tbody>
            @for (source of downloadSources(); track $index; let i = $index) {
              <tr>
                <td class="download-source-url"><input type="url" [value]="source.url" (change)="updateDownloadSource(i, { url: $any($event.target).value })" aria-label="Download source URL"></td>
                <td><select [value]="source.fileType" (change)="updateDownloadSource(i, { fileType: $any($event.target).value })" aria-label="Download source filetype"><option value="obf">OBF</option><option value="mbtiles">MBTiles</option></select></td>
                <td class="mbtiles-enabled-column"><input type="checkbox" [checked]="source.useForUpdates" (change)="updateDownloadSource(i, { useForUpdates: $any($event.target).checked })" aria-label="Use for updates"></td>
                <td><button type="button" (click)="openDownloadSource(source.url)" [disabled]="!isValidDownloadUrl(source.url)">Open</button><button type="button" (click)="removeDownloadSource(i)" aria-label="Remove download source">Remove</button></td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <p class="offline-map-status">These URLs are saved in application settings. Only entries enabled under “Use for updates” are checked by the OfflineMaps update checker.</p>
    </details>

    <details class="map-cache-section download-section">
      <summary class="map-cache-heading">Updates</summary>
      <div class="map-cache-actions offline-catalogue-toolbar">
        <span class="offline-map-status">Check configured catalogues for available offline-map updates.</span>
        <button type="button" class="offline-map-add-button" (click)="checkForOfflineMapUpdates()" [disabled]="offlineMapUpdateCheckBusy()">{{ offlineMapUpdateCheckBusy() ? 'Checking…' : 'Check for updates' }}</button>
      </div>
      <p class="offline-map-status" role="status">{{ offlineMapCatalogueSummary() }}</p>
      @if (offlineMapCatalogueFiles().length > 0) {
        <div class="mbtiles-map-table-wrap offline-catalogue-table-wrap">
          <table class="mbtiles-map-table offline-catalogue-table">
            <thead><tr><th>File name</th><th>Type</th><th>Catalogue date</th><th>Source</th><th></th></tr></thead>
            <tbody>
              @for (file of offlineMapCatalogueFiles(); track file.url) {
                <tr [class.offline-catalogue-matched]="file.matched">
                  <td class="offline-catalogue-file-name"><strong>{{ file.fileName }}</strong></td>
                  <td>{{ file.fileType.toUpperCase() }}</td>
                  <td class="mbtiles-map-number">{{ file.dateMs === null ? '—' : formatOfflineMapDate(file.dateMs) }}</td>
                  <td>{{ file.source }}</td>
                  <td><button type="button" (click)="openDownloadSource(file.url)">Open</button></td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      } @else {
        <p class="offline-map-status">No catalogue files listed yet. Run “Check for updates” to download and parse the configured catalogue pages.</p>
      }
    </details>

    <details class="map-cache-section download-section">
      <summary class="map-cache-heading">Local sources</summary>
      <div class="osmand-resources-picker">
        <strong>OsmAnd resources folder</strong>
        <span class="osmand-resources-path">{{ osmAndResourcesPath() || 'No external resources folder selected' }}</span>
        <button type="button" (click)="chooseOsmAndResourcesFolder()">Select folder…</button>
        @if (osmAndResourcesError()) { <p class="gpx-error" role="alert">{{ osmAndResourcesError() }}</p> }
        <p>Download separately from <a href="https://github.com/osmandapp/OsmAnd-resources" target="_blank" rel="noopener">OsmAnd-resources on GitHub</a>. Select the extracted resources root containing <code>rendering_styles/default.render.xml</code>. Resources are not bundled with LumaScope.</p>
      </div>
    </details>
  </div>
</div>
<div class="settings-tab-panel" role="tabpanel" [hidden]="activeSettingsTab() !== 'errors'">
  <div class="map-error-panel">
    <div class="map-cache-actions">
      <div>
        <div class="map-cache-heading">Map and rendering errors</div>
        <span class="offline-map-status">{{ mapErrors().length }} error entr{{ mapErrors().length === 1 ? 'y' : 'ies' }} recorded in this session</span>
      </div>
      <button type="button" (click)="clearMapErrors()" [disabled]="mapErrors().length === 0">Clear</button>
    </div>
    @if (mapErrors().length > 0) {
      <div class="map-error-list">
        @for (error of mapErrors(); track error.id) {
          <article class="map-error-entry">
            <div class="map-error-entry-heading"><strong>{{ error.source }}</strong><time>{{ error.timestamp }}</time>@if (error.occurrences > 1) { <span>{{ error.occurrences }} occurrences</span> }</div>
            <div class="map-error-context"><span>Renderer: <strong>{{ error.renderer }}</strong></span><span>Style: <strong>{{ error.style }}</strong></span></div>
            <pre>{{ error.message }}</pre>
          </article>
        }
      </div>
    } @else {
      <span class="offline-map-status">No errors recorded.</span>
    }
  </div>
</div>
</div>
</section>
      }
      @if (mapDisplayNotice() && (!settingsOpen() || activeSettingsTab() !== 'offlineMaps')) {
        <div class="map-display-notice" role="alert">
          <strong>Map cannot be displayed</strong>
          <span>{{ mapDisplayNotice() }}</span>
          <button type="button" (click)="openResourcesDownloadTab()">Open Download tab</button>
        </div>
      }
      <div class="map-content">
        @if (settingsOpen() && activeSettingsTab() === 'offlineMaps') {
          <div class="offline-map-list-view">
            <div class="mbtiles-map-list">
              @if (offlineMaps().length > 0) {
                <table class="mbtiles-map-table">
                  <thead><tr><th class="mbtiles-inuse-column">InUse</th><th class="mbtiles-enabled-column">Active</th><th>Type</th><th>Map / file</th><th>File size</th><th>Last modified</th><th class="mbtiles-updates-column">Updates</th><th>Bounds</th><th>Zoom</th><th></th></tr></thead>
                  <tbody>
                    @for (map of filteredOfflineMaps(); track map.id) {
                      <tr [class.mbtiles-map-disabled]="!map.enabled" [class.obf-map-row]="map.type === 'obf'" [class.mbtiles-map-row]="map.type !== 'obf'">
                        <td class="mbtiles-inuse-column"><span class="mbtiles-inuse-symbol" [class.in-use]="isOfflineMapInUse(map)" [attr.title]="isOfflineMapInUse(map) ? 'Currently used by the selected map source' : 'Not used by the selected map source'" [attr.aria-label]="isOfflineMapInUse(map) ? 'In use' : 'Not in use'">{{ isOfflineMapInUse(map) ? '●' : '—' }}</span></td>
                        <td class="mbtiles-enabled-column"><input type="checkbox" [checked]="map.enabled" [title]="'Preselect offline map ' + map.name" (change)="setOfflineMapEnabled(map.id, $any($event.target).checked)" [attr.aria-label]="'Active offline map ' + map.name"></td>
                        <td><i class="offline-map-format-tag" [class.obf-format-tag]="map.type === 'obf'" [class.mbtiles-format-tag]="map.type !== 'obf'">{{ map.type === 'obf' ? 'OBF' : 'MBTiles' }}</i></td>
                        <td class="mbtiles-map-file" [title]="map.filePath"><strong>{{ map.name }}</strong>@if (map.fileName !== map.name) { <span>{{ map.fileName }}</span> }</td>
                        <td class="mbtiles-map-number">{{ formatOfflineMapSize(map.fileSize) }}</td>
                        <td class="mbtiles-map-number">{{ formatOfflineMapDate(map.lastModified) }}</td>
                        <td class="mbtiles-updates-column"><span class="mbtiles-update-symbol" [class.update-available]="map.updateAvailable === true" [class.update-current]="map.updateAvailable === false" [class.update-unknown]="map.updateChecked && map.updateAvailable === null && map.updateMatched !== false" [class.update-no-match]="map.updateChecked && map.updateMatched === false" [attr.title]="map.updateAvailable === true ? 'Update available · ' + (map.updateDate || 'newer version') + ' · ' + (map.updateSource || 'source') : map.updateAvailable === false ? 'No newer version listed · ' + (map.updateSource || 'source') : map.updateMatched === true ? (map.updateDate ? 'Matched catalogue file · ' + map.updateDate + ' · ' + (map.updateSource || 'source') : 'Matched catalogue file · no catalogue date available · ' + (map.updateSource || 'source')) : map.updateChecked ? 'No matching filename found in the available catalogues' : 'Not checked yet'" [attr.aria-label]="map.updateAvailable === true ? 'Update available' : map.updateAvailable === false ? 'No update available' : map.updateMatched === true ? 'Catalogue file matched' : map.updateChecked ? 'No catalogue match' : 'Not checked'">{{ map.updateAvailable === true ? '↑' : map.updateAvailable === false ? '✓' : map.updateChecked && map.updateMatched === false ? '?' : map.updateChecked && map.updateMatched === true && map.updateAvailable === null ? '✓' : '—' }}</span></td>
                        <td class="mbtiles-map-bounds">{{ map.bounds }}</td>
                        <td class="mbtiles-map-number">{{ map.minZoom }}–{{ map.maxZoom }}</td>
                        <td><button type="button" class="mbtiles-remove-button" (click)="removeOfflineMap(map.id)" title="Remove map from LumaScope (file is not deleted)">Remove</button></td>
                      </tr>
                    }
                  </tbody>
                </table>
              } @else { <span class="offline-map-status">No offline maps loaded.</span> }
              @for (error of offlineMapImportErrors(); track $index) { <span class="offline-map-import-error">{{ error }}</span> }
            </div>
          </div>
        }
        <div #map class="map" [class.map-hidden]="!coordinatesAvailable() || (settingsOpen() && activeSettingsTab() === 'offlineMaps')" [style.opacity]="overlayMode ? overlayOpacity() / 100 : 1"></div>
        @if (!coordinatesAvailable() && (!settingsOpen() || activeSettingsTab() !== 'offlineMaps')) {
          <div class="map-unavailable" role="status">GPS coordinates are not available for this image.</div>
        }
        @if (renderInitStatus() && (!settingsOpen() || activeSettingsTab() !== 'offlineMaps')) {
          <div class="render-init-notice" role="status"><span class="render-init-spinner"></span>{{ renderInitStatus() }}</div>
        }
      </div>
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
    .map-display-notice{position:absolute;z-index:1050;top:50%;left:50%;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;gap:10px;max-width:min(520px,calc(100% - 36px));padding:18px 22px;text-align:center;background:var(--color-surface-default-high,#292a2d);border:1px solid var(--color-content-default-low,#666);border-radius:8px;box-shadow:0 5px 24px rgba(0,0,0,.35);color:var(--color-content-default-high,#eee)}
    .map-display-notice strong{font-size:15px}.map-display-notice span{overflow-wrap:anywhere}.map-display-notice button{margin-top:2px}
    .map-titlebar{position:relative;z-index:1100;-webkit-app-region:drag;height:38px;min-height:38px;display:flex;align-items:center;justify-content:flex-start;gap:12px;padding:0 10px;background:var(--color-surface-default-low,#292a2d);border-bottom:1px solid var(--color-content-default-low,#444);box-sizing:border-box}
    .map-title{display:flex;align-items:center;gap:8px;min-width:0;flex:0 0 auto;font-size:13px}.map-title-icon{font-size:18px;color:#8ab4f8}
    .map-titlebar button,.map-titlebar select,.map-titlebar label,.map-titlebar input{-webkit-app-region:no-drag}
    .titlebar-always-on-top{display:flex;align-items:center;gap:5px;white-space:nowrap;font-size:12px}
    .titlebar-always-on-top input{accent-color:#8ab4f8}
    .map-coordinates{font-size:11px;color:var(--color-content-default-medium,#aaa);white-space:nowrap;min-width:0;overflow:hidden;text-overflow:ellipsis}
    button,select{font:inherit;color:var(--color-content-default-high,#eee);background:var(--color-surface-default-high,#383a3f);border:1px solid var(--color-content-default-low,#555);border-radius:4px;padding:4px 8px}
    button{cursor:pointer}button:hover,.settings-toggle.active{background:var(--color-surface-default-medium,#4b5260);border-color:#8ab4f8}
    .settings-toggle{height:28px;white-space:nowrap;flex:0 0 auto}
    .map-settings{position:relative;z-index:2147483000;display:block;padding:0 10px 8px;background:var(--color-surface-default-low,#252629);border-bottom:0;box-sizing:border-box;height:max-content;min-height:max-content;max-height:none;overflow:visible;resize:none;flex:0 0 auto}
    .settings-tabs{display:flex;align-items:stretch;gap:3px;flex:0 0 auto;overflow-x:auto;white-space:nowrap;border-bottom:1px solid var(--color-content-default-low,#454545);margin:0 -10px 8px;padding:0 10px}
    .settings-tabs-spacer{flex:1 0 12px}
    .settings-tab.has-errors{color:#ff8a80}
    .settings-tab-error-count{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;margin-left:4px;padding:0 4px;border-radius:9px;background:rgba(255,110,110,.18);color:#ff8a80;font-size:10px;font-weight:700}
    .map-error-panel{display:flex;flex:1 1 auto;flex-direction:column;gap:10px;width:100%;min-width:0;min-height:0}
    .map-error-list{display:flex;flex:1 1 auto;flex-direction:column;gap:8px;min-width:0;min-height:0;overflow:auto;overscroll-behavior:contain}
    .map-error-entry{min-width:0;padding:8px 10px;border:1px solid rgba(255,120,120,.3);border-radius:5px;background:rgba(120,40,40,.10)}
    .map-error-entry-heading{display:flex;align-items:baseline;flex-wrap:wrap;gap:6px 12px;color:var(--color-content-default-medium,#aaa);font-size:11px}
    .map-error-entry-heading strong{color:#ff8a80}
    .map-error-entry-heading time{font-variant-numeric:tabular-nums}
    .map-error-entry pre{margin:6px 0 0;max-width:100%;overflow-wrap:anywhere;white-space:pre-wrap;font:11px/1.45 ui-monospace,Consolas,monospace;color:var(--color-content-default-high,#eee)}
    .settings-tab{border:0;border-bottom:2px solid transparent;border-radius:4px 4px 0 0;background:transparent;padding:8px 12px;white-space:nowrap}
    .settings-tab-map-group{background:color-mix(in srgb,var(--color-surface-default-medium,#343943) 78%,#8ab4f8 22%);border-radius:4px 4px 0 0}
    .settings-tab-map-group:hover{background:color-mix(in srgb,var(--color-surface-default-medium,#343943) 62%,#8ab4f8 38%)}
    .settings-tab-map-group.active,.settings-tab.active{background:#31577d;border:1px solid #65a9ff;border-bottom-color:#65a9ff;color:#fff;box-shadow:inset 0 -2px #65a9ff}
    .settings-tab-panels{display:block;width:100%;min-width:0;min-height:max-content;height:max-content;overflow:visible}
    .settings-tab-panel{min-width:0;min-height:max-content;height:max-content;overflow:visible}
    .settings-tab-panel:not([hidden]){display:block}
    .settings-tab-panel[hidden]{display:none}
    .settings-tab-content{display:flex;flex-direction:column;align-items:stretch;gap:8px;min-width:0;width:100%;padding:2px 0}
    .settings-tab-content>summary{display:none}
    .settings-tab-content.location-tab{width:100%}
    .view-primary-controls{display:flex;align-items:center;flex-wrap:wrap;gap:8px 16px;min-width:0}
    .atlas-density-zoom-row{display:flex;align-items:center;flex:1 1 100%;gap:18px;min-width:0}.atlas-density-zoom-row>.atlas-density-setting{flex:1 1 0;min-width:220px}
    .zoom-settings-section{display:flex;flex-direction:column;align-items:stretch;gap:7px;width:100%;min-width:0;padding:7px 0 0;border-top:1px solid var(--color-content-default-low,#454545)}
    .zoom-settings-section>summary{display:flex;align-items:center;gap:12px;cursor:pointer;font-weight:700;white-space:nowrap;list-style:disclosure-closed}
    .zoom-summary-control{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0;margin-left:auto}
    .zoom-summary-control input[type="range"]{flex:1 1 auto;min-width:70px;accent-color:#8ab4f8}
    .zoom-settings-section[open]>summary{margin-bottom:2px}
    .view-source-controls,.view-style-controls{display:contents}
    .view-primary-controls .map-source-content{display:flex;align-items:center;flex-wrap:wrap;gap:8px 14px;min-width:0}
    .view-primary-controls .offline-style-control{display:flex;align-items:center;gap:6px;white-space:nowrap;min-width:0}
    .view-primary-controls .view-map-color{display:flex;align-items:center;gap:7px;white-space:nowrap}
    .settings-tab-content.map-tab{width:100%}
    .settings-tab-content.track-tab,.settings-tab-content.marker-tab,.settings-tab-content.view-tab{width:100%}
    .settings-tab-content.offlineMaps-tab{width:100%}
     .cache-tab{width:100%}
     .map-cache-section{display:flex;flex-direction:column;gap:7px;max-width:900px;padding:5px 0}
     .map-cache-heading{font-weight:700;font-size:13px}
     .map-cache-row{display:grid;grid-template-columns:150px minmax(0,1fr);gap:12px;align-items:start;padding:4px 0;border-bottom:1px solid var(--color-content-default-low,#454545)}
     .map-cache-row>span{color:var(--color-content-default-medium,#aaa)}
     .map-cache-row code{font:11px/1.4 ui-monospace,monospace;overflow-wrap:anywhere;user-select:text}
     .map-cache-actions{display:flex;align-items:center;justify-content:space-between;gap:12px}
     .map-cache-progress{display:flex;align-items:center;gap:10px;min-width:0}
     .map-cache-progress progress{flex:1;min-width:120px;height:12px;accent-color:#65a9ff}
     .map-cache-progress span{flex:0 0 auto;color:var(--color-content-default-medium,#aaa);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}
    .render-progress-always{width:100%;box-sizing:border-box;min-height:24px;padding:4px 0}
    .render-progress-always.is-inactive{opacity:.42;filter:grayscale(1)}
    .view-rerender-section{display:flex;flex-direction:column;gap:7px;width:100%;min-width:0;padding-top:7px;border-top:1px solid var(--color-content-default-low,#454545)}
    .view-rerender-section>summary{display:flex;align-items:center;gap:12px;cursor:pointer;font-weight:700;white-space:nowrap;list-style:disclosure-closed}
    .view-rerender-section>summary .render-progress-always{flex:1 1 auto;width:auto;max-width:520px;margin-left:auto;padding:0;min-height:20px}
    .view-rerender-section[open]>summary{margin-bottom:2px}
    .view-rerender-section .map-cache-actions{min-width:0}
    .view-rerender-section .offline-map-status{max-width:none;flex:1 1 auto}

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
    .map-source-picker{position:relative;display:flex;align-items:center;gap:6px;white-space:nowrap;z-index:2147483002}
    .map-source-picker-label{font-weight:600}
    .map-source-picker-trigger{min-width:220px;text-align:left}
    .map-source-picker-menu{position:absolute;left:42px;top:calc(100% + 5px);min-width:460px;max-width:min(620px,80vw);padding:4px;border:1px solid var(--color-content-default-low,#555);border-radius:6px;background:var(--color-surface-default-high,#252932);box-shadow:0 8px 24px #0008;z-index:2147483003}
    .map-source-picker-table{width:100%;border-collapse:collapse;font-size:12px;white-space:nowrap}
    .map-source-picker-table th,.map-source-picker-table td{padding:7px 10px;text-align:left;border-bottom:1px solid var(--color-content-default-low,#454545)}
    .map-source-picker-table th{font-weight:700;color:var(--color-content-default-medium,#aaa)}
    .map-source-picker-table tr:last-child td{border-bottom:0}
    .map-source-picker-table td:first-child{width:52%}
    .map-source-picker-table td:nth-child(2){width:20%;font-family:monospace}
    .map-source-picker-table td:last-child{width:28%}
    .map-source-picker-table td button{width:100%;padding:0;border:0;background:transparent;text-align:left;color:inherit;cursor:pointer}
    .map-source-picker-table tbody tr:hover{background:var(--color-surface-default-medium,#343943)}
    .mbtiles-selection{display:grid;grid-template-columns:minmax(210px,1fr) auto minmax(0,2fr);align-items:center;gap:5px 8px;flex:1 1 100%;min-width:0}.offline-style-control{display:flex;align-items:center;gap:6px;grid-column:1/-1}
    .mbtiles-download-source{min-width:0;max-width:100%;}.mbtiles-download-controls{display:flex;flex-direction:row;align-items:center;gap:8px;flex-wrap:nowrap;}.mbtiles-download-controls .mbtiles-download-source{flex:0 0 280px;min-width:260px;}.mbtiles-download-url{display:block;box-sizing:border-box;height:28px;line-height:normal;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1 1 240px;width:0;min-width:0;max-width:100%;}.osmand-resources-picker{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 0;}.osmand-resources-path{flex:1 1 360px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}.osmand-resources-picker p{flex-basis:100%;margin:0;color:var(--color-text-secondary);font-size:11px;}.offline-map-clear-button{background:var(--color-surface-default-high,#454b55);color:var(--color-content-default-medium,#c5cbd3);border-color:var(--color-content-default-low,#626a75)}.offline-map-bulk-button{font-size:10px;padding:4px 8px;background:var(--color-surface-default-high,#454b55);color:var(--color-content-default-medium,#c5cbd3);border-color:var(--color-content-default-low,#626a75)}.offline-maps-tab-content{display:flex;flex-direction:column;gap:8px;min-width:0}.offline-map-updates-section{margin:0}.offline-map-update-actions{align-items:center;flex-wrap:wrap}.offline-map-update-actions .offline-map-status{flex:1 1 300px;min-width:0}.offline-map-toolbar{display:flex;flex-direction:row;align-items:center;justify-content:flex-start;gap:8px;flex-wrap:wrap;}.offline-map-toolbar .offline-map-preset-control{display:flex;align-items:center;gap:6px;flex:0 0 auto;}.offline-map-toolbar .offline-map-add-button{align-self:center}.offline-map-add-button{width:auto;min-width:0;flex:0 0 auto;padding:6px 10px;white-space:nowrap;}
    .mbtiles-selection{display:flex;flex:1 1 auto;flex-direction:column;align-items:stretch;gap:8px;min-width:0;min-height:0}
    .mbtiles-selection.offline-map-toolbar{flex-direction:row;align-items:center}
    .mbtiles-selection.mbtiles-download-controls{flex-direction:row;align-items:center;flex-wrap:nowrap}
    .mbtiles-map-list{flex:0 0 auto;grid-column:1/-1;width:100%;min-width:0;max-width:100%;height:auto;max-height:none;overflow:visible;overscroll-behavior:contain}
    .obf-map-row{background:rgba(56,139,253,.10)}.mbtiles-map-row{background:rgba(46,160,67,.07)}.offline-map-format-tag{display:inline-block;margin-right:5px;padding:1px 5px;border-radius:3px;font-style:normal;font-size:10px;font-weight:700;letter-spacing:.04em}.obf-format-tag{background:#174b78;color:#c8e5ff}.mbtiles-format-tag{background:#245b35;color:#c9f7d2}
    .mbtiles-map-table{width:100%;min-width:780px;border-collapse:collapse;font-size:11px;white-space:nowrap;font-variant-numeric:tabular-nums}
    .download-source-table{min-width:720px}.offline-catalogue-toolbar{margin-top:14px}
    .offline-catalogue-table-wrap{max-height:360px;overflow:auto;margin-top:6px}
    .offline-catalogue-table{width:100%;min-width:820px;table-layout:fixed}
    .offline-catalogue-table th,.offline-catalogue-table td{box-sizing:border-box;padding-left:12px;padding-right:12px}
    .offline-catalogue-table th{white-space:nowrap}
    .offline-catalogue-table th:first-child,.offline-catalogue-table td:first-child{width:42%}
    .offline-catalogue-table th:nth-child(2),.offline-catalogue-table td:nth-child(2){width:9%}
    .offline-catalogue-table th:nth-child(3),.offline-catalogue-table td:nth-child(3){width:19%}
    .offline-catalogue-table th:nth-child(4),.offline-catalogue-table td:nth-child(4){width:22%;white-space:normal;overflow-wrap:anywhere}
    .offline-catalogue-table th:nth-child(5),.offline-catalogue-table td:nth-child(5){width:8%}
    .offline-catalogue-file-name{white-space:normal!important;overflow-wrap:anywhere;word-break:normal;line-height:1.35}
    .offline-catalogue-matched{background:rgba(46,160,67,.20)}
    .offline-catalogue-matched:hover{background:rgba(46,160,67,.28)}
    .download-source-url{min-width:380px}.download-source-url input{width:100%;min-width:320px;box-sizing:border-box}.download-source-table select{max-width:110px}
    .mbtiles-map-table{min-width:850px;table-layout:fixed}.mbtiles-updates-column{width:58px;text-align:center!important}.mbtiles-update-symbol{display:inline-block;min-width:20px;font-size:19px;font-weight:900;line-height:1.2;color:var(--color-content-default-medium,#999)}.mbtiles-update-symbol.update-available{color:#4da3ff}.mbtiles-update-symbol.update-current{color:#55c878}.mbtiles-update-symbol.update-no-match{color:#ff6b6b}.mbtiles-update-symbol.update-unknown{color:#e5b85c}
    .memory-process-table{width:100%;table-layout:fixed;border-collapse:collapse;font-size:11px;font-variant-numeric:tabular-nums}
    .memory-process-table th,.memory-process-table td{box-sizing:border-box;padding:5px 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .memory-process-table th:first-child,.memory-process-table td:first-child{text-align:left}
    .memory-process-table th:not(:first-child),.memory-process-table td:not(:first-child){text-align:right}
    .mbtiles-map-table th,.mbtiles-map-table td{padding:5px 8px;border-bottom:1px solid var(--color-content-default-low,#454545);text-align:left;vertical-align:middle}
    .mbtiles-map-table th{position:sticky;top:0;z-index:1;font-weight:600;color:var(--color-content-default-medium,#aaa);background:var(--color-surface-default-medium,#343943)}
    .mbtiles-map-table .mbtiles-enabled-column{width:42px;text-align:center}
    .mbtiles-enabled-column input{margin:0;accent-color:#8ab4f8;vertical-align:middle}
    .mbtiles-enabled-column input.obf-preset-locked{appearance:none;width:14px;height:14px;box-sizing:border-box;border:1px solid #777;border-radius:2px;background:#858585;opacity:.9;cursor:not-allowed}
    .mbtiles-enabled-column input.obf-preset-locked:checked::after{content:"";display:block;width:6px;height:3px;margin:3px 0 0 3px;border:solid #f2f2f2;border-width:0 0 2px 2px;transform:rotate(-45deg)}
    .mbtiles-map-table th:nth-child(4),.mbtiles-map-table td:nth-child(4){width:360px}.mbtiles-map-table th:nth-child(5),.mbtiles-map-table td:nth-child(5){width:92px}.mbtiles-map-table th:nth-child(6),.mbtiles-map-table td:nth-child(6){width:132px}.mbtiles-map-table th:nth-child(8),.mbtiles-map-table td:nth-child(8){width:150px}
     .mbtiles-map-file{min-width:0;white-space:normal;overflow-wrap:anywhere;line-height:1.4;font-size:13px;background:#e8ebef;color:#000}
    .mbtiles-map-file strong,.mbtiles-map-file span{display:inline;vertical-align:baseline;margin-right:8px;max-width:none;overflow:visible;text-overflow:clip;overflow-wrap:anywhere;color:#000;font-weight:700}
    
    
    .mbtiles-map-file .mbtiles-in-use{color:#8ab4f8;font-weight:600}
    .mbtiles-map-number{white-space:nowrap}
    .mbtiles-map-bounds{max-width:210px;overflow:hidden;text-overflow:ellipsis}
    .obf-map-row{background:rgba(56,139,253,.10)}.mbtiles-map-row{background:rgba(46,160,67,.07)}.offline-map-format-tag{display:inline-block;margin-right:5px;padding:1px 5px;border-radius:3px;font-style:normal;font-size:10px;font-weight:700;letter-spacing:.04em}.obf-format-tag{background:#174b78;color:#c8e5ff}.mbtiles-format-tag{background:#245b35;color:#c9f7d2}.mbtiles-map-disabled{opacity:.48}
    .offline-map-import-error{grid-column:1/-1;color:var(--color-status-danger,#ff7777);font-size:11px;overflow-wrap:anywhere}
    .mbtiles-remove-button{padding:2px 7px;font-size:11px}
    .mbtiles-inuse-column{width:48px;text-align:center;white-space:nowrap}
    .mbtiles-inuse-symbol{display:inline-block;min-width:14px;color:var(--color-content-default-medium,#888);font-size:13px;line-height:1}
    .mbtiles-inuse-symbol.in-use{color:#39b86a}
    .view-settings-content{display:flex;flex-direction:column;align-items:flex-start;gap:8px;min-width:0}
    .opacity-settings{display:flex;flex-direction:column;align-items:stretch;gap:7px;min-width:0;padding:5px 0;width:100%}
    .opacity-settings>summary{display:flex;align-items:center;gap:12px;cursor:pointer;font-weight:700;white-space:nowrap;list-style:disclosure-closed}
    .opacity-settings[open]>summary{margin-bottom:2px}
    .opacity-summary-controls{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex:1 1 auto;min-width:0}
    .opacity-summary-controls>.range-setting{display:flex;align-items:center;gap:3px;flex:0 1 190px;min-width:135px;max-width:210px;box-sizing:border-box}
    .opacity-summary-controls .visibility-toggle{display:inline-flex;align-items:center;gap:0;flex:0 0 auto;white-space:nowrap;font-weight:400;min-width:0}
    .opacity-summary-controls .visibility-toggle input{width:13px;height:13px;flex:0 0 13px;margin:0!important;padding:0}
    .opacity-summary-controls>.range-setting>input.opacity-slider[type="range"]{flex:1 1 auto;width:auto;max-width:none;min-width:30px}
    .opacity-summary-controls .range-value{min-width:34px;text-align:right;font-variant-numeric:tabular-nums}
    .opacity-content{display:flex;align-items:stretch;flex-wrap:nowrap;width:100%;gap:6px;min-width:0;overflow-x:auto;padding:3px 1px 5px;box-sizing:border-box}
    .opacity-content .range-setting{display:flex;align-items:center;gap:5px;flex:1 1 0;min-width:0;max-width:none;box-sizing:border-box;padding:6px 8px;border:1px solid var(--color-border-subtle,rgba(128,128,128,.22));border-radius:8px;background:var(--color-surface-secondary,rgba(128,128,128,.085));box-shadow:inset 0 1px 0 rgba(255,255,255,.035)}
    .opacity-content .range-setting:has(.visibility-toggle){gap:4px}
    .opacity-content .range-setting:has(.visibility-toggle)::before{content:none}
    .opacity-content .visibility-toggle{display:inline-flex;align-items:center;gap:0;white-space:nowrap}
    .opacity-content .visibility-toggle input[type="checkbox"]{width:13px;height:13px;flex:0 0 13px;margin:0!important;padding:0}
    
    .opacity-content .range-setting.setting-unavailable{opacity:.58}
    .opacity-content .range-setting input:disabled{cursor:not-allowed;accent-color:#777}
    .opacity-content .range-setting button:disabled{cursor:not-allowed;opacity:.55}
    .opacity-content .view-map-color{display:flex;align-items:center;gap:7px;white-space:nowrap}
    .opacity-content .atlas-density-setting{grid-column:1/-1}
    .opacity-content .atlas-density-setting input[type="range"]{flex:1;min-width:100px}
    .opacity-content .range-setting>input[type="range"]{flex:1;width:auto;min-width:45px}
    .opacity-content .range-setting>input.opacity-slider[type="range"]{flex:1 1 24px;width:24px;max-width:none;min-width:24px;margin:0 1px;accent-color:#c084fc}
    .opacity-content .range-setting>input.opacity-slider[type="range"]:disabled{accent-color:#8b739d}
    .opacity-content .range-setting .visibility-toggle{display:inline-flex;align-items:center;gap:3px;flex:0 0 auto;white-space:nowrap;font-weight:500;min-width:0}
    .opacity-content .range-setting .visibility-toggle input{margin-left:1px!important}
    .opacity-content .overlay-opacity-setting{order:90;flex:0 1 125px}
    .opacity-content .range-setting:has(#map-label-opacity){order:80}
    .opacity-content .visibility-toggle input{margin:0!important;accent-color:#c084fc}
    .opacity-content .visibility-toggle input:disabled{accent-color:#8b739d}

    .settings-group:last-child{border-right:0;padding-right:0}.map-style-settings{flex:0 0 100%;width:100%;border-right:0}.offline-map-status{max-width:340px;overflow-wrap:anywhere;color:var(--color-content-default-medium,#aaa);font-size:11px}.settings-group>label{display:flex;align-items:center;gap:6px;white-space:nowrap}
    .location-settings{flex:0 0 100%;width:100%;border-right:0;border-bottom:1px solid var(--color-content-default-low,#454545);padding:0 0 7px;gap:8px}.location-settings>summary{cursor:pointer;font-weight:700;white-space:nowrap}.location-settings[open]>summary{margin-bottom:2px}.location-settings-content{display:flex;flex:1 1 100%;flex-wrap:wrap;align-items:center;gap:8px 16px;min-width:0}.location-coordinate-display{display:flex;flex:1 1 100%;align-items:baseline;gap:8px;min-width:0}.location-coordinate-display span{min-width:0;overflow-wrap:anywhere}.location-tab .address-settings{flex:1 1 100%;width:100%;padding:0;border:0}.location-actions{display:flex;align-items:center;flex-wrap:wrap;gap:6px;flex:1 1 100%}.location-actions>label{display:flex;align-items:center;gap:6px;white-space:nowrap}
    select{max-width:170px}.range-setting{min-width:150px}.range-setting input{width:100px;accent-color:#8ab4f8}.range-setting span{color:var(--color-content-default-medium,#aaa);min-width:34px;text-align:right}
    .settings-row-title{flex:0 0 auto;white-space:nowrap}.location-address{min-width:0;overflow-wrap:anywhere}.location-address-error{color:#ff8a80}
    .zoom-settings{flex:1;min-width:260px}
    .marker-appearance-settings{display:flex;align-items:flex-start;flex-direction:column;gap:10px;flex-wrap:wrap;margin-top:8px;padding-top:0;border-top:0;flex:0 0 100%;width:100%}
    .marker-appearance-settings>label{display:flex;align-items:center;gap:6px;white-space:nowrap}
    .location-tab .marker-current-appearance-settings{display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:1 1 100%;min-width:0}.location-tab .marker-current-appearance-settings>label{display:flex;align-items:center;gap:6px;white-space:nowrap}
    .always-on-top-setting input{accent-color:#8ab4f8}
    .zoom-buttons{display:flex;gap:4px}.zoom-buttons button{width:28px;height:27px;padding:0;font-size:18px}
    .marker-settings{flex:0 0 100%;width:100%;border-right:0;border-top:1px solid var(--color-content-default-low,#454545);border-bottom:0;padding:7px 0 0;gap:8px}
    .marker-settings summary{display:flex;flex-direction:column;align-items:flex-start;gap:2px;cursor:pointer;font-weight:700;font-size:13px;line-height:1.4;white-space:normal;text-align:left}
    .location-settings>summary,.map-source-settings>summary,.opacity-settings>summary,.gpx-settings>summary{font-size:13px;font-weight:700;line-height:1.4}
    .marker-settings summary .marker-description{display:block;margin:0;color:var(--color-content-default-medium,#aaa);font-size:12px;font-weight:400;text-align:left}
    .marker-settings-content{display:flex;flex:0 0 auto;flex-direction:column;align-items:flex-start;gap:8px;width:100%;min-width:0;text-align:left}
    .marker-setting-row{display:flex;align-items:center;justify-content:flex-start;gap:12px;width:100%;min-width:0;text-align:left}
    .marker-appearance-settings{display:flex;flex-direction:row;align-items:center;justify-content:flex-start;flex-wrap:wrap;gap:8px 22px;width:100%;min-width:0}
     .marker-appearance-settings>.marker-setting-row{display:flex;flex:0 0 auto;align-items:center;gap:8px;width:auto;min-width:0}
     .marker-appearance-settings>.marker-setting-row>label{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
     .marker-appearance-settings .color-picker-trigger{min-width:132px}
    .marker-summary-section{display:flex;flex-direction:column;align-items:stretch;gap:7px;width:100%;min-width:0;padding:7px 0 0;border-top:1px solid var(--color-content-default-low,#454545)}
    .marker-summary-section>summary{display:flex;align-items:center;gap:12px;cursor:pointer;font-weight:700;white-space:nowrap;list-style:disclosure-closed}
    .marker-summary-section[open]>summary{margin-bottom:2px}
    .marker-summary-content{display:flex;flex-direction:column;align-items:stretch;gap:5px;min-width:0}
    .marker-progress-row,.marker-statistics,.marker-status{align-self:flex-start;text-align:left}
    .marker-progress-text,.marker-statistics,.marker-status{color:var(--color-content-default-medium,#aaa);font-size:12px;font-variant-numeric:tabular-nums}
    .marker-progress-row{display:flex;flex:0 0 auto;align-items:center;gap:10px;width:100%;min-width:0}
    .marker-progress{flex:1 1 auto;width:auto;height:6px;accent-color:#8ab4f8}.marker-statistics{display:flex;flex-wrap:wrap;gap:14px}
    .location-address{min-width:0;overflow-wrap:anywhere;color:var(--color-content-default-medium,#aaa)}
    .gpx-settings{flex:0 0 100%;width:100%;border-right:0;border-top:1px solid var(--color-content-default-low,#454545);border-bottom:0;padding:7px 0 0;gap:8px}
    .gpx-filename{max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--color-content-default-medium,#aaa)}.gpx-error{color:#ff8a80}
    .color-picker{position:relative}.color-picker-trigger{display:flex;align-items:center;gap:7px;min-width:132px}.color-picker-chevron{margin-left:auto}
    .color-picker-menu{position:absolute;z-index:1000;top:calc(100% + 4px);left:0;min-width:185px;padding:4px;background:var(--color-surface-default-high,#383a3f);border:1px solid var(--color-content-default-low,#555);border-radius:5px;box-shadow:0 5px 18px #0005}
    .color-option{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:0;background:transparent}.color-option[aria-selected=true]{outline:1px solid #8ab4f8}
    .color-swatch{display:inline-flex;align-items:center;justify-content:center;min-width:78px;padding:3px 6px;border-radius:3px;font:11px/1.3 ui-monospace,monospace;font-weight:600}
    .color-swatch-off{background:var(--color-surface-default-medium,#555);color:var(--color-content-default-high,#fff)}
    .map-content{position:relative;display:flex;flex:1 1 auto;flex-direction:column;width:100%;min-width:0;min-height:0;overflow:hidden}
    .offline-map-list-view{display:flex;flex:1 1 auto;flex-direction:column;min-width:0;min-height:0;width:100%;overflow:auto;overscroll-behavior:contain;background:var(--color-surface-default-low,#202124)}
    .offline-map-list-view .mbtiles-map-list{flex:1 1 auto;max-height:none;overflow:auto}
    .map{position:relative;z-index:0;overflow:visible;flex:1 1 auto;width:100%;min-height:0;background:transparent;transition:opacity .12s ease}
    .render-init-notice{position:absolute;z-index:1050;top:50%;left:50%;transform:translate(-50%,-50%);display:flex;align-items:center;gap:10px;padding:10px 15px;border:1px solid rgba(255,255,255,.3);border-radius:6px;background:rgba(20,27,34,.92);color:#fff;font-size:13px;font-weight:600;box-shadow:0 3px 14px #0008;pointer-events:none;white-space:nowrap}
    .render-init-spinner{width:14px;height:14px;flex:0 0 14px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:render-init-spin .8s linear infinite}
    @keyframes render-init-spin{to{transform:rotate(360deg)}}
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
    .opacity-settings .range-setting{display:flex;align-items:center;gap:7px;flex:1;min-width:125px}
    .opacity-settings .range-setting input{flex:1;width:auto;min-width:45px}
    .opacity-settings .range-value{flex:0 0 38px;min-width:38px;text-align:right;color:var(--color-content-default-medium,#aaa);font-variant-numeric:tabular-nums}
    .opacity-settings .range-setting>input.opacity-slider + .range-value{margin-left:-4px}
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
    :host-context(html[data-theme='light']) .settings-tabs .settings-tab.active{background:#31577d;border-color:#65a9ff;color:#fff}
    :host-context(html[data-theme='light']) .map-coordinates,:host-context(html[data-theme='light']) .range-setting span,:host-context(html[data-theme='light']) .gpx-filename{color:#555}
    :host-context(html[data-theme='light']) .map-toolbar-button{color:#202124;background:#fff;border-color:#c5c8ce}
    @media(max-width:650px){.map-coordinates{display:none}.map-settings{align-items:flex-start}.settings-group{width:100%;border-right:0;border-bottom:1px solid var(--color-content-default-low,#454545);padding:0 0 7px}.settings-group:last-child{border-bottom:0}.range-setting{flex:1}.range-setting input{flex:1}.opacity-content{flex-wrap:wrap}.opacity-content .range-setting{flex:1 1 135px}}
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
  private currentOfflineMapId: string | null = null;
  private markerScanGeneration = 0;
  private leaflet: LeafletMapApi | null = null;
  private readonly desktop = (window as unknown as { desktop?: Desktop }).desktop;
  private unsubscribeLocation: (() => void) | null = null;
  private locationUpdateVersion = 0;
  private locationLookupVersion = 0;
  private mapInitialization: Promise<void> | null = null;
  private mapSourceGeneration = 0;
  private osmAndStyleChangeGeneration = 0;
  private osmAndStyleRestore: Promise<void> = Promise.resolve();
  private tileLayer: { remove(): void } | null = null;
  private trackLayers: Array<{ remove(): void }> = [];
  private gpxSegments: [number, number][][] = [];
  private readonly storagePrefix = 'mapWindow.';
  protected readonly selectSettingsTab = (tab: 'location' | 'track' | 'marker' | 'view' | 'offlineMaps' | 'hillshade' | 'cache' | 'memory' | 'download' | 'errors'): void => {
    this.activeSettingsTab.set(tab);
    this.persistLocationUiState({ activeSettingsTab: tab });
    if (tab === 'memory') void this.refreshProcessMemory();
  };
  protected readonly settingsOpen = signal(false);
  protected readonly activeSettingsTab = signal<'location' | 'track' | 'marker' | 'view' | 'offlineMaps' | 'hillshade' | 'cache' | 'memory' | 'download' | 'errors'>('location');
  protected readonly renderVisualsEnabled = signal(this.readSetting('renderVisualsEnabled', 'true') === 'true');
  protected readonly renderActiveCount = signal(0);
  protected readonly renderTotalCount = signal(0);
  protected readonly renderProgressValue = computed(() => this.rerenderVisibleTilesBusy()
    ? this.rerenderVisibleTilesProgress().completed
    : Math.max(0, this.renderTotalCount() - this.renderActiveCount()));
  protected readonly renderProgressMaximum = computed(() => this.rerenderVisibleTilesBusy()
    ? Math.max(1, this.rerenderVisibleTilesProgress().total)
    : Math.max(1, this.renderTotalCount()));
  protected readonly opacitySectionOpen = signal(this.readSetting('opacitySectionOpen', 'true') === 'true');
  protected readonly renderSectionOpen = signal(this.readSetting('renderSectionOpen', 'false') === 'true');
  private readonly activeRenderTiles = new Set<string>();
  private readonly seenRenderTiles = new Set<string>();
  private readonly persistLocationUiState = (patch: Record<string, unknown>): void => {
    void this.desktop?.ProcessManager.setAppSettingsSection('mapWindow', patch)
      .catch(error => console.warn('[Location] Could not persist window UI state:', error));
  };
  protected readonly changeRenderVisualsEnabled = (enabled: boolean): void => {
    this.renderVisualsEnabled.set(enabled);
    this.saveSetting('renderVisualsEnabled', enabled);
    window.dispatchEvent(new CustomEvent('lumascope-osmand-tile-visuals', { detail: { enabled } }));
    this.persistLocationUiState({ renderVisualsEnabled: enabled });
  };
  protected readonly onLocationDetailsToggle = (event: Event): void => {
    const section = event.currentTarget;
    if (!(section instanceof HTMLDetailsElement)) return;
    const isOpacity = section.classList.contains('opacity-settings');
    const isRender = section.classList.contains('view-rerender-section');
    if (isOpacity) this.opacitySectionOpen.set(section.open);
    if (isRender) this.renderSectionOpen.set(section.open);
    if (isOpacity) this.persistLocationUiState({ opacitySectionOpen: section.open });
    if (isRender) this.persistLocationUiState({ renderSectionOpen: section.open });
  };
  protected readonly renderInitStatus = signal('');
  private readonly onOsmAndTileStatus = (event: Event): void => {
    const detail = (event as CustomEvent<{ protocol?: string; status?: string; error?: string; zoom?: number; column?: number; row?: number }>).detail;
    const expectedProtocol = this.mapSource() === 'osmand-atlas' ? 'osmand-atlas' : this.mapSource() === 'osmand' ? 'osmand' : null;
    if (detail?.status === 'diagnostic' && detail.protocol === 'osmand-atlas' && detail.error) {
      this.recordMapError('OsmAnd Atlas helper', detail.error);
      return;
    }
    if (!detail || (detail.protocol !== 'osmand' && detail.protocol !== 'osmand-atlas')) return;
    const key = `${detail.protocol}/${detail.zoom}/${detail.column}/${detail.row}`;
    if (detail.status === 'loading' || detail.status === 'rerendering') {
      this.activeRenderTiles.add(key);
      if (!this.seenRenderTiles.has(key)) {
        this.seenRenderTiles.add(key);
        this.renderTotalCount.update(total => total + 1);
      }
    } else if (detail.status === 'loaded' || detail.status === 'cache-loading' || detail.status === 'cancelled' || detail.status === 'warning' || detail.status === 'error') {
      this.activeRenderTiles.delete(key);
    }
    this.renderActiveCount.set(this.activeRenderTiles.size);
    if (!expectedProtocol || detail.protocol !== expectedProtocol || !this.renderInitStatus()) return;
    if (detail.status === 'loading') this.renderInitStatus.set('Loading first tile …');
    else if (detail.status === 'loaded' || detail.status === 'warning' || detail.status === 'error' || detail.status === 'cache-loading') this.renderInitStatus.set('');
  };
  protected readonly colorMenuOpen = signal(false);
  protected readonly mapSourceMenuOpen = signal(false);
  protected readonly selectedMapSourceType = computed(() => ({
    online: 'Online map',
    offline: 'MBTiles',
    osmand: 'OsmAnd (no labels)',
    'osmand-atlas': 'OsmAnd Atlas'
  })[this.mapSource()]);
  protected readonly selectMapSource = (source: 'online' | 'offline' | 'osmand' | 'osmand-atlas'): void => {
    this.mapSourceMenuOpen.set(false);
    this.changeMapSource(source);
  };
  protected readonly alwaysOnTop = signal(this.readSetting('alwaysOnTop', 'false') === 'true');
  protected readonly mapStyle = signal<MapStyle>(this.readSetting('style', 'standard') as MapStyle);
  protected readonly mapSource = signal<'online' | 'offline' | 'osmand' | 'osmand-atlas'>(this.readSetting('source', 'online') === 'offline' ? 'offline' : this.readSetting('source', 'online') === 'osmand' ? 'osmand' : this.readSetting('source', 'online') === 'osmand-atlas' ? 'osmand-atlas' : 'online');
  protected readonly offlineMapStyle = signal<OfflineMapStyle>(this.readSetting('offlineStyle', 'lumascope') as OfflineMapStyle);
  protected readonly osmAndStyle = signal('default.render.xml');
  protected readonly osmAndStyles = signal<import('internal-api').OsmAndRenderingStyle[]>([]);
  protected readonly offlineMapStatus = signal<import('internal-api').OfflineMapStatus | null>(null);
  protected readonly offlineMaps = signal<import('internal-api').OfflineMapStatus[]>([]);
  protected readonly offlineMapListFilter = signal<'all' | 'inUse' | 'active' | 'updates' | 'current' | 'noMatch'>('all');
  protected readonly offlineMapUpdateCheckBusy = signal(false);
  protected readonly offlineMapUpdateCheckStatus = signal('');
  protected readonly offlineMapCatalogueFiles = signal<import('internal-api').OfflineMapCatalogueFile[]>([]);
  protected readonly offlineMapCatalogueSummary = signal('No catalogue has been checked yet.');
  protected readonly activeOfflineMapCount = computed(() => this.offlineMaps().filter(map => map.enabled).length);
  protected readonly inUseOfflineMapCount = computed(() => this.offlineMaps().filter(map => this.isOfflineMapInUse(map)).length);
  protected readonly filteredOfflineMaps = computed(() => {
    const maps = this.offlineMaps();
    const filter = this.offlineMapListFilter();
    if (filter === 'inUse') return maps.filter(map => this.isOfflineMapInUse(map));
    if (filter === 'active') return maps.filter(map => map.enabled);
    if (filter === 'updates') return maps.filter(map => map.updateAvailable === true);
    if (filter === 'current') return maps.filter(map => map.updateChecked && map.updateAvailable === false);
    if (filter === 'noMatch') return maps.filter(map => map.updateChecked && map.updateMatched === false);
    return maps;
  });
  protected readonly offlineMapPreset = signal<'austria' | 'europe' | 'all' | 'custom' | 'custom-no-world-map'>(
    (['austria', 'europe', 'all', 'custom', 'custom-no-world-map'] as const).includes(this.readSetting('offlineMapPreset', 'custom') as 'austria' | 'europe' | 'all' | 'custom' | 'custom-no-world-map')
      ? this.readSetting('offlineMapPreset', 'custom') as 'austria' | 'europe' | 'all' | 'custom' | 'custom-no-world-map'
      : 'austria'
  );
  protected readonly osmAndTileCache = signal({ path: '%LOCALAPPDATA%\\LumaScope\\cache\\maps\\obf', entries: 0, bytes: 0, available: false });
  protected readonly rerenderVisibleTilesBusy = signal(false);
  protected readonly rerenderVisibleTilesStatus = signal('');
  protected readonly rerenderVisibleTilesProgress = signal({ completed: 0, total: 0 });
  protected readonly processMemory = signal<import('internal-api').ProcessMemorySnapshot>({ processes: [], error: null });
  protected readonly memoryUpdatedAt = signal('');
  protected readonly totalProcessMemoryBytes = computed(() => this.processMemory().processes.reduce((sum, entry) => sum + entry.workingSetBytes, 0));
  private memoryRefreshTimer: ReturnType<typeof setInterval> | null = null;
  protected readonly offlineMapImportErrors = signal<string[]>([]);
  protected readonly mapErrors = signal<MapErrorEntry[]>([]);
  private mapErrorSequence = 0;
  protected readonly clearMapErrors = (): void => this.mapErrors.set([]);
  protected readonly activeOfflineMapId = signal<string | null>(null);
  protected readonly downloadSources = signal<Array<{ url: string; fileType: 'obf' | 'mbtiles'; useForUpdates: boolean }>>([
    { url: 'https://download.geofabrik.de/europe/austria.html', fileType: 'mbtiles', useForUpdates: true },
    { url: 'https://www.limaps.org/tileserver.html', fileType: 'mbtiles', useForUpdates: true },
    { url: 'https://shortbread-tiles.org/download/', fileType: 'mbtiles', useForUpdates: true },
    { url: 'https://download.osmand.net/list.php', fileType: 'obf', useForUpdates: true },
    { url: 'https://github.com/osmandapp/OsmAnd-resources', fileType: 'obf', useForUpdates: false }
  ]);
  protected readonly osmAndResourcesPath = signal('');
  protected readonly osmAndResourcesError = signal('');
  protected readonly mapDisplayNotice = signal('');
  protected readonly openResourcesDownloadTab = (): void => { this.settingsOpen.set(true); this.selectSettingsTab('download'); };
  protected readonly offlineMapStatusText = computed(() => {
    const status = this.offlineMapStatus();
    if (!status) return 'Checking offline map…';
    if (status.error) return status.error;
    return status.available ? (status.name ?? 'Offline map ready') + ' · zoom ' + status.minZoom + '–' + status.maxZoom : 'No MBTiles selected';
  });
  protected readonly mapColor = signal<MapColor>(this.readSetting('color', 'original') as MapColor);
  protected readonly mapOpacity = signal(this.readNumber('opacity', 100, 0, 100));
  protected readonly labelOpacity = signal(this.readNumber('labelOpacity', 100, 0, 100));
  protected readonly labelsVisible = signal(this.readSetting('labelsVisible', 'true') === 'true');
  protected readonly atlasDisplayDensityFactor = signal(this.readNumber('atlasDisplayDensityFactor', window.devicePixelRatio || 1, 1, 3));
  protected readonly overlayOpacity = signal(this.readNumber('overlayOpacity', 100, 0, 100));
  protected readonly mapVisible = signal(this.readSetting('mapVisible', 'true') === 'true');
  protected readonly hillshadeVisible = signal(this.readSetting('hillshadeVisible', 'false') === 'true');
  protected readonly hillshadeOpacity = signal(this.readNumber('hillshadeOpacity', 65, 0, 100));
  protected readonly hillshadeDatabases = signal<OsmAndHillshadeDatabase[]>([]);
  protected readonly hillshadeDatabaseCount = computed(() => this.hillshadeDatabases().length);
  protected readonly activeHillshadeDatabaseCount = computed(() => this.hillshadeDatabases().filter(item => item.enabled && item.available).length);
  protected readonly zoomLevel = signal(this.readNumber('zoom', 13, 1, 20));
  private readonly mapZoomRestore: Promise<void> = this.desktop?.MapWindow.getZoom().then(zoom => {
    if (Number.isFinite(zoom)) this.zoomLevel.set(this.validZoom(zoom));
  }).catch(error => console.error('Could not restore map zoom:', error)) ?? Promise.resolve();
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
  protected readonly directoryMarkersEnabled = signal(this.readSetting('directoryMarkersEnabled', 'false') === 'true');
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
    if (target instanceof Element && target.closest('.map-source-picker')) return;
    this.colorMenuOpen.set(false);
    this.markerColorMenuOpen.set(false);
    this.currentMarkerColorMenuOpen.set(false);
    this.mapSourceMenuOpen.set(false);
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    if (this.mapSourceMenuOpen()) {
      event.preventDefault();
      this.mapSourceMenuOpen.set(false);
    }
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
    void this.desktop?.ProcessManager.getAppSettings().then(settings => {
      const saved = settings['mapWindow'] as Record<string, unknown> | undefined;
      if (!saved) return;
      if (typeof saved['settingsOpen'] === 'boolean') this.settingsOpen.set(saved['settingsOpen']);
      if (typeof saved['activeSettingsTab'] === 'string' && ['location','track','marker','view','offlineMaps','hillshade','cache','memory','download','errors'].includes(saved['activeSettingsTab'])) this.activeSettingsTab.set(saved['activeSettingsTab'] as 'location' | 'track' | 'marker' | 'view' | 'offlineMaps' | 'hillshade' | 'cache' | 'memory' | 'download' | 'errors');
      if (typeof saved['renderVisualsEnabled'] === 'boolean') {
        this.renderVisualsEnabled.set(saved['renderVisualsEnabled']);
        window.dispatchEvent(new CustomEvent('lumascope-osmand-tile-visuals', { detail: { enabled: saved['renderVisualsEnabled'] } }));
      }
      if (typeof saved['opacitySectionOpen'] === 'boolean') this.opacitySectionOpen.set(saved['opacitySectionOpen']);
      if (typeof saved['renderSectionOpen'] === 'boolean') this.renderSectionOpen.set(saved['renderSectionOpen']);
      if (typeof saved['markerSectionOpen'] === 'boolean') this.markerSectionOpen.set(saved['markerSectionOpen']);
    }).catch(error => console.warn('[Location] Could not restore window UI state:', error));
    window.addEventListener('lumascope-osmand-tile-status', this.onOsmAndTileStatus);
    if (this.desktop) {
      registerOsmAndHillshadeTileProtocol(this.desktop, () => this.hillshadeDatabases());
      void this.desktop.OsmAndAtlas.getHillshadeDatabases().then(databases => {
        this.hillshadeDatabases.set(databases);
        if (this.offlineRenderer) this.applyHillshadeSettings(this.offlineRenderer);
      }).catch(error => this.recordMapError('Hillshade databases', error instanceof Error ? error.message : String(error)));
    }
    document.documentElement.style.backgroundColor = 'transparent';
    document.body.style.backgroundColor = 'transparent';
    document.documentElement.style.colorScheme = this.themeService.current();
    this.applyAlwaysOnTop();
    this.currentImagePath = this.route.snapshot.queryParamMap.get('imagePath');
    void this.refreshOsmAndTileCache();
    this.memoryRefreshTimer = setInterval(() => {
      if (this.activeSettingsTab() === 'memory') void this.refreshProcessMemory();
    }, 2000);
    if (this.desktop) {
      this.osmAndStyleRestore = (async () => {
        try {
          // The native managers already read the shared osmand settings.
          // Restore only the UI display from that same config section; never
          // let a stale mapWindow/localStorage copy overwrite the resources path.
          const settings = await this.desktop!.ProcessManager.getAppSettings();
          const osmand = settings['osmand'] as Record<string, unknown> | undefined;
          const resourcesPath = typeof osmand?.['resourcesPath'] === 'string'
            ? osmand['resourcesPath'] : '';
          this.osmAndResourcesPath.set(resourcesPath);

          // config.json is the single source of truth for the shared style.
          // The dropdown is initialized directly from osmand.renderingStyle;
          // runtime status must never override the user's saved selection.
          const styles = await this.desktop!.OsmAndAtlas.getRenderingStyles();
          const configuredStyle = typeof osmand?.['renderingStyle'] === 'string'
            ? osmand['renderingStyle'] as string : 'default.render.xml';
          const selectedStyle = styles.find(style => style.fileName === configuredStyle)
            ?? styles.find(style => style.fileName === 'default.render.xml')
            ?? styles[0];
          console.info('[OsmAnd Atlas][style-trace] UI restore', {
            configStyle: configuredStyle,
            availableStyles: styles.map(style => style.fileName),
            selectedStyle: selectedStyle?.fileName ?? null
          });
          this.osmAndStyles.set(styles.map(style => ({
            ...style, selected: !!selectedStyle && style.fileName === selectedStyle.fileName
          })));
          if (selectedStyle) {
            this.osmAndStyle.set(selectedStyle.fileName);
            await Promise.all([
              this.desktop!.OsmAndAtlas.setRenderingStyle(selectedStyle.fileName),
              this.desktop!.OsmAnd.setRenderingStyle(selectedStyle.fileName)
            ]);
          }
          this.osmAndResourcesError.set('');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.osmAndResourcesError.set(message);
          this.recordMapError('OsmAnd resources folder', message);
          console.error('Could not restore shared OsmAnd resources/style settings:', error);
        }
      })();
    }
    void this.desktop?.ProcessManager.getAppSettings().then(settings => {
      const offline = settings['offlineMaps'] as Record<string, unknown> | undefined;
      const saved = offline?.['updateSources'];
      if (Array.isArray(saved)) {
        const valid = saved.filter((entry): entry is { url: string; fileType: 'obf' | 'mbtiles'; useForUpdates: boolean } =>
          !!entry && typeof entry === 'object'
          && typeof (entry as { url?: unknown }).url === 'string'
          && ((entry as { fileType?: unknown }).fileType === 'obf' || (entry as { fileType?: unknown }).fileType === 'mbtiles')
          && typeof (entry as { useForUpdates?: unknown }).useForUpdates === 'boolean'
        );
        this.downloadSources.set(valid);
      }
    }).catch(error => console.error('Could not load download source settings:', error));
    void this.desktop?.ProcessManager.setAppSettingsSection('offlineMaps', { obfPreset: this.offlineMapPreset() }).catch(error => console.error('Could not persist OBF preset:', error));
    void this.desktop?.OfflineMap.getMaps().then(maps => {
      this.offlineMaps.set(maps);
      // An offline source without any compatible loaded MBTiles cannot be used.
      // Restore the online source instead of leaving the selector on an empty map.
      if (!maps.some(map => map.enabled && map.type !== 'obf') && this.mapSource() === 'offline') this.changeMapSource('online');
    }).catch(error => console.error('Could not read offline map list:', error));
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
        this.currentOfflineMapId = null;
        this.activeOfflineMapId.set(null);
        this.marker = null;
        this.clearDirectoryMarkers();
        return;
      }
      this.coordinatesAvailable.set(true);
      this.coordinateLabel.set(this.formatCoordinates(nextLatitude!, nextLongitude!));
      void this.lookupLocationAddress(nextLatitude!, nextLongitude!);
      this.bearing.set(typeof location.bearing === 'number' && Number.isFinite(location.bearing) ? location.bearing : null);
      if (this.mapSource() === 'offline' || this.mapSource() === 'osmand' || this.mapSource() === 'osmand-atlas') {
        // Re-evaluate the geographic coverage for every selected photo. This
        // also handles transitions between offline maps and the online fallback.
        void this.initialize(nextLatitude!, nextLongitude!);
      } else if (this.offlineRenderer) {
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
    if (this.memoryRefreshTimer) clearInterval(this.memoryRefreshTimer);
    this.memoryRefreshTimer = null;
    window.removeEventListener('lumascope-osmand-tile-status', this.onOsmAndTileStatus);
    this.renderInitStatus.set('');
    // Save the live camera value before destroying either map implementation.
    // This also covers closing the separate Location window or the overlay
    // while a zoom animation is still in progress.
    this.persistZoom(this.offlineRenderer?.map.getZoom() ?? this.map?.getZoom() ?? this.zoomLevel());
    this.persistLocationUiState({
      settingsOpen: this.settingsOpen(),
      activeSettingsTab: this.activeSettingsTab(),
      renderVisualsEnabled: this.renderVisualsEnabled(),
      opacitySectionOpen: this.opacitySectionOpen(),
      renderSectionOpen: this.renderSectionOpen(),
      markerSectionOpen: this.markerSectionOpen()
    });
    this.mapSourceGeneration++;
    this.mapInitialization = null;
    this.unsubscribeLocation?.();
    this.markerScanGeneration++;
    this.clearDirectoryMarkers();
    window.removeEventListener('resize', this.onResize);
    this.map?.remove();
    this.map = null;
    this.offlineRenderer?.remove(); this.offlineRenderer = null;
    // Native OsmAnd render helpers are persistent main-process workers. Stop them
    // when their map window goes away so they cannot keep GPU contexts alive.
    if (this.mapSource() === 'osmand-atlas') void this.desktop?.OsmAndAtlas.shutdown().catch(error => console.warn('Could not stop OsmAnd Atlas helpers:', error));
    if (this.mapSource() === 'osmand') void this.desktop?.OsmAnd.shutdown().catch(error => console.warn('Could not stop OsmAnd helpers:', error));
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

  private recordMapError(source: string, message: string): void {
    // MapLibre aborts obsolete tile requests during zoom/source changes. These
    // are expected lifecycle cancellations, not renderer failures.
    if (/\b(cancelled|canceled)\b/i.test(message)) return;
    const mapSource = this.mapSource();
    const renderer = ({
      online: 'Online map renderer',
      offline: 'MBTiles renderer',
      osmand: 'OsmAnd renderer',
      'osmand-atlas': 'OsmAnd Atlas renderer'
    } as const)[mapSource] ?? 'Unknown';
    const style = mapSource === 'osmand' || mapSource === 'osmand-atlas'
      ? this.osmAndStyle()
      : mapSource === 'offline'
        ? this.offlineMapStyle()
        : mapSource === 'online'
          ? this.mapStyle()
          : 'Unknown';
    const now = Date.now();
    const timestamp = new Date(now).toLocaleString();
    this.mapErrors.update(errors => {
      const latest = errors[0];
      if (latest && latest.source === source && latest.renderer === renderer
        && latest.style === style && latest.message === message && now - latest.lastSeenAt < 5000) {
        return [{ ...latest, timestamp, occurrences: latest.occurrences + 1, lastSeenAt: now }, ...errors.slice(1)];
      }
      return [{ id: ++this.mapErrorSequence, timestamp, source, renderer, style, message, occurrences: 1, lastSeenAt: now }, ...errors].slice(0, 100);
    });
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
    const open = !this.settingsOpen();
    this.settingsOpen.set(open);
    this.persistLocationUiState({ settingsOpen: open });

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
    this.offlineRenderer?.setPhotoClusterStyle(this.markerColor(), this.markerColorVisible(), value as MarkerShape);
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
    this.offlineRenderer?.setPhotoClusterStyle(this.markerColor(), this.markerColorVisible(), this.markerShape());
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
  private persistZoom(value: number): void {
    if (!Number.isFinite(value)) return;
    const zoom = this.validZoom(value);
    this.zoomLevel.set(zoom);
    this.saveSetting('zoom', zoom);
    void this.desktop?.MapWindow.setZoom(zoom).catch(error => console.error('Could not save map zoom:', error));
  }

  protected readonly onMarkerSectionToggle = (event: Event): void => {
    const section = event.currentTarget;
    if (!(section instanceof HTMLDetailsElement)) return;
    this.markerSectionOpen.set(section.open);
    this.saveSetting('markerSectionOpen', section.open);
    this.persistLocationUiState({ markerSectionOpen: section.open });
  };
  protected readonly changeDirectoryMarkersEnabled = (enabled: boolean): void => {
    this.directoryMarkersEnabled.set(enabled);
    this.saveSetting('directoryMarkersEnabled', enabled);
    if (enabled) {
      void this.scanDirectoryMarkers();
      return;
    }
    this.markerScanGeneration++;
    this.clearDirectoryMarkers();
    this.markerFilesChecked.set(0);
    this.markerFilesTotal.set(0);
    this.markerStatus.set('');
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
        this.offlineRenderer.setPhotoClusterStyle(this.markerColor(), this.markerColorVisible(), this.markerShape());
      } else this.renderDirectoryMarkers(markers, imagePath);
      this.markerStatus.set('Loaded ' + records.length + ' database records; ' + markers.length + ' GPS locations found.');
    } catch (error) {
      if (generation === this.markerScanGeneration) this.markerStatus.set(error instanceof Error ? error.message : 'Location database query failed.');
    }
  }
  private async initialize(latitude: number, longitude: number): Promise<void> {
    await this.mapZoomRestore;
    // Do not let the initial map request apply the stale renderer-local
    // default before the shared persisted OsmAnd style has been restored.
    await this.osmAndStyleRestore;
    let generation = this.mapSourceGeneration;
    if (this.mapSource() === 'osmand-atlas') {
      if (this.offlineRenderer) {
        this.offlineRenderer.updateCurrentLocation(latitude, longitude);
        this.offlineRenderer.map.easeTo({ center: [longitude, latitude] });
        return;
      }
      if (this.mapInitialization) await this.mapInitialization;
      if (generation !== this.mapSourceGeneration || this.mapSource() !== 'osmand-atlas' || this.offlineRenderer) return;
      const initialization = this.createOsmAndAtlasMap(latitude, longitude, generation);
      this.mapInitialization = initialization;
      try { await initialization; } finally { if (this.mapInitialization === initialization) this.mapInitialization = null; }
      return;
    }
    if (this.mapSource() === 'osmand') {
      if (this.offlineRenderer) {
        this.offlineRenderer.updateCurrentLocation(latitude, longitude);
        this.offlineRenderer.map.easeTo({ center: [longitude, latitude] });
        return;
      }
      if (this.mapInitialization) await this.mapInitialization;
      if (generation !== this.mapSourceGeneration || this.mapSource() !== 'osmand' || this.offlineRenderer) return;
      const initialization = this.createOsmAndMap(latitude, longitude, generation);
      this.mapInitialization = initialization;
      try { await initialization; } finally { if (this.mapInitialization === initialization) this.mapInitialization = null; }
      return;
    }
    if (this.mapSource() === 'offline') {
      const selected = await this.desktop?.OfflineMap.selectForCoordinates(latitude, longitude) ?? null;
      if (generation !== this.mapSourceGeneration || this.mapSource() !== 'offline') return;
      if (this.currentLatitude !== latitude || this.currentLongitude !== longitude) {
        if (this.currentLatitude !== null && this.currentLongitude !== null) {
          await this.initialize(this.currentLatitude, this.currentLongitude);
        }
        return;
      }
      const nextId = selected?.id ?? null;
      this.activeOfflineMapId.set(nextId);
      if (nextId !== this.currentOfflineMapId) {
        this.mapSourceGeneration++;
        generation = this.mapSourceGeneration;
        this.offlineRenderer?.remove(); this.offlineRenderer = null;
        this.map?.remove(); this.map = null; this.marker = null; this.directoryMarkerGroup = null;
        this.tileLayer?.remove(); this.tileLayer = null; this.clearDirectoryMarkers();
        this.currentOfflineMapId = nextId;
        this.mapInitialization = null;
      }
      if (!selected) {
        this.offlineMapStatus.set(null);
        if (this.map) {
          this.marker?.setLatLng([latitude, longitude]);
          this.map.setView([latitude, longitude], this.map.getZoom());
          return;
        }
        const fallback = this.createMap(latitude, longitude, generation, true);
        this.mapInitialization = fallback;
        try { await fallback; } finally { if (this.mapInitialization === fallback) this.mapInitialization = null; }
        return;
      }
      this.offlineMapStatus.set(selected);
      if (this.offlineRenderer) { this.offlineRenderer.updateCurrentLocation(latitude, longitude); this.offlineRenderer.map.easeTo({ center: [longitude, latitude] }); return; }
      if (this.mapInitialization) await this.mapInitialization;
      if (generation !== this.mapSourceGeneration || this.mapSource() !== 'offline') return;
      if (this.offlineRenderer) return;
      const initialization = this.createOfflineMap(latitude, longitude, generation, selected);
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

  private async createOfflineMap(latitude: number, longitude: number, generation: number, status: import('internal-api').OfflineMapStatus): Promise<void> {
    if (generation !== this.mapSourceGeneration || this.mapSource() !== 'offline') return;
    this.offlineMapStatus.set(status ?? null);
    const renderer = new OfflineMapRenderer(
      this.mapElement().nativeElement,
      [longitude, latitude],
      this.validZoom(this.zoomLevel()),
      message => {
        if (generation !== this.mapSourceGeneration) return;
        this.offlineMapStatus.update(current => current ? { ...current, error: message } : current);
        this.recordMapError('Offline map rendering', message);
      },
      this.offlineMapStyle(),
      status.id,
      status.minZoom,
      status.maxZoom,
      status.bounds?.split(',').map(Number) as [number, number, number, number] | undefined,
      status.schema ?? 'shortbread',
      status.vectorLayers ?? []
    );
    this.offlineRenderer = renderer;
    window.dispatchEvent(new CustomEvent('lumascope-osmand-tile-visuals', { detail: { enabled: this.renderVisualsEnabled() } }));
    try {
      await renderer.ready;
    } catch (error) {
      renderer.remove();
      if (this.offlineRenderer === renderer) this.offlineRenderer = null;
      if (generation === this.mapSourceGeneration) {
        const message = error instanceof Error ? error.message : String(error);
        this.offlineMapStatus.set({ ...status, error: message });
        this.recordMapError('Offline map initialization', message);
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
    renderer.setTextLabelOpacity(this.labelOpacity() / 100);
    renderer.map.jumpTo({ center: [latestLongitude, latestLatitude] });
    this.applyMapColor(); this.applyMapOpacity();
    this.applyHillshadeSettings(renderer);
    const syncOfflineZoom = (): void => this.persistZoom(renderer.map.getZoom());
    renderer.map.on('zoomend', syncOfflineZoom);
    syncOfflineZoom();
    if (this.directoryMarkersEnabled()) void this.scanDirectoryMarkers();
    await this.restoreGpxTrack();
    window.addEventListener('resize', this.onResize);
  }

  private async createOsmAndAtlasMap(latitude: number, longitude: number, generation: number): Promise<void> {
    if (generation !== this.mapSourceGeneration || this.mapSource() !== 'osmand-atlas') return;
    this.renderInitStatus.set('Render init …');
    if (!this.desktop) {
      this.renderInitStatus.set('');
      this.recordMapError('OsmAnd Atlas', 'Desktop API is not connected.');
      return;
    }

    let runtime: Awaited<ReturnType<Desktop['OsmAndAtlas']['getRuntimeStatus']>>;
    try {
      console.info('[OsmAnd Atlas][style-trace] map initialization request', {
        uiStyle: this.osmAndStyle(),
        source: this.mapSource()
      });
      runtime = await this.desktop.OsmAndAtlas.setRenderingStyle(this.osmAndStyle());
    } catch (error) {
      if (generation === this.mapSourceGeneration) {
        this.renderInitStatus.set('');
        this.recordMapError('OsmAnd Atlas runtime', error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (generation !== this.mapSourceGeneration || this.mapSource() !== 'osmand-atlas') return;
    this.mapDisplayNotice.set(!runtime.resourcesAvailable ? 'The OsmAnd resources folder is missing or invalid. Select the extracted resources folder in the Download tab; it must contain rendering_styles/default.render.xml.' : '');
    const missing = [
      !runtime.helperAvailable ? 'render helper: ' + runtime.helperPath : '',
      !runtime.obfAvailable ? 'OBF map: ' + runtime.obfPath : '',
      !runtime.resourcesAvailable ? 'OsmAnd resources: ' + runtime.resourcesPath : '',
      !runtime.styleAvailable ? 'rendering style: ' + runtime.stylePath : ''
    ].filter(Boolean);
    if (missing.length) {
      this.renderInitStatus.set('');
      this.recordMapError('OsmAnd Atlas runtime', 'Not ready. Missing ' + missing.join('; ') + '.');
      return;
    }

    registerOsmAndAtlasTileProtocol(this.desktop, () => this.atlasDisplayDensityFactor());
    const renderer = new OfflineMapRenderer(
      this.mapElement().nativeElement,
      [longitude, latitude],
      Math.max(2, this.validZoom(this.zoomLevel())),
      message => {
        if (generation !== this.mapSourceGeneration || /\b(cancelled|canceled)\b/i.test(message)) return;
        this.renderInitStatus.set('');
        this.recordMapError('OsmAnd Atlas rendering', message);
        console.error('[OsmAnd Atlas] Tile rendering error:', message);
      },
      'lumascope', '', 2, 22, undefined, 'shortbread', [], createOsmAndAtlasMapStyle()
    );
    this.offlineRenderer = renderer;
    window.dispatchEvent(new CustomEvent('lumascope-osmand-tile-visuals', { detail: { enabled: this.renderVisualsEnabled() } }));
    try {
      await renderer.ready;
    } catch (error) {
      renderer.remove();
      if (this.offlineRenderer === renderer) this.offlineRenderer = null;
      if (generation === this.mapSourceGeneration) {
        this.renderInitStatus.set('');
        const message = error instanceof Error ? error.message : String(error);
        this.recordMapError('OsmAnd Atlas initialization', message);
        console.error('[OsmAnd Atlas] Initialization failed:', error);
      }
      return;
    }
    if (generation !== this.mapSourceGeneration || this.mapSource() !== 'osmand-atlas') {
      renderer.remove();
      if (this.offlineRenderer === renderer) this.offlineRenderer = null;
      return;
    }

    const latestLatitude = this.currentLatitude ?? latitude;
    const latestLongitude = this.currentLongitude ?? longitude;
    renderer.setCurrentLocation(
      latestLatitude, latestLongitude, this.currentMarkerColor(),
      (this.locationVisible() ? this.locationOpacity() / 100 : 0), this.currentMarkerShape()
    );
    renderer.map.jumpTo({ center: [latestLongitude, latestLatitude] });
    this.applyMapColor();
    this.applyMapOpacity();
    this.applyHillshadeSettings(renderer);
    // Invalidate queued requests from the previous viewport during movement.
    // Once the camera settles, give MapLibre a fresh source identity so it
    // requests every tile for the final viewport again.
    let viewportRefreshTimer: number | null = null;
    let previousViewportZoom = renderer.map.getZoom();
    renderer.map.on('movestart', () => {
      if (viewportRefreshTimer !== null) window.clearTimeout(viewportRefreshTimer);
      this.activeRenderTiles.clear();
      this.seenRenderTiles.clear();
      this.renderActiveCount.set(0);
      this.renderTotalCount.set(0);
      void this.desktop?.OsmAndAtlas.cancelRendering().catch(error =>
        console.warn('[OsmAnd Atlas] Could not cancel obsolete queued tiles:', error));
    });
    renderer.map.on('moveend', () => {
      const settledZoom = renderer.map.getZoom();
      if (Math.abs(settledZoom - previousViewportZoom) > 0.001) {
        previousViewportZoom = settledZoom;
        return; // The renderer's zoomend handler refreshes zoom changes.
      }
      if (viewportRefreshTimer !== null) window.clearTimeout(viewportRefreshTimer);
      viewportRefreshTimer = window.setTimeout(() => {
        viewportRefreshTimer = null;
        const source = renderer.map.getSource('osmand-atlas') as { setTiles?: (tiles: string[]) => unknown } | undefined;
        if (!source?.setTiles) return;
        source.setTiles(['osmand-atlas://{z}/{x}/{y}?refresh=' + Date.now()]);
      }, 180);
    });
    renderer.map.on('zoomend', () => this.persistZoom(renderer.map.getZoom()));
    this.persistZoom(renderer.map.getZoom());
    if (this.directoryMarkersEnabled()) void this.scanDirectoryMarkers();
    await this.restoreGpxTrack();
    window.addEventListener('resize', this.onResize);
  }

  private async createOsmAndMap(latitude: number, longitude: number, generation: number): Promise<void> {
    if (generation !== this.mapSourceGeneration || this.mapSource() !== 'osmand') return;
    this.renderInitStatus.set('Render init …');
    if (!this.desktop) {
      this.renderInitStatus.set('');
      this.recordMapError('OsmAnd', 'Desktop API is not connected.');
      return;
    }

    let runtime: Awaited<ReturnType<Desktop['OsmAnd']['getRuntimeStatus']>>;
    try {
      runtime = await this.desktop.OsmAnd.setRenderingStyle(this.osmAndStyle());
    } catch (error) {
      if (generation === this.mapSourceGeneration) {
        this.renderInitStatus.set('');
        this.recordMapError('OsmAnd runtime', error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (generation !== this.mapSourceGeneration || this.mapSource() !== 'osmand') return;
    this.mapDisplayNotice.set(!runtime.resourcesAvailable ? 'The OsmAnd resources folder is missing or invalid. Select the extracted resources folder in the Download tab; it must contain rendering_styles/default.render.xml.' : '');
    const missing = [
      !runtime.helperAvailable ? 'render helper: ' + runtime.helperPath : '',
      !runtime.obfAvailable ? 'OBF map: ' + runtime.obfPath : '',
      !runtime.resourcesAvailable ? 'OsmAnd resources: ' + runtime.resourcesPath : '',
      !runtime.styleAvailable ? 'rendering style: ' + runtime.stylePath : ''
    ].filter(Boolean);
    if (missing.length) {
      this.renderInitStatus.set('');
      this.recordMapError('OsmAnd runtime', 'Not ready. Missing ' + missing.join('; ') + '.');
      return;
    }

    registerOsmAndTileProtocol(this.desktop);
    const renderer = new OfflineMapRenderer(
      this.mapElement().nativeElement,
      [longitude, latitude],
      Math.max(2, this.validZoom(this.zoomLevel())),
      message => {
        if (generation !== this.mapSourceGeneration) return;
        this.renderInitStatus.set('');
        this.recordMapError('OsmAnd rendering', message);
        console.error('[OsmAnd] Tile rendering error:', message);
      },
      'lumascope', '', 2, 19, undefined, 'shortbread', [], createOsmAndMapStyle()
    );
    this.offlineRenderer = renderer;
    window.dispatchEvent(new CustomEvent('lumascope-osmand-tile-visuals', { detail: { enabled: this.renderVisualsEnabled() } }));
    try {
      await renderer.ready;
    } catch (error) {
      renderer.remove();
      if (this.offlineRenderer === renderer) this.offlineRenderer = null;
      if (generation === this.mapSourceGeneration) {
        this.renderInitStatus.set('');
        const message = error instanceof Error ? error.message : String(error);
        this.recordMapError('OsmAnd initialization', message);
        console.error('[OsmAnd] Initialization failed:', error);
      }
      return;
    }
    if (generation !== this.mapSourceGeneration || this.mapSource() !== 'osmand') {
      renderer.remove();
      if (this.offlineRenderer === renderer) this.offlineRenderer = null;
      return;
    }

    const latestLatitude = this.currentLatitude ?? latitude;
    const latestLongitude = this.currentLongitude ?? longitude;
    renderer.setCurrentLocation(
      latestLatitude, latestLongitude, this.currentMarkerColor(),
      (this.locationVisible() ? this.locationOpacity() / 100 : 0), this.currentMarkerShape()
    );
    renderer.map.jumpTo({ center: [latestLongitude, latestLatitude] });
    this.applyMapColor();
    this.applyMapOpacity();
    this.applyHillshadeSettings(renderer);
    renderer.map.on('zoomend', () => this.persistZoom(renderer.map.getZoom()));
    this.persistZoom(renderer.map.getZoom());
    if (this.directoryMarkersEnabled()) void this.scanDirectoryMarkers();
    await this.restoreGpxTrack();
    window.addEventListener('resize', this.onResize);
  }

  private async createMap(latitude: number, longitude: number, generation: number, allowOfflineFallback = false): Promise<void> {
    this.offlineRenderer?.remove(); this.offlineRenderer = null;
    const leaflet = await this.loadLeaflet();
    if (generation !== this.mapSourceGeneration || (this.mapSource() !== 'online' && !allowOfflineFallback)) return;
    this.leaflet = leaflet;
    const center: [number, number] = [latitude, longitude];
    const map = this.leaflet.map(this.mapElement().nativeElement, { zoomControl: false, keyboard: false, minZoom: 1, maxZoom: 20 })
      .setView(center, this.validZoom(this.zoomLevel()));
    this.map = map;
    this.mapElement().nativeElement.style.setProperty('--marker-opacity', String((this.markersVisible() ? this.markerOpacity() / 100 : 0)));
    const syncZoom = (): void => this.persistZoom(map.getZoom());
    map.on('zoomend', syncZoom);
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
    if (value !== 'online' && value !== 'offline' && value !== 'osmand' && value !== 'osmand-atlas') return;
    // MBTiles requires a loaded map; OsmAnd uses its separately configured OBF runtime.
    const nextSource = value === 'offline' && this.offlineMaps().length === 0 ? 'online' : value;
    const previousSource = this.mapSource();
    this.renderInitStatus.set('');
    if (previousSource === 'osmand-atlas' && nextSource !== 'osmand-atlas') {
      void this.desktop?.OsmAndAtlas.shutdown().catch(error => console.warn('Could not stop OsmAnd Atlas helpers:', error));
    }
    if (previousSource === 'osmand' && nextSource !== 'osmand') {
      void this.desktop?.OsmAnd.shutdown().catch(error => console.warn('Could not stop OsmAnd helpers:', error));
    }
    this.mapSourceGeneration++;
    this.mapInitialization = null;
    this.mapSource.set(nextSource); this.saveSetting('source', nextSource);
    if (nextSource !== 'offline') {
      this.currentOfflineMapId = null;
      this.activeOfflineMapId.set(null);
      this.offlineMapStatus.set(null);
    }
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
  protected readonly changeOsmAndStyle = async (fileName: string): Promise<void> => {
    if (!this.osmAndStyles().some(style => style.fileName === fileName) || fileName === this.osmAndStyle()) return;
    if (!this.desktop) return;
    const changeGeneration = ++this.osmAndStyleChangeGeneration;
    try {
      // One shared style selection for both renderers. OsmAnd Atlas persists
      // it in config.json; both renderers are always updated to the same file.
      await Promise.all([
        this.desktop.OsmAndAtlas.setRenderingStyle(fileName),
        this.desktop.OsmAnd.setRenderingStyle(fileName)
      ]);
      // Rapid consecutive selections are serialized by the main process.
      // Only the latest selection may rebuild the map and update the UI.
      if (changeGeneration !== this.osmAndStyleChangeGeneration) return;
      this.osmAndStyle.set(fileName);
      this.osmAndStyles.update(styles => styles.map(style => ({ ...style, selected: style.fileName === fileName })));
      if ((this.mapSource() === 'osmand' || this.mapSource() === 'osmand-atlas')
        && this.currentLatitude !== null && this.currentLongitude !== null) {
        this.mapSourceGeneration++;
        this.mapInitialization = null;
        this.offlineRenderer?.remove();
        this.offlineRenderer = null;
        this.map?.remove(); this.map = null;
        void this.initialize(this.currentLatitude, this.currentLongitude);
      }
      void this.refreshOsmAndTileCache();
    } catch (error) {
      console.error('Could not change OsmAnd rendering style:', error);
      this.recordMapError('OsmAnd rendering style', error instanceof Error ? error.message : String(error));
    }
  };

  protected readonly chooseOfflineMap = async (): Promise<void> => {
    if (!this.desktop) return;
    const result = await this.desktop.OfflineMap.chooseFile();
    this.offlineMaps.set(result.maps);
    this.offlineMapImportErrors.set(result.errors);
    if (this.mapSource() === 'offline' && !result.maps.some(map => map.enabled && map.type !== 'obf')) this.changeMapSource('online');
    else if (result.maps.length === 0 && this.mapSource() === 'offline') this.changeMapSource('online');
    else if (this.currentLatitude !== null && this.currentLongitude !== null && (this.mapSource() === 'offline' || this.mapSource() === 'osmand' || this.mapSource() === 'osmand-atlas')) {
      this.mapSourceGeneration++; this.mapInitialization = null;
      this.offlineRenderer?.remove(); this.offlineRenderer = null;
      this.currentOfflineMapId = null;
      void this.initialize(this.currentLatitude, this.currentLongitude);
    }
  };
  protected readonly checkForOfflineMapUpdates = async (): Promise<void> => {
    if (!this.desktop || this.offlineMapUpdateCheckBusy()) return;
    this.offlineMapUpdateCheckBusy.set(true);
    this.offlineMapUpdateCheckStatus.set('Downloading update catalogues…');
    try {
      const result = await this.desktop.OfflineMap.checkForUpdates();
      this.offlineMaps.set(result.maps);
      const updates = result.maps.filter(map => map.updateAvailable === true).length;
      this.offlineMapCatalogueFiles.set(result.catalogueFiles);
      const checkedAt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(result.checkedAt));
      const errors = result.sourceErrors.length ? ' · Source errors: ' + result.sourceErrors.join('; ') : '';
      this.offlineMapCatalogueSummary.set('Checked ' + checkedAt + ' · ' + result.filesFound + ' catalogue file(s) · ' + result.matchedMaps + ' local map(s) matched · ' + result.unmatchedMaps + ' unmatched · ' + updates + ' update(s) available' + errors);
      this.offlineMapUpdateCheckStatus.set(this.offlineMapCatalogueSummary());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.offlineMapUpdateCheckStatus.set('Update check failed: ' + message);
      this.recordMapError('Offline map updates', message);
    } finally {
      this.offlineMapUpdateCheckBusy.set(false);
    }
  };
  protected readonly formatOfflineMapSize = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes < 1024) return bytes + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024, unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2) + ' ' + units[unit];
  };
  protected readonly refreshProcessMemory = async (): Promise<void> => {
    if (!this.desktop) return;
    try {
      this.processMemory.set(await this.desktop.ProcessManager.getProcessMemoryUsage());
      this.memoryUpdatedAt.set(new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date()));
    } catch (error) {
      this.processMemory.update(current => ({
        ...current,
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  };
  protected readonly refreshOsmAndTileCache = async (): Promise<void> => {
    if (!this.desktop) return;
    try {
      this.osmAndTileCache.set(await this.desktop.CacheManager.getOsmAndTileCacheSummary());
    } catch (error) {
      console.error('Could not read OsmAnd tile cache summary:', error);
    }
  };
  protected readonly rerenderVisibleTiles = async (): Promise<void> => {
    const renderer = this.offlineRenderer;
    const source = this.mapSource();
    if (!this.desktop || !renderer || (source !== 'osmand-atlas' && source !== 'osmand') || this.rerenderVisibleTilesBusy()) return;
    this.rerenderVisibleTilesBusy.set(true);
    this.rerenderVisibleTilesStatus.set(`Rendering visible ${source === 'osmand-atlas' ? 'Atlas' : 'no-label'} tiles without using the disk cache…`);
    try {
      const count = await renderer.rerenderVisibleTiles(
        (z, x, y, forceRender) => this.desktop!.OsmAnd.renderTile(z, x, y, forceRender),
        (z, x, y, displayScale, forceRender) =>
          this.desktop!.OsmAndAtlas.renderTile(z, x, y, displayScale, forceRender),
        this.atlasDisplayDensityFactor(),
        (completed, total) => this.rerenderVisibleTilesProgress.set({ completed, total })
      );
      this.rerenderVisibleTilesStatus.set(`Rendered ${count} visible ${source === 'osmand-atlas' ? 'Atlas' : 'no-label'} tile(s); reloading them from the updated cache.`);
      await this.refreshOsmAndTileCache();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.rerenderVisibleTilesStatus.set('Rerender failed: ' + message);
      this.rerenderVisibleTilesProgress.set({ completed: 0, total: 0 });
      console.error('[OsmAnd Atlas] Could not rerender visible tiles:', error);
    } finally {
      this.rerenderVisibleTilesBusy.set(false);
      this.rerenderVisibleTilesProgress.set({ completed: 0, total: 0 });
    }
  };
  protected readonly formatOfflineMapDate = (timestamp: number): string => {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '—';
    return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(timestamp));
  };
  protected readonly changeOfflineMapPreset = async (value: string): Promise<void> => {
    if (value !== 'austria' && value !== 'europe' && value !== 'all' && value !== 'custom' && value !== 'custom-no-world-map') return;
    this.offlineMapPreset.set(value);
    this.saveSetting('offlineMapPreset', value);
    if (this.desktop) {
      await this.desktop.ProcessManager.setAppSettingsSection('offlineMaps', { obfPreset: value });
      if (value !== 'custom-no-world-map') {
        const worldMap = this.offlineMaps().find(map => map.type === 'obf' && /^World_basemap\.obf$/i.test(map.fileName || map.name));
        if (worldMap && !worldMap.enabled) {
          this.offlineMaps.set(await this.desktop.OfflineMap.setEnabled(worldMap.id, true));
        }
      }
    }
    this.refreshOfflineMapRendering();
  };

  private obfMapMatchesPreset(map: import('internal-api').OfflineMapStatus): boolean {
    if (map.type !== 'obf') return false;
    const fileName = map.fileName || map.name;
    const isAustria = /austria|österreich|osterreich/i.test(fileName);
    const isEurope = /(?:^|[_. -])europe(?:[_. -]|$)/i.test(fileName);
    const preset = this.offlineMapPreset();
    const isWorldBasemap = /^World_basemap\.obf$/i.test(map.fileName || map.name);
    if (isWorldBasemap) return preset !== 'custom-no-world-map';
    return preset === 'all' || preset === 'custom' || preset === 'custom-no-world-map' || (preset === 'austria' ? isAustria : isEurope);
  }

  protected readonly isOfflineMapInUse = (map: import('internal-api').OfflineMapStatus): boolean => {
    if (!map.enabled) return false;
    if (map.type === 'obf') {
      return (this.mapSource() === 'osmand' || this.mapSource() === 'osmand-atlas')
        && this.obfMapMatchesPreset(map);
    }
    return this.mapSource() === 'offline' && map.id === this.activeOfflineMapId();
  }

  private refreshOfflineMapRendering(): void {
    if (this.currentLatitude !== null && this.currentLongitude !== null
      && (this.mapSource() === 'offline' || this.mapSource() === 'osmand' || this.mapSource() === 'osmand-atlas')) {
      this.mapSourceGeneration++; this.mapInitialization = null;
      this.offlineRenderer?.remove(); this.offlineRenderer = null;
      this.map?.remove(); this.map = null; this.marker = null; this.directoryMarkerGroup = null;
      this.currentOfflineMapId = null;
      void this.initialize(this.currentLatitude, this.currentLongitude);
    }
  }

  protected readonly setOfflineMapEnabled = async (id: string, enabled: boolean): Promise<void> => {
    if (!this.desktop) return;
    this.offlineMaps.set(await this.desktop.OfflineMap.setEnabled(id, enabled));
    if (this.currentLatitude !== null && this.currentLongitude !== null && (this.mapSource() === 'offline' || this.mapSource() === 'osmand' || this.mapSource() === 'osmand-atlas')) {
      this.mapSourceGeneration++; this.mapInitialization = null;
      this.offlineRenderer?.remove(); this.offlineRenderer = null;
      this.map?.remove(); this.map = null; this.marker = null; this.directoryMarkerGroup = null;
      this.currentOfflineMapId = null;
      void this.initialize(this.currentLatitude, this.currentLongitude);
    }
  };
  protected readonly setAllOfflineMapsEnabled = async (enabled: boolean): Promise<void> => {
    if (!this.desktop || this.offlineMaps().length === 0) return;
    try {
      this.offlineMaps.set(await this.desktop.OfflineMap.setAllEnabled(enabled));
      if (this.currentLatitude !== null && this.currentLongitude !== null
        && (this.mapSource() === 'offline' || this.mapSource() === 'osmand' || this.mapSource() === 'osmand-atlas')) {
        this.mapSourceGeneration++; this.mapInitialization = null;
        this.offlineRenderer?.remove(); this.offlineRenderer = null;
        this.map?.remove(); this.map = null; this.marker = null; this.directoryMarkerGroup = null;
        this.currentOfflineMapId = null;
        void this.initialize(this.currentLatitude, this.currentLongitude);
      }
    } catch (error) {
      console.error('[OfflineMap] Could not update Active state for all loaded maps:', error);
    }
  };
  protected readonly clearOfflineMapsList = async (): Promise<void> => {
    if (!this.desktop) return;
    const maps = this.offlineMaps();
    if (maps.length === 0) return;
    const confirmed = window.confirm(
      `Remove all ${maps.length} map(s) from the LumaScope list? The map files on disk will not be deleted.`
    );
    if (!confirmed) return;
    try {
      let remaining = maps;
      for (const map of maps) {
        remaining = await this.desktop.OfflineMap.removeFile(map.id);
      }
      this.offlineMaps.set(remaining);
      this.offlineMapUpdateCheckStatus.set('');
      if (!remaining.some(map => map.enabled && map.type !== 'obf') && this.mapSource() === 'offline') {
        this.changeMapSource('online');
        return;
      }
      if (this.currentLatitude !== null && this.currentLongitude !== null
        && (this.mapSource() === 'offline' || this.mapSource() === 'osmand' || this.mapSource() === 'osmand-atlas')) {
        this.mapSourceGeneration++; this.mapInitialization = null;
        this.offlineRenderer?.remove(); this.offlineRenderer = null;
        this.map?.remove(); this.map = null; this.marker = null; this.directoryMarkerGroup = null;
        this.currentOfflineMapId = null;
        void this.initialize(this.currentLatitude, this.currentLongitude);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordMapError('Clear offline maps list', message);
    }
  };
  protected readonly removeOfflineMap = async (id: string): Promise<void> => {
    if (!this.desktop) return;
    this.offlineMaps.set(await this.desktop.OfflineMap.removeFile(id));
    if (!this.offlineMaps().some(map => map.enabled && map.type !== 'obf') && this.mapSource() === 'offline') {
      this.changeMapSource('online');
      return;
    }
    if (this.currentLatitude !== null && this.currentLongitude !== null && (this.mapSource() === 'offline' || this.mapSource() === 'osmand' || this.mapSource() === 'osmand-atlas')) {
      this.mapSourceGeneration++; this.mapInitialization = null;
      this.offlineRenderer?.remove(); this.offlineRenderer = null;
      this.map?.remove(); this.map = null; this.marker = null; this.directoryMarkerGroup = null;
      this.currentOfflineMapId = null;
      void this.initialize(this.currentLatitude, this.currentLongitude);
    }
  };
  private persistDownloadSources(): void {
    const updateSources = this.downloadSources().map(source => ({ ...source }));
    void this.desktop?.ProcessManager.setAppSettingsSection('offlineMaps', {
      obfPreset: this.offlineMapPreset(),
      updateSources
    }).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      this.recordMapError('Download sources settings', message);
    });
  }
  protected readonly isValidDownloadUrl = (value: string): boolean => {
    try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:'; } catch { return false; }
  };
  protected readonly updateDownloadSource = (index: number, patch: Partial<{ url: string; fileType: 'obf' | 'mbtiles'; useForUpdates: boolean }>): void => {
    this.downloadSources.update(sources => sources.map((source, i) => i === index ? { ...source, ...patch } : source));
    this.persistDownloadSources();
  };
  protected readonly addDownloadSource = (): void => {
    this.downloadSources.update(sources => [...sources, { url: 'https://', fileType: 'mbtiles', useForUpdates: false }]);
    this.persistDownloadSources();
  };
  protected readonly removeDownloadSource = (index: number): void => {
    this.downloadSources.update(sources => sources.filter((_source, i) => i !== index));
    this.persistDownloadSources();
  };
  protected readonly openDownloadSource = async (url: string): Promise<void> => {
    if (this.isValidDownloadUrl(url)) await this.desktop?.ProcessManager.openExternal(url);
  };
  protected readonly chooseOsmAndResourcesFolder = async (): Promise<void> => {
    if (!this.desktop) return;
    const result = await this.desktop.Dialogs.openFolder(this.osmAndResourcesPath() || undefined);
    if (!result.success) return;
    this.osmAndResourcesError.set('');
    try {
      // Apply sequentially because both managers persist into the same
      // application settings section; parallel writes could race each other.
      await this.desktop.OsmAndAtlas.setResourcesPath(result.data);
      await this.desktop.OsmAnd.setResourcesPath(result.data);
      this.osmAndResourcesPath.set(result.data);
      this.osmAndStyles.set(await this.desktop.OsmAndAtlas.getRenderingStyles());
      if (this.mapSource() === 'osmand-atlas' && this.currentLatitude !== null && this.currentLongitude !== null) {
        this.refreshOfflineMapRendering();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.osmAndResourcesError.set(message);
      this.recordMapError('OsmAnd resources folder', message);
      console.error('[OsmAnd] Could not set resources folder:', error);
    }
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
  protected readonly changeOverlayOpacity = (value: string | number): void => {
    const opacity = Number(value); if (!Number.isFinite(opacity)) return;
    const next = Math.max(0, Math.min(100, Math.round(opacity)));
    this.overlayOpacity.set(next); this.saveSetting('overlayOpacity', next);
  };
  protected readonly changeHillshadeVisibility = (visible: boolean): void => {
    this.hillshadeVisible.set(visible);
    this.saveSetting('hillshadeVisible', visible);
    this.offlineRenderer?.setHillshadeVisibility(visible && this.activeHillshadeDatabaseCount() > 0);
  };
  protected readonly changeHillshadeOpacity = (value: string | number): void => {
    const opacity = Number(value); if (!Number.isFinite(opacity)) return;
    const next = Math.max(0, Math.min(100, Math.round(opacity)));
    this.hillshadeOpacity.set(next);
    this.saveSetting('hillshadeOpacity', next);
    this.offlineRenderer?.setHillshadeOpacity(next / 100);
  };
  protected readonly addHillshadeDatabases = async (): Promise<void> => {
    if (!this.desktop) return;
    try {
      const databases = await this.desktop.OsmAndAtlas.addHillshadeDatabases();
      this.hillshadeDatabases.set(databases);
      if (this.offlineRenderer) this.applyHillshadeSettings(this.offlineRenderer);
    } catch (error) {
      this.recordMapError('Add Hillshade databases', error instanceof Error ? error.message : String(error));
    }
  };
  protected readonly setHillshadeDatabaseEnabled = async (id: string, enabled: boolean): Promise<void> => {
    if (!this.desktop) return;
    try {
      const databases = await this.desktop.OsmAndAtlas.setHillshadeDatabaseEnabled(id, enabled);
      this.hillshadeDatabases.set(databases);
      if (this.offlineRenderer) this.applyHillshadeSettings(this.offlineRenderer);
    } catch (error) {
      this.recordMapError('Update Hillshade database', error instanceof Error ? error.message : String(error));
    }
  };
  protected readonly removeHillshadeDatabase = async (id: string): Promise<void> => {
    if (!this.desktop) return;
    try {
      const databases = await this.desktop.OsmAndAtlas.removeHillshadeDatabase(id);
      this.hillshadeDatabases.set(databases);
      if (this.offlineRenderer) this.applyHillshadeSettings(this.offlineRenderer);
      if (databases.length === 0) this.hillshadeVisible.set(false);
    } catch (error) {
      this.recordMapError('Remove Hillshade database', error instanceof Error ? error.message : String(error));
    }
  };
  private applyHillshadeSettings(renderer: OfflineMapRenderer): void {
    renderer.setHillshadeDatabases(this.hillshadeDatabases());
    renderer.setHillshadeOpacity(this.hillshadeOpacity() / 100);
    renderer.setHillshadeVisibility(this.hillshadeVisible() && this.activeHillshadeDatabaseCount() > 0);
  }
  protected readonly changeMapOpacity = (value: string | number): void => {
    const opacity = Number(value); if (!Number.isFinite(opacity)) return;
    const next = Math.max(0, Math.min(100, Math.round(opacity)));
    this.mapOpacity.set(next); this.saveSetting('opacity', next); this.applyMapOpacity();
  };
  protected readonly changeLabelsVisibility = (visible: boolean): void => {
    this.labelsVisible.set(visible);
    this.saveSetting('labelsVisible', visible);
    this.offlineRenderer?.setTextLabelOpacity(visible ? this.labelOpacity() / 100 : 0);
  };
  protected readonly changeLabelOpacity = (value: string | number): void => {
    const opacity = Number(value); if (!Number.isFinite(opacity)) return;
    const next = Math.max(0, Math.min(100, Math.round(opacity)));
    this.labelOpacity.set(next);
    this.saveSetting('labelOpacity', next);
    this.offlineRenderer?.setTextLabelOpacity(this.labelsVisible() ? next / 100 : 0);
  };
  protected readonly previewAtlasDisplayDensity = (value: string | number): void => {
    const density = Number(value);
    if (!Number.isFinite(density)) return;
    const next = Math.round(Math.max(1, Math.min(3, density)) * 20) / 20;
    this.atlasDisplayDensityFactor.set(next);
  };
  protected readonly changeAtlasDisplayDensity = (value: string | number): void => {
    const density = Number(value);
    if (!Number.isFinite(density)) return;
    const next = Math.round(Math.max(1, Math.min(3, density)) * 20) / 20;
    this.atlasDisplayDensityFactor.set(next);
    this.saveSetting('atlasDisplayDensityFactor', next);
    if (this.mapSource() === 'osmand-atlas' && this.currentLatitude !== null && this.currentLongitude !== null) {
      this.mapSourceGeneration++;
      this.mapInitialization = null;
      this.offlineRenderer?.remove();
      this.offlineRenderer = null;
      this.map?.remove();
      this.map = null;
      void this.initialize(this.currentLatitude, this.currentLongitude);
    }
  };
  protected readonly resetAtlasDisplayDensity = (): void => {
    const windowsScale = Math.round(Math.max(1, Math.min(3, window.devicePixelRatio || 1)) * 100) / 100;
    this.changeAtlasDisplayDensity(windowsScale);
  };
  protected readonly changeZoom = (value: string | number): void => {
    const zoom = Number(value); if (!Number.isFinite(zoom)) return;
    const next = Math.max(this.mapSource() === 'osmand' || this.mapSource() === 'osmand-atlas' ? 2 : 1, this.validZoom(zoom));
    // Keep queued Atlas work intact during zoom changes for the same reason
    // as panning: the worker queue is shared by all visible tile requests.
    this.persistZoom(next); this.map?.setZoom(next); this.offlineRenderer?.map.setZoom(next);
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
