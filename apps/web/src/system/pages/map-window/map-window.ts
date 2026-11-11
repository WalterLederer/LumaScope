import { ChangeDetectionStrategy, Component, ElementRef, computed, HostListener, inject, OnDestroy, OnInit, signal, viewChild } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Desktop, lookupReverseGeocoding, type OsmAndHillshadeDatabase } from 'internal-api';
import { ThemeService } from '../../services/theme/theme.service';
import { Marker as MapLibreMarker } from 'maplibre-gl';
import { OfflineMapRenderer, buildPhotoMarkerPreviewHtml, createOsmAndMapStyle, createOsmAndAtlasMapStyle, registerOsmAndAtlasTileProtocol, registerOsmAndHillshadeTileProtocol, registerOsmAndTileProtocol, type OfflinePhotoMarker, type OfflineMapStyle } from './offline-map-renderer';

interface MapMarker { setLatLng(position: [number, number]): MapMarker; setOpacity(opacity: number): MapMarker; setIcon(icon: unknown): MapMarker; getElement(): HTMLElement | null; getLatLng(): { lat: number; lng: number }; on(event: 'click', callback: () => void): MapMarker; remove(): void; bindTooltip(content: string, options?: { direction?: string; className?: string; opacity?: number }): MapMarker; }
interface MapBounds { isValid(): boolean; }
interface MapMarkerGroup { addTo(map: MapInstance): MapMarkerGroup; addLayer(marker: MapMarker): MapMarkerGroup; clearLayers(): MapMarkerGroup; eachLayer(callback: (layer: MapMarker) => void): MapMarkerGroup; refreshClusters?(): MapMarkerGroup; remove(): void; }
interface LeafletGridLayer { addTo(map: MapInstance): LeafletGridLayer; setOpacity(opacity: number): LeafletGridLayer; redraw(): LeafletGridLayer; remove(): void; }
interface MapMarkerCluster { getChildCount(): number; }
interface MapInstance {
  setView(center: [number, number], zoom: number): MapInstance;
  invalidateSize(): MapInstance;
  getZoom(): number;
  setZoom(zoom: number): MapInstance;
  containerPointToLatLng(point: [number, number]): { lat: number; lng: number };
  on(event: 'zoomend', callback: () => void): MapInstance;
  createPane(name: string): HTMLElement;
  fitBounds(bounds: [[number, number], [number, number]], options?: { padding?: [number, number]; maxZoom?: number; animate?: boolean }): MapInstance;
  remove(): void;
}
interface LeafletMapApi {
  map(element: HTMLElement, options?: { zoomControl?: boolean; keyboard?: boolean; minZoom?: number; maxZoom?: number }): MapInstance;
  control: { scale(options: { metric: boolean; imperial: boolean; position: 'bottomleft'; maxWidth: number }): { addTo(map: MapInstance): unknown } };
  tileLayer(url: string, options: { attribution: string; maxZoom: number; maxNativeZoom?: number }): { addTo(map: MapInstance): { remove(): void } };
  GridLayer: { extend(definition: { createTile(coords: { x: number; y: number; z: number }, done: (error: Error | null, tile: HTMLCanvasElement) => void): HTMLCanvasElement }): new(options?: { pane?: string; opacity?: number; tileSize?: number; minZoom?: number; maxZoom?: number; maxNativeZoom?: number; zIndex?: number }) => LeafletGridLayer };
  polyline(points: [number, number][], options: { color: string; weight: number; opacity: number; lineCap: string; lineJoin: string; dashArray?: string }): { addTo(map: MapInstance): { remove(): void; on(event: 'mousemove' | 'mouseout', callback: (event: { latlng: { lat: number; lng: number } }) => void): unknown } };
  marker(position: [number, number], options?: { icon?: unknown }): MapMarker & { addTo(map: MapInstance | MapMarkerGroup): MapMarker };
  divIcon(options: { className: string; html: string; iconSize: [number, number]; iconAnchor: [number, number] }): unknown;
  markerClusterGroup(options?: { chunkedLoading?: boolean; showCoverageOnHover?: boolean; spiderfyOnMaxZoom?: boolean; iconCreateFunction?: (cluster: MapMarkerCluster) => unknown }): MapMarkerGroup;
}
type MapStyle = 'standard' | 'satellite' | 'cycling' | 'topographic' | 'humanitarian';
type MapColor = 'original' | 'light' | 'extra-light' | 'ultra-light' | 'dark' | 'grayscale' | 'pastel' | 'contrast' | 'night';
type MarkerShape = 'double-circle' | 'hexagon' | 'circle' | 'square';
type CurrentMarkerShape = 'pin' | 'circle' | 'square' | 'diamond';

interface GpxTrackPoint { latitude: number; longitude: number; elevation: number | null; timestamp: string | null; }

interface GpxTrackFile { path: string; name: string; sizeBytes: number; lastModified: number; missing?: boolean; readError?: boolean; active?: boolean; color?: string; lineStyle?: 'solid' | 'dashed' | 'dotted' | 'long-dashed' | 'short-dashed' | 'dash-dot' | 'dash-dot-dot'; lineWidth?: number; showDirection?: boolean; directionStyle?: 'classic' | 'chevron' | 'triangle' | 'thin' | 'large-classic' | 'large-chevron' | 'large-triangle'; }

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
  <button type="button" role="tab" class="settings-tab" [class.active]="activeSettingsTab() === 'timeSlider'" [attr.aria-selected]="activeSettingsTab() === 'timeSlider'" (click)="selectSettingsTab('timeSlider')">Time Slider</button>
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
              <div class="location-coordinate-display"><span>{{ photoCoordinateLabel() }} @if (bearingLabel()) { · {{ bearingLabel() }} }</span></div>
              <div class="location-coordinate-display"><span>Mouse: {{ mouseCoordinateLabel() }}</span></div>
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
    <div class="gpx-toolbar">
      <button type="button" class="offline-map-add-button" (click)="importGpxTrack()">Add GPX files...</button>
      <button type="button" class="offline-map-add-button" (click)="generateGpxFromMarkers()" [disabled]="!hasDirectoryPhotoMarkers()">Generate GPX from Markers</button>
      <span class="offline-map-status">{{ gpxTracks().length }} GPX file(s) loaded</span>
      @if (gpxHoverInfo()) { <span class="gpx-hover-info">{{ gpxHoverInfo() }}</span> }
    </div>
    @if (gpxTracks().length > 0) {
      <div class="gpx-file-list" role="table" aria-label="GPX tracks">
        <div class="gpx-file-row gpx-file-header" role="row">
          <span role="columnheader">Actions</span><span role="columnheader">Active</span><span role="columnheader">File</span><span role="columnheader">Date</span><span role="columnheader">Track time (min – max)</span><span role="columnheader">File size</span><span role="columnheader">Color</span><span role="columnheader">Line</span><span role="columnheader">Width</span><span role="columnheader">Arrows</span><span></span><span></span>
        </div>
        @for (track of gpxTracks(); track track.path) {
          <div class="gpx-file-row" role="row" [class.gpx-hovered]="gpxHoveredTrackPath() === track.path" [class.gpx-missing]="track.missing">
            <div class="gpx-row-actions" role="cell"><button type="button" class="gpx-fit-button" (click)="fitGpxTrack(track.path)" [attr.aria-label]="'Fit map to ' + track.name" title="Fit map to entire track">⤢</button><button type="button" class="gpx-open-button" (click)="openGpxTrack(track)" [disabled]="track.missing || track.path.startsWith('memory:')" [attr.aria-label]="'Open ' + track.name + ' in default editor'" title="Open in default GPX editor">↗</button></div>
            <label class="gpx-active-toggle" role="cell" [title]="'Show ' + track.name"><input type="checkbox" [checked]="track.active !== false" (change)="changeGpxTrackActive(track.path, $any($event.target).checked)" [attr.aria-label]="'Show track ' + track.name"></label>
            <span class="gpx-file-name" role="cell" [title]="track.path">{{ track.name }}</span>
            <span role="cell">{{ track.missing ? 'Missing' : track.readError ? 'Read error' : formatGpxDate(track.lastModified) }}</span>
            <span class="gpx-time-range" role="cell" [title]="gpxTrackTimeRange(track.path)">{{ track.missing ? 'Missing' : track.readError ? 'Read error' : gpxTrackTimeRange(track.path) }}</span>
            <span role="cell">{{ track.missing ? 'Missing' : track.readError ? 'Read error' : formatGpxFileSize(track.sizeBytes) }}</span>
            <div class="color-picker gpx-track-color-picker" role="cell">
              <button type="button" class="color-picker-trigger" (click)="toggleGpxTrackColorMenu(track.path)" [attr.aria-expanded]="gpxTrackColorMenuOpen() === track.path" [attr.aria-label]="'Color for ' + track.name">
                <span class="color-swatch" [style.background]="track.color || gpxColor()" [style.color]="selectedGpxTrackTextColor(track)">{{ track.color || gpxColor() }}</span>
                <span>{{ selectedGpxTrackColorName(track) }}</span><span class="color-picker-chevron">▾</span>
              </button>
              @if (gpxTrackColorMenuOpen() === track.path) {
                <div class="color-picker-menu" role="listbox" [attr.aria-label]="'Colors for ' + track.name">
                  @for (color of gpxColors; track color.value) {
                    <button type="button" class="color-option" role="option" [attr.aria-selected]="(track.color || gpxColor()) === color.value" (click)="changeGpxTrackColor(track.path, color.value)">
                      <span class="color-swatch" [style.background]="color.value" [style.color]="color.textColor">{{ color.value }}</span><span>{{ color.name }}</span>
                    </button>
                  }
                </div>
              }
            </div>
            <div class="color-picker gpx-track-choice-picker" role="cell">
              <button type="button" class="color-picker-trigger gpx-track-choice-trigger" (click)="toggleGpxTrackLineStyleMenu(track.path)" [attr.aria-expanded]="gpxTrackLineStyleMenuOpen() === track.path" [attr.aria-label]="'Line style for ' + track.name">
                <span class="gpx-track-choice-sample" [style.color]="track.color || gpxColor()">{{ gpxLineStyleSample(track.lineStyle || 'solid') }}</span><span>{{ gpxLineStyleName(track.lineStyle || 'solid') }}</span><span class="color-picker-chevron">▾</span>
              </button>
              @if (gpxTrackLineStyleMenuOpen() === track.path) {
                <div class="color-picker-menu gpx-track-choice-menu gpx-line-style-menu" role="listbox" [attr.aria-label]="'Line styles for ' + track.name">
                  <button type="button" class="color-option gpx-track-choice-option" role="option" [attr.aria-selected]="(track.lineStyle || 'solid') === 'solid'" (click)="changeGpxTrackLineStyle(track.path, 'solid')"><span class="gpx-track-choice-sample" [style.color]="track.color || gpxColor()">━━━━━━━━━</span><span>Solid</span></button>
                  <button type="button" class="color-option gpx-track-choice-option" role="option" [attr.aria-selected]="track.lineStyle === 'dashed'" (click)="changeGpxTrackLineStyle(track.path, 'dashed')"><span class="gpx-track-choice-sample" [style.color]="track.color || gpxColor()">━ ━ ━ ━</span><span>Dashed</span></button>
                  <button type="button" class="color-option gpx-track-choice-option" role="option" [attr.aria-selected]="track.lineStyle === 'dotted'" (click)="changeGpxTrackLineStyle(track.path, 'dotted')"><span class="gpx-track-choice-sample" [style.color]="track.color || gpxColor()">· · · · ·</span><span>Dotted</span></button>
                  <button type="button" class="color-option gpx-track-choice-option" role="option" [attr.aria-selected]="track.lineStyle === 'long-dashed'" (click)="changeGpxTrackLineStyle(track.path, 'long-dashed')"><span class="gpx-track-choice-sample" [style.color]="track.color || gpxColor()">━━  ━━  ━━</span><span>Long dash</span></button>
                  <button type="button" class="color-option gpx-track-choice-option" role="option" [attr.aria-selected]="track.lineStyle === 'short-dashed'" (click)="changeGpxTrackLineStyle(track.path, 'short-dashed')"><span class="gpx-track-choice-sample">━ ━ ━ ━</span><span>Short dash</span></button>
                  <button type="button" class="color-option gpx-track-choice-option" role="option" [attr.aria-selected]="track.lineStyle === 'dash-dot'" (click)="changeGpxTrackLineStyle(track.path, 'dash-dot')"><span class="gpx-track-choice-sample" [style.color]="track.color || gpxColor()">━ · ━ · ━</span><span>Dash-dot</span></button>
                  <button type="button" class="color-option gpx-track-choice-option" role="option" [attr.aria-selected]="track.lineStyle === 'dash-dot-dot'" (click)="changeGpxTrackLineStyle(track.path, 'dash-dot-dot')"><span class="gpx-track-choice-sample" [style.color]="track.color || gpxColor()">━ · · ━ · ·</span><span>Dash-dot-dot</span></button>
                </div>
              }
            </div>
            <select class="gpx-track-line-width" role="cell" [value]="track.lineWidth || 4" (change)="changeGpxTrackLineWidth(track.path, $any($event.target).value)" [attr.aria-label]="'Line width for ' + track.name">
              <option value="1">1 px</option><option value="2">2 px</option><option value="3">3 px</option>
              <option value="4">4 px</option><option value="5">5 px</option><option value="6">6 px</option>
              <option value="8">8 px</option><option value="10">10 px</option>
            </select>
            <div class="color-picker gpx-track-choice-picker" role="cell">
              <button type="button" class="color-picker-trigger gpx-track-choice-trigger" (click)="toggleGpxTrackDirectionMenu(track.path)" [attr.aria-expanded]="gpxTrackDirectionMenuOpen() === track.path" [attr.aria-label]="'Direction arrows for ' + track.name">
                <span class="gpx-track-arrow-sample" [style.color]="track.color || gpxColor()">{{ gpxDirectionSample(track.showDirection ? (track.directionStyle || 'classic') : 'off') }}</span><span>{{ gpxDirectionName(track.showDirection ? (track.directionStyle || 'classic') : 'off') }}</span><span class="color-picker-chevron">▾</span>
              </button>
              @if (gpxTrackDirectionMenuOpen() === track.path) {
                <div class="color-picker-menu gpx-track-choice-menu gpx-direction-menu" role="listbox" [attr.aria-label]="'Direction arrow styles for ' + track.name">
                  <button type="button" class="color-option gpx-track-choice-option" role="option" [attr.aria-selected]="!track.showDirection" (click)="changeGpxTrackDirection(track.path, 'off')"><span class="gpx-track-arrow-sample" [style.color]="track.color || gpxColor()">—</span><span>Off</span></button>
                  <button type="button" class="color-option gpx-track-choice-option" role="option" [attr.aria-selected]="track.showDirection && (track.directionStyle || 'classic') === 'classic'" (click)="changeGpxTrackDirection(track.path, 'classic')"><span class="gpx-track-arrow-sample" [style.color]="track.color || gpxColor()">➤</span><span>Classic · 16 px</span></button>
                  <button type="button" class="color-option gpx-track-choice-option" role="option" [attr.aria-selected]="track.directionStyle === 'chevron' && track.showDirection" (click)="changeGpxTrackDirection(track.path, 'chevron')"><span class="gpx-track-arrow-sample" [style.color]="track.color || gpxColor()">❯</span><span>Chevron · 16 px</span></button>
                  <button type="button" class="color-option gpx-track-choice-option" role="option" [attr.aria-selected]="track.directionStyle === 'triangle' && track.showDirection" (click)="changeGpxTrackDirection(track.path, 'triangle')"><span class="gpx-track-arrow-sample" [style.color]="track.color || gpxColor()">▶</span><span>Triangle · 16 px</span></button>
                  <button type="button" class="color-option gpx-track-choice-option" role="option" [attr.aria-selected]="track.directionStyle === 'thin' && track.showDirection" (click)="changeGpxTrackDirection(track.path, 'thin')"><span class="gpx-track-arrow-sample" [style.color]="track.color || gpxColor()">➜</span><span>Slim · 16 px</span></button>
                  <button type="button" class="color-option gpx-track-choice-option" role="option" [attr.aria-selected]="track.directionStyle === 'large-classic' && track.showDirection" (click)="changeGpxTrackDirection(track.path, 'large-classic')"><span class="gpx-track-arrow-sample large">➤</span><span>Classic · 24 px</span></button>
                  <button type="button" class="color-option gpx-track-choice-option" role="option" [attr.aria-selected]="track.directionStyle === 'large-chevron' && track.showDirection" (click)="changeGpxTrackDirection(track.path, 'large-chevron')"><span class="gpx-track-arrow-sample large">❯</span><span>Chevron · 24 px</span></button>
                  <button type="button" class="color-option gpx-track-choice-option" role="option" [attr.aria-selected]="track.directionStyle === 'large-triangle' && track.showDirection" (click)="changeGpxTrackDirection(track.path, 'large-triangle')"><span class="gpx-track-arrow-sample large">▶</span><span>Triangle · 24 px</span></button>
                </div>
              }
            </div>
            <button type="button" class="offline-map-remove-button" (click)="removeGpxTrack(track.path)" [attr.aria-label]="'Remove ' + track.name" title="Remove GPX track">×</button><button type="button" class="file-path-copy-button" (click)="copyFilePath(track.path)" title="Copy full file path" aria-label="Copy full file path">⧉</button>
          </div>
        }
      </div>
    }
    @if (gpxError()) { <span class="gpx-error" role="alert">{{ gpxError() }}</span> }
  </div>
</div>
</div>
<div class="settings-tab-panel" role="tabpanel" [hidden]="activeSettingsTab() !== 'timeSlider'">
  <div class="settings-tab-content time-slider-tab">
    <div class="time-slider-settings">
      @if (timeSliderHasData()) {
        <div class="time-slider-readouts">
          <span class="time-slider-min"><strong>Start:</strong> {{ formatTimeSliderDate(timeSliderStart()) }}</span>
          <span class="time-slider-duration">{{ formatTimeSliderDuration(timeSliderStart(), timeSliderEnd()) }}</span>
          <span class="time-slider-max"><strong>End:</strong> {{ formatTimeSliderDate(timeSliderEnd()) }}</span>
        </div>
        <div class="time-slider-control-row">
          <label class="time-slider-activate" title="Activate or deactivate time filtering"><input type="checkbox" aria-label="Activate Time Slider" [checked]="timeSliderActive()" (change)="changeTimeSliderActive($any($event.target).checked)"></label>
          <div class="time-slider-range" [class.disabled]="!timeSliderActive()">
          <div class="time-slider-range-track"></div>
          <div class="time-slider-range-selection" [style.left.%]="timeSliderStartPercent()" [style.width.%]="timeSliderWidthPercent()"></div>
          <input aria-label="Time range start" class="time-slider-range-input time-slider-range-start" type="range"
            [min]="timeSliderMinimum()" [max]="timeSliderMaximum()" step="1" [value]="timeSliderStart()"
            [disabled]="!timeSliderActive()" (input)="changeTimeSliderStart($any($event.target))">
          <input aria-label="Time range end" class="time-slider-range-input time-slider-range-end" type="range"
            [min]="timeSliderMinimum()" [max]="timeSliderMaximum()" step="1" [value]="timeSliderEnd()"
            [disabled]="!timeSliderActive()" (input)="changeTimeSliderEnd($any($event.target))">
          </div>
        </div>
        <details class="time-slider-animate-section">
          <summary>Animate</summary>
          <div class="time-slider-animate-options">
            <button type="button" class="time-slider-animate-button" [disabled]="!timeSliderActive() || !timeSliderHasData() || (!timeSliderAnimating() && timeSliderEnd() >= timeSliderMaximum())"
              (click)="toggleTimeSliderAnimation()">{{ timeSliderAnimating() ? 'Stop' : 'Play' }}</button>
            <label class="time-slider-walker-toggle"><input type="checkbox" [checked]="timeSliderWalkerVisible()" (change)="changeTimeSliderWalkerVisibility($any($event.target).checked)"><span>Show track symbol</span></label>
            <label class="time-slider-speed-control"><span>Symbol</span><select [value]="walkingFigureType()" (change)="changeWalkingFigureType($any($event.target).value)"><option value="walker">Walking person</option><option value="car">Car (PKW)</option><option value="taxi">Taxi</option><option value="racecar">Race car</option><option value="van">Van</option><option value="pickup">Pickup</option><option value="ambulance">Ambulance</option><option value="police">Police car</option><option value="firetruck">Fire engine</option><option value="bus">Bus</option><option value="truck">Truck</option><option value="delivery">Delivery truck</option><option value="plane">Airplane</option><option value="helicopter">Helicopter</option><option value="train">Train</option><option value="bicycle">Bicycle</option><option value="motorcycle">Motorcycle</option><option value="scooter">Scooter</option><option value="tractor">Tractor</option><option value="boat">Motorboat</option><option value="ship">Ship</option><option value="sailboat">Sailboat</option><option value="rocket">Rocket</option></select></label>
            <label class="time-slider-speed-control"><span>Animation speed</span><input type="range" min="0.1" max="10" step="0.1" [value]="timeSliderAnimationSpeed()" (input)="changeTimeSliderAnimationSpeed($any($event.target).value)"><strong>{{ timeSliderAnimationSpeed() }}×</strong></label>
            <label class="time-slider-speed-control"><span>Walking animation speed</span><input type="range" min="0.2" max="3" step="0.1" [value]="walkingFigureAnimationSpeed()" (input)="changeWalkingFigureAnimationSpeed($any($event.target).value)" [disabled]="walkingFigureType() !== 'walker'"><strong>{{ walkingFigureAnimationSpeed() }}×</strong></label>
            <label class="time-slider-speed-control"><span>Figure size</span><input type="range" min="0.5" max="3" step="0.1" [value]="walkingFigureSize()" (input)="changeWalkingFigureSize($any($event.target).value)"><strong>{{ walkingFigureSize().toFixed(1) }}×</strong></label>
          </div>
        </details>
        <details class="time-slider-minmax-section">
          <summary>MinMax</summary>
          <div class="time-slider-minmax-content">
            <div class="time-slider-boundary-box">
              <div class="time-slider-boundary-column time-slider-min">
                <div class="time-slider-boundary-value"><strong>Min:</strong> {{ formatTimeSliderDate(timeSliderMinimum()) }}</div>
                <div class="time-slider-boundary-source"><strong>Source:</strong> {{ timeSliderBoundarySource(timeSliderMinimum()) }}</div>
              </div>
              <div class="time-slider-boundary-column time-slider-duration-column">
                <div class="time-slider-duration">{{ formatTimeSliderDuration(timeSliderMinimum(), timeSliderMaximum()) }}</div>
              </div>
              <div class="time-slider-boundary-column time-slider-max">
                <div class="time-slider-boundary-value"><strong>Max:</strong> {{ formatTimeSliderDate(timeSliderMaximum()) }}</div>
                <div class="time-slider-boundary-source"><strong>Source:</strong> {{ timeSliderBoundarySource(timeSliderMaximum()) }}</div>
              </div>
            </div>
            <span class="time-slider-help">{{ timeSliderHelpText() }}</span>
          </div>
        </details>
      } @else {
        <span class="time-slider-help">Load GPX files or enable photo markers with timestamps to define the time range.</span>
      }
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
                    <div class="marker-time-range">
                      <span>Minimum timestamp: <strong>{{ markerTimestampRange().minimum }}</strong></span>
                      <span>Maximum timestamp: <strong>{{ markerTimestampRange().maximum }}</strong></span>
                    </div>
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
      <div class="range-setting" [class.setting-unavailable]="mapSource() !== 'offline' && mapSource() !== 'osmand' && mapSource() !== 'osmand-atlas'">
        <label class="visibility-toggle">Labels <input type="checkbox" [checked]="labelsVisible()" (change)="changeLabelsVisibility($any($event.target).checked)" [disabled]="mapSource() === 'online'" aria-label="Show labels"></label>
        <input id="map-label-opacity" class="opacity-slider" type="range" min="0" max="100" step="1"
          [value]="labelOpacity()" (input)="changeLabelOpacity($any($event.target).value)"
          [disabled]="mapSource() === 'osmand' || mapSource() === 'osmand-atlas'" aria-label="Map label opacity">
        <span class="range-value">{{ labelOpacity() }}%</span>
      </div>
      <div class="range-setting" [class.setting-unavailable]="activeHillshadeDatabaseCount() === 0">
        <label class="visibility-toggle">Hillshade <input type="checkbox" [checked]="hillshadeVisible()" (change)="changeHillshadeVisibility($any($event.target).checked)" [disabled]="activeHillshadeDatabaseCount() === 0" aria-label="Show Hillshade"></label>
        <input id="hillshade-opacity" class="opacity-slider" type="range" min="0" max="100" step="1"
          [value]="hillshadeOpacity()" (input)="changeHillshadeOpacity($any($event.target).value)"
          [disabled]="activeHillshadeDatabaseCount() === 0 || !hillshadeVisible()" aria-label="Hillshade opacity">
        <span class="range-value">{{ hillshadeOpacity() }}%</span>
      </div>
    </div>
  </details>
  <details class="view-rerender-section"
    [open]="renderSectionOpen()"
    (toggle)="onLocationDetailsToggle($event)"
    [class.is-rendering]="renderActiveCount() > 0 || rerenderVisibleTilesBusy()"
    [class.has-render-errors]="renderActiveCount() === 0 && !rerenderVisibleTilesBusy() && lastRenderTileCounts().failed > 0"
    [class.is-render-complete]="renderActiveCount() === 0 && !rerenderVisibleTilesBusy() && renderTotalCount() > 0 && lastRenderTileCounts().failed === 0">
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
    <div class="view-rerender-layout">
      <div class="map-cache-actions view-rerender-actions">
        <div style="display: flex; align-items: center; gap: 6px;">
          <button type="button" (click)="refreshVisibleTiles()" title="Reloads the visible tiles from the existing disk cache without forcing a new native render." [disabled]="(mapSource() !== 'osmand-atlas' && mapSource() !== 'osmand') || rerenderVisibleTilesBusy()">
            Refresh
          </button>
          <button type="button" (click)="rerenderVisibleTiles()" title="Forces a fresh native render of the visible tiles instead of using the cached tile images." [disabled]="(mapSource() !== 'osmand-atlas' && mapSource() !== 'osmand') || rerenderVisibleTilesBusy()">
            {{ rerenderVisibleTilesBusy() ? 'Rerendering…' : 'Rerender' }}
          </button>
        </div>
        <label class="visibility-toggle"><input type="checkbox" [checked]="renderVisualsEnabled()" (change)="changeRenderVisualsEnabled($any($event.target).checked)"> Show tile rendering overlay and dimming</label>
        <label class="visibility-toggle scale-visibility-toggle"><input type="checkbox" [checked]="scaleVisible()" (change)="changeScaleVisible($any($event.target).checked)"> Show map scale</label>
        @if (rerenderVisibleTilesStatus()) {
          <span class="offline-map-status" role="status">{{ rerenderVisibleTilesStatus() }}</span>
        }
      </div>
      <div class="render-tile-statistics-box">
      <table class="render-tile-statistics" aria-live="polite">
        <caption>Map tiles</caption>
        <colgroup>
          <col class="render-stat-label-column">
          <col class="render-stat-value-column">
          <col class="render-stat-value-column">
        </colgroup>
        <thead>
          <tr>
            <th scope="col" class="render-counter-heading">Render Counter</th>
            <th scope="col">Total</th>
            <th scope="col">Last</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Rendered</th>
            <td>{{ totalRenderTileCounts().rendered.toLocaleString(locale) }}</td>
            <td>{{ lastRenderTileCounts().rendered.toLocaleString(locale) }}</td>
          </tr>
          <tr>
            <th scope="row">From cache</th>
            <td>{{ totalRenderTileCounts().cached.toLocaleString(locale) }}</td>
            <td>{{ lastRenderTileCounts().cached.toLocaleString(locale) }}</td>
          </tr>
          <tr>
            <th scope="row">Errors</th>
            <td>{{ totalRenderTileCounts().failed.toLocaleString(locale) }}</td>
            <td>{{ lastRenderTileCounts().failed.toLocaleString(locale) }}</td>
          </tr>
        </tbody>
      </table>
      <table class="render-tile-statistics hillshade-render-statistics" aria-live="polite">
        <caption>Hillshade</caption>
        <thead>
          <tr>
            <th scope="col" class="render-counter-heading">Render Counter</th>
            <th scope="col">Total</th>
            <th scope="col">Last</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Rendered</th>
            <td>{{ totalHillshadeTileCounts().rendered.toLocaleString(locale) }}</td>
            <td>{{ lastHillshadeTileCounts().rendered.toLocaleString(locale) }}</td>
          </tr>
          <tr>
            <th scope="row">Errors</th>
            <td>{{ totalHillshadeTileCounts().failed.toLocaleString(locale) }}</td>
            <td>{{ lastHillshadeTileCounts().failed.toLocaleString(locale) }}</td>
          </tr>
          <tr>
            <th scope="row">In progress</th>
            <td>{{ hillshadeActiveCount().toLocaleString(locale) }}</td>
            <td>{{ hillshadeTotalCount().toLocaleString(locale) }}</td>
          </tr>
        </tbody>
      </table>
      </div>
    </div>
  </details>
</div>
</div>
<div class="settings-tab-panel" role="tabpanel" [hidden]="activeSettingsTab() !== 'hillshade'">
  <div class="settings-tab-content offline-maps-tab-content">
    <div class="mbtiles-selection offline-map-toolbar">
      <label class="offline-map-preset-control">Preset:
        <select [value]="hillshadePreset()" (change)="changeHillshadePreset($any($event.target).value)">
          <option value="austria">Austria</option><option value="austria-plus">Austria+</option><option value="europe">Europe</option><option value="all">All</option><option value="none">None</option><option value="custom">Custom</option>
        </select>
      </label>
      <button type="button" class="offline-map-add-button" (click)="addHillshadeDatabases()">Add Hillshade files...</button>
      <button type="button" class="offline-map-add-button offline-map-bulk-button" (click)="setAllHillshadeDatabasesEnabled(true)" [disabled]="hillshadeDatabaseCount() === 0">Activate all</button>
      <button type="button" class="offline-map-add-button offline-map-bulk-button" (click)="setAllHillshadeDatabasesEnabled(false)" [disabled]="hillshadeDatabaseCount() === 0">Deactivate all</button>
      <span class="offline-map-status" role="status">{{ hillshadeDatabaseCount() }} Hillshade database(s) loaded · {{ activeHillshadeDatabaseCount() }} active</span>
    </div>
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
        <option value="austria">Austria</option><option value="austria-plus">Austria+</option><option value="europe">Europe</option><option value="all">All</option><option value="none">None</option><option value="custom">Custom</option>
      </select>
    </label>
    <button class="offline-map-add-button" type="button" (click)="chooseOfflineMap()">Add offline maps...</button>
    <details class="map-cache-section offline-map-filter-section">
      <summary class="map-cache-heading">Filter</summary>
      <div class="map-cache-actions offline-map-filter-actions">
        <label class="offline-map-list-filter">Filter:
          <select [value]="offlineMapListFilter()" (change)="offlineMapListFilter.set($any($event.target).value)">
            <option value="all">All</option>
            <option value="mbtiles">MBTiles</option>
            <option value="obf">OsmAnd (.obf)</option>
            <option value="map">Mapsforge (.map)</option>
            <option value="inUse">InUse</option>
            <option value="active">Active</option>
            <option value="updates">Updates</option>
            <option value="current">Current (no update needed)</option>
            <option value="noMatch">No matching download</option>
          </select>
        </label>
        <button class="offline-map-add-button offline-map-bulk-button" type="button" (click)="clearOfflineMapsList()" [disabled]="filteredOfflineMaps().length === 0">Clear visible maps</button>
        <button class="offline-map-add-button offline-map-bulk-button" type="button" (click)="setAllOfflineMapsEnabled(true)" [disabled]="filteredOfflineMaps().length === 0">Activate visible maps</button>
        <button class="offline-map-add-button offline-map-bulk-button" type="button" (click)="setAllOfflineMapsEnabled(false)" [disabled]="filteredOfflineMaps().length === 0">Deactivate visible maps</button>
      </div>
    </details>
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
      <div class="map-cache-row"><span>PNG tiles</span><strong>{{ osmAndTileCache().entries.toLocaleString(locale) }}</strong></div>
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
      <div class="mbtiles-map-table-wrap download-source-table-wrap">
        <table class="mbtiles-map-table download-source-table">
          <thead><tr><th>URL</th><th>Filetype</th><th>Use for updates</th><th></th></tr></thead>
          <tbody>
            @for (source of downloadSources(); track $index; let i = $index) {
              <tr>
                <td class="download-source-url"><input type="url" [value]="source.url" (change)="updateDownloadSource(i, { url: $any($event.target).value })" aria-label="Download source URL"></td>
                <td><select [value]="source.fileType" (change)="updateDownloadSource(i, { fileType: $any($event.target).value })" aria-label="Download source filetype"><option value="obf">OBF</option><option value="mbtiles">MBTiles</option><option value="mapsforge">MapsForge</option><option value="android">Android</option><option value="others">Others</option></select></td>
                <td class="mbtiles-enabled-column"><input type="checkbox" [checked]="source.useForUpdates" (change)="updateDownloadSource(i, { useForUpdates: $any($event.target).checked })" aria-label="Use for updates"></td>
                <td><button type="button" class="file-path-copy-button" (click)="copyFilePath(source.url)" title="Copy URL" aria-label="Copy URL">⧉</button><button type="button" class="gpx-open-button" (click)="openDownloadSource(source.url)" [disabled]="!isValidDownloadUrl(source.url)" title="Open download source" aria-label="Open download source">↗</button><button type="button" (click)="removeDownloadSource(i)" aria-label="Remove download source">Remove</button></td>
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
      @if (mapDisplayNotice() && (!settingsOpen() || (activeSettingsTab() !== 'offlineMaps' && activeSettingsTab() !== 'hillshade'))) {
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
                  <thead><tr><th class="mbtiles-inuse-column">InUse</th><th class="mbtiles-enabled-column">Active</th><th class="mbtiles-type-column">Type</th><th>Map file</th><th>File size</th><th>Last modified</th><th class="mbtiles-updates-column">Updates</th><th>Bounds</th><th>Zoom</th><th></th><th></th></tr></thead>
                  <tbody>
                    @for (map of filteredOfflineMaps(); track map.id) {
                      <tr [class.mbtiles-map-disabled]="!map.enabled" [class.obf-map-row]="map.type === 'obf'" [class.mbtiles-map-row]="map.type !== 'obf'">
                        <td class="mbtiles-inuse-column"><span class="mbtiles-inuse-symbol" [class.in-use]="isOfflineMapInUse(map)" [attr.title]="isOfflineMapInUse(map) ? 'Currently used by the selected map source' : 'Not used by the selected map source'" [attr.aria-label]="isOfflineMapInUse(map) ? 'In use' : 'Not in use'">{{ isOfflineMapInUse(map) ? '●' : '—' }}</span></td>
                        <td class="mbtiles-enabled-column"><input type="checkbox" [checked]="map.enabled" [title]="'Preselect offline map ' + map.name" (change)="setOfflineMapEnabled(map.id, $any($event.target).checked)" [attr.aria-label]="'Active offline map ' + map.name"></td>
                        <td><i class="offline-map-format-tag" [class.obf-format-tag]="map.type === 'obf'" [class.mbtiles-format-tag]="map.type === 'mbtiles' || !map.type" [class.mapsforge-format-tag]="map.type === 'mapsforge'">{{ map.type === 'obf' ? 'OBF' : map.type === 'mapsforge' ? 'Mapsforge' : 'MBTiles' }}</i></td>
                        <td class="mbtiles-map-file" [title]="map.filePath"><strong>{{ map.name }}</strong>@if (map.fileName !== map.name) { <span>{{ map.fileName }}</span> }</td>
                        <td class="mbtiles-map-number">{{ formatOfflineMapSize(map.fileSize) }}</td>
                        <td class="mbtiles-map-number">{{ formatOfflineMapDate(map.lastModified) }}</td>
                        <td class="mbtiles-updates-column"><span class="mbtiles-update-symbol" [class.update-available]="map.updateAvailable === true" [class.update-current]="map.updateAvailable === false" [class.update-unknown]="map.updateChecked && map.updateAvailable === null && map.updateMatched !== false" [class.update-no-match]="map.updateChecked && map.updateMatched === false" [attr.title]="map.updateAvailable === true ? 'Update available · ' + (map.updateDate || 'newer version') + ' · ' + (map.updateSource || 'source') : map.updateAvailable === false ? 'No newer version listed · ' + (map.updateSource || 'source') : map.updateMatched === true ? (map.updateDate ? 'Matched catalogue file · ' + map.updateDate + ' · ' + (map.updateSource || 'source') : 'Matched catalogue file · no catalogue date available · ' + (map.updateSource || 'source')) : map.updateChecked ? 'No matching filename found in the available catalogues' : 'Not checked yet'" [attr.aria-label]="map.updateAvailable === true ? 'Update available' : map.updateAvailable === false ? 'No update available' : map.updateMatched === true ? 'Catalogue file matched' : map.updateChecked ? 'No catalogue match' : 'Not checked'">{{ map.updateAvailable === true ? '↑' : map.updateAvailable === false ? '✓' : map.updateChecked && map.updateMatched === false ? '?' : map.updateChecked && map.updateMatched === true && map.updateAvailable === null ? '✓' : '—' }}</span></td>
                        <td class="mbtiles-map-bounds">{{ map.bounds }}</td>
                        <td class="mbtiles-map-number">{{ map.minZoom }}–{{ map.maxZoom }}</td>
                        <td><button type="button" class="file-path-copy-button" (click)="copyFilePath(map.filePath)" title="Copy full file path" aria-label="Copy full file path">⧉</button></td>
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
        @if (settingsOpen() && activeSettingsTab() === 'hillshade') {
          <div class="offline-map-list-view">
            <div class="mbtiles-map-list">
              @if (hillshadeDatabases().length > 0) {
                <table class="mbtiles-map-table hillshade-map-table">
                  <thead><tr><th class="mbtiles-enabled-column">Active</th><th>Hillshade file</th><th>Last modified</th><th>File size</th><th>Status</th><th></th><th></th></tr></thead>
                  <tbody>
                    @for (database of hillshadeDatabases(); track database.id) {
                      <tr [class.mbtiles-map-disabled]="!database.enabled || !database.available">
                        <td class="mbtiles-enabled-column"><input type="checkbox" [checked]="database.enabled" [disabled]="!database.available" (change)="setHillshadeDatabaseEnabled(database.id, $any($event.target).checked)" [attr.aria-label]="'Active Hillshade database ' + database.path"></td>
                        <td class="hillshade-file-name" [title]="database.path"><strong>{{ hillshadeDatabaseFileName(database.path) }}</strong></td>
                        <td>{{ formatHillshadeLastModified(database.lastModified) }}</td>
                        <td class="mbtiles-map-number">{{ database.sizeBytes === null ? '—' : formatOfflineMapSize(database.sizeBytes) }}</td>
                        <td>{{ database.available ? (database.enabled ? 'Active' : 'Inactive') : 'File not found' }}</td>
                        <td><button type="button" class="file-path-copy-button" (click)="copyFilePath(database.path)" title="Copy full file path" aria-label="Copy full file path">⧉</button></td>
                        <td><button type="button" class="mbtiles-remove-button" (click)="removeHillshadeDatabase(database.id)">Remove</button></td>
                      </tr>
                    }
                  </tbody>
                </table>
              } @else { <span class="offline-map-status">No Hillshade databases loaded. Use “Add Hillshade files...” above.</span> }
            </div>
          </div>
        }
        <div #map class="map" [class.map-hidden]="!coordinatesAvailable() || (settingsOpen() && (activeSettingsTab() === 'offlineMaps' || activeSettingsTab() === 'hillshade'))" [style.opacity]="overlayMode ? overlayOpacity() / 100 : 1"></div>
        @if (!coordinatesAvailable() && (!settingsOpen() || (activeSettingsTab() !== 'offlineMaps' && activeSettingsTab() !== 'hillshade'))) {
          <div class="map-unavailable" role="status">GPS coordinates are not available for this image.</div>
        }
        @if (renderInitStatus() && (!settingsOpen() || (activeSettingsTab() !== 'offlineMaps' && activeSettingsTab() !== 'hillshade'))) {
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
    :host ::ng-deep .maplibregl-ctrl-bottom-left{z-index:40!important;pointer-events:none}:host ::ng-deep .leaflet-bottom.leaflet-left{z-index:1000!important;pointer-events:none}
    :host ::ng-deep .maplibregl-ctrl-bottom-left .maplibregl-ctrl,:host ::ng-deep .leaflet-bottom.leaflet-left .leaflet-control{pointer-events:auto}
    :host ::ng-deep .maplibregl-ctrl-scale,:host ::ng-deep .leaflet-control-scale-line{opacity:.85;transition:opacity .15s ease;background:rgba(255,255,255,.94);color:#111;border:1px solid rgba(0,0,0,.88);box-shadow:0 1px 3px rgba(0,0,0,.45);font-size:10px;font-weight:700;text-shadow:none;padding:2px 5px}
    :host ::ng-deep .maplibregl-ctrl-scale:hover,:host ::ng-deep .leaflet-control-scale-line:hover{opacity:1}
    .scale-visibility-toggle{flex-basis:100%;margin-left:0}
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
    .view-rerender-section{display:flex;flex-direction:column;gap:7px;width:100%;min-width:0;padding:7px 8px 8px;border:1px solid var(--color-content-default-low,#454545);border-radius:6px;background:transparent;transition:background-color 140ms ease,border-color 140ms ease}
    .view-rerender-section.is-rendering{background:rgba(55,125,190,.13);border-color:rgba(75,145,210,.38)}
    .view-rerender-section.is-render-complete{background:rgba(45,150,75,.10);border-color:rgba(65,165,95,.32)}
    .view-rerender-section.has-render-errors{background:rgba(180,55,55,.14);border-color:rgba(205,75,75,.42)}
    .view-rerender-section>summary{display:flex;align-items:center;gap:12px;cursor:pointer;font-weight:700;white-space:nowrap;list-style:disclosure-closed}
    .view-rerender-section>summary .render-progress-always{flex:1 1 auto;width:auto;max-width:520px;margin-left:auto;padding:0;min-height:20px}
    .view-rerender-section[open]>summary{margin-bottom:2px}
    .gpx-settings-content{display:flex;flex-direction:column;align-items:flex-start;gap:8px;width:100%;min-width:0}
    .time-slider-settings{display:flex;flex-direction:column;align-items:stretch;gap:12px;width:min(100%,1100px);padding:6px 2px;user-select:text;-webkit-user-select:text}
    .time-slider-control-row{display:grid;grid-template-columns:20px minmax(0,1fr);align-items:center;gap:10px}
    .time-slider-activate{display:flex;align-items:center;justify-content:center;margin:0;cursor:pointer}
    .time-slider-activate input{margin:0}
    .time-slider-readouts{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:12px;font-size:12px;font-variant-numeric:tabular-nums}
    .time-slider-readouts .time-slider-min{text-align:left}
    .time-slider-readouts .time-slider-max{text-align:right}
    .time-slider-duration{text-align:center;white-space:nowrap;font-size:12px;font-weight:700;color:#000;font-variant-numeric:tabular-nums}
    .time-slider-boundary-box{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:16px;border:1px solid var(--color-content-default-low,#666);border-radius:6px;padding:8px 10px;font-variant-numeric:tabular-nums;min-width:0}
    .time-slider-duration-column{align-items:center;justify-content:center;white-space:nowrap}
    .time-slider-boundary-column{display:flex;flex-direction:column;gap:4px;min-width:0}
    .time-slider-min{--time-slider-boundary-color:#1d78b8;color:var(--time-slider-boundary-color)}
    .time-slider-max{--time-slider-boundary-color:#c87525;color:var(--time-slider-boundary-color)}
    .time-slider-boundary-value{font-size:12px;overflow-wrap:anywhere}
    .time-slider-boundary-source{font-size:11px;color:inherit;opacity:.82;overflow-wrap:anywhere}
    .time-slider-range{position:relative;height:30px;display:grid;align-items:center;margin:0 10px}
    .time-slider-range-track{position:absolute;top:50%;left:0;right:0;height:5px;transform:translateY(-50%);border-radius:5px;background:var(--color-content-default-low,#555)}
    .time-slider-range-selection{position:absolute;top:50%;height:5px;transform:translateY(-50%);border-radius:5px;background:var(--color-accent,#2688e8);pointer-events:none}
    .time-slider-range-input{position:absolute;top:50%;left:0;right:0;width:100%;height:5px;margin:0;transform:translateY(-50%);background:transparent;appearance:none;-webkit-appearance:none;pointer-events:none;z-index:2}
    .time-slider-range-input::-webkit-slider-runnable-track{height:5px;background:transparent}
    .time-slider-range-input::-moz-range-track{height:5px;background:transparent}
    .time-slider-range-input.time-slider-range-start::-webkit-slider-thumb{width:13px;height:22px;margin-top:-8.5px;transform:translateX(-6.5px);border:2px solid #fff;border-radius:12px 0 0 12px;background:#1d78b8;box-shadow:0 1px 4px #0008;appearance:none;-webkit-appearance:none;pointer-events:auto;cursor:ew-resize}
    .time-slider-range-input.time-slider-range-end::-webkit-slider-thumb{width:13px;height:22px;margin-top:-8.5px;transform:translateX(6.5px);border:2px solid #fff;border-radius:0 12px 12px 0;background:#c87525;box-shadow:0 1px 4px #0008;appearance:none;-webkit-appearance:none;pointer-events:auto;cursor:ew-resize}
    .time-slider-range-input.time-slider-range-start::-moz-range-thumb{width:9px;height:18px;transform:translateX(-6.5px);border:2px solid #fff;border-radius:12px 0 0 12px;background:#1d78b8;box-shadow:0 1px 4px #0008;pointer-events:auto;cursor:ew-resize}
    .time-slider-range-input.time-slider-range-end::-moz-range-thumb{width:9px;height:18px;transform:translateX(6.5px);border:2px solid #fff;border-radius:0 12px 12px 0;background:#c87525;box-shadow:0 1px 4px #0008;pointer-events:auto;cursor:ew-resize}
    .time-slider-range-input:disabled::-webkit-slider-thumb,.time-slider-range-input:disabled::-moz-range-thumb{opacity:.45;cursor:default}
    .time-slider-range.disabled{opacity:.55}
    .time-slider-animate-button{flex:0 0 auto;min-width:76px;padding:5px 12px;border:1px solid var(--color-border-default,#777);border-radius:5px;background:var(--color-background-default,#333);color:var(--color-content-default,#fff);font:inherit;cursor:pointer}
    .time-slider-animate-button:disabled{opacity:.45;cursor:default}
    .time-slider-animate-section,.time-slider-minmax-section{display:flex;flex-direction:column;align-items:stretch;gap:7px;width:100%;min-width:0;margin-top:0;padding:7px 0 0;border-top:1px solid var(--color-content-default-low,#454545)}.time-slider-minmax-section{padding-top:0;border-top:0}
    .time-slider-animate-section>summary,.time-slider-minmax-section>summary{color:#000}
    .time-slider-minmax-content{display:flex;flex-direction:column;gap:7px;padding-top:7px}
    .time-slider-range{user-select:none;-webkit-user-select:none}
    .time-slider-animate-options{display:flex;align-items:center;gap:20px;padding:8px 0 3px;flex-wrap:wrap}
    .time-slider-walker-toggle{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-size:12px;color:#000;cursor:pointer}.time-slider-walker-toggle input{accent-color:var(--color-accent,#2688e8);margin:0}
    .time-slider-speed-control{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--color-content-default-medium,#aaa);flex:1;min-width:220px}.time-slider-speed-control input{flex:1;min-width:90px;accent-color:var(--color-accent,#2688e8)}.time-slider-speed-control strong{min-width:24px;text-align:right;color:var(--color-content-default,#fff)}
    .lumascope-walker-icon{background:transparent;border:0}.lumascope-walker{width:24px;height:30px;max-width:24px;max-height:30px;position:relative;filter:drop-shadow(0 1px 1px #000b);transform-origin:50% 50%;will-change:transform}.lumascope-walker svg{display:block;width:24px!important;height:30px!important;max-width:24px;max-height:30px;overflow:visible}.lumascope-walker .walker-limb{transform-box:fill-box;transform-origin:top center;animation:walker-step var(--walker-animation-duration,.72s) ease-in-out infinite alternate}.lumascope-walker .walker-arm{animation-duration:var(--walker-animation-duration,.72s)}.lumascope-walker .walker-leg{animation-duration:var(--walker-animation-duration,.72s)}.lumascope-walker .walker-leg.back,.lumascope-walker .walker-arm.back{animation-direction:alternate-reverse}@keyframes walker-step{from{transform:rotate(-16deg)}to{transform:rotate(16deg)}}
    .time-slider-help{font-size:12px;color:var(--color-content-default-medium,#aaa)}
    .gpx-toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;width:100%}
    .gpx-file-list{display:flex;flex-direction:column;gap:0;width:100%;border-top:1px solid var(--color-content-default-low,#666);border-bottom:1px solid var(--color-content-default-low,#666);border-left:0;border-right:0;border-radius:0;padding:4px 0;box-sizing:border-box}
    .gpx-file-row{display:grid;grid-template-columns:58px 42px minmax(180px,1fr) minmax(135px,175px) minmax(245px,290px) minmax(75px,95px) 132px 150px 68px minmax(150px,190px) 32px 28px;align-items:center;gap:8px;padding:6px 4px;border-bottom:1px solid var(--color-content-default-low,#454545);min-width:0}
    .gpx-file-row:last-child{border-bottom:0}.gpx-file-row.gpx-missing{color:#ff5b5b;background:color-mix(in srgb,#e53935 9%,transparent)}.gpx-file-row.gpx-missing .gpx-file-name{color:#ff5b5b}.gpx-file-row.gpx-hovered{background:color-mix(in srgb,var(--color-accent,#2688e8) 10%,transparent);outline:1px solid color-mix(in srgb,var(--color-accent,#2688e8) 22%,transparent);outline-offset:-1px}.gpx-hover-info{font-size:12px;color:var(--color-content-default-medium,#bbb);font-variant-numeric:tabular-nums;white-space:nowrap}
    .gpx-file-header{font-weight:700;color:var(--color-content-default-medium,#aaa)}
    .gpx-time-range{font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .marker-time-range{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;font-variant-numeric:tabular-nums}
    .file-path-copy-button{width:23px;height:22px;padding:0;border:1px solid var(--color-content-default-low,#666);border-radius:4px;background:var(--color-surface-default-low,#252525);color:var(--color-content-default-medium,#bbb);font-size:14px;line-height:18px;cursor:pointer}.file-path-copy-button:hover{background:var(--color-surface-default-medium,#444);color:var(--color-content-default,#fff);border-color:var(--color-content-default-medium,#999)}
    .gpx-row-actions{display:flex;align-items:center;justify-content:center;gap:3px}.gpx-fit-button,.gpx-open-button{justify-self:center;width:24px;height:22px;padding:0;border:1px solid var(--color-content-default-low,#666);border-radius:4px;background:var(--color-surface-default-low,#252525);color:var(--color-content-default,#eee);font-size:15px;line-height:18px;cursor:pointer}.gpx-fit-button:hover,.gpx-open-button:hover{background:var(--color-surface-default-medium,#444);border-color:var(--color-content-default-medium,#999)}.gpx-open-button{width:24px;height:22px;padding:0;border:1px solid var(--color-content-default-low,#666);border-radius:4px;background:var(--color-surface-default-low,#252525);color:var(--color-content-default,#eee);font-size:15px;line-height:18px;cursor:pointer}.gpx-open-button:disabled{opacity:.35;cursor:default}.gpx-active-toggle{display:flex;align-items:center;justify-content:center}.gpx-active-toggle input{margin:0}.gpx-file-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .gpx-file-row>span:not(:first-child){white-space:nowrap;font-variant-numeric:tabular-nums}
    .gpx-file-row .offline-map-remove-button{justify-self:end}.gpx-track-color-picker .color-picker-trigger{min-width:0;width:100%;max-width:132px;padding:3px 5px;gap:5px}.gpx-track-color-picker .color-swatch{min-width:0;padding:3px 4px}.gpx-track-color-picker .color-picker-menu{min-width:160px}.gpx-file-row select{min-width:0;max-width:100%;width:100%}
    @media(max-width:900px){.gpx-file-list{overflow-x:auto}.gpx-file-row{min-width:1360px;grid-template-columns:54px 30px minmax(140px,1fr) 90px minmax(245px,290px) 65px 120px 105px 62px 150px 32px 28px;gap:4px}.gpx-file-row select{max-width:100%;min-width:0;padding:3px 2px;font-size:11px}.gpx-direction-arrow-icon{background:transparent;border:0}.gpx-direction-arrow{display:block;font-size:15px;line-height:16px;font-weight:700;text-shadow:-1px -1px 2px #fff,1px 1px 2px #fff;}}
    .view-rerender-section .view-rerender-layout{display:flex;align-items:flex-start;justify-content:flex-start;gap:12px;min-width:0}
    .view-rerender-section .view-rerender-actions{display:flex;flex-direction:column;align-items:flex-start;justify-content:flex-start;gap:8px;min-width:0}
    .view-rerender-section .view-rerender-actions .visibility-toggle{align-self:flex-start}
    .view-rerender-section .offline-map-status{max-width:none;flex:0 0 auto}
    @media(max-width:620px){.view-rerender-section .view-rerender-layout{flex-wrap:wrap}.view-rerender-section .render-tile-statistics-box{max-width:100%}}
    .render-tile-statistics-box{width:max-content;max-width:100%;margin-left:auto;overflow-x:auto;border:1px solid var(--color-content-default-low,#666);border-radius:6px;padding:6px 8px;background:var(--color-surface-default-low,#202124)}
    .render-tile-statistics-title{font-weight:700;font-size:13px;margin:0 0 3px 2px}
    .render-tile-statistics{display:table;width:auto;table-layout:fixed;border-collapse:collapse;font-variant-numeric:tabular-nums}
    .render-tile-statistics .render-stat-label-column{width:130px}
    .render-tile-statistics .render-stat-value-column{width:150px}
    .render-tile-statistics th,.render-tile-statistics td{padding:5px 10px;text-align:left;white-space:nowrap;border-bottom:1px solid var(--color-content-default-low,#454545)}
    .render-tile-statistics thead th{font-weight:700}
    .render-tile-statistics tbody tr:last-child th,.render-tile-statistics tbody tr:last-child td{border-bottom:0}
    .render-tile-statistics tbody th{font-weight:400;color:var(--color-content-default-medium,#aaa)}

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
    .mbtiles-download-source{min-width:0;max-width:100%;}.mbtiles-download-controls{display:flex;flex-direction:row;align-items:center;gap:8px;flex-wrap:nowrap;}.mbtiles-download-controls .mbtiles-download-source{flex:0 0 280px;min-width:260px;}.mbtiles-download-url{display:block;box-sizing:border-box;height:28px;line-height:normal;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1 1 240px;width:0;min-width:0;max-width:100%;}.osmand-resources-picker{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 0;}.osmand-resources-path{flex:1 1 360px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}.osmand-resources-picker p{flex-basis:100%;margin:0;color:var(--color-text-secondary);font-size:11px;}.offline-map-clear-button{background:var(--color-surface-default-high,#454b55);color:var(--color-content-default-medium,#c5cbd3);border-color:var(--color-content-default-low,#626a75)}.offline-map-bulk-button{font-size:10px;padding:4px 8px;background:var(--color-surface-default-high,#454b55);color:var(--color-content-default-medium,#c5cbd3);border-color:var(--color-content-default-low,#626a75)}.offline-maps-tab-content{display:flex;flex-direction:column;gap:8px;min-width:0}.offline-map-updates-section{margin:0}.offline-map-update-actions{align-items:center;flex-wrap:wrap}.offline-map-update-actions .offline-map-status{flex:1 1 300px;min-width:0}.offline-map-toolbar{display:flex;flex-direction:row;align-items:center;justify-content:flex-start;gap:8px;flex-wrap:wrap;}.offline-map-toolbar .offline-map-preset-control{display:flex;align-items:center;gap:6px;flex:0 0 auto;}.offline-map-toolbar .offline-map-add-button{align-self:center}.offline-map-filter-section{flex:0 0 100%;max-width:none;padding:2px 0}.offline-map-filter-actions{justify-content:flex-start;flex-wrap:wrap;gap:8px}.offline-map-filter-actions .offline-map-list-filter{display:flex;align-items:center;gap:6px;order:0}.offline-map-filter-actions .offline-map-bulk-button{order:1}.offline-map-add-button{width:auto;min-width:0;flex:0 0 auto;padding:6px 10px;white-space:nowrap;}
    .mbtiles-selection{display:flex;flex:1 1 auto;flex-direction:column;align-items:stretch;gap:8px;min-width:0;min-height:0}
    .mbtiles-selection.offline-map-toolbar{flex-direction:row;align-items:center}
    .mbtiles-selection.mbtiles-download-controls{flex-direction:row;align-items:center;flex-wrap:nowrap}
    .mbtiles-map-list{flex:0 0 auto;grid-column:1/-1;width:100%;min-width:0;max-width:100%;height:auto;max-height:none;overflow:visible;overscroll-behavior:contain}
    .obf-map-row{background:rgba(56,139,253,.10)}.mbtiles-map-row{background:rgba(46,160,67,.07)}.offline-map-format-tag{display:inline-block;margin-right:5px;padding:1px 5px;border-radius:3px;font-style:normal;font-size:10px;font-weight:700;letter-spacing:.04em}.obf-format-tag{background:#174b78;color:#c8e5ff}.mbtiles-format-tag{background:#245b35;color:#c9f7d2}.mapsforge-format-tag{background:#65451f;color:#ffe0ad}
    .mbtiles-map-table{width:100%;min-width:780px;border-collapse:collapse;font-size:11px;white-space:nowrap;font-variant-numeric:tabular-nums}
    .download-source-table{min-width:0!important;width:100%!important;max-width:none;table-layout:fixed}.download-source-table-wrap{display:block;width:100%!important;max-width:none;min-width:0;overflow-x:auto;flex:1 1 100%;align-self:stretch}.download-section{width:100%;max-width:none;min-width:0;box-sizing:border-box}.download-source-table th:first-child,.download-source-table td:first-child{width:56%}.download-source-table th:nth-child(2),.download-source-table td:nth-child(2){width:22%}.download-source-table th:nth-child(3),.download-source-table td:nth-child(3){width:10%}.download-source-table th:nth-child(4),.download-source-table td:nth-child(4){width:12%}.download-source-table td{box-sizing:border-box}.download-source-url input{display:block;width:100%;min-width:0;max-width:100%;box-sizing:border-box}.offline-catalogue-toolbar{margin-top:14px}
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
    .download-source-url{min-width:0;width:auto}.download-source-url input{width:100%;min-width:0;box-sizing:border-box}.download-source-table select{width:100%;max-width:100%;min-width:0;box-sizing:border-box}
    .mbtiles-map-table{min-width:850px;table-layout:fixed}.hillshade-map-table{min-width:0;width:100%;max-width:100%;table-layout:fixed;font-size:12px}.hillshade-map-table th,.hillshade-map-table td{padding:3px 5px;white-space:nowrap}.hillshade-map-table th:nth-child(1),.hillshade-map-table td:nth-child(1){width:42px}.hillshade-map-table th:nth-child(2),.hillshade-map-table td:nth-child(2){width:auto;min-width:0}.hillshade-map-table th:nth-child(3),.hillshade-map-table td:nth-child(3){width:145px}.hillshade-map-table th:nth-child(4),.hillshade-map-table td:nth-child(4){width:85px}.hillshade-map-table th:nth-child(5),.hillshade-map-table td:nth-child(5){width:90px}.hillshade-map-table th:nth-child(6),.hillshade-map-table td:nth-child(6){width:65px}.hillshade-file-name{max-width:none;overflow:hidden;text-overflow:ellipsis;cursor:default}.mbtiles-updates-column{width:58px;text-align:center!important}.mbtiles-update-symbol{display:inline-block;min-width:20px;font-size:19px;font-weight:900;line-height:1.2;color:var(--color-content-default-medium,#999)}.mbtiles-update-symbol.update-available{color:#4da3ff}.mbtiles-update-symbol.update-current{color:#55c878}.mbtiles-update-symbol.update-no-match{color:#ff6b6b}.mbtiles-update-symbol.update-unknown{color:#e5b85c}
    .memory-process-table{width:100%;table-layout:fixed;border-collapse:collapse;font-size:11px;font-variant-numeric:tabular-nums}
    .memory-process-table th,.memory-process-table td{box-sizing:border-box;padding:5px 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .memory-process-table th:first-child,.memory-process-table td:first-child{text-align:left}
    .memory-process-table th:not(:first-child),.memory-process-table td:not(:first-child){text-align:right}
    .mbtiles-map-table th,.mbtiles-map-table td{padding:5px 8px;border-bottom:1px solid var(--color-content-default-low,#454545);text-align:left;vertical-align:middle}
    .mbtiles-map-table th{position:sticky;top:0;z-index:1;font-weight:600;color:var(--color-content-default-medium,#aaa);background:var(--color-surface-default-medium,#343943)}
    .mbtiles-map-table .mbtiles-enabled-column{width:42px;text-align:center}
    .mbtiles-map-table .mbtiles-type-column{width:112px;min-width:112px;box-sizing:border-box}
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
    .opacity-content .range-setting{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-rows:auto auto;align-items:center;column-gap:5px;row-gap:4px;flex:1 1 0;min-width:0;max-width:none;box-sizing:border-box;padding:6px 8px;border:1px solid var(--color-border-subtle,rgba(128,128,128,.22));border-radius:8px;background:var(--color-surface-secondary,rgba(128,128,128,.085));box-shadow:inset 0 1px 0 rgba(255,255,255,.035)}
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
    .opacity-content .range-setting>input.opacity-slider[type="range"]{grid-column:1/-1;grid-row:2;align-self:center;flex:1 1 auto;width:100%;max-width:none;min-width:0;margin:0;accent-color:#c084fc}
    .opacity-content .range-setting>input.opacity-slider[type="range"]:disabled{accent-color:#8b739d}
    .opacity-content .range-setting .visibility-toggle{display:inline-flex;align-items:center;gap:3px;flex:0 0 auto;white-space:nowrap;font-weight:500;min-width:0}
    .opacity-content .range-setting>label,.opacity-content .range-setting>.visibility-toggle{grid-column:1;grid-row:1;min-width:0}
    .opacity-content .range-setting>.range-value{grid-column:2;grid-row:1;justify-self:end;white-space:nowrap;font-variant-numeric:tabular-nums}
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
    .color-option{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:0;background:transparent}.color-option[aria-selected=true]{outline:1px solid #8ab4f8}\n    .gpx-track-choice-picker{min-width:0;width:100%}.gpx-track-choice-trigger{display:grid!important;grid-template-columns:92px minmax(0,1fr) 12px;align-items:center;gap:5px;width:100%;min-width:0;max-width:none;padding:3px 5px}.gpx-track-choice-trigger>span:nth-child(2){overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}.gpx-track-choice-menu{width:230px;min-width:230px}.gpx-track-choice-option{display:grid;grid-template-columns:105px minmax(0,1fr);align-items:center;gap:8px;padding:4px 6px;min-height:27px}.gpx-track-choice-option>span:last-child{white-space:nowrap}.gpx-track-choice-sample{display:block;width:105px;overflow:hidden;white-space:nowrap;font:12px/1.2 ui-monospace,monospace;letter-spacing:-.5px;text-align:left}.gpx-track-arrow-sample{display:flex;align-items:center;justify-content:center;width:105px;font:700 17px/1 Arial,sans-serif}.gpx-track-arrow-sample.large{font-size:24px}.gpx-direction-menu{width:220px;min-width:220px}
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
    /* Override the generic flex layout above: each opacity card has a header row and a full-width slider row. */
    .opacity-settings .opacity-content>.range-setting{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-rows:auto auto;align-items:center;column-gap:5px;row-gap:4px;gap:4px}
    .opacity-settings .opacity-content>.range-setting>label,
    .opacity-settings .opacity-content>.range-setting>.visibility-toggle{grid-column:1;grid-row:1;min-width:0}
    .opacity-settings .opacity-content>.range-setting>.range-value{grid-column:2;grid-row:1;justify-self:end;white-space:nowrap;margin:0;min-width:0}
    .opacity-settings .opacity-content>.range-setting>input.opacity-slider[type=range]{grid-column:1/-1;grid-row:2;align-self:center;width:100%;max-width:none;min-width:0;margin:0}
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
  readonly locale = navigator.language;

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
  private walkingMarker: MapMarker | null = null;
  private walkingMapLibreMarker: MapLibreMarker | null = null;
  private directoryMarkerGroup: MapMarkerGroup | null = null;
  private readonly directoryMarkers: MapMarker[] = [];
  private currentImagePath: string | null = null;
  private currentOfflineMapId: string | null = null;
  private markerScanGeneration = 0;
  private leaflet: LeafletMapApi | null = null;
  private leafletHillshadeLayer: LeafletGridLayer | null = null;
  private leafletHillshadePane: HTMLElement | null = null;
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
  protected readonly hasDirectoryPhotoMarkers = (): boolean => this.directoryPhotoMarkers.length > 0;
  private readonly gpxSegmentsByTrack = new Map<string, [number, number][][]>();
  private readonly gpxPointDataByTrack = new Map<string, GpxTrackPoint[][]>();
  private directoryPhotoMarkers: Array<OfflinePhotoMarker & { gpsTimestamp?: number | null }> = [];
  private directoryPhotoTimestampMarkers: Array<OfflinePhotoMarker & { gpsTimestamp?: number | null }> = [];
  private timeSliderRangeInitialized = false;
  private readonly storagePrefix = 'mapWindow.';
  protected readonly selectSettingsTab = (tab: 'location' | 'track' | 'timeSlider' | 'marker' | 'view' | 'offlineMaps' | 'hillshade' | 'cache' | 'memory' | 'download' | 'errors'): void => {
    this.activeSettingsTab.set(tab);
    this.persistLocationUiState({ activeSettingsTab: tab });
    if (tab === 'memory') void this.refreshProcessMemory();
  };
  protected readonly settingsOpen = signal(false);
  protected readonly activeSettingsTab = signal<'location' | 'track' | 'timeSlider' | 'marker' | 'view' | 'offlineMaps' | 'hillshade' | 'cache' | 'memory' | 'download' | 'errors'>('location');
  protected readonly renderVisualsEnabled = signal(this.readSetting('renderVisualsEnabled', 'true') === 'true');
  protected readonly scaleVisible = signal(this.readSetting('scaleVisible', 'true') === 'true');
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
  private readonly currentTileRequestResults = new Map<string, 'pending' | 'cached'>();
  protected readonly totalRenderTileCounts = signal({ rendered: 0, cached: 0, failed: 0 });
  protected readonly lastRenderTileCounts = signal({ rendered: 0, cached: 0, failed: 0 });
  protected readonly hillshadeActiveCount = signal(0);
  protected readonly hillshadeTotalCount = signal(0);
  protected readonly totalHillshadeTileCounts = signal({ rendered: 0, failed: 0 });
  protected readonly lastHillshadeTileCounts = signal({ rendered: 0, failed: 0 });
  private readonly activeHillshadeTiles = new Set<string>();
  private readonly seenHillshadeTiles = new Set<string>();
  private readonly persistLocationUiState = (patch: Record<string, unknown>): void => {
    void this.desktop?.ProcessManager.setAppSettingsSection('mapWindow', patch)
      .catch(error => console.warn('[Location] Could not persist window UI state:', error));
  };
  protected readonly changeScaleVisible = (visible: boolean): void => {
    this.scaleVisible.set(visible);
    this.saveSetting('scaleVisible', visible);
    this.persistLocationUiState({ scaleVisible: visible });
    this.applyScaleVisibility();
  };
  private applyScaleVisibility(): void {
    const visible = this.scaleVisible();
    this.offlineRenderer?.setScaleVisible(visible);
    const mapElement = this.mapElement().nativeElement;
    const leafletScale = mapElement.querySelector<HTMLElement>('.leaflet-control-scale');
    if (leafletScale) leafletScale.style.display = visible ? '' : 'none';
    const leafletControls = mapElement.querySelector<HTMLElement>('.leaflet-bottom.leaflet-left');
    if (leafletControls) {
      leafletControls.style.zIndex = '1000';
      leafletControls.style.pointerEvents = 'none';
      const control = leafletControls.querySelector<HTMLElement>('.leaflet-control');
      if (control) control.style.pointerEvents = 'auto';
    }
  }
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
      this.currentTileRequestResults.set(key, 'pending');
      if (!this.seenRenderTiles.has(key)) {
        this.seenRenderTiles.add(key);
        this.renderTotalCount.update(total => total + 1);
      }
    } else if (detail.status === 'cache-loading') {
      if (this.currentTileRequestResults.get(key) !== 'cached') {
        this.currentTileRequestResults.set(key, 'cached');
        this.totalRenderTileCounts.update(counts => ({ ...counts, cached: counts.cached + 1 }));
        this.lastRenderTileCounts.update(counts => ({ ...counts, cached: counts.cached + 1 }));
      }
    } else if (detail.status === 'loaded') {
      if (this.currentTileRequestResults.get(key) !== 'cached') {
        this.totalRenderTileCounts.update(counts => ({ ...counts, rendered: counts.rendered + 1 }));
        this.lastRenderTileCounts.update(counts => ({ ...counts, rendered: counts.rendered + 1 }));
      }
      this.currentTileRequestResults.delete(key);
      this.activeRenderTiles.delete(key);
    } else if (detail.status === 'error') {
      this.recordMapError(
        detail.protocol === 'osmand-atlas' ? 'OsmAnd Atlas tile' : 'OsmAnd tile',
        (detail.error || 'Tile rendering failed') + ' [z=' + detail.zoom + ', x=' + detail.column + ', y=' + detail.row + ']'
      );
      this.totalRenderTileCounts.update(counts => ({ ...counts, failed: counts.failed + 1 }));
      this.lastRenderTileCounts.update(counts => ({ ...counts, failed: counts.failed + 1 }));
      this.currentTileRequestResults.delete(key);
      this.activeRenderTiles.delete(key);
    } else if (detail.status === 'cancelled' || detail.status === 'warning') {
      this.currentTileRequestResults.delete(key);
      this.activeRenderTiles.delete(key);
    }
    this.renderActiveCount.set(this.activeRenderTiles.size);
    if (!expectedProtocol || detail.protocol !== expectedProtocol || !this.renderInitStatus()) return;
    if (detail.status === 'loading') this.renderInitStatus.set('Loading first tile …');
    else if (detail.status === 'loaded' || detail.status === 'warning' || detail.status === 'error' || detail.status === 'cache-loading') this.renderInitStatus.set('');
  };
  private readonly onHillshadeTileStatus = (event: Event): void => {
    const detail = (event as CustomEvent<{ key?: string; status?: string; error?: string; zoom?: number; column?: number; row?: number }>).detail;
    if (!detail || !detail.key) return;
    const key = detail.key;
    if (detail.status === 'loading') {
      this.activeHillshadeTiles.add(key);
      if (!this.seenHillshadeTiles.has(key)) {
        this.seenHillshadeTiles.add(key);
        this.hillshadeTotalCount.update(total => total + 1);
      }
    } else if (detail.status === 'loaded') {
      this.totalHillshadeTileCounts.update(counts => ({ ...counts, rendered: counts.rendered + 1 }));
      this.lastHillshadeTileCounts.update(counts => ({ ...counts, rendered: counts.rendered + 1 }));
      this.activeHillshadeTiles.delete(key);
    } else if (detail.status === 'error') {
      this.totalHillshadeTileCounts.update(counts => ({ ...counts, failed: counts.failed + 1 }));
      this.lastHillshadeTileCounts.update(counts => ({ ...counts, failed: counts.failed + 1 }));
      this.activeHillshadeTiles.delete(key);
      this.recordMapError('Hillshade tile', (detail.error || 'Hillshade tile rendering failed')
        + ' [z=' + detail.zoom + ', x=' + detail.column + ', y=' + detail.row + ']');
    } else if (detail.status === 'cancelled') {
      this.activeHillshadeTiles.delete(key);
    }
    this.hillshadeActiveCount.set(this.activeHillshadeTiles.size);
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
  protected readonly offlineMapListFilter = signal<'all' | 'mbtiles' | 'obf' | 'map' | 'inUse' | 'active' | 'updates' | 'current' | 'noMatch'>('all');
  protected readonly offlineMapUpdateCheckBusy = signal(false);
  protected readonly offlineMapUpdateCheckStatus = signal('');
  protected readonly offlineMapCatalogueFiles = signal<import('internal-api').OfflineMapCatalogueFile[]>([]);
  protected readonly offlineMapCatalogueSummary = signal('No catalogue has been checked yet.');
  protected readonly activeOfflineMapCount = computed(() => this.offlineMaps().filter(map => map.enabled).length);
  protected readonly inUseOfflineMapCount = computed(() => this.offlineMaps().filter(map => this.isOfflineMapInUse(map)).length);
  protected readonly filteredOfflineMaps = computed(() => {
    const maps = this.offlineMaps();
    const filter = this.offlineMapListFilter();
    if (filter === 'mbtiles') return maps.filter(map => map.type === 'mbtiles' || !map.type);
    if (filter === 'obf') return maps.filter(map => map.type === 'obf');
    if (filter === 'map') return maps.filter(map => map.type === 'mapsforge');
    if (filter === 'inUse') return maps.filter(map => this.isOfflineMapInUse(map));
    if (filter === 'active') return maps.filter(map => map.enabled);
    if (filter === 'updates') return maps.filter(map => map.updateAvailable === true);
    if (filter === 'current') return maps.filter(map => map.updateChecked && map.updateAvailable === false);
    if (filter === 'noMatch') return maps.filter(map => map.updateChecked && map.updateMatched === false);
    return maps;
  });
  protected readonly offlineMapPreset = signal<'austria' | 'austria-plus' | 'europe' | 'all' | 'none' | 'custom'>(
    (['austria', 'austria-plus', 'europe', 'all', 'none', 'custom'] as const).includes(this.readSetting('offlineMapPreset', 'custom') as 'austria' | 'austria-plus' | 'europe' | 'all' | 'none' | 'custom')
      ? this.readSetting('offlineMapPreset', 'custom') as 'austria' | 'austria-plus' | 'europe' | 'all' | 'none' | 'custom' : 'austria'
  );
  protected readonly hillshadePreset = signal<'austria' | 'austria-plus' | 'europe' | 'all' | 'none' | 'custom'>(
    (['austria', 'austria-plus', 'europe', 'all', 'none', 'custom'] as const).includes(this.readSetting('hillshadePreset', 'custom') as 'austria' | 'austria-plus' | 'europe' | 'all' | 'none' | 'custom')
      ? this.readSetting('hillshadePreset', 'custom') as 'austria' | 'austria-plus' | 'europe' | 'all' | 'none' | 'custom' : 'austria'
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
  protected readonly downloadSources = signal<Array<{ url: string; fileType: 'obf' | 'mbtiles' | 'mapsforge' | 'android' | 'others'; useForUpdates: boolean }>>([
    { url: 'https://download.geofabrik.de/europe/austria.html', fileType: 'mbtiles', useForUpdates: false },
    { url: 'https://www.limaps.org/tileserver.html', fileType: 'mbtiles', useForUpdates: true },
    { url: 'https://shortbread-tiles.org/download/', fileType: 'mbtiles', useForUpdates: false },
    { url: 'https://download.osmand.net/list.php', fileType: 'obf', useForUpdates: true },
    { url: 'https://github.com/osmandapp/OsmAnd-resources', fileType: 'obf', useForUpdates: false },
    { url: 'https://fides.fe.uni-lj.si/~arpadb/osmand/', fileType: 'obf', useForUpdates: true },
    { url: 'https://download.osmand.net/latest-night-build/', fileType: 'android', useForUpdates: false },
    { url: 'https://download.mapsforge.org/maps/', fileType: 'mapsforge', useForUpdates: false }
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
  protected readonly labelsVisible = signal(this.mapSource() === 'osmand-atlas' ? true : this.mapSource() === 'osmand' ? false : this.readSetting('labelsVisible', 'true') === 'true');
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
  protected readonly gpxTrackColorMenuOpen = signal<string | null>(null);
  protected readonly gpxTrackLineStyleMenuOpen = signal<string | null>(null);
  protected readonly gpxTrackDirectionMenuOpen = signal<string | null>(null);
  protected readonly gpxVisible = signal(this.readSetting('gpxVisible', 'true') === 'true');
  protected readonly gpxTracks = signal<GpxTrackFile[]>([]);
  protected readonly gpxError = signal('');
  protected readonly gpxHoveredTrackPath = signal<string | null>(null);
  protected readonly gpxHoverInfo = signal('');
  protected readonly timeSliderActive = signal(this.readSetting('timeSliderActive', 'false') === 'true');
  protected readonly timeSliderMinimum = signal(0);
  protected readonly timeSliderMaximum = signal(0);
  protected readonly timeSliderStart = signal(0);
  protected readonly timeSliderEnd = signal(0);
  protected readonly timeSliderAnimating = signal(false);
  protected readonly timeSliderWalkerVisible = signal(this.readSetting('timeSliderWalkerVisible', 'false') === 'true');
  protected readonly timeSliderAnimationSpeed = signal(Math.max(0.1, Math.min(10, Number(this.readSetting('timeSliderAnimationSpeed', '1')) || 1)));
  protected readonly walkingFigureSize = signal(Math.max(0.5, Math.min(3, Number(this.readSetting('walkingFigureSize', '1')) || 1)));
  protected readonly walkingFigureAnimationSpeed = signal(Math.max(0.2, Math.min(3, Number(this.readSetting('walkingFigureAnimationSpeed', '1')) || 1)));
  protected readonly walkingFigureType = signal((['walker', 'car', 'taxi', 'racecar', 'van', 'pickup', 'ambulance', 'police', 'firetruck', 'bus', 'truck', 'delivery', 'plane', 'helicopter', 'train', 'bicycle', 'motorcycle', 'scooter', 'tractor', 'boat', 'ship', 'sailboat', 'rocket'].includes(this.readSetting('walkingFigureType', 'walker')) ? this.readSetting('walkingFigureType', 'walker') : 'walker') as 'walker' | 'car' | 'van' | 'bus' | 'truck' | 'plane' | 'helicopter' | 'train' | 'bicycle' | 'motorcycle' | 'scooter' | 'tractor' | 'boat');
  private timeSliderAnimationTimer: ReturnType<typeof setInterval> | null = null;
  private lastWalkingBearing = 0;
  private smoothedWalkingBearing: number | null = null;
  private lastWalkingBearingUpdate = 0;
  protected readonly timeSliderHasData = computed(() => this.timeSliderMaximum() > this.timeSliderMinimum());
  protected readonly markerSectionOpen = signal(this.readSetting('markerSectionOpen', 'false') === 'true');
  protected readonly directoryMarkersEnabled = signal(this.readSetting('directoryMarkersEnabled', 'false') === 'true');
  protected readonly markerFilesChecked = signal(0);
  protected readonly markerFilesTotal = signal(0);
  protected readonly markerCount = signal(0);
  protected readonly markerStatus = signal('');
  protected readonly coordinateLabel = signal('GPS coordinates unavailable');
  protected readonly photoCoordinateLabel = signal('Photo: GPS coordinates unavailable');
  protected readonly mouseCoordinateLabel = signal('');
  protected readonly coordinatesAvailable = signal(false);
  protected readonly locationAddress = signal('');
  protected readonly bearing = signal<number | null>(null);
  protected readonly bearingLabel = computed(() => this.bearing() === null ? '' : String(Math.round(this.bearing()!)) + '° ' + this.compassDirection(this.bearing()!));
  protected readonly gpxColors = [
    { name: 'Red', value: '#ff3b30', textColor: '#ffffff' }, { name: 'Orange', value: '#ff9500', textColor: '#171717' },
    { name: 'Yellow', value: '#ffd60a', textColor: '#171717' }, { name: 'Green', value: '#34c759', textColor: '#102014' },
    { name: 'Blue', value: '#0a84ff', textColor: '#ffffff' }, { name: 'Magenta', value: '#bf5af2', textColor: '#ffffff' }
  ] as const;

  @HostListener('document:mousemove', ['$event'])
  onDocumentMouseMove(event: MouseEvent): void {
    const mapElement = this.mapElement().nativeElement;
    if (mapElement.classList.contains('map-hidden') || !mapElement.contains(event.target as Node)) {
      this.mouseCoordinateLabel.set('');
      return;
    }
    const rect = mapElement.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    let latitude: number;
    let longitude: number;
    if (this.offlineRenderer) {
      const coordinate = this.offlineRenderer.map.unproject([x, y]);
      latitude = coordinate.lat;
      longitude = coordinate.lng;
    } else if (this.map) {
      const coordinate = this.map.containerPointToLatLng([x, y]);
      latitude = coordinate.lat;
      longitude = coordinate.lng;
    } else {
      this.mouseCoordinateLabel.set('');
      return;
    }
    this.mouseCoordinateLabel.set(this.formatCoordinates(latitude, longitude).replace(/^Coordinates: /, ''));
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const target = event.target;
    if (target instanceof Element && target.closest('.color-picker')) return;
    if (target instanceof Element && target.closest('.map-source-picker')) return;
    this.colorMenuOpen.set(false);
    this.markerColorMenuOpen.set(false);
    this.currentMarkerColorMenuOpen.set(false);
    this.gpxTrackColorMenuOpen.set(null);
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
      if (typeof saved['activeSettingsTab'] === 'string' && ['location','track','marker','view','offlineMaps','hillshade','cache','memory','download','errors'].includes(saved['activeSettingsTab'])) this.activeSettingsTab.set(saved['activeSettingsTab'] as 'location' | 'track' | 'timeSlider' | 'marker' | 'view' | 'offlineMaps' | 'hillshade' | 'cache' | 'memory' | 'download' | 'errors');
      if (typeof saved['renderVisualsEnabled'] === 'boolean') {
        this.renderVisualsEnabled.set(saved['renderVisualsEnabled']);
        window.dispatchEvent(new CustomEvent('lumascope-osmand-tile-visuals', { detail: { enabled: saved['renderVisualsEnabled'] } }));
      }
      if (typeof saved['scaleVisible'] === 'boolean') {
        this.scaleVisible.set(saved['scaleVisible']);
        this.applyScaleVisibility();
      }
      if (typeof saved['opacitySectionOpen'] === 'boolean') this.opacitySectionOpen.set(saved['opacitySectionOpen']);
      if (typeof saved['renderSectionOpen'] === 'boolean') this.renderSectionOpen.set(saved['renderSectionOpen']);
      if (typeof saved['markerSectionOpen'] === 'boolean') this.markerSectionOpen.set(saved['markerSectionOpen']);
    }).catch(error => console.warn('[Location] Could not restore window UI state:', error));
    window.addEventListener('lumascope-osmand-tile-status', this.onOsmAndTileStatus);
    window.addEventListener('lumascope-hillshade-tile-status', this.onHillshadeTileStatus);
    if (this.desktop) {
      registerOsmAndHillshadeTileProtocol(this.desktop, () => this.hillshadeDatabases());
      void this.desktop.OsmAndAtlas.getHillshadeDatabases().then(databases => {
        this.hillshadeDatabases.set(databases);
        this.updateHillshadePresetFromSelection(databases);
        this.applyHillshadeSettingsIfReady(true);
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
      const defaults: Array<{ url: string; fileType: 'obf' | 'mbtiles' | 'mapsforge' | 'android' | 'others'; useForUpdates: boolean }> = [
        { url: 'https://download.geofabrik.de/europe/austria.html', fileType: 'mbtiles', useForUpdates: false },
        { url: 'https://www.limaps.org/tileserver.html', fileType: 'mbtiles', useForUpdates: true },
        { url: 'https://shortbread-tiles.org/download/', fileType: 'mbtiles', useForUpdates: false },
        { url: 'https://download.osmand.net/list.php', fileType: 'obf', useForUpdates: true },
        { url: 'https://github.com/osmandapp/OsmAnd-resources', fileType: 'obf', useForUpdates: false },
        { url: 'https://fides.fe.uni-lj.si/~arpadb/osmand/', fileType: 'obf', useForUpdates: true },
        { url: 'https://download.osmand.net/latest-night-build/', fileType: 'android', useForUpdates: false },
        { url: 'https://download.mapsforge.org/maps/', fileType: 'mapsforge', useForUpdates: false }
      ];
      if (Array.isArray(saved) && saved.length > 0) {
        const valid = saved.filter((entry): entry is { url: string; fileType: 'obf' | 'mbtiles' | 'mapsforge' | 'android' | 'others'; useForUpdates: boolean } =>
          !!entry && typeof entry === 'object'
          && typeof (entry as { url?: unknown }).url === 'string'
          && ['obf', 'mbtiles', 'mapsforge', 'android', 'others'].includes(String((entry as { fileType?: unknown }).fileType))
          && typeof (entry as { useForUpdates?: unknown }).useForUpdates === 'boolean'
        );
        const merged = [...valid];
        for (const source of defaults.slice(6)) {
          if (!merged.some(entry => entry.url === source.url)) merged.push(source);
        }
        this.downloadSources.set(merged);
        if (merged.length !== valid.length) {
          void this.desktop?.ProcessManager.setAppSettingsSection('offlineMaps', { updateSources: merged }).catch(error => console.error('Could not add new default download sources:', error));
        }
      } else {
        this.downloadSources.set(defaults);
        void this.desktop?.ProcessManager.setAppSettingsSection('offlineMaps', { updateSources: defaults }).catch(error => console.error('Could not save default download sources:', error));
      }
    }).catch(error => console.error('Could not load download source settings:', error));
    void this.desktop?.OfflineMap.getMaps().then(async maps => {
      this.offlineMaps.set(maps);
      // The stored preset describes the last applied preset, not necessarily the
      // current OBF selection. Manual changes from older versions are normalized
      // to Custom during startup so the selector never claims a false preset.
      const matchingPreset = this.getObfPresetForMaps(maps);
      if (matchingPreset && matchingPreset !== this.offlineMapPreset()) {
        this.offlineMapPreset.set(matchingPreset);
        this.saveSetting('offlineMapPreset', matchingPreset);
        await this.desktop?.OfflineMap.setEnabledBatch([], matchingPreset);
      }
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
      this.photoCoordinateLabel.set(this.formatCoordinates(latitude, longitude).replace(/^Coordinates: /, 'Photo: '));
      void this.lookupLocationAddress(latitude, longitude);
      void this.initialize(latitude, longitude);
    } else {
      this.locationAddress.set('This image does not contain GPS coordinates.');
    }
    const applyLocation = (location: { latitude: number | null; longitude: number | null; bearing?: number | null; imagePath?: string | null }): void => {
      const previousImagePath = this.currentImagePath;
      this.currentLatitude = location.latitude; this.currentLongitude = location.longitude;
      this.currentImagePath = location.imagePath ?? null;
      this.applyCurrentPhotoVisibility();
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
        this.photoCoordinateLabel.set('Photo: GPS coordinates unavailable');
        this.locationAddress.set('This image does not contain GPS coordinates.');
        this.map?.remove();
        this.map = null;
        this.leafletHillshadeLayer = null;
        this.leafletHillshadePane = null;
        this.offlineRenderer?.remove(); this.offlineRenderer = null;
        this.currentOfflineMapId = null;
        this.activeOfflineMapId.set(null);
        this.marker = null;
        this.clearDirectoryMarkers();
        return;
      }
      this.coordinatesAvailable.set(true);
      this.coordinateLabel.set(this.formatCoordinates(nextLatitude!, nextLongitude!));
      this.photoCoordinateLabel.set(this.formatCoordinates(nextLatitude!, nextLongitude!).replace(/^Coordinates: /, 'Photo: '));
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
    this.stopTimeSliderAnimation();
    this.walkingMarker?.remove(); this.walkingMarker = null;
    this.walkingMapLibreMarker?.remove(); this.walkingMapLibreMarker = null;
    window.removeEventListener('lumascope-osmand-tile-status', this.onOsmAndTileStatus);
    window.removeEventListener('lumascope-hillshade-tile-status', this.onHillshadeTileStatus);
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
    this.leafletHillshadeLayer = null;
    this.leafletHillshadePane = null;
    this.offlineRenderer?.remove(); this.offlineRenderer = null;
    // Native OsmAnd render helpers are persistent main-process workers. Stop them
    // when their map window goes away so they cannot keep GPU contexts alive.
    if (this.mapSource() === 'osmand-atlas') void this.desktop?.OsmAndAtlas.shutdown().catch(error => console.warn('Could not stop OsmAnd Atlas helpers:', error));
    if (this.mapSource() === 'osmand') void this.desktop?.OsmAnd.shutdown().catch(error => console.warn('Could not stop OsmAnd helpers:', error));
  }

  private readonly onResize = (): void => { this.map?.invalidateSize(); this.offlineRenderer?.resize(); };

  protected readonly copyFilePath = async (path: string): Promise<void> => {
    if (!path) return;
    try { await navigator.clipboard.writeText(path); }
    catch (error) { console.error('Failed to copy file path', error); }
  };

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
    const timestamp = new Date(now).toLocaleString(this.locale);
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
  protected readonly toggleGpxTrackColorMenu = (path: string): void => {
    const open = this.gpxTrackColorMenuOpen() === path ? null : path;
    this.colorMenuOpen.set(false); this.markerColorMenuOpen.set(false); this.currentMarkerColorMenuOpen.set(false);
    this.gpxTrackColorMenuOpen.set(open);
  };
  protected readonly toggleGpxTrackLineStyleMenu = (path: string): void => {
    const open = this.gpxTrackLineStyleMenuOpen() === path ? null : path;
    this.gpxTrackColorMenuOpen.set(null); this.gpxTrackDirectionMenuOpen.set(null);
    this.gpxTrackLineStyleMenuOpen.set(open);
  };
  protected readonly toggleGpxTrackDirectionMenu = (path: string): void => {
    const open = this.gpxTrackDirectionMenuOpen() === path ? null : path;
    this.gpxTrackColorMenuOpen.set(null); this.gpxTrackLineStyleMenuOpen.set(null);
    this.gpxTrackDirectionMenuOpen.set(open);
  };
  protected readonly gpxLineStyleName = (style: string): string => ({
    solid: 'Solid', dashed: 'Dashed', dotted: 'Dotted', 'long-dashed': 'Long dash',
    'short-dashed': 'Short dash', 'dash-dot': 'Dash-dot', 'dash-dot-dot': 'Dash-dot-dot'
  } as Record<string, string>)[style] ?? 'Solid';
  protected readonly gpxLineStyleSample = (style: string): string => ({
    solid: '━━━━━━━━━', dashed: '━ ━ ━ ━', dotted: '· · · · ·', 'long-dashed': '━━  ━━  ━━',
    'short-dashed': '━ ━ ━ ━', 'dash-dot': '━ · ━ · ━', 'dash-dot-dot': '━ · · ━ · ·'
  } as Record<string, string>)[style] ?? '━━━━━━━━━';
  protected readonly gpxDirectionName = (style: string): string => ({
    off: 'Off', classic: 'Classic · 16 px', chevron: 'Chevron · 16 px', triangle: 'Triangle · 16 px',
    thin: 'Slim · 16 px', 'large-classic': 'Classic · 24 px', 'large-chevron': 'Chevron · 24 px',
    'large-triangle': 'Triangle · 24 px'
  } as Record<string, string>)[style] ?? 'Classic · 16 px';
  protected readonly gpxDirectionSample = (style: string): string => ({
    off: '—', classic: '➤', chevron: '❯', triangle: '▶', thin: '➜',
    'large-classic': '➤', 'large-chevron': '❯', 'large-triangle': '▶'
  } as Record<string, string>)[style] ?? '➤';
  protected readonly selectedGpxTrackColorName = (track: GpxTrackFile): string => this.gpxColors.find(color => color.value === (track.color || this.gpxColor()))?.name ?? 'Red';
  protected readonly selectedGpxTrackTextColor = (track: GpxTrackFile): string => this.gpxColors.find(color => color.value === (track.color || this.gpxColor()))?.textColor ?? '#ffffff';
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
    this.directoryPhotoMarkers = [];
    this.directoryPhotoTimestampMarkers = [];
    this.offlineRenderer?.setPhotoMarkers([], path => { void this.desktop?.MapWindow.selectImage(path); }, (this.markersVisible() ? this.markerOpacity() / 100 : 0));
    this.markerCount.set(0);
    this.updateTimeSliderBounds();
    this.applyCurrentPhotoVisibility();
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
    this.directoryMarkerGroup?.clearLayers();
    this.directoryMarkers.length = 0;
    this.markerCount.set(0);
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
      const [records, imageFiles] = await Promise.all([
        desktop.CacheManager.getDirectoryPhotoLocations(directory),
        desktop.FileSystem.readImages(directory, 'name', 'asc')
      ]);
      if (generation !== this.markerScanGeneration || !this.directoryMarkersEnabled()) return;
      const modifiedAtByName = new Map(
        (imageFiles.success ? imageFiles.data : [])
          .filter(file => !file.isDirectory && Number.isFinite(file.modifiedAt) && file.modifiedAt! > 0)
          .map(file => [file.name.toLowerCase(), Math.floor(file.modifiedAt! / 1000)])
      );
      const markers = records
        .filter(record => record.latitude !== null && record.longitude !== null
          && Number.isFinite(record.latitude) && Number.isFinite(record.longitude)
          && Math.abs(record.latitude) <= 90 && Math.abs(record.longitude) <= 180)
        .map(record => ({
          path: record.path,
          fileName: record.fileName,
          latitude: record.latitude!,
          longitude: record.longitude!,
          gpsTimestamp: record.gpsTimestamp ?? modifiedAtByName.get(record.fileName.toLowerCase()) ?? null
        }));

      this.markerFilesTotal.set(records.length);
      this.markerFilesChecked.set(records.length);
      // Keep the current image as a timestamp anchor even though its marker is not displayed.
      this.directoryPhotoTimestampMarkers = markers.map(item => ({ ...item }));
      this.directoryPhotoMarkers = markers.filter(item => item.path.toLowerCase() !== imagePath.toLowerCase()).map(item => ({ ...item }));
      this.updateTimeSliderBounds();
      this.applyDirectoryPhotoMarkers();
      this.applyCurrentPhotoVisibility();
      if (this.offlineRenderer) this.offlineRenderer.setPhotoClusterStyle(this.markerColor(), this.markerColorVisible(), this.markerShape());
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
        this.map?.remove(); this.map = null; this.leafletHillshadeLayer = null; this.leafletHillshadePane = null; this.marker = null; this.directoryMarkerGroup = null;
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
    renderer.setTextLabelOpacity(this.labelsVisible() ? this.labelOpacity() / 100 : 0);
    renderer.map.jumpTo({ center: [latestLongitude, latestLatitude] });
    this.applyMapColor(); this.applyMapOpacity();
    this.applyHillshadeSettings(renderer);
    const syncOfflineZoom = (): void => this.persistZoom(renderer.map.getZoom());
    renderer.map.on('zoomend', syncOfflineZoom);
    syncOfflineZoom();
    if (this.directoryMarkersEnabled()) void this.scanDirectoryMarkers();
    await this.restoreGpxTrack();
    this.applyOpacitySettings();
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

    // Atlas tiles are rendered asynchronously through the native tile protocol.
    // Reapply the persisted opacity values once the first complete viewport is
    // idle as well as immediately after track restoration below. This avoids
    // the startup-only case where the controls hold the saved values but the
    // first fully rendered Atlas viewport still uses the style defaults.
    renderer.map.once('idle', () => {
      if (generation !== this.mapSourceGeneration
        || this.mapSource() !== 'osmand-atlas'
        || this.offlineRenderer !== renderer) return;
      this.applyOpacitySettings();
    });

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
      this.currentTileRequestResults.clear();
      this.lastRenderTileCounts.set({ rendered: 0, cached: 0, failed: 0 });
      this.lastHillshadeTileCounts.set({ rendered: 0, failed: 0 });
      this.activeHillshadeTiles.clear();
      this.seenHillshadeTiles.clear();
      this.hillshadeActiveCount.set(0);
      this.hillshadeTotalCount.set(0);
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
    this.applyOpacitySettings();
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
    this.applyOpacitySettings();
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
    this.updateWalkingMarker();
    this.leaflet.control.scale({ metric: true, imperial: false, position: 'bottomleft', maxWidth: 140 }).addTo(map);
    const leafletScale = this.mapElement().nativeElement.querySelector<HTMLElement>('.leaflet-control-scale');
    if (leafletScale) {
      // Place the scale directly on the map surface, outside Leaflet's control pane.
      leafletScale.style.position = 'absolute';
      leafletScale.style.left = '10px';
      leafletScale.style.bottom = '10px';
      leafletScale.style.margin = '0';
      leafletScale.style.zIndex = '10000';
      leafletScale.style.pointerEvents = 'auto';
      this.mapElement().nativeElement.appendChild(leafletScale);
    }
    this.applyScaleVisibility();
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
    this.applyOpacitySettings();
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
    if (nextSource === 'osmand-atlas' || nextSource === 'osmand') {
      const labelsEnabled = nextSource === 'osmand-atlas';
      this.labelsVisible.set(labelsEnabled);
      this.saveSetting('labelsVisible', labelsEnabled);
    }
    if (nextSource !== 'offline') {
      this.currentOfflineMapId = null;
      this.activeOfflineMapId.set(null);
      this.offlineMapStatus.set(null);
    }
    if (this.currentLatitude !== null && this.currentLongitude !== null) {
      this.map?.remove(); this.map = null; this.leafletHillshadeLayer = null; this.leafletHillshadePane = null; this.marker = null; this.directoryMarkerGroup = null;
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
        this.map?.remove(); this.map = null; this.leafletHillshadeLayer = null; this.leafletHillshadePane = null;
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
  protected readonly refreshVisibleTiles = (): void => {
    const renderer = this.offlineRenderer;
    const source = this.mapSource();
    if (!renderer || (source !== 'osmand-atlas' && source !== 'osmand') || this.rerenderVisibleTilesBusy()) return;
    this.currentTileRequestResults.clear();
    this.lastRenderTileCounts.set({ rendered: 0, cached: 0, failed: 0 });
    this.rerenderVisibleTilesStatus.set('');
    try {
      renderer.refreshVisibleTiles();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.rerenderVisibleTilesStatus.set('Refresh failed: ' + message);
      this.recordMapError('Refresh visible OsmAnd tiles', message);
    }
  };
  protected readonly rerenderVisibleTiles = async (): Promise<void> => {
    const renderer = this.offlineRenderer;
    const source = this.mapSource();
    if (!this.desktop || !renderer || (source !== 'osmand-atlas' && source !== 'osmand') || this.rerenderVisibleTilesBusy()) return;
    this.currentTileRequestResults.clear();
    this.lastRenderTileCounts.set({ rendered: 0, cached: 0, failed: 0 });
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
      this.rerenderVisibleTilesStatus.set('');
      // The Hillshade overlay has its own MapLibre raster source and is not
      // part of the base-map native rerender above. Recreate it as well so
      // visible shade tiles are fetched and composited again from all enabled DBs.
      renderer.rerenderHillshadeTiles();
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
    if (value !== 'austria' && value !== 'austria-plus' && value !== 'europe' && value !== 'all' && value !== 'none' && value !== 'custom') return;
    this.offlineMapPreset.set(value);
    this.saveSetting('offlineMapPreset', value);
    if (this.desktop) {
      // Apply all OBF states and the preset in one IPC call and one settings write.
      // Custom intentionally preserves the user's individual enabled states.
      const updates = value === 'custom' ? [] : this.offlineMaps()
        .filter(map => map.type === 'obf' && map.enabled !== this.obfMapMatchesPreset(map, value))
        .map(map => ({ id: map.id, enabled: this.obfMapMatchesPreset(map, value) }));
      this.offlineMaps.set(await this.desktop.OfflineMap.setEnabledBatch(updates, value));
    }
    this.refreshOfflineMapRendering();
  };

  private obfMapMatchesPreset(
    map: import('internal-api').OfflineMapStatus,
    selectedPreset: 'austria' | 'austria-plus' | 'europe' | 'all' | 'none' | 'custom' = this.offlineMapPreset()
  ): boolean {
    if (map.type !== 'obf') return false;
    const fileName = map.fileName || map.name;
    const isWorldBasemap = /^World_basemap\.obf$/i.test(fileName);
    if (selectedPreset === 'none') return false;
    if (isWorldBasemap) return true;
    // The legacy nationwide extract is obsolete and must never be activated by Austria.
    if (selectedPreset === 'austria' && /^Austria_europe\.obf$/i.test(fileName)) return false;
    const isAustria = /austria|österreich|osterreich/i.test(fileName);
    const isAustriaPlus = /austria|österreich|osterreich|germany|deutschland|czech|czechia|tschech|slovakia|slowakei|slovensko|hungary|ungarn|slovenia|slowenien|italy|italien|switzerland|schweiz|liechtenstein/i.test(fileName);
    const isEurope = /(?:^|[_. -])europe(?:[_. -]|$)/i.test(fileName);
    return selectedPreset === 'all' || selectedPreset === 'custom'
      || (selectedPreset === 'austria' ? isAustria : selectedPreset === 'austria-plus' ? isAustriaPlus : selectedPreset === 'europe' ? isEurope : false);
  }

  private getObfPresetForMaps(
    maps: import('internal-api').OfflineMapStatus[]
  ): 'austria' | 'austria-plus' | 'europe' | 'all' | 'none' | 'custom' | null {
    const obfMaps = maps.filter(map => map.type === 'obf');
    if (obfMaps.length === 0) return null;
    const candidates: Array<'austria' | 'austria-plus' | 'europe' | 'all' | 'none'> =
      ['none', 'austria', 'austria-plus', 'europe', 'all'];
    return candidates.find(preset =>
      obfMaps.every(map => map.enabled === this.obfMapMatchesPreset(map, preset))
    ) ?? 'custom';
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
      this.map?.remove(); this.map = null; this.leafletHillshadeLayer = null; this.leafletHillshadePane = null; this.marker = null; this.directoryMarkerGroup = null;
      this.currentOfflineMapId = null;
      void this.initialize(this.currentLatitude, this.currentLongitude);
    }
  }

  protected readonly setOfflineMapEnabled = async (id: string, enabled: boolean): Promise<void> => {
    if (!this.desktop) return;
    const currentMaps = this.offlineMaps();
    const map = currentMaps.find(item => item.id === id);
    const obfSelectionChanged = map?.type === 'obf' && map.enabled !== enabled;
    const nextMaps = currentMaps.map(item => item.id === id ? { ...item, enabled } : item);
    const matchingPreset = obfSelectionChanged ? this.getObfPresetForMaps(nextMaps) : null;
    this.offlineMaps.set(await this.desktop.OfflineMap.setEnabledBatch(
      [{ id, enabled }],
      matchingPreset ?? undefined
    ));
    if (matchingPreset) {
      this.offlineMapPreset.set(matchingPreset);
      this.saveSetting('offlineMapPreset', matchingPreset);
    }
    if (this.currentLatitude !== null && this.currentLongitude !== null && (this.mapSource() === 'offline' || this.mapSource() === 'osmand' || this.mapSource() === 'osmand-atlas')) {
      this.mapSourceGeneration++; this.mapInitialization = null;
      this.offlineRenderer?.remove(); this.offlineRenderer = null;
      this.map?.remove(); this.map = null; this.leafletHillshadeLayer = null; this.leafletHillshadePane = null; this.marker = null; this.directoryMarkerGroup = null;
      this.currentOfflineMapId = null;
      void this.initialize(this.currentLatitude, this.currentLongitude);
    }
  };
  protected readonly setAllOfflineMapsEnabled = async (enabled: boolean): Promise<void> => {
    if (!this.desktop) return;
    const visibleMaps = this.filteredOfflineMaps();
    if (visibleMaps.length === 0) return;
    try {
      const obfSelectionChanged = visibleMaps.some(map => map.type === 'obf' && map.enabled !== enabled);
      const updates = visibleMaps.map(map => ({ id: map.id, enabled }));
      const updateById = new Map(updates.map(update => [update.id, update.enabled]));
      const updatedSelection = this.offlineMaps().map(map =>
        updateById.has(map.id) ? { ...map, enabled: updateById.get(map.id)! } : map
      );
      const matchingPreset = obfSelectionChanged ? this.getObfPresetForMaps(updatedSelection) : null;
      const updated = await this.desktop.OfflineMap.setEnabledBatch(
        updates,
        matchingPreset ?? undefined
      );
      this.offlineMaps.set(updated);
      if (matchingPreset) {
        this.offlineMapPreset.set(matchingPreset);
        this.saveSetting('offlineMapPreset', matchingPreset);
      }
      this.refreshOfflineMapRendering();
    } catch (error) {
      console.error('[OfflineMap] Could not update Active state for visible maps:', error);
    }
  };
  protected readonly clearOfflineMapsList = async (): Promise<void> => {
    if (!this.desktop) return;
    const maps = this.filteredOfflineMaps();
    if (maps.length === 0) return;
    const confirmed = window.confirm(
      `Remove all ${maps.length} visible map(s) from the LumaScope list? The map files on disk will not be deleted.`
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
        this.map?.remove(); this.map = null; this.leafletHillshadeLayer = null; this.leafletHillshadePane = null; this.marker = null; this.directoryMarkerGroup = null;
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
      this.map?.remove(); this.map = null; this.leafletHillshadeLayer = null; this.leafletHillshadePane = null; this.marker = null; this.directoryMarkerGroup = null;
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
  protected readonly updateDownloadSource = (index: number, patch: Partial<{ url: string; fileType: 'obf' | 'mbtiles' | 'mapsforge' | 'android' | 'others'; useForUpdates: boolean }>): void => {
    this.downloadSources.update(sources => sources.map((source, i) => i === index ? { ...source, ...patch } : source));
    this.persistDownloadSources();
  };
  protected readonly addDownloadSource = (): void => {
    this.downloadSources.update(sources => [...sources, { url: 'https://', fileType: 'others', useForUpdates: false }]);
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
  protected readonly hillshadeDatabaseFileName = (path: string): string => path.split(/[\\/]/).pop() ?? path;
  protected readonly formatHillshadeLastModified = (timestamp: number | null): string =>
    timestamp === null || !Number.isFinite(timestamp) ? '—' : new Date(timestamp).toLocaleString(this.locale);
  private hillshadeDatabaseMatchesPreset(database: OsmAndHillshadeDatabase, preset: 'austria' | 'austria-plus' | 'europe' | 'all' | 'none'): boolean {
    if (!database.available || preset === 'none') return false;
    if (preset === 'all') return true;
    const fileName = this.hillshadeDatabaseFileName(database.path);
    if (preset === 'austria') return /austria|österreich|osterreich/i.test(fileName);
    if (preset === 'austria-plus') return /austria|österreich|osterreich|germany|deutschland|czech|czechia|tschech|slovakia|slowakei|slovensko|hungary|ungarn|slovenia|slowenien|italy|italien|switzerland|schweiz|liechtenstein/i.test(fileName);
    return /(?:^|[_. -])europe(?:[_. -]|$)/i.test(fileName);
  }
  private updateHillshadePresetFromSelection(databases: OsmAndHillshadeDatabase[]): void {
    const available = databases.filter(database => database.available);
    if (!available.length) return;
    const candidates: Array<'none' | 'austria' | 'austria-plus' | 'europe' | 'all'> = ['none', 'austria', 'austria-plus', 'europe', 'all'];
    const matching = candidates.find(preset => available.every(database => database.enabled === this.hillshadeDatabaseMatchesPreset(database, preset)));
    const next = matching ?? 'custom';
    this.hillshadePreset.set(next);
    this.saveSetting('hillshadePreset', next);
  }
  protected readonly changeHillshadePreset = async (value: string): Promise<void> => {
    if (!['austria', 'austria-plus', 'europe', 'all', 'none', 'custom'].includes(value)) return;
    const preset = value as 'austria' | 'austria-plus' | 'europe' | 'all' | 'none' | 'custom';
    this.hillshadePreset.set(preset);
    this.saveSetting('hillshadePreset', preset);
    if (preset !== 'custom' && this.desktop) {
      let databases = this.hillshadeDatabases();
      for (const database of databases) {
        if (!database.available) continue;
        const enabled = this.hillshadeDatabaseMatchesPreset(database, preset);
        if (database.enabled !== enabled) {
          databases = await this.desktop.OsmAndAtlas.setHillshadeDatabaseEnabled(database.id, enabled);
          this.hillshadeDatabases.set(databases);
        }
      }
    }
    this.applyHillshadeSettingsIfReady(true);
  };
  protected readonly changeHillshadeVisibility = (visible: boolean): void => {
    this.hillshadeVisible.set(visible);
    this.saveSetting('hillshadeVisible', visible);
    this.applyHillshadeSettingsIfReady();
  };
  protected readonly changeHillshadeOpacity = (value: string | number): void => {
    const opacity = Number(value); if (!Number.isFinite(opacity)) return;
    const next = Math.max(0, Math.min(100, Math.round(opacity)));
    this.hillshadeOpacity.set(next);
    this.saveSetting('hillshadeOpacity', next);
    this.applyHillshadeSettingsIfReady();
  };
  protected readonly addHillshadeDatabases = async (): Promise<void> => {
    if (!this.desktop) return;
    try {
      const databases = await this.desktop.OsmAndAtlas.addHillshadeDatabases();
      this.hillshadeDatabases.set(databases);
      this.updateHillshadePresetFromSelection(databases);
      this.applyHillshadeSettingsIfReady(true);
    } catch (error) {
      this.recordMapError('Add Hillshade databases', error instanceof Error ? error.message : String(error));
    }
  };
  protected readonly setHillshadeDatabaseEnabled = async (id: string, enabled: boolean): Promise<void> => {
    if (!this.desktop) return;
    try {
      const databases = await this.desktop.OsmAndAtlas.setHillshadeDatabaseEnabled(id, enabled);
      this.hillshadeDatabases.set(databases);
      this.updateHillshadePresetFromSelection(databases);
      this.applyHillshadeSettingsIfReady(true);
    } catch (error) {
      this.recordMapError('Update Hillshade database', error instanceof Error ? error.message : String(error));
    }
  };
  protected readonly setAllHillshadeDatabasesEnabled = async (enabled: boolean): Promise<void> => {
    if (!this.desktop) return;
    try {
      let databases = this.hillshadeDatabases();
      for (const database of databases) {
        if (!database.available || database.enabled === enabled) continue;
        databases = await this.desktop.OsmAndAtlas.setHillshadeDatabaseEnabled(database.id, enabled);
        this.hillshadeDatabases.set(databases);
      }
      this.updateHillshadePresetFromSelection(databases);
      this.applyHillshadeSettingsIfReady(true);
    } catch (error) {
      this.recordMapError('Update Hillshade databases', error instanceof Error ? error.message : String(error));
    }
  };
  protected readonly removeHillshadeDatabase = async (id: string): Promise<void> => {
    if (!this.desktop) return;
    try {
      const databases = await this.desktop.OsmAndAtlas.removeHillshadeDatabase(id);
      this.hillshadeDatabases.set(databases);
      this.updateHillshadePresetFromSelection(databases);
      this.applyHillshadeSettingsIfReady(true);
      if (databases.length === 0) { this.hillshadeVisible.set(false); this.saveSetting('hillshadeVisible', false); }
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
    if (this.mapSource() === 'osmand' || this.mapSource() === 'osmand-atlas') {
      // The two OsmAnd renderers differ by label rendering: Atlas includes labels,
      // while the plain OsmAnd renderer deliberately omits them.
      this.changeMapSource(visible ? 'osmand-atlas' : 'osmand');
      return;
    }
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
      this.leafletHillshadeLayer = null;
      this.leafletHillshadePane = null;
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
  protected readonly formatGpxDate = (timestamp: number): string =>
    Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toLocaleString(this.locale) : '—';
  protected readonly gpxTrackTimeRange = (path: string): string => {
    const timestamps = (this.gpxPointDataByTrack.get(path) ?? []).flat()
      .map(point => point.timestamp ? Date.parse(point.timestamp) : Number.NaN)
      .filter(value => Number.isFinite(value))
      .sort((a, b) => a - b);
    return timestamps.length
      ? `${this.formatGpxDate(timestamps[0])} – ${this.formatGpxDate(timestamps[timestamps.length - 1])}`
      : '—';
  };
  protected readonly markerTimestampRange = (): { minimum: string; maximum: string } => {
    const timestamps = this.directoryPhotoTimestampMarkers
      .map(marker => marker.gpsTimestamp ?? Number.NaN)
      .filter(value => Number.isFinite(value))
      .sort((a, b) => a - b);
    return timestamps.length
      ? { minimum: this.formatGpxDate(timestamps[0] * 1000), maximum: this.formatGpxDate(timestamps[timestamps.length - 1] * 1000) }
      : { minimum: '—', maximum: '—' };
  };
  protected readonly formatGpxFileSize = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024, unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
  };
  protected readonly importGpxTrack = (): void => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.gpx,application/gpx+xml,application/xml,text/xml'; input.multiple = true;
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []);
      if (!files.length) return;
      void this.addGpxFiles(files);
    }, { once: true });
    input.click();
  };

  private async addGpxFiles(files: File[]): Promise<void> {
    const added: GpxTrackFile[] = [];
    const current = this.gpxTracks();
    for (const file of files) {
      const path = this.desktop?.getPathForFile(file) ?? '';
      if (current.some(track => (path && track.path === path) || (!path && track.name === file.name && track.sizeBytes === file.size))) continue;
      try {
        const content = await file.text();
        const parsed = this.parseGpxTrackData(content);
        const pointData = this.parseGpxTrackPointData(content);
        const trackPath = path || `memory:${file.name}:${file.lastModified}`;
        added.push({ path: trackPath, name: file.name, sizeBytes: file.size, lastModified: file.lastModified, active: true, color: this.gpxColors[(current.length + added.length) % this.gpxColors.length]?.value ?? this.gpxColor(), lineStyle: 'solid' });
        this.gpxSegmentsByTrack.set(trackPath, parsed);
        this.gpxPointDataByTrack.set(trackPath, pointData);
      } catch (error) {
        this.gpxError.set(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!added.length) return;
    const next = [...current, ...added];
    this.gpxTracks.set(next);
    this.saveSetting('gpxTracks', JSON.stringify(next.filter(track => !track.path.startsWith('memory:'))));
    this.gpxError.set('');
    this.rebuildGpxSegments();
    this.applyGpxTrack();
    this.fitGpxTrack();
  }

  protected readonly openGpxTrack = async (track: GpxTrackFile): Promise<void> => {
    if (!this.desktop || track.missing || track.path.startsWith('memory:')) return;
    const error = await this.desktop.ProcessManager.openPath(track.path);
    if (error) this.gpxError.set(error);
  };

  protected readonly removeGpxTrack = async (path: string): Promise<void> => {
    const next = this.gpxTracks().filter(track => track.path !== path);
    this.gpxSegmentsByTrack.delete(path);
    this.gpxPointDataByTrack.delete(path);
    this.gpxTracks.set(next);
    this.saveSetting('gpxTracks', JSON.stringify(next.filter(track => !track.path.startsWith('memory:'))));
    await this.reloadGpxTracks();
  };

  private async readGpxFileMetadata(path: string): Promise<{ size: number; modifiedAt: number } | null> {
    if (!this.desktop) return null;
    try {
      const directory = await this.desktop.FileSystem.dirname(path);
      const fileName = path.split(/[\\/]/).pop()?.toLowerCase();
      if (!fileName) return null;
      const entries = await this.desktop.FileSystem.readDir(directory);
      const file = entries.find(entry => !entry.isDirectory && entry.name.toLowerCase() === fileName);
      return file ? { size: file.size, modifiedAt: file.modifiedAt ?? file.createdAt } : null;
    } catch {
      return null;
    }
  }

  private async reloadGpxTracks(): Promise<void> {
    if (!this.desktop) return;
    const segments: [number, number][][] = [];
    const valid: GpxTrackFile[] = [];
    this.gpxSegmentsByTrack.clear();
    this.gpxPointDataByTrack.clear();
    for (const track of this.gpxTracks()) {
      if (track.path.startsWith('memory:')) continue;
      const [result, metadata] = await Promise.all([
        this.desktop.FileSystem.readText(track.path),
        this.readGpxFileMetadata(track.path)
      ]);
      if (!result.success) { valid.push({ ...track, missing: metadata === null, readError: metadata !== null }); continue; }
      try {
        const parsed = this.parseGpxTrackData(result.data);
        this.gpxPointDataByTrack.set(track.path, this.parseGpxTrackPointData(result.data));
        this.gpxSegmentsByTrack.set(track.path, parsed);
        if (track.active !== false) segments.push(...parsed);
        valid.push({ ...track, sizeBytes: metadata?.size ?? track.sizeBytes, lastModified: metadata?.modifiedAt ?? track.lastModified, missing: false, readError: false, active: track.active !== false, color: this.gpxColors.some(item => item.value === track.color) ? track.color : this.gpxColor(), lineStyle: ['dashed', 'dotted', 'long-dashed', 'short-dashed', 'dash-dot', 'dash-dot-dot'].includes(track.lineStyle ?? '') ? track.lineStyle : 'solid', lineWidth: [1, 2, 3, 4, 5, 6, 8, 10].includes(track.lineWidth ?? 4) ? track.lineWidth : 4 });
      }
      catch { /* Keep malformed files out of the rendered track set. */ }
    }
    this.gpxTracks.set(valid);
    this.saveSetting('gpxTracks', JSON.stringify(valid));
    this.rebuildGpxSegments();
    this.applyGpxTrack();
  }

  private async restoreGpxTrack(): Promise<void> {
    if (!this.desktop) return;
    let tracks: GpxTrackFile[] = [];
    try {
      const stored = JSON.parse(this.readSetting('gpxTracks', '[]')) as GpxTrackFile[];
      if (Array.isArray(stored)) tracks = stored.filter(track => track && typeof track.path === 'string' && typeof track.name === 'string');
    } catch { /* Fall back to the legacy single-file setting below. */ }
    if (!tracks.length) {
      const legacyPath = this.readSetting('gpxPath', '');
      const legacyName = this.readSetting('gpxFileName', '');
      if (legacyPath && legacyName) tracks = [{ path: legacyPath, name: legacyName, sizeBytes: 0, lastModified: 0 }];
    }
    const segments: [number, number][][] = [];
    const available: GpxTrackFile[] = [];
    this.gpxSegmentsByTrack.clear();
    this.gpxPointDataByTrack.clear();
    for (const track of tracks) {
      const [result, metadata] = await Promise.all([
        this.desktop.FileSystem.readText(track.path),
        this.readGpxFileMetadata(track.path)
      ]);
      if (!result.success) { available.push({ ...track, missing: metadata === null, readError: metadata !== null }); continue; }
      try {
        const parsed = this.parseGpxTrackData(result.data);
        this.gpxPointDataByTrack.set(track.path, this.parseGpxTrackPointData(result.data));
        const active = track.active !== false;
        this.gpxSegmentsByTrack.set(track.path, parsed);
        if (active) segments.push(...parsed);
        available.push({ ...track, sizeBytes: metadata?.size ?? track.sizeBytes, lastModified: metadata?.modifiedAt ?? track.lastModified, missing: false, readError: false, active, color: this.gpxColors.some(item => item.value === track.color) ? track.color : this.gpxColor(), lineStyle: ['dashed', 'dotted', 'long-dashed', 'short-dashed', 'dash-dot', 'dash-dot-dot'].includes(track.lineStyle ?? '') ? track.lineStyle : 'solid', lineWidth: [1, 2, 3, 4, 5, 6, 8, 10].includes(track.lineWidth ?? 4) ? track.lineWidth : 4 });
      } catch (error) { this.gpxError.set(`${track.name}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    this.gpxTracks.set(available);
    this.saveSetting('gpxTracks', JSON.stringify(available));
    this.rebuildGpxSegments();
    this.applyGpxTrack();
  }

  protected readonly changeGpxTrackColor = (path: string, color: string): void => {
    if (!this.gpxColors.some(item => item.value === color)) return;
    this.updateGpxTrack(path, { color });
    this.gpxTrackColorMenuOpen.set(null);
  };
  protected readonly changeGpxTrackLineStyle = (path: string, lineStyle: string): void => {
    if (!['solid', 'dashed', 'dotted', 'long-dashed', 'short-dashed', 'dash-dot', 'dash-dot-dot'].includes(lineStyle)) return;
    this.updateGpxTrack(path, { lineStyle: lineStyle as GpxTrackFile['lineStyle'] });
    this.gpxTrackLineStyleMenuOpen.set(null);
  };
  protected readonly changeGpxTrackLineWidth = (path: string, value: string): void => {
    const lineWidth = Number(value);
    if (![1, 2, 3, 4, 5, 6, 8, 10].includes(lineWidth)) return;
    this.updateGpxTrack(path, { lineWidth });
  };
  protected readonly changeGpxTrackDirection = (path: string, value: string): void => {
    const styles = ['classic', 'chevron', 'triangle', 'thin', 'large-classic', 'large-chevron', 'large-triangle'];
    if (value !== 'off' && !styles.includes(value)) return;
    this.updateGpxTrack(path, { showDirection: value !== 'off', directionStyle: value === 'off' ? undefined : value as GpxTrackFile['directionStyle'] });
    this.gpxTrackDirectionMenuOpen.set(null);
  };
  private gpxDirectionArrows(segment: [number, number][]): Array<{ position: [number, number]; bearing: number }> {
    const arrows: Array<{ position: [number, number]; bearing: number }> = [];
    const intervalMeters = 160;
    let distanceSinceArrow = 0;
    for (let i = 1; i < segment.length; i++) {
      const [lat1, lon1] = segment[i - 1];
      const [lat2, lon2] = segment[i];
      const radians = Math.PI / 180;
      const dLat = (lat2 - lat1) * radians;
      const dLon = (lon2 - lon1) * radians;
      const meanLat = ((lat1 + lat2) / 2) * radians;
      const length = 6371000 * Math.hypot(dLat, dLon * Math.cos(meanLat));
      if (!Number.isFinite(length) || length <= 0) continue;
      const y = Math.sin(dLon) * Math.cos(lat2 * radians);
      const x = Math.cos(lat1 * radians) * Math.sin(lat2 * radians) -
        Math.sin(lat1 * radians) * Math.cos(lat2 * radians) * Math.cos(dLon);
      const bearing = (Math.atan2(y, x) / radians + 360) % 360;
      let remaining = intervalMeters - distanceSinceArrow;
      while (remaining <= length) {
        const fraction = remaining / length;
        arrows.push({ position: [lat1 + (lat2 - lat1) * fraction, lon1 + (lon2 - lon1) * fraction], bearing });
        remaining += intervalMeters;
      }
      distanceSinceArrow = (distanceSinceArrow + length) % intervalMeters;
    }
    return arrows;
  }
  private updateGpxTrack(path: string, patch: Partial<Pick<GpxTrackFile, 'color' | 'lineStyle' | 'lineWidth' | 'showDirection' | 'directionStyle' | 'active'>>): void {
    const next = this.gpxTracks().map(track => track.path === path ? { ...track, ...patch } : track);
    this.gpxTracks.set(next);
    this.saveSetting('gpxTracks', JSON.stringify(next.filter(track => !track.path.startsWith('memory:'))));
    this.applyGpxTrack();
  }

  protected readonly changeGpxTrackActive = (path: string, active: boolean): void => {
    const next = this.gpxTracks().map(track => track.path === path ? { ...track, active } : track);
    this.gpxTracks.set(next);
    this.saveSetting('gpxTracks', JSON.stringify(next.filter(track => !track.path.startsWith('memory:'))));
    this.rebuildGpxSegments();
    this.applyGpxTrack();
  };

  private rebuildGpxSegments(): void {
    // Update the time range before filtering points; otherwise the initial
    // persisted slider range (0..0) hides every timestamped point.
    this.updateTimeSliderBounds();
    this.gpxSegments = this.gpxTracks()
      .filter(track => track.active !== false)
      .flatMap(track => this.visibleGpxSegments(track));
    this.updateWalkingMarker();
  }

  private visibleGpxSegments(track: GpxTrackFile): [number, number][][] {
    const source = this.gpxSegmentsByTrack.get(track.path) ?? [];
    if (!this.timeSliderActive()) return source;
    const pointSegments = this.gpxPointDataByTrack.get(track.path) ?? [];
    const visible: [number, number][][] = [];
    for (const segment of pointSegments) {
      let run: [number, number][] = [];
      const flush = (): void => { if (run.length >= 2) visible.push(run); run = []; };
      for (const point of segment) {
        const timestamp = point.timestamp ? Date.parse(point.timestamp) / 1000 : Number.NaN;
        if (Number.isFinite(timestamp) && timestamp >= this.timeSliderStart() && timestamp <= this.timeSliderEnd()) {
          run.push([point.latitude, point.longitude]);
        } else flush();
      }
      flush();
    }
    return visible;
  }

  private isTimeSliderTimestampVisible(timestamp: number | null | undefined): boolean {
    if (!this.timeSliderActive()) return true;
    return timestamp != null && Number.isFinite(timestamp)
      && timestamp >= this.timeSliderStart() && timestamp <= this.timeSliderEnd();
  }

  protected readonly timeSliderBoundarySource = (timestamp: number): string => {
    // A single available timestamp gets a +1 second slider span; its source is still the original timestamp.
    const sourceTimestamp = timestamp === this.timeSliderMaximum()
      && this.timeSliderMaximum() === this.timeSliderMinimum() + 1
      ? this.timeSliderMinimum() : timestamp;
    const sources: string[] = [];
    for (const track of this.gpxTracks().filter(item => item.active !== false)) {
      const points = (this.gpxPointDataByTrack.get(track.path) ?? []).flat();
      if (points.some(point => point.timestamp && Number.isFinite(Date.parse(point.timestamp))
        && Math.floor(Date.parse(point.timestamp) / 1000) === sourceTimestamp)) {
        sources.push('GPX: ' + track.name);
      }
    }
    if (this.directoryMarkersEnabled()) {
      for (const marker of this.directoryPhotoTimestampMarkers) {
        if (marker.gpsTimestamp != null && Number.isFinite(marker.gpsTimestamp)
          && marker.gpsTimestamp === sourceTimestamp) {
          sources.push('Photo: ' + marker.fileName);
        }
      }
    }
    return sources.length ? [...new Set(sources)].join(' · ') : 'Unknown';
  };

  private updateTimeSliderBounds(): void {
    const timestamps = [
      ...this.gpxTracks().filter(track => track.active !== false)
        .flatMap(track => (this.gpxPointDataByTrack.get(track.path) ?? []).flat())
        .map(point => point.timestamp ? Date.parse(point.timestamp) / 1000 : Number.NaN),
      ...(this.directoryMarkersEnabled()
        ? this.directoryPhotoTimestampMarkers.map(marker => marker.gpsTimestamp ?? Number.NaN)
        : [])
    ].filter(value => Number.isFinite(value));
    if (!timestamps.length) {
      this.timeSliderMinimum.set(0);
      this.timeSliderMaximum.set(0);
      this.timeSliderStart.set(0);
      this.timeSliderEnd.set(0);
      this.timeSliderRangeInitialized = false;
      return;
    }
    const minimum = Math.min(...timestamps);
    const maximum = Math.max(...timestamps);
    const effectiveMaximum = maximum > minimum ? maximum : minimum + 1;
    const previousMinimum = this.timeSliderMinimum();
    const previousMaximum = this.timeSliderMaximum();
    const firstInitialization = !this.timeSliderRangeInitialized;
    const previouslyFullRange = firstInitialization
      || (this.timeSliderStart() <= previousMinimum && this.timeSliderEnd() >= previousMaximum);
    this.timeSliderMinimum.set(minimum);
    this.timeSliderMaximum.set(effectiveMaximum);
    if (firstInitialization) {
      const storedStart = Number(this.readSetting('timeSliderStart', 'NaN'));
      const storedEnd = Number(this.readSetting('timeSliderEnd', 'NaN'));
      const hasStoredRange = Number.isFinite(storedStart) && Number.isFinite(storedEnd) && storedStart <= storedEnd;
      this.timeSliderStart.set(hasStoredRange ? Math.max(minimum, Math.min(storedStart, effectiveMaximum)) : minimum);
      this.timeSliderEnd.set(hasStoredRange ? Math.max(this.timeSliderStart(), Math.min(storedEnd, effectiveMaximum)) : effectiveMaximum);
      this.timeSliderRangeInitialized = true;
    } else if (previouslyFullRange) {
      this.timeSliderStart.set(minimum);
      this.timeSliderEnd.set(effectiveMaximum);
    } else {
      this.timeSliderStart.set(Math.max(minimum, Math.min(this.timeSliderStart(), effectiveMaximum)));
      this.timeSliderEnd.set(Math.max(this.timeSliderStart(), Math.min(this.timeSliderEnd(), effectiveMaximum)));
    }
  }

  protected readonly timeSliderStartPercent = (): number => {
    const span = this.timeSliderMaximum() - this.timeSliderMinimum();
    return span > 0 ? Math.max(0, Math.min(100, (this.timeSliderStart() - this.timeSliderMinimum()) / span * 100)) : 0;
  };

  protected readonly timeSliderEndPercent = (): number => {
    const span = this.timeSliderMaximum() - this.timeSliderMinimum();
    return span > 0 ? Math.max(0, Math.min(100, (this.timeSliderEnd() - this.timeSliderMinimum()) / span * 100)) : 100;
  };

  protected readonly timeSliderWidthPercent = (): number => {
    const span = this.timeSliderMaximum() - this.timeSliderMinimum();
    return span > 0 ? Math.max(0, Math.min(100, (this.timeSliderEnd() - this.timeSliderStart()) / span * 100)) : 100;
  };

  protected readonly timeSliderHelpText = (): string => {
    const hasActiveTracks = this.gpxTracks().some(track => track.active !== false);
    const hasPhotoMarkers = this.directoryMarkersEnabled();
    if (hasActiveTracks && hasPhotoMarkers) return 'Only GPX track points and photos within this time range are shown.';
    if (hasActiveTracks) return 'Only GPX tracks within this time range are shown.';
    if (hasPhotoMarkers) return 'Only photos within this time range are shown.';
    return 'No active GPX tracks or photo markers.';
  };

  protected readonly formatTimeSliderDate = (timestamp: number): string =>
    Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000).toLocaleString(this.locale) : '–';

  protected readonly formatTimeSliderDuration = (start: number, end: number): string => {
    const totalMinutes = Math.max(0, Math.floor((end - start) / 60));
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    const parts: string[] = [];
    if (days > 0) parts.push(days + (days === 1 ? ' day' : ' days'));
    if (hours > 0) parts.push(hours + (hours === 1 ? ' hour' : ' hours'));
    if (minutes > 0 || parts.length === 0) parts.push(minutes + (minutes === 1 ? ' minute' : ' minutes'));
    return parts.join(', ');
  };

  protected readonly clearTimeSliderTextSelection = (): void => {
    window.getSelection()?.removeAllRanges();
  };

  protected readonly changeTimeSliderActive = (active: boolean): void => {
    this.timeSliderActive.set(active);
    this.saveSetting('timeSliderActive', active);
    this.rebuildGpxSegments();
    this.applyGpxTrack();
    this.applyDirectoryPhotoMarkers();
    this.applyCurrentPhotoVisibility();
  };

  private timeSliderHandleGap(_trackWidth: number): number {
    // The handles are visually offset by half their width in CSS, so equal timestamps
    // still render edge-to-edge without introducing an artificial time gap.
    return 0;
  }

  protected readonly toggleTimeSliderAnimation = (): void => {
    if (this.timeSliderAnimating()) {
      this.stopTimeSliderAnimation();
      return;
    }
    if (!this.timeSliderActive() || !this.timeSliderHasData() || this.timeSliderEnd() >= this.timeSliderMaximum()) return;
    const track = this.firstActiveGpxTrack();
    const firstTimestamp = track ? (this.gpxPointDataByTrack.get(track.path) ?? []).flat().map(point => point.timestamp ? Date.parse(point.timestamp) / 1000 : Number.NaN).find(value => Number.isFinite(value)) : undefined;
    if (firstTimestamp !== undefined) this.setTimeSliderEnd(Math.max(this.timeSliderMinimum(), Math.min(this.timeSliderMaximum(), firstTimestamp)));
    this.timeSliderAnimating.set(true);
    const span = this.timeSliderMaximum() - this.timeSliderMinimum();
    // At 1×, traverse the full time range in about 60 seconds.
    const increment = span / 1200;
    this.timeSliderAnimationTimer = setInterval(() => {
      const next = Math.min(this.timeSliderMaximum(), this.timeSliderEnd() + increment * this.timeSliderAnimationSpeed());
      this.setTimeSliderEnd(next);
      if (next >= this.timeSliderMaximum()) this.stopTimeSliderAnimation();
    }, 50);
  };

  private stopTimeSliderAnimation(): void {
    if (this.timeSliderAnimationTimer !== null) clearInterval(this.timeSliderAnimationTimer);
    this.timeSliderAnimationTimer = null;
    this.timeSliderAnimating.set(false);
    // Immediately remove the walking gait when playback is stopped; otherwise
    // the last timer tick can leave the CSS animation class active on the marker.
    this.updateWalkingMarker();
  }

  protected readonly changeTimeSliderAnimationSpeed = (value: string | number): void => {
    const speed = Math.max(0.1, Math.min(10, Math.round(Number(value) * 10) / 10));
    if (!Number.isFinite(speed)) return;
    this.timeSliderAnimationSpeed.set(speed);
    this.saveSetting('timeSliderAnimationSpeed', speed);
    if (this.timeSliderAnimating()) {
      this.stopTimeSliderAnimation();
      this.toggleTimeSliderAnimation();
    }
  };

  private firstActiveGpxTrack(): GpxTrackFile | undefined {
    return this.gpxTracks().find(track => track.active !== false && !track.missing && (this.gpxPointDataByTrack.get(track.path)?.some(segment => segment.length > 0) ?? false));
  }

  protected readonly changeTimeSliderWalkerVisibility = (visible: boolean): void => {
    this.timeSliderWalkerVisible.set(visible);
    this.saveSetting('timeSliderWalkerVisible', visible);
    this.updateWalkingMarker();
  };

  protected readonly changeWalkingFigureSize = (value: string | number): void => {
    const size = Math.max(0.5, Math.min(3, Math.round(Number(value) * 10) / 10));
    if (!Number.isFinite(size)) return;
    this.walkingFigureSize.set(size);
    this.saveSetting('walkingFigureSize', size);
    this.updateWalkingMarker();
  };

  protected readonly changeWalkingFigureAnimationSpeed = (value: string | number): void => {
    const speed = Math.max(0.2, Math.min(3, Math.round(Number(value) * 10) / 10));
    if (!Number.isFinite(speed)) return;
    this.walkingFigureAnimationSpeed.set(speed);
    this.saveSetting('walkingFigureAnimationSpeed', speed);
    this.updateWalkingMarker();
  };

  protected readonly changeWalkingFigureType = (value: string): void => {
    if (!['walker', 'car', 'taxi', 'racecar', 'van', 'pickup', 'ambulance', 'police', 'firetruck', 'bus', 'truck', 'delivery', 'plane', 'helicopter', 'train', 'bicycle', 'motorcycle', 'scooter', 'tractor', 'boat', 'ship', 'sailboat', 'rocket'].includes(value)) return;
    this.walkingFigureType.set(value as 'walker' | 'car' | 'van' | 'bus' | 'truck' | 'plane' | 'helicopter' | 'train' | 'bicycle' | 'motorcycle' | 'scooter' | 'tractor' | 'boat');
    this.saveSetting('walkingFigureType', value);
    this.updateWalkingMarker();
  };

  private ensureWalkingFigureAnimationStyles(): void {
    // The walker SVG is inserted with innerHTML by Leaflet/MapLibre. Angular's
    // emulated component styles add _ngcontent attributes, so scoped CSS cannot
    // reach these dynamically-created SVG paths. Install the animation rules
    // globally once so the limbs animate in both online and offline renderers.
    if (document.getElementById('lumascope-walker-animation-styles')) return;
    const style = document.createElement('style');
    style.id = 'lumascope-walker-animation-styles';
    style.textContent = `
      .lumascope-walker .walker-limb {
        transform-box: fill-box;
        transform-origin: top center;
        animation: none;
      }
      .lumascope-walker.is-moving .walker-limb {
        animation: lumascope-walker-step var(--walker-animation-duration, .72s) ease-in-out infinite alternate;
      }
      .lumascope-walker .walker-arm,
      .lumascope-walker .walker-leg {
        animation-duration: var(--walker-animation-duration, .72s);
      }
      .lumascope-walker .walker-leg.back,
      .lumascope-walker .walker-arm.back {
        animation-direction: alternate-reverse;
      }
      @keyframes lumascope-walker-step {
        from { transform: rotate(-16deg); }
        to { transform: rotate(16deg); }
      }`;
    document.head.appendChild(style);
  }

  private updateWalkingMarker(): void {
    if (!this.timeSliderWalkerVisible() || (!this.leaflet || !this.map) && !this.offlineRenderer || !this.timeSliderActive()) {
      this.walkingMarker?.remove(); this.walkingMarker = null;
      this.walkingMapLibreMarker?.remove(); this.walkingMapLibreMarker = null;
      this.offlineRenderer?.clearWalkingFigure();
      return;
    }

    this.ensureWalkingFigureAnimationStyles();

    // Keep each GPX segment separate: joining separate segments or tracks can
    // put the animated symbol on a straight line that is not part of the GPX.
    const activeTracks = this.gpxTracks().filter(track => track.active !== false && !track.missing);
    const timedSegments = activeTracks.flatMap(track =>
      (this.gpxPointDataByTrack.get(track.path) ?? []).map(segment =>
        segment.map(point => ({ point, time: point.timestamp ? Date.parse(point.timestamp) / 1000 : Number.NaN }))
          .filter(item => Number.isFinite(item.time))
          .sort((a, b) => a.time - b.time)
      ).filter(segment => segment.length > 0)
    );
    const currentTime = this.timeSliderEnd();
    let latitude: number, longitude: number, bearing = this.lastWalkingBearing;
    let trackSpeedMetersPerSecond = 0;
    const selectedSegment = timedSegments.find(segment =>
      currentTime >= segment[0].time && currentTime <= segment[segment.length - 1].time
    );

    if (selectedSegment) {
      const coordinateAt = (time: number): [number, number] => {
        const nextIndex = selectedSegment.findIndex(item => item.time >= time);
        if (nextIndex <= 0) return [selectedSegment[0].point.latitude, selectedSegment[0].point.longitude];
        if (nextIndex < 0) {
          const last = selectedSegment[selectedSegment.length - 1].point;
          return [last.latitude, last.longitude];
        }
        const a = selectedSegment[nextIndex - 1], b = selectedSegment[nextIndex];
        const fraction = Math.max(0, Math.min(1, (time - a.time) / Math.max(0.001, b.time - a.time)));
        return [
          a.point.latitude + (b.point.latitude - a.point.latitude) * fraction,
          a.point.longitude + (b.point.longitude - a.point.longitude) * fraction
        ];
      };
      [latitude, longitude] = coordinateAt(currentTime);

      // Use the same local GPX interval for heading and speed, avoiding GPS jitter.
      const headingWindowSeconds = 4;
      const beforeTime = Math.max(selectedSegment[0].time, currentTime - headingWindowSeconds / 2);
      const afterTime = Math.min(selectedSegment[selectedSegment.length - 1].time, currentTime + headingWindowSeconds / 2);
      const before = coordinateAt(beforeTime);
      const after = coordinateAt(afterTime);
      const meanLatitude = (before[0] + after[0]) * Math.PI / 360;
      const north = (after[0] - before[0]) * Math.PI / 180;
      const east = (after[1] - before[1]) * Math.PI / 180 * Math.cos(meanLatitude);
      const distance = Math.hypot(north, east) * 6371000;
      const elapsed = Math.max(0, afterTime - beforeTime);
      if (distance >= 1.5) bearing = (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
      if (elapsed > 0) trackSpeedMetersPerSecond = distance / elapsed;
      this.lastWalkingBearing = bearing;
    } else if (timedSegments.length) {
      // Outside a recorded segment, stay on the nearest actual GPX point.
      const nearest = timedSegments.flat().reduce((best, item) =>
        Math.abs(item.time - currentTime) < Math.abs(best.time - currentTime) ? item : best
      );
      latitude = nearest.point.latitude;
      longitude = nearest.point.longitude;
    } else {
      const track = activeTracks.find(item => (this.gpxPointDataByTrack.get(item.path)?.some(segment => segment.length > 0) ?? false));
      const points = track ? (this.gpxPointDataByTrack.get(track.path) ?? []).flat() : [];
      if (!points.length) {
        this.walkingMarker?.remove(); this.walkingMarker = null;
        this.walkingMapLibreMarker?.remove(); this.walkingMapLibreMarker = null;
        return;
      }
      const fraction = Math.max(0, Math.min(1, (currentTime - this.timeSliderMinimum()) / Math.max(1, this.timeSliderMaximum() - this.timeSliderMinimum())));
      const index = Math.min(points.length - 1, Math.floor(fraction * (points.length - 1)));
      latitude = points[index].latitude;
      longitude = points[index].longitude;
      const next = points[Math.min(points.length - 1, index + 1)];
      const north = (next.latitude - latitude) * Math.PI / 180;
      const east = (next.longitude - longitude) * Math.PI / 180 * Math.cos(latitude * Math.PI / 180);
      if (Math.hypot(north, east) * 6371000 >= 1.5) bearing = (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
      this.lastWalkingBearing = bearing;
    }

    // Smooth compass heading across playback ticks. Circular angle interpolation
    // avoids 359°↔0° flips; a turn-rate limit filters abrupt GPS bearing spikes.
    const bearingNow = Date.now();
    if (this.smoothedWalkingBearing === null) {
      this.smoothedWalkingBearing = bearing;
    } else {
      const elapsedSeconds = Math.max(0.016, Math.min(0.5, (bearingNow - this.lastWalkingBearingUpdate) / 1000));
      const delta = ((bearing - this.smoothedWalkingBearing + 540) % 360) - 180;
      const filteredDelta = delta * (1 - Math.exp(-elapsedSeconds / 0.9));
      const maxTurn = 75 * elapsedSeconds;
      this.smoothedWalkingBearing = (this.smoothedWalkingBearing + Math.max(-maxTurn, Math.min(maxTurn, filteredDelta)) + 360) % 360;
    }
    this.lastWalkingBearingUpdate = bearingNow;
    bearing = this.smoothedWalkingBearing;
    this.lastWalkingBearing = bearing;

    // The timeline traverses its complete range in about 60 seconds at 1×.
    // Convert recorded GPX speed into the symbol's actual on-screen travel speed.
    const timelineFactor = this.timeSliderAnimating()
      ? (this.timeSliderMaximum() - this.timeSliderMinimum()) / 60 * this.timeSliderAnimationSpeed()
      : 0;
    const displayedSpeed = trackSpeedMetersPerSecond * timelineFactor;
    const isWalking = this.walkingFigureType() === 'walker';
    const isMoving = isWalking && this.timeSliderAnimating() && displayedSpeed >= 0.15;
    const gaitSpeed = Math.max(0.2, Math.min(3,
      displayedSpeed / 1.4 * this.walkingFigureAnimationSpeed()));
    const figureType = this.walkingFigureType();
    const vehicleSymbols: Record<string, string> = {
      car: '🚗', taxi: '🚕', racecar: '🏎️', van: '🚐', pickup: '🛻',
      ambulance: '🚑', police: '🚓', firetruck: '🚒', bus: '🚌',
      truck: '🚚', delivery: '🚛', plane: '✈️', helicopter: '🚁',
      train: '🚆', bicycle: '🚲', motorcycle: '🏍️', scooter: '🛵',
      tractor: '🚜', boat: '🚤', ship: '🚢', sailboat: '⛵', rocket: '🚀'
    };
    const orientationOffset = ['car', 'taxi', 'racecar', 'van', 'pickup', 'ambulance', 'police', 'firetruck', 'bus', 'truck', 'delivery', 'bicycle', 'motorcycle', 'scooter', 'tractor'].includes(figureType) ? -90 : 0;
    const html = isWalking
      ? `<div class="lumascope-walker" data-figure-type="walker" style="display:block;width:24px;height:30px;position:relative;filter:drop-shadow(0 1px 1px #000b);transform-origin:50% 50%"><svg width="24" height="30" viewBox="0 0 30 38" style="display:block;width:24px;height:30px;overflow:visible" aria-hidden="true"><circle cx="15" cy="6" r="4.2" fill="#ffd166" stroke="#202020" stroke-width="1.2"/><path d="M15 11 L15 23" stroke="#1769aa" stroke-width="5" stroke-linecap="round"/><path class="walker-limb walker-arm back" d="M14 14 L8 21" stroke="#ffd166" stroke-width="3.2" stroke-linecap="round"/><path class="walker-limb walker-arm" d="M16 14 L22 21" stroke="#ffd166" stroke-width="3.2" stroke-linecap="round"/><path class="walker-limb walker-leg back" d="M14 23 L9 34" stroke="#263238" stroke-width="4" stroke-linecap="round"/><path class="walker-limb walker-leg" d="M16 23 L21 34" stroke="#263238" stroke-width="4" stroke-linecap="round"/></svg></div>`
      : `<div class="lumascope-walker lumascope-vehicle" data-figure-type="${figureType}" style="display:flex;align-items:center;justify-content:center;width:32px;height:32px;font-family:'Segoe UI Emoji',sans-serif;font-size:27px;line-height:1;filter:drop-shadow(0 1px 2px #000b);transform-origin:50% 50%">${vehicleSymbols[figureType]}</div>`;
    if (this.offlineRenderer) {
      this.walkingMarker?.remove(); this.walkingMarker = null;
      this.walkingMapLibreMarker?.remove(); this.walkingMapLibreMarker = null;
      this.offlineRenderer.setWalkingFigure(latitude, longitude, html, bearing + orientationOffset, this.walkingFigureSize(), gaitSpeed, figureType, isMoving);
      return;
    }
    this.walkingMapLibreMarker?.remove(); this.walkingMapLibreMarker = null;
    if (!this.leaflet || !this.map) return;
    const existingElement = this.walkingMarker?.getElement()?.querySelector<HTMLElement>('.lumascope-walker');
    if (existingElement?.dataset['figureType'] !== figureType) {
      this.walkingMarker?.remove();
      this.walkingMarker = null;
    }
    if (!this.walkingMarker) {
      const icon = this.leaflet.divIcon({ className: 'lumascope-walker-icon', html, iconSize: [34, 34], iconAnchor: [17, 17] });
      this.walkingMarker = this.leaflet.marker([latitude, longitude], { icon }).addTo(this.map);
    } else {
      this.walkingMarker.setLatLng([latitude, longitude]);
    }
    const walkerElement = this.walkingMarker.getElement()?.querySelector<HTMLElement>('.lumascope-walker');
    if (walkerElement) {
      walkerElement.classList.toggle('is-moving', isMoving);
      walkerElement.style.transform = `rotate(${bearing + orientationOffset}deg) scale(${this.walkingFigureSize()})`;
      walkerElement.style.setProperty('--walker-animation-duration', `${0.72 / gaitSpeed}s`);
    }
  }

  private setTimeSliderEnd(next: number): void {
    this.timeSliderEnd.set(next);
    this.saveSetting('timeSliderEnd', next);
    this.rebuildGpxSegments();
    this.applyGpxTrack();
    this.applyDirectoryPhotoMarkers();
    this.applyCurrentPhotoVisibility();
    this.updateWalkingMarker();
  }

  protected readonly changeTimeSliderStart = (input: HTMLInputElement): void => {
    const timestamp = Number(input.value);
    if (!Number.isFinite(timestamp)) return;
    const gap = this.timeSliderHandleGap(input.parentElement?.getBoundingClientRect().width ?? 0);
    const next = Math.min(timestamp, Math.max(this.timeSliderMinimum(), this.timeSliderEnd() - gap));
    input.value = String(next);
    this.timeSliderStart.set(next);
    this.saveSetting('timeSliderStart', next);
    this.rebuildGpxSegments();
    this.applyGpxTrack();
    this.applyDirectoryPhotoMarkers();
    this.applyCurrentPhotoVisibility();
    this.updateWalkingMarker();
  };

  protected readonly changeTimeSliderEnd = (input: HTMLInputElement): void => {
    this.stopTimeSliderAnimation();
    const timestamp = Number(input.value);
    if (!Number.isFinite(timestamp)) return;
    const gap = this.timeSliderHandleGap(input.parentElement?.getBoundingClientRect().width ?? 0);
    const next = Math.max(timestamp, Math.min(this.timeSliderMaximum(), this.timeSliderStart() + gap));
    input.value = String(next);
    this.setTimeSliderEnd(next);
  };

  private applyCurrentPhotoVisibility(): void {
    const currentPhoto = this.timeSliderActive()
      ? this.directoryPhotoTimestampMarkers.find(marker => marker.path.toLowerCase() === this.currentImagePath?.toLowerCase())
      : null;
    const withinTimeRange = !this.timeSliderActive() || currentPhoto == null
      || this.isTimeSliderTimestampVisible(currentPhoto.gpsTimestamp);
    const opacity = this.locationVisible() && withinTimeRange ? this.locationOpacity() / 100 : 0;
    this.marker?.setOpacity(opacity);
    this.offlineRenderer?.setCurrentOpacity(opacity);
  }

  private applyDirectoryPhotoMarkers(): void {
    const visibleMarkers = this.directoryPhotoMarkers.filter(marker => this.isTimeSliderTimestampVisible(marker.gpsTimestamp));
    if (this.offlineRenderer) {
      this.markerCount.set(visibleMarkers.length);
      this.offlineRenderer.setPhotoMarkers(visibleMarkers, path => { void this.desktop?.MapWindow.selectImage(path); }, (this.markersVisible() ? this.markerOpacity() / 100 : 0));
    } else if (this.leaflet && this.directoryMarkerGroup) {
      this.renderDirectoryMarkers(visibleMarkers, this.currentImagePath ?? '');
    }
  }

  private parseMarkerFileNameTimestamp(fileName: string): number | null {
    const separated = fileName.match(/(?:^|[^0-9])(\\d{4})[_-](\\d{2})[_-](\\d{2})[ T_-](\\d{2})[_:-](\\d{2})[_:-](\\d{2})(?:[^0-9]|$)/);
    const compact = separated ? null : fileName.match(/(?:^|[^0-9])(\\d{4})(\\d{2})(\\d{2})[_ T-](\\d{2})(\\d{2})(\\d{2})(?:[^0-9]|$)/);
    const match = separated ?? compact;
    if (!match) return null;
    const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
    const year = Number(yearText), month = Number(monthText), day = Number(dayText);
    const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
    const date = new Date(year, month - 1, day, hour, minute, second);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
      || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second) return null;
    return Math.floor(date.getTime() / 1000);
  }

  private interpolateMarkerTimestamps<T extends { latitude: number; longitude: number; fileName: string; gpsTimestamp?: number | null }>(markers: T[]): Array<T & { timestamp: number | null }> {
    const result = markers.map(marker => ({
      ...marker,
      timestamp: marker.gpsTimestamp != null && Number.isFinite(marker.gpsTimestamp) && marker.gpsTimestamp > 0
        ? marker.gpsTimestamp
        : this.parseMarkerFileNameTimestamp(marker.fileName)
    }));
    const distance = (a: T, b: T): number => {
      const radians = Math.PI / 180;
      const meanLatitude = (a.latitude + b.latitude) * 0.5 * radians;
      return 6371000 * Math.hypot((b.latitude - a.latitude) * radians, (b.longitude - a.longitude) * radians * Math.cos(meanLatitude));
    };
    const known = result.map((marker, index) => marker.timestamp !== null ? index : -1).filter(index => index >= 0);
    for (let pair = 1; pair < known.length; pair++) {
      const start = known[pair - 1], end = known[pair];
      if (end - start < 2) continue;
      let totalDistance = 0;
      const distances = [0];
      for (let i = start + 1; i <= end; i++) {
        totalDistance += distance(result[i - 1], result[i]);
        distances.push(totalDistance);
      }
      const startTime = result[start].timestamp!, endTime = result[end].timestamp!;
      for (let i = start + 1; i < end; i++) {
        const fraction = totalDistance > 0 ? distances[i - start] / totalDistance : (i - start) / (end - start);
        result[i].timestamp = Math.round(startTime + (endTime - startTime) * fraction);
      }
    }
    return result;
  }

  protected readonly generateGpxFromMarkers = async (): Promise<void> => {
    const desktop = this.desktop;
    const markers = this.directoryPhotoTimestampMarkers.length ? this.directoryPhotoTimestampMarkers : this.directoryPhotoMarkers;
    if (!desktop || !markers.length) {
      this.gpxError.set('No displayed photo markers with GPS coordinates are available.');
      return;
    }
    try {
      const defaultName = 'Photo-Markers-' + new Date().toISOString().slice(0, 10) + '.gpx';
      const lastAddedTrack = [...this.gpxTracks()].reverse().find(track => !track.path.startsWith('memory:'));
      const initialFolder = lastAddedTrack
        ? await desktop.FileSystem.dirname(lastAddedTrack.path)
        : '';
      const suggestedPath = initialFolder
        ? await desktop.FileSystem.join(initialFolder, defaultName)
        : defaultName;
      const save = await desktop.Dialogs.saveFile(suggestedPath);
      if (!save.success) return;
      const destination = save.data;
      const fileName = destination.split(/[\\/]/).pop() || defaultName;
      const timedMarkers = this.interpolateMarkerTimestamps(markers)
        .filter(marker => marker.path.toLowerCase() !== this.currentImagePath?.toLowerCase());
      const points = timedMarkers.map(marker =>
        `      <trkpt lat="${marker.latitude.toFixed(8)}" lon="${marker.longitude.toFixed(8)}">${marker.timestamp !== null ? `<time>${new Date(marker.timestamp * 1000).toISOString()}</time>` : ''}<name>${this.escapeMarkerHtml(marker.fileName)}</name></trkpt>`
      ).join('\n');
      const content = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="LumaScope" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${this.escapeMarkerHtml(fileName.replace(/\.gpx$/i, ''))}</name>
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>
`;
      const result = await desktop.FileSystem.writeText(destination, content);
      if (!result.success) throw new Error(result.errorMessage);
      const parsed = this.parseGpxTrackData(content);
      const track: GpxTrackFile = {
        path: destination, name: fileName, sizeBytes: new Blob([content]).size,
        lastModified: Date.now(), active: true,
        color: this.gpxColors[this.gpxTracks().length % this.gpxColors.length]?.value ?? this.gpxColor(), lineStyle: 'solid'
      };
      this.gpxTracks.set([...this.gpxTracks(), track]);
      this.gpxSegmentsByTrack.set(destination, parsed);
      this.gpxPointDataByTrack.set(destination, this.parseGpxTrackPointData(content));
      this.saveSetting('gpxTracks', JSON.stringify(this.gpxTracks().filter(item => !item.path.startsWith('memory:'))));
      this.rebuildGpxSegments();
      this.gpxError.set('');
      this.applyGpxTrack();
      this.fitGpxTrack();
    } catch (error) {
      this.gpxError.set(error instanceof Error ? error.message : String(error));
    }
  };

  private parseGpxTrackData(content: string): [number, number][][] {
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
    return segments;
  }

  protected readonly fitGpxTrack = (path?: string): void => {
    const points = (path ? this.gpxSegmentsByTrack.get(path) ?? [] : this.gpxSegments).flat();
    if (!points.length) return;
    if (this.offlineRenderer) {
      const longitudes = points.map(point => point[1]), latitudes = points.map(point => point[0]);
      this.offlineRenderer.map.fitBounds([[Math.min(...longitudes), Math.min(...latitudes)], [Math.max(...longitudes), Math.max(...latitudes)]], { padding: 24, maxZoom: 16, duration: 0 });
      this.zoomLevel.set(this.offlineRenderer.map.getZoom()); this.saveSetting('zoom', this.offlineRenderer.map.getZoom());
    } else if (this.map) {
      const bounds: [[number, number], [number, number]] = [
        [Math.min(...points.map(point => point[0])), Math.min(...points.map(point => point[1]))],
        [Math.max(...points.map(point => point[0])), Math.max(...points.map(point => point[1]))]
      ];
      this.map.fitBounds(bounds, { padding: [24, 24], maxZoom: 16, animate: false });
      this.zoomLevel.set(this.map.getZoom()); this.saveSetting('zoom', this.map.getZoom());
    }
  };

  private parseGpxTrackPointData(content: string): GpxTrackPoint[][] {
    const xml = new DOMParser().parseFromString(content, 'application/xml');
    const segments = Array.from(xml.getElementsByTagName('*')).filter(element => element.localName === 'trkseg')
      .map(segment => Array.from(segment.getElementsByTagName('*')).filter(point => point.localName === 'trkpt')
        .map(point => this.parseGpxTrackPoint(point)).filter((point): point is GpxTrackPoint => point !== null))
      .filter(segment => segment.length > 0);
    if (segments.length) return segments;
    const points = Array.from(xml.getElementsByTagName('*'))
      .filter(point => point.localName === 'trkpt' || point.localName === 'rtept')
      .map(point => this.parseGpxTrackPoint(point)).filter((point): point is GpxTrackPoint => point !== null);
    return points.length ? [points] : [];
  }

  private parseGpxTrackPoint(point: Element): GpxTrackPoint | null {
    const coordinates = this.parseGpxPoint(point);
    if (!coordinates) return null;
    const elevationText = Array.from(point.children).find(child => child.localName === 'ele')?.textContent?.trim();
    const timestamp = Array.from(point.children).find(child => child.localName === 'time')?.textContent?.trim() || null;
    const elevation = elevationText ? Number(elevationText) : null;
    return { latitude: coordinates[0], longitude: coordinates[1], elevation: elevationText && Number.isFinite(elevation) ? elevation : null, timestamp };
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
    this.applyHillshadeSettingsIfReady(true);
  }
  private applyMapColor(): void {
    const mapLibreCanvas = this.mapElement().nativeElement.querySelector<HTMLElement>('.maplibregl-canvas');
    if (mapLibreCanvas) mapLibreCanvas.style.filter = this.filters[this.mapColor()];
    const pane = this.mapElement().nativeElement.querySelector<HTMLElement>('.leaflet-tile-pane');
    if (pane) pane.style.filter = this.filters[this.mapColor()];
  }
  private applyOpacitySettings(): void {
    // Reapply persisted values only after all map layers and restored tracks exist.
    // This keeps startup behavior identical to changing the controls manually.
    this.applyMapOpacity();
    const markerOpacity = this.markersVisible() ? this.markerOpacity() / 100 : 0;
    this.mapElement().nativeElement.style.setProperty('--marker-opacity', String(markerOpacity));
    for (const marker of this.directoryMarkers) marker.setOpacity(markerOpacity);
    this.directoryMarkerGroup?.refreshClusters?.();
    this.offlineRenderer?.setPhotoOpacity(markerOpacity);

    this.applyCurrentPhotoVisibility();
    this.offlineRenderer?.setTextLabelOpacity(this.labelsVisible() ? this.labelOpacity() / 100 : 0);
    this.applyHillshadeSettingsIfReady();
    this.applyGpxTrack();
    this.applyDirectoryPhotoMarkers();
    this.updateWalkingMarker();
    this.applyScaleVisibility();
  }

  private applyHillshadeSettingsIfReady(refreshLeafletTiles = false): void {
    if (this.offlineRenderer) {
      this.applyHillshadeSettings(this.offlineRenderer);
      return;
    }
    if (this.map && this.leaflet) this.applyLeafletHillshadeSettings(refreshLeafletTiles);
  }

  private applyLeafletHillshadeSettings(refreshTiles: boolean): void {
    const map = this.map;
    const leaflet = this.leaflet;
    const desktop = this.desktop;
    const databases = this.hillshadeDatabases().filter(database => database.enabled && database.available);
    if (!map || !leaflet || !desktop || !this.hillshadeVisible() || databases.length === 0) {
      this.leafletHillshadeLayer?.remove();
      this.leafletHillshadeLayer = null;
      return;
    }

    if (refreshTiles && this.leafletHillshadeLayer) {
      this.leafletHillshadeLayer.remove();
      this.leafletHillshadeLayer = null;
    }

    if (!this.leafletHillshadeLayer) {
      if (!this.leafletHillshadePane) {
        this.leafletHillshadePane = map.createPane('hillshadePane');
        this.leafletHillshadePane.style.zIndex = '250';
      }
      const HillshadeGridLayer = leaflet.GridLayer.extend({
        createTile: (coords, done) => {
          const canvas = document.createElement('canvas');
          canvas.width = 256;
          canvas.height = 256;
          const context = canvas.getContext('2d');
          if (!context) {
            done(new Error('Unable to create the Leaflet Hillshade tile canvas.'), canvas);
            return canvas;
          }
          void (async () => {
            try {
              const tileCount = 2 ** coords.z;
              const x = ((coords.x % tileCount) + tileCount) % tileCount;
              if (coords.y < 0 || coords.y >= tileCount) {
                done(null, canvas);
                return;
              }
              let hasImage = false;
              for (const database of databases) {
                let png: Uint8Array;
                try {
                  png = await desktop.OsmAndAtlas.renderHillshadeTile(database.path, coords.z, x, coords.y, 0);
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  if (/Hillshade tile not found/i.test(message)) continue;
                  throw error;
                }
                const buffer = new ArrayBuffer(png.byteLength);
                new Uint8Array(buffer).set(png);
                const bitmap = await createImageBitmap(new Blob([buffer], { type: 'image/png' }));
                try {
                  if (bitmap.width !== 256 || bitmap.height !== 256) {
                    throw new Error('Hillshade tile has unexpected dimensions (' + bitmap.width + 'x' + bitmap.height + ').');
                  }
                  context.globalCompositeOperation = hasImage ? 'destination-over' : 'source-over';
                  context.drawImage(bitmap, 0, 0);
                  hasImage = true;
                } finally {
                  bitmap.close();
                }
              }
              context.globalCompositeOperation = 'source-over';
              done(null, canvas);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              this.recordMapError('Online Hillshade tile', message + ' [z=' + coords.z + ', x=' + coords.x + ', y=' + coords.y + ']');
              done(error instanceof Error ? error : new Error(message), canvas);
            }
          })();
          return canvas;
        }
      });
      this.leafletHillshadeLayer = new HillshadeGridLayer({
        pane: 'hillshadePane', tileSize: 256, minZoom: 1, maxZoom: 20, maxNativeZoom: 12,
        opacity: this.hillshadeOpacity() / 100, zIndex: 250
      }).addTo(map);
    } else {
      this.leafletHillshadeLayer.setOpacity(this.hillshadeOpacity() / 100);
    }
  }

  private applyMapOpacity(): void {
    const opacity = this.mapVisible() ? this.mapOpacity() / 100 : 0;
    this.offlineRenderer?.setBasemapOpacity(opacity);
    const pane = this.mapElement().nativeElement.querySelector<HTMLElement>('.leaflet-tile-pane');
    if (pane) pane.style.opacity = String(opacity);
  }
  private gpxLineDashArray(style: NonNullable<GpxTrackFile['lineStyle']>): string | undefined {
    const patterns: Record<NonNullable<GpxTrackFile['lineStyle']>, string | undefined> = {
      solid: undefined, dashed: '10 7', dotted: '2 7', 'long-dashed': '18 7',
      'short-dashed': '5 5', 'dash-dot': '12 5 2 5', 'dash-dot-dot': '12 4 2 4 2 4'
    };
    return patterns[style];
  }

  private updateGpxHover(path: string, latitude: number, longitude: number): void {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) { this.clearGpxHover(); return; }
    this.gpxHoveredTrackPath.set(path);
    const points = (this.gpxPointDataByTrack.get(path) ?? []).flat();
    let nearest: GpxTrackPoint | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const point of points) {
      const dy = point.latitude - latitude;
      const dx = (point.longitude - longitude) * Math.cos(latitude * Math.PI / 180);
      const distance = dx * dx + dy * dy;
      if (distance < nearestDistance) { nearestDistance = distance; nearest = point; }
    }
    const parts = [
      nearest ? 'GPS ' + nearest.latitude.toFixed(6) + ', ' + nearest.longitude.toFixed(6) : 'GPS –',
      nearest?.elevation !== null && nearest?.elevation !== undefined ? 'Elevation ' + nearest.elevation.toFixed(1) + ' m' : 'Elevation –',
      nearest?.timestamp ? 'GPX time ' + (Number.isNaN(Date.parse(nearest.timestamp)) ? nearest.timestamp : new Date(nearest.timestamp).toLocaleString(this.locale)) : 'GPX time –'
    ];
    this.gpxHoverInfo.set(parts.join(' · '));
  }

  private clearGpxHover(path?: string): void {
    if (path && this.gpxHoveredTrackPath() !== path) return;
    this.gpxHoveredTrackPath.set(null);
    this.gpxHoverInfo.set('');
  }

  private applyGpxTrack(): void {
    if (this.offlineRenderer) {
      this.offlineRenderer.setTrack(this.gpxVisible() ? this.gpxTracks().filter(track => track.active !== false).map(track => ({ path: track.path, segments: this.visibleGpxSegments(track), color: track.color || this.gpxColor(), lineStyle: track.lineStyle || 'solid', lineWidth: track.lineWidth || 4, showDirection: track.showDirection === true, directionStyle: track.directionStyle || 'classic' })) : [], .92 * this.gpxOpacity() / 100);
      this.offlineRenderer.setTrackHoverHandler((path, latitude, longitude) => this.updateGpxHover(path, latitude, longitude));
      return;
    }
    for (const layer of this.trackLayers) layer.remove();
    this.trackLayers = [];
    if (!this.map || !this.leaflet || !this.gpxVisible()) return;
    for (const track of this.gpxTracks().filter(item => item.active !== false)) {
      for (const segment of this.visibleGpxSegments(track)) {
        if (segment.length < 2) continue;
        const lineStyle = track.lineStyle || 'solid';
        const trackLine = this.leaflet.polyline(segment, {
          color: track.color || this.gpxColor(), weight: track.lineWidth || 4, opacity: .92 * this.gpxOpacity() / 100,
          lineCap: 'round', lineJoin: 'round', dashArray: this.gpxLineDashArray(lineStyle)
        }).addTo(this.map);
        const hoverLine = this.leaflet.polyline(segment, {
          color: track.color || this.gpxColor(), weight: Math.max(14, (track.lineWidth || 4) + 10), opacity: .01,
          lineCap: 'round', lineJoin: 'round'
        }).addTo(this.map);
        hoverLine.on('mousemove', event => this.updateGpxHover(track.path, event.latlng.lat, event.latlng.lng));
        hoverLine.on('mouseout', () => this.clearGpxHover(track.path));
        this.trackLayers.push(trackLine, hoverLine);
        if (track.showDirection) {
          const arrowStyles: Record<NonNullable<GpxTrackFile['directionStyle']>, { glyph: string; size: number }> = {
            classic: { glyph: '➤', size: 16 }, chevron: { glyph: '❯', size: 16 }, triangle: { glyph: '▶', size: 16 }, thin: { glyph: '➜', size: 16 },
            'large-classic': { glyph: '➤', size: 24 }, 'large-chevron': { glyph: '❯', size: 24 }, 'large-triangle': { glyph: '▶', size: 24 }
          };
          const arrowStyle = arrowStyles[track.directionStyle || 'classic'];
          for (const arrow of this.gpxDirectionArrows(segment)) {
            const icon = this.leaflet.divIcon({
              className: 'gpx-direction-arrow-icon',
              html: '<span class="gpx-direction-arrow" style="font-size:' + arrowStyle.size + 'px;color:' + (track.color || this.gpxColor()) + ';opacity:' + (.92 * this.gpxOpacity() / 100) + ';transform:rotate(' + (arrow.bearing - 90) + 'deg)">' + arrowStyle.glyph + '</span>',
              iconSize: [arrowStyle.size + 4, arrowStyle.size + 4], iconAnchor: [(arrowStyle.size + 4) / 2, (arrowStyle.size + 4) / 2]
            });
            this.trackLayers.push(this.leaflet.marker(arrow.position, { icon }).addTo(this.map) as MapMarker & { remove(): void });
          }
        }
      }
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
