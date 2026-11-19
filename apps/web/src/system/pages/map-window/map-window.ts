import { ChangeDetectionStrategy, Component, ElementRef, computed, HostListener, inject, OnDestroy, OnInit, signal, viewChild } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { SliderComponent } from '@light-matter/ui';
import { GpxDatabaseImportComponent } from './gpx-database-import.component';
import { GpxTrackPreviewComponent } from './gpx-track-preview.component';
import { GalleryLocations } from '../../../gallery/services/gallery-locations/gallery-locations';
import { Desktop, formatGpsCoordinates as formatSystemGpsCoordinates, formatOsDateTime, lookupReverseGeocoding, type FixPhotoLocationsProgress, type GpxElevationProfile, type OsmAndHillshadeDatabase } from 'internal-api';
import { ThemeService } from '../../services/theme/theme.service';
import { Configuration } from '../../services/configuration/configuration';
import { take } from 'rxjs';
import { Marker as MapLibreMarker } from 'maplibre-gl';
import { buildGpxSymbolTransform, GPX_SYMBOLS, GPX_VEHICLE_SYMBOLS, gpxAnimationDuration, normalizeGpxSymbolSettings } from './gpx-animation';
import { OfflineMapRenderer, buildPhotoMarkerPreviewHtml, createOsmAndMapStyle, createOsmAndAtlasMapStyle, cacheHillshadeTile, createHillshadeTileCacheKey, getCachedHillshadeTile, registerOsmAndAtlasTileProtocol, registerOsmAndHillshadeTileProtocol, registerOsmAndTileProtocol, registerMapsforgeTileProtocol, setMapsforgeTileProtocolActive, createMapsforgeMapStyle, setOfflineRenderConcurrency, runOfflineRenderTask, subscribeOfflineRenderStatus, type OfflineRenderTaskStatus, type OfflinePhotoMarker, type OfflineMapStyle } from './offline-map-renderer';

interface MapPresetOption { id: string; name: string; osmAndRegex: string; mapsForgeRegex?: string; hillshadeRegex?: string; }
interface MapMarker { setLatLng(position: [number, number]): MapMarker; setOpacity(opacity: number): MapMarker; setIcon(icon: unknown): MapMarker; getElement(): HTMLElement | null; getLatLng(): { lat: number; lng: number }; on(event: 'click', callback: () => void): MapMarker; remove(): void; bindTooltip(content: string, options?: { direction?: string; className?: string; opacity?: number }): MapMarker; }
interface MapBounds { isValid(): boolean; }
interface ObfBoundsPreview { name: string; bounds: string | null; zoom: string; error: string | null; rectangles: Array<{ x: number; y: number; width: number; height: number }>; }
type BoundsMapKind = 'world' | 'europe';
interface BoundsMapView { x: number; y: number; width: number; height: number; }
interface MapMarkerGroup { addTo(map: MapInstance): MapMarkerGroup; addLayer(marker: MapMarker): MapMarkerGroup; clearLayers(): MapMarkerGroup; eachLayer(callback: (layer: MapMarker) => void): MapMarkerGroup; refreshClusters?(): MapMarkerGroup; remove(): void; }
interface LeafletGridLayer { addTo(map: MapInstance): LeafletGridLayer; setOpacity(opacity: number): LeafletGridLayer; redraw(): LeafletGridLayer; on(event: 'load', callback: () => void): LeafletGridLayer; remove(): void; }
interface LeafletTileLayer { addTo(map: MapInstance): LeafletTileLayer; setOpacity(opacity: number): LeafletTileLayer; on(event: 'load', callback: () => void): LeafletTileLayer; remove(): void; }
interface MapMarkerCluster { getChildCount(): number; }
interface MapInstance {
  getCenter(): { lat: number; lng: number };
  getBounds(): { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number };
  setView(center: [number, number], zoom: number): MapInstance;
  invalidateSize(): MapInstance;
  getZoom(): number;
  setZoom(zoom: number): MapInstance;
  containerPointToLatLng(point: [number, number]): { lat: number; lng: number };
  project(latlng: [number, number], zoom?: number): { x: number; y: number };
  unproject(point: [number, number], zoom?: number): { lat: number; lng: number };
  on(event: 'zoomend', callback: () => void): MapInstance;
  on(event: 'contextmenu', callback: (event: { latlng: { lat: number; lng: number }; originalEvent: MouseEvent }) => void): MapInstance;
  createPane(name: string): HTMLElement;
  fitBounds(bounds: [[number, number], [number, number]], options?: { padding?: [number, number]; maxZoom?: number; animate?: boolean }): MapInstance;
  remove(): void;
}
interface LeafletMapApi {
  map(element: HTMLElement, options?: { zoomControl?: boolean; keyboard?: boolean; minZoom?: number; maxZoom?: number }): MapInstance;
  control: { scale(options: { metric: boolean; imperial: boolean; position: 'bottomleft'; maxWidth: number }): { addTo(map: MapInstance): unknown } };
  tileLayer(url: string, options: { attribution: string; maxZoom: number; maxNativeZoom?: number }): LeafletTileLayer;
  GridLayer: { extend(definition: { createTile(coords: { x: number; y: number; z: number }, done: (error: Error | null, tile: HTMLCanvasElement) => void): HTMLCanvasElement }): new(options?: { pane?: string; opacity?: number; tileSize?: number; minZoom?: number; maxZoom?: number; maxNativeZoom?: number; zIndex?: number }) => LeafletGridLayer };
  polyline(points: [number, number][], options: { color: string; weight: number; opacity: number; lineCap: string; lineJoin: string; dashArray?: string }): { addTo(map: MapInstance): { remove(): void; on(event: 'mousemove' | 'mouseout', callback: (event: { latlng: { lat: number; lng: number } }) => void): unknown } };
  polygon(points: [number, number][], options: { color: string; weight: number; opacity: number; fillColor: string; fillOpacity: number }): { addTo(map: MapInstance): { remove(): void } };
  marker(position: [number, number], options?: { icon?: unknown }): MapMarker & { addTo(map: MapInstance | MapMarkerGroup): MapMarker };
  divIcon(options: { className: string; html: string; iconSize: [number, number]; iconAnchor: [number, number] }): unknown;
  markerClusterGroup(options?: { chunkedLoading?: boolean; showCoverageOnHover?: boolean; spiderfyOnMaxZoom?: boolean; iconCreateFunction?: (cluster: MapMarkerCluster) => unknown }): MapMarkerGroup;
}
type MapStyle = 'standard' | 'satellite' | 'cycling' | 'topographic' | 'humanitarian';
type MapColor = 'original' | 'light' | 'extra-light' | 'ultra-light' | 'dark' | 'grayscale' | 'pastel' | 'contrast' | 'night';
type MarkerShape = 'double-circle' | 'hexagon' | 'circle' | 'square';
type CurrentMarkerShape = 'pin' | 'circle' | 'square' | 'diamond';

interface GpxTrackPoint { latitude: number; longitude: number; elevation: number | null; timestamp: string | null; inViewport?: boolean; }
type RouteProfile = 'driving-car' | 'cycling-regular' | 'foot-walking';
type RouteProviderId = 'openrouteservice' | 'offline-valhalla';
interface RouteWaypoint { latitude: number; longitude: number; name?: string; active?: boolean; }
interface RouteCalculationRequest {
  points: Array<Pick<RouteWaypoint, 'latitude' | 'longitude'>>;
  profile: RouteProfile;
  apiKey?: string;
}
interface RouteCalculationResult {
  provider: RouteProviderId;
  coordinates: Array<{ latitude: number; longitude: number }>;
}

interface TimeSliderSymbolSettings { rotation: number; flipHorizontal: boolean; }


interface GpxTrackSettingsDraft { colorMode: 'fixed' | 'speed' | 'elevation'; color: string; speedPalette: 'spectrum' | 'cool-warm' | 'viridis' | 'plasma' | 'inferno' | 'terrain' | 'custom-2' | 'custom-3'; customColor1: string; customColor2: string; customColor3: string; speedMinKmh: number; speedMaxKmh: number; elevationMinM: number; elevationMaxM: number; lineStyle: NonNullable<GpxTrackFile['lineStyle']>; lineWidth: number; showDirection: boolean; directionIntervalPx: number; directionArrowSizePx: number; directionArrowOutlineWidthPx: number; trackShadowStrength: number; arrowShadowStrength: number; trackOutlineStrength: number; directionStyle: NonNullable<GpxTrackFile['directionStyle']> }
interface GpxTrackSettingsFavorite { name: string; settings: GpxTrackSettingsDraft; }
interface GpxTrackFile { path: string; name: string; sizeBytes: number; lastModified: number; databasePath?: string; missing?: boolean; readError?: boolean; active?: boolean; color?: string; colorMode?: 'fixed' | 'speed' | 'elevation'; speedPalette?: 'spectrum' | 'cool-warm' | 'viridis' | 'plasma' | 'inferno' | 'terrain' | 'custom-2' | 'custom-3'; customColor1?: string; customColor2?: string; customColor3?: string; speedMinKmh?: number; speedMaxKmh?: number; elevationMinM?: number; elevationMaxM?: number; lineStyle?: 'solid' | 'dashed' | 'dotted' | 'long-dashed' | 'short-dashed' | 'dash-dot' | 'dash-dot-dot'; lineWidth?: number; showDirection?: boolean; directionIntervalPx?: number; directionArrowSizePx?: number; directionArrowOutlineWidthPx?: number; trackShadowStrength?: number; arrowShadowStrength?: number; trackOutlineStrength?: number; directionStyle?: 'classic' | 'chevron' | 'triangle' | 'thin' | 'large-classic' | 'large-chevron' | 'large-triangle'; }

interface RenderTimingSummary {
  count: number;
  averageMs: number;
  medianMs: number;
  minMs: number;
  maxMs: number;
}

function summarizeRenderDurations(samples: number[]): RenderTimingSummary {
  if (samples.length === 0) return { count: 0, averageMs: 0, medianMs: 0, minMs: 0, maxMs: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
  return {
    count: samples.length,
    averageMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    medianMs,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1]
  };
}

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
  imports: [SliderComponent, GpxDatabaseImportComponent, GpxTrackPreviewComponent],
  host: { '[class.overlay-mode]': 'overlayMode' },
  template: `
    <main class="map-window" [class.light-theme]="themeService.current() === 'light'">
      <header class="map-titlebar">
        <button type="button" class="settings-toggle app-disclosure-heading" [class.active]="settingsOpen()" [class.expanded]="settingsOpen()" (click)="toggleSettings()"
                [attr.aria-expanded]="settingsOpen()" title="Show or hide map settings" aria-label="Map settings">Settings</button>
        <label class="always-on-top-setting titlebar-always-on-top" title="Keep the map window above the main window">
          <input type="checkbox" [checked]="alwaysOnTop()" (change)="changeAlwaysOnTop($any($event.target).checked)">
          <span>Always on top</span>
        </label>
        <div class="titlebar-mouse-coordinate" title="Current mouse position on the map">Mouse: {{ mouseCoordinateLabel() || '—' }}</div>
        <div class="map-title"><span class="map-title-icon">⌖</span></div>
        @if (overlayMode) {
          <button type="button" class="overlay-close-button" (click)="closeOverlayWindow()" title="Close overlay" aria-label="Close overlay">×</button>
        }
      </header>
      @if (settingsOpen()) {
        <section class="map-settings" aria-label="Map settings">
<nav class="settings-tabs image-sidebar-tabs" role="tablist" aria-label="Location settings">
  <button type="button" role="tab" class="settings-tab" [class.active]="activeSettingsTab() === 'location'" [attr.aria-selected]="activeSettingsTab() === 'location'" (click)="selectSettingsTab('location')">Location</button>
  <button type="button" role="tab" class="settings-tab" [class.active]="activeSettingsTab() === 'fix'" [attr.aria-selected]="activeSettingsTab() === 'fix'" (click)="selectSettingsTab('fix')">Fix</button>
  <button type="button" role="tab" class="settings-tab" [class.active]="activeSettingsTab() === 'track'" [attr.aria-selected]="activeSettingsTab() === 'track'" (click)="selectSettingsTab('track')">Track</button>
  <button type="button" role="tab" class="settings-tab" [class.active]="activeSettingsTab() === 'routing'" [attr.aria-selected]="activeSettingsTab() === 'routing'" (click)="selectSettingsTab('routing')">Routing</button>
  <button type="button" role="tab" class="settings-tab" [class.active]="activeSettingsTab() === 'timeSlider'" [attr.aria-selected]="activeSettingsTab() === 'timeSlider'" (click)="selectSettingsTab('timeSlider')">Time Slider</button>
  <button type="button" role="tab" class="settings-tab" [class.active]="activeSettingsTab() === 'marker'" [attr.aria-selected]="activeSettingsTab() === 'marker'" (click)="selectSettingsTab('marker')">Images</button>
  <button type="button" role="tab" class="settings-tab" [class.active]="activeSettingsTab() === 'view'" [attr.aria-selected]="activeSettingsTab() === 'view'" (click)="selectSettingsTab('view')">View</button>
  <button type="button" role="tab" class="settings-tab settings-tab-map-group settings-tab-right-start" [class.active]="activeSettingsTab() === 'offlineMaps'" [attr.aria-selected]="activeSettingsTab() === 'offlineMaps'" [class.has-errors]="offlineMapTabErrorCount() > 0" [class.has-warning]="offlineMapTabErrorCount() === 0 && offlineMapHasUnselectedFiles()" (click)="selectSettingsTab('offlineMaps')">Offline@if (offlineMapTabErrorCount() > 0) { <span class="settings-tab-error-count">{{ offlineMapTabErrorCount() }}</span> } @else if (offlineMapHasUnselectedFiles()) { <span class="settings-tab-warning-count">{{ offlineMapUnselectedCount() }}</span> }</button>
  <button type="button" role="tab" class="settings-tab settings-tab-map-group" [class.active]="activeSettingsTab() === 'cache'" [attr.aria-selected]="activeSettingsTab() === 'cache'" (click)="selectSettingsTab('cache')">Cache</button>
  <button type="button" role="tab" class="settings-tab settings-tab-map-group" [class.active]="activeSettingsTab() === 'memory'" [attr.aria-selected]="activeSettingsTab() === 'memory'" (click)="selectSettingsTab('memory')">Memory</button>
  <button type="button" role="tab" class="settings-tab settings-tab-map-group" [class.active]="activeSettingsTab() === 'download'" [attr.aria-selected]="activeSettingsTab() === 'download'" (click)="selectSettingsTab('download')">Download@if (downloadSources().length === 0) { <span class="settings-tab-error-count">EMPTY</span> }</button>
  <button type="button" role="tab" class="settings-tab settings-tab-map-group" [class.active]="activeSettingsTab() === 'errors'" [class.has-errors]="mapErrors().length > 0" [attr.aria-selected]="activeSettingsTab() === 'errors'" (click)="selectSettingsTab('errors')">Error @if (mapErrors().length > 0) { <span class="settings-tab-error-count">{{ mapErrors().length }}</span> }</button>
</nav>
<div class="settings-tab-panels" (toggle)="onDisclosureStateToggle($event)">
<div class="settings-tab-panel" data-settings-tab="location" role="tabpanel" [hidden]="activeSettingsTab() !== 'location'">
<div class="settings-tab-content location-tab">
            
            <div class="location-settings-content">
              
              <details class="offline-address-search app-disclosure">
                <summary class="settings-row-title">Offline address search</summary>
                <button type="button" class="routing-help-button location-section-help" (click)="openOfflineAddressSearchHelp()" title="Open offline address search help" aria-label="Open offline address search help"><span aria-hidden="true">?</span></button>
                <form (submit)="$event.preventDefault(); searchOfflineAddresses()">
                  <div class="location-actions">
                    <input id="offline-address-query" type="search" [value]="offlineAddressQuery()" (input)="offlineAddressQuery.set($any($event.target).value)"
                           placeholder="Street, house number, city or postcode…" autocomplete="off">
                    <button type="submit" class="map-toolbar-button" [disabled]="offlineAddressSearchBusy() || offlineAddressQuery().trim().length < 2">
                      {{ offlineAddressSearchBusy() ? 'Searching…' : 'Search' }}
                    </button>
                   </div>
                  @if (offlineAddressSearchError()) { <span class="location-address location-address-error" role="alert">{{ offlineAddressSearchError() }}</span> }
                  @if (offlineAddressSearchResults().length > 0) {
                    <div class="offline-address-results"><table aria-label="Offline address search results">
                      <thead><tr><th scope="col">Address</th><th scope="col">Coordinates</th></tr></thead>
                      <tbody>
                        @for (result of offlineAddressSearchResults(); track result.latitude + ':' + result.longitude + ':' + result.display_name) {
                          <tr tabindex="0" (click)="goToOfflineAddress(result)" (keydown.enter)="goToOfflineAddress(result)" (keydown.space)="$event.preventDefault(); goToOfflineAddress(result)">
                            <td class="offline-address-result-name"><strong>{{ result.display_name }}</strong>@if (result.secondary_text) { <span> · {{ result.secondary_text }}</span> }</td>
                            <td class="offline-address-result-coordinates">{{ formatGpsCoordinates(result.latitude, result.longitude) }}</td>
                          </tr>
                        }
                      </tbody>
                    </table></div>
                  }
                  <span class="offline-map-status">Searches only enabled, available OsmAnd OBF files.</span>
                </form>
              </details>
              <details class="location-tools-section app-disclosure">
                <summary class="settings-row-title">Location tools</summary>
                <div class="location-tools-content">
                  <div class="location-coordinate-display"><span>{{ photoCoordinateLabel() }} @if (bearingLabel()) { · {{ bearingLabel() }} }</span></div>
                  <div class="location-coordinate-display"><span>Mouse: {{ mouseCoordinateLabel() }}</span></div>
                  <div class="address-settings">
                    <span class="settings-row-title">Address:</span>
                    <span class="location-address" role="status" [class.location-address-error]="locationAddress().startsWith('Reverse geocoding failed:')">{{ locationAddress() || (coordinatesAvailable() ? 'Looking up address…' : '') }}</span>
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
            </div>
          </div>

</div>
<div class="settings-tab-panel" data-settings-tab="fix" role="tabpanel" [hidden]="activeSettingsTab() !== 'fix'">
  <div class="settings-tab-content location-tab">
    <div class="location-settings-content">
<details class="fix-location-automatic-section app-disclosure">
                <summary class="settings-row-title">Fix location AUTOMATIC</summary>
                <button type="button" class="routing-help-button location-section-help" (click)="openLocationFixAutomaticHelp()" title="Open automatic photo location correction help" aria-label="Open automatic photo location correction help"><span aria-hidden="true">?</span></button>
                <div class="fix-location-step-title">STEP 1 - Add GPX to search</div>
                <app-gpx-database-import [databaseKey]="currentImageDatabaseKey" [databaseKeys]="favoriteGpxDatabaseKeys()" [databaseKeysReady]="favoriteGpxDatabaseKeysReady()" (help)="openGpxCacheHelp()" />
                <div class="fix-location-step-title">STEP 2 - Add GPS info from GPX to photos</div>
                <div class="location-actions fix-location-automatic-actions">
                  <button type="button" class="offline-map-add-button" (click)="fixLocationAutomatic()" [disabled]="autoFixBusy()">{{ autoFixBusy() ? 'Processing…' : 'Select folder with photos to fix...' }}</button>
                  <div class="time-slider-control-card fix-location-check-only-panel"><label class="fix-location-check-only"><input type="checkbox" [checked]="autoFixCheckOnly()" (change)="autoFixCheckOnly.set($any($event.target).checked)"> Check only</label></div>
                  <div class="time-slider-control-card fix-location-check-only-panel fix-location-max-difference-panel"><label class="fix-location-max-difference">Maximum time difference (minutes) <input type="number" min="0" max="1440" step="0.5" [value]="autoFixMaxDifferenceMinutes()" (input)="setAutoFixMaxDifference($any($event.target).value)"></label></div>
                  <div class="fix-location-log-actions">
                    <button type="button" class="file-row-menu-trigger" (click)="autoFixLogMenuOpen.set(!autoFixLogMenuOpen()); $event.stopPropagation()"
                            [attr.aria-expanded]="autoFixLogMenuOpen()" aria-haspopup="menu" aria-label="GPS Auto Fix log actions" title="Log actions">☰</button>
                    @if (autoFixLogMenuOpen()) {
                      <div class="fix-location-log-menu" role="menu" (click)="$event.stopPropagation()">
                        <button type="button" role="menuitem" (click)="openAutoFixLogFile(); autoFixLogMenuOpen.set(false)">Open log file</button>
                        <button type="button" role="menuitem" (click)="openAutoFixLogFolder(); autoFixLogMenuOpen.set(false)">Open log folder</button>
                      </div>
                    }
                  </div>
                  @if (autoFixOperationActive()) { <button type="button" class="map-toolbar-button fix-location-abort-button" (click)="abortAutomaticLocationFix()">Abort</button> }
                  @if (autoFixStatus()) { <div class="offline-map-status fix-location-automatic-status" role="status">{{ autoFixStatus() }}</div> }
                 </div>
                @if (autoFixStatus()) {
                  @if (autoFixOperationActive()) {
                    <div class="fix-location-progress-track" role="progressbar"
                      [attr.aria-valuenow]="autoFixProgressPercent()" aria-valuemin="0" aria-valuemax="100"
                      [attr.aria-label]="autoFixProgress().scanned + ' of ' + autoFixProgress().total + ' photos checked'">
                      <div class="fix-location-progress-fill" [style.width.%]="autoFixProgressPercent()"></div>
                    </div>
                    <div class="fix-location-progress-count">{{ formatAutoFixCount(autoFixProgress().scanned) }} / {{ formatAutoFixCount(autoFixProgress().total) }} photos checked</div>
                    <div class="fix-location-counter">
                      <div class="fix-location-counter-label">Photos without GPS found: {{ formatAutoFixCount(autoFixProgress().withoutGps) }} / {{ formatAutoFixCount(autoFixProgress().total) }}</div>
                      <div class="fix-location-progress-track" role="progressbar" [attr.aria-valuenow]="autoFixCountPercent(autoFixProgress().withoutGps)" aria-valuemin="0" aria-valuemax="100" aria-label="Photos without GPS found">
                        <div class="fix-location-progress-fill" [style.width.%]="autoFixCountPercent(autoFixProgress().withoutGps)"></div>
                      </div>
                    </div>
                    <div class="fix-location-counter">
                      <div class="fix-location-counter-label">Photos with GPS found: {{ formatAutoFixCount(autoFixProgress().withGps) }} / {{ formatAutoFixCount(autoFixProgress().total) }}</div>
                      <div class="fix-location-progress-track" role="progressbar" [attr.aria-valuenow]="autoFixCountPercent(autoFixProgress().withGps)" aria-valuemin="0" aria-valuemax="100" aria-label="Photos with GPS found">
                        <div class="fix-location-progress-fill" [style.width.%]="autoFixCountPercent(autoFixProgress().withGps)"></div>
                      </div>
                    </div>
                    <div class="fix-location-counter">
                      <div class="fix-location-counter-label">Photos without GPS that can be fixed: {{ formatAutoFixCount(autoFixProgress().matched) }} / {{ formatAutoFixCount(autoFixProgress().total) }}</div>
                      <div class="fix-location-progress-track" role="progressbar" [attr.aria-valuenow]="autoFixCountPercent(autoFixProgress().matched)" aria-valuemin="0" aria-valuemax="100" aria-label="Photos without GPS that can be fixed">
                        <div class="fix-location-progress-fill" [style.width.%]="autoFixCountPercent(autoFixProgress().matched)"></div>
                      </div>
                    </div>
                    <div class="fix-location-current-folder">Current folder: {{ autoFixProgress().currentFolder === '.' ? 'Selected start folder' : autoFixProgress().currentFolder }}</div>
                  }
                }
                @if (autoFixReport().length) {
                  <div class="fix-location-report-wrap">
                    <table class="fix-location-report">
                      <tbody>
                        @for (item of autoFixReport(); track item.label) {
                          <tr [class.fix-location-report-row-matched]="item.label === 'Photos matched to GPX within the time limit' && item.value !== '0'"><th scope="row">{{ item.label }}</th><td>{{ item.value }}</td></tr>
                        }
                      </tbody>
                    </table>
                  </div>
                }
                <div class="fix-location-help offline-map-status">GPS availability here refers to coordinates embedded in the photo files themselves (EXIF/XMP), not GPS records in the LumaScope cache database. Photos whose files already contain GPS coordinates are counted separately and skipped. A GPX match requires track points before and after the photo time in the same track segment. “No usable GPX match” means no such pair was found within the search window. “Rejected by the time limit” counts candidates that were found but whose nearest track point was farther away than the configured maximum time difference. Check only reports results without writing to files. EXIF timestamps without an explicit timezone are interpreted in the computer's local timezone.</div>
              </details>
              <details class="fix-location-section app-disclosure" [open]="fixLocationSectionOpen()" (toggle)="fixLocationSectionOpen.set($any($event.target).open)">
                <summary class="settings-row-title">Fix location MANUAL</summary>
                <button type="button" class="routing-help-button location-section-help" (click)="openLocationFixManualHelp()" title="Open manual photo location correction help" aria-label="Open manual photo location correction help"><span aria-hidden="true">?</span></button>
                <div class="fix-location-layout">
                  <div class="fix-location-controls">
                    <div class="fix-location-crosshair-row"><div class="time-slider-control-card fix-location-check-only-panel fix-location-crosshair-panel"><label class="fix-location-toggle"><input type="checkbox" [checked]="fixLocationEnabled()" (change)="setFixLocationEnabled($any($event.target).checked)"> Show crosshair</label></div><button type="button" class="map-toolbar-button" (click)="showCrosshairAddress()" [disabled]="!fixLocationEnabled()">Show crosshair address</button><span class="location-address fix-location-address" role="status">{{ crosshairAddress() }}</span> </div>
                    <div class="location-actions">
                      <button type="button" class="map-toolbar-button" (click)="saveGpsPosition()" [disabled]="!fixLocationEnabled() || !canSaveGpsPosition() || gpsSaveBusy()">{{ gpsSaveBusy() ? 'Saving…' : 'Update GPS infos in file...' }}</button>
                      @if (gpsSaveStatus()) { <span class="offline-map-status" role="status">{{ gpsSaveStatus() }}</span> }
                    </div>
                      </div>
                  <div class="fix-photo-preview">
                    @if (currentImagePreview()) {
                      <img [src]="currentImagePreview()" [alt]="currentImageName()" />
                    } @else {
                      <div class="fix-photo-preview-empty">Photo preview unavailable</div>
                    }
                    <div class="fix-photo-preview-info">
                      <strong>{{ currentImageName() || 'No photo selected' }}</strong>
                      <span>{{ coordinatesAvailable() ? 'GPS coordinates already available' : 'No GPS coordinates in this photo' }}</span>
                    </div>
                  </div>
                </div>
                <div class="fix-location-help offline-map-status">The currently selected map source is used. Move the map until the crosshair marks the photo location, then save the GPS position to the image file.</div>
              </details>
    </div>
  </div>
</div>
<div class="settings-tab-panel" data-settings-tab="track" role="tabpanel" [hidden]="activeSettingsTab() !== 'track'">
<div class="settings-tab-content track-tab">
  <div class="gpx-settings-content">
    <div class="gpx-toolbar">
      <button type="button" class="offline-map-add-button gpx-add-button" (click)="importGpxTrack()">Add GPX files...</button>
      <label class="gpx-db-mode-toggle" title="Use GPX files stored in the cache database that intersect the current map viewport">
        <input type="checkbox" [checked]="gpxListMode() === 'database'" (change)="$any($event.target).checked ? showGpxFilesVisibleOnMap() : showRecentGpxFiles()" [disabled]="gpxDatabaseQueryBusy()">
        Use GPX files from DB
      </label>
      @if (gpxListMode() === 'database') {
        <button type="button" class="gpx-list-action-button" (click)="showRecentGpxFiles()">Show recently loaded GPX files</button>
        <span class="offline-map-status">{{ gpxDatabaseVisibleTracks().length }} matching DB file(s)</span>
      } @else {
        <span class="offline-map-status">{{ gpxTracks().length }} GPX file(s) loaded</span>
      }
      @if (gpxDatabaseQueryBusy()) { <span class="gpx-hover-info">Searching GPX database…</span> }
      @if (gpxDatabaseQueryStatus()) { <span class="gpx-hover-info gpx-database-query-status">{{ gpxDatabaseQueryStatus() }}</span> }
      @if (gpxHoverInfo()) { <span class="gpx-hover-info">{{ gpxHoverInfo() }}</span> }
      <button type="button" class="routing-help-button gpx-toolbar-help" (click)="openTrackTabHelp()" title="Open track tab help" aria-label="Open track tab help"><span aria-hidden="true">?</span></button>
    </div>
    @if (gpxDatabaseVisibleTracks().length > 0) {
      <div class="gpx-database-table" role="table" aria-label="GPX tracks">
        <div class="gpx-database-header" role="row" [style.grid-template-columns]="gpxDatabaseGridColumns()">
          <span class="gpx-db-sort-button" role="columnheader" (click)="sortGpxDatabase('active')">Active {{ gpxDatabaseSortIndicator('active') }}<span class="gpx-column-resizer" (pointerdown)="startGpxColumnResize($event, 'active')" (click)="$event.stopPropagation(); $event.preventDefault()"></span></span>
          <span class="gpx-db-sort-button" role="columnheader" (click)="sortGpxDatabase('name')">File {{ gpxDatabaseSortIndicator('name') }}<span class="gpx-column-resizer" (pointerdown)="startGpxColumnResize($event, 'name')" (click)="$event.stopPropagation(); $event.preventDefault()"></span></span>
          @if (gpxDatabaseColumns().points) { <span class="gpx-db-sort-button" role="columnheader" (click)="sortGpxDatabase('points')">Points {{ gpxDatabaseSortIndicator('points') }}<span class="gpx-column-resizer" (pointerdown)="startGpxColumnResize($event, 'points')" (click)="$event.stopPropagation(); $event.preventDefault()"></span></span> }
          @if (gpxDatabaseColumns().modified) { <span class="gpx-db-sort-button" role="columnheader" (click)="sortGpxDatabase('modified')">Date {{ gpxDatabaseSortIndicator('modified') }}<span class="gpx-column-resizer" (pointerdown)="startGpxColumnResize($event, 'modified')" (click)="$event.stopPropagation(); $event.preventDefault()"></span></span> }
          @if (gpxDatabaseColumns().time) { <span class="gpx-db-sort-button" role="columnheader" (click)="sortGpxDatabase('time')">Track time {{ gpxDatabaseSortIndicator('time') }}<span class="gpx-column-resizer" (pointerdown)="startGpxColumnResize($event, 'time')" (click)="$event.stopPropagation(); $event.preventDefault()"></span></span> }
          @if (gpxDatabaseColumns().size) { <span class="gpx-db-sort-button" role="columnheader" (click)="sortGpxDatabase('size')">Size {{ gpxDatabaseSortIndicator('size') }}<span class="gpx-column-resizer" (pointerdown)="startGpxColumnResize($event, 'size')" (click)="$event.stopPropagation(); $event.preventDefault()"></span></span> }
          @if (gpxDatabaseColumns().path) { <span class="gpx-db-sort-button" role="columnheader" (click)="sortGpxDatabase('path')">Path {{ gpxDatabaseSortIndicator('path') }}<span class="gpx-column-resizer" (pointerdown)="startGpxColumnResize($event, 'path')" (click)="$event.stopPropagation(); $event.preventDefault()"></span></span> }
          <span role="columnheader">Track preview</span>
          <span role="columnheader">Actions</span>
        </div>
        <div class="gpx-file-list gpx-database-file-list" role="rowgroup">
          @for (track of gpxDatabaseVisibleTracks(); track track.path) {
            <div class="gpx-file-row gpx-database-file-row" role="row" [style.grid-template-columns]="gpxDatabaseGridColumns()" [class.gpx-hovered]="gpxHoveredTrackPath() === track.path" [class.gpx-missing]="track.missing || track.readError" [class.gpx-color-menu-open]="gpxTrackColorMenuOpen() === track.path">
              <label class="gpx-active-toggle" role="cell" [title]="'Show ' + track.name"><input type="checkbox" [checked]="track.active !== false" (change)="changeGpxListTrack(track.path, { active: $any($event.target).checked })" [attr.aria-label]="'Show track ' + track.name"></label>
              <span class="gpx-file-name" role="cell" [title]="track.databasePath || track.path">{{ track.name }}</span>
              @if (gpxDatabaseColumns().points) { <span class="gpx-waypoint-count" role="cell">{{ track.missing || track.readError ? '—' : gpxListWaypointCount(track) }}</span> }
              @if (gpxDatabaseColumns().modified) { <span role="cell">{{ track.missing || track.readError ? (track.missing ? 'Missing' : 'Read error') : formatGpxDate(track.lastModified) }}</span> }
              @if (gpxDatabaseColumns().time) { <span class="gpx-time-range" role="cell" [title]="gpxTrackTimeRange(track.path)">{{ track.missing || track.readError ? '—' : gpxTrackTimeRange(track.path) }}</span> }
              @if (gpxDatabaseColumns().size) { <span role="cell">{{ track.missing || track.readError ? '—' : formatGpxFileSize(track.sizeBytes) }}</span> }
              @if (gpxDatabaseColumns().path) { <span class="gpx-file-name" role="cell" [title]="gpxTrackDirectoryPath(track)">{{ gpxTrackDirectoryPath(track) }}</span> }
              <app-gpx-track-preview role="cell" [track]="track" [opacity]="gpxOpacity()" variant="list" />
              <div class="gpx-row-actions" role="cell">
                <button type="button" class="gpx-track-edit-button" (click)="openGpxTrackSettings(track)" title="Track Settings">✎</button>
                              <button type="button" class="file-row-menu-trigger" (click)="toggleGpxRowActionMenu(track, $event); $event.stopPropagation()" [attr.aria-label]="'Actions for ' + track.name" title="Track actions">☰</button>
                            </div>
              
            </div>
          }
        </div>
        @if (gpxRowActionTrack(); as actionTrack) {
          <div class="gpx-row-action-menu gpx-row-action-menu-floating" role="menu" [attr.aria-label]="'Actions for ' + actionTrack.name"
               [style.top.px]="gpxRowActionMenuPosition().top" [style.left.px]="gpxRowActionMenuPosition().left" (click)="$event.stopPropagation()">
            <button type="button" role="menuitem" (click)="fitGpxTrack(actionTrack.path); gpxRowActionMenuOpen.set(null); gpxRowActionTrack.set(null)"><span aria-hidden="true">⤢</span> Fit map to track</button>
            @if (gpxListMode() === 'recent') {
              <button type="button" role="menuitem" (click)="exportGpxFromMemory(actionTrack); gpxRowActionMenuOpen.set(null); gpxRowActionTrack.set(null)"><span aria-hidden="true">⇩</span> Export from memory</button>
            }
            @if (!actionTrack.path.startsWith('memory:')) {
              <button type="button" role="menuitem" (click)="exportGpxFromDatabase(actionTrack); gpxRowActionMenuOpen.set(null); gpxRowActionTrack.set(null)"><span aria-hidden="true">⇩</span> Export from db</button>
            }
            <button type="button" role="menuitem" class="gpx-row-action-delete-all"
                    (click)="deleteGpxDatabaseRecordsForFile(actionTrack); gpxRowActionMenuOpen.set(null); gpxRowActionTrack.set(null)"
                    [disabled]="actionTrack.path.startsWith('memory:')"><span aria-hidden="true">⌫</span> Delete all db records for this file</button>
            @if (gpxListMode() === 'recent') {
              <button type="button" role="menuitem" (click)="openGpxTrack(actionTrack); gpxRowActionMenuOpen.set(null); gpxRowActionTrack.set(null)" [disabled]="actionTrack.missing || actionTrack.path.startsWith('memory:')"><span aria-hidden="true">↗</span> Open in GPX editor</button>
              <button type="button" role="menuitem" (click)="removeGpxTrack(actionTrack.path); gpxRowActionMenuOpen.set(null); gpxRowActionTrack.set(null)"><span aria-hidden="true">×</span> Remove track</button>
            }
            <button type="button" role="menuitem" (click)="copyFilePath(actionTrack.databasePath || actionTrack.path); gpxRowActionMenuOpen.set(null); gpxRowActionTrack.set(null)"><span aria-hidden="true">⧉</span> Copy full file path</button>
            @if (gpxListMode() === 'recent') {
              <div class="gpx-row-action-menu-separator" role="separator"></div>
              <button type="button" role="menuitem" (click)="selectAllGpxTracks(); gpxRowActionMenuOpen.set(null); gpxRowActionTrack.set(null)" [disabled]="gpxTracks().length === 0"><span aria-hidden="true">☑</span> Select all</button>
              <button type="button" role="menuitem" (click)="deselectAllGpxTracks(); gpxRowActionMenuOpen.set(null); gpxRowActionTrack.set(null)" [disabled]="gpxTracks().length === 0"><span aria-hidden="true">□</span> Deselect all</button>
              <button type="button" role="menuitem" class="gpx-row-action-delete-all" (click)="deleteAllGpxTracks(); gpxRowActionMenuOpen.set(null); gpxRowActionTrack.set(null)" [disabled]="gpxTracks().length === 0"><span aria-hidden="true">⌫</span> Delete All</button>
            }
          </div>
        }
      </div>
    } @else if (gpxListMode() === 'database') {
      <div class="gpx-database-empty">No GPX track points from the database are visible in the current map viewport and time range.</div>
    } @else {
      <div class="gpx-database-empty">No GPX tracks are loaded.</div>
    }
    @if (gpxTrackSettingsTrack(); as settingsTrack) {
      <div class="gpx-track-settings-backdrop" role="presentation" (click)="cancelGpxTrackSettings()">
        <section class="gpx-track-settings-dialog" role="dialog" aria-modal="true" tabindex="-1" [attr.aria-label]="'Track Settings: ' + settingsTrack.name" (click)="$event.stopPropagation(); onGpxTrackSettingsDialogClick($event)">
          <header><strong>Track Settings</strong><span>{{ settingsTrack.name }}</span></header>
          <app-gpx-track-preview [track]="gpxSettingsPreviewTrack(settingsTrack)" [opacity]="gpxOpacity()" variant="settings" />
          <section class="gpx-track-settings-grid">
            <details class="gpx-track-settings-section">
              <summary>Favorites</summary>
              <div class="gpx-track-settings-section-grid">
                <label>Settings favorites<select [value]="gpxTrackSettingsFavoriteSelection()" (change)="applyGpxTrackSettingsFavorite($any($event.target).value)"><option value="">Select favorite…</option>@for (favorite of gpxTrackSettingsFavorites(); track favorite.name) { <option [value]="favorite.name">{{ favorite.name }}</option> }</select></label>
                <div class="gpx-track-settings-favorite-add"><input type="text" maxlength="60" placeholder="Favorite name" [value]="gpxTrackSettingsFavoriteName()" (input)="gpxTrackSettingsFavoriteName.set($any($event.target).value)"><button type="button" (click)="addGpxTrackSettingsFavorite()" [disabled]="!gpxTrackSettingsFavoriteName().trim()">Add settings to favorites</button><button type="button" class="gpx-track-settings-favorite-remove" (click)="removeGpxTrackSettingsFavorite()" [disabled]="!gpxTrackSettingsFavoriteSelection()">Remove favorite</button></div>
              </div>
            </details>
            <details class="gpx-track-settings-section">
              <summary>Track</summary>
              <div class="gpx-track-settings-section-grid">
            <label>Color mode<select [value]="gpxTrackSettingsDraft().colorMode" (change)="updateGpxTrackSettingsDraft({ colorMode: $any($event.target).value })"><option value="fixed">Fixed color</option><option value="speed">Speed-based</option><option value="elevation">Elevation-based</option></select></label>
            @if (gpxTrackSettingsDraft().colorMode === 'fixed') {
              <label>Color<select [value]="gpxTrackSettingsDraft().color.toLowerCase()" [style.color]="gpxTrackSettingsDraft().color" (change)="updateGpxTrackSettingsDraft({ color: $any($event.target).value })">@for (color of gpxTrackSettingsColors; track color.value) { <option [value]="color.value.toLowerCase()" [selected]="color.value.toLowerCase() === gpxTrackSettingsDraft().color.toLowerCase()" [style.color]="color.value">■ {{ color.name }} ({{ color.value }})</option> } @if (!gpxTrackSettingsColors.some(color => color.value.toLowerCase() === gpxTrackSettingsDraft().color.toLowerCase())) { <option [value]="gpxTrackSettingsDraft().color.toLowerCase()" selected>■ {{ gpxTrackSettingsDraft().color.toLowerCase() === '#ff3b30' ? 'Orange' : 'Custom' }} ({{ gpxTrackSettingsDraft().color }})</option> }</select></label>
            } @else if (gpxTrackSettingsDraft().colorMode === 'speed') {
              <label>Speed palette<select [value]="gpxTrackSettingsDraft().speedPalette" (change)="updateGpxTrackSettingsDraft({ speedPalette: $any($event.target).value })"><option value="spectrum">Blue–red</option><option value="cool-warm">Cool–warm</option><option value="viridis">Viridis</option><option value="plasma">Plasma</option><option value="inferno">Inferno</option><option value="terrain">Terrain</option><option value="custom-2">Custom 2</option><option value="custom-3">Custom 3</option></select></label>
              @if (gpxTrackSettingsDraft().speedPalette === "custom-2") {
                <label>Start color<select [value]="gpxTrackSettingsDraft().customColor1" [style.color]="gpxTrackSettingsDraft().customColor1" (change)="updateGpxTrackSettingsDraft({ customColor1: $any($event.target).value })">@for (color of gpxTrackSettingsColors; track color.value) { <option [value]="color.value" [style.color]="color.value">■ {{ color.name }} ({{ color.value }})</option> }</select></label>
                <label>End color<select [value]="gpxTrackSettingsDraft().customColor3" [style.color]="gpxTrackSettingsDraft().customColor3" (change)="updateGpxTrackSettingsDraft({ customColor3: $any($event.target).value })">@for (color of gpxTrackSettingsColors; track color.value) { <option [value]="color.value" [style.color]="color.value">■ {{ color.name }} ({{ color.value }})</option> }</select></label>
              }
              @if (gpxTrackSettingsDraft().speedPalette === "custom-3") {
                <label>Start color<select [value]="gpxTrackSettingsDraft().customColor1" [style.color]="gpxTrackSettingsDraft().customColor1" (change)="updateGpxTrackSettingsDraft({ customColor1: $any($event.target).value })">@for (color of gpxTrackSettingsColors; track color.value) { <option [value]="color.value" [style.color]="color.value">■ {{ color.name }} ({{ color.value }})</option> }</select></label>
                <label>Middle color<select [value]="gpxTrackSettingsDraft().customColor2" [style.color]="gpxTrackSettingsDraft().customColor2" (change)="updateGpxTrackSettingsDraft({ customColor2: $any($event.target).value })">@for (color of gpxTrackSettingsColors; track color.value) { <option [value]="color.value" [style.color]="color.value">■ {{ color.name }} ({{ color.value }})</option> }</select></label>
                <label>End color<select [value]="gpxTrackSettingsDraft().customColor3" [style.color]="gpxTrackSettingsDraft().customColor3" (change)="updateGpxTrackSettingsDraft({ customColor3: $any($event.target).value })">@for (color of gpxTrackSettingsColors; track color.value) { <option [value]="color.value" [style.color]="color.value">■ {{ color.name }} ({{ color.value }})</option> }</select></label>
              }
              <label>Minimum speed (km/h)<input type="number" min="0" max="299" [value]="gpxTrackSettingsDraft().speedMinKmh" (change)="updateGpxTrackSettingsDraft({ speedMinKmh: +$any($event.target).value })"></label>
              <label>Maximum speed (km/h)<input type="number" min="1" max="300" [value]="gpxTrackSettingsDraft().speedMaxKmh" (change)="updateGpxTrackSettingsDraft({ speedMaxKmh: +$any($event.target).value })"></label>
            } @else {
              <label>Elevation palette<select [value]="gpxTrackSettingsDraft().speedPalette" (change)="updateGpxTrackSettingsDraft({ speedPalette: $any($event.target).value })"><option value="spectrum">Blue–red</option><option value="cool-warm">Cool–warm</option><option value="viridis">Viridis</option><option value="plasma">Plasma</option><option value="inferno">Inferno</option><option value="terrain">Terrain</option><option value="custom-2">Custom 2</option><option value="custom-3">Custom 3</option></select></label>
              @if (gpxTrackSettingsDraft().speedPalette === "custom-2") {
                <label>Start color<select [value]="gpxTrackSettingsDraft().customColor1" [style.color]="gpxTrackSettingsDraft().customColor1" (change)="updateGpxTrackSettingsDraft({ customColor1: $any($event.target).value })">@for (color of gpxTrackSettingsColors; track color.value) { <option [value]="color.value" [style.color]="color.value">■ {{ color.name }} ({{ color.value }})</option> }</select></label>
                <label>End color<select [value]="gpxTrackSettingsDraft().customColor3" [style.color]="gpxTrackSettingsDraft().customColor3" (change)="updateGpxTrackSettingsDraft({ customColor3: $any($event.target).value })">@for (color of gpxTrackSettingsColors; track color.value) { <option [value]="color.value" [style.color]="color.value">■ {{ color.name }} ({{ color.value }})</option> }</select></label>
              }
              @if (gpxTrackSettingsDraft().speedPalette === "custom-3") {
                <label>Start color<select [value]="gpxTrackSettingsDraft().customColor1" [style.color]="gpxTrackSettingsDraft().customColor1" (change)="updateGpxTrackSettingsDraft({ customColor1: $any($event.target).value })">@for (color of gpxTrackSettingsColors; track color.value) { <option [value]="color.value" [style.color]="color.value">■ {{ color.name }} ({{ color.value }})</option> }</select></label>
                <label>Middle color<select [value]="gpxTrackSettingsDraft().customColor2" [style.color]="gpxTrackSettingsDraft().customColor2" (change)="updateGpxTrackSettingsDraft({ customColor2: $any($event.target).value })">@for (color of gpxTrackSettingsColors; track color.value) { <option [value]="color.value" [style.color]="color.value">■ {{ color.name }} ({{ color.value }})</option> }</select></label>
                <label>End color<select [value]="gpxTrackSettingsDraft().customColor3" [style.color]="gpxTrackSettingsDraft().customColor3" (change)="updateGpxTrackSettingsDraft({ customColor3: $any($event.target).value })">@for (color of gpxTrackSettingsColors; track color.value) { <option [value]="color.value" [style.color]="color.value">■ {{ color.name }} ({{ color.value }})</option> }</select></label>
              }
              <label>Minimum elevation (m)<input type="number" step="1" [value]="gpxTrackSettingsDraft().elevationMinM" (change)="updateGpxTrackSettingsDraft({ elevationMinM: +$any($event.target).value })"></label>
              <label>Maximum elevation (m)<input type="number" step="1" [value]="gpxTrackSettingsDraft().elevationMaxM" (change)="updateGpxTrackSettingsDraft({ elevationMaxM: +$any($event.target).value })"></label>
            }
            <div class="gpx-track-settings-divider" role="separator"></div>
            <div class="gpx-settings-choice-field"><details class="gpx-settings-choice" (mouseleave)="clearGpxTrackSettingsHover()"><summary><span>Line style</span><strong>{{ gpxLineStyleLabel(gpxTrackSettingsHoveredLineStyle() ?? gpxTrackSettingsDraft().lineStyle) }}</strong></summary><div class="gpx-settings-choice-options">@for (option of gpxTrackLineStyleOptions; track option.value) { <button type="button" [class.active]="gpxTrackSettingsDraft().lineStyle === option.value" (mouseenter)="previewGpxTrackLineStyle(option.value)" (focus)="previewGpxTrackLineStyle(option.value)" (click)="selectGpxTrackLineStyle(option.value)">{{ option.label }}</button> }</div></details></div>
            <label class="gpx-direction-density-control"><span>Line width</span><strong>{{ gpxTrackSettingsDraft().lineWidth }} px</strong><ui-slider [min]="1" [max]="10" [step]="1" [value]="gpxTrackSettingsDraft().lineWidth" (valueChange)="updateGpxTrackSettingsDraft({ lineWidth: $event })" [color]="themeService.sliderColor()" aria-label="Track line width" /></label>
            <label class="gpx-direction-density-control"><span>Track outline strength</span><strong>{{ gpxTrackSettingsDraft().trackOutlineStrength }}%</strong><ui-slider [min]="0" [max]="100" [step]="5" [value]="gpxTrackSettingsDraft().trackOutlineStrength" (valueChange)="updateGpxTrackSettingsDraft({ trackOutlineStrength: $event })" [color]="themeService.sliderColor()" aria-label="Track outline strength" /></label>
            <label class="gpx-direction-density-control"><span>Track shadow strength</span><strong>{{ gpxTrackSettingsDraft().trackShadowStrength }}%</strong><ui-slider [min]="0" [max]="100" [step]="5" [value]="gpxTrackSettingsDraft().trackShadowStrength" (valueChange)="updateGpxTrackSettingsDraft({ trackShadowStrength: $event })" [color]="themeService.sliderColor()" aria-label="Track shadow strength" /></label>
              </div>
            </details>
            <details class="gpx-track-settings-section">
              <summary>Arrows</summary>
              <div class="gpx-track-settings-section-grid">
            <div class="gpx-settings-choice-field"><details class="gpx-settings-choice" (mouseleave)="clearGpxTrackSettingsHover()"><summary><span>Direction arrow</span><strong>{{ gpxDirectionStyleLabel(gpxTrackSettingsHoveredDirection() ?? (gpxTrackSettingsDraft().showDirection ? gpxTrackSettingsDraft().directionStyle : 'off')) }}</strong></summary><div class="gpx-settings-choice-options">@for (option of gpxTrackDirectionStyleOptions; track option.value) { <button type="button" [class.active]="(gpxTrackSettingsDraft().showDirection ? gpxTrackSettingsDraft().directionStyle : 'off') === option.value" (mouseenter)="previewGpxTrackDirection(option.value)" (focus)="previewGpxTrackDirection(option.value)" (click)="selectGpxTrackDirection(option.value)">{{ option.label }}</button> }</div></details></div>
            <label class="gpx-direction-density-control"><span>Arrow spacing</span><strong>{{ gpxTrackSettingsDraft().directionIntervalPx }} px</strong><ui-slider [min]="20" [max]="200" [step]="10" [value]="gpxTrackSettingsDraft().directionIntervalPx" (valueChange)="updateGpxTrackSettingsDraft({ directionIntervalPx: $event })" [color]="themeService.sliderColor()" aria-label="Direction arrow spacing" /></label>
            <label class="gpx-direction-density-control"><span>Arrow size</span><strong>{{ gpxTrackSettingsDraft().directionArrowSizePx }} px</strong><ui-slider [min]="8" [max]="40" [step]="1" [value]="gpxTrackSettingsDraft().directionArrowSizePx" (valueChange)="updateGpxTrackSettingsDraft({ directionArrowSizePx: $event })" [color]="themeService.sliderColor()" aria-label="Direction arrow size" /></label>
            <label class="gpx-direction-density-control"><span>Arrow outline width</span><strong>{{ gpxTrackSettingsDraft().directionArrowOutlineWidthPx }} px</strong><ui-slider [min]="0" [max]="6" [step]="0.5" [value]="gpxTrackSettingsDraft().directionArrowOutlineWidthPx" (valueChange)="updateGpxTrackSettingsDraft({ directionArrowOutlineWidthPx: $event })" [color]="themeService.sliderColor()" aria-label="Direction arrow outline width" /></label>
            <label class="gpx-direction-density-control"><span>Arrow shadow strength</span><strong>{{ gpxTrackSettingsDraft().arrowShadowStrength }}%</strong><ui-slider [min]="0" [max]="100" [step]="5" [value]="gpxTrackSettingsDraft().arrowShadowStrength" (valueChange)="updateGpxTrackSettingsDraft({ arrowShadowStrength: $event })" [color]="themeService.sliderColor()" aria-label="Arrow shadow strength" /></label>
              </div>
            </details>
          </section>
          <footer><button type="button" class="gpx-track-settings-cancel" (click)="cancelGpxTrackSettings()" (keydown)="onGpxTrackSettingsFooterKeydown($event)">Cancel</button><button type="button" class="gpx-track-settings-ok" (click)="saveGpxTrackSettings()" (keydown)="onGpxTrackSettingsFooterKeydown($event)" autofocus aria-keyshortcuts="Enter">OK</button></footer>
        </section>
      </div>
    }
    <details class="gpx-elevation-profile-section app-disclosure">
      <summary>Elevation Profile</summary>
      @if (latestGpxElevationProfileBusy()) {
        <span class="offline-map-status">Loading the latest GPX elevation profile…</span>
      } @else if (gpxElevationProfiles().length > 0) {
        @if (gpxElevationChart(); as chart) {
          <div class="gpx-elevation-profile-info">
            <strong>{{ gpxElevationProfiles().length }} active GPX track(s)</strong>
            <span>Combined elevation range: {{ chart.minLabel }}–{{ chart.maxLabel }} m · Shared time axis</span>
          </div>
          <svg class="gpx-elevation-chart" viewBox="0 0 900 270" role="img" [attr.aria-label]="'Elevation profiles for ' + gpxElevationProfiles().length + ' active GPX tracks, from ' + chart.startLabel + ' to ' + chart.endLabel">
            <line class="gpx-elevation-axis" x1="70" y1="18" x2="70" y2="218" />
            <line class="gpx-elevation-axis" x1="70" y1="218" x2="880" y2="218" />
            <line class="gpx-elevation-grid" x1="70" y1="18" x2="880" y2="18" />
            <line class="gpx-elevation-grid" x1="70" y1="118" x2="880" y2="118" />
            <line class="gpx-elevation-grid" x1="70" y1="218" x2="880" y2="218" />
            <text class="gpx-elevation-tick" x="60" y="22" text-anchor="end">{{ chart.maxLabel }}</text>
            <text class="gpx-elevation-tick" x="60" y="122" text-anchor="end">{{ chart.midLabel }}</text>
            <text class="gpx-elevation-tick" x="60" y="222" text-anchor="end">{{ chart.minLabel }}</text>
            @for (series of chart.series; track series.key) {
              <polyline class="gpx-elevation-line" [attr.points]="series.polyline" [style.stroke]="series.color" [style.strokeWidth]="series.lineWidth" [style.strokeDasharray]="series.dash" />
              @for (arrow of series.arrows; track $index) {
                <text class="gpx-preview-direction-arrow" text-anchor="middle" dominant-baseline="central" [attr.x]="arrow.x" [attr.y]="arrow.y" [attr.font-size]="series.arrowSize" [attr.fill]="series.color" [attr.opacity]=".92 * gpxOpacity() / 100" [attr.transform]="'rotate(' + arrow.angle + ' ' + arrow.x + ' ' + arrow.y + ')'">{{ series.arrowGlyph }}</text>
              }
            }
            <text class="gpx-elevation-axis-title" x="18" y="118" text-anchor="middle" transform="rotate(-90 18 118)">Elevation (m)</text>
            <text class="gpx-elevation-tick" x="70" y="242" text-anchor="start">{{ chart.startLabel }}</text>
            <text class="gpx-elevation-tick" x="880" y="242" text-anchor="end">{{ chart.endLabel }}</text>
            <text class="gpx-elevation-axis-title" x="475" y="265" text-anchor="middle">Track time</text>
          </svg>
          <div class="gpx-elevation-profile-legend">
            @for (series of chart.series; track series.key) {
              <div class="gpx-elevation-profile-legend-item">
                <svg viewBox="0 0 72 16" aria-hidden="true"><line x1="2" y1="8" x2="70" y2="8" [attr.stroke]="series.color" [attr.stroke-width]="series.lineWidth" [attr.stroke-dasharray]="series.dash" /></svg>
                <div><strong>{{ series.name }}</strong><span>{{ series.modeDetails }} · Line: {{ series.lineStyle }} · {{ series.lineWidth }} px · {{ series.directionLabel }}@if (series.customColors) { · Custom: {{ series.customColors }} }</span></div>
              </div>
            }
          </div>
        }
      } @else {
        <span class="offline-map-status">{{ latestGpxElevationProfileError() || 'No imported GPX track with timestamped elevation data was found in the available cache databases.' }}</span>
      }
    </details>
    @if (gpxError()) { <span class="gpx-error" role="alert">{{ gpxError() }}</span> }
    <details class="gpx-advanced-section app-disclosure">
      <summary>Advanced</summary>
      <app-gpx-database-import [databaseKey]="trackGpxDatabaseKey()" [databaseKeys]="favoriteGpxDatabaseKeys()" (help)="openGpxCacheHelp()" (imported)="refreshLatestGpxElevationProfile($event)" />
    </details>
  </div>
</div>
</div>
<div class="settings-tab-panel" data-settings-tab="routing" role="tabpanel" [hidden]="activeSettingsTab() !== 'routing'">
  <div class="settings-tab-content routing-tab">
    <div class="routing-toolbar">
      <div class="routing-calculate-row">
        <label class="routing-waypoints-visibility" title="Show routing points on map" aria-label="Show routing points on map">
          <input type="checkbox" [checked]="routeWaypointMarkersVisible()" (change)="changeRouteWaypointMarkersVisible($any($event.target).checked)" title="Show routing points on map" aria-label="Show routing points on map">
        </label>
        <button type="button" class="offline-map-add-button routing-calculate-button" (click)="calculateRoute()" [disabled]="routeBusy() || activeRouteWaypointCount() < 2 || activeRouteWaypointCount() > 50 || (routeProvider() === 'openrouteservice' && !routeApiKey().trim())">{{ routeBusy() ? 'Calculating…' : 'Calculate route…' }}</button>
      </div>
      <div class="routing-name-card">
        <label class="routing-name-label" for="routing-name-input">Route name</label>
        <input id="routing-name-input" class="routing-name-input" type="text" [value]="routeName()" (input)="changeRouteName($any($event.target).value)" placeholder="Route name">
      </div>
     <div class="routing-travel-mode-card">
        <label class="routing-travel-mode-label">Travel mode</label>
        <span class="routing-travel-mode-control">
          <select [value]="routeProfile()" (change)="routeProfile.set($any($event.target).value)">
            <option value="driving-car">Car</option><option value="cycling-regular">Bicycle</option><option value="foot-walking">Walking</option>
          </select>
          <span class="routing-travel-mode-icon" [attr.title]="routeProfile() === 'driving-car' ? 'Car' : routeProfile() === 'cycling-regular' ? 'Bicycle' : 'Walking'" aria-hidden="true">{{ routeProfile() === 'driving-car' ? '🚗' : routeProfile() === 'cycling-regular' ? '🚲' : '🚶' }}</span>
        </span>
      </div>
      <div class="routing-save-location-card">
        <button type="button" class="offline-map-add-button" (click)="chooseRouteSaveLocation()" [disabled]="routeBusy()">Select save location...</button>
        <span class="routing-save-location" [title]="routeSaveDirectory()">{{ routeSaveDirectory() || 'No save location selected' }}</span>
      </div>
      <div class="routing-toolbar-actions">
        <button type="button" class="offline-map-add-button routing-remove-all-button" (click)="clearRouteWaypoints()" [disabled]="routeWaypoints().length === 0 || routeBusy()">× All</button>
        <button type="button" class="routing-help-button" (click)="openRoutingHelp()" title="Open routing documentation" aria-label="Open routing documentation"><span aria-hidden="true">?</span></button>
      </div>
    </div>
    @if (routeProvider() === 'openrouteservice') {
      <div class="routing-key-row">
        <label for="ors-api-key">openrouteservice API key</label>
        <input id="ors-api-key" type="password" autocomplete="off" [value]="routeApiKey()" (input)="changeRouteApiKey($any($event.target).value)" placeholder="Paste your personal API key">
        <a href="https://account.heigit.org/" target="_blank" rel="noreferrer">Get API key</a>
      </div>
    }
    <div class="routing-actions">
      <span class="offline-map-status">{{ routeStatus() }}</span>
      @if (lastSavedRouteGpxPath()) {
        <button type="button" class="offline-map-remove-button" (click)="deleteLastSavedRouteGpx()" [disabled]="routeBusy()" title="Delete the last saved GPX file and remove it from the Track list" aria-label="Delete last saved GPX file">×</button>
      }
    </div>
    @if (activeRouteWaypointCount() > 50) { <span class="gpx-error">openrouteservice supports at most 50 active waypoints per request.</span> }
    @if (routeWaypoints().length > 0) {
    <div class="routing-points-list">
      @for (point of routeWaypoints(); track $index; let i = $index) {
        <div class="routing-point-row" [class.inactive]="point.active === false">
          <input class="routing-point-active" type="checkbox" [checked]="point.active !== false"
                 (change)="changeRouteWaypointActive(i, $any($event.target).checked)"
                 [attr.aria-label]="'Use route point ' + (i + 1)" title="Include this point in route calculation">
          <span class="routing-point-endpoint-column">@if (routeWaypoints().length >= 2 && i === 0) { <span class="routing-point-endpoint start">▶</span> } @else if (routeWaypoints().length >= 2 && i === routeWaypoints().length - 1) { <span class="routing-point-endpoint end">■</span> }</span>
          <span class="routing-point-index">{{ i + 1 }}.</span>
          <span class="routing-point-location"><strong>{{ point.name || 'Resolving location…' }}</strong><small>{{ point.latitude.toFixed(6) }}, {{ point.longitude.toFixed(6) }}</small></span>
          <div class="routing-point-actions">
            <button type="button" class="file-row-menu-trigger" (click)="toggleRoutePointActionMenu(i, $event); $event.stopPropagation()"
                    [attr.aria-expanded]="routePointActionMenuOpen() === i" aria-haspopup="menu"
                    [attr.aria-label]="'Actions for route point ' + (i + 1)" title="Point actions">☰</button>
          </div>
        </div>
      }
    </div>
    } @else {
      <div class="routing-empty-message">No route points. Right-click the map while the Routing tab is active to add locations.</div>
    }
    @if (routePointActionMenuOpen() !== null) {
      @let pointIndex = routePointActionMenuOpen()!;
      <div class="gpx-row-action-menu gpx-row-action-menu-floating routing-point-action-menu" role="menu"
           [style.top.px]="routePointActionMenuPosition().top" [style.left.px]="routePointActionMenuPosition().left"
           (click)="$event.stopPropagation()">
        <button type="button" role="menuitem" (click)="runRoutePointAction(pointIndex, 'remove')"><span aria-hidden="true">×</span> Remove point</button>
        <button type="button" role="menuitem" (click)="runRoutePointAction(pointIndex, 'up')" [disabled]="pointIndex === 0"><span aria-hidden="true">↑</span> Move up</button>
        <button type="button" role="menuitem" (click)="runRoutePointAction(pointIndex, 'down')" [disabled]="pointIndex === routeWaypoints().length - 1"><span aria-hidden="true">↓</span> Move down</button>
      </div>
    }
    @if (routeWaypoints().length === 0) { <div class="routing-pick-hint routing-pick-hint-bottom">Add route points by RIGHT clicking the map</div> }
    <details class="routing-advanced app-disclosure">
      <summary>Advanced</summary>
      <div class="routing-provider-row">
        <div class="routing-provider-card">
          <label class="routing-provider-label">Routing provider
          <select class="routing-provider-select" [value]="routeProviderSelection()" (change)="changeRouteProviderSelection($any($event.target).value)">
            @for (configuration of valhallaConfigurations(); track configuration.path) {
              <option [value]="'offline-valhalla|' + configuration.path" [disabled]="!configuration.available">Offline Valhalla — {{ configuration.name }}</option>
            }
            @if (valhallaConfigurations().length === 0) { <option value="offline-valhalla|">Offline Valhalla (no configuration)</option> }
            <option value="openrouteservice">openrouteservice</option>
          </select>
          </label>
        </div>
        <button type="button" class="offline-map-add-button routing-gpx-read-button" (click)="readRoutingWaypointsFromGpx()" [disabled]="routeBusy() || routeConfigBusy()" title="Reads saved points, names and active states from the most recently loaded GPX containing LumaScope routing metadata. Replaces the current list.">Read routing waypoints from GPX</button>
      </div>
    </details>
  </div>
</div>
<div class="settings-tab-panel" data-settings-tab="timeSlider" role="tabpanel" [hidden]="activeSettingsTab() !== 'timeSlider'">
  <div class="settings-tab-content time-slider-tab">
    <div class="time-slider-settings">
      @if (timeSliderHasData()) {
        <div class="time-slider-readouts">
          <span class="time-slider-min"><strong>Start:</strong> {{ formatTimeSliderDate(timeSliderStart()) }}</span>
          <span class="time-slider-duration">{{ formatTimeSliderDuration(timeSliderStart(), timeSliderEnd()) }}</span>
          <span class="time-slider-max"><strong>End:</strong> {{ formatTimeSliderDate(timeSliderEnd()) }}</span>
          <button type="button" class="routing-help-button time-slider-inline-help" (click)="openTimeSliderHelp()" title="Open time slider help" aria-label="Open time slider help"><span aria-hidden="true">?</span></button>
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
        <details class="time-slider-animate-section app-disclosure" [open]="timeSliderAnimationSectionOpen()" (toggle)="changeTimeSliderAnimationSectionOpen($any($event.target).open)">
          <summary>Animate</summary>
          <div class="time-slider-animate-options">
            <button type="button" class="time-slider-animate-button time-slider-play-button" [class.is-playing]="timeSliderAnimating()" [disabled]="!timeSliderActive() || !timeSliderHasData() || (!timeSliderAnimating() && timeSliderEnd() >= timeSliderMaximum())"
              (click)="toggleTimeSliderAnimation()"><span class="time-slider-animate-icon" aria-hidden="true">{{ timeSliderAnimating() ? '■' : '▶' }}</span> {{ timeSliderAnimating() ? 'Stop' : 'Play' }}</button>
            <section class="time-slider-animation-panel time-slider-play-panel">
              <h4>Speed</h4>
              <div class="time-slider-play-speed-row">
                <label class="time-slider-speed-control time-slider-animation-speed time-slider-control-card"><span>Animation</span><strong>{{ timeSliderAnimationSpeed() }}×</strong><ui-slider [min]="0.1" [max]="10" [step]="0.1" [value]="timeSliderAnimationSpeed()" (valueChange)="changeTimeSliderAnimationSpeed($event)" [color]="themeService.sliderColor()" aria-label="Animation speed" /></label>
                <label class="time-slider-speed-control time-slider-walking-speed time-slider-control-card"><span>Walking animation</span><strong>{{ walkingFigureAnimationSpeed() }}×</strong><ui-slider [min]="0.2" [max]="3" [step]="0.1" [value]="walkingFigureAnimationSpeed()" (valueChange)="changeWalkingFigureAnimationSpeed($event)" [isDisabled]="walkingFigureType() !== 'walker'" [color]="themeService.sliderColor()" aria-label="Walking animation speed" /></label>
              </div>
            </section>
            <section class="time-slider-animation-panel time-slider-symbol-panel">
              <h4 class="time-slider-symbol-heading"><label class="time-slider-walker-toggle time-slider-symbol-visibility"><input type="checkbox" [checked]="timeSliderWalkerVisible()" (change)="changeTimeSliderWalkerVisibility($any($event.target).checked)"> Symbol</label></h4>
              <div class="time-slider-symbol-controls-row">
                <div class="time-slider-symbol-preview-row time-slider-symbol-preview-card">
                  <div class="time-slider-symbol-preview-box" aria-label="Selected symbol preview">
                    @if (walkingFigureType() === 'walker') {
                      <span [style.transform]="walkingFigurePreviewTransform()"><svg xmlns="http://www.w3.org/2000/svg" width="30" height="38" viewBox="0 0 30 38" aria-hidden="true"><circle cx="15" cy="6" r="4.2" fill="#ffd166" stroke="#202020" stroke-width="1.2"/><path d="M15 11 L15 23" stroke="#1769aa" stroke-width="5" stroke-linecap="round"/><path d="M14 14 L8 21" stroke="#ffd166" stroke-width="3.2" stroke-linecap="round"/><path d="M16 14 L22 21" stroke="#ffd166" stroke-width="3.2" stroke-linecap="round"/><path d="M14 23 L9 34" stroke="#263238" stroke-width="4" stroke-linecap="round"/><path d="M16 23 L21 34" stroke="#263238" stroke-width="4" stroke-linecap="round"/></svg></span>
                    } @else {
                      <span [innerHTML]="walkingFigurePreviewHtml()" [style.transform]="walkingFigurePreviewTransform()"></span>
                    }
                  </div>
                  <span class="time-slider-symbol-front">Front</span>
                </div>
                <label class="time-slider-symbol-select"><select [value]="walkingFigureType()" (change)="changeWalkingFigureType($any($event.target).value)"><option value="walker">Walking person</option><option value="car">Car (PKW)</option><option value="carFront">Car (front)</option><option value="suv">SUV</option><option value="taxi">Taxi</option><option value="taxiFront">Taxi (front)</option><option value="racecar">Race car</option><option value="van">Van</option><option value="pickup">Pickup</option><option value="ambulance">Ambulance</option><option value="police">Police car</option><option value="policeFront">Police car (front)</option><option value="firetruck">Fire engine</option><option value="bus">Bus</option><option value="busFront">Bus (front)</option><option value="trolleybus">Trolleybus</option><option value="truck">Truck</option><option value="delivery">Delivery truck</option><option value="plane">Airplane</option><option value="helicopter">Helicopter</option><option value="train">Train</option><option value="bicycle">Bicycle</option><option value="motorcycle">Motorcycle</option><option value="scooter">Scooter</option><option value="tractor">Tractor</option><option value="boat">Motorboat</option><option value="ship">Ship</option><option value="sailboat">Sailboat</option><option value="cableCar">Cable car</option><option value="autoRickshaw">Auto rickshaw</option><option value="rocket">Rocket</option><option value="smallPlane">Small airplane</option><option value="flyingSaucer">Flying saucer</option><option value="locomotive">Steam locomotive</option><option value="railCar">Rail car</option><option value="tram">Tram</option><option value="mountainRailway">Mountain railway</option><option value="monorail">Monorail</option><option value="highSpeedTrain">High-speed train</option><option value="bulletTrain">Bullet train</option><option value="lightRail">Light rail</option><option value="metro">Metro</option><option value="motorYacht">Motor yacht</option><option value="ferry">Ferry</option><option value="cruiseShip">Cruise ship</option><option value="canoe">Canoe</option></select></label>
                <label class="time-slider-symbol-size time-slider-control-card"><span>Size</span><strong>{{ walkingFigureSize().toFixed(1) }}×</strong><ui-slider class="zoom-purpose-slider" [min]="0.5" [max]="3" [step]="0.1" [value]="walkingFigureSize()" (valueChange)="changeWalkingFigureSize($event)" aria-label="Walking figure size" /></label>
                <div class="time-slider-symbol-orientation-controls">
                  <label class="time-slider-symbol-rotation time-slider-control-card"><span>Rotation</span><strong>{{ selectedWalkingFigureSymbolSettings().rotation }}°</strong><ui-slider [min]="0" [max]="359" [step]="1" [value]="selectedWalkingFigureSymbolSettings().rotation" (valueChange)="changeWalkingFigureRotation($event)" (valueCommit)="persistWalkingFigureRotation()" [color]="themeService.sliderColor()" aria-label="Rotation" /></label>
                  <div class="time-slider-symbol-orientation-actions">
                    <button type="button" class="time-slider-symbol-snap" (click)="snapWalkingFigureRotation()" title="Snap to the nearest 0°, 90°, 180° or 270°">Snap 90°</button>
                    <label class="time-slider-symbol-flip"><input type="checkbox" [checked]="selectedWalkingFigureSymbolSettings().flipHorizontal" (change)="changeWalkingFigureFlipHorizontal($any($event.target).checked)"><span>Flip horizontal</span></label>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </details>
        <details class="time-slider-minmax-section app-disclosure">
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
        <div class="time-slider-no-data-row"><span class="time-slider-help">{{ timeSliderNoDataHelpText() }}</span><button type="button" class="routing-help-button time-slider-inline-help" (click)="openTimeSliderHelp()" title="Open time slider help" aria-label="Open time slider help"><span aria-hidden="true">?</span></button></div>
      }
    </div>
  </div>
</div>
<div class="settings-tab-panel" data-settings-tab="marker" role="tabpanel" [hidden]="activeSettingsTab() !== 'marker'">
<div class="settings-tab-content marker-tab">
            <div class="marker-settings-content">
              <div class="marker-setting-row marker-first-row"><label class="marker-enable-toggle"><input type="checkbox" [checked]="directoryMarkersEnabled()" (change)="changeDirectoryMarkersEnabled($any($event.target).checked)"> Show images</label><button type="button" class="map-toolbar-button marker-fit-images-button" (click)="fitMapToImages()" [disabled]="!directoryMarkersEnabled()" title="Fit map to all images with GPS coordinates"><span aria-hidden="true">⤢</span> Fit map to images</button><button type="button" class="routing-help-button marker-tab-help" (click)="openPhotoMarkersTabHelp()" title="Open photo markers tab help" aria-label="Open photo markers tab help"><span aria-hidden="true">?</span></button></div>
              <label class="marker-enable-toggle marker-setting-row"><input type="checkbox" [checked]="useAllPhotosInDb()" (change)="changeUseAllPhotosInDb($any($event.target).checked)"> Use all images in DB</label>
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
                      <span class="color-swatch" [style.background]="markerColor() === 'dynamic' ? 'linear-gradient(90deg,#34c759 0 33%,#ffd60a 33% 66%,#ff3b30 66%)' : markerColor()" [style.color]="markerColor() === 'dynamic' ? '#171717' : selectedMarkerTextColor()">{{ markerColor() === 'dynamic' ? 'Dynamic' : markerColor() }}</span>
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
              <details class="marker-summary-section app-disclosure">
                <summary>Summary</summary>
                <div class="marker-summary-content">
                  <div class="marker-progress-row">
                    <div class="marker-progress-text">Database records: <strong>{{ markerFilesChecked() }} / {{ markerFilesTotal() }}</strong></div>
                    <progress class="marker-progress" [max]="markerFilesTotal() || 1" [value]="markerFilesChecked()"></progress>
                  </div>
                  <table class="marker-summary-table">
                    <tbody>
                      <tr><th scope="row">Folder</th><td>{{ markerSourceFolder() }}</td></tr>
                      <tr><th scope="row">GPS coordinates found</th><td>{{ markerCount() }}</td></tr>
                      <tr><th scope="row">Minimum timestamp</th><td>{{ markerTimestampRange().minimum }}</td></tr>
                      <tr><th scope="row">Maximum timestamp</th><td>{{ markerTimestampRange().maximum }}</td></tr>
                      <tr><th scope="row">Database status</th><td role="status">{{ markerStatus() }}</td></tr>
                    </tbody>
                  </table>
                </div>
              </details>
            </div>
          </div>

  <details class="gpx-database-section app-disclosure">
    <summary>Images -&gt; GPX</summary>
    <button type="button" class="offline-map-add-button" (click)="generateGpxFromMarkers()" [disabled]="!hasDirectoryPhotoMarkers()">Generate GPX from images</button>
  </details>
</div>
<div class="settings-tab-panel" data-settings-tab="view" role="tabpanel" [hidden]="activeSettingsTab() !== 'view'">
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
                <tr role="option" tabindex="0" [attr.aria-selected]="mapSource() === 'online'" (click)="selectMapSource('online')" (keydown.enter)="selectMapSource('online')" (keydown.space)="$event.preventDefault(); selectMapSource('online')"><td>Online map</td><td>—</td><td>Online</td></tr>
                <tr role="option" tabindex="0" [attr.aria-selected]="mapSource() === 'offline'" (click)="selectMapSource('offline')" (keydown.enter)="selectMapSource('offline')" (keydown.space)="$event.preventDefault(); selectMapSource('offline')"><td>MBTiles</td><td>.mbtiles</td><td>Offline</td></tr>
                <tr role="option" tabindex="0" [attr.aria-selected]="mapSource() === 'osmand'" (click)="selectMapSource('osmand')" (keydown.enter)="selectMapSource('osmand')" (keydown.space)="$event.preventDefault(); selectMapSource('osmand')"><td>OsmAnd (no labels)</td><td>.obf</td><td>Offline</td></tr>
                <tr role="option" tabindex="0" [attr.aria-selected]="mapSource() === 'osmand-atlas'" (click)="selectMapSource('osmand-atlas')" (keydown.enter)="selectMapSource('osmand-atlas')" (keydown.space)="$event.preventDefault(); selectMapSource('osmand-atlas')"><td>OsmAnd Atlas</td><td>.obf</td><td>Offline</td></tr>
                <tr role="option" tabindex="0" [attr.aria-selected]="mapSource() === 'mapsforge'" (click)="selectMapSource('mapsforge')" (keydown.enter)="selectMapSource('mapsforge')" (keydown.space)="$event.preventDefault(); selectMapSource('mapsforge')"><td>Mapsforge</td><td>.map</td><td>Offline</td></tr>
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
    @if (mapSource() === 'mapsforge' && hasActiveMapsforgeMaps()) {
      <label class="offline-style-control"><span>Mapsforge Theme</span>
        <select [value]="mapsforgeThemePath()" (change)="changeMapsforgeTheme($any($event.target).value)">
          <option value="">Default (built-in)</option>
          @for (theme of mapsforgeThemes(); track theme.path) {
            <option [value]="theme.path">{{ theme.relativePath }}</option>
          }
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
  <details class="zoom-settings-section app-disclosure">
    <summary>
      <span>Zoom</span>
      <span class="zoom-summary-control">
        <span class="zoom-buttons">
          <button type="button" class="zoom-step" (click)="adjustZoom(-1)" aria-label="Zoom out">−</button>
          <button type="button" class="zoom-step" (click)="adjustZoom(1)" aria-label="Zoom in">+</button>
        </span>
        <ui-slider class="zoom-purpose-slider" [min]="1" [max]="20" [step]="1" [value]="zoomLevel()" (valueChange)="changeZoom($event)" aria-label="Map zoom" />
        <span class="zoom-value">{{ zoomLevel() }}</span>
      </span>
    </summary>
    <div class="atlas-density-zoom-row">
      <div class="range-setting atlas-density-setting" [class.setting-unavailable]="mapSource() !== 'osmand-atlas' && mapSource() !== 'mapsforge'">
        <label for="map-display-density">Display density factor</label>
        <input id="map-display-density" type="range" min="1" max="3" step="0.05"
          [value]="displayDensityFactor()"
          (input)="previewDisplayDensity($any($event.target).value)"
          (change)="changeDisplayDensity($any($event.target).value)"
          [disabled]="mapSource() !== 'osmand-atlas' && mapSource() !== 'mapsforge'"
          aria-label="Map display density">
        <span class="range-value">{{ displayDensityFactor() }}×</span>
        <button type="button" class="map-toolbar-button" (click)="resetDisplayDensity()" [disabled]="mapSource() !== 'osmand-atlas' && mapSource() !== 'mapsforge'" title="Reset to Windows display scaling">Windows</button>
      </div>
    </div>
  </details>
  <details class="opacity-settings app-disclosure" [open]="opacitySectionOpen()" (toggle)="onLocationDetailsToggle($event)">
    <summary>
      <span>Opacity</span>
    </summary>
    <div class="opacity-content">
      <div class="range-setting">
        <label class="visibility-toggle">Map <input type="checkbox" [checked]="mapVisible()" (change)="changeMapVisibility($any($event.target).checked)" aria-label="Show map"></label>
        <ui-slider class="opacity-slider" [min]="0" [max]="100" [step]="1" [value]="mapOpacity()" [color]="themeService.sliderColor()" (valueChange)="changeMapOpacity($event)" />
        <span class="range-value">{{ mapOpacity() }}%</span>
      </div>
      <div class="range-setting">
        <div class="opacity-row-label"><label class="visibility-toggle">Track <input type="checkbox" [checked]="gpxVisible()" (change)="changeTrackVisibility($any($event.target).checked)" aria-label="Show track"></label><button type="button" class="opacity-fit-button" (click)="fitSelectedTracksToMap()" [disabled]="!hasActiveTrackPoints()" title="Fit selected tracks to map" aria-label="Fit selected tracks to map"><span aria-hidden="true">⤢</span></button></div>
        <ui-slider class="opacity-slider" [min]="0" [max]="100" [step]="1" [value]="gpxOpacity()" [color]="themeService.sliderColor()" (valueChange)="changeGpxOpacity($event)" />
        <span class="range-value">{{ gpxOpacity() }}%</span>
      </div>
      <div class="range-setting">
        <div class="opacity-row-label"><label class="visibility-toggle">Images <input type="checkbox" [checked]="markersVisible()" (change)="changeMarkersVisibility($any($event.target).checked)" aria-label="Show images"></label><button type="button" class="opacity-fit-button" (click)="fitSelectedImagesToMap()" [disabled]="!hasDirectoryPhotoMarkers()" title="Fit selected images to map" aria-label="Fit selected images to map"><span aria-hidden="true">⤢</span></button></div>
        <ui-slider class="opacity-slider" [min]="0" [max]="100" [step]="1" [value]="markerOpacity()" [color]="themeService.sliderColor()" (valueChange)="changeMarkerOpacity($event)" />
        <span class="range-value">{{ markerOpacity() }}%</span>
      </div>
      <div class="range-setting">
        <label class="visibility-toggle">Location <input type="checkbox" [checked]="locationVisible()" (change)="changeLocationVisibility($any($event.target).checked)" aria-label="Show location"></label>
        <ui-slider class="opacity-slider" [min]="0" [max]="100" [step]="1" [value]="locationOpacity()" [color]="themeService.sliderColor()" (valueChange)="changeLocationOpacity($event)" />
        <span class="range-value">{{ locationOpacity() }}%</span>
      </div>
      <div class="range-setting overlay-opacity-setting" [class.setting-unavailable]="!overlayMode">
        <label for="overlay-opacity">Window</label>
        <input id="overlay-opacity" class="opacity-slider" type="range" min="0" max="100" step="1" [value]="overlayOpacity()" (input)="changeOverlayOpacity($any($event.target).value)" [disabled]="!overlayMode" aria-label="Window opacity">
        <span class="range-value">{{ overlayOpacity() }}%</span>
      </div>
      <div class="range-setting" [class.setting-unavailable]="mapSource() !== 'offline' && mapSource() !== 'osmand' && mapSource() !== 'osmand-atlas'">
        <label class="visibility-toggle">Labels <input type="checkbox" [checked]="labelsVisible()" (change)="changeLabelsVisibility($any($event.target).checked)" [disabled]="mapSource() === 'online'" aria-label="Show labels"></label>
        <ui-slider id="map-label-opacity" class="opacity-slider" [min]="0" [max]="100" [step]="1" [value]="labelOpacity()" (valueChange)="changeLabelOpacity($event)" [color]="themeService.sliderColor()" [isDisabled]="mapSource() === 'osmand' || mapSource() === 'osmand-atlas'" aria-label="Map label opacity" />
        <span class="range-value">{{ labelOpacity() }}%</span>
      </div>
      <div class="range-setting" [class.setting-unavailable]="activeHillshadeDatabaseCount() === 0">
        <label class="visibility-toggle">Hillshade <input type="checkbox" [checked]="hillshadeVisible()" (change)="changeHillshadeVisibility($any($event.target).checked)" [disabled]="activeHillshadeDatabaseCount() === 0" aria-label="Show Hillshade"></label>
        <ui-slider id="hillshade-opacity" class="opacity-slider" [min]="0" [max]="100" [step]="1" [value]="hillshadeOpacity()" (valueChange)="changeHillshadeOpacity($event)" [color]="themeService.sliderColor()" [isDisabled]="activeHillshadeDatabaseCount() === 0 || !hillshadeVisible()" aria-label="Hillshade opacity" />
        <span class="range-value">{{ hillshadeOpacity() }}%</span>
      </div>
    </div>
  </details>
  <details class="view-rerender-section app-disclosure"
    [open]="renderSectionOpen()"
    (toggle)="onLocationDetailsToggle($event)"
    [class.is-rendering]="renderActiveCount() > 0 || hillshadeActiveCount() > 0 || rerenderVisibleTilesBusy() || renderDisplayPending()"
    [class.has-render-errors]="renderActiveCount() === 0 && hillshadeActiveCount() === 0 && !rerenderVisibleTilesBusy() && !renderDisplayPending() && (lastRenderTileCounts().failed > 0 || lastHillshadeTileCounts().failed > 0)"
    [class.is-render-complete]="renderActiveCount() === 0 && hillshadeActiveCount() === 0 && !rerenderVisibleTilesBusy() && !renderDisplayPending() && (renderTotalCount() > 0 || hillshadeTotalCount() > 0) && lastRenderTileCounts().failed === 0 && lastHillshadeTileCounts().failed === 0">
    <summary>
      <span>Render</span>
      <span class="map-cache-progress render-progress-always" [class.is-inactive]="renderActiveCount() === 0 && hillshadeActiveCount() === 0 && !rerenderVisibleTilesBusy() && !renderDisplayPending()" [attr.aria-disabled]="renderActiveCount() === 0 && hillshadeActiveCount() === 0 && !rerenderVisibleTilesBusy() && !renderDisplayPending()">
        @if (renderActiveCount() > 0 || rerenderVisibleTilesBusy() || renderDisplayPending()) {
          <progress [value]="renderProgressValue()" [max]="renderProgressMaximum()" aria-label="Map tile rendering progress"></progress>
        }
        @if (renderActiveCount() === 0 && hillshadeActiveCount() === 0 && !rerenderVisibleTilesBusy() && !renderDisplayPending()) {
          <span>Rendering inactive</span>
        } @else {
          <span>
            @if (renderActiveCount() > 0) { Map tiles: {{ renderActiveCount() }} active }
            @if (hillshadeActiveCount() > 0 || hillshadeDisplayPending()) {
              @if (renderActiveCount() > 0) { · }
              @if (hillshadeActiveCount() > 0) { Hillshade: {{ hillshadeCompletedCount() }}/{{ hillshadeTotalCount() }} tiles · {{ hillshadeActiveCount() }} active }
              @else { Hillshade: Display }
              <progress class="hillshade-active-progress" [value]="hillshadeProgressValue()" [max]="hillshadeProgressMaximum()" aria-label="Hillshade rendering progress"></progress>
            }
            @if (renderDisplayPending() && renderActiveCount() === 0 && hillshadeActiveCount() === 0) { Display }
            @else if (rerenderVisibleTilesBusy()) { · Rerendering visible tiles }
          </span>
        }
      </span>
    </summary>
    <div class="view-rerender-layout">
      <div class="map-cache-actions view-rerender-actions">
        <div style="display: flex; align-items: center; gap: 6px;">
          <button type="button" (click)="refreshVisibleTiles()" title="Reloads the visible tiles from the existing disk cache without forcing a new native render." [disabled]="(mapSource() !== 'osmand-atlas' && mapSource() !== 'osmand') || rerenderVisibleTilesBusy()">
            Refresh
          </button>
          <button type="button" (click)="rerenderVisibleTiles()" title="Forces a fresh native render of the visible tiles instead of using the cached tile images." [disabled]="!canRerenderVisibleTiles() || rerenderVisibleTilesBusy()">
            {{ rerenderVisibleTilesBusy() ? 'Rerendering…' : 'Rerender' }}
          </button>
          <button type="button" class="danger" (click)="cancelMapRendering()" title="Cancels the active visible-tile rerender." [disabled]="!rerenderVisibleTilesBusy()">
            Cancel
          </button>
        </div>
        @if (rerenderVisibleTilesStatus()) {
          <span class="offline-map-status" role="status">{{ rerenderVisibleTilesStatus() }}</span>
        }
      </div>
      <details class="render-helper-activity-section app-disclosure">
        <summary>Render helper</summary>
        <div class="render-statistics-content">
          <div class="range-setting render-worker-setting">
            <label for="render-worker-count">Parallel render helper processes</label>
            <ui-slider id="render-worker-count" class="opacity-slider" [min]="1" [max]="4" [step]="1"
              [value]="renderWorkerCount()" (valueChange)="changeRenderWorkerCount($event)"
              [color]="themeService.sliderColor()" aria-label="Number of parallel render helper processes" />
            <span class="range-value">{{ renderWorkerCount() }}</span>
          </div>
          <section class="render-helper-activity" aria-label="Active render helpers">
            <div class="render-helper-activity-heading">
              <span>{{ offlineRenderTasks().filter(task => task.state === 'Running').length }} active · {{ offlineRenderTasks().filter(task => task.state === 'Queued').length }} queued</span>
            </div>
            <div class="render-helper-activity-list" role="list" aria-live="polite">
              @if (offlineRenderTasks().length) {
                @for (task of offlineRenderTasks(); track task.id) {
                  <div class="render-helper-activity-row" role="listitem" [class.queued]="task.state === 'Queued'">
                    <span class="render-helper-activity-state">{{ task.state === 'Running' ? 'Active' : 'Queued' }}</span>
                    <strong>{{ task.helper }}</strong>
                    <span class="render-helper-activity-description" [title]="task.description">{{ task.description }}</span>
                  </div>
                }
              } @else {
                <div class="render-helper-activity-empty">No render helper tasks are active or queued.</div>
              }
            </div>
          </section>
        </div>
      </details>
      <details class="render-statistics-section app-disclosure view-settings-section">
        <summary>View settings</summary>
        <div class="render-statistics-content">
          <label class="visibility-toggle"><input type="checkbox" [checked]="renderVisualsEnabled()" (change)="changeRenderVisualsEnabled($any($event.target).checked)"> Show tile rendering overlay and dimming</label>
          <label class="visibility-toggle scale-visibility-toggle"><input type="checkbox" [checked]="scaleVisible()" (change)="changeScaleVisible($any($event.target).checked)"> Show map scale</label>
          <label class="visibility-toggle scale-visibility-toggle" [class.setting-unavailable]="!canShowMapBounds()" title="Map bounds are drawn only at zoom level 10 or lower (zoom ≤ 10). Zoom in beyond level 10 to hide them."><input type="checkbox" [checked]="mapBoundsVisible()" (change)="changeMapBoundsVisible($any($event.target).checked)" [disabled]="!canShowMapBounds()"> Show map bounds</label>
          <div class="range-setting photo-preview-size-setting">
            <label for="photo-preview-size">Photo marker preview width</label>
            <ui-slider id="photo-preview-size" class="opacity-slider" [min]="60" [max]="240" [step]="10"
              [value]="photoPreviewSize()" (valueChange)="changePhotoPreviewSize($event)"
              [color]="themeService.sliderColor()" aria-label="Photo marker preview width" />
            <span class="range-value">{{ photoPreviewSize() }} px</span>
          </div>
        </div>
      </details>
      <details class="render-statistics-section app-disclosure">
        <summary>Statistics</summary>
        <div class="render-statistics-content">
      <div class="render-tile-statistics-box">
      <table class="render-tile-statistics" aria-live="polite">
        
        <colgroup>
          <col class="render-stat-label-column">
          <col class="render-stat-value-column">
          <col class="render-stat-value-column">
        </colgroup>
        <thead>
          <tr>
            <th scope="col" class="render-counter-heading">Map tiles · Active OBF maps (#{{ activeOsmandMapCount() }})</th>
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
          <tr>
            <th scope="row" title="End-to-end time from Atlas IPC submission until the RGBA tile is ready, including renderer queue wait.">Avg. total time</th>
            <td>{{ totalRenderTiming().count ? totalRenderTiming().averageMs.toFixed(1) + ' ms' : '—' }}</td>
            <td>{{ lastRenderTiming().count ? lastRenderTiming().averageMs.toFixed(1) + ' ms' : '—' }}</td>
          </tr>
          <tr>
            <th scope="row">Median total time</th>
            <td>{{ totalRenderTiming().count ? totalRenderTiming().medianMs.toFixed(1) + ' ms' : '—' }}</td>
            <td>{{ lastRenderTiming().count ? lastRenderTiming().medianMs.toFixed(1) + ' ms' : '—' }}</td>
          </tr>
          <tr>
            <th scope="row">Min / max</th>
            <td>{{ totalRenderTiming().count ? totalRenderTiming().minMs.toFixed(1) + ' / ' + totalRenderTiming().maxMs.toFixed(1) + ' ms' : '—' }}</td>
            <td>{{ lastRenderTiming().count ? lastRenderTiming().minMs.toFixed(1) + ' / ' + lastRenderTiming().maxMs.toFixed(1) + ' ms' : '—' }}</td>
          </tr>
          <tr>
            <th scope="row">Timing samples</th>
            <td>{{ totalRenderTiming().count.toLocaleString(locale) }}</td>
            <td>{{ lastRenderTiming().count.toLocaleString(locale) }}</td>
          </tr>
          <tr>
            <th scope="row" title="Time spent waiting in the selected Atlas worker queue before native rendering can start.">Avg. queue wait</th>
            <td>{{ totalRenderQueueTiming().count ? totalRenderQueueTiming().averageMs.toFixed(1) + ' ms' : '—' }}</td>
            <td>{{ lastRenderQueueTiming().count ? lastRenderQueueTiming().averageMs.toFixed(1) + ' ms' : '—' }}</td>
          </tr>
          <tr>
            <th scope="row">Median queue wait</th>
            <td>{{ totalRenderQueueTiming().count ? totalRenderQueueTiming().medianMs.toFixed(1) + ' ms' : '—' }}</td>
            <td>{{ lastRenderQueueTiming().count ? lastRenderQueueTiming().medianMs.toFixed(1) + ' ms' : '—' }}</td>
          </tr>
          <tr>
            <th scope="row">Queue min / max</th>
            <td>{{ totalRenderQueueTiming().count ? totalRenderQueueTiming().minMs.toFixed(1) + ' / ' + totalRenderQueueTiming().maxMs.toFixed(1) + ' ms' : '—' }}</td>
            <td>{{ lastRenderQueueTiming().count ? lastRenderQueueTiming().minMs.toFixed(1) + ' / ' + lastRenderQueueTiming().maxMs.toFixed(1) + ' ms' : '—' }}</td>
          </tr>
        </tbody>
      </table>
      <table class="render-tile-statistics hillshade-render-statistics" aria-live="polite">
        <colgroup>
          <col class="render-stat-label-column">
          <col class="render-stat-value-column">
          <col class="render-stat-value-column">
        </colgroup>
        <thead>
          <tr>
            <th scope="col" class="render-counter-heading">Hillshade (#{{ activeHillshadeDatabaseCount() }})</th>
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
            <th scope="row">From cache</th>
            <td>–</td>
            <td>–</td>
          </tr>
          <tr>
            <th scope="row">Errors</th>
            <td>{{ totalHillshadeTileCounts().failed.toLocaleString(locale) }}</td>
            <td>{{ lastHillshadeTileCounts().failed.toLocaleString(locale) }}</td>
          </tr>
        </tbody>
      </table>
        </div>
        </div>
      </details>
      <details class="render-statistics-section app-disclosure optimize-obf-rendering-section">
        <summary>Optimize OsmAnd .obf rendering</summary>
        <div class="render-statistics-content">
          <label class="visibility-toggle scale-visibility-toggle" [class.setting-unavailable]="mapSource() !== 'osmand' && mapSource() !== 'osmand-atlas'">
            <input type="checkbox" [checked]="optimizedObfSelectionEnabled()" (change)="changeOptimizedObfSelectionEnabled($any($event.target).checked)" [disabled]="mapSource() !== 'osmand' && mapSource() !== 'osmand-atlas'">
            Optimize OBF selection by bounds
          </label>
          @if (mapSource() === 'osmand' || mapSource() === 'osmand-atlas') {
            <div class="active-obf-list-box">
              <table class="active-obf-list" aria-live="polite">
                <thead><tr><th colspan="2">Viewport OBF maps ({{ viewportObfMaps().length }})</th></tr></thead>
                <tbody>
                  @for (map of viewportObfMaps(); track map.id) {
                    <tr><td>{{ map.name }}</td><td>{{ map.minZoom }}–{{ map.maxZoom }}</td></tr>
                  } @empty {
                    <tr><td colspan="2">No matching OBF maps</td></tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </div>
      </details>
      </div>
  </details>
    </div>
</div>
<div class="settings-tab-panel" data-settings-tab="offlineMaps" role="tabpanel" [hidden]="activeSettingsTab() !== 'offlineMaps'">
<div class="settings-tab-content offline-maps-tab-content" [class.resource-section-warning]="offlineMapHasUnselectedFiles() && offlineMapTabErrorCount() === 0">
    <button type="button" class="routing-help-button offline-tab-help" (click)="openResourcePackageHelp()" title="Open resource package documentation" aria-label="Open resource package documentation"><span aria-hidden="true">?</span></button>
    <div class="mbtiles-selection offline-map-toolbar resource-package-scan-toolbar">
      <button type="button" class="offline-map-add-button resource-package-open-button" (click)="scanResourcePackage()" [disabled]="resourcePackageScanBusy() || offlineFilesCheckBusy()">{{ resourcePackageScanBusy() ? 'Opening package…' : 'Open resource package…' }}</button>
      <span class="offline-map-status" role="status">{{ resourcePackageScanStatus() || 'Open the extracted resource package to discover offline maps and resources.' }}</span>
      
    </div>
    @if (resourcePackageScanFound()) {
      <div class="resource-package-scan-results" aria-live="polite">
        <table class="resource-package-scan-table">
          <tbody>
            <tr>
              <th scope="row">Found</th>
              @for (item of resourcePackageScanFound().split(' · '); track $index) {
                <td>{{ item }}</td>
              }
            </tr>
            <tr>
              <th scope="row">Changed</th>
              @for (item of resourcePackageScanChanged().split(' · '); track $index) {
                <td>{{ item }}</td>
              }
            </tr>
          </tbody>
        </table>
      </div>
    }
    @if (resourcePackageScanError()) {
      <details class="map-cache-section offline-map-filter-section app-disclosure">
        <summary class="map-cache-heading">Scan details / warnings</summary>
        <pre class="offline-map-import-errors">{{ resourcePackageScanError() }}</pre>
      </details>
    }

  <div class="mbtiles-selection offline-map-toolbar">
    <label class="offline-map-preset-control">Preset:
      <select [value]="offlineMapPreset()" (change)="changeOfflineMapPreset($any($event.target).value)">
        @for (preset of mapPresetOptions(); track preset.id) { <option [value]="preset.id">{{ preset.name }}</option> }
      </select>
    </label>
    <label class="offline-map-list-filter">Filter:
       <select [value]="offlineMapListFilter()" (change)="offlineMapListFilter.set($any($event.target).value)">
         <option value="all">All</option><option value="mbtiles" class="mbtiles-filter-option">{{ offlineMapTypeLabels.mbtiles }}</option><option value="obf" class="obf-filter-option">{{ offlineMapTypeLabels.obf }}</option><option value="map" class="mapsforge-filter-option">{{ offlineMapTypeLabels.mapsforge }}</option><option value="hillshade" class="hillshade-filter-option">{{ offlineMapTypeLabels.hillshade }}</option><option value="valhalla" class="resource-valhalla-filter-option">Valhalla (offline routing)</option><option value="osmandResources" class="resource-osmand-filter-option">OsmAnd resources (rendering)</option><option value="mapsforgeTheme" class="resource-mapsforge-filter-option">Mapsforge XML theme</option><option value="inUse">InUse</option><option value="active">Active</option><option value="inactive">Inactive</option><option value="missing">Missing</option><option value="updates">Updates</option><option value="current">Current (no update needed)</option><option value="noMatch">No matching download</option>
       </select>
     </label>
  </div>
</div>
</div>
<div class="settings-tab-panel" data-settings-tab="cache" role="tabpanel" [hidden]="activeSettingsTab() !== 'cache'">
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
        <span class="offline-map-status">{{ osmAndTileCacheStatus() || 'Stores cached PNG tiles for OsmAnd and OsmAnd Atlas.' }}</span>
        <button type="button" class="danger" (click)="clearOsmAndTileCache()" [disabled]="osmAndTileCacheBusy()">
          {{ osmAndTileCacheBusy() ? 'Clearing…' : 'Clear cache' }}
        </button>
      </div>
    </div>
    <div class="map-cache-section">
      <div class="map-cache-heading">GPX database entries</div>
      <div class="map-cache-actions">
        <span class="offline-map-status">{{ gpxDatabaseClearStatus() || 'Deletes imported GPX files, track segments and track points from every drive cache database. Original GPX files and favorites are not affected.' }}</span>
        <button type="button" class="danger" (click)="clearAllGpxDatabaseEntries()" [disabled]="gpxDatabaseClearBusy()">
          {{ gpxDatabaseClearBusy() ? 'Deleting…' : 'Delete all GPX database entries' }}
        </button>
      </div>
    </div>
  </div>
</div>
<div class="settings-tab-panel" data-settings-tab="memory" role="tabpanel" [hidden]="activeSettingsTab() !== 'memory'">
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
<div class="settings-tab-panel" data-settings-tab="download" role="tabpanel" [hidden]="activeSettingsTab() !== 'download'">
  <div class="settings-tab-content download-tab">
    <details class="map-cache-section download-section app-disclosure">
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
                <td><button type="button" class="file-path-copy-button" (click)="copyFilePath(source.url)" title="Copy URL" aria-label="Copy URL">⧉</button><button type="button" class="gpx-open-button" (click)="openDownloadSource(source.url)" [disabled]="!isValidDownloadUrl(source.url)" title="Open download source" aria-label="Open download source">↗</button><button type="button" class="mbtiles-remove-button" (click)="removeDownloadSource(i)" aria-label="Remove download source" title="Remove download source">×</button></td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <p class="offline-map-status">These URLs are saved in application settings. Only entries enabled under “Use for updates” are checked by the Offline update checker.</p>
    </details>

    <details class="map-cache-section download-section app-disclosure">
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


  </div>
</div>
<div class="settings-tab-panel" data-settings-tab="errors" role="tabpanel" [hidden]="activeSettingsTab() !== 'errors'">
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
      <div class="map-content">
        @if (mapDisplayNotice() && (!settingsOpen() || activeSettingsTab() !== 'offlineMaps')) {
          <div class="map-display-notice" role="alert">
            <button type="button" class="map-display-notice-close" (click)="mapDisplayNotice.set('')" title="Dismiss map notice" aria-label="Dismiss map notice">×</button>
            <strong>Map cannot be displayed</strong>
            <span>{{ mapDisplayNotice() }}</span>
            <button type="button" (click)="settingsOpen.set(true); selectSettingsTab('offlineMaps')">Open Offline tab</button>
          </div>
        }
        @if (settingsOpen() && offlineMapListMounted()) {
          <div class="offline-map-list-view" [style.display]="activeSettingsTab() === 'offlineMaps' ? '' : 'none'">
            <div class="mbtiles-map-list">
              @if (filteredOffline().length + filteredHillshadeDatabases().length + filteredResourcePackageEntries().length > 0) {
                <table class="mbtiles-map-table">
                  <thead><tr><th class="mbtiles-inuse-column"><span class="table-sort-button" (click)="sortOfflineMaps('inUse')">InUse {{ offlineMapSortIndicator('inUse') }}</span></th><th class="mbtiles-enabled-column"><span class="table-sort-button" (click)="sortOfflineMaps('enabled')">Active {{ offlineMapSortIndicator('enabled') }}</span></th><th class="mbtiles-type-column"><span class="table-sort-button" (click)="sortOfflineMaps('type')">Type {{ offlineMapSortIndicator('type') }}</span></th><th><span class="table-sort-button" (click)="sortOfflineMaps('name')">File {{ offlineMapSortIndicator('name') }}</span></th><th><span class="table-sort-button" (click)="sortOfflineMaps('path')">Path {{ offlineMapSortIndicator('path') }}</span></th><th><span class="table-sort-button" (click)="sortOfflineMaps('fileSize')">Size {{ offlineMapSortIndicator('fileSize') }}</span></th><th><span class="table-sort-button" (click)="sortOfflineMaps('lastModified')">Last modified {{ offlineMapSortIndicator('lastModified') }}</span></th><th class="offline-file-status-column">Status</th><th class="mbtiles-updates-column"><span class="table-sort-button" (click)="sortOfflineMaps('updates')">Updates {{ offlineMapSortIndicator('updates') }}</span></th><th><span class="table-sort-button" (click)="sortOfflineMaps('bounds')">Bounds {{ offlineMapSortIndicator('bounds') }}</span></th><th><span class="table-sort-button" (click)="sortOfflineMaps('zoom')">Zoom {{ offlineMapSortIndicator('zoom') }}</span></th><th class="offline-row-actions-column"></th></tr></thead>
                  <tbody>
                    @let duplicateIds = offlineMapDuplicateIds();
                    @let hillshadeDuplicateSet = hillshadeDuplicateIds();
                    @for (map of sortedOffline().filter(map => map.type === 'obf'); track map.id) {
                      @let inUse = isOfflineMapInUse(map);
                      <tr [class.mbtiles-map-disabled]="!map.enabled" [class.obf-map-row]="map.type === 'obf'" [class.mbtiles-map-row]="map.type !== 'obf'" [class.file-path-error]="offlineFilesChecked() && (offlineMapHasMissingFile(map) || duplicateIds.has(map.id))">
                        <td class="mbtiles-inuse-column"><span class="mbtiles-inuse-symbol" [class.in-use]="inUse" [attr.title]="inUse ? 'Currently used by the selected map source' : 'Not in use'">{{ inUse ? '●' : '—' }}</span></td>
                        <td class="mbtiles-enabled-column"><input type="checkbox" [checked]="map.enabled" [disabled]="!map.available" [title]="'Preselect offline map ' + map.name" (change)="setOfflineMapEnabled(map.id, $any($event.target).checked)" [attr.aria-label]="'Active offline map ' + map.name"></td>
                        <td class="mbtiles-type-column"><i class="offline-map-format-tag" [class.obf-format-tag]="map.type === 'obf'" [class.mbtiles-format-tag]="map.type === 'mbtiles' || !map.type" [class.mapsforge-format-tag]="map.type === 'mapsforge'">{{ offlineMapTypeLabel(map.type) }}</i></td>
                        <td class="mbtiles-map-file" [title]="map.filePath"><strong>{{ map.name }}</strong>@if (map.fileName !== map.name) { <span>{{ map.fileName }}</span> }@if (map.obfMetadataAvailable) { <span>{{ map.obfSectionCount ?? 0 }} map section(s)@if (map.obfIsBasemap) { · Basemap }</span> }</td>
                        <td class="offline-map-path-cell" [title]="map.filePath">{{ map.filePath || '—' }}</td>
                        <td class="mbtiles-map-number">{{ formatOfflineMapSize(map.fileSize) }}</td><td class="mbtiles-map-number">{{ formatOfflineMapDate(map.lastModified) }}</td>
                        <td class="offline-file-status-cell">{{ !offlineFilesChecked() ? 'Not checked' : (!map.available || !map.filePath.trim() ? 'Missing' : map.enabled ? 'Active' : 'Inactive') + (duplicateIds.has(map.id) ? ' · Duplicate' : '') }}</td>
                        <td class="mbtiles-updates-column"><span class="mbtiles-update-symbol" [class.update-available]="map.updateAvailable === true" [class.update-current]="map.updateAvailable === false" [class.update-unknown]="map.updateChecked && map.updateAvailable === null && map.updateMatched !== false" [class.update-no-match]="map.updateChecked && map.updateMatched === false" [attr.title]="map.updateAvailable === true ? 'Update available' : map.updateAvailable === false ? 'No newer version listed' : map.updateChecked ? 'No matching catalogue file' : 'Not checked yet'">{{ map.updateAvailable === true ? '↑' : map.updateAvailable === false ? '✓' : map.updateChecked && map.updateMatched === false ? '?' : '—' }}</span></td>
                        <td class="mbtiles-map-bounds" [attr.title]="obfMetadataTooltip(map)">{{ map.bounds || '—' }}</td><td class="mbtiles-map-number">{{ map.obfMetadataAvailable && map.minZoom > 0 && map.maxZoom > 0 ? map.minZoom + '–' + map.maxZoom : '—' }}</td>
                        <td class="offline-row-actions">
                          <button type="button" class="file-row-menu-trigger offline-row-menu-trigger" (click)="toggleOfflineRowActionMenu(map.filePath, $event); $event.stopPropagation()" [attr.aria-expanded]="offlineRowActionMenuOpen() === map.filePath" [attr.aria-label]="'Actions for ' + map.filePath" title="File actions">☰</button>
                          @if (offlineRowActionMenuOpen() === map.filePath) {
                            <div class="gpx-row-action-menu offline-row-action-menu" role="menu" [style.top.px]="offlineRowActionMenuPosition().top" [style.left.px]="offlineRowActionMenuPosition().left" (click)="$event.stopPropagation()">
                              <button type="button" role="menuitem" (click)="copyOfflineFolder(map.filePath, false); offlineRowActionMenuOpen.set(null)"><span aria-hidden="true">⧉</span> Copy folder path</button>
                              <button type="button" role="menuitem" (click)="openOfflineFolder(map.filePath, false); offlineRowActionMenuOpen.set(null)"><span aria-hidden="true">📂</span> Open path</button>
                              <button type="button" role="menuitem" (click)="openOfflineFileWith(map.filePath); offlineRowActionMenuOpen.set(null)" ><span aria-hidden="true">↗</span> Open file</button>
                              <div class="gpx-row-action-menu-separator" role="separator"></div>
                              <button type="button" role="menuitem" (click)="setAllOfflineEnabled(true); offlineRowActionMenuOpen.set(null)" [disabled]="!hasVisibleOfflineFiles()"><span aria-hidden="true">✓</span> Activate visible files</button>
                              <button type="button" role="menuitem" (click)="setAllOfflineEnabled(false); offlineRowActionMenuOpen.set(null)" [disabled]="!hasVisibleOfflineFiles()"><span aria-hidden="true">×</span> Deactivate visible files</button>
                              <button type="button" role="menuitem" (click)="setAllOfflineEnabled(true, false); offlineRowActionMenuOpen.set(null)" [disabled]="!hasAllOfflineFiles()"><span aria-hidden="true">✓✓</span> Activate all files</button>
                              <button type="button" role="menuitem" (click)="setAllOfflineEnabled(false, false); offlineRowActionMenuOpen.set(null)" [disabled]="!hasAllOfflineFiles()"><span aria-hidden="true">××</span> Deactivate all files</button>
                            </div>
                          }
                        </td>
                      </tr>
                    }
                    @for (entry of filteredResourcePackageEntries().filter(entry => entry.type === 'osmand-resources'); track entry.type + '|' + entry.path + '|' + entry.fileName) {
                      <tr class="resource-package-entry-row" [class.resource-valhalla-row]="entry.type === 'valhalla'" [class.resource-osmand-row]="entry.type === 'osmand-resources'" [class.resource-mapsforge-row]="entry.type === 'mapsforge-theme'">
                        <td class="mbtiles-inuse-column"><span class="mbtiles-inuse-symbol">—</span></td>
                        <td class="mbtiles-enabled-column">@if (entry.type === 'valhalla') { <input type="checkbox" [checked]="resourcePackageEntryActive(entry)" [disabled]="!resourcePackageEntryAvailable(entry) || routeConfigBusy()" (change)="$any($event.target).checked ? setActiveValhallaConfig(entry.sourcePath) : null" [attr.aria-label]="'Use ' + entry.fileName + ' as active routing configuration'"> } @else { — }</td>
                        <td class="mbtiles-type-column"><i class="offline-map-format-tag resource-package-format-tag" [class.resource-valhalla-tag]="entry.type === 'valhalla'" [class.resource-osmand-tag]="entry.type === 'osmand-resources'" [class.resource-mapsforge-tag]="entry.type === 'mapsforge-theme'">{{ resourcePackageEntryTypeLabel(entry.type) }}</i></td>
                        <td class="mbtiles-map-file" [title]="entry.fileName"><strong>{{ entry.fileName }}</strong></td>
                        <td class="offline-map-path-cell" [title]="entry.path">{{ entry.path }}</td>
                        <td class="mbtiles-map-number">{{ formatOfflineMapSize(entry.fileSize) }}</td>
                        <td class="mbtiles-map-number">—</td>
                        <td class="offline-file-status-cell">External resource</td>
                        <td class="mbtiles-updates-column">—</td><td class="mbtiles-map-bounds">—</td><td class="mbtiles-map-number">—</td>
                        <td class="offline-row-actions">
                          <button type="button" class="file-row-menu-trigger offline-row-menu-trigger" (click)="toggleOfflineRowActionMenu(entry.path, $event); $event.stopPropagation()" [attr.aria-expanded]="offlineRowActionMenuOpen() === entry.path" [attr.aria-label]="'Actions for ' + entry.path" title="File actions">☰</button>
                          @if (offlineRowActionMenuOpen() === entry.path) {
                            <div class="gpx-row-action-menu offline-row-action-menu" role="menu" [style.top.px]="offlineRowActionMenuPosition().top" [style.left.px]="offlineRowActionMenuPosition().left" (click)="$event.stopPropagation()">
                              <button type="button" role="menuitem" (click)="copyOfflineFolder(entry.path, true); offlineRowActionMenuOpen.set(null)"><span aria-hidden="true">⧉</span> Copy folder path</button>
                              <button type="button" role="menuitem" (click)="openOfflineFolder(entry.path, true); offlineRowActionMenuOpen.set(null)"><span aria-hidden="true">📂</span> Open path</button>
                              <button type="button" role="menuitem" (click)="openOfflineFileWith(entry.sourcePath); offlineRowActionMenuOpen.set(null)" [disabled]="entry.type === 'osmand-resources'"><span aria-hidden="true">↗</span> Open file</button>
                              <div class="gpx-row-action-menu-separator" role="separator"></div>
                              <button type="button" role="menuitem" (click)="setAllOfflineEnabled(true); offlineRowActionMenuOpen.set(null)" [disabled]="!hasVisibleOfflineFiles()"><span aria-hidden="true">✓</span> Activate visible files</button>
                              <button type="button" role="menuitem" (click)="setAllOfflineEnabled(false); offlineRowActionMenuOpen.set(null)" [disabled]="!hasVisibleOfflineFiles()"><span aria-hidden="true">×</span> Deactivate visible files</button>
                              <button type="button" role="menuitem" (click)="setAllOfflineEnabled(true, false); offlineRowActionMenuOpen.set(null)" [disabled]="!hasAllOfflineFiles()"><span aria-hidden="true">✓✓</span> Activate all files</button>
                              <button type="button" role="menuitem" (click)="setAllOfflineEnabled(false, false); offlineRowActionMenuOpen.set(null)" [disabled]="!hasAllOfflineFiles()"><span aria-hidden="true">××</span> Deactivate all files</button>
                            </div>
                          }
                        </td>
                      </tr>
                    }
                    @for (map of sortedOffline().filter(map => map.type === 'mapsforge'); track map.id) {
                      @let inUse = isOfflineMapInUse(map);
                      <tr [class.mbtiles-map-disabled]="!map.enabled" [class.obf-map-row]="map.type === 'obf'" [class.mbtiles-map-row]="map.type !== 'obf'" [class.file-path-error]="offlineFilesChecked() && (offlineMapHasMissingFile(map) || duplicateIds.has(map.id))">
                        <td class="mbtiles-inuse-column"><span class="mbtiles-inuse-symbol" [class.in-use]="inUse" [attr.title]="inUse ? 'Currently used by the selected map source' : 'Not in use'">{{ inUse ? '●' : '—' }}</span></td>
                        <td class="mbtiles-enabled-column"><input type="checkbox" [checked]="map.enabled" [disabled]="!map.available" [title]="'Preselect offline map ' + map.name" (change)="setOfflineMapEnabled(map.id, $any($event.target).checked)" [attr.aria-label]="'Active offline map ' + map.name"></td>
                        <td class="mbtiles-type-column"><i class="offline-map-format-tag" [class.obf-format-tag]="map.type === 'obf'" [class.mbtiles-format-tag]="map.type === 'mbtiles' || !map.type" [class.mapsforge-format-tag]="map.type === 'mapsforge'">{{ offlineMapTypeLabel(map.type) }}</i></td>
                        <td class="mbtiles-map-file" [title]="map.filePath"><strong>{{ map.name }}</strong>@if (map.fileName !== map.name) { <span>{{ map.fileName }}</span> }</td>
                        <td class="offline-map-path-cell" [title]="map.filePath">{{ map.filePath || '—' }}</td>
                        <td class="mbtiles-map-number">{{ formatOfflineMapSize(map.fileSize) }}</td><td class="mbtiles-map-number">{{ formatOfflineMapDate(map.lastModified) }}</td>
                        <td class="offline-file-status-cell">{{ !offlineFilesChecked() ? 'Not checked' : (!map.available || !map.filePath.trim() ? 'Missing' : map.enabled ? 'Active' : 'Inactive') + (duplicateIds.has(map.id) ? ' · Duplicate' : '') }}</td>
                        <td class="mbtiles-updates-column"><span class="mbtiles-update-symbol" [class.update-available]="map.updateAvailable === true" [class.update-current]="map.updateAvailable === false" [class.update-unknown]="map.updateChecked && map.updateAvailable === null && map.updateMatched !== false" [class.update-no-match]="map.updateChecked && map.updateMatched === false" [attr.title]="map.updateAvailable === true ? 'Update available' : map.updateAvailable === false ? 'No newer version listed' : map.updateChecked ? 'No matching catalogue file' : 'Not checked yet'">{{ map.updateAvailable === true ? '↑' : map.updateAvailable === false ? '✓' : map.updateChecked && map.updateMatched === false ? '?' : '—' }}</span></td>
                        <td class="mbtiles-map-bounds">{{ map.bounds }}</td><td class="mbtiles-map-number">{{ map.minZoom }}–{{ map.maxZoom }}</td>
                        <td class="offline-row-actions">
                          <button type="button" class="file-row-menu-trigger offline-row-menu-trigger" (click)="toggleOfflineRowActionMenu(map.filePath, $event); $event.stopPropagation()" [attr.aria-expanded]="offlineRowActionMenuOpen() === map.filePath" [attr.aria-label]="'Actions for ' + map.filePath" title="File actions">☰</button>
                          @if (offlineRowActionMenuOpen() === map.filePath) {
                            <div class="gpx-row-action-menu offline-row-action-menu" role="menu" [style.top.px]="offlineRowActionMenuPosition().top" [style.left.px]="offlineRowActionMenuPosition().left" (click)="$event.stopPropagation()">
                              <button type="button" role="menuitem" (click)="copyOfflineFolder(map.filePath, false); offlineRowActionMenuOpen.set(null)"><span aria-hidden="true">⧉</span> Copy folder path</button>
                              <button type="button" role="menuitem" (click)="openOfflineFolder(map.filePath, false); offlineRowActionMenuOpen.set(null)"><span aria-hidden="true">📂</span> Open path</button>
                              <button type="button" role="menuitem" (click)="openOfflineFileWith(map.filePath); offlineRowActionMenuOpen.set(null)" ><span aria-hidden="true">↗</span> Open file</button>
                              <div class="gpx-row-action-menu-separator" role="separator"></div>
                              <button type="button" role="menuitem" (click)="setAllOfflineEnabled(true); offlineRowActionMenuOpen.set(null)" [disabled]="!hasVisibleOfflineFiles()"><span aria-hidden="true">✓</span> Activate visible files</button>
                              <button type="button" role="menuitem" (click)="setAllOfflineEnabled(false); offlineRowActionMenuOpen.set(null)" [disabled]="!hasVisibleOfflineFiles()"><span aria-hidden="true">×</span> Deactivate visible files</button>
                              <button type="button" role="menuitem" (click)="setAllOfflineEnabled(true, false); offlineRowActionMenuOpen.set(null)" [disabled]="!hasAllOfflineFiles()"><span aria-hidden="true">✓✓</span> Activate all files</button>
                              <button type="button" role="menuitem" (click)="setAllOfflineEnabled(false, false); offlineRowActionMenuOpen.set(null)" [disabled]="!hasAllOfflineFiles()"><span aria-hidden="true">××</span> Deactivate all files</button>
                            </div>
                          }
                        </td>
                      </tr>
                    }
                    @for (entry of filteredResourcePackageEntries().filter(entry => entry.type === 'mapsforge-theme'); track entry.type + '|' + entry.path + '|' + entry.fileName) {
                      <tr class="resource-package-entry-row" [class.resource-valhalla-row]="entry.type === 'valhalla'" [class.resource-osmand-row]="entry.type === 'osmand-resources'" [class.resource-mapsforge-row]="entry.type === 'mapsforge-theme'">
                        <td class="mbtiles-inuse-column"><span class="mbtiles-inuse-symbol">—</span></td>
                        <td class="mbtiles-enabled-column">@if (entry.type === 'valhalla') { <input type="checkbox" [checked]="resourcePackageEntryActive(entry)" [disabled]="!resourcePackageEntryAvailable(entry) || routeConfigBusy()" (change)="$any($event.target).checked ? setActiveValhallaConfig(entry.sourcePath) : null" [attr.aria-label]="'Use ' + entry.fileName + ' as active routing configuration'"> } @else { — }</td>
                        <td class="mbtiles-type-column"><i class="offline-map-format-tag resource-package-format-tag" [class.resource-valhalla-tag]="entry.type === 'valhalla'" [class.resource-osmand-tag]="entry.type === 'osmand-resources'" [class.resource-mapsforge-tag]="entry.type === 'mapsforge-theme'">{{ resourcePackageEntryTypeLabel(entry.type) }}</i></td>
                        <td class="mbtiles-map-file" [title]="entry.fileName"><strong>{{ entry.fileName }}</strong></td>
                        <td class="offline-map-path-cell" [title]="entry.path">{{ entry.path }}</td>
                        <td class="mbtiles-map-number">{{ formatOfflineMapSize(entry.fileSize) }}</td>
                        <td class="mbtiles-map-number">—</td>
                        <td class="offline-file-status-cell">External resource</td>
                        <td class="mbtiles-updates-column">—</td><td class="mbtiles-map-bounds">—</td><td class="mbtiles-map-number">—</td>
                        <td class="offline-row-actions">
                          <button type="button" class="file-row-menu-trigger offline-row-menu-trigger" (click)="toggleOfflineRowActionMenu(entry.path, $event); $event.stopPropagation()" [attr.aria-expanded]="offlineRowActionMenuOpen() === entry.path" [attr.aria-label]="'Actions for ' + entry.path" title="File actions">☰</button>
                          @if (offlineRowActionMenuOpen() === entry.path) {
                            <div class="gpx-row-action-menu offline-row-action-menu" role="menu" [style.top.px]="offlineRowActionMenuPosition().top" [style.left.px]="offlineRowActionMenuPosition().left" (click)="$event.stopPropagation()">
                              <button type="button" role="menuitem" (click)="copyOfflineFolder(entry.path, true); offlineRowActionMenuOpen.set(null)"><span aria-hidden="true">⧉</span> Copy folder path</button>
                              <button type="button" role="menuitem" (click)="openOfflineFolder(entry.path, true); offlineRowActionMenuOpen.set(null)"><span aria-hidden="true">📂</span> Open path</button>
                              <button type="button" role="menuitem" (click)="openOfflineFileWith(entry.sourcePath); offlineRowActionMenuOpen.set(null)" [disabled]="entry.type === 'osmand-resources'"><span aria-hidden="true">↗</span> Open file</button>
                              <div class="gpx-row-action-menu-separator" role="separator"></div>
                              <button type="button" role="menuitem" (click)="setAllOfflineEnabled(true); offlineRowActionMenuOpen.set(null)" [disabled]="!hasVisibleOfflineFiles()"><span aria-hidden="true">✓</span> Activate visible files</button>
                              <button type="button" role="menuitem" (click)="setAllOfflineEnabled(false); offlineRowActionMenuOpen.set(null)" [disabled]="!hasVisibleOfflineFiles()"><span aria-hidden="true">×</span> Deactivate visible files</button>
                              <button type="button" role="menuitem" (click)="setAllOfflineEnabled(true, false); offlineRowActionMenuOpen.set(null)" [disabled]="!hasAllOfflineFiles()"><span aria-hidden="true">✓✓</span> Activate all files</button>
                              <button type="button" role="menuitem" (click)="setAllOfflineEnabled(false, false); offlineRowActionMenuOpen.set(null)" [disabled]="!hasAllOfflineFiles()"><span aria-hidden="true">××</span> Deactivate all files</button>
                            </div>
                          }
                        </td>
                      </tr>
                    }
                    @for (map of sortedOffline().filter(map => map.type !== 'obf' && map.type !== 'mapsforge'); track map.id) {
                      @let inUse = isOfflineMapInUse(map);
                      <tr [class.mbtiles-map-disabled]="!map.enabled" [class.obf-map-row]="map.type === 'obf'" [class.mbtiles-map-row]="map.type !== 'obf'" [class.file-path-error]="offlineFilesChecked() && (offlineMapHasMissingFile(map) || duplicateIds.has(map.id))">
                        <td class="mbtiles-inuse-column"><span class="mbtiles-inuse-symbol" [class.in-use]="inUse" [attr.title]="inUse ? 'Currently used by the selected map source' : 'Not in use'">{{ inUse ? '●' : '—' }}</span></td>
                        <td class="mbtiles-enabled-column"><input type="checkbox" [checked]="map.enabled" [disabled]="!map.available" [title]="'Preselect offline map ' + map.name" (change)="setOfflineMapEnabled(map.id, $any($event.target).checked)" [attr.aria-label]="'Active offline map ' + map.name"></td>
                        <td class="mbtiles-type-column"><i class="offline-map-format-tag" [class.obf-format-tag]="map.type === 'obf'" [class.mbtiles-format-tag]="map.type === 'mbtiles' || !map.type" [class.mapsforge-format-tag]="map.type === 'mapsforge'">{{ offlineMapTypeLabel(map.type) }}</i></td>
                        <td class="mbtiles-map-file" [title]="map.filePath"><strong>{{ map.name }}</strong>@if (map.fileName !== map.name) { <span>{{ map.fileName }}</span> }</td>
                        <td class="offline-map-path-cell" [title]="map.filePath">{{ map.filePath || '—' }}</td>
                        <td class="mbtiles-map-number">{{ formatOfflineMapSize(map.fileSize) }}</td><td class="mbtiles-map-number">{{ formatOfflineMapDate(map.lastModified) }}</td>
                        <td class="offline-file-status-cell">{{ !offlineFilesChecked() ? 'Not checked' : (!map.available || !map.filePath.trim() ? 'Missing' : map.enabled ? 'Active' : 'Inactive') + (duplicateIds.has(map.id) ? ' · Duplicate' : '') }}</td>
                        <td class="mbtiles-updates-column"><span class="mbtiles-update-symbol" [class.update-available]="map.updateAvailable === true" [class.update-current]="map.updateAvailable === false" [class.update-unknown]="map.updateChecked && map.updateAvailable === null && map.updateMatched !== false" [class.update-no-match]="map.updateChecked && map.updateMatched === false" [attr.title]="map.updateAvailable === true ? 'Update available' : map.updateAvailable === false ? 'No newer version listed' : map.updateChecked ? 'No matching catalogue file' : 'Not checked yet'">{{ map.updateAvailable === true ? '↑' : map.updateAvailable === false ? '✓' : map.updateChecked && map.updateMatched === false ? '?' : '—' }}</span></td>
                        <td class="mbtiles-map-bounds">{{ map.bounds }}</td><td class="mbtiles-map-number">{{ map.minZoom }}–{{ map.maxZoom }}</td>
                        <td class="offline-row-actions">
                          <button type="button" class="file-row-menu-trigger offline-row-menu-trigger" (click)="toggleOfflineRowActionMenu(map.filePath, $event); $event.stopPropagation()" [attr.aria-expanded]="offlineRowActionMenuOpen() === map.filePath" [attr.aria-label]="'Actions for ' + map.filePath" title="File actions">☰</button>
                          @if (offlineRowActionMenuOpen() === map.filePath) {
                            <div class="gpx-row-action-menu offline-row-action-menu" role="menu" [style.top.px]="offlineRowActionMenuPosition().top" [style.left.px]="offlineRowActionMenuPosition().left" (click)="$event.stopPropagation()">
                              <button type="button" role="menuitem" (click)="copyOfflineFolder(map.filePath, false); offlineRowActionMenuOpen.set(null)"><span aria-hidden="true">⧉</span> Copy folder path</button>
                              <button type="button" role="menuitem" (click)="openOfflineFolder(map.filePath, false); offlineRowActionMenuOpen.set(null)"><span aria-hidden="true">📂</span> Open path</button>
                              <button type="button" role="menuitem" (click)="openOfflineFileWith(map.filePath); offlineRowActionMenuOpen.set(null)" ><span aria-hidden="true">↗</span> Open file</button>
                              <div class="gpx-row-action-menu-separator" role="separator"></div>
                              <button type="button" role="menuitem" (click)="setAllOfflineEnabled(true); offlineRowActionMenuOpen.set(null)" [disabled]="!hasVisibleOfflineFiles()"><span aria-hidden="true">✓</span> Activate visible files</button>
                              <button type="button" role="menuitem" (click)="setAllOfflineEnabled(false); offlineRowActionMenuOpen.set(null)" [disabled]="!hasVisibleOfflineFiles()"><span aria-hidden="true">×</span> Deactivate visible files</button>
                              <button type="button" role="menuitem" (click)="setAllOfflineEnabled(true, false); offlineRowActionMenuOpen.set(null)" [disabled]="!hasAllOfflineFiles()"><span aria-hidden="true">✓✓</span> Activate all files</button>
                              <button type="button" role="menuitem" (click)="setAllOfflineEnabled(false, false); offlineRowActionMenuOpen.set(null)" [disabled]="!hasAllOfflineFiles()"><span aria-hidden="true">××</span> Deactivate all files</button>
                            </div>
                          }
                        </td>
                      </tr>
                    }
                    @for (database of sortedHillshadeDatabases(); track database.id) {
                      <tr class="hillshade-map-row" [class.mbtiles-map-disabled]="!database.enabled || !database.available" [class.file-path-error]="offlineFilesChecked() && (!database.path.trim() || !database.available || hillshadeDuplicateSet.has(database.id))">
                        <td class="mbtiles-inuse-column"><span class="mbtiles-inuse-symbol">—</span></td>
                        <td class="mbtiles-enabled-column"><input type="checkbox" [checked]="database.enabled" [disabled]="!database.available" (change)="setHillshadeDatabaseEnabled(database.id, $any($event.target).checked)" [attr.aria-label]="'Active Hillshade database ' + database.path"></td>
                        <td class="mbtiles-type-column"><i class="offline-map-format-tag hillshade-format-tag">Hillshade (.sqlitedb)</i></td>
                        <td class="mbtiles-map-file" [title]="database.path"><strong>{{ hillshadeDatabaseFileName(database.path) }}</strong></td>
                        <td class="offline-map-path-cell" [title]="database.path">{{ database.path || '—' }}</td>
                        <td class="mbtiles-map-number">{{ database.sizeBytes === null ? '—' : formatOfflineMapSize(database.sizeBytes) }}</td>
                        <td>{{ formatHillshadeLastModified(database.lastModified) }}</td><td class="offline-file-status-cell">{{ !offlineFilesChecked() ? 'Not checked' : (!database.available || !database.path.trim() ? 'Missing' : database.enabled ? 'Active' : 'Inactive') + (hillshadeDuplicateSet.has(database.id) ? ' · Duplicate' : '') }}</td><td class="mbtiles-updates-column">—</td><td class="mbtiles-map-bounds">—</td><td class="mbtiles-map-number">—</td>
                        <td class="offline-row-actions">
                          <button type="button" class="file-row-menu-trigger offline-row-menu-trigger" (click)="toggleOfflineRowActionMenu(database.path, $event); $event.stopPropagation()" [attr.aria-expanded]="offlineRowActionMenuOpen() === database.path" [attr.aria-label]="'Actions for ' + database.path" title="File actions">☰</button>
                          @if (offlineRowActionMenuOpen() === database.path) {
                            <div class="gpx-row-action-menu offline-row-action-menu" role="menu" [style.top.px]="offlineRowActionMenuPosition().top" [style.left.px]="offlineRowActionMenuPosition().left" (click)="$event.stopPropagation()">
                              <button type="button" role="menuitem" (click)="copyOfflineFolder(database.path, false); offlineRowActionMenuOpen.set(null)"><span aria-hidden="true">⧉</span> Copy folder path</button>
                              <button type="button" role="menuitem" (click)="openOfflineFolder(database.path, false); offlineRowActionMenuOpen.set(null)"><span aria-hidden="true">📂</span> Open path</button>
                              <button type="button" role="menuitem" (click)="openOfflineFileWith(database.path); offlineRowActionMenuOpen.set(null)" ><span aria-hidden="true">↗</span> Open file</button>
                              <div class="gpx-row-action-menu-separator" role="separator"></div>
                              <button type="button" role="menuitem" (click)="setAllOfflineEnabled(true); offlineRowActionMenuOpen.set(null)" [disabled]="!hasVisibleOfflineFiles()"><span aria-hidden="true">✓</span> Activate visible files</button>
                              <button type="button" role="menuitem" (click)="setAllOfflineEnabled(false); offlineRowActionMenuOpen.set(null)" [disabled]="!hasVisibleOfflineFiles()"><span aria-hidden="true">×</span> Deactivate visible files</button>
                              <button type="button" role="menuitem" (click)="setAllOfflineEnabled(true, false); offlineRowActionMenuOpen.set(null)" [disabled]="!hasAllOfflineFiles()"><span aria-hidden="true">✓✓</span> Activate all files</button>
                              <button type="button" role="menuitem" (click)="setAllOfflineEnabled(false, false); offlineRowActionMenuOpen.set(null)" [disabled]="!hasAllOfflineFiles()"><span aria-hidden="true">××</span> Deactivate all files</button>
                            </div>
                          }
                        </td>
                      </tr>
                    }
                    @for (entry of filteredResourcePackageEntries().filter(entry => entry.type === 'valhalla'); track entry.type + '|' + entry.path + '|' + entry.fileName) {
                      <tr class="resource-package-entry-row" [class.resource-valhalla-row]="entry.type === 'valhalla'" [class.resource-osmand-row]="entry.type === 'osmand-resources'" [class.resource-mapsforge-row]="entry.type === 'mapsforge-theme'">
                        <td class="mbtiles-inuse-column"><span class="mbtiles-inuse-symbol">—</span></td>
                        <td class="mbtiles-enabled-column">@if (entry.type === 'valhalla') { <input type="checkbox" [checked]="resourcePackageEntryActive(entry)" [disabled]="!resourcePackageEntryAvailable(entry) || routeConfigBusy()" (change)="$any($event.target).checked ? setActiveValhallaConfig(entry.sourcePath) : null" [attr.aria-label]="'Use ' + entry.fileName + ' as active routing configuration'"> } @else { — }</td>
                        <td class="mbtiles-type-column"><i class="offline-map-format-tag resource-package-format-tag" [class.resource-valhalla-tag]="entry.type === 'valhalla'" [class.resource-osmand-tag]="entry.type === 'osmand-resources'" [class.resource-mapsforge-tag]="entry.type === 'mapsforge-theme'">{{ resourcePackageEntryTypeLabel(entry.type) }}</i></td>
                        <td class="mbtiles-map-file" [title]="entry.fileName"><strong>{{ entry.fileName }}</strong></td>
                        <td class="offline-map-path-cell" [title]="entry.path">{{ entry.path }}</td>
                        <td class="mbtiles-map-number">{{ formatOfflineMapSize(entry.fileSize) }}</td>
                        <td class="mbtiles-map-number">—</td>
                        <td class="offline-file-status-cell">External resource</td>
                        <td class="mbtiles-updates-column">—</td><td class="mbtiles-map-bounds">—</td><td class="mbtiles-map-number">—</td>
                        <td class="offline-row-actions">
                          <button type="button" class="file-row-menu-trigger offline-row-menu-trigger" (click)="toggleOfflineRowActionMenu(entry.path, $event); $event.stopPropagation()" [attr.aria-expanded]="offlineRowActionMenuOpen() === entry.path" [attr.aria-label]="'Actions for ' + entry.path" title="File actions">☰</button>
                          @if (offlineRowActionMenuOpen() === entry.path) {
                            <div class="gpx-row-action-menu offline-row-action-menu" role="menu" [style.top.px]="offlineRowActionMenuPosition().top" [style.left.px]="offlineRowActionMenuPosition().left" (click)="$event.stopPropagation()">
                              <button type="button" role="menuitem" (click)="copyOfflineFolder(entry.path, true); offlineRowActionMenuOpen.set(null)"><span aria-hidden="true">⧉</span> Copy folder path</button>
                              <button type="button" role="menuitem" (click)="openOfflineFolder(entry.path, true); offlineRowActionMenuOpen.set(null)"><span aria-hidden="true">📂</span> Open path</button>
                              <button type="button" role="menuitem" (click)="openOfflineFileWith(entry.sourcePath); offlineRowActionMenuOpen.set(null)" [disabled]="entry.type === 'osmand-resources'"><span aria-hidden="true">↗</span> Open file</button>
                              <div class="gpx-row-action-menu-separator" role="separator"></div>
                              <button type="button" role="menuitem" (click)="setAllOfflineEnabled(true); offlineRowActionMenuOpen.set(null)" [disabled]="!hasVisibleOfflineFiles()"><span aria-hidden="true">✓</span> Activate visible files</button>
                              <button type="button" role="menuitem" (click)="setAllOfflineEnabled(false); offlineRowActionMenuOpen.set(null)" [disabled]="!hasVisibleOfflineFiles()"><span aria-hidden="true">×</span> Deactivate visible files</button>
                              <button type="button" role="menuitem" (click)="setAllOfflineEnabled(true, false); offlineRowActionMenuOpen.set(null)" [disabled]="!hasAllOfflineFiles()"><span aria-hidden="true">✓✓</span> Activate all files</button>
                              <button type="button" role="menuitem" (click)="setAllOfflineEnabled(false, false); offlineRowActionMenuOpen.set(null)" [disabled]="!hasAllOfflineFiles()"><span aria-hidden="true">××</span> Deactivate all files</button>
                            </div>
                          }
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              } @else { <span class="offline-map-status">No offline files loaded. Use “Open resource package…” to discover files.</span> }
              @for (error of offlineMapImportErrors(); track $index) { <span class="offline-map-import-error">{{ error }}</span> }
            </div>
            @if (obfBoundsPreview(); as preview) {
              <section class="obf-bounds-preview" aria-label="Activated OBF map bounds preview">
                <div class="obf-bounds-preview-heading">
                  <strong>Activated OBF bounds · {{ preview.name }}</strong>
                  <span>{{ preview.bounds || preview.error || 'Bounds unavailable' }}@if (preview.zoom) { · Zoom {{ preview.zoom }} }</span>
                </div>
                <div class="obf-bounds-map-grid">
                  <div class="obf-bounds-map-panel">
                    <strong>World</strong>
                    <svg class="obf-bounds-world-map" [class.is-panning]="boundsMapIsPanning('world')" [attr.viewBox]="boundsMapViewBox('world')" role="img" [attr.aria-label]="'World map showing bounds for ' + preview.name"
                         (wheel)="zoomBoundsMap($event, 'world')" (pointerdown)="startBoundsMapPan($event, 'world')"
                         (pointermove)="moveBoundsMapPan($event)" (pointerup)="endBoundsMapPan($event)" (pointercancel)="endBoundsMapPan($event)">
                      <image href="world-map.svg" x="0" y="0" width="360" height="180" preserveAspectRatio="none"></image>
                      @for (rectangle of preview.rectangles; track $index) {
                        <rect [attr.x]="rectangle.x" [attr.y]="rectangle.y" [attr.width]="rectangle.width" [attr.height]="rectangle.height"
                              fill="#ffad33" fill-opacity=".34" stroke="#ffad33" stroke-width="1.4"></rect>
                      }
                    </svg>
                  </div>
                  <div class="obf-bounds-map-panel">
                    <strong>Europe</strong>
                    <svg class="obf-bounds-europe-map" [class.is-panning]="boundsMapIsPanning('europe')" [attr.viewBox]="boundsMapViewBox('europe')" role="img" [attr.aria-label]="'Europe map showing bounds for ' + preview.name"
                         (wheel)="zoomBoundsMap($event, 'europe')" (pointerdown)="startBoundsMapPan($event, 'europe')"
                         (pointermove)="moveBoundsMapPan($event)" (pointerup)="endBoundsMapPan($event)" (pointercancel)="endBoundsMapPan($event)">
                      <image href="world-map.svg" x="0" y="0" width="2000" height="1001" preserveAspectRatio="none"></image>
                      @for (rectangle of preview.rectangles; track $index) {
                        <rect [attr.x]="rectangle.x * 5.5555556" [attr.y]="rectangle.y * 5.5611111"
                              [attr.width]="rectangle.width * 5.5555556" [attr.height]="rectangle.height * 5.5611111"
                              fill="#ffad33" fill-opacity=".34" stroke="#ffad33" stroke-width="1.8"></rect>
                      }
                    </svg>
                  </div>
                </div>
              </section>
            }
              <details class="map-cache-section offline-map-updates-section app-disclosure">
                <summary class="map-cache-heading">Checks</summary>
                <div class="map-cache-actions offline-map-update-actions">
                  <button type="button" class="offline-map-add-button" (click)="checkOffline()" [disabled]="offlineFilesCheckBusy() || resourcePackageScanBusy()">{{ offlineFilesCheckBusy() ? 'Checking…' : 'Check' }}</button>
                  <span class="offline-map-status" role="status">{{ offlineFilesCheckStatus() || 'Check file availability, missing files, duplicates and active selections.' }}</span>
                </div>
                <div class="map-cache-actions offline-map-update-actions">
                  <button type="button" class="offline-map-add-button" (click)="checkForOfflineMapUpdates()" [disabled]="offlineMaps().length === 0 || offlineMapUpdateCheckBusy()">{{ offlineMapUpdateCheckBusy() ? 'Checking…' : 'Check for updates' }}</button>
                  <span class="offline-map-status" role="status">{{ offlineMapUpdateCheckStatus() || offlineMapCatalogueSummary() }}</span>
                </div>
                <div class="map-cache-actions offline-map-update-actions">
                <span class="offline-map-status" role="status">{{ offlineMaps().length + hillshadeDatabases().length + resourcePackageEntries().length + ' offline file(s) loaded · ' + (activeOfflineMapCount() + activeHillshadeDatabaseCount()) + ' active · ' + inUseOfflineMapCount() + ' in use · ' + (filteredOffline().length + filteredHillshadeDatabases().length + filteredResourcePackageEntries().length) + ' filtered' }}@if (offlineMapMissingCount() + hillshadeMissingCount() > 0) { · {{ offlineMapMissingCount() + hillshadeMissingCount() }} missing - FILES MISSING }@if (offlineMapDuplicateCount() + hillshadeDuplicateCount() > 0) { · {{ offlineMapDuplicateCount() + hillshadeDuplicateCount() }} duplicate - FILES DUPLICATE }
                @if (coordinatesAvailable() && mapSource() === 'offline' && !activeOfflineMapId()) { · No offline map covers this location; using the online map }
                </span>
                </div>
              </details>
          </div>
        }
        <div class="map-viewport" [class.map-hidden]="settingsOpen() && activeSettingsTab() === 'offlineMaps'">
          <div #map class="map" [style.opacity]="overlayMode ? overlayOpacity() / 100 : 1"></div>
          @if (gpxVisible() && gpxSpeedLegendTracks().length > 0) {
            <div class="gpx-speed-map-legend" aria-label="GPX track color legends">
              @for (track of gpxSpeedLegendTracks(); track track.path) {
                <div class="gpx-speed-legend">
                  <strong>{{ track.name }}</strong>
                  <span class="gpx-speed-gradient" [style.background]="gpxPreviewGradient(track)"></span>
                  <span>{{ track.colorMode === 'elevation' ? (track.elevationMinM ?? 0) + '–' + (track.elevationMaxM ?? 3000) + ' m' : (track.speedMinKmh ?? 0) + '–' + (track.speedMaxKmh ?? 120) + ' km/h' }}</span><span class="gpx-speed-no-data" [title]="track.colorMode === 'elevation' ? 'Segments without elevation data' : 'Segments without usable timestamps'">{{ track.colorMode === 'elevation' ? 'No elevation' : 'No time' }}</span>
                </div>
              }
            </div>
          }
          @if (fixLocationEnabled()) { <div class="map-fix-crosshair" aria-hidden="true"><span></span></div> }
        </div>
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

  changeDetection: ChangeDetectionStrategy.OnPush
})
export class MapWindow implements OnInit, OnDestroy {
  readonly locale = navigator.language;
  protected readonly offlineMapTypeLabels = {
    mbtiles: 'MBTiles (.mbtiles)',
    obf: 'OsmAnd (.obf)',
    mapsforge: 'MapsForge (.map)',
    hillshade: 'Hillshade (.sqlitedb)'
  } as const;
  protected readonly offlineMapTypeLabel = (type?: string): string =>
    this.offlineMapTypeLabels[type === 'obf' ? 'obf' : type === 'mapsforge' || type === 'map' ? 'mapsforge' : type === 'hillshade' ? 'hillshade' : 'mbtiles'];

  private readonly route = inject(ActivatedRoute);
  private readonly galleryLocations = inject(GalleryLocations);
  protected readonly favoriteGpxDatabaseKeys = signal<string[]>([]);
  protected readonly favoriteGpxDatabaseKeysReady = signal(false);
  private favoriteLocationsUnsubscribe: (() => void) | null = null;
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
  private currentFolderPath: string | null = null;
  get currentImageDatabaseKey(): string | undefined { return (this.currentImagePath ?? this.currentFolderPath)?.slice(0, 2); }
  private currentOfflineMapId: string | null = null;
  private markerScanGeneration = 0;
  private leaflet: LeafletMapApi | null = null;
  private leafletHillshadeLayer: LeafletGridLayer | null = null;
  private leafletHillshadePane: HTMLElement | null = null;
  private readonly desktop = (window as unknown as { desktop?: Desktop }).desktop;
  private readonly configuration = inject(Configuration);
  private unsubscribeLocation: (() => void) | null = null;
  private locationUpdateVersion = 0;
  private locationLookupVersion = 0;
  private mapInitialization: Promise<void> | null = null;
  private mapWindowConfigRestore: Promise<void> = Promise.resolve();
  private rendererTransition: Promise<void> = Promise.resolve();
  private mapSourceGeneration = 0;
  private osmAndStyleChangeGeneration = 0;
  private osmAndStyleRestore: Promise<void> = Promise.resolve();
  private tileLayer: LeafletTileLayer | null = null;
  private mapBoundsLayers: Array<{ remove(): void }> = [];
  private trackLayers: Array<{ remove(): void }> = [];
  private gpxSegments: [number, number][][] = [];
  protected readonly hasDirectoryPhotoMarkers = (): boolean => this.directoryPhotoMarkers.length > 0;
  private readonly gpxSegmentsByTrack = new Map<string, [number, number][][]>();
  private readonly gpxPointDataByTrack = new Map<string, GpxTrackPoint[][]>();
  private readonly gpxSpeedSegmentsCache = new Map<string, { points: GpxTrackPoint[][]; key: string; segments: Array<{ coordinates: [number, number][]; color: string }> }>();
  private directoryPhotoMarkers: Array<OfflinePhotoMarker & { gpsTimestamp?: number | null }> = [];
  private directoryPhotoTimestampMarkers: Array<OfflinePhotoMarker & { gpsTimestamp?: number | null }> = [];
  private timeSliderRangeInitialized = false;
  private readonly storagePrefix = 'mapWindow.';
  protected readonly offlineMapListMounted = signal(false);
  protected readonly selectSettingsTab = (tab: 'location' | 'fix' | 'track' | 'routing' | 'timeSlider' | 'marker' | 'view' | 'offlineMaps' | 'cache' | 'memory' | 'download' | 'errors'): void => {
    this.activeSettingsTab.set(tab);
    if (tab === 'track' && this.favoriteGpxDatabaseKeysReady()) void this.refreshLatestGpxElevationProfile();
    if (tab === 'offlineMaps') this.offlineMapListMounted.set(true);
    this.persistLocationUiState({ activeSettingsTab: tab });
    if (tab === 'memory') void this.refreshProcessMemory();
  };
  protected readonly settingsOpen = signal(false);
  protected readonly activeSettingsTab = signal<'location' | 'fix' | 'track' | 'routing' | 'timeSlider' | 'marker' | 'view' | 'offlineMaps' | 'cache' | 'memory' | 'download' | 'errors'>('location');
  protected readonly renderVisualsEnabled = signal(this.readSetting('renderVisualsEnabled', 'true') === 'true');
  protected readonly renderWorkerCount = signal(this.readNumber('renderWorkerCount', 2, 1, 4));
  protected readonly photoPreviewSize = signal(this.readNumber('photoPreviewSize', 120, 60, 240));
  protected readonly offlineRenderTasks = signal<OfflineRenderTaskStatus[]>([]);
  private offlineRenderStatusUnsubscribe: (() => void) | null = null;
  protected readonly scaleVisible = signal(this.readSetting('scaleVisible', 'true') === 'true');
  protected readonly mapBoundsVisible = signal(this.readSetting('mapBoundsVisible', 'false') === 'true');
  protected readonly optimizedObfSelectionEnabled = signal(this.readSetting('optimizedObfSelectionEnabled', 'true') === 'true');
  protected readonly canShowMapBounds = computed(() => {
    const supportedMapType = this.mapSource() === 'offline' ? 'mbtiles'
      : this.mapSource() === 'osmand' || this.mapSource() === 'osmand-atlas' ? 'obf' : null;
    return this.zoomLevel() <= 10 && supportedMapType !== null
      && this.offlineMaps().some(map => map.type === supportedMapType && map.enabled && !!map.bounds
        && !this.isWorldMapBounds(map));
  });
  protected readonly renderActiveCount = signal(0);
  protected readonly renderDisplayPending = signal(false);
  protected readonly renderTotalCount = signal(0);
  protected readonly renderProgressValue = computed(() => this.rerenderVisibleTilesBusy()
    ? this.rerenderVisibleTilesProgress().completed
    : Math.max(0, this.renderTotalCount() + this.hillshadeTotalCount()
      - this.renderActiveCount() - this.hillshadeActiveCount()));
  protected readonly renderProgressMaximum = computed(() => this.rerenderVisibleTilesBusy()
    ? Math.max(1, this.rerenderVisibleTilesProgress().total + 1)
    : Math.max(1, this.renderTotalCount() + this.hillshadeTotalCount() + 1));
  protected readonly hillshadeProgressValue = computed(() => this.hillshadeCompletedCount());
  protected readonly hillshadeProgressMaximum = computed(() =>
    Math.max(1, this.hillshadeTotalCount()));
  protected readonly opacitySectionOpen = signal(this.readSetting('opacitySectionOpen', 'true') === 'true');
  protected readonly renderSectionOpen = signal(this.readSetting('renderSectionOpen', 'false') === 'true');
  private readonly activeRenderTiles = new Set<string>();
  private readonly seenRenderTiles = new Set<string>();
  private renderDisplayFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly currentTileRequestResults = new Map<string, 'pending' | 'cached'>();
  protected readonly totalRenderTileCounts = signal({ rendered: 0, cached: 0, failed: 0 });
  protected readonly lastRenderTileCounts = signal({ rendered: 0, cached: 0, failed: 0 });
  private readonly totalRenderDurationSamples = signal<number[]>([]);
  private readonly lastRenderDurationSamples = signal<number[]>([]);
  private readonly totalRenderQueueSamples = signal<number[]>([]);
  private readonly lastRenderQueueSamples = signal<number[]>([]);
  protected readonly totalRenderTiming = computed(() => summarizeRenderDurations(this.totalRenderDurationSamples()));
  protected readonly lastRenderTiming = computed(() => summarizeRenderDurations(this.lastRenderDurationSamples()));
  protected readonly totalRenderQueueTiming = computed(() => summarizeRenderDurations(this.totalRenderQueueSamples()));
  protected readonly lastRenderQueueTiming = computed(() => summarizeRenderDurations(this.lastRenderQueueSamples()));
  protected readonly hillshadeActiveCount = signal(0);
  protected readonly hillshadeDisplayPending = signal(false);
  protected readonly hillshadeTotalCount = signal(0);
  protected readonly hillshadeCompletedCount = signal(0);
  protected readonly totalHillshadeTileCounts = signal({ rendered: 0, failed: 0 });
  protected readonly lastHillshadeTileCounts = signal({ rendered: 0, failed: 0 });
  private readonly activeHillshadeTiles = new Set<string>();
  private readonly seenHillshadeTiles = new Set<string>();
  private readonly completedHillshadeTiles = new Set<string>();
  private disclosureStateKey(section: HTMLDetailsElement): string | null {
    const panel = section.closest<HTMLElement>('.settings-tab-panel');
    const tab = panel?.dataset['settingsTab'];
    if (!tab) return null;
    const sections = Array.from(panel.querySelectorAll('details'));
    const sectionIndex = sections.indexOf(section);
    return sectionIndex < 0 ? null : tab + ':' + sectionIndex;
  }
  private restoreDisclosureStates(states: Record<string, unknown>): void {
    const panels = Array.from(document.querySelectorAll<HTMLElement>('.settings-tab-panels > .settings-tab-panel'));
    panels.forEach((panel, panelIndex) => {
      const tab = panel.dataset['settingsTab'];
      if (!tab) return;
      Array.from(panel.querySelectorAll<HTMLDetailsElement>('details')).forEach((section, sectionIndex) => {
        const stableKey = tab + ':' + sectionIndex;
        let value = states[stableKey];
        if (typeof value !== 'boolean') {
          const legacyPanelIndex = tab === 'fix' ? 0 : panelIndex > 1 ? panelIndex - 1 : panelIndex;
          const legacySectionIndex = tab === 'fix' ? sectionIndex : tab === 'location' ? sectionIndex + 2 : sectionIndex;
          value = states[legacyPanelIndex + ':' + legacySectionIndex];
        }
        if (typeof value === 'boolean') {
          section.open = value;
          if (tab === 'fix' && sectionIndex === 1) this.fixLocationSectionOpen.set(value);
        }
      });
    });
  }
  protected readonly onDisclosureStateToggle = (event: Event): void => {
    const section = event.target;
    if (!(section instanceof HTMLDetailsElement)) return;
    const key = this.disclosureStateKey(section);
    if (!key) return;
    const current = this.disclosureStates;
    current[key] = section.open;
    this.persistLocationUiState({ disclosureStates: { ...current } });
  };
  private disclosureStates: Record<string, boolean> = {};
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
  protected readonly changeMapBoundsVisible = (visible: boolean): void => {
    if (visible && !this.canShowMapBounds()) return;
    this.mapBoundsVisible.set(visible);
    this.saveSetting('mapBoundsVisible', visible);
    this.persistLocationUiState({ mapBoundsVisible: visible });
    this.applyMapBoundsVisibility();
  };
  protected readonly changeOptimizedObfSelectionEnabled = (enabled: boolean): void => {
    this.optimizedObfSelectionEnabled.set(enabled);
    this.saveSetting('optimizedObfSelectionEnabled', enabled);
    this.persistLocationUiState({ optimizedObfSelectionEnabled: enabled });
    const renderer = this.offlineRenderer;
    const source = this.mapSource();
    if (!renderer || (source !== 'osmand' && source !== 'osmand-atlas')) return;
    void this.updateActiveObfMapsForViewport(renderer, source).then(() => {
      renderer.refreshVisibleTiles();
    }).catch(error => console.warn('[OsmAnd] Could not apply OBF selection mode:', error));
  };
  private isWorldMapBounds(map: import('internal-api').OfflineMapStatus): boolean {
    const name = ((map.name || '') + ' ' + (map.fileName || '')).toLowerCase();
    if (name.includes('world')) return true;
    const values = map.bounds?.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    if (values.length !== 4 || values.some(value => !Number.isFinite(value))) return false;
    const [west, south, east, north] = values;
    const longitudeSpan = east >= west ? east - west : 360 - west + east;
    return longitudeSpan >= 300 && north - south >= 140;
  }
  private getActiveOfflineMapBounds(): Array<{ bounds: [number, number, number, number]; name: string }> {
    const supportedMapType = this.mapSource() === 'offline' ? 'mbtiles'
      : this.mapSource() === 'osmand' || this.mapSource() === 'osmand-atlas' ? 'obf' : null;
    if (!supportedMapType) return [];
    return this.offlineMaps().flatMap(map => {
      if (map.type !== supportedMapType || !map.enabled || !map.bounds || this.isWorldMapBounds(map)) return [];
      const values = map.bounds.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
      if (values.length !== 4 || values.some(value => !Number.isFinite(value))) return [];
      const [west, south, east, north] = values;
      if (west < -180 || west > 180 || east < -180 || east > 180
        || south < -90 || north > 90 || south > north) return [];
      return [{ bounds: [west, south, east, north] as [number, number, number, number], name: map.name || map.fileName || 'Unnamed map' }];
    });
  }
  private clearMapBoundsLayers(): void {
    for (const layer of this.mapBoundsLayers) {
      try { layer.remove(); } catch { /* The previous Leaflet map may already be destroyed. */ }
    }
    this.mapBoundsLayers = [];
  }
  private applyMapBoundsVisibility(): void {
    // MapLibre layer maxzoom keeps the OBF bounds visible only below zoom 10.
    const visible = this.mapBoundsVisible() && this.canShowMapBounds();
    const bounds = this.getActiveOfflineMapBounds();
    this.offlineRenderer?.setMapBoundsOverlay(bounds, visible);
    this.clearMapBoundsLayers();
    if (!visible || !this.map || !this.leaflet) return;
    for (const { bounds: [west, south, east, north], name } of bounds) {
      const segments: Array<[number, number]> = east >= west
        ? [[west, east]]
        : [[west, 180], [-180, east]];
      for (const [segmentWest, segmentEast] of segments) {
        const layer = this.leaflet.polygon([
          [south, segmentWest], [south, segmentEast],
          [north, segmentEast], [north, segmentWest]
        ], {
          color: '#ff9f1c', weight: 2, opacity: 0.95,
          fillColor: '#ff9f1c', fillOpacity: 0.22
        }).addTo(this.map);
        this.mapBoundsLayers.push(layer);
        const label = this.leaflet.marker([(south + north) / 2, (segmentWest + segmentEast) / 2], {
          icon: this.leaflet.divIcon({
            className: 'map-bounds-label',
            html: '<span>' + name.replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character] ?? character)) + '</span>',
            iconSize: [180, 24],
            iconAnchor: [90, 12]
          })
        }).addTo(this.map);
        this.mapBoundsLayers.push(label);
      }
    }  }
  protected readonly changeRenderWorkerCount = (value: string | number): void => {
    const count = Number(value);
    if (!Number.isFinite(count)) return;
    const next = Math.max(1, Math.min(4, Math.round(count)));
    this.renderWorkerCount.set(next);
    this.saveSetting('renderWorkerCount', next);
    setOfflineRenderConcurrency(next);
  };
  protected readonly changePhotoPreviewSize = (value: string | number): void => {
    const size = Number(value);
    if (!Number.isFinite(size)) return;
    const next = Math.max(60, Math.min(240, Math.round(size / 10) * 10));
    this.photoPreviewSize.set(next);
    this.saveSetting('photoPreviewSize', next);
    this.offlineRenderer?.setPhotoPreviewSize(next);
    if (this.leaflet && this.directoryMarkerGroup) this.applyDirectoryPhotoMarkers();
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
  private readonly onMapsforgeTileError = (event: Event): void => {
    if (this.mapSource() !== 'mapsforge') return;
    const detail = (event as CustomEvent<{ message?: string; zoom?: number; column?: number; row?: number }>).detail;
    const message = detail?.message ?? 'Unknown Mapsforge tile error.';
    const noCoverage = /No loaded Mapsforge map covers tile/i.test(message);
    this.mapDisplayNotice.set(noCoverage
      ? 'No active Mapsforge map covers the current map area. Check the geographic coverage of the enabled .map files.'
      : 'Mapsforge tile rendering failed: ' + message);
    this.recordMapError('Mapsforge tile coverage', message);
  };

  private resetLastRenderCountsForViewport(): void {
    this.activeRenderTiles.clear();
    this.seenRenderTiles.clear();
    this.currentTileRequestResults.clear();
    this.lastRenderTileCounts.set({ rendered: 0, cached: 0, failed: 0 });
    this.lastRenderDurationSamples.set([]);
    this.lastRenderQueueSamples.set([]);
    this.lastHillshadeTileCounts.set({ rendered: 0, failed: 0 });
    this.hillshadeTotalCount.set(0);
    this.hillshadeCompletedCount.set(0);
    this.activeHillshadeTiles.clear();
    this.seenHillshadeTiles.clear();
    this.completedHillshadeTiles.clear();
    this.hillshadeActiveCount.set(0);
    this.renderActiveCount.set(0);
    this.renderTotalCount.set(0);
  }

  private readonly onOsmAndTileStatus = (event: Event): void => {
    const detail = (event as CustomEvent<{ protocol?: string; status?: string; error?: string; zoom?: number; column?: number; row?: number; totalDurationMs?: number; queueWaitMs?: number }>).detail;
    const expectedProtocol = this.mapSource() === 'osmand-atlas' ? 'osmand-atlas' : this.mapSource() === 'osmand' ? 'osmand' : this.mapSource() === 'mapsforge' ? 'mapsforge' : null;
    if (detail?.status === 'diagnostic' && detail.protocol === 'osmand-atlas' && detail.error) {
      this.recordMapError('OsmAnd Atlas helper', detail.error);
      return;
    }
    if (!detail || (detail.protocol !== 'osmand' && detail.protocol !== 'osmand-atlas' && detail.protocol !== 'mapsforge')) return;
    const key = `${detail.protocol}/${detail.zoom}/${detail.column}/${detail.row}`;
    if (detail.status === 'loading' || detail.status === 'rerendering') {
      this.clearRenderDisplayFallback();
      this.renderDisplayPending.set(false);
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
    } else if (detail.status === 'loaded' || detail.status === 'warning') {
      if (this.currentTileRequestResults.get(key) !== 'cached') {
        if (typeof detail.totalDurationMs === 'number' && Number.isFinite(detail.totalDurationMs) && detail.totalDurationMs >= 0) {
          const duration = detail.totalDurationMs;
          this.totalRenderDurationSamples.update(samples => [...samples, duration]);
          this.lastRenderDurationSamples.update(samples => [...samples, duration].slice(-500));
        }
        if (typeof detail.queueWaitMs === 'number' && Number.isFinite(detail.queueWaitMs) && detail.queueWaitMs >= 0) {
          const queueWait = detail.queueWaitMs;
          this.totalRenderQueueSamples.update(samples => [...samples, queueWait]);
          this.lastRenderQueueSamples.update(samples => [...samples, queueWait].slice(-500));
        }
        this.totalRenderTileCounts.update(counts => ({ ...counts, rendered: counts.rendered + 1 }));
        this.lastRenderTileCounts.update(counts => ({ ...counts, rendered: counts.rendered + 1 }));
      }
      this.currentTileRequestResults.delete(key);
      this.activeRenderTiles.delete(key);
    } else if (detail.status === 'error') {
      if (detail.protocol !== 'mapsforge') {
        this.recordMapError(
          detail.protocol === 'osmand-atlas' ? 'OsmAnd Atlas tile' : 'OsmAnd tile',
          (detail.error || 'Tile rendering failed') + ' [z=' + detail.zoom + ', x=' + detail.column + ', y=' + detail.row + ']'
        );
      }
      this.totalRenderTileCounts.update(counts => ({ ...counts, failed: counts.failed + 1 }));
      this.lastRenderTileCounts.update(counts => ({ ...counts, failed: counts.failed + 1 }));
      this.currentTileRequestResults.delete(key);
      this.activeRenderTiles.delete(key);
    } else if (detail.status === 'cancelled') {
      this.currentTileRequestResults.delete(key);
      this.activeRenderTiles.delete(key);
    }
    this.renderActiveCount.set(this.activeRenderTiles.size);
    if (this.activeRenderTiles.size === 0 && ['loaded', 'error', 'cancelled', 'warning'].includes(detail.status ?? '')) {
      this.renderDisplayPending.set(true);
      this.scheduleRenderDisplayFallback();
    }
    if (!expectedProtocol || detail.protocol !== expectedProtocol || !this.renderInitStatus()) return;
    if (detail.status === 'loading') this.renderInitStatus.set('Loading first tile …');
    else if (detail.status === 'loaded' || detail.status === 'warning' || detail.status === 'error' || detail.status === 'cache-loading') this.renderInitStatus.set('');
  };
  private readonly onHillshadeTileStatus = (event: Event): void => {
    const detail = (event as CustomEvent<{ key?: string; status?: string; error?: string; zoom?: number; column?: number; row?: number }>).detail;
    if (!detail || !detail.key) return;
    const key = detail.key;
    if (detail.status === 'loading') {
      this.clearRenderDisplayFallback();
      this.renderDisplayPending.set(false);
      this.hillshadeDisplayPending.set(false);
      this.completedHillshadeTiles.delete(key);
      this.hillshadeCompletedCount.set(this.completedHillshadeTiles.size);
      this.activeHillshadeTiles.add(key);
      if (!this.seenHillshadeTiles.has(key)) {
        this.seenHillshadeTiles.add(key);
        this.hillshadeTotalCount.update(total => total + 1);
      }
    } else if (detail.status === 'loaded') {
      this.completedHillshadeTiles.add(key);
      this.hillshadeCompletedCount.set(this.completedHillshadeTiles.size);
      this.totalHillshadeTileCounts.update(counts => ({ ...counts, rendered: counts.rendered + 1 }));
      this.lastHillshadeTileCounts.update(counts => ({ ...counts, rendered: counts.rendered + 1 }));
      this.activeHillshadeTiles.delete(key);
    } else if (detail.status === 'error') {
      this.completedHillshadeTiles.add(key);
      this.hillshadeCompletedCount.set(this.completedHillshadeTiles.size);
      this.totalHillshadeTileCounts.update(counts => ({ ...counts, failed: counts.failed + 1 }));
      this.lastHillshadeTileCounts.update(counts => ({ ...counts, failed: counts.failed + 1 }));
      this.activeHillshadeTiles.delete(key);
      this.recordMapError('Hillshade tile', (detail.error || 'Hillshade tile rendering failed')
        + ' [z=' + detail.zoom + ', x=' + detail.column + ', y=' + detail.row + ']', true);
    } else if (detail.status === 'cancelled') {
      this.activeHillshadeTiles.delete(key);
    }
    this.hillshadeActiveCount.set(this.activeHillshadeTiles.size);
    if (this.activeHillshadeTiles.size === 0 && ['loaded', 'error', 'cancelled'].includes(detail.status ?? '')) {
      this.hillshadeDisplayPending.set(true);
      this.renderDisplayPending.set(true);
      this.scheduleRenderDisplayFallback();
    }
  };
  private clearRenderDisplayFallback(): void {
    if (this.renderDisplayFallbackTimer !== null) {
      clearTimeout(this.renderDisplayFallbackTimer);
      this.renderDisplayFallbackTimer = null;
    }
  }
  private scheduleRenderDisplayFallback(): void {
    this.clearRenderDisplayFallback();
    // MapLibre normally emits an idle/display-ready event after uploading the
    // final tile. Keep the status responsive if that event is skipped while
    // the map is being resized or another source keeps the map non-idle.
    this.renderDisplayFallbackTimer = setTimeout(() => {
      this.renderDisplayFallbackTimer = null;
      if (this.renderActiveCount() === 0 && this.hillshadeActiveCount() === 0 && !this.rerenderVisibleTilesBusy()) {
        this.renderDisplayPending.set(false);
        this.hillshadeDisplayPending.set(false);
      }
    }, 1000);
  }
  private readonly onMapDisplayReady = (): void => {
    if (this.renderActiveCount() === 0 && this.hillshadeActiveCount() === 0 && !this.rerenderVisibleTilesBusy()) {
      this.clearRenderDisplayFallback();
      this.renderDisplayPending.set(false);
      this.hillshadeDisplayPending.set(false);
    }
  };
  protected readonly colorMenuOpen = signal(false);
  protected readonly mapSourceMenuOpen = signal(false);
  protected readonly selectedMapSourceType = computed(() => ({
    online: 'Online map',
    offline: 'MBTiles',
    osmand: 'OsmAnd (no labels)',
    'osmand-atlas': 'OsmAnd Atlas',
    mapsforge: 'Mapsforge'
  })[this.mapSource()]);
  protected readonly selectMapSource = (source: 'online' | 'offline' | 'osmand' | 'osmand-atlas' | 'mapsforge'): void => {
    this.mapSourceMenuOpen.set(false);
    this.changeMapSource(source);
  };
  protected readonly alwaysOnTop = signal(this.readSetting('alwaysOnTop', 'false') === 'true');
  protected readonly mapStyle = signal<MapStyle>(this.readSetting('style', 'standard') as MapStyle);
  protected readonly mapSource = signal<'online' | 'offline' | 'osmand' | 'osmand-atlas' | 'mapsforge'>(this.readSetting('source', 'online') === 'offline' ? 'offline' : this.readSetting('source', 'online') === 'osmand' ? 'osmand' : this.readSetting('source', 'online') === 'osmand-atlas' ? 'osmand-atlas' : this.readSetting('source', 'online') === 'mapsforge' ? 'mapsforge' : 'online');
  protected readonly offlineMapStyle = signal<OfflineMapStyle>(this.readSetting('offlineStyle', 'lumascope') as OfflineMapStyle);
  protected readonly osmAndStyle = signal('default.render.xml');
  protected readonly osmAndStyles = signal<import('internal-api').OsmAndRenderingStyle[]>([]);
  protected readonly offlineMapStatus = signal<import('internal-api').OfflineMapStatus | null>(null);
  protected readonly offlineMaps = signal<import('internal-api').OfflineMapStatus[]>([]);
  // The initial map-source restore can run before the asynchronous offline-map catalogue is loaded.
  protected readonly offlineMapsLoaded = signal(false);
  protected readonly viewportObfMapIds = signal<string[]>([]);
  protected readonly viewportObfMaps = computed(() => {
    const ids = new Set(this.viewportObfMapIds());
    return this.offlineMaps().filter(map => map.type === 'obf' && ids.has(map.id));
  });
  protected readonly obfBoundsPreview = signal<ObfBoundsPreview | null>(null);
  protected readonly boundsMapViews = signal<Record<BoundsMapKind, BoundsMapView>>({
    world: { x: 0, y: 0, width: 360, height: 180 },
    europe: { x: 850, y: 70, width: 500, height: 350 }
  });
  private boundsMapDrag: {
    kind: BoundsMapKind; pointerId: number; startX: number; startY: number;
    startView: BoundsMapView; rect: DOMRect;
  } | null = null;
  protected readonly offlineMapListFilter = signal<'all' | 'mbtiles' | 'obf' | 'map' | 'hillshade' | 'valhalla' | 'osmandResources' | 'mapsforgeTheme' | 'inUse' | 'active' | 'inactive' | 'missing' | 'updates' | 'current' | 'noMatch'>('all');
  protected readonly filteredResourcePackageEntries = computed(() => {
    const entries = this.resourcePackageEntries();
    const filter = this.offlineMapListFilter();
    const filtered = filter === 'all' ? entries
      : filter === 'valhalla' ? entries.filter(entry => entry.type === 'valhalla')
      : filter === 'osmandResources' ? entries.filter(entry => entry.type === 'osmand-resources')
      : filter === 'mapsforgeTheme' ? entries.filter(entry => entry.type === 'mapsforge-theme')
      : [];
    const sort = this.offlineMapSort();
    return [...filtered].sort((a, b) => {
      const typeOrder = a.type.localeCompare(b.type, undefined, { numeric: true, sensitivity: 'base' });
      const fileOrder = a.fileName.localeCompare(b.fileName, undefined, { numeric: true, sensitivity: 'base' });
      const direction = sort.direction === 'asc' ? 1 : -1;
      return sort.column === 'name'
        ? direction * fileOrder || typeOrder
        : direction * typeOrder || fileOrder;
    });
  });
  protected readonly resourcePackageEntryTypeLabel = (type: import('internal-api').ResourcePackageEntry['type']): string =>
    type === 'valhalla' ? 'Valhalla (offline routing)'
      : type === 'osmand-resources' ? 'OsmAnd resources (rendering)'
      : 'Mapsforge XML theme';
  protected readonly resourcePackageEntryActive = (entry: import('internal-api').ResourcePackageEntry): boolean =>
    entry.type === 'valhalla' && entry.sourcePath.replace(/\\/g, '/').toLocaleLowerCase() === this.routeValhallaConfigPath().replace(/\\/g, '/').toLocaleLowerCase();
  protected readonly resourcePackageEntryAvailable = (entry: import('internal-api').ResourcePackageEntry): boolean =>
    entry.type !== 'valhalla' || this.valhallaConfigurations().some(configuration =>
      configuration.available && configuration.path.replace(/\\/g, '/').toLocaleLowerCase() === entry.sourcePath.replace(/\\/g, '/').toLocaleLowerCase());
  protected readonly offlineMapUpdateCheckBusy = signal(false);
  protected readonly offlineMapUpdateCheckStatus = signal('');
  protected readonly offlineMapCatalogueFiles = signal<import('internal-api').OfflineMapCatalogueFile[]>([]);
  protected readonly offlineMapCatalogueSummary = signal('No catalogue has been checked yet.');
  private readonly offlineMapStats = computed(() => {
    let activeCount = 0;
    let availableCount = 0;
    let missingCount = 0;
    let unselectedCount = 0;
    const inUseIds = new Set<string>();
    for (const map of this.offlineMaps()) {
      if (map.enabled && map.available) activeCount++;
      if (map.available) availableCount++;
      if (this.offlineMapHasMissingFile(map)) missingCount++;
      if (map.available && !map.enabled) unselectedCount++;
      if (this.calculateOfflineMapInUse(map)) inUseIds.add(map.id);
    }
    return { activeCount, availableCount, missingCount, unselectedCount, inUseIds };
  });
  protected readonly activeOfflineMapCount = computed(() => this.offlineMapStats().activeCount);
  protected readonly activeOsmandMapCount = computed(() => this.viewportObfMapIds().length);
  protected readonly inUseOfflineMapCount = computed(() => this.offlineMapStats().inUseIds.size);
  protected readonly filteredOffline = computed(() => {
    const maps = this.offlineMaps();
    const filter = this.offlineMapListFilter();
    if (filter === 'mbtiles') return maps.filter(map => map.type === 'mbtiles' || !map.type);
    if (filter === 'obf') return maps.filter(map => map.type === 'obf');
    if (filter === 'map') return maps.filter(map => map.type === 'mapsforge');
    if (filter === 'hillshade') return [];
    if (filter === 'inUse') { const inUse = this.offlineMapStats().inUseIds; return maps.filter(map => inUse.has(map.id)); }
    if (filter === 'active') return maps.filter(map => map.enabled && map.available);
    if (filter === 'inactive') return maps.filter(map => map.available && !map.enabled);
    if (filter === 'missing') return maps.filter(map => !map.available || !map.filePath?.trim());
    if (filter === 'updates') return maps.filter(map => map.updateAvailable === true);
    if (filter === 'current') return maps.filter(map => map.updateChecked && map.updateAvailable === false);
    if (filter === 'noMatch') return maps.filter(map => map.updateChecked && map.updateMatched === false);
    if (filter === 'valhalla' || filter === 'osmandResources' || filter === 'mapsforgeTheme') return [];
    return maps;
  });
  protected readonly offlineMapSort = signal<{ column: string; direction: 'asc' | 'desc' }>({ column: 'type', direction: 'asc' });
  protected readonly sortedOffline = computed(() => {
    const sort = this.offlineMapSort();
    return this.sortRows(this.filteredOffline(), sort, map => sort.column === 'type'
      ? String(this.offlineMapSortValue(map, 'type')) + '|' + map.name
      : this.offlineMapSortValue(map, sort.column));
  });
  protected readonly offlineMapDuplicateIds = signal<ReadonlySet<string>>(new Set());
  protected readonly offlineMapMissingCount = computed(() => this.offlineFilesChecked() ? this.offlineMapStats().missingCount : 0);
  protected readonly offlineMapDuplicateCount = computed(() => this.offlineFilesChecked() ? this.offlineMapDuplicateIds().size : 0);
  protected readonly offlineMapHasMissingFile = (map: import('internal-api').OfflineMapStatus): boolean => this.offlineFilesChecked() && (!map.filePath?.trim() || !map.available);
  protected readonly offlineMapHasDuplicateName = (map: import('internal-api').OfflineMapStatus): boolean => this.offlineMapDuplicateIds().has(map.id);
  protected readonly offlineMapUnselectedCount = computed(() => this.offlineFilesChecked() ? this.offlineMapStats().unselectedCount + this.hillshadeStats().unselectedCount : 0);
  protected readonly offlineMapSortIndicator = (column: string): string => this.offlineMapSort().column === column ? (this.offlineMapSort().direction === 'asc' ? '▲' : '▼') : '↕';
  protected readonly sortOfflineMaps = (column: string): void => this.offlineMapSort.update(current => ({ column, direction: current.column === column && current.direction === 'asc' ? 'desc' : 'asc' }));
  protected readonly hillshadeSort = signal<{ column: string; direction: 'asc' | 'desc' }>({ column: 'name', direction: 'asc' });
  protected readonly sortedHillshadeDatabases = computed(() => this.sortRows(this.filteredHillshadeDatabases(), this.offlineMapSort(), database => this.hillshadeSortValue(database, this.offlineMapSort().column)));
  protected readonly hillshadeDuplicateIds = signal<ReadonlySet<string>>(new Set());
  private readonly hillshadeStats = computed(() => {
    let activeCount = 0;
    let availableCount = 0;
    let missingCount = 0;
    let unselectedCount = 0;
    for (const database of this.hillshadeDatabases()) {
      if (!database.path.trim() || !database.available) missingCount++;
      if (database.available) availableCount++;
      if (database.enabled && database.available) activeCount++;
      if (database.available && !database.enabled) unselectedCount++;
    }
    return { activeCount, availableCount, missingCount, unselectedCount };
  });
  protected readonly hillshadeMissingCount = computed(() => this.offlineFilesChecked() ? this.hillshadeStats().missingCount : 0);
  protected readonly hillshadeDuplicateCount = computed(() => this.offlineFilesChecked() ? this.hillshadeDuplicateIds().size : 0);
  protected readonly hillshadeHasDuplicateName = (database: OsmAndHillshadeDatabase): boolean => this.hillshadeDuplicateIds().has(database.id);
  protected readonly hillshadeSortIndicator = (column: string): string => this.hillshadeSort().column === column ? (this.hillshadeSort().direction === 'asc' ? '▲' : '▼') : '↕';
  protected readonly sortHillshadeDatabases = (column: string): void => this.hillshadeSort.update(current => ({ column, direction: current.column === column && current.direction === 'asc' ? 'desc' : 'asc' }));
  protected readonly valhallaMissingCount = computed(() => this.offlineFilesChecked() ? this.valhallaConfigurations().filter(configuration => !configuration.path.trim() || !configuration.available).length : 0);
  private readonly valhallaDuplicatePaths = signal<ReadonlySet<string>>(new Set());
  protected readonly valhallaDuplicateCount = computed(() => this.offlineFilesChecked() ? this.valhallaDuplicatePaths().size : 0);
  protected readonly valhallaHasDuplicatePath = (path: string): boolean => this.offlineFilesChecked() && this.valhallaDuplicatePaths().has(path.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase());
  private refreshValhallaDuplicateIndex(configurations: Array<{ path: string }>): void {
    const counts = new Map<string, number>();
    for (const configuration of configurations) {
      const path = configuration.path.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase();
      if (path) counts.set(path, (counts.get(path) ?? 0) + 1);
    }
    this.valhallaDuplicatePaths.set(new Set([...counts].filter(([, count]) => count > 1).map(([path]) => path)));
  }
  private readonly mapsforgeThemeDuplicatePaths = signal<ReadonlySet<string>>(new Set());
  protected readonly mapsforgeThemeDuplicateCount = computed(() => this.offlineFilesChecked() ? this.mapsforgeThemeDuplicatePaths().size : 0);
  protected readonly valhallaHasSelectedConfig = computed(() => !!this.routeValhallaConfigPath() && this.valhallaConfigurations().some(configuration => configuration.available && configuration.path.toLocaleLowerCase() === this.routeValhallaConfigPath().toLocaleLowerCase()));
  protected readonly offlineMapTabErrorCount = computed(() => this.offlineMapMissingCount() + this.offlineMapDuplicateCount()
    + this.hillshadeMissingCount() + this.hillshadeDuplicateCount()
    + this.valhallaMissingCount() + this.valhallaDuplicateCount()
    + (this.offlineFilesChecked() && this.valhallaConfigurations().length === 0 ? 1 : 0)
    + this.mapsforgeThemeDuplicateCount()
    + (this.offlineFilesChecked() && (!this.osmAndResourcesPath().trim() || !!this.osmAndResourcesError()) ? 1 : 0)
    + (this.offlineFilesChecked() && (!this.mapsforgeThemeFolder().trim() || this.mapsforgeThemes().length === 0 || !!this.mapsforgeThemeError()) ? 1 : 0));
  protected readonly hillshadeTabErrorCount = computed(() => this.hillshadeMissingCount() + this.hillshadeDuplicateCount());
  protected readonly offlineMapHasUnselectedFiles = computed(() => this.offlineFilesChecked() && this.offlineMapStats().availableCount + this.hillshadeStats().availableCount > 0 && this.offlineMapStats().activeCount + this.hillshadeStats().activeCount === 0);
  protected readonly hillshadeHasUnselectedFiles = computed(() => this.hillshadeStats().availableCount > 0 && this.hillshadeStats().activeCount === 0);
  protected readonly hillshadeUnselectedCount = computed(() => this.hillshadeStats().unselectedCount);

  protected readonly fileNameFromPath = (path: string): string => path.replace(/\\/g, '/').split('/').pop()?.toLocaleLowerCase() ?? '';
  protected readonly hasDuplicatePathName = (path: string, paths: string[]): boolean => {
    const name = this.fileNameFromPath(path);
    return !!name && paths.some(other => other.toLocaleLowerCase() !== path.toLocaleLowerCase() && this.fileNameFromPath(other) === name);
  };
  private readonly sortedRowOrderCache = new Map<string, string[]>();
  protected readonly sortRows = <T>(rows: T[], state: { column: string; direction: 'asc' | 'desc' }, value: (row: T) => string | number | boolean | null): T[] => {
    const ids = rows.map(row => String((row as { id?: string | number }).id ?? ''));
    const cacheKey = `${state.column}|${state.direction}|${ids.join('|')}`;
    let sortedIds = this.sortedRowOrderCache.get(cacheKey);
    if (!sortedIds) {
      const direction = state.direction === 'asc' ? 1 : -1;
      sortedIds = [...rows].sort((a, b) => {
        const left = value(a), right = value(b);
        if (left === right) return 0;
        if (left === null || left === undefined) return 1;
        if (right === null || right === undefined) return -1;
        if (typeof left === 'number' && typeof right === 'number') return (left - right) * direction;
        if (typeof left === 'boolean' && typeof right === 'boolean') return ((left ? 1 : 0) - (right ? 1 : 0)) * direction;
        return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' }) * direction;
      }).map(row => String((row as { id?: string | number }).id ?? ''));
      this.sortedRowOrderCache.set(cacheKey, sortedIds);
      // Keep the cache bounded when lists are repeatedly added, removed or resorted.
      if (this.sortedRowOrderCache.size > 12) this.sortedRowOrderCache.delete(this.sortedRowOrderCache.keys().next().value!);
    }
    const rowsById = new Map(rows.map(row => [String((row as { id?: string | number }).id ?? ''), row]));
    return sortedIds.map(id => rowsById.get(id)).filter((row): row is T => row !== undefined);
  };
  private offlineMapSortValue(map: import('internal-api').OfflineMapStatus, column: string): string | number | boolean | null {
    switch (column) {
      case 'inUse': return this.isOfflineMapInUse(map);
      case 'enabled': return map.enabled;
      case 'type': return (map.type ?? 'mbtiles') + '|' + map.name;
      case 'name': return map.name;
      case 'path': return map.filePath;
      case 'fileSize': return map.fileSize;
      case 'lastModified': return map.lastModified;
      case 'updates': return map.updateAvailable === true ? 2 : map.updateAvailable === false ? 1 : 0;
      case 'bounds': return map.bounds;
      case 'zoom': return map.minZoom * 100 + map.maxZoom;
      default: return map.name;
    }
  }
  private hillshadeSortValue(database: OsmAndHillshadeDatabase, column: string): string | number | boolean | null {
    switch (column) {
      case 'inUse': return false;
      case 'enabled': return database.enabled;
      case 'type': return 'hillshade';
      case 'name': return this.fileNameFromPath(database.path);
      case 'path': return database.path;
      case 'fileSize':
      case 'sizeBytes': return database.sizeBytes;
      case 'lastModified': return database.lastModified;
      case 'updates':
      case 'zoom': return 0;
      case 'bounds': return '';
      case 'status': return database.available ? (database.enabled ? 'Active' : 'Inactive') : 'File not found';
      default: return this.fileNameFromPath(database.path);
    }
  }
  protected readonly mapPresetOptions = signal<MapPresetOption[]>([]);
  protected readonly offlineMapPreset = signal<string>('custom');
  protected readonly hillshadePreset = signal<string>('custom');
  protected readonly osmAndTileCache = signal({ path: '%LOCALAPPDATA%\\LumaScope\\cache\\maps\\obf', entries: 0, bytes: 0, available: false });
  protected readonly osmAndTileCacheBusy = signal(false);
  protected readonly osmAndTileCacheStatus = signal('');
  protected readonly gpxDatabaseClearBusy = signal(false);
  protected readonly gpxDatabaseClearStatus = signal('');
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
  protected readonly downloadSources = signal<Array<{ url: string; fileType: 'obf' | 'mbtiles' | 'mapsforge' | 'android' | 'others'; useForUpdates: boolean }>>([]);
  protected readonly resourcePackageEntries = signal<import('internal-api').ResourcePackageEntry[]>([]);
  protected readonly osmAndResourcesPath = signal('');
  protected readonly osmAndResourcesError = signal('');
  protected readonly mapsforgeThemeFolder = signal('');
  protected readonly mapsforgeThemePath = signal('');
  protected readonly mapsforgeThemes = signal<import('internal-api').MapsforgeTheme[]>([]);
  protected readonly mapsforgeThemeError = signal('');
  protected readonly resourcePackageScanBusy = signal(false);
  protected readonly offlineFilesCheckBusy = signal(false);
  protected readonly offlineFilesChecked = signal(false);
  protected readonly offlineFilesCheckStatus = signal('');
  protected readonly resourcePackageScanStatus = signal('');
  protected readonly resourcePackageScanFound = signal('');
  protected readonly resourcePackageScanChanged = signal('');
  protected readonly resourcePackageScanError = signal('');

  protected readonly hasActiveMapsforgeMaps = computed(() => this.offlineMaps().some(map => map.type === 'mapsforge' && map.enabled && map.available));
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
  protected readonly displayDensityFactor = signal(this.readNumber('displayDensityFactor', this.readNumber('atlasDisplayDensityFactor', window.devicePixelRatio || 1, 1, 3), 1, 3));
  protected readonly overlayOpacity = signal(this.readNumber('overlayOpacity', 100, 0, 100));
  protected readonly mapVisible = signal(this.readSetting('mapVisible', 'true') === 'true');
  protected readonly hillshadeVisible = signal(this.readSetting('hillshadeVisible', 'false') === 'true');
  protected readonly hillshadeOpacity = signal(this.readNumber('hillshadeOpacity', 65, 0, 100));
  protected readonly hillshadeDatabases = signal<OsmAndHillshadeDatabase[]>([]);
  protected readonly filteredHillshadeDatabases = computed(() => {
    const databases = this.hillshadeDatabases();
    const filter = this.offlineMapListFilter();
    if (filter === 'hillshade' || filter === 'all') return databases;
    if (filter === 'active') return databases.filter(database => database.available && database.enabled);
    if (filter === 'inactive') return databases.filter(database => database.available && !database.enabled);
    if (filter === 'missing') return databases.filter(database => !database.available || !database.path.trim());
    return [];
  });
  protected readonly hillshadeDatabaseCount = computed(() => this.hillshadeDatabases().length);
  protected readonly activeHillshadeDatabaseCount = computed(() => this.hillshadeStats().activeCount);
  protected readonly zoomLevel = signal(this.readNumber('zoom', 13, 1, 20));
  private readonly mapZoomRestore: Promise<void> = this.desktop?.MapWindow.getZoom().then(zoom => {
    if (Number.isFinite(zoom)) this.zoomLevel.set(this.validZoom(zoom));
  }).catch(error => console.error('Could not restore map zoom:', error)) ?? Promise.resolve();
  protected readonly gpxColor = signal('#ff0000');
  protected readonly gpxOpacity = signal(100);
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
  protected readonly gpxTrackColorMenuPosition = signal({ top: 8, left: 8 });
  protected readonly autoFixLogMenuOpen = signal(false);
  protected readonly gpxRowActionMenuOpen = signal<string | null>(null);
  protected readonly gpxRowActionTrack = signal<GpxTrackFile | null>(null);
  protected readonly gpxRowActionMenuPosition = signal({ top: 8, left: 8 });
  protected readonly gpxTrackSettingsTrack = signal<GpxTrackFile | null>(null);
  protected readonly gpxTrackSettingsFavorites = signal<GpxTrackSettingsFavorite[]>([]);
  protected readonly gpxTrackSettingsHoveredLineStyle = signal<NonNullable<GpxTrackFile['lineStyle']> | null>(null);
  protected readonly gpxTrackSettingsHoveredDirection = signal<'off' | NonNullable<GpxTrackFile['directionStyle']> | null>(null);
  protected readonly gpxTrackLineStyleOptions = [
    { value: 'solid', label: 'Solid' }, { value: 'dashed', label: 'Dashed' }, { value: 'dotted', label: 'Dotted' },
    { value: 'long-dashed', label: 'Long dash' }, { value: 'short-dashed', label: 'Short dash' },
    { value: 'dash-dot', label: 'Dash-dot' }, { value: 'dash-dot-dot', label: 'Dash-dot-dot' }
  ] as const;
  protected readonly gpxTrackDirectionStyleOptions = [
    { value: 'off', label: 'Off' }, { value: 'classic', label: 'Classic' }, { value: 'chevron', label: 'Chevron' },
    { value: 'triangle', label: 'Triangle' }, { value: 'thin', label: 'Thin' }, { value: 'large-classic', label: 'Large classic' },
    { value: 'large-chevron', label: 'Large chevron' }, { value: 'large-triangle', label: 'Large triangle' }
  ] as const;
  protected readonly gpxLineStyleLabel = (value: string): string => this.gpxTrackLineStyleOptions.find(option => option.value === value)?.label ?? value;
  protected readonly gpxDirectionStyleLabel = (value: string): string => this.gpxTrackDirectionStyleOptions.find(option => option.value === value)?.label ?? value;

  protected readonly gpxTrackSettingsFavoriteName = signal('');
  protected readonly gpxTrackSettingsFavoriteSelection = signal('');
  protected readonly gpxTrackSettingsDraft = signal<GpxTrackSettingsDraft>({ colorMode: 'fixed', color: '#3388ff', speedPalette: 'spectrum', customColor1: '#2878ff', customColor2: '#18c99a', customColor3: '#f04444', speedMinKmh: 0, speedMaxKmh: 120, elevationMinM: 0, elevationMaxM: 3000, lineStyle: 'solid', lineWidth: 3, showDirection: false, directionIntervalPx: 120, directionArrowSizePx: 16, directionArrowOutlineWidthPx: 2, trackShadowStrength: 0, arrowShadowStrength: 0, trackOutlineStrength: 0, directionStyle: 'classic' });
  protected readonly routePointActionMenuOpen = signal<number | null>(null);
  protected readonly routePointActionMenuPosition = signal({ top: 8, left: 8 });
  protected readonly offlineRowActionMenuOpen = signal<string | null>(null);
  protected readonly offlineRowActionMenuPosition = signal({ top: 8, left: 8 });
  protected readonly toggleOfflineRowActionMenu = (path: string, event: MouseEvent): void => {
    if (this.offlineRowActionMenuOpen() === path) { this.offlineRowActionMenuOpen.set(null); return; }
    const pointer = { x: event.clientX, y: event.clientY };
    this.offlineRowActionMenuOpen.set(path);
    this.offlineRowActionMenuPosition.set(this.getRowActionMenuPosition(event, 300, 270, true));
    // Reposition after Angular has rendered the menu, using its real dimensions
    // instead of a guessed height. This keeps the popup anchored to the click
    // even when menu content or font metrics change.
    requestAnimationFrame(() => {
      if (this.offlineRowActionMenuOpen() !== path) return;
      const menu = document.querySelector<HTMLElement>('.offline-row-action-menu');
      if (!menu) return;
      const width = menu.getBoundingClientRect().width;
      const height = menu.getBoundingClientRect().height;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      let left = pointer.x + 4;
      if (left + width > viewportWidth - 8) left = pointer.x - width - 4;
      left = Math.max(8, Math.min(left, Math.max(8, viewportWidth - width - 8)));
      let top = pointer.y + 4;
      if (top + height > viewportHeight - 8) top = pointer.y - height - 4;
      top = Math.max(8, Math.min(top, Math.max(8, viewportHeight - height - 8)));
      this.offlineRowActionMenuPosition.set({ top, left });
    });
  };
  protected readonly hasVisibleOfflineFiles = (): boolean => this.filteredOffline().some(map => map.available) || this.filteredHillshadeDatabases().some(database => database.available);
  protected readonly hasAllOfflineFiles = (): boolean => this.offlineMaps().some(map => map.available) || this.hillshadeDatabases().some(database => database.available);
  protected readonly toggleGpxTrackColorMenu = (path: string, event: MouseEvent): void => {
    if (this.gpxTrackColorMenuOpen() === path) { this.gpxTrackColorMenuOpen.set(null); return; }
    this.colorMenuOpen.set(false);
    this.markerColorMenuOpen.set(false);
    this.currentMarkerColorMenuOpen.set(false);
    this.gpxTrackLineStyleMenuOpen.set(null);
    this.gpxTrackDirectionMenuOpen.set(null);
    const pointer = { x: event.clientX, y: event.clientY };
    this.gpxTrackColorMenuOpen.set(path);
    this.gpxTrackColorMenuPosition.set(this.getRowActionMenuPosition(event, 190, 300, true));
    // Render as a viewport-level overlay so the scrollable GPX list cannot clip it.
    requestAnimationFrame(() => {
      if (this.gpxTrackColorMenuOpen() !== path) return;
      const menu = document.querySelector<HTMLElement>('.gpx-track-color-menu-floating');
      if (!menu) return;
      const rect = menu.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      let left = pointer.x + 4;
      if (left + rect.width > viewportWidth - 8) left = pointer.x - rect.width - 4;
      left = Math.max(8, Math.min(left, Math.max(8, viewportWidth - rect.width - 8)));
      let top = pointer.y + 4;
      if (top + rect.height > viewportHeight - 8) top = pointer.y - rect.height - 4;
      top = Math.max(8, Math.min(top, Math.max(8, viewportHeight - rect.height - 8)));
      this.gpxTrackColorMenuPosition.set({ top, left });
    });
  };
  protected readonly gpxPreviewStops = (track: GpxTrackFile): Array<{ offset: string; color: string }> => track.speedPalette === 'custom-2'
    ? [{ offset: '0%', color: track.customColor1 || '#2878ff' }, { offset: '100%', color: track.customColor3 || '#f04444' }]
    : track.speedPalette === 'custom-3'
      ? [{ offset: '0%', color: track.customColor1 || '#2878ff' }, { offset: '50%', color: track.customColor2 || '#18c99a' }, { offset: '100%', color: track.customColor3 || '#f04444' }]
      : ({
          'cool-warm': [{ offset: '0%', color: '#2573be' }, { offset: '50%', color: '#46beaa' }, { offset: '100%', color: '#dc4637' }],
          viridis: [{ offset: '0%', color: '#440154' }, { offset: '25%', color: '#3b528b' }, { offset: '50%', color: '#21918c' }, { offset: '75%', color: '#5ec962' }, { offset: '100%', color: '#fde725' }],
          plasma: [{ offset: '0%', color: '#0d0887' }, { offset: '25%', color: '#7e03a8' }, { offset: '50%', color: '#cc4778' }, { offset: '75%', color: '#f89540' }, { offset: '100%', color: '#f0f921' }],
          inferno: [{ offset: '0%', color: '#000004' }, { offset: '25%', color: '#57106e' }, { offset: '50%', color: '#bc3754' }, { offset: '75%', color: '#f98e09' }, { offset: '100%', color: '#fcffa4' }],
          terrain: [{ offset: '0%', color: '#183a8f' }, { offset: '25%', color: '#27a9c2' }, { offset: '50%', color: '#4caf50' }, { offset: '75%', color: '#d8c66a' }, { offset: '100%', color: '#8c4b2d' }],
          spectrum: [{ offset: '0%', color: '#285adc' }, { offset: '25%', color: '#00bedc' }, { offset: '50%', color: '#28be5a' }, { offset: '75%', color: '#ffd200' }, { offset: '100%', color: '#eb2d23' }]
        } as Record<string, Array<{ offset: string; color: string }>>)[track.speedPalette ?? 'spectrum'] ?? [{ offset: '0%', color: '#285adc' }, { offset: '25%', color: '#00bedc' }, { offset: '50%', color: '#28be5a' }, { offset: '75%', color: '#ffd200' }, { offset: '100%', color: '#eb2d23' }];
  protected readonly gpxSettingsPreviewTrack = (track: GpxTrackFile): GpxTrackFile => {
    const draft = this.gpxTrackSettingsDraft();
    const hoveredDirection = this.gpxTrackSettingsHoveredDirection();
    const directionStyle = hoveredDirection && hoveredDirection !== 'off' ? hoveredDirection : (draft.directionStyle ?? 'classic');
    return {
      ...track,
      ...draft,
      lineStyle: this.gpxTrackSettingsHoveredLineStyle() ?? draft.lineStyle,
      showDirection: (hoveredDirection ?? (draft.showDirection ? draft.directionStyle : 'off')) !== 'off',
      directionStyle
    };
  };
  protected readonly gpxPreviewGradient = (track: GpxTrackFile): string => 'linear-gradient(90deg, ' + this.gpxPreviewStops(track).map(stop => stop.color + ' ' + stop.offset).join(', ') + ')';
  protected readonly gpxPreviewId = (path: string): string => { let hash = 0; for (let i = 0; i < path.length; i++) hash = (hash * 31 + path.charCodeAt(i)) | 0; return Math.abs(hash).toString(36); };
  protected readonly gpxDirectionGlyph = (style?: GpxTrackFile['directionStyle']): string =>
    style === 'chevron' || style === 'large-chevron' ? '❯'
      : style === 'triangle' || style === 'large-triangle' ? '▶'
      : style === 'thin' ? '➜'
      : '➤';
  protected readonly gpxDirectionArrowSize = (size?: number, style?: GpxTrackFile['directionStyle']): number => Math.max(8, Math.min(40, size ?? (style?.startsWith('large-') ? 24 : 16)));
  protected readonly gpxPreviewArrowPositions = (intervalPx = 120): Array<{ x: number; y: number; angle: number }> => {
    const points: Array<[number, number]> = [[3, 17], [22, 6], [42, 14], [62, 5], [82, 16], [102, 7], [122, 15], [147, 5]];
    const total = points.slice(1).reduce((sum, point, index) => sum + Math.hypot(point[0] - points[index][0], point[1] - points[index][1]), 0);
    const spacing = Math.max(20, Math.min(200, intervalPx));
    const result: Array<{ x: number; y: number; angle: number }> = [];
    for (let distance = spacing; distance < total - 2; distance += spacing) {
      let remaining = distance;
      for (let i = 1; i < points.length; i++) {
        const start = points[i - 1], end = points[i];
        const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
        if (remaining <= length) {
          const fraction = remaining / length;
          result.push({ x: start[0] + (end[0] - start[0]) * fraction, y: start[1] + (end[1] - start[1]) * fraction, angle: Math.atan2(end[1] - start[1], end[0] - start[0]) * 180 / Math.PI });
          break;
        }
        remaining -= length;
      }
    }
    return result;
  };
  protected readonly gpxPreviewDash = (style?: GpxTrackFile['lineStyle']): string => style === 'dashed' ? '10 7' : style === 'dotted' ? '2 7' : style === 'long-dashed' ? '18 7' : style === 'short-dashed' ? '5 5' : style === 'dash-dot' ? '12 5 2 5' : style === 'dash-dot-dot' ? '12 4 2 4 2 4' : '';
  protected readonly openGpxTrackSettings = async (track: GpxTrackFile): Promise<void> => {
    await this.ensureGpxDatabaseTrackSettingsLoaded();
    this.configuration.config().pipe(take(1)).subscribe(config => this.gpxTrackSettingsFavorites.set((config.system.gpxTrackSettingsFavorites ?? []) as unknown as GpxTrackSettingsFavorite[]));
    this.gpxTrackSettingsFavoriteName.set('');
    this.gpxTrackSettingsFavoriteSelection.set('');
    this.gpxTrackSettingsHoveredLineStyle.set(null);
    this.gpxTrackSettingsHoveredDirection.set(null);
    this.gpxTrackSettingsTrack.set(track);
    const settingsKey = track.databasePath || track.path;
    const latestTrackSettings = this.gpxDatabaseTrackSettings.get(settingsKey) ?? {};
    // The track row is the live source of truth; persisted settings are fallback
    // values only, so an older cached value cannot override the current row.
    const rawColor = String(track.color ?? latestTrackSettings.color ?? this.gpxColor()).trim().toLowerCase();
    const selectedColor = this.gpxColors.find(color =>
      color.value.toLowerCase() === rawColor || color.name.toLowerCase() === rawColor
    )?.value.toLowerCase() ?? rawColor;
    this.gpxTrackSettingsDraft.set({
      colorMode: track.colorMode ?? latestTrackSettings.colorMode ?? 'fixed',
      color: selectedColor,
      speedPalette: track.speedPalette ?? latestTrackSettings.speedPalette ?? 'spectrum',
      customColor1: track.customColor1 ?? latestTrackSettings.customColor1 ?? '#2878ff',
      customColor2: track.customColor2 ?? latestTrackSettings.customColor2 ?? '#18c99a',
      customColor3: track.customColor3 ?? latestTrackSettings.customColor3 ?? '#f04444',
      speedMinKmh: track.speedMinKmh ?? latestTrackSettings.speedMinKmh ?? 0,
      speedMaxKmh: track.speedMaxKmh ?? latestTrackSettings.speedMaxKmh ?? 120,
      elevationMinM: track.elevationMinM ?? latestTrackSettings.elevationMinM ?? 0,
      elevationMaxM: track.elevationMaxM ?? latestTrackSettings.elevationMaxM ?? 3000,
      lineStyle: track.lineStyle ?? latestTrackSettings.lineStyle ?? 'solid',
      lineWidth: track.lineWidth ?? latestTrackSettings.lineWidth ?? 4,
      showDirection: track.showDirection ?? latestTrackSettings.showDirection ?? false,
      directionIntervalPx: track.directionIntervalPx ?? latestTrackSettings.directionIntervalPx ?? 120,
      directionArrowSizePx: track.directionArrowSizePx ?? latestTrackSettings.directionArrowSizePx ?? ((track.directionStyle || 'classic').startsWith('large-') ? 24 : 16),
      directionArrowOutlineWidthPx: track.directionArrowOutlineWidthPx ?? latestTrackSettings.directionArrowOutlineWidthPx ?? 2,
      trackShadowStrength: track.trackShadowStrength ?? latestTrackSettings.trackShadowStrength ?? 0,
      arrowShadowStrength: track.arrowShadowStrength ?? latestTrackSettings.arrowShadowStrength ?? 0,
      trackOutlineStrength: track.trackOutlineStrength ?? latestTrackSettings.trackOutlineStrength ?? 0,
      directionStyle: track.directionStyle ?? latestTrackSettings.directionStyle ?? 'classic'
    });
    requestAnimationFrame(() => {
      const dialog = document.querySelector<HTMLElement>('.gpx-track-settings-dialog');
      const okButton = dialog?.querySelector<HTMLButtonElement>('.gpx-track-settings-ok');
      okButton?.focus();
    });
  };
  protected readonly onGpxTrackSettingsDialogClick = (event: MouseEvent): void => {
    const dialog = event.currentTarget as HTMLElement;
    const clickedChoice = (event.target as HTMLElement | null)?.closest('details.gpx-settings-choice') ?? null;
    dialog.querySelectorAll<HTMLDetailsElement>('details.gpx-settings-choice').forEach(choice => {
      if (choice !== clickedChoice) choice.removeAttribute('open');
    });
  };
  protected readonly onGpxTrackSettingsFooterKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const current = event.currentTarget as HTMLButtonElement;
    const buttons = Array.from(current.closest('footer')?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []);
    const index = buttons.indexOf(current);
    if (index < 0) return;
    event.preventDefault();
    event.stopPropagation();
    buttons[event.key === 'ArrowRight' ? Math.min(buttons.length - 1, index + 1) : Math.max(0, index - 1)].focus();
  };
  protected readonly clearGpxTrackSettingsHover = (): void => { this.gpxTrackSettingsHoveredLineStyle.set(null); this.gpxTrackSettingsHoveredDirection.set(null); };
  protected readonly previewGpxTrackLineStyle = (style: NonNullable<GpxTrackFile['lineStyle']>): void => this.gpxTrackSettingsHoveredLineStyle.set(style);
  protected readonly previewGpxTrackDirection = (style: 'off' | NonNullable<GpxTrackFile['directionStyle']>): void => this.gpxTrackSettingsHoveredDirection.set(style);
  protected readonly selectGpxTrackLineStyle = (style: NonNullable<GpxTrackFile['lineStyle']>): void => {
    this.updateGpxTrackSettingsDraft({ lineStyle: style });
    this.gpxTrackSettingsHoveredLineStyle.set(null);
  };
  protected readonly selectGpxTrackDirection = (style: 'off' | NonNullable<GpxTrackFile['directionStyle']>): void => {
    this.updateGpxTrackSettingsDraft({ showDirection: style !== 'off', ...(style === 'off' ? {} : { directionStyle: style }) });
    this.gpxTrackSettingsHoveredDirection.set(null);
  };
  protected readonly updateGpxTrackSettingsDraft = (patch: Partial<{ colorMode: 'fixed' | 'speed' | 'elevation'; color: string; speedPalette: 'spectrum' | 'cool-warm' | 'viridis' | 'plasma' | 'inferno' | 'terrain' | 'custom-2' | 'custom-3'; customColor1: string; customColor2: string; customColor3: string; speedMinKmh: number; speedMaxKmh: number; elevationMinM: number; elevationMaxM: number; lineStyle: NonNullable<GpxTrackFile['lineStyle']>; lineWidth: number; showDirection: boolean; directionIntervalPx: number; directionArrowSizePx: number; directionArrowOutlineWidthPx: number; trackShadowStrength: number; arrowShadowStrength: number; trackOutlineStrength: number; directionStyle: NonNullable<GpxTrackFile['directionStyle']> }>): void => this.gpxTrackSettingsDraft.update(current => ({ ...current, ...patch }));
  protected readonly cancelGpxTrackSettings = (): void => { this.gpxTrackSettingsHoveredLineStyle.set(null); this.gpxTrackSettingsHoveredDirection.set(null); this.gpxTrackSettingsTrack.set(null); };
  protected readonly applyGpxTrackSettingsFavorite = (name: string): void => {
    this.gpxTrackSettingsFavoriteSelection.set(name);
    const favorite = this.gpxTrackSettingsFavorites().find(item => item.name === name);
    if (favorite) this.gpxTrackSettingsDraft.set({ ...favorite.settings });
  };
  protected readonly addGpxTrackSettingsFavorite = (): void => {
    const name = this.gpxTrackSettingsFavoriteName().trim();
    if (!name) return;
    const favorite: GpxTrackSettingsFavorite = { name, settings: { ...this.gpxTrackSettingsDraft() } };
    const favorites = [...this.gpxTrackSettingsFavorites()];
    const existingIndex = favorites.findIndex(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (existingIndex >= 0) favorites[existingIndex] = favorite; else favorites.push(favorite);
    this.gpxTrackSettingsFavorites.set(favorites);
    this.gpxTrackSettingsFavoriteSelection.set(name);
    this.configuration.updateSystemConfig({ gpxTrackSettingsFavorites: favorites as unknown as Array<{ name: string; settings: Record<string, unknown> }> });
  };
  protected readonly removeGpxTrackSettingsFavorite = (): void => {
    const selectedName = this.gpxTrackSettingsFavoriteSelection();
    if (!selectedName) return;
    const favorites = this.gpxTrackSettingsFavorites().filter(item => item.name !== selectedName);
    this.gpxTrackSettingsFavorites.set(favorites);
    this.gpxTrackSettingsFavoriteSelection.set('');
    this.configuration.updateSystemConfig({ gpxTrackSettingsFavorites: favorites as unknown as Array<{ name: string; settings: Record<string, unknown> }> });
  };
  protected readonly saveGpxTrackSettings = (): void => {
    this.gpxTrackSettingsHoveredLineStyle.set(null);
    this.gpxTrackSettingsHoveredDirection.set(null);
    const track = this.gpxTrackSettingsTrack(); if (!track) return;
    const draft = this.gpxTrackSettingsDraft();
    const min = Math.max(0, Math.min(299, Math.round(Number(draft.speedMinKmh) || 0)));
    const max = Math.max(min + 1, Math.min(300, Math.round(Number(draft.speedMaxKmh) || 120)));
    const elevationMinM = Math.max(-12000, Math.min(100000, Math.round(Number(draft.elevationMinM) || 0)));
    const elevationMaxM = Math.max(elevationMinM + 1, Math.min(100001, Math.round(Number(draft.elevationMaxM) || 3000)));
    const savedSettings = { ...draft, directionIntervalPx: Math.max(20, Math.min(200, Math.round(Number(draft.directionIntervalPx) / 10) * 10)), directionArrowSizePx: Math.max(8, Math.min(40, Math.round(Number(draft.directionArrowSizePx) || 16))), directionArrowOutlineWidthPx: Math.max(0, Math.min(6, Number(draft.directionArrowOutlineWidthPx) || 0)), trackShadowStrength: Math.max(0, Math.min(100, Number(draft.trackShadowStrength) || 0)), arrowShadowStrength: Math.max(0, Math.min(100, Number(draft.arrowShadowStrength) || 0)), trackOutlineStrength: Math.max(0, Math.min(100, Number(draft.trackOutlineStrength) || 0)), speedMinKmh: min, speedMaxKmh: max, elevationMinM, elevationMaxM, lineWidth: Math.max(1, Math.min(10, Math.round(Number(draft.lineWidth) || 3))) };
    this.changeGpxListTrack(track.path, savedSettings);
    // Keep both list data sources synchronized so the GPX row preview refreshes
    // immediately regardless of whether the list is showing recent or database tracks.
    this.gpxTracks.update(tracks => tracks.map(item => item.path === track.path ? { ...item, ...savedSettings } : item));
    this.gpxDatabaseTracks.update(tracks => tracks.map(item => item.path === track.path ? { ...item, ...savedSettings } : item));
    this.gpxTrackSettingsTrack.set(null);
  };
  protected readonly exportGpxFromMemory = async (track: GpxTrackFile): Promise<void> => {
    if (!this.desktop) return;
    const segments = this.gpxPointDataByTrack.get(track.path) ?? [];
    if (!segments.some(segment => segment.length > 0)) {
      this.gpxError.set('No GPX points are available in the in-memory buffer for this track.');
      return;
    }
    try {
      const result = await this.desktop.CacheManager.exportGpxTrackFromMemory(track.name, segments.map(segment => segment.map(point => ({ latitude: point.latitude, longitude: point.longitude, elevation: point.elevation, timestamp: point.timestamp }))));
      if (!result.cancelled && result.path) this.gpxDatabaseQueryStatus.set('Exported ' + result.points.toLocaleString() + ' points (' + result.elevationPoints.toLocaleString() + ' elevation values) to ' + result.path);
    } catch (error) { this.gpxError.set(error instanceof Error ? error.message : String(error)); }
  };
  protected readonly toggleGpxRowActionMenu = (track: GpxTrackFile, event: MouseEvent): void => {
    if (this.gpxRowActionMenuOpen() === track.path) { this.gpxRowActionMenuOpen.set(null); this.gpxRowActionTrack.set(null); return; }
    this.gpxRowActionMenuOpen.set(track.path);
    this.gpxRowActionTrack.set(track);
    this.gpxRowActionMenuPosition.set(this.getRowActionMenuPosition(event, 230, this.gpxListMode() === 'recent' ? 325 : 195, true));
  };
  protected readonly deleteGpxDatabaseRecordsForFile = async (track: GpxTrackFile): Promise<void> => {
    if (!this.desktop || track.path.startsWith('memory:')) return;
    const sourcePath = track.databasePath || track.path;
    const databaseKey = /^[a-z]:[\\/]/i.test(sourcePath) ? sourcePath.slice(0, 2).toUpperCase()
      : this.trackGpxDatabaseKey() ?? this.gpxTracks().find(item => /^[a-z]:[\\/]/i.test(item.path))?.path.slice(0, 2).toUpperCase();
    if (!window.confirm(`Delete all database records for "${track.name}"?\\n\\nOnly this GPX file's database entry, segments and points will be deleted. The original GPX file and its favorite entry will remain unchanged.`)) return;
    try {
      const result = await this.desktop.CacheManager.deleteGpxDatabaseEntriesForFile(sourcePath, databaseKey);
      this.gpxDatabaseQueryStatus.set(result.deleted
        ? `Deleted records for ${track.name}: ${result.files} file, ${result.segments.toLocaleString()} segments and ${result.points.toLocaleString()} points.`
        : `No database records were found for ${track.name}.`);
      if (result.deleted && this.gpxTracks().at(-1)?.path === track.path) await this.refreshLatestGpxElevationProfile();
    } catch (error) {
      this.gpxError.set(error instanceof Error ? error.message : String(error));
    }
  };

  protected readonly exportGpxFromDatabase = async (track: GpxTrackFile): Promise<void> => {
    if (!this.desktop || track.path.startsWith('memory:')) return;
    const sourcePath = track.databasePath || track.path;
    const absolutePath = /^[a-z]:[\\/]/i.test(sourcePath);
    const databaseKey = absolutePath
      ? sourcePath.slice(0, 2).toUpperCase()
      : this.trackGpxDatabaseKey()
        ?? this.gpxTracks().find(item => /^[a-z]:[\\/]/i.test(item.path))?.path.slice(0, 2).toUpperCase();
    try {
      const result = await this.desktop.CacheManager.exportGpxFileFromDatabase(sourcePath, databaseKey);
      if (!result.cancelled && result.path) {
        this.gpxDatabaseQueryStatus.set(`Exported ${result.points.toLocaleString()} points (${result.elevationPoints.toLocaleString()} elevation values) to ${result.path}`);
      }
    } catch (error) {
      this.gpxError.set(error instanceof Error ? error.message : String(error));
    }
  };
  protected readonly toggleRoutePointActionMenu = (index: number, event: MouseEvent): void => {
    if (this.routePointActionMenuOpen() === index) { this.routePointActionMenuOpen.set(null); return; }
    this.routePointActionMenuOpen.set(index);
    this.routePointActionMenuPosition.set(this.getRowActionMenuPosition(event, 190, 112));
  };
  protected readonly runRoutePointAction = (index: number, action: 'remove' | 'up' | 'down'): void => {
    this.routePointActionMenuOpen.set(null);
    this.autoFixLogMenuOpen.set(false);
    if (action === 'remove') this.removeRouteWaypoint(index);
    else this.moveRouteWaypoint(index, action === 'up' ? -1 : 1);
  };
  private getRowActionMenuPosition(event: MouseEvent, width: number, estimatedHeight: number, anchorAtPointer = false): { top: number; left: number } {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const menuWidth = Math.min(width, Math.max(0, viewportWidth - 16));
    if (anchorAtPointer && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
      let top = event.clientY + 4;
      if (top + estimatedHeight > viewportHeight - 8) top = event.clientY - estimatedHeight - 4;
      top = Math.max(8, Math.min(top, Math.max(8, viewportHeight - Math.min(estimatedHeight, viewportHeight - 16) - 8)));
      let left = event.clientX + 4;
      if (left + menuWidth > viewportWidth - 8) left = event.clientX - menuWidth - 4;
      left = Math.max(8, Math.min(left, viewportWidth - menuWidth - 8));
      return { top, left };
    }
    let top = rect.bottom + 3;
    if (top + estimatedHeight > viewportHeight - 8) top = rect.top - estimatedHeight - 3;
    top = Math.max(8, Math.min(top, Math.max(8, viewportHeight - Math.min(estimatedHeight, viewportHeight - 16) - 8)));
    const anchorX = Number.isFinite(event.clientX) && event.clientX > 0 ? event.clientX : rect.right;
    const left = Math.max(8, Math.min(anchorX - menuWidth, viewportWidth - menuWidth - 8));
    return { top, left };
  }
  protected readonly gpxTrackLineStyleMenuOpen = signal<string | null>(null);
  protected readonly gpxTrackDirectionMenuOpen = signal<string | null>(null);
  protected readonly gpxVisible = signal(true);
  protected readonly gpxTracks = signal<GpxTrackFile[]>([]);
  protected readonly gpxDatabaseTracks = signal<GpxTrackFile[]>([]);
  private readonly gpxDatabaseTrackSettings = new Map<string, Partial<Pick<GpxTrackFile, 'active' | 'color' | 'colorMode' | 'speedPalette' | 'customColor1' | 'customColor2' | 'customColor3' | 'speedMinKmh' | 'speedMaxKmh' | 'elevationMinM' | 'elevationMaxM' | 'lineStyle' | 'lineWidth' | 'showDirection' | 'directionIntervalPx' | 'directionArrowSizePx' | 'directionArrowOutlineWidthPx' | 'trackShadowStrength' | 'arrowShadowStrength' | 'trackOutlineStrength' | 'directionStyle'>>>();
  private gpxDatabaseTrackSettingsLoaded = false;
  private gpxDatabaseSettingsWriteQueue: Promise<void> = Promise.resolve();
  protected readonly gpxSpeedLegendTracks = computed(() => (this.gpxListMode() === 'database' ? this.gpxDatabaseTracks() : this.gpxTracks()).filter(track => track.active !== false && (track.colorMode === 'speed' || track.colorMode === 'elevation')));
  protected readonly gpxElevationProfiles = signal<Array<{ track: GpxTrackFile; profile: GpxElevationProfile }>>([]);
  protected readonly latestGpxElevationProfileBusy = signal(false);
  protected readonly latestGpxElevationProfileError = signal('');
  private gpxElevationProfileRequestId = 0;
  protected readonly gpxElevationChart = computed(() => {
    const entries = this.gpxElevationProfiles().filter(entry => entry.profile.points.length >= 2);
    if (!entries.length) return null;
    const width = 900, left = 70, right = 20, top = 18, plotHeight = 200;
    const allPoints = entries.flatMap(entry => entry.profile.points);
    const minTime = allPoints.reduce((value, point) => Math.min(value, point.timestampMs), Number.POSITIVE_INFINITY);
    const maxTime = allPoints.reduce((value, point) => Math.max(value, point.timestampMs), Number.NEGATIVE_INFINITY);
    const minElevation = allPoints.reduce((value, point) => Math.min(value, point.elevationM), Number.POSITIVE_INFINITY);
    const maxElevation = allPoints.reduce((value, point) => Math.max(value, point.elevationM), Number.NEGATIVE_INFINITY);
    const elevationRange = maxElevation - minElevation || 1;
    const timeRange = maxTime - minTime || 1;
    const formatTime = (timestamp: number): string => new Date(timestamp).toLocaleString(undefined, {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });
    const series = entries.map(({ track, profile }) => {
      const points = profile.points.map(point => ({
        x: left + (point.timestampMs - minTime) / timeRange * (width - left - right),
        y: top + (maxElevation - point.elevationM) / elevationRange * plotHeight
      }));
      const polyline = points.map(point => point.x.toFixed(1) + ',' + point.y.toFixed(1)).join(' ');
      const arrows: Array<{ x: number; y: number; angle: number }> = [];
      if (track.showDirection && points.length > 1) {
        const interval = Math.max(20, Math.min(200, track.directionIntervalPx ?? 120));
        let nextArrowAt = interval, travelled = 0;
        for (let index = 1; index < points.length; index++) {
          const a = points[index - 1], b = points[index];
          const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
          if (!length) continue;
          while (travelled + length >= nextArrowAt) {
            const fraction = (nextArrowAt - travelled) / length;
            arrows.push({ x: a.x + dx * fraction, y: a.y + dy * fraction, angle: Math.atan2(dy, dx) * 180 / Math.PI });
            nextArrowAt += interval;
          }
          travelled += length;
        }
      }
      return {
        key: track.path, name: track.name, color: track.color || this.gpxColor(),
        lineWidth: track.lineWidth ?? 3, dash: this.gpxPreviewDash(track.lineStyle),
        polyline, arrows,
        arrowGlyph: this.gpxDirectionGlyph(track.directionStyle),
        arrowSize: this.gpxDirectionArrowSize(track.directionArrowSizePx, track.directionStyle),
        lineStyle: this.gpxLineStyleName(track.lineStyle ?? 'solid'),
        colorMode: track.colorMode === 'speed' ? 'Speed-based' : track.colorMode === 'elevation' ? 'Elevation-based' : 'Fixed color',
        palette: track.speedPalette ?? 'spectrum',
        modeDetails: track.colorMode === 'speed'
          ? `Speed ${track.speedMinKmh ?? 0}–${track.speedMaxKmh ?? 30} km/h · ${track.speedPalette ?? 'spectrum'} palette`
          : track.colorMode === 'elevation'
            ? `Elevation ${track.elevationMinM ?? 0}–${track.elevationMaxM ?? 3000} m · ${track.speedPalette ?? 'spectrum'} palette`
            : `Fixed color ${track.color || this.gpxColor()}`,
        customColors: [track.customColor1, track.customColor2, track.customColor3].filter((value): value is string => !!value).join(' / '),
        directionLabel: track.showDirection ? `${this.gpxDirectionName(track.directionStyle ?? 'classic')} · every ${track.directionIntervalPx ?? 120} px · ${track.directionArrowSizePx ?? 16} px` : 'Direction arrows off'
      };
    });
    return {
      series, minLabel: minElevation.toFixed(0),
      midLabel: ((minElevation + maxElevation) / 2).toFixed(0),
      maxLabel: maxElevation.toFixed(0), startLabel: formatTime(minTime), endLabel: formatTime(maxTime)
    };
  });
  protected readonly gpxListMode = signal<'recent' | 'database'>('recent');
  protected readonly gpxDatabaseColumns = signal({ points: true, time: true, size: true, modified: true, path: true });
  protected readonly gpxDatabaseSort = signal<{ key: 'active' | 'name' | 'points' | 'time' | 'size' | 'modified' | 'path' | 'color' | 'line' | 'width' | 'arrows'; direction: 'asc' | 'desc' }>({ key: 'time', direction: 'asc' });
  protected readonly gpxDatabaseColumnWidths = signal<Record<string, number>>((() => {
    const defaults = { actions: 42, active: 76, name: 210, points: 76, time: 190, size: 88, modified: 135, path: 260, color: 130, line: 112, width: 76, arrows: 130 };
    try {
      const saved = JSON.parse(this.readSetting('gpxDatabaseColumnWidths', '{}')) as Record<string, number>;
      for (const key of Object.keys(defaults) as Array<keyof typeof defaults>) {
        if (Number.isFinite(saved[key]) && saved[key] >= (key === 'active' ? 76 : 42) && saved[key] <= 900) defaults[key] = saved[key];
      }
    } catch { /* Keep the default column widths. */ }
    return defaults;
  })());
  protected readonly gpxDatabaseQueryBusy = signal(false);
  protected readonly gpxDatabaseQueryStatus = signal('');
  private gpxDatabaseQueryGeneration = 0;
  private gpxDatabaseViewportRefreshTimer: number | null = null;
  protected readonly routeWaypoints = signal<RouteWaypoint[]>([]);
  protected readonly routeWaypointMarkersVisible = signal(this.readSetting('routeWaypointMarkersVisible', 'true') !== 'false');
  protected readonly routeProfile = signal<RouteProfile>('driving-car');
  protected readonly routeProvider = signal<RouteProviderId>('offline-valhalla');
  protected readonly routeValhallaConfigPath = signal(this.readSetting('valhallaConfigPath', ''));
  protected readonly valhallaConfigurations = signal<Array<{ path: string; name: string; available: boolean }>>([]);
  protected readonly routeConfigBusy = signal(false);
  protected readonly routeApiKey = signal(this.readSetting('openRouteServiceApiKey', ''));
  protected readonly routeSaveDirectory = signal(this.readSetting('routeSaveDirectory', ''));
  protected readonly routeName = signal(this.readSetting('routeName', 'Route'));
  protected readonly routeBusy = signal(false);
  protected readonly routeStatus = signal('');
  protected readonly lastSavedRouteGpxPath = signal('');
  private routeWaypointMarkers: Array<{ remove(): void }> = [];
  private routeRequestGeneration = 0;
  protected readonly gpxError = signal('');
  protected readonly gpxHoveredTrackPath = signal<string | null>(null);
  protected readonly gpxHoverInfo = signal('');
  protected readonly timeSliderActive = signal(this.readSetting('timeSliderActive', 'false') === 'true');
  protected readonly timeSliderAnimationSectionOpen = signal(this.readSetting('timeSliderAnimationSectionOpen', 'false') === 'true');
  protected readonly timeSliderMinimum = signal(0);
  protected readonly timeSliderMaximum = signal(0);
  protected readonly timeSliderStart = signal(0);
  protected readonly timeSliderEnd = signal(0);
  protected readonly timeSliderAnimating = signal(false);
  protected readonly timeSliderWalkerVisible = signal(this.readSetting('timeSliderWalkerVisible', 'false') === 'true');
  protected readonly timeSliderAnimationSpeed = signal(Math.max(0.1, Math.min(10, Number(this.readSetting('timeSliderAnimationSpeed', '1')) || 1)));
  protected readonly walkingFigureSize = signal(Math.max(0.5, Math.min(3, Number(this.readSetting('walkingFigureSize', '1')) || 1)));
  protected readonly walkingFigureAnimationSpeed = signal(Math.max(0.2, Math.min(3, Number(this.readSetting('walkingFigureAnimationSpeed', '1')) || 1)));
  protected readonly walkingFigureType = signal<string>(
    Object.hasOwn(GPX_SYMBOLS, this.readSetting('walkingFigureType', 'walker'))
      ? this.readSetting('walkingFigureType', 'walker')
      : 'walker'
  );
  protected readonly walkingFigureSymbolSettings = signal<Record<string, TimeSliderSymbolSettings>>(this.readWalkingFigureSymbolSettings());
  private timeSliderAnimationTimer: ReturnType<typeof setInterval> | null = null;
  private lastWalkingBearing = 0;
  private smoothedWalkingBearing: number | null = null;
  private lastWalkingBearingUpdate = 0;
  protected readonly timeSliderHasData = computed(() => this.timeSliderMaximum() > this.timeSliderMinimum());
  protected readonly markerSectionOpen = signal(this.readSetting('markerSectionOpen', 'false') === 'true');
  protected readonly directoryMarkersEnabled = signal(this.readSetting('directoryMarkersEnabled', 'false') === 'true');
  protected readonly useAllPhotosInDb = signal(this.readSetting('useAllPhotosInDb', 'false') === 'true');
  private markerViewportRefreshTimer: number | null = null;
  protected readonly markerFilesChecked = signal(0);
  protected readonly markerFilesTotal = signal(0);
  protected readonly markerCount = signal(0);
  protected readonly markerStatus = signal('');
  protected readonly markerSourceFolder = signal('Not loaded.');
  protected readonly coordinateLabel = signal('GPS coordinates unavailable');
  protected readonly photoCoordinateLabel = signal('Photo: GPS coordinates unavailable');
  protected readonly mouseCoordinateLabel = signal('');
  protected readonly coordinatesAvailable = signal(false);
  protected readonly currentImageHasGps = signal(false);
  protected readonly fixLocationEnabled = signal(false);
  protected readonly fixLocationSectionOpen = signal(true);
  protected readonly autoFixCheckOnly = signal(false);
  protected readonly autoFixMaxDifferenceMinutes = signal(2);
  protected readonly autoFixBusy = signal(false);
  protected readonly autoFixOperationActive = signal(false);
  protected readonly autoFixStatus = signal('');
  protected readonly autoFixReport = signal<Array<{ label: string; value: string }>>([]);
  protected readonly autoFixProgress = signal({ scanned: 0, total: 0, withGps: 0, withoutGps: 0, matched: 0, currentFolder: '.' });
  protected readonly autoFixProgressPercent = (): number => {
    const progress = this.autoFixProgress();
    return progress.total > 0 ? Math.min(100, Math.max(0, progress.scanned / progress.total * 100)) : 0;
  };
  protected readonly autoFixCountPercent = (count: number): number => {
    const total = this.autoFixProgress().total;
    return total > 0 ? Math.min(100, Math.max(0, count / total * 100)) : 0;
  };
  protected readonly formatAutoFixTimestampRange = (from: number | null, to: number | null): string => {
    if (from === null || to === null) return 'n/a';
    return formatOsDateTime(new Date(from)) + ' – ' + formatOsDateTime(new Date(to));
  };
  protected readonly createAutoFixLiveReport = (
    progress: FixPhotoLocationsProgress, checkOnly: boolean
  ): Array<{ label: string; value: string }> => {
    const elapsedSeconds = progress.elapsedMilliseconds / 1000;
    const formatDuration = (seconds: number): string => {
      const roundedSeconds = Math.max(0, Math.round(seconds));
      if (roundedSeconds < 60) return roundedSeconds + ' s';
      const minutes = Math.floor(roundedSeconds / 60);
      const remainingSeconds = roundedSeconds % 60;
      if (minutes < 60) return minutes + ' min ' + remainingSeconds + ' s';
      const hours = Math.floor(minutes / 60);
      return hours + ' h ' + (minutes % 60) + ' min';
    };
    const elapsedText = elapsedSeconds < 60
      ? elapsedSeconds.toFixed(1) + ' s'
      : formatDuration(elapsedSeconds);
    const remainingPhotos = progress.total - progress.scanned;
    const estimatedRemainingSeconds = progress.scanned >= 5 && remainingPhotos > 0
      ? elapsedSeconds / progress.scanned * remainingPhotos
      : null;
    const runtimeText = estimatedRemainingSeconds === null
      ? elapsedText
      : elapsedText + ' · Estimated remaining: ~' + formatDuration(estimatedRemainingSeconds);
    const deviationStats = progress.minDeviationSeconds === null
      ? 'n/a'
      : progress.minDeviationSeconds.toFixed(1) + ' / ' + progress.meanDeviationSeconds!.toFixed(1) + ' / ' + progress.maxDeviationSeconds!.toFixed(1) + ' s';
    return [
      { label: 'Selected start folder', value: progress.rootFolder },
      { label: 'Folders scanned (including subfolders)', value: this.formatAutoFixCount(progress.totalFoldersProcessed) },
      { label: 'All files scanned (photos and non-photos)', value: this.formatAutoFixCount(progress.totalFilesProcessed) },
      { label: 'Photo files checked', value: this.formatAutoFixCount(progress.scanned) + ' / ' + this.formatAutoFixCount(progress.total) },
      { label: 'Cache databases searched', value: progress.databaseKeys.join(', ') || '—' },
      { label: 'GPX timestamp range (all imported files)', value: this.formatAutoFixTimestampRange(progress.gpxFromTimestamp, progress.gpxToTimestamp) },
      { label: 'Photo timestamp range (photos scanned so far)', value: this.formatAutoFixTimestampRange(progress.photoFromTimestamp, progress.photoToTimestamp) },
      { label: 'Runtime', value: runtimeText },
      { label: 'Result', value: checkOnly ? 'Checking — no files will be changed' : 'GPS correction in progress' },
      { label: 'Photos whose files already contain GPS coordinates', value: this.formatAutoFixCount(progress.withGps) },
      { label: 'Photos missing GPS coordinates', value: this.formatAutoFixCount(progress.withoutGps) },
      { label: 'Photos matched to GPX within the time limit', value: this.formatAutoFixCount(progress.matched) },
      { label: 'Photos with no usable GPX match', value: this.formatAutoFixCount(progress.unmatched) },
      { label: 'Photos with a GPX match rejected by the time limit', value: this.formatAutoFixCount(progress.ignoredTooFar) },
      { label: 'Time deviation of GPX candidates (min / mean / max)', value: deviationStats },
      ...(!checkOnly ? [{ label: 'Photos updated', value: this.formatAutoFixCount(progress.updated) }] : []),
      ...(progress.errors ? [{ label: 'Errors', value: this.formatAutoFixCount(progress.errors) }] : [])
    ];
  };
  private autoFixOperationSequence = 0;
  private activeAutoFixOperationId: string | null = null;
  protected readonly currentImagePreview = signal<string | null>(null);
  protected readonly currentImageName = signal('');
  private imagePreviewGeneration = 0;
  protected readonly gpsSaveBusy = signal(false);
  protected readonly gpsSaveStatus = signal('');
  protected readonly locationAddress = signal('');

  protected readonly crosshairAddress = signal('');
  protected readonly offlineAddressQuery = signal('');
  protected readonly offlineAddressSearchResults = signal<import('internal-api').OsmAndAddressSearchResult[]>([]);
  protected readonly offlineAddressSearchBusy = signal(false);
  protected readonly offlineAddressSearchError = signal('');
  protected readonly bearing = signal<number | null>(null);
  protected readonly bearingLabel = computed(() => this.bearing() === null ? '' : String(Math.round(this.bearing()!)) + '° ' + this.compassDirection(this.bearing()!));
  protected readonly gpxColors: ReadonlyArray<{ name: string; value: string; textColor?: string }> = [
    { name: 'Red', value: '#ff0000' }, { name: 'Orange', value: '#ff9500' },
    { name: 'Amber', value: '#ffb000' }, { name: 'Yellow', value: '#ffd60a' },
    { name: 'Lime', value: '#a8d600' }, { name: 'Green', value: '#34c759' },
    { name: 'Forest green', value: '#16834a' }, { name: 'Teal', value: '#30b7a5' },
    { name: 'Cyan', value: '#32c7e8' }, { name: 'Sky blue', value: '#64aaf5' },
    { name: 'Blue', value: '#0a84ff' }, { name: 'Navy', value: '#244a9b' },
    { name: 'Purple', value: '#8e5bd9' }, { name: 'Magenta', value: '#bf5af2' },
    { name: 'Pink', value: '#ff6fae' }, { name: 'Brown', value: '#9b6544' },
    { name: 'Gray', value: '#8e8e93' }, { name: 'White', value: '#ffffff' },
    { name: 'Black', value: '#171717' }
  ] as const;
  protected readonly gpxTrackSettingsColors = this.gpxColors.filter(color => color.name !== 'White');

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
    if (target instanceof Element && target.closest('.gpx-row-actions')) return;
    if (target instanceof Element && target.closest('.offline-row-actions')) return;
    if (target instanceof Element && target.closest('.routing-point-actions')) return;
    if (target instanceof Element && target.closest('.fix-location-log-actions')) return;
    this.autoFixLogMenuOpen.set(false);
    this.routePointActionMenuOpen.set(null);
    this.gpxRowActionMenuOpen.set(null);
    this.gpxRowActionTrack.set(null);
    this.offlineRowActionMenuOpen.set(null);
    this.colorMenuOpen.set(false);
    this.markerColorMenuOpen.set(false);
    this.currentMarkerColorMenuOpen.set(false);
    this.gpxTrackColorMenuOpen.set(null);
    this.mapSourceMenuOpen.set(false);
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(event: KeyboardEvent): void {
    const trackSettingsOpen = !!document.querySelector('.gpx-track-settings-dialog');
    if (trackSettingsOpen && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.cancelGpxTrackSettings();
      return;
    }
    if (trackSettingsOpen && event.key === 'Enter'
      && !(event.target instanceof HTMLSelectElement)
      && !(event.target instanceof HTMLTextAreaElement)
      && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      this.saveGpxTrackSettings();
      return;
    }
    if (event.key !== 'Escape') return;
    this.routePointActionMenuOpen.set(null);
    if (this.mapSourceMenuOpen()) {
      event.preventDefault();
      this.mapSourceMenuOpen.set(false);
    }
    this.colorMenuOpen.set(false);
    this.markerColorMenuOpen.set(false);
    this.currentMarkerColorMenuOpen.set(false);
    this.gpxRowActionMenuOpen.set(null);
    this.gpxRowActionTrack.set(null);
    this.offlineRowActionMenuOpen.set(null);
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
    const target = event.target;
    if (target instanceof HTMLElement && (
      target.isContentEditable
      || target.matches('input:not([type="checkbox"]):not([type="button"]):not([type="submit"]), textarea, select, [contenteditable="true"]')
    )) return;
    // The location window is a separate Electron window, so the main image-view
    // keyboard listener cannot receive shortcuts while this window has focus.
    if (event.key.toLowerCase() === 's'
      && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      void this.desktop?.CapturePreviewWindow.open();
    }
  }

  ngOnInit(): void {
    const favoriteLocationsSubscription = this.galleryLocations.locations().subscribe(locations => {
      const keys = [...new Set(locations.map(path => path.slice(0, 2).toUpperCase()).filter(key => /^[A-Z]:$/.test(key)))].sort();
      this.favoriteGpxDatabaseKeys.set(keys);
      this.favoriteGpxDatabaseKeysReady.set(true);
      if (this.activeSettingsTab() === 'track') void this.refreshLatestGpxElevationProfile();
    });
    this.favoriteLocationsUnsubscribe = () => favoriteLocationsSubscription.unsubscribe();
    setOfflineRenderConcurrency(this.renderWorkerCount());
    this.offlineRenderStatusUnsubscribe = subscribeOfflineRenderStatus(tasks => this.offlineRenderTasks.set(tasks));
    if (this.desktop) {
      void this.desktop.Valhalla.getRuntimeStatus().then(async status => {
        this.valhallaConfigurations.set(status.configurations ?? []);
        const savedPath = this.routeValhallaConfigPath();
        if (savedPath && !status.configurations?.some(configuration => configuration.path.toLowerCase() === savedPath.toLowerCase())) {
          try {
            status = await this.desktop!.Valhalla.setConfigPath(savedPath);
            this.valhallaConfigurations.set(status.configurations ?? []);
          } catch (error) {
            console.warn('[Valhalla] Could not migrate the saved routing configuration:', error);
          }
        }
        if (!this.routeValhallaConfigPath() && status.configPath) this.routeValhallaConfigPath.set(status.configPath);
      }).catch(error => console.warn('[Valhalla] Could not load routing configurations:', error));
    }
    this.mapWindowConfigRestore = this.desktop
      ? this.desktop.ProcessManager.getAppSettings().then(settings => {
      const offlineSettings = settings['offline'] as Record<string, unknown> | undefined;
      const savedOfflineFileEntries = Array.isArray(offlineSettings?.['paths'])
        ? offlineSettings['paths'] as Array<{ type?: string; path?: string; enabled?: boolean; size?: number; name?: string; sourcePath?: string }>
        : [];
      const savedResourceEntries: import('internal-api').ResourcePackageEntry[] = savedOfflineFileEntries.flatMap((entry): import('internal-api').ResourcePackageEntry[] => {
        if (!entry.path || typeof entry.size !== 'number') return [];
        if (entry.type === 'valhalla-config') {
          const folder = entry.path.replace(/[\\/][^\\/]+$/, '');
          const name = folder.replace(/^.*[\\/]/, '');
          return [{ type: 'valhalla' as const, fileName: name, path: folder, sourcePath: entry.path, fileSize: entry.size }];
        }
        if (entry.type === 'osmand-resources') {
          return [{ type: 'osmand-resources' as const, fileName: '', path: entry.path, sourcePath: entry.path, fileSize: entry.size }];
        }
        if (entry.type === 'mapsforge-theme') {
          return [{ type: 'mapsforge-theme' as const, fileName: entry.name ?? entry.sourcePath?.replace(/^.*[\\/]/, '').replace(/\.xml$/i, '') ?? '',
            path: entry.path, sourcePath: entry.sourcePath ?? entry.path, fileSize: entry.size }];
        }
        return [];
      });
      this.resourcePackageEntries.set(savedResourceEntries);
      const configuredPresets = offlineSettings?.['presets'];
      if (configuredPresets && typeof configuredPresets === 'object' && !Array.isArray(configuredPresets)) {
        const options = Object.entries(configuredPresets as Record<string, unknown>).flatMap(([id, value]) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
          const preset = value as Record<string, unknown>;
          return typeof preset['name'] === 'string' && typeof preset['OsmAndRegex'] === 'string'
            ? [{
                id, name: preset['name'], osmAndRegex: preset['OsmAndRegex'],
                ...(typeof preset['mapsForgeRegex'] === 'string' ? { mapsForgeRegex: preset['mapsForgeRegex'] } : {}),
                ...(typeof preset['HillshadeRegex'] === 'string' ? { hillshadeRegex: preset['HillshadeRegex'] } : {})
              }] : [];
        });
        if (options.length) {
          this.mapPresetOptions.set(options);
          const loadedMaps = this.offlineMaps();
          const matchingPreset = loadedMaps.length ? this.getOfflineMapPresetForMaps(loadedMaps) : null;
          if (matchingPreset) this.offlineMapPreset.set(matchingPreset);
          const loadedHillshade = this.hillshadeDatabases();
          if (loadedHillshade.length) this.updateHillshadePresetFromSelection(loadedHillshade);
        }
      }
      const saved = settings['mapWindow'] as Record<string, unknown> | undefined;
      const savedDisclosureStates = saved?.['disclosureStates'];
      if (savedDisclosureStates && typeof savedDisclosureStates === 'object' && !Array.isArray(savedDisclosureStates)) {
        this.disclosureStates = Object.fromEntries(Object.entries(savedDisclosureStates).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'));
        this.restoreDisclosureStates(savedDisclosureStates as Record<string, unknown>);
      }
      const savedSymbolSettings = saved?.['timeSliderSymbolSettings']
        && typeof saved['timeSliderSymbolSettings'] === 'object'
        && !Array.isArray(saved['timeSliderSymbolSettings'])
        ? saved['timeSliderSymbolSettings'] as Record<string, Partial<TimeSliderSymbolSettings>>
        : {};
      const restoredSymbolSettings = this.normalizeWalkingFigureSymbolSettings({
        ...this.readWalkingFigureSymbolSettings(),
        ...savedSymbolSettings
      });
      this.walkingFigureSymbolSettings.set(restoredSymbolSettings);
      this.saveSetting('timeSliderSymbolSettings', JSON.stringify(restoredSymbolSettings));
      if (!saved) return;
      const configuredOpacity = Number(saved['opacity']);
      if (Number.isFinite(configuredOpacity) && configuredOpacity >= 0 && configuredOpacity <= 100) {
        this.mapOpacity.set(configuredOpacity);
        this.saveSetting('opacity', configuredOpacity);
      }
      if (typeof saved['mapVisible'] === 'boolean') {
        this.mapVisible.set(saved['mapVisible']);
        this.saveSetting('mapVisible', saved['mapVisible']);
      }
      if (!Number.isFinite(configuredOpacity)) {
        this.persistLocationUiState({ opacity: this.mapOpacity(), mapVisible: this.mapVisible() });
      }
      this.applyMapOpacity();
      const configuredWaypoints = Array.isArray(saved['routeWaypoints']) ? saved['routeWaypoints'] : [];
      const restoredWaypoints = configuredWaypoints.flatMap((entry: unknown) => {
        if (!entry || typeof entry !== 'object') return [];
        const point = entry as Record<string, unknown>;
        const latitude = Number(point['latitude']), longitude = Number(point['longitude']);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return [];
        return [{ latitude, longitude, active: point['active'] !== false, ...(typeof point['name'] === 'string' ? { name: point['name'] } : {}) }];
      });
      this.routeWaypoints.set(restoredWaypoints);
      this.updateRouteWaypointMarkers();
      if (typeof saved['settingsOpen'] === 'boolean') this.settingsOpen.set(saved['settingsOpen']);
      if (typeof saved['timeSliderAnimationSectionOpen'] === 'boolean') {
        this.timeSliderAnimationSectionOpen.set(saved['timeSliderAnimationSectionOpen']);
        this.saveSetting('timeSliderAnimationSectionOpen', saved['timeSliderAnimationSectionOpen']);
      }
      if (saved['activeSettingsTab'] === 'offlineMaps' || saved['activeSettingsTab'] === 'hillshade') {
        this.activeSettingsTab.set('offlineMaps');
        this.offlineMapListMounted.set(true);
      } else if (typeof saved['activeSettingsTab'] === 'string' && ['location','fix','track','routing','timeSlider','marker','view','cache','memory','download','errors'].includes(saved['activeSettingsTab'])) {
        this.activeSettingsTab.set(saved['activeSettingsTab'] as 'location' | 'fix' | 'track' | 'routing' | 'timeSlider' | 'marker' | 'view' | 'cache' | 'memory' | 'download' | 'errors');
      }
      if (typeof saved['renderVisualsEnabled'] === 'boolean') {
        this.renderVisualsEnabled.set(saved['renderVisualsEnabled']);
        window.dispatchEvent(new CustomEvent('lumascope-osmand-tile-visuals', { detail: { enabled: saved['renderVisualsEnabled'] } }));
      }
      if (typeof saved['scaleVisible'] === 'boolean') {
        this.scaleVisible.set(saved['scaleVisible']);
        this.applyScaleVisibility();
      }
      if (typeof saved['mapBoundsVisible'] === 'boolean') {
        this.mapBoundsVisible.set(saved['mapBoundsVisible']);
        this.applyMapBoundsVisibility();
      }
      if (typeof saved['fixLocationEnabled'] === 'boolean') {
        this.fixLocationEnabled.set(saved['fixLocationEnabled']);
      }
      if (typeof saved['opacitySectionOpen'] === 'boolean') this.opacitySectionOpen.set(saved['opacitySectionOpen']);
      if (typeof saved['renderSectionOpen'] === 'boolean') this.renderSectionOpen.set(saved['renderSectionOpen']);
      if (typeof saved['markerSectionOpen'] === 'boolean') this.markerSectionOpen.set(saved['markerSectionOpen']);
      }).catch(error => console.warn('[Location] Could not restore window UI state:', error))
      : Promise.resolve();
    window.addEventListener('lumascope-osmand-tile-status', this.onOsmAndTileStatus);
    window.addEventListener('lumascope-mapsforge-tile-error', this.onMapsforgeTileError);
    window.addEventListener('lumascope-map-display-ready', this.onMapDisplayReady);
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
    this.currentFolderPath = this.route.snapshot.queryParamMap.get('folderPath');
    if (this.fixLocationEnabled() && !this.coordinatesAvailable()) {
      void this.initializeFixLocationMap();
    }
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
          const offlineFileEntries = Array.isArray((settings['offline'] as Record<string, unknown> | undefined)?.['paths'])
            ? (settings['offline'] as Record<string, unknown>)['paths'] as Array<{ type?: string; path?: string; enabled?: boolean; size?: number; name?: string; sourcePath?: string }>
            : [];
          const resourcesPath = offlineFileEntries.find(entry => entry.type === 'osmand-resources')?.path ?? '';
          this.osmAndResourcesPath.set(resourcesPath);

          const themeFolder = offlineFileEntries.find(entry => entry.type === 'mapsforge-theme-folder')?.path ?? '';
          const savedThemePath = offlineFileEntries.find(entry => entry.type === 'mapsforge-theme' && entry.enabled !== false)?.sourcePath ?? '';
          this.mapsforgeThemeFolder.set(themeFolder);
          if (themeFolder) {
            try {
              const themes = await this.desktop!.Mapsforge.scanThemes(themeFolder);
              this.mapsforgeThemes.set(themes);

              const selectedTheme = themes.find(theme => theme.path === savedThemePath) ?? null;
              const selectedPath = selectedTheme?.path ?? '';
              this.mapsforgeThemePath.set(selectedPath);
              if (selectedPath !== savedThemePath) {
                await this.desktop!.ProcessManager.setAppSettingsSection('mapsforge', { themeFolder, themePath: selectedPath });
              }
            } catch (error) {
              this.mapsforgeThemeError.set(error instanceof Error ? error.message : String(error));
            }
          }

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
      const offline = settings['offline'] as Record<string, unknown> | undefined;
      const saved = offline?.['updateSources'];
      const valid = Array.isArray(saved) ? saved.filter((entry): entry is { url: string; fileType: 'obf' | 'mbtiles' | 'mapsforge' | 'android' | 'others'; useForUpdates: boolean } =>
        !!entry && typeof entry === 'object'
        && typeof (entry as { url?: unknown }).url === 'string'
        && ['obf', 'mbtiles', 'mapsforge', 'android', 'others'].includes(String((entry as { fileType?: unknown }).fileType))
        && typeof (entry as { useForUpdates?: unknown }).useForUpdates === 'boolean'
      ) : [];
      this.downloadSources.set(valid);
    }).catch(error => console.error('Could not load download source settings:', error));
    void this.desktop?.OfflineMap.getMaps().then(async maps => {
      const mapsWithMetadata = await this.enrichObfMetadata(maps);
      this.offlineMaps.set(mapsWithMetadata);
      this.offlineMapsLoaded.set(true);
      this.applyMapBoundsVisibility();

      if (this.mapSource() === 'mapsforge' && this.currentLatitude !== null && this.currentLongitude !== null) {
        this.mapSourceGeneration++;
        this.mapInitialization = null;
        this.offlineRenderer?.remove();
        this.offlineRenderer = null;
        void this.initialize(this.currentLatitude, this.currentLongitude);
      }
      // Preset is always derived from the current enabled-file selection.
      this.offlineMapPreset.set(this.getOfflineMapPresetForMaps(maps) ?? 'custom');
      // An offline source without any compatible loaded MBTiles cannot be used.
      // Restore the online source instead of leaving the selector on an empty map.
      if (!maps.some(map => map.enabled && (map.type === 'mbtiles' || !map.type)) && this.mapSource() === 'offline') this.changeMapSource('online');
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
      this.currentImageHasGps.set(true);
      this.currentLatitude = latitude; this.currentLongitude = longitude;
      this.coordinateLabel.set(this.formatCoordinates(latitude, longitude));
      this.photoCoordinateLabel.set(this.formatCoordinates(latitude, longitude).replace(/^Coordinates: /, 'Photo: '));
      void this.lookupLocationAddress(latitude, longitude);
      void this.initialize(latitude, longitude);
    } else {
      const savedLatitude = Number(this.readSetting('lastLatitude', ''));
      const savedLongitude = Number(this.readSetting('lastLongitude', ''));
      const hasSavedPosition = Number.isFinite(savedLatitude) && Number.isFinite(savedLongitude)
        && savedLatitude >= -90 && savedLatitude <= 90
        && savedLongitude >= -180 && savedLongitude <= 180;
      if (hasSavedPosition) {
        this.currentLatitude = savedLatitude;
        this.currentLongitude = savedLongitude;
        this.coordinatesAvailable.set(true);
        this.coordinateLabel.set(this.formatCoordinates(savedLatitude, savedLongitude));
        this.photoCoordinateLabel.set(this.formatCoordinates(savedLatitude, savedLongitude).replace(/^Coordinates: /, 'Photo: '));
        void this.lookupLocationAddress(savedLatitude, savedLongitude);
        void this.initialize(savedLatitude, savedLongitude);
      } else {
        this.locationAddress.set('');
        void this.initialize(48.2082, 16.3738);
      }
    }
    const applyLocation = (location: { latitude: number | null; longitude: number | null; bearing?: number | null; imagePath?: string | null; folderPath?: string | null }): void => {
      const previousImagePath = this.currentImagePath;
      const previousFolderPath = this.currentFolderPath;
      this.currentLatitude = location.latitude; this.currentLongitude = location.longitude;
      this.currentImagePath = location.imagePath ?? null;
      this.currentFolderPath = location.folderPath ?? null;
      if (this.currentFolderPath) this.markerSourceFolder.set(this.currentFolderPath);
      this.currentImageHasGps.set(Number.isFinite(location.latitude) && Number.isFinite(location.longitude)
        && location.latitude! >= -90 && location.latitude! <= 90
        && location.longitude! >= -180 && location.longitude! <= 180);
      void this.loadCurrentImagePreview(this.currentImagePath);
      this.applyCurrentPhotoVisibility();
      if (this.directoryMarkersEnabled() && (previousImagePath?.toLowerCase() !== this.currentImagePath?.toLowerCase() || previousFolderPath?.toLowerCase() !== this.currentFolderPath?.toLowerCase())) void this.scanDirectoryMarkers();
      const nextLatitude = location.latitude;
      const nextLongitude = location.longitude;
      if (!Number.isFinite(nextLatitude) || !Number.isFinite(nextLongitude)
        || nextLatitude! < -90 || nextLatitude! > 90 || nextLongitude! < -180 || nextLongitude! > 180) {
        this.locationLookupVersion++;
        this.mapSourceGeneration++;
        this.mapInitialization = null;
        const savedLatitude = Number(this.readSetting('lastLatitude', ''));
        const savedLongitude = Number(this.readSetting('lastLongitude', ''));
        const hasSavedPosition = Number.isFinite(savedLatitude) && Number.isFinite(savedLongitude)
          && savedLatitude >= -90 && savedLatitude <= 90
          && savedLongitude >= -180 && savedLongitude <= 180;
        this.photoCoordinateLabel.set('Photo: GPS coordinates unavailable');
        if (hasSavedPosition) {
          this.currentLatitude = savedLatitude;
          this.currentLongitude = savedLongitude;
          this.coordinatesAvailable.set(true);
          this.coordinateLabel.set(this.formatCoordinates(savedLatitude, savedLongitude));
          this.locationAddress.set('Looking up address…');
          void this.lookupLocationAddress(savedLatitude, savedLongitude);
          if (this.mapSource() === 'offline' || this.mapSource() === 'osmand' || this.mapSource() === 'osmand-atlas' || this.mapSource() === 'mapsforge') {
            void this.initialize(savedLatitude, savedLongitude);
          } else if (this.offlineRenderer) {
            this.offlineRenderer.updateCurrentLocation(savedLatitude, savedLongitude);
            this.offlineRenderer.map.jumpTo({ center: [savedLongitude, savedLatitude] });
          } else if (this.map) {
            this.map.setView([savedLatitude, savedLongitude], this.map.getZoom());
          } else {
            void this.initialize(savedLatitude, savedLongitude);
          }
        } else {
          this.coordinatesAvailable.set(false);
          this.coordinateLabel.set('GPS coordinates unavailable');
          this.locationAddress.set('');
          this.marker?.setOpacity(0);
          this.offlineRenderer?.setCurrentOpacity(0);
          if (!this.map && !this.offlineRenderer) void this.initialize(48.2082, 16.3738);
        }
        return;
      }
      this.coordinatesAvailable.set(true);
      this.saveSetting('lastLatitude', nextLatitude!);
      this.saveSetting('lastLongitude', nextLongitude!);
      this.coordinateLabel.set(this.formatCoordinates(nextLatitude!, nextLongitude!));
      this.photoCoordinateLabel.set(this.formatCoordinates(nextLatitude!, nextLongitude!).replace(/^Coordinates: /, 'Photo: '));
      void this.lookupLocationAddress(nextLatitude!, nextLongitude!);
      this.bearing.set(typeof location.bearing === 'number' && Number.isFinite(location.bearing) ? location.bearing : null);
      if (this.mapSource() === 'offline' || this.mapSource() === 'osmand' || this.mapSource() === 'osmand-atlas' || this.mapSource() === 'mapsforge') {
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
    this.offlineRenderStatusUnsubscribe?.();
    this.offlineRenderStatusUnsubscribe = null;
    this.favoriteLocationsUnsubscribe?.();
    this.favoriteLocationsUnsubscribe = null;
    if (this.memoryRefreshTimer) clearInterval(this.memoryRefreshTimer);
    this.memoryRefreshTimer = null;
    this.stopTimeSliderAnimation();
    this.walkingMarker?.remove(); this.walkingMarker = null;
    this.walkingMapLibreMarker?.remove(); this.walkingMapLibreMarker = null;
    window.removeEventListener('lumascope-osmand-tile-status', this.onOsmAndTileStatus);
    window.removeEventListener('lumascope-mapsforge-tile-error', this.onMapsforgeTileError);
    window.removeEventListener('lumascope-map-display-ready', this.onMapDisplayReady);
    window.removeEventListener('lumascope-hillshade-tile-status', this.onHillshadeTileStatus);
    this.clearRenderDisplayFallback();
    this.renderInitStatus.set('');
    // Save the live camera value before destroying either map implementation.
    // This also covers closing the separate Location window or the overlay
    // while a zoom animation is still in progress.
    this.persistZoom(this.offlineRenderer?.map.getZoom() ?? this.map?.getZoom() ?? this.zoomLevel());
    this.persistLocationUiState({
      settingsOpen: this.settingsOpen(),
      activeSettingsTab: this.activeSettingsTab(),
      timeSliderAnimationSectionOpen: this.timeSliderAnimationSectionOpen(),
      renderVisualsEnabled: this.renderVisualsEnabled(),
      opacitySectionOpen: this.opacitySectionOpen(),
      renderSectionOpen: this.renderSectionOpen(),
      markerSectionOpen: this.markerSectionOpen()
    });
    this.mapSourceGeneration++;
    this.mapInitialization = null;
    setMapsforgeTileProtocolActive(false);
    if (this.mapSource() === 'mapsforge') {
      void this.desktop?.Mapsforge.close().catch(error => console.warn('Could not close Mapsforge renderer:', error));
    }
    this.unsubscribeLocation?.();
    this.markerScanGeneration++;
    if (this.markerViewportRefreshTimer !== null) window.clearTimeout(this.markerViewportRefreshTimer);
    this.markerViewportRefreshTimer = null;
    if (this.gpxDatabaseViewportRefreshTimer !== null) window.clearTimeout(this.gpxDatabaseViewportRefreshTimer);
    this.gpxDatabaseViewportRefreshTimer = null;
    this.clearDirectoryMarkers();
    window.removeEventListener('resize', this.onResize);
    this.clearMapBoundsLayers();
    this.map?.remove();
    this.map = null;
    this.leafletHillshadeLayer = null;
    this.leafletHillshadePane = null;
    this.offlineRenderer?.remove(); this.offlineRenderer = null;
    // Native OsmAnd render helpers are persistent main-process workers. Stop them
    // when their map window goes away so they cannot keep GPU contexts alive.
    if (this.mapSource() === 'osmand-atlas') {
      void (async () => {
        try {
          await this.desktop?.OsmAndAtlas.cancelRendering();
          await this.desktop?.OsmAndAtlas.shutdown();
        } catch (error) {
          console.warn('Could not stop OsmAnd Atlas helpers:', error);
        }
      })();
    }
    if (this.mapSource() === 'osmand') void this.desktop?.OsmAnd.shutdown().catch(error => console.warn('Could not stop OsmAnd helpers:', error));
  }

  private readonly onResize = (): void => { this.map?.invalidateSize(); this.offlineRenderer?.resize(); };

  protected readonly copyFilePath = async (path: string): Promise<void> => {
    if (!path) return;
    try { await navigator.clipboard.writeText(path); }
    catch (error) { console.error('Failed to copy file path', error); }
  };

  protected readonly setFixLocationEnabled = (enabled: boolean): void => {
    this.fixLocationEnabled.set(enabled);
    this.persistLocationUiState({ fixLocationEnabled: enabled });
    this.gpsSaveStatus.set('');
    if (!enabled) return;
    if (!this.map && !this.offlineRenderer) void this.initialize(48.2082, 16.3738);
  };

  private async initializeFixLocationMap(): Promise<void> {
    if (!this.fixLocationEnabled() || this.map || this.offlineRenderer || !this.currentImagePath) return;
    this.mapSourceGeneration++;
    this.mapInitialization = null;
    this.renderInitStatus.set('Loading map for location fixing…');
    try {
      await this.initialize(48.2082, 16.3738);
      if (this.fixLocationEnabled()) {
        this.onResize();
        this.renderInitStatus.set('');
        if (!this.map && !this.offlineRenderer) {
          this.gpsSaveStatus.set(this.mapDisplayNotice() || 'The selected map source could not be initialized for location fixing.');
        }
      }
    } catch (error) {
      this.renderInitStatus.set('');
      this.gpsSaveStatus.set(error instanceof Error ? error.message : String(error));
    }
  }

  private async loadCurrentImagePreview(imagePath: string | null): Promise<void> {
    const generation = ++this.imagePreviewGeneration;
    this.currentImagePreview.set(null);
    this.currentImageName.set(imagePath ? imagePath.split(/[\\/]/).pop() ?? imagePath : '');
    if (!imagePath || !this.desktop) return;
    try {
      const preview = await this.desktop.MapWindow.getImagePreview(imagePath);
      if (generation === this.imagePreviewGeneration && imagePath === this.currentImagePath) {
        this.currentImagePreview.set(preview);
      }
    } catch (error) {
      if (generation === this.imagePreviewGeneration) {
        console.warn('[Location] Could not load the current photo preview:', error);
      }
    }
  }

  protected readonly formatAutoFixCount = (value: number): string => value.toLocaleString('en-US').replace(/,/g, ' ');

  protected readonly setAutoFixMaxDifference = (value: string): void => {
    this.autoFixMaxDifferenceMinutes.set(value.trim() === '' ? 0 : Number(value));
  };

  protected readonly abortAutomaticLocationFix = (): void => {
    const operationId = this.activeAutoFixOperationId;
    if (!operationId || !this.desktop) return;
    this.autoFixStatus.set('Aborting…');
    this.desktop.Exif.cancelFixFolderLocations(operationId);
  };

  protected readonly fixLocationAutomatic = async (): Promise<void> => {
    if (!this.desktop || this.autoFixBusy()) return;
    this.autoFixBusy.set(true);
    this.autoFixStatus.set('Selecting photo folder…');
    try {
      let initialFolder: string | undefined;
      if (this.currentImagePath) {
        try { initialFolder = await this.desktop.FileSystem.dirname(this.currentImagePath); }
        catch (error) { console.warn('[Location] Could not determine the current photo folder:', error); }
      }
      const selection = await this.desktop.Dialogs.openFolder(initialFolder);
      if (!selection.success || !selection.data) {
        this.autoFixStatus.set('');
        return;
      }
      const checkOnly = this.autoFixCheckOnly();
      this.autoFixReport.set([]);
      this.autoFixProgress.set({ scanned: 0, total: 0, withGps: 0, withoutGps: 0, matched: 0, currentFolder: '.' });
      this.autoFixStatus.set(checkOnly ? 'Checking photos against the GPX database…' : 'Fixing missing GPS information… Please wait.');
      const maxDifferenceMinutes = this.autoFixMaxDifferenceMinutes();
      if (!Number.isFinite(maxDifferenceMinutes) || maxDifferenceMinutes < 0 || maxDifferenceMinutes > 1440) {
        throw new Error('Maximum time difference must be between 0 and 1440 minutes.');
      }
      const operationId = Date.now().toString(36) + '-' + (++this.autoFixOperationSequence).toString(36);
      this.activeAutoFixOperationId = operationId;
      this.autoFixOperationActive.set(true);
      this.autoFixProgress.set({ scanned: 0, total: 0, withGps: 0, withoutGps: 0, matched: 0, currentFolder: '.' });
      const unsubscribeProgress = this.desktop.Exif.onFixFolderLocationsProgress(progress => {
        this.autoFixProgress.set({ scanned: progress.scanned, total: progress.total, withGps: progress.withGps, withoutGps: progress.withoutGps, matched: progress.matched, currentFolder: progress.currentFolder });
        this.autoFixReport.set(this.createAutoFixLiveReport(progress, checkOnly));
        if (checkOnly) {
          this.autoFixStatus.set('Checking photos against the GPX database… '
            + this.formatAutoFixCount(progress.scanned) + ' / ' + this.formatAutoFixCount(progress.total) + ' photos checked');
        } else {
          this.autoFixStatus.set('Fixing missing GPS information… '
            + this.formatAutoFixCount(progress.scanned) + ' / ' + this.formatAutoFixCount(progress.total) + ' photos processed');
        }
      });
      const response = await this.desktop.Exif.fixFolderLocations(selection.data, checkOnly, maxDifferenceMinutes * 60, operationId, this.favoriteGpxDatabaseKeys())
        .finally(() => {
          unsubscribeProgress();
          if (this.activeAutoFixOperationId === operationId) this.activeAutoFixOperationId = null;
          this.autoFixOperationActive.set(false);
        });
      if (!response.success) throw new Error(response.errorMessage || 'Automatic GPS correction failed.');
      const result = response.data;
      if (result.aborted) this.autoFixStatus.set('Aborted after ' + this.formatAutoFixCount(result.scanned) + ' photos.');
      const elapsedSeconds = result.elapsedMilliseconds / 1000;
      const roundedElapsedSeconds = Math.round(elapsedSeconds);
      const elapsedText = elapsedSeconds < 60
        ? elapsedSeconds.toFixed(1) + ' s'
        : Math.floor(roundedElapsedSeconds / 60).toString() + ' min ' + (roundedElapsedSeconds % 60).toString() + ' s';
      const deviationStats = result.minDeviationSeconds === null
        ? 'n/a'
        : result.minDeviationSeconds.toFixed(1) + ' / ' + result.meanDeviationSeconds!.toFixed(1) + ' / ' + result.maxDeviationSeconds!.toFixed(1) + ' s';
      if (!result.aborted) this.autoFixStatus.set('');
      this.autoFixReport.set([
        { label: 'Selected start folder', value: result.rootFolder },
        { label: 'Folders scanned (including subfolders)', value: this.formatAutoFixCount(result.totalFoldersProcessed) },
        { label: 'All files scanned (photos and non-photos)', value: this.formatAutoFixCount(result.totalFilesProcessed) },
        { label: 'Photo files checked', value: this.formatAutoFixCount(result.scanned) },
        { label: 'Cache databases searched', value: result.databaseKeys.join(', ') || '—' },
        { label: 'GPX timestamp range (all imported files)', value: this.formatAutoFixTimestampRange(result.gpxFromTimestamp, result.gpxToTimestamp) },
        { label: 'Photo timestamp range (photos scanned)', value: this.formatAutoFixTimestampRange(result.photoFromTimestamp, result.photoToTimestamp) },
        { label: 'Runtime', value: elapsedText },
        { label: 'Result', value: result.aborted ? 'Aborted — partial results' : checkOnly ? 'Check only — no files changed' : 'GPS correction completed' },
        { label: 'Photos whose files already contain GPS coordinates', value: this.formatAutoFixCount(result.withGps) },
        { label: 'Photos missing GPS coordinates', value: this.formatAutoFixCount(result.withoutGps) },
        { label: 'Photos matched to GPX within the time limit', value: this.formatAutoFixCount(result.matched) },
        { label: 'Photos with no usable GPX match', value: this.formatAutoFixCount(result.unmatched) },
        { label: 'Photos with a GPX match rejected by the time limit', value: this.formatAutoFixCount(result.ignoredTooFar) },
        { label: 'Time deviation of GPX candidates (min / mean / max)', value: deviationStats },
        ...(!checkOnly ? [{ label: 'Photos updated', value: this.formatAutoFixCount(result.updated) }] : []),
        ...(result.errors ? [{ label: 'Errors', value: this.formatAutoFixCount(result.errors) }] : [])
      ]);
    } catch (error) {
      this.autoFixStatus.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.autoFixBusy.set(false);
    }
  };

  protected readonly canSaveGpsPosition = (): boolean => !!this.currentImagePath && !!(this.map || this.offlineRenderer) && !!this.desktop;

  protected readonly saveGpsPosition = async (): Promise<void> => {
    if (!this.fixLocationEnabled() || !this.currentImagePath || (!this.map && !this.offlineRenderer) || !this.desktop || this.gpsSaveBusy()) return;
    const center = this.offlineRenderer
      ? this.offlineRenderer.map.getCenter()
      : this.map!.getCenter();
    if (!Number.isFinite(center.lat) || !Number.isFinite(center.lng)) return;

    if (this.coordinatesAvailable()) {
      const oldPosition = this.currentLatitude !== null && this.currentLongitude !== null
        ? this.formatCoordinates(this.currentLatitude, this.currentLongitude).replace(/^Coordinates: /, '')
        : 'the existing photo location';
      const newPosition = formatSystemGpsCoordinates(center.lat, center.lng);
      const confirmed = window.confirm(
        'This image already contains GPS information.\n\n' +
        'Check both positions on the map before continuing:\n' +
        '• Red crosshair: the newly selected position (' + newPosition + ')\n' +
        '• Location marker: the existing position from the image (' + oldPosition + ')\n\n' +
        'Updating the GPS information will replace the existing position. Continue?'
      );
      if (!confirmed) return;
    }

    this.gpsSaveBusy.set(true);
    this.gpsSaveStatus.set('');
    try {
      const result = await this.desktop.Exif.writeGpsPosition(this.currentImagePath, center.lat, center.lng);
      if (!result.success) throw new Error(result.errorMessage || 'Could not write GPS metadata to the image file.');
      this.currentLatitude = center.lat; this.currentLongitude = center.lng;
      this.coordinatesAvailable.set(true);
      this.coordinateLabel.set(this.formatCoordinates(center.lat, center.lng));
      this.photoCoordinateLabel.set(this.formatCoordinates(center.lat, center.lng).replace(/^Coordinates: /, 'Photo: '));
      this.locationAddress.set('Looking up address…');
      void this.lookupLocationAddress(center.lat, center.lng);
      this.marker?.setLatLng([center.lat, center.lng]);
      this.marker?.setOpacity(this.locationVisible() ? this.locationOpacity() / 100 : 0);

      this.gpsSaveStatus.set('GPS position saved to image file.');
    } catch (error) {
      this.gpsSaveStatus.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.gpsSaveBusy.set(false);
    }
  };

  protected readonly copyCoordinates = async (): Promise<void> => {
    const marker = this.marker?.getLatLng();
    const latitude = marker?.lat ?? this.currentLatitude, longitude = marker?.lng ?? this.currentLongitude;
    if (latitude === null || longitude === null) return;
    try { await navigator.clipboard.writeText(formatSystemGpsCoordinates(latitude, longitude)); }
    catch (error) { console.error('Failed to copy GPS coordinates', error); }
  };
  protected readonly searchOfflineAddresses = async (): Promise<void> => {
    const query = this.offlineAddressQuery().trim();
    if (query.length < 2 || !this.desktop || this.offlineAddressSearchBusy()) return;
    const activePaths = this.offlineMaps()
      .filter(map => map.type === 'obf' && map.enabled && map.available && !!map.filePath)
      .map(map => map.filePath);
    this.offlineAddressSearchBusy.set(true);
    this.offlineAddressSearchError.set('');
    this.offlineAddressSearchResults.set([]);
    try {
      if (!activePaths.length) throw new Error('No enabled and available OsmAnd OBF files are configured in Offline Files.');
      const results = await this.desktop.OsmAndAtlas.searchAddresses(activePaths, query, 0);
      this.offlineAddressSearchResults.set(results);
      if (!results.length) this.offlineAddressSearchError.set('No matching address was found in the enabled OBF files.');
    } catch (error) {
      this.offlineAddressSearchError.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.offlineAddressSearchBusy.set(false);
    }
  };
  protected readonly goToOfflineAddress = (result: import('internal-api').OsmAndAddressSearchResult): void => {
    if (!Number.isFinite(result.latitude) || !Number.isFinite(result.longitude)) return;
    if (this.offlineRenderer) {
      this.offlineRenderer.map.jumpTo({ center: [result.longitude, result.latitude], zoom: Math.max(15, this.offlineRenderer.map.getZoom()) });
    } else if (this.map) {
      this.map.setView([result.latitude, result.longitude], Math.max(15, this.map.getZoom()));
    }
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
  protected readonly formatGpsCoordinates = formatSystemGpsCoordinates;

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
    const decimal = formatSystemGpsCoordinates(latitude, longitude, 5);
    return `Coordinates: ${dms}  |  Decimal: ${decimal}`;
  }

  private recordMapError(source: string, message: string, force = false): void {
    // MapLibre aborts obsolete tile requests during zoom/source changes. These
    // are expected lifecycle cancellations, not renderer failures. Explicit
    // error-status events (notably Hillshade) must still be recorded even when
    // the underlying exception text happens to contain the word "cancelled".
    if (!force && /\b(cancel(?:led|ed|lation)?|abort(?:ed|ion)?)\b/i.test(message)) return;
    const mapSource = this.mapSource();
    const renderer = ({
      online: 'Online map renderer',
      offline: 'MBTiles renderer',
      osmand: 'OsmAnd renderer',
      'osmand-atlas': 'OsmAnd Atlas renderer',
      mapsforge: 'Mapsforge renderer'
    } as const)[mapSource] ?? 'Unknown';
    const style = mapSource === 'osmand' || mapSource === 'osmand-atlas'
      ? this.osmAndStyle()
      : mapSource === 'offline'
        ? this.offlineMapStyle()
        : mapSource === 'online'
          ? this.mapStyle()
          : mapSource === 'mapsforge'
            ? 'Mapsforge'
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

  protected readonly showCrosshairAddress = (): void => {
    if (!this.fixLocationEnabled()) return;
    const center = this.offlineRenderer?.map?.getCenter();
    if (!center) { this.crosshairAddress.set('Map center is not available.'); return; }
    this.crosshairAddress.set('Looking up address…');
    void (async () => {
      try {
        const imagePath = this.currentImagePath;
        let displayName: string | null = null;
        if (imagePath && this.desktop) displayName = await this.desktop.CacheManager.resolvePhotoLocation(imagePath, center.lat, center.lng);
        else displayName = (await lookupReverseGeocoding(center.lat, center.lng, navigator.language || 'en'))?.displayName ?? null;
        this.crosshairAddress.set(displayName || 'No street address available for this location.');
      } catch (error) {
        this.crosshairAddress.set(`Reverse geocoding failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  };

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
  private readWalkingFigureSymbolSettings(): Record<string, TimeSliderSymbolSettings> {
    try {
      const parsed = JSON.parse(this.readSetting('timeSliderSymbolSettings', '{}')) as
        Record<string, Partial<TimeSliderSymbolSettings> & { flipVertical?: boolean }>;
      return this.normalizeWalkingFigureSymbolSettings(parsed ?? {});
    } catch { return {}; }
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
    if (value > 10 && this.mapBoundsVisible()) this.changeMapBoundsVisible(false);
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
    if (this.markerViewportRefreshTimer !== null) window.clearTimeout(this.markerViewportRefreshTimer);
    this.markerViewportRefreshTimer = null;
    this.clearDirectoryMarkers();
    this.markerFilesChecked.set(0);
    this.markerFilesTotal.set(0);
    this.markerStatus.set('');
    this.markerSourceFolder.set('Not loaded.');
  };
  protected readonly changeUseAllPhotosInDb = (enabled: boolean): void => {
    this.useAllPhotosInDb.set(enabled);
    this.saveSetting('useAllPhotosInDb', enabled);
    if (this.directoryMarkersEnabled()) void this.scanDirectoryMarkers();
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
      marker.bindTooltip(buildPhotoMarkerPreviewHtml(item.path, item.fileName, this.photoPreviewSize()), {
        direction: 'top', className: 'folder-marker-tooltip', opacity: 1
      });
      marker.on('click', () => { void this.desktop?.MapWindow.selectImage(item.path); });
      this.directoryMarkers.push(marker);
      this.directoryMarkerGroup?.addLayer(marker);
      this.markerCount.update(value => value + 1);
    }
  }

  private async scanDirectoryMarkers(): Promise<void> {
    const generation = ++this.markerScanGeneration, imagePath = this.currentImagePath, selectedFolderPath = this.currentFolderPath, desktop = this.desktop;
    if ((!imagePath && !selectedFolderPath) || !desktop || (!this.directoryMarkerGroup && !this.offlineRenderer)) {
      this.clearDirectoryMarkers();
      this.markerStatus.set('No image folder is available.');
      return;
    }
    this.clearDirectoryMarkers();
    this.markerStatus.set(this.useAllPhotosInDb() ? 'Reading photo locations in the current map viewport…' : 'Reading location database…');
    this.markerSourceFolder.set(this.useAllPhotosInDb() ? 'All photos in DB · current map viewport' : 'Resolving current image folder…');
    try {
      let records: Awaited<ReturnType<Desktop['CacheManager']['getDirectoryPhotoLocations']>>;
      let imageFiles: Awaited<ReturnType<Desktop['FileSystem']['readImages']>> | null = null;
      if (this.useAllPhotosInDb()) {
        const mapBounds = this.offlineRenderer?.map.getBounds() ?? this.map?.getBounds();
        if (!mapBounds) {
          this.markerStatus.set('The map is not ready yet.');
          return;
        }
        const bounds = {
          west: mapBounds.getWest(),
          south: Math.max(-90, mapBounds.getSouth()),
          east: mapBounds.getEast(),
          north: Math.min(90, mapBounds.getNorth())
        };
        if (bounds.west < -180 || bounds.east > 180 || bounds.west > bounds.east) {
          this.markerStatus.set('The current map viewport crosses the date line; this query is not supported yet.');
          return;
        }
        const databasePath = selectedFolderPath ?? imagePath ?? '';
        const databaseKey = /^[a-z]:[\\/]/i.test(databasePath) ? databasePath.slice(0, 2) : '';
        if (!databaseKey) {
          this.markerSourceFolder.set('All photos in DB · unsupported image drive');
          this.markerStatus.set('The current image is not on a supported cache database drive.');
          return;
        }
        this.markerSourceFolder.set('All photos in DB · ' + databaseKey + ' · current map viewport');
        records = await desktop.CacheManager.getPhotoLocationsInBounds(bounds, databaseKey);
      } else {
        const directory = selectedFolderPath ?? await desktop.FileSystem.dirname(imagePath!);
        if (generation !== this.markerScanGeneration || !this.directoryMarkersEnabled()) return;
        this.markerSourceFolder.set(directory);
        [records, imageFiles] = await Promise.all([
          desktop.CacheManager.getDirectoryPhotoLocations(directory),
          desktop.FileSystem.readImages(directory, 'name', 'asc')
        ]);
      }
      if (generation !== this.markerScanGeneration || !this.directoryMarkersEnabled()) return;
      const modifiedAtByName = new Map(
        (imageFiles?.success ? imageFiles.data : [])
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
      this.directoryPhotoTimestampMarkers = markers.map(item => ({ ...item }));
      this.directoryPhotoMarkers = markers.filter(item => !imagePath || item.path.toLowerCase() !== imagePath.toLowerCase()).map(item => ({ ...item }));
      this.updateTimeSliderBounds();
      this.applyDirectoryPhotoMarkers();
      this.applyCurrentPhotoVisibility();
      if (this.offlineRenderer) this.offlineRenderer.setPhotoClusterStyle(this.markerColor(), this.markerColorVisible(), this.markerShape());
      this.markerStatus.set(this.useAllPhotosInDb()
        ? 'Loaded ' + records.length + ' photo location(s) from the cache database in the current map viewport.'
        : 'Loaded ' + records.length + ' database records; ' + markers.length + ' GPS location NAME(s) found.');
    } catch (error) {
      if (generation === this.markerScanGeneration) this.markerStatus.set(error instanceof Error ? error.message : 'Location database query failed.');
    }
  }
  private async initialize(latitude: number, longitude: number): Promise<void> {
    // Restore persisted mapWindow values before creating any renderer. In
    // particular, Mapsforge must receive the saved opacity on its first style.
    await this.mapWindowConfigRestore;
    await this.mapZoomRestore;
    // Do not let the initial map request apply the stale renderer-local
    // default before the shared persisted OsmAnd style has been restored.
    await this.osmAndStyleRestore;
    await this.rendererTransition;
    let generation = this.mapSourceGeneration;
    if (this.mapSource() === 'mapsforge') {
      if (this.offlineRenderer) {
        this.offlineRenderer.updateCurrentLocation(latitude, longitude);
        this.offlineRenderer.map.easeTo({ center: [longitude, latitude] });
        return;
      }
      if (this.mapInitialization) await this.mapInitialization;
      if (generation !== this.mapSourceGeneration || this.mapSource() !== 'mapsforge' || this.offlineRenderer) return;
      const initialization = this.createMapsforgeMap(latitude, longitude, generation);
      this.mapInitialization = initialization;
      try { await initialization; } finally { if (this.mapInitialization === initialization) this.mapInitialization = null; }
      return;
    }
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
        const hasActiveMbtiles = this.offlineMaps().some(map => map.enabled && (!map.type || map.type === 'mbtiles'));
        this.mapDisplayNotice.set(hasActiveMbtiles
          ? 'No active .mbtiles map covers the current location. Check the map bounds in Offline.'
          : 'No .mbtiles active. Activate an MBTiles map in Offline.');
        // Do not silently substitute the online basemap: that makes switching
        // to MBTiles appear to work while showing exactly the same online map.
        this.offlineRenderer?.remove(); this.offlineRenderer = null;
        this.map?.remove(); this.map = null;
        this.leafletHillshadeLayer = null; this.leafletHillshadePane = null;
        this.marker = null; this.directoryMarkerGroup = null;
        this.tileLayer?.remove(); this.tileLayer = null;
        this.clearDirectoryMarkers();
        return;
      }
      this.mapDisplayNotice.set('');
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
    this.applyMapBoundsVisibility();
    const latestLatitude = this.currentLatitude ?? latitude;
    const latestLongitude = this.currentLongitude ?? longitude;
    renderer.setCurrentLocation(latestLatitude, latestLongitude, this.currentMarkerColor(), (this.locationVisible() ? this.locationOpacity() / 100 : 0), this.currentMarkerShape());
    renderer.setTextLabelOpacity(this.labelsVisible() ? this.labelOpacity() / 100 : 0);
    renderer.map.jumpTo({ center: [latestLongitude, latestLatitude] });
    this.applyMapColor(); this.applyMapOpacity();
    this.applyHillshadeSettings(renderer);
    const syncOfflineZoom = (): void => this.persistZoom(renderer.map.getZoom());
    renderer.map.on('movestart', () => this.resetLastRenderCountsForViewport());
    renderer.map.on('moveend', () => this.scheduleGpxDatabaseViewportRefresh());
    renderer.map.on('zoomend', syncOfflineZoom);
    renderer.map.on('contextmenu', event => {
      if (!this.settingsOpen() || this.activeSettingsTab() !== 'routing') return;
      event.originalEvent.preventDefault();
      this.addRouteWaypoint(event.lngLat.lat, event.lngLat.lng);
    });
    this.updateRouteWaypointMarkers();
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

    registerOsmAndAtlasTileProtocol(this.desktop, () => this.displayDensityFactor());
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
    this.applyMapBoundsVisibility();

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
    await this.updateActiveObfMapsForViewport(renderer, 'osmand-atlas');
    try { renderer.refreshVisibleTiles(); } catch (error) { console.warn('[OsmAnd Atlas] Initial visible-tile refresh failed:', error); }
    this.applyMapColor();
    this.applyMapOpacity();
    this.applyHillshadeSettings(renderer);
    // Invalidate queued requests from the previous viewport during movement.
    // Once the camera settles, give MapLibre a fresh source identity so it
    // requests every tile for the final viewport again.
    let viewportRefreshTimer: number | null = null;
    let previousViewportZoom = renderer.map.getZoom();
    let viewportZoomChanged = false;
    renderer.map.on('movestart', () => {
      if (viewportRefreshTimer !== null) window.clearTimeout(viewportRefreshTimer);
      this.resetLastRenderCountsForViewport();
    });
    renderer.map.on('moveend', () => {
      const settledZoom = renderer.map.getZoom();
      if (Math.abs(settledZoom - previousViewportZoom) > 0.001) {
        previousViewportZoom = settledZoom;
        viewportZoomChanged = true;
      }
      if (viewportRefreshTimer !== null) window.clearTimeout(viewportRefreshTimer);
      viewportRefreshTimer = window.setTimeout(() => {
        viewportRefreshTimer = null;
        const cancelObsolete = viewportZoomChanged;
        viewportZoomChanged = false;
        const cancel = cancelObsolete
          ? this.desktop?.OsmAndAtlas.cancelRendering() ?? Promise.resolve()
          : Promise.resolve();
        void cancel.then(() => this.updateActiveObfMapsForViewport(renderer, 'osmand-atlas')).then(() => {
          const source = renderer.map.getSource('osmand-atlas') as { setTiles?: (tiles: string[]) => unknown } | undefined;
          if (source?.setTiles) source.setTiles(['osmand-atlas://{z}/{x}/{y}?refresh=' + Date.now()]);
        }).catch(error => console.warn('[OsmAnd Atlas] Could not refresh viewport OBF tiles:', error));
      }, 180);
    });
    renderer.map.on('zoomend', () => this.persistZoom(renderer.map.getZoom()));
    renderer.map.on('moveend', () => this.scheduleGpxDatabaseViewportRefresh());
    renderer.map.on('contextmenu', event => {
      if (!this.settingsOpen() || this.activeSettingsTab() !== 'routing') return;
      event.originalEvent.preventDefault();
      this.addRouteWaypoint(event.lngLat.lat, event.lngLat.lng);
    });
    this.updateRouteWaypointMarkers();
    this.persistZoom(renderer.map.getZoom());
    if (this.directoryMarkersEnabled()) void this.scanDirectoryMarkers();
    await this.restoreGpxTrack();
    this.applyOpacitySettings();
    window.addEventListener('resize', this.onResize);
  }

  private async createMapsforgeMap(latitude: number, longitude: number, generation: number): Promise<void> {
    if (generation !== this.mapSourceGeneration || this.mapSource() !== 'mapsforge') return;
    this.renderInitStatus.set('Render init …');
    if (!this.desktop) {
      this.renderInitStatus.set('');
      this.mapDisplayNotice.set('Desktop API is not connected.');
      return;
    }
    const maps = this.offlineMaps().filter(map => map.type === 'mapsforge' && map.enabled && map.available);
    if (maps.length === 0) {
      this.renderInitStatus.set('');
      // Do not report a missing-map error while the initial offline catalogue is still loading.
      // The catalogue completion handler restarts Mapsforge initialization with the loaded entries.
      if (!this.offlineMapsLoaded()) return;
      this.mapDisplayNotice.set('No active Mapsforge .map files. Add and activate Mapsforge maps in Offline.');
      this.recordMapError('Mapsforge', 'No active Mapsforge .map files are loaded.');
      return;
    }
    try {
      await this.desktop.Mapsforge.open(maps.map(map => map.filePath), this.mapsforgeThemePath() || null, this.displayDensityFactor());
      if (generation !== this.mapSourceGeneration || this.mapSource() !== 'mapsforge') {
        // changeMapSource() already queued close() after this open request.
        // Closing again here is unsafe: a rapid switch back to Mapsforge may
        // have queued a newer open(), which this stale continuation would close.
        return;
      }
      registerMapsforgeTileProtocol(this.desktop);
      setMapsforgeTileProtocolActive(true);
      this.mapDisplayNotice.set('');
      const renderer = new OfflineMapRenderer(
        this.mapElement().nativeElement,
        [longitude, latitude],
        this.validZoom(this.zoomLevel()),
        message => {
          if (generation !== this.mapSourceGeneration || /\b(cancelled|canceled)\b/i.test(message)) return;
          this.recordMapError('Mapsforge rendering', message);
          console.error('[Mapsforge] Tile rendering error:', message);
        },
        'lumascope', '', 0, 22, undefined, 'shortbread', [], createMapsforgeMapStyle()
      );
      this.offlineRenderer = renderer;
      window.dispatchEvent(new CustomEvent('lumascope-osmand-tile-visuals', { detail: { enabled: this.renderVisualsEnabled() } }));
      try {
        await renderer.ready;
      } catch (error) {
        renderer.remove();
        if (this.offlineRenderer === renderer) this.offlineRenderer = null;
        throw error;
      }
      if (generation !== this.mapSourceGeneration || this.mapSource() !== 'mapsforge') {
        renderer.remove();
        if (this.offlineRenderer === renderer) this.offlineRenderer = null;
        await this.desktop.Mapsforge.close();
        return;
      }
      renderer.map.on('style.load', () => {
        if (generation === this.mapSourceGeneration && this.offlineRenderer === renderer) this.applyMapOpacity();
      });
      renderer.map.once('idle', () => {
        if (generation === this.mapSourceGeneration && this.offlineRenderer === renderer) this.applyOpacitySettings();
      });
      this.applyMapBoundsVisibility();
      const latestLatitude = this.currentLatitude ?? latitude;
      const latestLongitude = this.currentLongitude ?? longitude;
      renderer.setCurrentLocation(latestLatitude, latestLongitude, this.currentMarkerColor(),
        (this.locationVisible() ? this.locationOpacity() / 100 : 0), this.currentMarkerShape());
      renderer.map.jumpTo({ center: [latestLongitude, latestLatitude] });
      this.applyMapColor();
      this.applyMapOpacity();
      this.applyHillshadeSettings(renderer);
      renderer.map.on('zoomend', () => this.persistZoom(renderer.map.getZoom()));
      renderer.map.on('moveend', () => this.scheduleGpxDatabaseViewportRefresh());
      renderer.map.on('movestart', () => this.resetLastRenderCountsForViewport());
      renderer.map.on('contextmenu', event => {
      if (!this.settingsOpen() || this.activeSettingsTab() !== 'routing') return;
      event.originalEvent.preventDefault();
      this.addRouteWaypoint(event.lngLat.lat, event.lngLat.lng);
    });
      this.updateRouteWaypointMarkers();
      this.persistZoom(renderer.map.getZoom());
      if (this.directoryMarkersEnabled()) void this.scanDirectoryMarkers();
      await this.restoreGpxTrack();
      this.applyOpacitySettings();
      // Mapsforge can finish its first style/tile pass after renderer.ready.
      // Reapply the persisted basemap opacity once the initial viewport is idle.
      renderer.map.once('idle', () => {
        if (generation === this.mapSourceGeneration && this.offlineRenderer === renderer) this.applyMapOpacity();
      });
      window.addEventListener('resize', this.onResize);
    } catch (error) {
      if (generation !== this.mapSourceGeneration) return;
      this.renderInitStatus.set('');
      const message = error instanceof Error ? error.message : String(error);
      this.mapDisplayNotice.set('Mapsforge renderer could not be initialized: ' + message);
      this.recordMapError('Mapsforge initialization', message);
      console.error('[Mapsforge] Initialization failed:', error);
    } finally {
      if (generation === this.mapSourceGeneration) this.renderInitStatus.set('');
    }
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
    renderer.map.on('style.load', () => {
      if (generation === this.mapSourceGeneration && this.offlineRenderer === renderer) this.applyMapOpacity();
    });
    renderer.map.once('idle', () => {
      if (generation === this.mapSourceGeneration && this.offlineRenderer === renderer) this.applyOpacitySettings();
    });
    this.applyMapBoundsVisibility();

    const latestLatitude = this.currentLatitude ?? latitude;
    const latestLongitude = this.currentLongitude ?? longitude;
    renderer.setCurrentLocation(
      latestLatitude, latestLongitude, this.currentMarkerColor(),
      (this.locationVisible() ? this.locationOpacity() / 100 : 0), this.currentMarkerShape()
    );
    renderer.map.jumpTo({ center: [latestLongitude, latestLatitude] });
    await this.updateActiveObfMapsForViewport(renderer, 'osmand');
    try { renderer.refreshVisibleTiles(); } catch (error) { console.warn('[OsmAnd] Initial visible-tile refresh failed:', error); }
    this.applyMapColor();
    this.applyMapOpacity();
    this.applyHillshadeSettings(renderer);
    renderer.map.on('zoomend', () => this.persistZoom(renderer.map.getZoom()));
    renderer.map.on('moveend', () => this.scheduleGpxDatabaseViewportRefresh());
    let obfViewportTimer: number | null = null;
    let previousObfZoom = renderer.map.getZoom();
    let obfZoomChanged = false;
    renderer.map.on('movestart', () => {
      if (obfViewportTimer !== null) window.clearTimeout(obfViewportTimer);
      this.resetLastRenderCountsForViewport();
    });
    renderer.map.on('moveend', () => {
      const settledZoom = renderer.map.getZoom();
      if (Math.abs(settledZoom - previousObfZoom) > 0.001) {
        previousObfZoom = settledZoom;
        obfZoomChanged = true;
      }
      if (obfViewportTimer !== null) window.clearTimeout(obfViewportTimer);
      obfViewportTimer = window.setTimeout(() => {
        obfViewportTimer = null;
        const cancelObsolete = obfZoomChanged;
        obfZoomChanged = false;
        const cancel = cancelObsolete
          ? this.desktop?.OsmAnd.cancelRendering() ?? Promise.resolve()
          : Promise.resolve();
        void cancel.then(() => this.updateActiveObfMapsForViewport(renderer, 'osmand')).then(() => {
          const source = renderer.map.getSource('osmand') as { setTiles?: (tiles: string[]) => unknown } | undefined;
          if (source?.setTiles) source.setTiles(['osmand://{z}/{x}/{y}?refresh=' + Date.now()]);
        }).catch(error => console.warn('[OsmAnd] Could not refresh viewport OBF tiles:', error));
      }, 180);
    });
    renderer.map.on('contextmenu', event => {
      if (!this.settingsOpen() || this.activeSettingsTab() !== 'routing') return;
      event.originalEvent.preventDefault();
      this.addRouteWaypoint(event.lngLat.lat, event.lngLat.lng);
    });
    this.updateRouteWaypointMarkers();
    this.persistZoom(renderer.map.getZoom());
    if (this.directoryMarkersEnabled()) void this.scanDirectoryMarkers();
    await this.restoreGpxTrack();
    this.applyOpacitySettings();
    window.addEventListener('resize', this.onResize);
  }

  private async createMap(latitude: number, longitude: number, generation: number): Promise<void> {
    this.offlineRenderer?.remove(); this.offlineRenderer = null;
    const leaflet = await this.loadLeaflet();
    if (generation !== this.mapSourceGeneration || this.mapSource() !== 'online') return;
    this.leaflet = leaflet;
    const center: [number, number] = [latitude, longitude];
    const map = this.leaflet.map(this.mapElement().nativeElement, { zoomControl: false, keyboard: false, minZoom: 1, maxZoom: 20 })
      .setView(center, this.validZoom(this.zoomLevel()));
    this.map = map;
    this.applyMapBoundsVisibility();
    map.on('contextmenu', event => {
      if (!this.settingsOpen() || this.activeSettingsTab() !== 'routing') return;
      event.originalEvent.preventDefault();
      this.addRouteWaypoint(event.latlng.lat, event.latlng.lng);
    });
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
    const syncZoom = (): void => { this.persistZoom(map.getZoom()); this.applyGpxTrack(); };
    map.on('zoomend', syncZoom);
    (map as unknown as { on: (event: 'moveend', callback: () => void) => unknown })
      .on('moveend', () => this.scheduleGpxDatabaseViewportRefresh());
    this.updateRouteWaypointMarkers();
    this.marker = this.leaflet.marker(center, { icon: this.createCurrentLocationIcon() }).addTo(this.map).setOpacity((!this.coordinatesAvailable() ? 0 : this.locationVisible() ? this.locationOpacity() / 100 : 0));
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
    if (value !== 'online' && value !== 'offline' && value !== 'osmand' && value !== 'osmand-atlas' && value !== 'mapsforge') return;
    // MBTiles selection is validated against enabled maps and geographic bounds during initialization.
    const nextSource = value;
    const previousSource = this.mapSource();
    // Stop late requests from a map instance that is being replaced.
    setMapsforgeTileProtocolActive(false);
    if (nextSource !== 'offline') this.mapDisplayNotice.set('');
    this.renderInitStatus.set('');
    if (previousSource !== nextSource) {
      // Serialize teardown before the next renderer initializes. Atlas may have
      // many queued OBF tiles; Mapsforge must not wait for their 30-second timeout.
      this.rendererTransition = this.rendererTransition.then(async () => {
        if (previousSource === 'osmand-atlas' && nextSource !== 'osmand-atlas') {
          await this.desktop?.OsmAndAtlas.cancelRendering();
          await this.desktop?.OsmAndAtlas.shutdown();
        }
        if (previousSource === 'osmand' && nextSource !== 'osmand') {
          await this.desktop?.OsmAnd.shutdown();
        }
        if (previousSource === 'mapsforge' && nextSource !== 'mapsforge') {
          await this.desktop?.Mapsforge.close();
        }
      }).catch(error => console.warn('Could not stop previous map renderer:', error));
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

  private async enrichObfMetadata(
    maps: import('internal-api').OfflineMapStatus[],
    resourcesAvailable?: boolean
  ): Promise<import('internal-api').OfflineMapStatus[]> {
    const obfMaps = maps.filter(map => map.type === 'obf' && map.available);
    if (!obfMaps.length) return maps;
    try {
      const desktop = this.desktop;
      if (!desktop) return maps;
      const available = resourcesAvailable ?? (await desktop.OsmAndAtlas.getRuntimeStatus()).resourcesAvailable;
      if (!available) return maps;
      const metadata = await desktop.OsmAndAtlas.getObfMetadata(obfMaps.map(map => map.filePath));
      const byPath = new Map(metadata.map(item => [item.filePath.toLocaleLowerCase(), item]));
      return maps.map(map => {
        if (map.type !== 'obf') return map;
        const item = byPath.get(map.filePath.toLocaleLowerCase());
        if (!item) return { ...map, minZoom: 0, maxZoom: 0, bounds: null, obfMetadataAvailable: false, obfMetadataError: 'OsmAnd Core returned no metadata for this file.' };
        return {
          ...map,
          minZoom: item.metadataAvailable ? item.minZoom ?? 0 : 0,
          maxZoom: item.metadataAvailable ? item.maxZoom ?? 0 : 0,
          bounds: item.metadataAvailable ? item.bounds ?? null : null,
          obfMetadataAvailable: item.metadataAvailable,
          obfSectionCount: item.sectionCount,
          obfSections: item.sections,
          obfIsBasemap: item.isBasemap,
          obfMetadataError: item.error
        };
      });
    } catch (error) {
      console.warn('[OfflineMap] Could not read OBF metadata from OsmAnd Core:', error);
      return maps.map(map => map.type === 'obf'
        ? { ...map, minZoom: 0, maxZoom: 0, bounds: null, obfMetadataAvailable: false,
            obfMetadataError: error instanceof Error ? error.message : String(error) }
        : map);
    }
  }

  private mergeObfMetadata(maps: import('internal-api').OfflineMapStatus[]): import('internal-api').OfflineMapStatus[] {
    const previous = new Map(this.offlineMaps().map(map => [map.id, map]));
    return maps.map(map => {
      const old = previous.get(map.id);
      return map.type === 'obf' && old?.obfMetadataAvailable !== undefined
        ? { ...map, minZoom: old.minZoom, maxZoom: old.maxZoom, bounds: old.bounds,
            obfMetadataAvailable: old.obfMetadataAvailable, obfSectionCount: old.obfSectionCount,
            obfSections: old.obfSections, obfIsBasemap: old.obfIsBasemap, obfMetadataError: old.obfMetadataError }
        : map;
    });
  }

  protected obfMetadataTooltip(map: import('internal-api').OfflineMapStatus): string {
    if (!map.obfMetadataAvailable) return map.obfMetadataError || 'OBF metadata unavailable';
    const sections = map.obfSections ?? [];
    const details = sections.map(section =>
      section.name + ' (' + section.minZoom + '–' + section.maxZoom + ')');
    if (map.obfIsBasemap) details.unshift('Basemap');
    return details.length ? details.join(' · ') : (map.obfSectionCount ?? 0) + ' map section(s)';
  }

  private async updateActiveObfMapsForViewport(
    renderer: OfflineMapRenderer,
    source: 'osmand' | 'osmand-atlas'
  ): Promise<void> {
    const desktop = this.desktop;
    if (!desktop || this.offlineRenderer !== renderer || this.mapSource() !== source) return;
    const viewport = renderer.map.getBounds();
    const west = viewport.getWest();
    const east = viewport.getEast();
    const south = viewport.getSouth();
    const north = viewport.getNorth();
    const longitudeSpan = Math.min(360, Math.max(0.1, east - west));
    const latitudeSpan = Math.max(0.1, north - south);
    // Keep a 20% geographic overscan so adjacent regional files are ready
    // before the user pans across their border.
    const paddedWest = west - longitudeSpan * 0.2;
    const paddedEast = east + longitudeSpan * 0.2;
    const paddedSouth = Math.max(-85.0511, south - latitudeSpan * 0.2);
    const paddedNorth = Math.min(85.0511, north + latitudeSpan * 0.2);
    const renderZoom = Math.floor(renderer.map.getZoom()) + (source === 'osmand' ? 1 : 0);
    const parseBounds = (value: string | null | undefined): [number, number, number, number] | null => {
      const numbers = value?.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
      return numbers.length === 4 && numbers.every(Number.isFinite)
        ? [numbers[0], numbers[1], numbers[2], numbers[3]] : null;
    };
    const longitudeIntersects = (mapWest: number, mapEast: number): boolean => {
      const mapSegments = mapWest <= mapEast ? [[mapWest, mapEast]] : [[mapWest, 180], [-180, mapEast]];
      const viewSegments = paddedEast - paddedWest >= 360
        ? [[-180, 180]]
        : paddedWest < -180
          ? [[paddedWest + 360, 180], [-180, paddedEast]]
          : paddedEast > 180
            ? [[paddedWest, 180], [-180, paddedEast - 360]]
            : [[paddedWest, paddedEast]];
      return mapSegments.some(([a, b]) => viewSegments.some(([c, d]) => a <= d && b >= c));
    };
    const intersects = (value: string | null | undefined): boolean => {
      const bounds = parseBounds(value);
      if (!bounds) return false;
      const [mapWest, mapSouth, mapEast, mapNorth] = bounds;
      return mapSouth <= paddedNorth && mapNorth >= paddedSouth
        && longitudeIntersects(mapWest, mapEast);
    };
    const enabledMaps = this.offlineMaps().filter(map =>
      map.type === 'obf' && map.enabled && map.available && !!map.filePath);
    if (!enabledMaps.length) {
      // Offline Files may still be loading while the first map tiles are requested.
      // Do not replace the manager's configured active OBF set with an empty list.
      console.info('[OsmAnd] Viewport OBF selection deferred: no enabled OBF entries are loaded yet.');
      return;
    }
    let selected: typeof enabledMaps;
    if (!this.optimizedObfSelectionEnabled()) {
      // Compatibility mode: pass every enabled OBF file to the renderer,
      // matching the pre-viewport-selection behavior.
      selected = enabledMaps;
    } else {
      const basemaps = enabledMaps.filter(map => map.obfIsBasemap
        || /world[_ -]?basemap|world[_ -]?map/i.test((map.fileName || '') + ' ' + map.name));
      const regionalMaps = enabledMaps.filter(map => !basemaps.includes(map) && (() => {
        const levels = (map.obfSections ?? []).flatMap(section => section.levels ?? []);
        if (levels.length) {
          return levels.some(level => renderZoom >= level.minZoom && renderZoom <= level.maxZoom
            && intersects(level.bounds));
        }
        return renderZoom >= (map.minZoom || 0) && renderZoom <= (map.maxZoom || 30)
          && intersects(map.bounds);
      })());
      selected = [...regionalMaps, ...basemaps];
      if (!regionalMaps.length && !basemaps.length) {
        // Older/partially indexed OBF files remain usable as a conservative fallback.
        selected = enabledMaps.filter(map => !map.obfMetadataAvailable || intersects(map.bounds));
      }
      if (!selected.length && enabledMaps.length) selected = enabledMaps;
    }
    const selectedIds = selected.map(map => map.id);
    this.viewportObfMapIds.set(selectedIds);
    const paths = selected.map(map => map.filePath);
    try {
      if (source === 'osmand-atlas') await desktop.OsmAndAtlas.setActiveObfMaps(paths);
      else await desktop.OsmAnd.setActiveObfMaps(paths);
    } catch (error) {
      console.warn('[OsmAnd] Could not update viewport OBF selection:', error);
    }
  }

  protected readonly checkOffline = async (): Promise<void> => {
    const desktop = this.desktop;
    if (!desktop || this.offlineFilesCheckBusy()) return;
    this.offlineFilesCheckBusy.set(true);
    this.offlineFilesChecked.set(false);
    this.offlineFilesCheckStatus.set('Checking offline files and resource status…');
    try {
      const [maps, hillshade, valhalla, osmandStatus, atlasStatus] = await Promise.all([
        desktop.OfflineMap.checkFiles(),
        desktop.OsmAndAtlas.getHillshadeDatabases(),
        desktop.Valhalla.getRuntimeStatus(),
        desktop.OsmAnd.getRuntimeStatus(),
        desktop.OsmAndAtlas.getRuntimeStatus()
      ]);
      const mapsWithMetadata = await this.enrichObfMetadata(maps, atlasStatus.resourcesAvailable);
      this.offlineMaps.set(mapsWithMetadata);
      this.offlineMapsLoaded.set(true);
      this.applyMapBoundsVisibility();
      this.hillshadeDatabases.set(hillshade);
      this.valhallaConfigurations.set(valhalla.configurations ?? []);
      if (valhalla.configPath) this.routeValhallaConfigPath.set(valhalla.configPath);
      this.osmAndResourcesPath.set(osmandStatus.resourcesPath || atlasStatus.resourcesPath || '');
      this.osmAndResourcesError.set(osmandStatus.resourcesAvailable && atlasStatus.resourcesAvailable ? '' : 'The configured OsmAnd resources folder is missing or unavailable.');
      this.refreshOfflineMapDuplicateIndex(maps);
      this.refreshHillshadeDuplicateIndex(hillshade);
      this.refreshValhallaDuplicateIndex(valhalla.configurations ?? []);
      this.updateHillshadePresetFromSelection(hillshade);
      this.mapsforgeThemeDuplicatePaths.set(new Set());
      this.mapsforgeThemeError.set('');
      if (this.mapsforgeThemeFolder()) {
        try {
          const themes = await desktop.Mapsforge.scanThemes(this.mapsforgeThemeFolder());
          this.mapsforgeThemes.set(themes);
          this.refreshMapsforgeThemeDuplicateIndex(themes);
        } catch (error) {
          this.mapsforgeThemes.set([]);
          this.mapsforgeThemeError.set(error instanceof Error ? error.message : String(error));
        }
      } else {
        this.mapsforgeThemes.set([]);
      }
      this.offlineMapPreset.set(this.getOfflineMapPresetForMaps(mapsWithMetadata) ?? 'custom');
      this.offlineFilesChecked.set(true);
      this.applyHillshadeSettingsIfReady(true);
      this.offlineFilesCheckStatus.set('Check completed · ' + maps.length + ' maps · ' + hillshade.length + ' Hillshade · ' +
        (this.offlineMapMissingCount() + this.hillshadeMissingCount()) + ' missing · ' +
        (this.offlineMapDuplicateCount() + this.hillshadeDuplicateCount()) + ' duplicates · ' +
        (this.activeOfflineMapCount() + this.activeHillshadeDatabaseCount()) + ' active · ' +
        this.valhallaMissingCount() + ' missing Valhalla config(s) · ' + this.valhallaDuplicateCount() + ' duplicate Valhalla config(s) · ' + this.mapsforgeThemeDuplicateCount() + ' duplicate theme(s) · ' + (this.mapsforgeThemes().length === 0 ? 'Mapsforge themes missing · ' : 'Mapsforge themes OK · ') +
        (osmandStatus.resourcesAvailable && atlasStatus.resourcesAvailable ? 'OsmAnd resources OK' : 'OsmAnd resources missing'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.offlineFilesCheckStatus.set('Check failed: ' + message);
      this.recordMapError('Offline files check', message);
    } finally {
      this.offlineFilesCheckBusy.set(false);
    }
  };

  protected readonly openResourcePackageHelp = (): void => {
    void this.desktop?.MapWindow.openHelpDocument('resource-package-format.md');
  };

  protected readonly openGpxCacheHelp = (): void => {
    void this.desktop?.MapWindow.openHelpDocument('gpx-cache.md');
  };

  protected readonly openLocationFixManualHelp = (): void => {
    void this.desktop?.MapWindow.openHelpDocument('location-fix-manual.md');
  };

  private readonly getAutoFixLogPaths = async (): Promise<{ file: string; folder: string }> => {
    if (!this.desktop) throw new Error('Desktop API is unavailable.');
    const paths = await this.desktop.ProcessManager.getSystemPaths();
    const file = await this.desktop.FileSystem.join(paths.userData, 'gps-auto-fix-debug.log');
    return { file, folder: paths.userData };
  };

  protected readonly openAutoFixLogFile = async (): Promise<void> => {
    if (!this.desktop) return;
    try {
      const paths = await this.getAutoFixLogPaths();
      const error = await this.desktop.ProcessManager.openPath(paths.file);
      if (error) this.autoFixStatus.set('Could not open GPS Auto Fix log: ' + error);
    } catch (error) {
      this.autoFixStatus.set('Could not open GPS Auto Fix log: ' + (error instanceof Error ? error.message : String(error)));
    }
  };

  protected readonly openAutoFixLogFolder = async (): Promise<void> => {
    if (!this.desktop) return;
    try {
      const paths = await this.getAutoFixLogPaths();
      const error = await this.desktop.ProcessManager.openPath(paths.folder);
      if (error) this.autoFixStatus.set('Could not open GPS Auto Fix log folder: ' + error);
    } catch (error) {
      this.autoFixStatus.set('Could not open GPS Auto Fix log folder: ' + (error instanceof Error ? error.message : String(error)));
    }
  };

  protected readonly openLocationFixAutomaticHelp = (): void => {
    void this.desktop?.MapWindow.openHelpDocument('location-fix-automatic.md');
  };

  protected readonly openOfflineAddressSearchHelp = (): void => {
    void this.desktop?.MapWindow.openHelpDocument('offline-address-search.md');
  };

  protected readonly openTrackTabHelp = (): void => {
    void this.desktop?.MapWindow.openHelpDocument('track-tab.md');
  };

  protected readonly openPhotoMarkersTabHelp = (): void => {
    void this.desktop?.MapWindow.openHelpDocument('photo-markers-tab.md');
  };

  protected readonly openTimeSliderHelp = (): void => {
    void this.desktop?.MapWindow.openHelpDocument('time-slider.md');
  };

  protected readonly openRoutingHelp = (): void => {
    void this.desktop?.MapWindow.openHelpDocument('routing.md');
  };

  protected readonly scanResourcePackage = async (): Promise<void> => {
    if (!this.desktop || this.resourcePackageScanBusy()) return;
    const previousSettings = await this.desktop.ProcessManager.getAppSettings();
    const offlineSettings = previousSettings['offline'] && typeof previousSettings['offline'] === 'object'
      ? previousSettings['offline'] as Record<string, unknown>
      : {};
    const lastScanFolder = typeof offlineSettings['resourcePackageLastFolder'] === 'string'
      ? offlineSettings['resourcePackageLastFolder']
      : undefined;
    const folder = await this.desktop.Dialogs.openFolder(lastScanFolder);
    if (!folder.success) return;
    await this.desktop.ProcessManager.setAppSettingsSection('offline', {
      resourcePackageLastFolder: folder.data
    });
    this.resourcePackageScanBusy.set(true);
    this.offlineFilesChecked.set(false);
    this.offlineFilesCheckStatus.set('');
    this.resourcePackageScanError.set('');
    this.resourcePackageScanFound.set('');
    this.resourcePackageScanChanged.set('');
    this.resourcePackageEntries.set([]);
    this.resourcePackageScanStatus.set('Scanning extracted resource package…');
    try {
      const scan = await this.desktop.OfflineMap.scanResourcePackage(folder.data);
      this.resourcePackageEntries.set(scan.resourceEntries ?? []);
      const settings = await this.desktop.ProcessManager.getAppSettings();
      const offlineFileEntries = Array.isArray((settings['offline'] as Record<string, unknown> | undefined)?.['paths'])
        ? (settings['offline'] as Record<string, unknown>)['paths'] as Array<{ type?: string; path?: string; enabled?: boolean; size?: number; name?: string; sourcePath?: string }>
        : [];
      const valhallaBefore = await this.desktop.Valhalla.getRuntimeStatus();
      const existingResources = offlineFileEntries.find(entry => entry.type === 'osmand-resources')?.path ?? '';
      const existingThemeFolder = offlineFileEntries.find(entry => entry.type === 'mapsforge-theme-folder')?.path ?? '';
      const hasExistingPaths = !!(existingResources || existingThemeFolder || valhallaBefore.configPath || valhallaBefore.configurations?.length);
      const overwrite = !hasExistingPaths || window.confirm(
        'Existing local resource paths are already configured.\n\n' +
        'Yes: replace the OsmAnd resources folder, Mapsforge theme folder and active Valhalla configuration with resources found in this package.\n' +
        'No: keep the existing resource folders and active routing configuration; discovered Valhalla configurations are added.\n' +
        'Offline map and Hillshade lists are synchronized to the scanned package in either case. Entries not found in the package are removed from LumaScope only; files on disk are never deleted.'
      );

      const normalizePath = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase();
      const mapPaths = [...scan.obfFiles, ...scan.mbtilesFiles, ...scan.mapsforgeFiles];
      const previousMapPaths = new Set(this.offlineMaps().map(map => normalizePath(map.filePath)));
      const wantedMapPaths = new Set(mapPaths.map(normalizePath));
      const mapsRemoved = [...previousMapPaths].filter(path => !wantedMapPaths.has(path)).length;
      const importResult = await this.desktop.OfflineMap.reconcileFiles(mapPaths);
      const mapsAdded = importResult.maps.filter(map => !previousMapPaths.has(normalizePath(map.filePath))).length;
      this.offlineMaps.set(await this.enrichObfMetadata(importResult.maps));
      this.applyMapBoundsVisibility();
      this.offlineMapImportErrors.set(importResult.errors);

      const previousHillshadePaths = new Set(this.hillshadeDatabases().map(database => normalizePath(database.path)));
      const wantedHillshadePaths = new Set(scan.hillshadeFiles.map(normalizePath));
      const hillshadeRemoved = [...previousHillshadePaths].filter(path => !wantedHillshadePaths.has(path)).length;
      const databases = await this.desktop.OsmAndAtlas.reconcileHillshadeDatabasePaths(scan.hillshadeFiles);
      const hillshadeAdded = databases.filter(database => !previousHillshadePaths.has(normalizePath(database.path))).length;
      this.hillshadeDatabases.set(databases);
      this.updateHillshadePresetFromSelection(databases);
      this.applyHillshadeSettingsIfReady(true);

      let valhallaStatus = valhallaBefore;
      let valhallaRemoved = 0;
      if (overwrite) {
        const wantedValhallaPaths = new Set(scan.valhallaConfigs.map(normalizePath));
        for (const configuration of valhallaStatus.configurations ?? []) {
          if (!wantedValhallaPaths.has(normalizePath(configuration.path))) {
            valhallaStatus = await this.desktop.Valhalla.removeConfig(configuration.path);
            valhallaRemoved++;
          }
        }
      }
      const previousValhallaPaths = new Set((valhallaStatus.configurations ?? []).map(configuration => normalizePath(configuration.path)));
      let valhallaAdded = 0;
      if (scan.valhallaConfigs.length) {
        valhallaStatus = await this.desktop.Valhalla.addConfigsFromPaths(scan.valhallaConfigs);
        valhallaAdded = (valhallaStatus.configurations ?? []).filter(configuration => !previousValhallaPaths.has(normalizePath(configuration.path))).length;
      }
      if (overwrite && scan.valhallaConfigs[0]) {
        valhallaStatus = await this.desktop.Valhalla.setConfigPath(scan.valhallaConfigs[0]);
      }
      this.valhallaConfigurations.set(valhallaStatus.configurations ?? []);
      this.routeValhallaConfigPath.set(valhallaStatus.configPath || '');

      let resourcesApplied = false;
      if (overwrite && scan.osmAndResourcesPath) {
        await this.desktop.OsmAndAtlas.setResourcesPath(scan.osmAndResourcesPath);
        await this.desktop.OsmAnd.setResourcesPath(scan.osmAndResourcesPath);
        this.osmAndResourcesPath.set(scan.osmAndResourcesPath);
        this.osmAndStyles.set(await this.desktop.OsmAndAtlas.getRenderingStyles());
        resourcesApplied = true;
      }

      let themesFound = 0;
      let themeNames: string[] = [];
      if (scan.mapsforgeThemeFolder) {
        const themes = await this.desktop.Mapsforge.scanThemes(scan.mapsforgeThemeFolder);
        themesFound = themes.length;
        themeNames = themes.map(theme => theme.relativePath);
        if (overwrite) {
          this.mapsforgeThemeFolder.set(scan.mapsforgeThemeFolder);
          this.mapsforgeThemes.set(themes);
          const previousTheme = offlineFileEntries.find(entry => entry.type === 'mapsforge-theme' && entry.enabled !== false)?.path ?? '';
          const selectedTheme = themes.find(theme => theme.path === previousTheme) ?? themes[0];
          const selectedPath = selectedTheme?.path ?? '';
          this.mapsforgeThemePath.set(selectedPath);
          await this.desktop.ProcessManager.setAppSettingsSection('mapsforge', {
            themeFolder: scan.mapsforgeThemeFolder,
            themePath: selectedPath,
            themes: themes.map(theme => ({
              path: scan.mapsforgeThemeFolder!,
              name: theme.fileName.replace(/\.xml$/i, ''),
              sourcePath: theme.path
            }))
          });
        }
      } else if (overwrite) {
        this.mapsforgeThemeFolder.set('');
        this.mapsforgeThemes.set([]);
        this.mapsforgeThemePath.set('');
        await this.desktop.ProcessManager.setAppSettingsSection('mapsforge', { themeFolder: '', themePath: '' });
      }

      // Refresh the cached sizes from this explicit package scan. Opening the
      // Location window later restores these values without recursively walking folders.
      const latestSettings = await this.desktop.ProcessManager.getAppSettings();
      const latestOfflineSettings = latestSettings['offline'] as Record<string, unknown> | undefined;
      const latestEntries = Array.isArray(latestOfflineSettings?.['paths'])
        ? latestOfflineSettings['paths'] as Array<{ type?: string; path?: string; enabled?: boolean; size?: number; name?: string; sourcePath?: string }>
        : [];
      const normalizeConfigPath = (path: string): string => path.replace(/\\/g, '/').toLocaleLowerCase();
      const scannedValhallaSizes = new Map((scan.resourceEntries ?? [])
        .filter(entry => entry.type === 'valhalla')
        .map(entry => [normalizeConfigPath(entry.sourcePath), entry.fileSize]));
      const refreshedValhallaEntries = (valhallaStatus.configurations ?? []).map(configuration => ({
        type: 'valhalla-config',
        path: configuration.path,
        enabled: normalizeConfigPath(configuration.path) === normalizeConfigPath(valhallaStatus.configPath || ''),
        size: scannedValhallaSizes.get(normalizeConfigPath(configuration.path))
          ?? latestEntries.find(entry => entry.type === 'valhalla-config' && entry.path && normalizeConfigPath(entry.path) === normalizeConfigPath(configuration.path))?.size
          ?? 0
      }));
      const refreshedEntries = latestEntries.filter(entry => {
        if (entry.type === 'valhalla-config') return false;
        if (overwrite && scan.osmAndResourcesPath && entry.type === 'osmand-resources') return false;
        if (overwrite && (entry.type === 'mapsforge-theme-folder' || entry.type === 'mapsforge-theme')) return false;
        return true;
      });
      if (overwrite && scan.osmAndResourcesPath) {
        const size = scan.resourceEntries.find(entry => entry.type === 'osmand-resources')?.fileSize ?? 0;
        refreshedEntries.push({ type: 'osmand-resources', path: scan.osmAndResourcesPath, enabled: true, size });
      }
      if (overwrite && scan.mapsforgeThemeFolder) {
        const folderSize = scan.resourceEntries.find(entry => entry.type === 'mapsforge-theme')?.fileSize
          ?? latestEntries.find(entry => entry.type === 'mapsforge-theme-folder' && entry.path === scan.mapsforgeThemeFolder)?.size
          ?? 0;
        refreshedEntries.push({ type: 'mapsforge-theme-folder', path: scan.mapsforgeThemeFolder, enabled: true, size: folderSize });
        for (const theme of (scan.resourceEntries ?? []).filter(entry => entry.type === 'mapsforge-theme')) {
          refreshedEntries.push({
            type: 'mapsforge-theme',
            path: theme.path,
            name: theme.fileName,
            sourcePath: theme.sourcePath,
            enabled: theme.sourcePath === this.mapsforgeThemePath(),
            size: theme.fileSize
          });
        }
      }
      await this.desktop.ProcessManager.setAppSettingsSection('offline', {
        paths: [...refreshedEntries, ...refreshedValhallaEntries]
      });

      const foundParts = [
        scan.obfFiles.length + ' OBF',
        scan.mbtilesFiles.length + ' MBTiles',
        scan.mapsforgeFiles.length + ' Mapsforge MAP',
        scan.hillshadeFiles.length + ' hillshade',
        scan.valhallaConfigs.length + ' Valhalla configuration(s)',
        (scan.osmAndResourcesPath ? 'OsmAnd resources folder found' : 'no OsmAnd resources folder'),
        themesFound + ' Mapsforge XML theme(s)' + (scan.mapsforgeThemeFolder ? ' in ' + scan.mapsforgeThemeFolder : '') + (themeNames.length > 0 ? ': ' + themeNames.join(', ') : '')
      ];
      const changedParts = [
        mapsAdded + ' map file(s) added · ' + mapsRemoved + ' stale map entry(s) removed from the list',
        hillshadeAdded + ' Hillshade file(s) added · ' + hillshadeRemoved + ' stale Hillshade entry(s) removed from the list',
        valhallaAdded + ' Valhalla configuration(s) added · ' + valhallaRemoved + ' stale configuration(s) removed from the list',
        resourcesApplied ? 'OsmAnd resources folder selected' : 'OsmAnd resources folder not changed',
        overwrite && scan.mapsforgeThemeFolder ? 'Mapsforge theme folder and theme list updated' : overwrite ? 'Mapsforge theme folder and theme list cleared' : 'Mapsforge theme folder not changed'
      ];
      const importErrors = importResult.errors.length ? ' · Import errors: ' + importResult.errors.length : '';
      const scanErrors = scan.errors.length ? ' · Scan warnings: ' + scan.errors.length : '';
      this.resourcePackageScanFound.set(foundParts.join(' · '));
      this.resourcePackageScanChanged.set(changedParts.join(' · ') + importErrors + scanErrors);
      this.resourcePackageScanStatus.set('Resource package scan completed.');
      this.offlineFilesCheckStatus.set('Package loaded · click Check to refresh file status, missing files, duplicates and active selections.');
      if (scan.errors.length || importResult.errors.length) {
        this.resourcePackageScanError.set([...scan.errors, ...importResult.errors].join('\n'));
      }
      if (this.currentLatitude !== null && this.currentLongitude !== null) this.refreshOfflineMapRendering();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.resourcePackageScanError.set(message);
      this.resourcePackageScanFound.set('Scan did not complete.');
      this.resourcePackageScanChanged.set('No changes can be confirmed.');
      this.resourcePackageScanStatus.set('Resource package scan failed.');
      this.recordMapError('Resource package scan', message);
    } finally {
      this.resourcePackageScanBusy.set(false);
    }
  };

  protected readonly chooseOfflineMap = async (): Promise<void> => {
    if (!this.desktop) return;
    const result = await this.desktop.OfflineMap.chooseFile();
    this.offlineMaps.set(await this.enrichObfMetadata(result.maps));
    this.applyMapBoundsVisibility();

    this.offlineMapImportErrors.set(result.errors);
    if (this.mapSource() === 'offline' && !result.maps.some(map => map.enabled && (map.type === 'mbtiles' || !map.type))) this.changeMapSource('online');
    else if (result.maps.length === 0 && this.mapSource() === 'offline') this.changeMapSource('online');
    else if (this.currentLatitude !== null && this.currentLongitude !== null && (this.mapSource() === 'offline' || this.mapSource() === 'osmand' || this.mapSource() === 'osmand-atlas' || this.mapSource() === 'mapsforge')) {
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
      this.offlineMaps.set(this.mergeObfMetadata(result.maps));
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
  protected readonly clearAllGpxDatabaseEntries = async (): Promise<void> => {
    if (!this.desktop || this.gpxDatabaseClearBusy()) return;
    const confirmed = window.confirm(
      'Delete all imported GPX database entries from every drive cache database?\\n\\nThis permanently deletes GPX database files, segments and points from all drives. Original GPX files and the GPX favorites list will remain unchanged.'
    );
    if (!confirmed) return;
    this.gpxDatabaseClearBusy.set(true);
    this.gpxDatabaseClearStatus.set('');
    try {
      const result = await this.desktop.CacheManager.clearAllGpxDatabaseEntries();
      this.gpxDatabaseClearStatus.set(
        `Deleted ${result.files.toLocaleString(this.locale)} GPX file(s), ${result.segments.toLocaleString(this.locale)} segment(s) and ${result.points.toLocaleString(this.locale)} point(s) from ${result.databases.toLocaleString(this.locale)} cache database(s).`
      );
      this.gpxElevationProfileRequestId++;
      this.gpxElevationProfiles.set([]);
      this.latestGpxElevationProfileBusy.set(false);
      this.latestGpxElevationProfileError.set('No GPX database entries remain. Add a GPX track again to display its elevation profile.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.gpxDatabaseClearStatus.set('Deleting GPX database entries failed: ' + message);
      this.recordMapError('Delete all GPX database entries', message);
    } finally {
      this.gpxDatabaseClearBusy.set(false);
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
  protected readonly clearOsmAndTileCache = async (): Promise<void> => {
    if (!this.desktop || this.osmAndTileCacheBusy()) return;
    const current = this.osmAndTileCache();
    const confirmed = window.confirm(
      `Clear the OsmAnd tile cache?\n\n${current.entries.toLocaleString(this.locale)} PNG tiles (about ${this.formatOfflineMapSize(current.bytes)}) will be deleted from:\n${current.path}\n\nThe tiles will be rendered again when needed.`
    );
    if (!confirmed) return;

    this.osmAndTileCacheBusy.set(true);
    this.osmAndTileCacheStatus.set('');
    try {
      const result = await this.desktop.CacheManager.clearOsmAndTileCache();
      await this.refreshOsmAndTileCache();
      this.osmAndTileCacheStatus.set(`Cleared ${result.entries.toLocaleString(this.locale)} tile(s) · ${this.formatOfflineMapSize(result.bytes)} freed.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.osmAndTileCacheStatus.set('Clear cache failed: ' + message);
      this.recordMapError('Clear OsmAnd tile cache', message);
    } finally {
      this.osmAndTileCacheBusy.set(false);
    }
  };
  protected readonly refreshVisibleTiles = (): void => {
    const renderer = this.offlineRenderer;
    const source = this.mapSource();
    if (!renderer || (source !== 'osmand-atlas' && source !== 'osmand') || this.rerenderVisibleTilesBusy()) return;
    this.currentTileRequestResults.clear();
    this.lastRenderTileCounts.set({ rendered: 0, cached: 0, failed: 0 });
    this.lastRenderDurationSamples.set([]);
    this.lastRenderQueueSamples.set([]);
    this.rerenderVisibleTilesStatus.set('');
    try {
      renderer.refreshVisibleTiles();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.rerenderVisibleTilesStatus.set('Refresh failed: ' + message);
      this.recordMapError('Refresh visible OsmAnd tiles', message);
    }
  };
  protected readonly canRerenderVisibleTiles = (): boolean =>
    !!this.offlineRenderer && (this.mapSource() === 'osmand-atlas' || this.mapSource() === 'osmand');

  protected readonly isMapRenderingActive = (): boolean =>
    this.renderActiveCount() > 0 || this.hillshadeActiveCount() > 0
    || this.rerenderVisibleTilesBusy() || this.renderDisplayPending();

  protected readonly cancelMapRendering = async (): Promise<void> => {
    if (!this.isMapRenderingActive()) return;
    // Stop any camera animation and cancel queued/in-flight Atlas helper work.
    this.offlineRenderer?.map.stop();
    try {
      if (this.mapSource() === 'osmand-atlas') {
        await this.desktop?.OsmAndAtlas.cancelRendering();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordMapError('Cancel map rendering', message);
    }
    this.activeRenderTiles.clear();
    this.activeHillshadeTiles.clear();
    this.completedHillshadeTiles.clear();
    this.hillshadeCompletedCount.set(0);
    this.renderActiveCount.set(0);
    this.hillshadeActiveCount.set(0);
    this.renderDisplayPending.set(false);
    this.rerenderVisibleTilesBusy.set(false);
    this.rerenderVisibleTilesProgress.set({ completed: 0, total: 0 });
    this.rerenderVisibleTilesStatus.set('Rendering cancelled.');
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
        (z, x, y, forceRender) => runOfflineRenderTask(() => this.desktop!.OsmAnd.renderTile(z, x, y, forceRender), 'OsmAnd', `Rerender z${z}/${x}/${y}`),
        (z, x, y, displayScale, forceRender) =>
          runOfflineRenderTask(() => this.desktop!.OsmAndAtlas.renderTile(z, x, y, displayScale, forceRender), 'OsmAnd Atlas', `Rerender z${z}/${x}/${y}`),
        this.displayDensityFactor(),
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
  protected readonly formatOfflineMapDate = (timestamp: number): string =>
    Number.isFinite(timestamp) && timestamp > 0 ? formatOsDateTime(timestamp) : '—';
  protected readonly changeOfflineMapPreset = async (value: string): Promise<void> => {
    if (!this.mapPresetOptions().some(preset => preset.id === value)) return;
    if (this.desktop) {
      // Apply all OBF states and the preset in one IPC call and one settings write.
      // Custom intentionally preserves the user's individual enabled states.
      const updates = value === 'custom' ? [] : this.offlineMaps()
        .filter(map => {
          if (map.type === 'obf') return map.enabled !== this.obfMapMatchesPreset(map, value);
          if (map.type === 'mapsforge') {
            const baseName = (map.fileName || map.name).split(/[\\/]/).pop()?.toLowerCase() ?? '';
            if (baseName === 'world.map') {
              return map.enabled !== (value !== 'none');
            }
            if (value !== 'all' && value !== 'none' && value !== 'custom') {
              return map.enabled !== this.mapsforgeMapMatchesPreset(map, value, this.offlineMaps());
            }
          }
          return false;
        })
        .map(map => ({
          id: map.id,
          enabled: map.type === 'obf'
            ? this.obfMapMatchesPreset(map, value)
            : (map.fileName || map.name).split(/[\\/]/).pop()?.toLowerCase() === 'world.map'
              ? value !== 'none'
              : this.mapsforgeMapMatchesPreset(map, value, this.offlineMaps())
        }));
      const updated = await this.desktop.OfflineMap.setEnabledBatch(updates);
      this.offlineMaps.set(this.mergeObfMetadata(updated));
      this.offlineMapPreset.set(this.getOfflineMapPresetForMaps(updated) ?? 'custom');
      this.applyMapBoundsVisibility();
      await this.changeHillshadePreset(value);
    } else {
      this.offlineMapPreset.set(value);
    }
    this.refreshOfflineMapRendering();
  };

  private presetMatchesFileName(preset: string, fileName: string): boolean {
    const definition = this.mapPresetOptions().find(item => item.id === preset);
    if (!definition) return false;
    try { return new RegExp(definition.osmAndRegex, 'i').test(fileName); } catch { return false; }
  }

  private obfMapMatchesPreset(
    map: import('internal-api').OfflineMapStatus,
    selectedPreset: string = this.offlineMapPreset()
  ): boolean {
    if (map.type !== 'obf') return false;
    const fileName = map.fileName || map.name;
    const isWorldBasemap = /^World_basemap\.obf$/i.test(fileName);
    if (selectedPreset === 'none') return false;
    if (isWorldBasemap) return true;
    // The legacy nationwide extract is obsolete and must never be activated by Austria.
    if ((selectedPreset === 'austria' || selectedPreset === 'austria-plus') && /^Austria_europe\.obf$/i.test(fileName)) return false;
    return selectedPreset === 'all' || selectedPreset === 'custom'
      || this.presetMatchesFileName(selectedPreset, fileName);
  }

  private mapsforgeMapMatchesPreset(
    map: import('internal-api').OfflineMapStatus,
    selectedPreset: string,
    _allMaps: import('internal-api').OfflineMapStatus[] = this.offlineMaps()
  ): boolean {
    if (map.type !== 'mapsforge') return false;
    const fileName = (map.fileName || map.name).split(/[\\/]/).pop() ?? '';
    if (/^world\.map$/i.test(fileName)) return true;
    if (selectedPreset === 'none') return false;
    if (selectedPreset === 'all') return true;

    // Mapsforge files are selected directly by their own filenames. Regional
    // presets use mapsForgeRegex from the default config; other presets fall
    // back to their regular preset regex (e.g. Austria, DACH).
    const definition = this.mapPresetOptions().find(item => item.id === selectedPreset);
    if (!definition) return false;
    const pattern = definition.mapsForgeRegex || definition.osmAndRegex;
    try { return new RegExp(pattern, 'i').test(fileName); } catch { return false; }
  }

  private getOfflineMapPresetForMaps(
    maps: import('internal-api').OfflineMapStatus[]
  ): string | null {
    // Presets describe the available OBF + Mapsforge files. Missing entries
    // must not prevent an otherwise complete selection from being recognized.
    const presetMaps = maps.filter(map =>
      (map.type === 'obf' || map.type === 'mapsforge') && map.available
    );
    if (presetMaps.length === 0) return null;
    const candidates = this.mapPresetOptions().map(item => item.id).filter(id => id !== 'custom');
    const allEnabled = presetMaps.every(map => map.enabled);
    const noneEnabled = presetMaps.every(map => !map.enabled);
    if (allEnabled && candidates.includes('all')) return 'all';
    if (noneEnabled && candidates.includes('none')) return 'none';

    const matches = (map: import('internal-api').OfflineMapStatus, preset: typeof candidates[number]): boolean => {
      if (map.type === 'obf') return this.obfMapMatchesPreset(map, preset);
      if (map.type === 'mapsforge') {
        const baseName = (map.fileName || map.name).split(/[\\/]/).pop()?.toLowerCase() ?? '';
        if (baseName === 'world.map') return preset !== 'none';
        if (preset === 'none') return false;
        if (preset === 'all') return true;
        return this.mapsforgeMapMatchesPreset(map, preset, maps);
      }
      return map.enabled;
    };
    // Several regional presets can produce the same enabled-file set when
    // only a subset of the regions' files is installed. Choose the compatible
    // preset that covers the most available files; on a tie, prefer the broader
    // (less restrictive) filename pattern instead of the default UI selection.
    const compatible = candidates.map(preset => {
      const definition = this.mapPresetOptions().find(item => item.id === preset);
      const patternLength = presetMaps.reduce((total, map) => {
        if (map.type === 'obf') return total + (definition?.osmAndRegex.length ?? Number.MAX_SAFE_INTEGER);
        if (map.type === 'mapsforge') return total + ((definition?.mapsForgeRegex || definition?.osmAndRegex)?.length ?? Number.MAX_SAFE_INTEGER);
        return total;
      }, 0);
      return {
        preset,
        covered: presetMaps.filter(map => matches(map, preset)).length,
        patternLength
      };
    }).filter(candidate =>
      presetMaps.every(map => map.enabled === matches(map, candidate.preset))
    ).sort((a, b) => b.covered - a.covered || a.patternLength - b.patternLength);
    return compatible[0]?.preset ?? 'custom';
  }

  protected readonly isOfflineMapInUse = (map: import('internal-api').OfflineMapStatus): boolean => this.offlineMapStats().inUseIds.has(map.id);

  private calculateOfflineMapInUse(map: import('internal-api').OfflineMapStatus): boolean {
    if (!map.enabled) return false;
    if (map.type === 'obf') {
      return (this.mapSource() === 'osmand' || this.mapSource() === 'osmand-atlas')
        && this.obfMapMatchesPreset(map);
    }
    if (map.type === 'mapsforge') return this.mapSource() === 'mapsforge';
    return this.mapSource() === 'offline' && map.id === this.activeOfflineMapId();
  }

  private refreshOfflineMapDuplicateIndex(maps: import('internal-api').OfflineMapStatus[] = this.offlineMaps()): void {
    const idsByName = new Map<string, Array<{ id: string; path: string }>>();
    for (const map of maps) {
      const name = this.fileNameFromPath(map.filePath);
      if (!name) continue;
      const entries = idsByName.get(name);
      if (entries) entries.push({ id: map.id, path: map.filePath.toLocaleLowerCase() });
      else idsByName.set(name, [{ id: map.id, path: map.filePath.toLocaleLowerCase() }]);
    }
    const duplicateIds = new Set<string>();
    for (const entries of idsByName.values()) {
      if (entries.length < 2) continue;
      const firstPath = entries[0].path;
      if (entries.some(entry => entry.path !== firstPath)) {
        for (const entry of entries) duplicateIds.add(entry.id);
      }
    }
    this.offlineMapDuplicateIds.set(duplicateIds);
  }

  private refreshHillshadeDuplicateIndex(databases: OsmAndHillshadeDatabase[] = this.hillshadeDatabases()): void {
    const idsByName = new Map<string, Array<{ id: string; path: string }>>();
    for (const database of databases) {
      const name = this.fileNameFromPath(database.path);
      if (!name) continue;
      const entries = idsByName.get(name);
      if (entries) entries.push({ id: database.id, path: database.path.toLocaleLowerCase() });
      else idsByName.set(name, [{ id: database.id, path: database.path.toLocaleLowerCase() }]);
    }
    const duplicateIds = new Set<string>();
    for (const entries of idsByName.values()) {
      if (entries.length < 2) continue;
      const firstPath = entries[0].path;
      if (entries.some(entry => entry.path !== firstPath)) {
        for (const entry of entries) duplicateIds.add(entry.id);
      }
    }
    this.hillshadeDuplicateIds.set(duplicateIds);
  }

  private refreshMapsforgeThemeDuplicateIndex(themes: import('internal-api').MapsforgeTheme[] = this.mapsforgeThemes()): void {
    const pathsByName = new Map<string, Set<string>>();
    for (const theme of themes) {
      const name = this.fileNameFromPath(theme.path);
      if (!name) continue;
      const paths = pathsByName.get(name) ?? new Set<string>();
      paths.add(theme.path.toLocaleLowerCase());
      pathsByName.set(name, paths);
    }
    const duplicatePaths = new Set<string>();
    for (const theme of themes) {
      const name = this.fileNameFromPath(theme.path);
      if (name && (pathsByName.get(name)?.size ?? 0) > 1) duplicatePaths.add(theme.path.toLocaleLowerCase());
    }
    this.mapsforgeThemeDuplicatePaths.set(duplicatePaths);
  }

  private refreshOfflineMapRendering(): void {
    if (this.currentLatitude !== null && this.currentLongitude !== null
      && (this.mapSource() === 'offline' || this.mapSource() === 'osmand' || this.mapSource() === 'osmand-atlas' || this.mapSource() === 'mapsforge')) {
      this.mapSourceGeneration++; this.mapInitialization = null;
      this.offlineRenderer?.remove(); this.offlineRenderer = null;
      this.map?.remove(); this.map = null; this.leafletHillshadeLayer = null; this.leafletHillshadePane = null; this.marker = null; this.directoryMarkerGroup = null;
      this.currentOfflineMapId = null;
      void this.initialize(this.currentLatitude, this.currentLongitude);
    }
  }

  protected readonly boundsMapViewBox = (kind: BoundsMapKind): string => {
    const view = this.boundsMapViews()[kind];
    return `${view.x} ${view.y} ${view.width} ${view.height}`;
  };
  protected readonly boundsMapIsPanning = (kind: BoundsMapKind): boolean =>
    this.boundsMapDrag?.kind === kind;
  private clampBoundsMapView(kind: BoundsMapKind, view: BoundsMapView): BoundsMapView {
    const base = kind === 'world'
      ? { width: 360, height: 180, maxX: 360, maxY: 180 }
      : { width: 500, height: 350, maxX: 2000, maxY: 1001 };
    const width = Math.max(base.width / 12, Math.min(base.width, view.width));
    const height = width * base.height / base.width;
    return {
      x: Math.max(0, Math.min(base.maxX - width, view.x)),
      y: Math.max(0, Math.min(base.maxY - height, view.y)),
      width, height
    };
  }
  protected readonly startBoundsMapPan = (event: PointerEvent, kind: BoundsMapKind): void => {
    if (event.button !== 0) return;
    const svg = event.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    event.preventDefault();
    svg.setPointerCapture(event.pointerId);
    this.boundsMapDrag = {
      kind, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      startView: { ...this.boundsMapViews()[kind] }, rect
    };
  };
  protected readonly moveBoundsMapPan = (event: PointerEvent): void => {
    const drag = this.boundsMapDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = (event.clientX - drag.startX) * drag.startView.width / drag.rect.width;
    const dy = (event.clientY - drag.startY) * drag.startView.height / drag.rect.height;
    const next = this.clampBoundsMapView(drag.kind, {
      ...drag.startView, x: drag.startView.x - dx, y: drag.startView.y - dy
    });
    this.boundsMapViews.update(views => ({ ...views, [drag.kind]: next }));
  };
  protected readonly endBoundsMapPan = (event: PointerEvent): void => {
    if (!this.boundsMapDrag || this.boundsMapDrag.pointerId !== event.pointerId) return;
    const svg = event.currentTarget as SVGSVGElement;
    if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    this.boundsMapDrag = null;
  };
  protected readonly zoomBoundsMap = (event: WheelEvent, kind: BoundsMapKind): void => {
    event.preventDefault();
    const svg = event.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const current = this.boundsMapViews()[kind];
    const baseWidth = kind === 'world' ? 360 : 500;
    const factor = event.deltaY < 0 ? 0.82 : 1.22;
    const width = Math.max(baseWidth / 12, Math.min(baseWidth, current.width * factor));
    const height = current.height * width / current.width;
    const anchorX = current.x + (event.clientX - rect.left) / rect.width * current.width;
    const anchorY = current.y + (event.clientY - rect.top) / rect.height * current.height;
    const next = this.clampBoundsMapView(kind, {
      x: anchorX - (anchorX - current.x) * width / current.width,
      y: anchorY - (anchorY - current.y) * height / current.height,
      width, height
    });
    this.boundsMapViews.update(views => ({ ...views, [kind]: next }));
  };
  private createObfBoundsPreview(map: import('internal-api').OfflineMapStatus): ObfBoundsPreview {
    if (!map.obfMetadataAvailable || !map.bounds) {
      return { name: map.name, bounds: map.bounds, zoom: '', error: map.obfMetadataError || 'OsmAnd Core did not provide bounds for this OBF file.', rectangles: [] };
    }
    const values = map.bounds.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    if (values.length !== 4 || values.some(value => !Number.isFinite(value))) {
      return { name: map.name, bounds: map.bounds, zoom: '', error: 'The bounds value could not be parsed.', rectangles: [] };
    }
    const [west, south, east, north] = values;
    if (west < -180 || west > 180 || east < -180 || east > 180 || south < -90 || north > 90 || south > north) {
      return { name: map.name, bounds: map.bounds, zoom: '', error: 'The bounds are outside the valid geographic range.', rectangles: [] };
    }
    // The world-map SVG uses a non-equirectangular projection. Convert latitude
    // to the SVG's vertical coordinate so bounds align with the drawn land areas.
    const toMapY = (latitude: number): number =>
      500 - Math.sign(latitude) * 500 * Math.pow(Math.abs(latitude) / 90, 1.54);
    const y = toMapY(north) * 180 / 1001;
    const height = (toMapY(south) - toMapY(north)) * 180 / 1001;
    const zoom = map.minZoom > 0 && map.maxZoom > 0 ? map.minZoom + '–' + map.maxZoom : '';
    const toX = (longitude: number): number => longitude + 180;
    const rectangles = east >= west
      ? [{ x: toX(west), y, width: east - west, height }]
      : [
          { x: toX(west), y, width: 180 - west, height },
          { x: 0, y, width: east + 180, height }
        ];
    return { name: map.name, bounds: map.bounds, zoom, error: null, rectangles };
  }

  protected readonly setOfflineMapEnabled = async (id: string, enabled: boolean): Promise<void> => {
    if (!this.desktop) return;
    const previousMap = this.offlineMaps().find(map => map.id === id);
    const showBoundsPreview = enabled && previousMap?.type === 'obf' && !previousMap.enabled;
    this.obfBoundsPreview.set(null);
    const updated = await this.desktop.OfflineMap.setEnabledBatch([{ id, enabled }]);
    this.offlineMaps.set(this.mergeObfMetadata(updated));
    this.resetLastRenderCountsForViewport();
    this.applyMapBoundsVisibility();
    if (showBoundsPreview) {
      const activatedMap = this.offlineMaps().find(map => map.id === id);
      if (activatedMap) this.obfBoundsPreview.set(this.createObfBoundsPreview(activatedMap));
    }
    this.offlineMapPreset.set(this.getOfflineMapPresetForMaps(updated) ?? 'custom');
    if (this.currentLatitude !== null && this.currentLongitude !== null && (this.mapSource() === 'offline' || this.mapSource() === 'osmand' || this.mapSource() === 'osmand-atlas' || this.mapSource() === 'mapsforge')) {
      this.mapSourceGeneration++; this.mapInitialization = null;
      this.offlineRenderer?.remove(); this.offlineRenderer = null;
      this.map?.remove(); this.map = null; this.leafletHillshadeLayer = null; this.leafletHillshadePane = null; this.marker = null; this.directoryMarkerGroup = null;
      this.currentOfflineMapId = null;
      void this.initialize(this.currentLatitude, this.currentLongitude);
    }
  };
  protected readonly copyOfflineFolder = async (path: string, isFolder: boolean): Promise<void> => {
    if (!this.desktop || !path.trim()) return;
    try {
      const folderPath = isFolder ? path : await this.desktop.FileSystem.dirname(path);
      await this.copyFilePath(folderPath);
    } catch (error) {
      console.warn('[OfflineMap] Could not resolve folder path:', error);
    }
  };
  protected readonly openOfflineFolder = async (path: string, isFolder: boolean): Promise<void> => {
    if (!this.desktop || !path.trim()) return;
    try {
      const folderPath = isFolder ? path : await this.desktop.FileSystem.dirname(path);
      const error = await this.desktop.ProcessManager.openPath(folderPath);
      if (error) console.warn('[OfflineMap] Could not open folder:', error);
    } catch (error) {
      console.warn('[OfflineMap] Could not open folder:', error);
    }
  };
  protected readonly openOfflineFileWith = async (filePath: string): Promise<void> => {
    if (!this.desktop || !filePath.trim()) return;
    try {
      await this.desktop.ProcessManager.openWith(filePath);
    } catch (error) {
      console.warn('[OfflineMap] Could not open file chooser:', error);
    }
  };

  protected readonly setAllOfflineEnabled = async (enabled: boolean, visibleOnly = true): Promise<void> => {
    if (!this.desktop) return;
    this.obfBoundsPreview.set(null);
    const targetMaps = visibleOnly ? this.filteredOffline() : this.offlineMaps();
    const visibleMaps = targetMaps.filter(map => map.available);
    const visibleHillshade = visibleOnly ? this.filteredHillshadeDatabases() : this.hillshadeDatabases();
    if (visibleMaps.length === 0 && visibleHillshade.length === 0) return;
    try {
      if (visibleMaps.length) {
        const updates = visibleMaps.map(map => ({ id: map.id, enabled }));
        const updated = await this.desktop.OfflineMap.setEnabledBatch(updates);
        this.offlineMaps.set(this.mergeObfMetadata(updated));
        this.offlineMapPreset.set(this.getOfflineMapPresetForMaps(updated) ?? 'custom');
        this.applyMapBoundsVisibility();
        this.resetLastRenderCountsForViewport();
        this.refreshOfflineMapRendering();
      }
      if (visibleHillshade.length) await this.setAllHillshadeDatabasesEnabled(enabled, visibleOnly);
    } catch (error) {
      console.error('[OfflineMap] Could not update Active state for offline files:', error);
    }
  };
  protected readonly removeVisibleOffline = async (): Promise<void> => {
    if (!this.desktop) return;
    const maps = this.filteredOffline();
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
      this.offlineMaps.set(this.mergeObfMetadata(remaining));
      this.applyMapBoundsVisibility();
       this.offlineMapUpdateCheckStatus.set('');
      if (!remaining.some(map => map.enabled && (map.type === 'mbtiles' || !map.type)) && this.mapSource() === 'offline') {
        this.changeMapSource('online');
        return;
      }
      if (this.currentLatitude !== null && this.currentLongitude !== null
        && (this.mapSource() === 'offline' || this.mapSource() === 'osmand' || this.mapSource() === 'osmand-atlas' || this.mapSource() === 'mapsforge')) {
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
    const remaining = await this.desktop.OfflineMap.removeFile(id);
    this.offlineMaps.set(this.mergeObfMetadata(remaining));
    this.applyMapBoundsVisibility();

    if (!this.offlineMaps().some(map => map.enabled && (map.type === 'mbtiles' || !map.type)) && this.mapSource() === 'offline') {
      this.changeMapSource('online');
      return;
    }
    if (this.currentLatitude !== null && this.currentLongitude !== null && (this.mapSource() === 'offline' || this.mapSource() === 'osmand' || this.mapSource() === 'osmand-atlas' || this.mapSource() === 'mapsforge')) {
      this.mapSourceGeneration++; this.mapInitialization = null;
      this.offlineRenderer?.remove(); this.offlineRenderer = null;
      this.map?.remove(); this.map = null; this.leafletHillshadeLayer = null; this.leafletHillshadePane = null; this.marker = null; this.directoryMarkerGroup = null;
      this.currentOfflineMapId = null;
      void this.initialize(this.currentLatitude, this.currentLongitude);
    }
  };
  private persistDownloadSources(): void {
    const updateSources = this.downloadSources().map(source => ({ ...source }));
    void this.desktop?.ProcessManager.setAppSettingsSection('offline', {
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
  protected readonly chooseMapsforgeThemeFolder = async (): Promise<void> => {
    if (!this.desktop) return;
    const result = await this.desktop.Dialogs.openFolder(this.mapsforgeThemeFolder() || undefined);
    if (!result.success) return;
    this.mapsforgeThemeFolder.set(result.data);
    await this.refreshMapsforgeThemes();
  };
  protected readonly refreshMapsforgeThemes = async (): Promise<void> => {
    if (!this.desktop || !this.mapsforgeThemeFolder()) return;
    this.mapsforgeThemeError.set('');
    try {
      const themes = await this.desktop.Mapsforge.scanThemes(this.mapsforgeThemeFolder());
      this.mapsforgeThemes.set(themes);

      const selected = themes.find(theme => theme.path === this.mapsforgeThemePath()) ?? null;
      const selectedPath = selected?.path ?? '';
      this.mapsforgeThemePath.set(selectedPath);
      await this.desktop.ProcessManager.setAppSettingsSection('mapsforge', {
        themeFolder: this.mapsforgeThemeFolder(), themePath: selectedPath
      });
      if (this.mapSource() === 'mapsforge' && this.currentLatitude !== null && this.currentLongitude !== null) {
        this.refreshOfflineMapRendering();
      }
    } catch (error) {
      this.mapsforgeThemeError.set(error instanceof Error ? error.message : String(error));
    }
  };
  protected readonly changeMapsforgeTheme = async (path: string): Promise<void> => {
    if (path !== '' && !this.mapsforgeThemes().some(theme => theme.path === path)) return;
    this.mapsforgeThemePath.set(path);
    await this.desktop?.ProcessManager.setAppSettingsSection('mapsforge', {
      themeFolder: this.mapsforgeThemeFolder(), themePath: path
    });
    if (this.mapSource() === 'mapsforge' && this.currentLatitude !== null && this.currentLongitude !== null) {
      this.refreshOfflineMapRendering();
    }
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
      if ((this.mapSource() === 'osmand-atlas' || this.mapSource() === 'mapsforge') && this.currentLatitude !== null && this.currentLongitude !== null) {
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
    this.mapVisible.set(visible); this.saveSetting('mapVisible', visible);
    this.persistLocationUiState({ mapVisible: visible });
    this.applyMapOpacity();
  };
  protected readonly changeTrackVisibility = (visible: boolean): void => {
    this.gpxVisible.set(visible); void this.persistGpxMapSettings({ visible }); this.applyGpxTrack();
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
    timestamp === null || !Number.isFinite(timestamp) ? '—' : formatOsDateTime(timestamp);
  private hillshadeDatabaseMatchesPreset(database: OsmAndHillshadeDatabase, preset: string): boolean {
    if (!database.available || preset === 'none') return false;
    if (preset === 'all') return true;
    const fileName = this.hillshadeDatabaseFileName(database.path);
    const definition = this.mapPresetOptions().find(item => item.id === preset);
    const pattern = definition?.hillshadeRegex;
    if (!pattern) return false;
    try { return new RegExp(pattern, 'i').test(fileName); } catch { return false; }
  }
  private updateHillshadePresetFromSelection(databases: OsmAndHillshadeDatabase[]): void {
    const available = databases.filter(database => database.available);
    const allEnabled = available.length > 0 && available.every(database => database.enabled);
    const noneEnabled = available.length === 0 || available.every(database => !database.enabled);

    // Explicit global selections take precedence over narrower presets.
    // Otherwise, e.g. a list containing only Austrian files would be labelled
    // "Austria" even when the user has selected every available file.
    const candidates = this.mapPresetOptions().map(item => item.id).filter(id => id !== 'custom');
    const compatible = candidates.filter(preset => preset !== 'all' && preset !== 'none')
      .map(preset => {
        const pattern = this.mapPresetOptions().find(item => item.id === preset)?.hillshadeRegex ?? '';
        return {
          preset,
          covered: available.filter(database => this.hillshadeDatabaseMatchesPreset(database, preset)).length,
          patternLength: pattern.length
        };
      })
      .filter(candidate => available.every(database =>
        database.enabled === this.hillshadeDatabaseMatchesPreset(database, candidate.preset)
      ))
      .sort((a, b) => b.covered - a.covered || a.patternLength - b.patternLength);
    const next = allEnabled && candidates.includes('all') ? 'all'
      : noneEnabled && candidates.includes('none') ? 'none'
      : compatible[0]?.preset ?? 'custom';
    this.hillshadePreset.set(next);
  }
  protected readonly changeHillshadePreset = async (value: string): Promise<void> => {
    if (!this.mapPresetOptions().some(preset => preset.id === value)) return;
    const preset = value;
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
    this.updateHillshadePresetFromSelection(this.hillshadeDatabases());
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
  protected readonly setAllHillshadeDatabasesEnabled = async (enabled: boolean, visibleOnly = false): Promise<void> => {
    if (!this.desktop) return;
    try {
      const targetIds = new Set((visibleOnly ? this.filteredHillshadeDatabases() : this.hillshadeDatabases()).map(database => database.id));
      let databases = this.hillshadeDatabases();
      for (const database of databases) {
        if (!targetIds.has(database.id) || !database.available || database.enabled === enabled) continue;
        databases = await this.desktop.OsmAndAtlas.setHillshadeDatabaseEnabled(database.id, enabled);
        this.hillshadeDatabases.set(databases);
      }
      this.updateHillshadePresetFromSelection(databases);
      this.applyHillshadeSettingsIfReady(true);
    } catch (error) {
      this.recordMapError('Update Hillshade databases', error instanceof Error ? error.message : String(error));
    }
  };
  protected readonly clearVisibleHillshadeDatabases = async (): Promise<void> => {
    if (!this.desktop) return;
    const visible = this.filteredHillshadeDatabases();
    if (visible.length === 0) return;
    const confirmed = window.confirm(
      `Remove all ${visible.length} visible Hillshade database(s) from the LumaScope list? The files on disk will not be deleted.`
    );
    if (!confirmed) return;
    try {
      let databases = this.hillshadeDatabases();
      for (const database of visible) {
        if (!databases.some(item => item.id === database.id)) continue;
        databases = await this.desktop.OsmAndAtlas.removeHillshadeDatabase(database.id);
        this.hillshadeDatabases.set(databases);
      }

      this.updateHillshadePresetFromSelection(databases);
      this.applyHillshadeSettingsIfReady(true);
      if (databases.length === 0) {
        this.hillshadeVisible.set(false);
        this.saveSetting('hillshadeVisible', false);
      }
    } catch (error) {
      this.recordMapError('Remove Hillshade databases', error instanceof Error ? error.message : String(error));
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
    this.mapOpacity.set(next); this.saveSetting('opacity', next);
    this.persistLocationUiState({ opacity: next });
    this.applyMapOpacity();
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
  protected readonly previewDisplayDensity = (value: string | number): void => {
    const density = Number(value);
    if (!Number.isFinite(density)) return;
    const next = Math.round(Math.max(1, Math.min(3, density)) * 20) / 20;
    this.displayDensityFactor.set(next);
  };
  protected readonly changeDisplayDensity = (value: string | number): void => {
    const density = Number(value);
    if (!Number.isFinite(density)) return;
    const next = Math.round(Math.max(1, Math.min(3, density)) * 20) / 20;
    this.displayDensityFactor.set(next);
    this.saveSetting('displayDensityFactor', next);
    if ((this.mapSource() === 'osmand-atlas' || this.mapSource() === 'mapsforge') && this.currentLatitude !== null && this.currentLongitude !== null) {
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
  protected readonly resetDisplayDensity = (): void => {
    const windowsScale = Math.round(Math.max(1, Math.min(3, window.devicePixelRatio || 1)) * 100) / 100;
    this.changeDisplayDensity(windowsScale);
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
    this.gpxOpacity.set(next); void this.persistGpxMapSettings({ opacity: next }); this.applyGpxTrack();
  };
  protected readonly gpxSelection = (): string => this.gpxVisible() ? this.gpxColor() : 'off';
  protected readonly changeGpxColor = (value: string): void => {
    if (value === 'off') { this.gpxVisible.set(false); void this.persistGpxMapSettings({ visible: false }); }
    else if (this.gpxColors.some(color => color.value === value)) {
      this.gpxColor.set(value); this.gpxVisible.set(true);
      void this.persistGpxMapSettings({ color: value, visible: true });
    } else return;
    this.colorMenuOpen.set(false);
    this.applyGpxTrack();
  };
  protected readonly formatGpxDate = (timestamp: number): string =>
    Number.isFinite(timestamp) && timestamp > 0 ? formatOsDateTime(timestamp) : '—';
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
  protected readonly refreshLatestGpxElevationProfile = async (_importedDrive?: string): Promise<void> => {
    if (!this.desktop) return;
    const requestId = ++this.gpxElevationProfileRequestId;
    const tracks = (this.gpxListMode() === 'database' ? this.gpxDatabaseTracks() : this.gpxTracks())
      .filter(track => track.active !== false && !track.missing && !track.readError)
      .map(track => ({ track, sourcePath: track.databasePath || track.path }))
      .filter(entry => /^[a-z]:[\\/]/i.test(entry.sourcePath));
    this.latestGpxElevationProfileBusy.set(tracks.length > 0);
    this.latestGpxElevationProfileError.set(tracks.length ? '' : 'No active GPX tracks with local cache paths are available.');
    this.gpxElevationProfiles.set([]);
    if (!tracks.length) { this.latestGpxElevationProfileBusy.set(false); return; }
    try {
      const results = await Promise.all(tracks.map(async ({ track, sourcePath }) => ({
        track, profile: await this.desktop!.CacheManager.getLatestGpxElevationProfile(sourcePath)
      })));
      if (requestId !== this.gpxElevationProfileRequestId) return;
      const available = results.filter((entry): entry is { track: GpxTrackFile; profile: GpxElevationProfile } => !!entry.profile);
      this.gpxElevationProfiles.set(available);
      if (!available.length) this.latestGpxElevationProfileError.set('None of the active GPX tracks has timestamped elevation data in its cache database.');
      else if (available.length < tracks.length) this.latestGpxElevationProfileError.set(`${tracks.length - available.length} active GPX track(s) have no timestamped elevation data and were skipped.`);
    } catch (error) {
      if (requestId !== this.gpxElevationProfileRequestId) return;
      this.gpxElevationProfiles.set([]);
      this.latestGpxElevationProfileError.set(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === this.gpxElevationProfileRequestId) this.latestGpxElevationProfileBusy.set(false);
    }
  };

  protected readonly trackGpxDatabaseKey = (): string | undefined => {
    const configuredPath = this.gpxTracks().find(track => /^[a-z]:[\\/]/i.test(track.path) && !track.path.startsWith('memory:'))?.path;
    return configuredPath?.slice(0, 2);
  };

  private scheduleGpxDatabaseViewportRefresh(): void {
    if (this.gpxListMode() === 'database') {
      if (this.gpxDatabaseViewportRefreshTimer !== null) window.clearTimeout(this.gpxDatabaseViewportRefreshTimer);
      this.gpxDatabaseViewportRefreshTimer = window.setTimeout(() => {
        this.gpxDatabaseViewportRefreshTimer = null;
        if (this.gpxListMode() === 'database') void this.showGpxFilesVisibleOnMap();
      }, 350);
    }
    if (this.directoryMarkersEnabled() && this.useAllPhotosInDb()) {
      if (this.markerViewportRefreshTimer !== null) window.clearTimeout(this.markerViewportRefreshTimer);
      this.markerViewportRefreshTimer = window.setTimeout(() => {
        this.markerViewportRefreshTimer = null;
        if (this.directoryMarkersEnabled() && this.useAllPhotosInDb()) void this.scanDirectoryMarkers();
      }, 350);
    }
  }

  protected readonly showGpxFilesVisibleOnMap = async (): Promise<void> => {
    const queryGeneration = ++this.gpxDatabaseQueryGeneration;
    const desktop = this.desktop;
    if (!desktop) { this.gpxDatabaseQueryBusy.set(false); this.gpxDatabaseQueryStatus.set('The desktop GPX database service is unavailable.'); return; }
    await this.ensureGpxDatabaseTrackSettingsLoaded();
    const mapBounds = this.offlineRenderer?.map.getBounds() ?? this.map?.getBounds();
    if (!mapBounds) {
      this.gpxDatabaseQueryBusy.set(false);
      this.gpxDatabaseQueryStatus.set('The map is not ready yet.');
      return;
    }
    const bounds = {
      west: mapBounds.getWest(),
      south: Math.max(-90, mapBounds.getSouth()),
      east: mapBounds.getEast(),
      north: Math.min(90, mapBounds.getNorth())
    };
    if (bounds.west < -180 || bounds.east > 180 || bounds.west > bounds.east) {
      this.gpxDatabaseQueryBusy.set(false);
      this.gpxDatabaseQueryStatus.set('The current map viewport crosses the date line; this query is not supported yet.');
      return;
    }
    this.gpxDatabaseQueryBusy.set(true);
    this.gpxDatabaseQueryStatus.set('');
    try {
      const configuredPath = this.gpxTracks().find(track => /^[a-z]:[\\/]/i.test(track.path))?.path
        ?? this.gpxDatabaseTracks().find(track => track.databasePath && /^[a-z]:[\\/]/i.test(track.databasePath))?.databasePath;
      const databaseKey = configuredPath?.slice(0, 2);
      const results = await desktop.CacheManager.getGpxFilesInBounds(bounds, databaseKey);
      if (queryGeneration !== this.gpxDatabaseQueryGeneration) return;
      for (const previous of this.gpxDatabaseTracks()) {
        this.gpxSegmentsByTrack.delete(previous.path);
        this.gpxPointDataByTrack.delete(previous.path);
        this.gpxSpeedSegmentsCache.delete(previous.path);
      }
      const previousSettings = new Map(this.gpxDatabaseTracks().map(track => [track.databasePath || '', track]));
      const tracks: GpxTrackFile[] = results.map((file, index) => {
        const path = 'db-cache:' + file.path;
        const previous = { ...previousSettings.get(file.path), ...this.gpxDatabaseTrackSettings.get(file.path) };
        const pointSegments: GpxTrackPoint[][] = file.segments.map(segment => segment.map(point => ({
          latitude: point.latitude,
          longitude: point.longitude,
          elevation: null,
          timestamp: point.timestamp === null ? null : new Date(point.timestamp).toISOString(),
          inViewport: point.inViewport
        })));
        const coordinates = pointSegments.map(segment => segment.map(point => [point.latitude, point.longitude] as [number, number]));
        this.gpxPointDataByTrack.set(path, pointSegments);
        this.gpxSegmentsByTrack.set(path, coordinates);
        return {
          path, databasePath: file.path, name: file.name, sizeBytes: file.sizeBytes,
          lastModified: file.lastModified, active: previous?.active ?? true,
          color: previous?.color ?? this.gpxColors[index % this.gpxColors.length]?.value ?? this.gpxColor(),
          lineStyle: previous?.lineStyle ?? 'solid', lineWidth: previous?.lineWidth ?? 3,
          showDirection: previous?.showDirection ?? false, directionStyle: previous?.directionStyle ?? 'classic'
        };
      });
      this.gpxDatabaseTracks.set(tracks);
      this.gpxListMode.set('database');
      this.rebuildGpxSegments();
      this.applyGpxTrack();
      const matchingPoints = results.reduce((total, file) => total + file.matchingPoints, 0);
      this.gpxDatabaseQueryStatus.set(results.length
        ? results.length + ' file(s), ' + matchingPoints.toLocaleString() + ' point(s) in the current map viewport.'
        : 'No GPX track points found in the current map viewport.');
    } catch (error) {
      if (queryGeneration === this.gpxDatabaseQueryGeneration) this.gpxDatabaseQueryStatus.set(error instanceof Error ? error.message : String(error));
    } finally {
      if (queryGeneration === this.gpxDatabaseQueryGeneration) this.gpxDatabaseQueryBusy.set(false);
    }
  };

  protected readonly showRecentGpxFiles = (): void => {
    this.gpxDatabaseQueryGeneration++;
    if (this.gpxDatabaseViewportRefreshTimer !== null) {
      window.clearTimeout(this.gpxDatabaseViewportRefreshTimer);
      this.gpxDatabaseViewportRefreshTimer = null;
    }
    this.gpxDatabaseQueryBusy.set(false);
    this.gpxListMode.set('recent');
    this.gpxDatabaseQueryStatus.set('');
    this.rebuildGpxSegments();
    this.applyGpxTrack();
    void this.refreshLatestGpxElevationProfile();
  };

  protected readonly selectAllGpxTracks = (): void => {
    const tracks = this.gpxTracks().map(track => ({ ...track, active: true }));
    this.gpxTracks.set(tracks);
    void this.persistGpxTracks(tracks);
    this.rebuildGpxSegments();
    this.applyGpxTrack();
    void this.refreshLatestGpxElevationProfile();
  };

  protected readonly deselectAllGpxTracks = (): void => {
    const tracks = this.gpxTracks().map(track => ({ ...track, active: false }));
    this.gpxTracks.set(tracks);
    void this.persistGpxTracks(tracks);
    this.rebuildGpxSegments();
    this.applyGpxTrack();
    void this.refreshLatestGpxElevationProfile();
  };

  protected readonly deleteAllGpxTracks = async (): Promise<void> => {
    this.gpxSegmentsByTrack.clear();
    this.gpxPointDataByTrack.clear();
    this.gpxSpeedSegmentsCache.clear();
    this.gpxTracks.set([]);
    await this.persistGpxTracks([]);
    this.rebuildGpxSegments();
    this.applyGpxTrack();
    this.gpxElevationProfiles.set([]);
    this.latestGpxElevationProfileError.set('No active GPX tracks with local cache paths are available.');
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
        added.push({
          path: trackPath, name: file.name, sizeBytes: file.size, lastModified: file.lastModified,
          active: true,
          color: this.gpxColors[(current.length + added.length) % this.gpxColors.length]?.value ?? this.gpxColor(),
          lineStyle: 'solid', lineWidth: 4, showDirection: false, directionStyle: 'classic'
        });
        this.gpxSegmentsByTrack.set(trackPath, parsed);
        this.gpxPointDataByTrack.set(trackPath, pointData);
      } catch (error) {
        this.gpxError.set(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!added.length) return;
    const next = [...current, ...added];
    this.gpxTracks.set(next);
    void this.persistGpxTracks(next.filter(track => !track.path.startsWith('memory:')));
    this.gpxListMode.set('recent');
    this.gpxDatabaseQueryStatus.set('');
    this.gpxError.set('');
    this.rebuildGpxSegments();
    this.applyGpxTrack();
    this.fitGpxTrack();

    // Keep the per-drive GPX cache in sync with tracks added directly from files.
    const cachePaths = added.map(track => track.path).filter(path => !path.startsWith('memory:'));
    if (this.desktop && cachePaths.length > 0) {
      try {
        const result = await this.desktop.CacheManager.importGpxFiles(cachePaths);
        if (result.errors > 0) {
          this.gpxError.set(`GPX cache import completed with ${result.errors} error(s).`);
        }
        const importedDrives = [...new Set(cachePaths.map(path => path.slice(0, 2).toUpperCase()))];
        await this.refreshLatestGpxElevationProfile(importedDrives[0]);
      } catch (error) {
        this.gpxError.set(`Could not update the GPX cache: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  protected readonly openGpxTrack = async (track: GpxTrackFile): Promise<void> => {
    if (!this.desktop || track.missing || track.path.startsWith('memory:')) return;
    const error = await this.desktop.ProcessManager.openPath(track.path);
    if (error) this.gpxError.set(error);
  };

  protected readonly deleteLastSavedRouteGpx = async (): Promise<void> => {
    const path = this.lastSavedRouteGpxPath();
    if (!path || !this.desktop) return;
    try {
      const result = await this.desktop.FileSystem.deleteFile(path);
      if (!result.success) throw new Error(result.errorMessage || 'Could not delete the GPX file.');
      await this.removeGpxTrack(path);
      this.lastSavedRouteGpxPath.set('');
      this.routeStatus.set('Deleted GPX file: ' + path);
    } catch (error) {
      this.routeStatus.set(error instanceof Error ? error.message : String(error));
    }
  };

  protected readonly removeGpxTrack = async (path: string): Promise<void> => {
    const next = this.gpxTracks().filter(track => track.path !== path);
    this.gpxSegmentsByTrack.delete(path);
    this.gpxPointDataByTrack.delete(path);
    this.gpxSpeedSegmentsCache.delete(path);
    this.gpxTracks.set(next);
    void this.persistGpxTracks(next.filter(track => !track.path.startsWith('memory:')));
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
    this.gpxSpeedSegmentsCache.clear();
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
        valid.push({ ...track, sizeBytes: metadata?.size ?? track.sizeBytes, lastModified: metadata?.modifiedAt ?? track.lastModified, missing: false, readError: false, active: track.active !== false, color: this.gpxColors.some(item => item.value === track.color) ? track.color : this.gpxColor(), lineStyle: ['solid', 'dashed', 'dotted', 'long-dashed', 'short-dashed', 'dash-dot', 'dash-dot-dot'].includes(track.lineStyle ?? '') ? (track.lineStyle ?? 'solid') : 'solid', lineWidth: [1, 2, 3, 4, 5, 6, 8, 10].includes(track.lineWidth ?? 4) ? (track.lineWidth ?? 4) : 4, showDirection: track.showDirection === true, directionStyle: ['classic', 'chevron', 'triangle', 'thin', 'large-classic', 'large-chevron', 'large-triangle'].includes(track.directionStyle ?? '') ? (track.directionStyle ?? 'classic') : 'classic' });
      }
      catch { /* Keep malformed files out of the rendered track set. */ }
    }
    this.gpxTracks.set(valid);
    void this.persistGpxTracks(valid);
    this.rebuildGpxSegments();
    this.applyGpxTrack();
  }

  private gpxSettingsWriteQueue: Promise<void> = Promise.resolve();

  private async persistGpxMapSettings(patch: Record<string, unknown>): Promise<void> {
    if (!this.desktop) return;
    const settings = await this.desktop.ProcessManager.getAppSettings();
    const gpx = settings['gpx'] && typeof settings['gpx'] === 'object'
      ? settings['gpx'] as Record<string, unknown> : {};
    const mapView = gpx['mapWindow'] && typeof gpx['mapWindow'] === 'object'
      ? gpx['mapWindow'] as Record<string, unknown> : {};
    const legacyMapWindow = settings['mapWindow'] && typeof settings['mapWindow'] === 'object'
      ? settings['mapWindow'] as Record<string, unknown> : {};
    await this.desktop.ProcessManager.setAppSettingsSection('gpx', {
      mapWindow: { ...mapView, ...patch }
    });
    if (legacyMapWindow['gpxColor'] !== undefined || legacyMapWindow['gpxOpacity'] !== undefined || legacyMapWindow['gpxVisible'] !== undefined) {
      await this.desktop.ProcessManager.setAppSettingsSection('mapWindow', {
        gpxColor: undefined, gpxOpacity: undefined, gpxVisible: undefined
      });
    }
  }

  private serializeGpxTracks(tracks: GpxTrackFile[]): Array<Record<string, unknown>> {
    return tracks.filter(track => !track.path.startsWith('memory:')).map(track => ({
      path: track.path,
      name: track.name,
      sizeBytes: Number.isFinite(track.sizeBytes) ? track.sizeBytes : 0,
      lastModified: Number.isFinite(track.lastModified) ? track.lastModified : 0,
      active: track.active !== false,
      color: this.gpxColors.some(item => item.value === track.color) ? track.color : this.gpxColor(),
      colorMode: track.colorMode === 'speed' || track.colorMode === 'elevation' ? track.colorMode : 'fixed',
      speedPalette: ['cool-warm', 'viridis', 'plasma', 'inferno', 'terrain', 'custom-2', 'custom-3'].includes(track.speedPalette ?? '') ? track.speedPalette : 'spectrum',
      speedMinKmh: Number.isFinite(track.speedMinKmh) ? Math.max(0, Math.min(299, track.speedMinKmh!)) : 0,
      speedMaxKmh: Number.isFinite(track.speedMaxKmh) ? Math.max(1, Math.min(300, track.speedMaxKmh!)) : 120,
      elevationMinM: Number.isFinite(track.elevationMinM) ? Math.max(-12000, Math.min(100000, track.elevationMinM!)) : 0,
      elevationMaxM: Number.isFinite(track.elevationMaxM) ? Math.max((track.elevationMinM ?? 0) + 1, Math.min(100001, track.elevationMaxM!)) : 3000,
      lineStyle: ['solid', 'dashed', 'dotted', 'long-dashed', 'short-dashed', 'dash-dot', 'dash-dot-dot'].includes(track.lineStyle ?? '') ? track.lineStyle : 'solid',
      lineWidth: [1, 2, 3, 4, 5, 6, 8, 10].includes(track.lineWidth ?? 4) ? track.lineWidth ?? 4 : 4,
      showDirection: track.showDirection === true,
      directionStyle: ['classic', 'chevron', 'triangle', 'thin', 'large-classic', 'large-chevron', 'large-triangle'].includes(track.directionStyle ?? '') ? track.directionStyle : 'classic'
    }));
  }

  private async persistGpxTracks(tracks: GpxTrackFile[]): Promise<void> {
    if (!this.desktop) return;
    const serializedTracks = this.serializeGpxTracks(tracks);
    const operation = this.gpxSettingsWriteQueue.then(async () => {
      const settings = await this.desktop!.ProcessManager.getAppSettings();
      await this.desktop!.ProcessManager.setAppSettingsSection('gpx', {
        tracks: serializedTracks
      });
      // Remove former map-window GPX keys once they have been copied to the shared list.
      const mapWindow = settings['mapWindow'] && typeof settings['mapWindow'] === 'object'
        ? settings['mapWindow'] as Record<string, unknown> : {};
      if (mapWindow['gpxTracks'] !== undefined || mapWindow['gpxPath'] !== undefined || mapWindow['gpxFileName'] !== undefined) {
        await this.desktop!.ProcessManager.setAppSettingsSection('mapWindow', {
          gpxTracks: undefined, gpxPath: undefined, gpxFileName: undefined
        });
      }
    });
    this.gpxSettingsWriteQueue = operation.catch(error => console.error('[GPX] Could not save tracks to application config:', error));
    await operation;
  }

  private async restoreGpxTrack(): Promise<void> {
    if (!this.desktop) return;
    const settings = await this.desktop.ProcessManager.getAppSettings();
    const gpx = settings['gpx'] && typeof settings['gpx'] === 'object'
      ? settings['gpx'] as Record<string, unknown> : {};
    const mapView = gpx['mapWindow'] && typeof gpx['mapWindow'] === 'object'
      ? gpx['mapWindow'] as Record<string, unknown> : {};
    const legacyMapWindow = settings['mapWindow'] && typeof settings['mapWindow'] === 'object'
      ? settings['mapWindow'] as Record<string, unknown> : {};
    const color = mapView['color'] ?? legacyMapWindow['gpxColor'];
    if (typeof color === 'string' && this.gpxColors.some(item => item.value === color)) this.gpxColor.set(color);
    const opacity = Number(mapView['opacity'] ?? legacyMapWindow['gpxOpacity']);
    if (Number.isFinite(opacity) && opacity >= 0 && opacity <= 100) this.gpxOpacity.set(opacity);
    const visible = mapView['visible'] ?? legacyMapWindow['gpxVisible'];
    if (typeof visible === 'boolean' || visible === 'true' || visible === 'false') this.gpxVisible.set(visible === true || visible === 'true');
    if (mapView['color'] === undefined || mapView['opacity'] === undefined || mapView['visible'] === undefined) {
      await this.persistGpxMapSettings({ color: this.gpxColor(), opacity: this.gpxOpacity(), visible: this.gpxVisible() });
    }
    let tracks: GpxTrackFile[] = Array.isArray(gpx['tracks'])
      ? gpx['tracks'].filter((track): track is GpxTrackFile =>
          !!track && typeof track === 'object' && typeof track.path === 'string' && typeof track.name === 'string')
      : [];
    if (!tracks.length) {
      const mapWindow = settings['mapWindow'] && typeof settings['mapWindow'] === 'object'
        ? settings['mapWindow'] as Record<string, unknown> : {};
      const legacyStored = mapWindow['gpxTracks'];
      if (typeof legacyStored === 'string') {
        try {
          const parsed: unknown = JSON.parse(legacyStored);
          if (Array.isArray(parsed)) tracks = parsed.filter((track): track is GpxTrackFile =>
            !!track && typeof track === 'object' && typeof track.path === 'string' && typeof track.name === 'string');
        } catch { /* Continue with the former single-track keys. */ }
      }
      if (!tracks.length) {
        const legacyPath = typeof mapWindow['gpxPath'] === 'string' ? mapWindow['gpxPath'] : '';
        const legacyName = typeof mapWindow['gpxFileName'] === 'string' ? mapWindow['gpxFileName'] : '';
        if (legacyPath && legacyName) tracks = [{ path: legacyPath, name: legacyName, sizeBytes: 0, lastModified: 0 }];
      }
    }
    // Also migrate the former image-view single-track config fields into the shared list.
    const preferences = settings['preferences'] && typeof settings['preferences'] === 'object'
      ? settings['preferences'] as Record<string, unknown> : {};
    const legacyImagePath = typeof preferences['gpxTrackPath'] === 'string' ? preferences['gpxTrackPath']
      : typeof settings['gpxTrackPath'] === 'string' ? settings['gpxTrackPath'] as string : '';
    const legacyImageName = typeof preferences['gpxTrackFileName'] === 'string' ? preferences['gpxTrackFileName']
      : typeof settings['gpxTrackFileName'] === 'string' ? settings['gpxTrackFileName'] as string : '';
    if (legacyImagePath && legacyImageName && !tracks.some(track => track.path === legacyImagePath)) {
      tracks.push({ path: legacyImagePath, name: legacyImageName, sizeBytes: 0, lastModified: 0, active: true });
      const imageView = gpx['imageView'] && typeof gpx['imageView'] === 'object'
        ? gpx['imageView'] as Record<string, unknown> : {};
      await this.desktop.ProcessManager.setAppSettingsSection('gpx', {
        imageView: { ...imageView, activePath: legacyImagePath }
      });
    }
    if (legacyImagePath || legacyImageName) {
      await this.desktop.ProcessManager.setAppSettingsSection('root', {
        gpxTrackPath: undefined, gpxTrackFileName: undefined
      });
    }
    if (legacyImagePath || legacyImageName || preferences['gpxTrackOpacity'] !== undefined
        || preferences['gpxTrackColor'] !== undefined || preferences['gpxTrackVisible'] !== undefined) {
      await this.desktop.ProcessManager.setAppSettingsSection('preferences', {
        gpxTrackPath: undefined, gpxTrackFileName: undefined,
        gpxTrackOpacity: undefined, gpxTrackColor: undefined, gpxTrackVisible: undefined
      });
    }
    const segments: [number, number][][] = [];
    const available: GpxTrackFile[] = [];
    this.gpxSegmentsByTrack.clear();
    this.gpxPointDataByTrack.clear();
    this.gpxSpeedSegmentsCache.clear();
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
        available.push({ ...track, sizeBytes: metadata?.size ?? track.sizeBytes, lastModified: metadata?.modifiedAt ?? track.lastModified, missing: false, readError: false, active, color: this.gpxColors.some(item => item.value === track.color) ? track.color : this.gpxColor(), lineStyle: ['solid', 'dashed', 'dotted', 'long-dashed', 'short-dashed', 'dash-dot', 'dash-dot-dot'].includes(track.lineStyle ?? '') ? (track.lineStyle ?? 'solid') : 'solid', lineWidth: [1, 2, 3, 4, 5, 6, 8, 10].includes(track.lineWidth ?? 4) ? (track.lineWidth ?? 4) : 4, showDirection: track.showDirection === true, directionStyle: ['classic', 'chevron', 'triangle', 'thin', 'large-classic', 'large-chevron', 'large-triangle'].includes(track.directionStyle ?? '') ? (track.directionStyle ?? 'classic') : 'classic' });
      } catch (error) { this.gpxError.set(`${track.name}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    this.gpxTracks.set(available);
    void this.persistGpxTracks(available);
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
    const currentStyle = this.gpxTracks().find(track => track.path === path)?.directionStyle ?? 'classic';
    this.updateGpxTrack(path, {
      showDirection: value !== 'off',
      directionStyle: value === 'off' ? currentStyle : value as GpxTrackFile['directionStyle']
    });
    this.gpxTrackDirectionMenuOpen.set(null);
  };
  private gpxDirectionArrows(segment: [number, number][], intervalPx = 120): Array<{ position: [number, number]; bearing: number }> {
    const arrows: Array<{ position: [number, number]; bearing: number }> = [];
    if (!this.map || segment.length < 2) return arrows;
    intervalPx = Math.max(20, Math.min(200, intervalPx));
    const zoom = this.map.getZoom();
    let distanceSinceArrow = 0;
    for (let i = 1; i < segment.length; i++) {
      const [lat1, lon1] = segment[i - 1];
      const [lat2, lon2] = segment[i];
      const start = this.map.project([lat1, lon1], zoom);
      const finish = this.map.project([lat2, lon2], zoom);
      const dx = finish.x - start.x;
      const dy = finish.y - start.y;
      const length = Math.hypot(dx, dy);
      if (!Number.isFinite(length) || length <= 0) continue;
      const radians = Math.PI / 180;
      const dLon = (lon2 - lon1) * radians;
      const y = Math.sin(dLon) * Math.cos(lat2 * radians);
      const x = Math.cos(lat1 * radians) * Math.sin(lat2 * radians) -
        Math.sin(lat1 * radians) * Math.cos(lat2 * radians) * Math.cos(dLon);
      const bearing = (Math.atan2(y, x) / radians + 360) % 360;
      let remaining = intervalPx - distanceSinceArrow;
      while (remaining <= length) {
        const fraction = remaining / length;
        const point = this.map.unproject([start.x + dx * fraction, start.y + dy * fraction], zoom);
        arrows.push({ position: [point.lat, point.lng], bearing });
        remaining += intervalPx;
      }
      distanceSinceArrow = (distanceSinceArrow + length) % intervalPx;
    }
    return arrows;
  }
  private updateGpxTrack(path: string, patch: Partial<Pick<GpxTrackFile, 'color' | 'colorMode' | 'speedPalette' | 'customColor1' | 'customColor2' | 'customColor3' | 'speedMinKmh' | 'speedMaxKmh' | 'elevationMinM' | 'elevationMaxM' | 'lineStyle' | 'lineWidth' | 'showDirection' | 'directionIntervalPx' | 'directionArrowSizePx' | 'directionArrowOutlineWidthPx' | 'directionStyle' | 'active'>>): void {
    const next = this.gpxTracks().map(track => track.path === path ? { ...track, ...patch } : track);
    this.gpxTracks.set(next);
    void this.persistGpxTracks(next.filter(track => !track.path.startsWith('memory:')));
    this.applyGpxTrack();
  }

  protected readonly changeGpxTrackActive = (path: string, active: boolean): void => {
    const next = this.gpxTracks().map(track => track.path === path ? { ...track, active } : track);
    this.gpxTracks.set(next);
    void this.persistGpxTracks(next.filter(track => !track.path.startsWith('memory:')));
    this.rebuildGpxSegments();
    this.applyGpxTrack();
    void this.refreshLatestGpxElevationProfile();
  };

  private rebuildGpxSegments(): void {
    // Update the time range before filtering points; otherwise the initial
    // persisted slider range (0..0) hides every timestamped point.
    this.updateTimeSliderBounds();
    const sourceTracks = this.gpxListMode() === 'database' ? this.gpxDatabaseTracks() : this.gpxTracks();
    this.gpxSegments = sourceTracks
      .filter(track => track.active !== false)
      .flatMap(track => this.visibleGpxSegments(track));
    this.updateWalkingMarker();
  }

  private visibleGpxSegments(track: GpxTrackFile): [number, number][][] {
    const source = this.gpxSegmentsByTrack.get(track.path) ?? [];
    if (!this.timeSliderActive()) return source;
    const pointSegments = this.gpxPointDataByTrack.get(track.path) ?? [];
    const visible: [number, number][][] = [];
    source.forEach((sourceSegment, index) => {
      const segment = pointSegments[index];
      if (track.databasePath && this.timeSliderActive() && !segment?.some(point => {
        const timestamp = point.timestamp ? Date.parse(point.timestamp) / 1000 : null;
        return point.inViewport !== false && this.isTimeSliderTimestampVisible(Number.isFinite(timestamp) ? timestamp : null);
      })) return;
      // Routes without timestamps (e.g. routes returned by openrouteservice)
      // are independent of the GPX time slider and must remain visible.
      if (!segment?.some(point => point.timestamp && Number.isFinite(Date.parse(point.timestamp)))) {
        if (sourceSegment.length >= 2) visible.push(sourceSegment);
        return;
      }
      let run: [number, number][] = [];
      const flush = (): void => { if (run.length >= 2) visible.push(run); run = []; };
      for (const point of segment) {
        const timestamp = point.timestamp ? Date.parse(point.timestamp) / 1000 : Number.NaN;
        if (!Number.isFinite(timestamp) || (timestamp >= this.timeSliderStart() && timestamp <= this.timeSliderEnd())) {
          run.push([point.latitude, point.longitude]);
        } else flush();
      }
      flush();
    });
    return visible;
  }

  private isTimeSliderTimestampVisible(timestamp: number | null | undefined): boolean {
    if (!this.timeSliderActive() || timestamp == null || !Number.isFinite(timestamp)) return true;
    return timestamp >= this.timeSliderStart() && timestamp <= this.timeSliderEnd();
  }

  protected readonly timeSliderBoundarySource = (timestamp: number): string => {
    // A single available timestamp gets a +1 second slider span; its source is still the original timestamp.
    const sourceTimestamp = timestamp === this.timeSliderMaximum()
      && this.timeSliderMaximum() === this.timeSliderMinimum() + 1
      ? this.timeSliderMinimum() : timestamp;
    const sources: string[] = [];
    const sourceTracks = this.gpxListMode() === 'database' ? this.gpxDatabaseTracks() : this.gpxTracks();
    for (const track of sourceTracks.filter(item => !item.missing && !item.readError)) {
      const points = (this.gpxPointDataByTrack.get(track.path) ?? []).flat();
      if (points.some(point => point.inViewport !== false && point.timestamp && Number.isFinite(Date.parse(point.timestamp))
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
      // Loaded GPX tracks define the available time range even when their
      // map visibility is switched off. Track visibility must not hide the
      // time controls or make photo GPS timestamps a prerequisite.
      ...(this.gpxListMode() === 'database' ? this.gpxDatabaseTracks() : this.gpxTracks()).filter(track => !track.missing && !track.readError)
        .flatMap(track => (this.gpxPointDataByTrack.get(track.path) ?? []).flat())
        .filter(point => point.inViewport !== false)
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

  protected readonly timeSliderNoDataHelpText = (): string =>
    (this.gpxListMode() === 'database' ? this.gpxDatabaseTracks() : this.gpxTracks()).some(track => !track.missing && !track.readError)
      ? 'The available GPX files contain no usable point timestamps. Track points need time values to define the time range.'
      : 'Load GPX files with timestamped track points or enable photo markers with timestamps to define the time range.';

  protected readonly timeSliderHelpText = (): string => {
    const hasTracks = (this.gpxListMode() === 'database' ? this.gpxDatabaseTracks() : this.gpxTracks()).some(track => !track.missing && !track.readError
      && (this.gpxPointDataByTrack.get(track.path) ?? []).flat()
        .some(point => point.inViewport !== false && point.timestamp && Number.isFinite(Date.parse(point.timestamp))));
    const hasTimedPhotoMarkers = this.directoryMarkersEnabled()
      && this.directoryPhotoTimestampMarkers.some(marker => marker.gpsTimestamp != null && Number.isFinite(marker.gpsTimestamp));
    if (hasTracks && hasTimedPhotoMarkers) return 'Only timestamped GPX track points and photos within this time range are filtered. Items without timestamps remain visible.';
    if (hasTracks) return 'Timestamped GPX track points are filtered by this time range. Items without timestamps remain visible.';
    if (hasTimedPhotoMarkers) return 'Timestamped photos are filtered by this time range. Photos without timestamps remain visible.';
    return 'No timestamped GPX track points or photo markers are available.';
  };

  protected readonly formatTimeSliderDate = (timestamp: number): string =>
    Number.isFinite(timestamp) && timestamp > 0 ? formatOsDateTime(timestamp * 1000) : '–';

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

  protected readonly changeTimeSliderAnimationSectionOpen = (open: boolean): void => {
    if (this.timeSliderAnimationSectionOpen() === open) return;
    this.timeSliderAnimationSectionOpen.set(open);
    this.saveSetting('timeSliderAnimationSectionOpen', open);
    this.persistLocationUiState({ timeSliderAnimationSectionOpen: open });
  };

  protected readonly snapWalkingFigureRotation = (): void => {
    const current = this.selectedWalkingFigureSymbolSettings().rotation;
    const snapped = (Math.round(current / 90) * 90) % 360;
    this.updateSelectedWalkingFigureSettings({ rotation: snapped });
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
    const sourceTracks = this.gpxListMode() === 'database' ? this.gpxDatabaseTracks() : this.gpxTracks();
    return sourceTracks.find(track => track.active !== false && !track.missing && (this.gpxPointDataByTrack.get(track.path)?.some(segment => segment.length > 0) ?? false));
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
    if (!Object.hasOwn(GPX_SYMBOLS, value)) return;
    this.walkingFigureType.set(value);
    this.saveSetting('walkingFigureType', value);
    this.updateWalkingMarker();
  };

  private normalizeWalkingFigureSymbolSettings(value: Record<string, Partial<TimeSliderSymbolSettings>>): Record<string, TimeSliderSymbolSettings> {
    return normalizeGpxSymbolSettings(value);
  }

  protected readonly selectedWalkingFigureSymbolSettings = (): TimeSliderSymbolSettings =>
    this.walkingFigureSymbolSettings()[this.walkingFigureType()] ?? { rotation: 0, flipHorizontal: false };

  protected readonly walkingFigurePreviewHtml = (): string => {
    if (this.walkingFigureType() === 'walker') {
      return '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="38" viewBox="0 0 30 38" aria-hidden="true"><circle cx="15" cy="6" r="4.2" fill="#ffd166" stroke="#202020" stroke-width="1.2"/><path d="M15 11 L15 23" stroke="#1769aa" stroke-width="5" stroke-linecap="round"/><path d="M14 14 L8 21" stroke="#ffd166" stroke-width="3.2" stroke-linecap="round"/><path d="M16 14 L22 21" stroke="#ffd166" stroke-width="3.2" stroke-linecap="round"/><path d="M14 23 L9 34" stroke="#263238" stroke-width="4" stroke-linecap="round"/><path d="M16 23 L21 34" stroke="#263238" stroke-width="4" stroke-linecap="round"/></svg>';
    }
    return this.walkingFigurePreviewSymbol();
  };

  protected readonly walkingFigurePreviewSymbol = (): string =>
    GPX_SYMBOLS[this.walkingFigureType()] ?? GPX_SYMBOLS['walker'];

  protected readonly walkingFigurePreviewTransform = (): string => {
    return buildGpxSymbolTransform({
      figureType: this.walkingFigureType(),
      bearing: 90,
      settings: this.selectedWalkingFigureSymbolSettings()
    });
  };

  private updateSelectedWalkingFigureSettings(patch: Partial<TimeSliderSymbolSettings>, persistConfig = true): void {
    const symbol = this.walkingFigureType();
    const current = this.selectedWalkingFigureSymbolSettings();
    const next = { ...this.walkingFigureSymbolSettings(), [symbol]: { ...current, ...patch } };
    this.walkingFigureSymbolSettings.set(next);
    this.saveSetting('timeSliderSymbolSettings', JSON.stringify(next));
    if (persistConfig) this.persistLocationUiState({ timeSliderSymbolSettings: next });
    this.updateWalkingMarker();
  }

  protected readonly persistWalkingFigureRotation = (): void => {
    this.persistLocationUiState({ timeSliderSymbolSettings: this.walkingFigureSymbolSettings() });
  };

  protected readonly changeWalkingFigureRotation = (value: string | number): void => {
    const rotation = Number(value);
    if (!Number.isFinite(rotation)) return;
    this.updateSelectedWalkingFigureSettings({ rotation: ((Math.round(rotation) % 360) + 360) % 360 }, false);
  };

  protected readonly changeWalkingFigureFlipHorizontal = (enabled: boolean): void => {
    this.updateSelectedWalkingFigureSettings({ flipHorizontal: enabled });
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

    // Manual slider seeking must use the exact GPX heading immediately.
    // Time-based smoothing is only useful during continuous playback. Otherwise
    // rapid seek operations accumulate a turn-rate-limited lag and the marker
    // appears to rotate gradually even though the selected GPX position changed.
    if (!this.timeSliderAnimating()) {
      this.smoothedWalkingBearing = bearing;
      this.lastWalkingBearingUpdate = Date.now();
    } else {
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
    }
    bearing = this.smoothedWalkingBearing ?? bearing;
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

    const symbolSettings = this.walkingFigureSymbolSettings()[figureType] ?? { rotation: 0, flipHorizontal: false };
    // The shared transform owns compass-to-artwork orientation, automatic direction
    // mirroring, manual correction, vertical correction and scaling.
    const symbolTransform = buildGpxSymbolTransform({
      figureType, bearing, settings: symbolSettings, size: this.walkingFigureSize()
    });
    const animationDuration = gpxAnimationDuration(gaitSpeed);
    const html = isWalking
      ? `<div class="lumascope-walker" data-figure-type="walker" style="display:block;width:24px;height:30px;position:relative;filter:drop-shadow(0 1px 1px #000b);transform-origin:50% 50%"><svg width="24" height="30" viewBox="0 0 30 38" style="display:block;width:24px;height:30px;overflow:visible" aria-hidden="true"><circle cx="15" cy="6" r="4.2" fill="#ffd166" stroke="#202020" stroke-width="1.2"/><path d="M15 11 L15 23" stroke="#1769aa" stroke-width="5" stroke-linecap="round"/><path class="walker-limb walker-arm back" d="M14 14 L8 21" stroke="#ffd166" stroke-width="3.2" stroke-linecap="round"/><path class="walker-limb walker-arm" d="M16 14 L22 21" stroke="#ffd166" stroke-width="3.2" stroke-linecap="round"/><path class="walker-limb walker-leg back" d="M14 23 L9 34" stroke="#263238" stroke-width="4" stroke-linecap="round"/><path class="walker-limb walker-leg" d="M16 23 L21 34" stroke="#263238" stroke-width="4" stroke-linecap="round"/></svg></div>`
      : `<div class="lumascope-walker lumascope-vehicle" data-figure-type="${figureType}" style="display:flex;align-items:center;justify-content:center;width:32px;height:32px;font-family:'Segoe UI Emoji',sans-serif;font-size:27px;line-height:1;filter:drop-shadow(0 1px 2px #000b);transform-origin:50% 50%">${GPX_VEHICLE_SYMBOLS[figureType]}</div>`;
    if (this.offlineRenderer) {
      this.walkingMarker?.remove(); this.walkingMarker = null;
      this.walkingMapLibreMarker?.remove(); this.walkingMapLibreMarker = null;
      this.offlineRenderer.setWalkingFigure(latitude, longitude, html, symbolTransform, animationDuration, figureType, isMoving);
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
      walkerElement.style.transform = symbolTransform;
      walkerElement.style.setProperty('--walker-animation-duration', animationDuration);
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
    const opacity = this.coordinatesAvailable() && this.currentImageHasGps() && this.locationVisible() && withinTimeRange ? this.locationOpacity() / 100 : 0;
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
    const separated = fileName.match(/(?:^|[^0-9])(\d{4})[_-](\d{2})[_-](\d{2})[ T_-](\d{2})[_:-](\d{2})[_:-](\d{2})(?:[^0-9]|$)/);
    const compact = separated ? null : fileName.match(/(?:^|[^0-9])(\d{4})(\d{2})(\d{2})[_ T-](\d{2})(\d{2})(\d{2})(?:[^0-9]|$)/);
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

  protected readonly changeRouteApiKey = (value: string): void => {
    this.routeApiKey.set(value);
    this.persistLocationUiState({ openRouteServiceApiKey: value || undefined });
  };

  protected readonly routeProviderSelection = (): string =>
    this.routeProvider() === 'openrouteservice'
      ? 'openrouteservice'
      : 'offline-valhalla|' + this.routeValhallaConfigPath();

  protected readonly changeRouteProviderSelection = (value: string): void => {
    if (value === 'openrouteservice') {
      this.routeProvider.set('openrouteservice');
      return;
    }
    this.routeProvider.set('offline-valhalla');
    const path = value.startsWith('offline-valhalla|') ? value.slice('offline-valhalla|'.length) : '';
    if (path) {
      this.routeValhallaConfigPath.set(path);
      void this.applyValhallaConfigPath();
    }
  };

  protected readonly addValhallaConfig = async (): Promise<void> => {
    if (!this.desktop) return;
    this.routeConfigBusy.set(true);
    try {
      const status = await this.desktop.Valhalla.addConfig();
      this.valhallaConfigurations.set(status.configurations ?? []);
      if (!this.routeValhallaConfigPath() && status.configPath) this.routeValhallaConfigPath.set(status.configPath);
      this.routeStatus.set('Valhalla configuration list updated.');
    } catch (error) {
      this.routeStatus.set(error instanceof Error ? error.message : String(error));
    } finally { this.routeConfigBusy.set(false); }
  };

  protected readonly setActiveValhallaConfig = async (path: string): Promise<void> => {
    this.routeValhallaConfigPath.set(path);
    this.routeProvider.set('offline-valhalla');
    await this.applyValhallaConfigPath();
  };

  protected readonly removeValhallaConfig = async (path: string): Promise<void> => {
    if (!this.desktop) return;
    this.routeConfigBusy.set(true);
    try {
      const status = await this.desktop.Valhalla.removeConfig(path);
      this.valhallaConfigurations.set(status.configurations ?? []);
      this.routeValhallaConfigPath.set(status.configPath || '');
      this.routeStatus.set('Valhalla configuration removed from the list. The JSON file was not deleted.');
    } catch (error) {
      this.routeStatus.set(error instanceof Error ? error.message : String(error));
    } finally { this.routeConfigBusy.set(false); }
  };

  protected readonly applyValhallaConfigPath = async (): Promise<void> => {
    const path = this.routeValhallaConfigPath().trim();
    if (!path) { this.routeStatus.set('Enter the path to valhalla.json.'); return; }
    const desktop = this.desktop;
    if (!desktop) { this.routeStatus.set('The desktop Valhalla service is unavailable.'); return; }
    this.routeConfigBusy.set(true);
    try {
      const status = await desktop.Valhalla.setConfigPath(path);
      this.saveSetting('valhallaConfigPath', status.configPath);
      this.routeStatus.set(status.configAvailable ? 'Valhalla configuration saved.' : 'Valhalla configuration is not available.');
    } catch (error) {
      this.routeStatus.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.routeConfigBusy.set(false);
    }
  };

  protected readonly addRouteWaypoint = (latitude: number, longitude: number): void => {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
      || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return;
    const waypoint: RouteWaypoint = { latitude, longitude, active: true };
    this.routeWaypoints.update(points => [...points, waypoint]);
    this.persistRouteWaypoints();
    this.updateRouteWaypointMarkers();
    void this.resolveRouteWaypointName(waypoint);
  };

  protected readonly changeRouteWaypointActive = (index: number, active: boolean): void => {
    this.routeWaypoints.update(points => points.map((point, i) => i === index ? { ...point, active } : point));
    this.persistRouteWaypoints();
  };

  protected readonly activeRouteWaypointCount = (): number =>
    this.routeWaypoints().filter(point => point.active !== false).length;

  protected readonly moveRouteWaypoint = (index: number, direction: -1 | 1): void => {
    const points = [...this.routeWaypoints()];
    const target = index + direction;
    if (index < 0 || target < 0 || index >= points.length || target >= points.length) return;
    [points[index], points[target]] = [points[target], points[index]];
    this.routeWaypoints.set(points);
    this.persistRouteWaypoints();
    this.updateRouteWaypointMarkers();
  };

  protected readonly removeRouteWaypoint = (index: number): void => {
    this.routeWaypoints.update(points => points.filter((_, i) => i !== index));
    this.persistRouteWaypoints();
    this.updateRouteWaypointMarkers();
  };

  protected readonly clearRouteWaypoints = (): void => {
    this.routeWaypoints.set([]);
    this.persistRouteWaypoints();
    this.updateRouteWaypointMarkers();
    this.routeStatus.set('');
  };

  private persistRouteWaypoints(): void {
    this.persistLocationUiState({ routeWaypoints: this.routeWaypoints().map(point => ({
      latitude: point.latitude, longitude: point.longitude, active: point.active !== false,
      ...(point.name ? { name: point.name } : {})
    })) });
  }

  private async resolveRouteWaypointName(waypoint: RouteWaypoint): Promise<void> {
    try {
      const result = await lookupReverseGeocoding(waypoint.latitude, waypoint.longitude, navigator.language || 'en');
      const name = result?.displayName?.trim();
      if (!name) return;
      this.routeWaypoints.update(points => points.map(point => point.latitude === waypoint.latitude && point.longitude === waypoint.longitude ? { ...point, name } : point));
      this.persistRouteWaypoints();
    } catch (error) {
      console.warn('[Routing] Could not resolve route point location:', error);
    }
  }

  protected readonly gpxWaypointCount = (path: string): number =>
    (this.gpxSegmentsByTrack.get(path) ?? []).reduce((count, segment) => count + segment.length, 0);

  protected readonly gpxVisibleWaypointCount = (track: GpxTrackFile): number => {
    const points = (this.gpxPointDataByTrack.get(track.path) ?? []).flat();
    return points.filter(point => {
      if (point.inViewport === false) return false;
      const timestamp = point.timestamp ? Date.parse(point.timestamp) / 1000 : Number.NaN;
      return !this.timeSliderActive() || !Number.isFinite(timestamp)
        || (timestamp >= this.timeSliderStart() && timestamp <= this.timeSliderEnd());
    }).length;
  };

  protected readonly gpxTrackDirectoryPath = (track: GpxTrackFile): string => {
    const filePath = track.databasePath || track.path;
    const separatorIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    return separatorIndex >= 0 ? filePath.slice(0, separatorIndex + 1) : '';
  };

  protected readonly gpxDatabaseVisibleTracks = computed(() => {
    const sort = this.gpxDatabaseSort();
    const databaseMode = this.gpxListMode() === 'database';
    const tracks = databaseMode
      ? this.gpxDatabaseTracks().filter(track => this.gpxVisibleWaypointCount(track) > 0)
      : this.gpxTracks();
    const timestamp = (track: GpxTrackFile): number => {
      let earliest = Number.MAX_SAFE_INTEGER;
      for (const segment of this.gpxPointDataByTrack.get(track.path) ?? []) {
        for (const point of segment) {
          if (point.inViewport === false || !point.timestamp) continue;
          const value = Date.parse(point.timestamp);
          if (Number.isFinite(value) && value < earliest) earliest = value;
        }
      }
      return earliest;
    };
    const value = (track: GpxTrackFile): string | number => {
      switch (sort.key) {
        case 'active': return track.active === false ? 0 : 1;
        case 'name': return track.name.toLocaleLowerCase();
        case 'points': return databaseMode ? this.gpxVisibleWaypointCount(track) : this.gpxWaypointCount(track.path);
        case 'time': return timestamp(track);
        case 'size': return track.sizeBytes;
        case 'modified': return track.lastModified;
        case 'path': return (track.databasePath || track.path).toLocaleLowerCase();
        case 'color': return (track.color || '').toLocaleLowerCase();
        case 'line': return (track.lineStyle || 'solid').toLocaleLowerCase();
        case 'width': return track.lineWidth || 3;
        case 'arrows': return track.showDirection ? (track.directionStyle || 'classic') : 'off';
      }
    };
    return [...tracks].sort((a, b) => {
      const av = value(a), bv = value(b);
      const result = av < bv ? -1 : av > bv ? 1 : 0;
      return sort.direction === 'asc' ? result : -result;
    });
  });
  protected readonly gpxDatabaseGridColumns = (): string => {
    const widths = this.gpxDatabaseColumnWidths();
    const columns = this.gpxDatabaseColumns();
    return [
      widths['active'] + 'px', widths['name'] + 'px',
      ...(columns.points ? [widths['points'] + 'px'] : []),
      ...(columns.modified ? [widths['modified'] + 'px'] : []),
      ...(columns.time ? [widths['time'] + 'px'] : []),
      ...(columns.size ? [widths['size'] + 'px'] : []),
      ...(columns.path ? [widths['path'] + 'px'] : []),
      '250px', '74px'
    ].join(' ');
  };
  protected readonly setGpxDatabaseColumn = (key: 'points' | 'time' | 'size' | 'modified' | 'path', visible: boolean): void => this.gpxDatabaseColumns.update(columns => ({ ...columns, [key]: visible }));
  protected readonly sortGpxDatabase = (key: 'active' | 'name' | 'points' | 'time' | 'size' | 'modified' | 'path' | 'color' | 'line' | 'width' | 'arrows'): void => this.gpxDatabaseSort.update(sort => ({ key, direction: sort.key === key && sort.direction === 'asc' ? 'desc' : 'asc' }));
  protected readonly gpxDatabaseSortIndicator = (key: 'active' | 'name' | 'points' | 'time' | 'size' | 'modified' | 'path' | 'color' | 'line' | 'width' | 'arrows'): string => this.gpxDatabaseSort().key === key ? (this.gpxDatabaseSort().direction === 'asc' ? '▲' : '▼') : '↕';
  protected readonly startGpxColumnResize = (event: PointerEvent, key: string): void => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = this.gpxDatabaseColumnWidths()[key] ?? 100;
    const move = (moveEvent: PointerEvent): void => {
      const width = Math.max(key === 'active' ? 76 : 42, Math.min(900, startWidth + moveEvent.clientX - startX));
      this.gpxDatabaseColumnWidths.update(current => ({ ...current, [key]: width }));
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.saveSetting('gpxDatabaseColumnWidths', JSON.stringify(this.gpxDatabaseColumnWidths()));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };
  protected readonly gpxListWaypointCount = (track: GpxTrackFile): number =>
    this.gpxListMode() === 'database' ? this.gpxVisibleWaypointCount(track) : this.gpxWaypointCount(track.path);
  protected readonly changeGpxListTrack = (path: string, patch: Partial<Pick<GpxTrackFile, 'active' | 'color' | 'colorMode' | 'speedPalette' | 'customColor1' | 'customColor2' | 'customColor3' | 'speedMinKmh' | 'speedMaxKmh' | 'elevationMinM' | 'elevationMaxM' | 'lineStyle' | 'lineWidth' | 'showDirection' | 'directionIntervalPx' | 'directionArrowSizePx' | 'directionArrowOutlineWidthPx' | 'trackShadowStrength' | 'arrowShadowStrength' | 'trackOutlineStrength' | 'directionStyle'>>): void => {
    if (this.gpxListMode() === 'database') this.changeGpxDatabaseTrack(path, patch);
    else if (patch.active !== undefined) this.changeGpxTrackActive(path, patch.active);
    else this.updateGpxTrack(path, patch);
  };
  private async ensureGpxDatabaseTrackSettingsLoaded(): Promise<void> {
    if (this.gpxDatabaseTrackSettingsLoaded || !this.desktop) return;
    try {
      const settings = await this.desktop.ProcessManager.getAppSettings();
      const gpx = settings['gpx'] && typeof settings['gpx'] === 'object' ? settings['gpx'] as Record<string, unknown> : {};
      const saved = gpx['databaseTrackSettings'];
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        for (const [path, value] of Object.entries(saved as Record<string, unknown>)) {
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            this.gpxDatabaseTrackSettings.set(path, value as Partial<Pick<GpxTrackFile, 'active' | 'color' | 'colorMode' | 'speedPalette' | 'customColor1' | 'customColor2' | 'customColor3' | 'speedMinKmh' | 'speedMaxKmh' | 'elevationMinM' | 'elevationMaxM' | 'lineStyle' | 'lineWidth' | 'showDirection' | 'directionIntervalPx' | 'directionArrowSizePx' | 'directionArrowOutlineWidthPx' | 'trackShadowStrength' | 'arrowShadowStrength' | 'trackOutlineStrength' | 'directionStyle'>>);
          }
        }
      }
      this.gpxDatabaseTrackSettingsLoaded = true;
    } catch (error) {
      console.warn('[GPX] Could not restore database track settings:', error);
    }
  }

  private persistGpxDatabaseTrackSettings(): void {
    if (!this.desktop) return;
    const snapshot = Object.fromEntries(this.gpxDatabaseTrackSettings);
    const operation = this.gpxDatabaseSettingsWriteQueue.then(async () => {
      await this.desktop!.ProcessManager.setAppSettingsSection('gpx', { databaseTrackSettings: snapshot });
    });
    this.gpxDatabaseSettingsWriteQueue = operation.catch(error => console.error('[GPX] Could not save database track settings:', error));
  }

  protected readonly changeGpxSpeedRange = (path: string, bound: 'min' | 'max', value: string): void => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return;
    const tracks = this.gpxListMode() === 'database' ? this.gpxDatabaseTracks() : this.gpxTracks();
    const track = tracks.find(item => item.path === path);
    if (!track) return;
    const currentMin = track.speedMinKmh ?? 0;
    const currentMax = track.speedMaxKmh ?? 120;
    if (bound === 'min') {
      const speedMinKmh = Math.max(0, Math.min(299, Math.round(numeric)));
      this.changeGpxListTrack(path, { speedMinKmh, speedMaxKmh: Math.max(currentMax, speedMinKmh + 1) });
    } else {
      const speedMaxKmh = Math.max(1, Math.min(300, Math.round(numeric)));
      this.changeGpxListTrack(path, { speedMaxKmh, speedMinKmh: Math.min(currentMin, speedMaxKmh - 1) });
    }
  };

  protected readonly changeGpxDatabaseTrack = (path: string, patch: Partial<Pick<GpxTrackFile, 'active' | 'color' | 'colorMode' | 'speedPalette' | 'customColor1' | 'customColor2' | 'customColor3' | 'speedMinKmh' | 'speedMaxKmh' | 'elevationMinM' | 'elevationMaxM' | 'lineStyle' | 'lineWidth' | 'showDirection' | 'directionIntervalPx' | 'directionArrowSizePx' | 'directionArrowOutlineWidthPx' | 'directionStyle'>>): void => {
    const databasePath = this.gpxDatabaseTracks().find(track => track.path === path)?.databasePath;
    if (databasePath) this.gpxDatabaseTrackSettings.set(databasePath, { ...this.gpxDatabaseTrackSettings.get(databasePath), ...patch });
    if (databasePath) this.persistGpxDatabaseTrackSettings();
    const tracks = this.gpxDatabaseTracks().map(track => track.path === path ? { ...track, ...patch } : track);
    this.gpxDatabaseTracks.set(tracks);
    this.rebuildGpxSegments();
    this.applyGpxTrack();
    if (patch.active !== undefined) void this.refreshLatestGpxElevationProfile();
  };

  protected readonly changeRouteWaypointMarkersVisible = (visible: boolean): void => {
    this.routeWaypointMarkersVisible.set(visible);
    this.saveSetting('routeWaypointMarkersVisible', String(visible));
    this.updateRouteWaypointMarkers();
  };

  private updateRouteWaypointMarkers(): void {
    for (const marker of this.routeWaypointMarkers) marker.remove();
    this.routeWaypointMarkers = [];
    const points = this.routeWaypoints();
    const visible = this.routeWaypointMarkersVisible();
    if (this.offlineRenderer) {
      this.offlineRenderer.setRouteWaypoints(points, visible);
      return;
    }
    if (!this.map || !this.leaflet || !visible) return;
    points.forEach((point, index) => {
      const endpoint = points.length >= 2 && index === 0 ? 'start' : points.length >= 2 && index === points.length - 1 ? 'end' : 'point';
      const label = endpoint === 'start' ? 'S' + (index + 1) : endpoint === 'end' ? 'E' + (index + 1) : String(index + 1);
      const size = endpoint === 'point' ? 36 : 42;
      const icon = this.leaflet!.divIcon({
        className: 'routing-waypoint-icon',
        html: '<span class="' + endpoint + '">' + label + '</span>',
        iconSize: [size, size], iconAnchor: [size / 2, size / 2]
      });
      this.routeWaypointMarkers.push(this.leaflet!.marker([point.latitude, point.longitude], { icon }).addTo(this.map!) as MapMarker & { remove(): void });
    });
  }

  private async requestRouteGeometry(
    provider: RouteProviderId,
    request: RouteCalculationRequest
  ): Promise<RouteCalculationResult> {
    switch (provider) {
      case 'openrouteservice': {
        const apiKey = request.apiKey?.trim();
        if (!apiKey) throw new Error('Enter your openrouteservice API key first.');
        if (request.points.length > 50) {
          throw new Error('openrouteservice supports at most 50 active waypoints per request.');
        }
        const response = await fetch('https://api.openrouteservice.org/v2/directions/' + request.profile + '/geojson', {
          method: 'POST',
          headers: { 'Authorization': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/geo+json, application/json' },
          body: JSON.stringify({
            coordinates: request.points.map(point => [point.longitude, point.latitude]),
            instructions: false
          })
        });
        if (!response.ok) {
          const detail = await response.text();
          throw new Error('openrouteservice returned HTTP ' + response.status + ': ' + detail.slice(0, 500));
        }
        const payload = await response.json() as { features?: Array<{ geometry?: { type?: string; coordinates?: number[][] } }> };
        const coordinates = payload.features?.[0]?.geometry?.coordinates;
        if (!coordinates || coordinates.length < 2) {
          throw new Error('The routing service returned no usable route geometry.');
        }
        const routePoints = coordinates
          .filter(point => Array.isArray(point) && point.length >= 2
            && Number.isFinite(point[0]) && Number.isFinite(point[1]))
          .map(point => ({ latitude: point[1], longitude: point[0] }));
        if (routePoints.length < 2) {
          throw new Error('The returned route contains fewer than two valid coordinates.');
        }
        return { provider, coordinates: routePoints };
      }
      case 'offline-valhalla': {
        const desktop = this.desktop;
        if (!desktop) throw new Error('The desktop Valhalla service is unavailable.');
        const selectedConfig = this.routeValhallaConfigPath().trim();
        if (!selectedConfig) throw new Error('Add and select a Valhalla configuration in Offline first.');
        await desktop.Valhalla.setConfigPath(selectedConfig);
        const result = await desktop.Valhalla.route({
          points: request.points,
          profile: request.profile
        });
        return { provider, coordinates: result.coordinates };
      }
    }
  }

  protected readonly changeRouteName = (value: string): void => {
    this.routeName.set(value);
    this.saveSetting('routeName', value);
  };

  protected readonly chooseRouteSaveLocation = async (): Promise<void> => {
    const desktop = this.desktop;
    if (!desktop) { this.routeStatus.set('The desktop folder picker is unavailable.'); return; }
    try {
      const result = await desktop.Dialogs.openFolder(this.routeSaveDirectory() || undefined);
      if (!result.success) return;
      this.routeSaveDirectory.set(result.data);
      this.saveSetting('routeSaveDirectory', result.data);
      this.routeStatus.set('Route save location updated.');
    } catch (error) {
      this.routeStatus.set(error instanceof Error ? error.message : String(error));
    }
  };

  protected readonly calculateRoute = async (): Promise<void> => {
    const desktop = this.desktop;
    if (!desktop) { this.routeStatus.set('The desktop file system is unavailable.'); return; }
    const points = this.routeWaypoints();
    const activePoints = points.filter(point => point.active !== false);
    const apiKey = this.routeApiKey().trim();
    if (activePoints.length < 2) { this.routeStatus.set('Activate at least two route points.'); return; }
    const provider = this.routeProvider();
    if (provider === 'openrouteservice' && !apiKey) {
      this.routeStatus.set('Enter your openrouteservice API key first.');
      return;
    }
    const providerName = provider;
    const requestTimestamp = new Date().toISOString();
    const requestProfile = this.routeProfile();
    const generation = ++this.routeRequestGeneration;
    this.routeBusy.set(true);
    this.routeStatus.set('Requesting route from ' + providerName + '…');
    try {
      const routeResult = await this.requestRouteGeometry(provider, {
        points: activePoints,
        profile: requestProfile,
        apiKey
      });
      const routePoints = routeResult.coordinates;
      if (generation !== this.routeRequestGeneration) return;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace(/Z$/, '');
      const baseName = this.routeName().trim().replace(/[\\/:*?"<>|]/g, '-').replace(/[. ]+$/g, '') || 'Route';
      const defaultName = baseName + '_' + timestamp + '.gpx';
      let destination = '';
      const selectedFolder = this.routeSaveDirectory().trim();
      if (selectedFolder) {
        destination = await desktop.FileSystem.join(selectedFolder, defaultName);
      } else {
        const lastTrack = [...this.gpxTracks()].reverse().find(track => !track.path.startsWith('memory:'));
        const folder = lastTrack ? await desktop.FileSystem.dirname(lastTrack.path) : '';
        const suggestedPath = folder ? await desktop.FileSystem.join(folder, defaultName) : defaultName;
        const save = await desktop.Dialogs.saveFile(suggestedPath);
        if (!save.success) { this.routeStatus.set('Route calculated; saving was cancelled.'); return; }
        destination = save.data;
        const selectedDirectory = await desktop.FileSystem.dirname(destination);
        if (selectedDirectory) {
          this.routeSaveDirectory.set(selectedDirectory);
          this.saveSetting('routeSaveDirectory', selectedDirectory);
        }
      }
      if (!/\.gpx$/i.test(destination)) destination += '.gpx';
      const fileName = destination.split(/[\\/]/).pop() || defaultName;
      const trackPoints = routePoints.map(point => '      <trkpt lat="' + point.latitude.toFixed(8) + '" lon="' + point.longitude.toFixed(8) + '"/>').join('\n');
      const returnedWaypointCount = routePoints.length;
      const routingPointMetadata = {
        version: 1,
        provider: providerName,
        returnedWaypointCount,
        requestTimestamp,
        profile: requestProfile,
        points: points.map(point => ({
          latitude: point.latitude,
          longitude: point.longitude,
          name: point.name ?? '',
          active: point.active !== false
        }))
      };
      // Escape hyphens so arbitrary location names cannot create an illegal "--" XML comment sequence.
      const routingPointComment = JSON.stringify(routingPointMetadata).replace(/-/g, '\\u002d');
      const content = '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<gpx version="1.1" creator="LumaScope" xmlns="http://www.topografix.com/GPX/1/1">\n'
        + '<!-- LumaScope routing-waypoints v1\n' + routingPointComment + '\n-->\n'
        + '  <trk><name>' + this.escapeMarkerHtml(fileName.replace(/\.gpx$/i, '')) + '</name><trkseg>\n'
        + trackPoints + '\n  </trkseg></trk>\n</gpx>\n';
      const written = await desktop.FileSystem.writeText(destination, content);
      if (!written.success) throw new Error(written.errorMessage);
      const parsed = this.parseGpxTrackData(content);
      const track: GpxTrackFile = { path: destination, name: fileName, sizeBytes: new Blob([content]).size, lastModified: Date.now(), active: true,
        color: this.gpxColors[this.gpxTracks().length % this.gpxColors.length]?.value ?? this.gpxColor(), lineStyle: 'solid', lineWidth: 4 };
      this.gpxTracks.set([...this.gpxTracks(), track]);
      this.lastSavedRouteGpxPath.set(destination);
      this.gpxSegmentsByTrack.set(destination, parsed);
      this.gpxPointDataByTrack.set(destination, this.parseGpxTrackPointData(content));
      await this.persistGpxTracks(this.gpxTracks().filter(item => !item.path.startsWith('memory:')));
      this.rebuildGpxSegments();
      this.applyGpxTrack();
      this.fitGpxTrack(destination);
      this.routeStatus.set('Saved GPX: ' + destination + ' (' + returnedWaypointCount + ' waypoints returned by routing server). Route added to GPX track list; route points were kept.');
    } catch (error) {
      this.routeStatus.set(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === this.routeRequestGeneration) this.routeBusy.set(false);
    }
  };

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
      void this.persistGpxTracks(this.gpxTracks().filter(item => !item.path.startsWith('memory:')));
      this.rebuildGpxSegments();
      this.gpxError.set('');
      this.applyGpxTrack();
      this.fitGpxTrack();
    } catch (error) {
      this.gpxError.set(error instanceof Error ? error.message : String(error));
    }
  };

  private parseRoutingWaypointsFromGpx(content: string): RouteWaypoint[] | null {
    const xml = new DOMParser().parseFromString(content, 'application/xml');
    if (xml.getElementsByTagName('parsererror').length) return null;
    const comments: string[] = [];
    const walker = xml.createTreeWalker(xml, NodeFilter.SHOW_COMMENT);
    let node: Node | null;
    while ((node = walker.nextNode())) comments.push(node.textContent ?? '');

    for (const comment of comments) {
      const marker = 'LumaScope routing-waypoints v1';
      const markerIndex = comment.indexOf(marker);
      if (markerIndex >= 0) {
        try {
          const metadata = JSON.parse(comment.slice(markerIndex + marker.length).trim()) as { version?: number; points?: unknown };
          if (metadata.version !== 1 || !Array.isArray(metadata.points)) continue;
          const points = metadata.points.flatMap((entry: unknown) => {
            if (!entry || typeof entry !== 'object') return [];
            const value = entry as Record<string, unknown>;
            const latitude = Number(value['latitude']), longitude = Number(value['longitude']);
            if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
              || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return [];
            return [{
              latitude, longitude, active: value['active'] !== false,
              ...(typeof value['name'] === 'string' && value['name'].trim() ? { name: value['name'].trim() } : {})
            }];
          });
          return points.length ? points : null;
        } catch { /* Try the legacy text comment below. */ }
      }
    }

    // Backward compatibility with the former human-readable comment format.
    for (const comment of comments) {
      if (!comment.includes('Routing points (complete list')) continue;
      const points: RouteWaypoint[] = [];
      const pattern = /^\s*\d+\. \[(ACTIVE|INACTIVE)\] (.*?) \| latitude=(-?\d+(?:\.\d+)?) \| longitude=(-?\d+(?:\.\d+)?)/gm;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(comment))) {
        const latitude = Number(match[3]), longitude = Number(match[4]);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
          || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) continue;
        const name = match[2] === '(no resolved location name)' ? '' : match[2].trim();
        points.push({ latitude, longitude, active: match[1] === 'ACTIVE', ...(name ? { name } : {}) });
      }
      if (points.length) return points;
    }
    return null;
  }

  protected readonly readRoutingWaypointsFromGpx = async (): Promise<void> => {
    const desktop = this.desktop;
    if (!desktop) { this.routeStatus.set('The desktop file system is unavailable.'); return; }
    const tracks = [...this.gpxTracks()].reverse().filter(track => !track.path.startsWith('memory:') && !track.missing);
    if (!tracks.length) { this.routeStatus.set('Load a GPX file first.'); return; }
    this.routeConfigBusy.set(true);
    try {
      for (const track of tracks) {
        const result = await desktop.FileSystem.readText(track.path);
        if (!result.success) continue;
        const points = this.parseRoutingWaypointsFromGpx(result.data);
        if (!points) continue;
        this.routeWaypoints.set(points);
        this.persistRouteWaypoints();
        this.updateRouteWaypointMarkers();
        this.routeStatus.set('Replaced routing points with ' + points.length + ' waypoint(s) from ' + track.name + '.');
        return;
      }
      this.routeStatus.set('No LumaScope routing waypoint comment was found in the loaded GPX files.');
    } catch (error) {
      this.routeStatus.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.routeConfigBusy.set(false);
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

  protected readonly fitMapToImages = (): void => {
    const points = this.directoryPhotoMarkers
      .filter(marker => Number.isFinite(marker.latitude) && Number.isFinite(marker.longitude)
        && marker.latitude >= -90 && marker.latitude <= 90
        && marker.longitude >= -180 && marker.longitude <= 180)
      .map(marker => [marker.latitude, marker.longitude] as [number, number]);
    if (!points.length) return;
    if (this.offlineRenderer) {
      const longitudes = points.map(point => point[1]), latitudes = points.map(point => point[0]);
      this.offlineRenderer.map.fitBounds(
        [[Math.min(...longitudes), Math.min(...latitudes)], [Math.max(...longitudes), Math.max(...latitudes)]],
        { padding: 32, maxZoom: points.length === 1 ? 15 : 16, duration: 0 }
      );
      this.zoomLevel.set(this.offlineRenderer.map.getZoom());
      this.saveSetting('zoom', this.offlineRenderer.map.getZoom());
    } else if (this.map) {
      const bounds: [[number, number], [number, number]] = [
        [Math.min(...points.map(point => point[0])), Math.min(...points.map(point => point[1]))],
        [Math.max(...points.map(point => point[0])), Math.max(...points.map(point => point[1]))]
      ];
      this.map.fitBounds(bounds, { padding: [32, 32], maxZoom: points.length === 1 ? 15 : 16, animate: false });
      this.zoomLevel.set(this.map.getZoom());
      this.saveSetting('zoom', this.map.getZoom());
    }
  };

  protected readonly hasActiveTrackPoints = (): boolean => this.gpxTracks().some(track => track.active !== false && (this.gpxSegmentsByTrack.get(track.path) ?? []).some(segment => segment.length > 0));

  protected readonly fitSelectedTracksToMap = (): void => {
    const points = this.gpxTracks()
      .filter(track => track.active !== false)
      .flatMap(track => (this.gpxSegmentsByTrack.get(track.path) ?? []).flat());
    this.fitMapToCoordinates(points, 24, 16);
  };

  protected readonly fitSelectedImagesToMap = (): void => {
    const points = this.directoryPhotoMarkers
      .filter(marker => Number.isFinite(marker.latitude) && Number.isFinite(marker.longitude)
        && marker.latitude >= -90 && marker.latitude <= 90
        && marker.longitude >= -180 && marker.longitude <= 180)
      .map(marker => [marker.latitude, marker.longitude] as [number, number]);
    this.fitMapToCoordinates(points, 32, 16);
  };

  private fitMapToCoordinates(points: [number, number][], padding: number, maxZoom: number): void {
    if (!points.length) return;
    const targetZoom = points.length === 1 ? Math.min(maxZoom, 15) : maxZoom;
    if (this.offlineRenderer) {
      const longitudes = points.map(point => point[1]), latitudes = points.map(point => point[0]);
      this.offlineRenderer.map.fitBounds(
        [[Math.min(...longitudes), Math.min(...latitudes)], [Math.max(...longitudes), Math.max(...latitudes)]],
        { padding, maxZoom: targetZoom, duration: 0 }
      );
      this.zoomLevel.set(this.offlineRenderer.map.getZoom());
      this.saveSetting('zoom', this.offlineRenderer.map.getZoom());
    } else if (this.map) {
      const bounds: [[number, number], [number, number]] = [
        [Math.min(...points.map(point => point[0])), Math.min(...points.map(point => point[1]))],
        [Math.max(...points.map(point => point[0])), Math.max(...points.map(point => point[1]))]
      ];
      this.map.fitBounds(bounds, { padding: [padding, padding], maxZoom: targetZoom, animate: false });
      this.zoomLevel.set(this.map.getZoom());
      this.saveSetting('zoom', this.map.getZoom());
    }
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
    this.applyMapOpacity();
    // Leaflet does not emit MapLibre's 'idle' event. Use the base layer's
    // completed visible-tile batch to finish the shared Display phase.
    this.tileLayer.on('load', () => {
      // Reapply the configured opacity after Leaflet has completed its initial
      // tile batch; the pane can be recreated during first-time layer setup.
      this.applyMapOpacity();
      window.dispatchEvent(new CustomEvent('lumascope-map-display-ready'));
    });
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
            let emitHillshadeStatus: ((status: 'loading' | 'loaded' | 'error' | 'cancelled', error?: string) => void) | null = null;
            try {
              const tileCount = 2 ** coords.z;
              const x = ((coords.x % tileCount) + tileCount) % tileCount;
              if (coords.y < 0 || coords.y >= tileCount) {
                done(null, canvas);
                return;
              }
              const hillshadeKey = 'online/' + coords.z + '/' + x + '/' + coords.y;
              const cacheKey = createHillshadeTileCacheKey(databases, coords.z, x, coords.y);
              emitHillshadeStatus = (status, error): void => {
                window.dispatchEvent(new CustomEvent('lumascope-hillshade-tile-status', {
                  detail: { key: hillshadeKey, status, error, zoom: coords.z, column: x, row: coords.y }
                }));
              };
              emitHillshadeStatus('loading');
              const cachedPng = getCachedHillshadeTile(cacheKey);
              if (cachedPng) {
                const bitmap = await createImageBitmap(new Blob([cachedPng.slice().buffer as ArrayBuffer], { type: 'image/png' }));
                try {
                  context.drawImage(bitmap, 0, 0);
                } finally {
                  bitmap.close();
                }
                emitHillshadeStatus('loaded');
                done(null, canvas);
                return;
              }
              let hasImage = false;
              for (const database of databases) {
                let png: Uint8Array;
                try {
                  png = await runOfflineRenderTask(() => desktop.OsmAndAtlas.renderHillshadeTile(database.path, coords.z, x, coords.y, 0), 'Hillshade', `${database.path.split(/[\\\\/]/).pop() ?? database.id} · z${coords.z}/${x}/${coords.y}`);
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
              const cachedBlob = await new Promise<Blob>((resolve, reject) =>
                canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Unable to encode Hillshade cache tile.')), 'image/png'));
              cacheHillshadeTile(cacheKey, new Uint8Array(await cachedBlob.arrayBuffer()));
              emitHillshadeStatus('loaded');
              done(null, canvas);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              const cancelled = /\b(cancelled|canceled|aborted)\b/i.test(message);
              emitHillshadeStatus?.(cancelled ? 'cancelled' : 'error', message);
              if (!cancelled) {
                this.recordMapError('Online Hillshade tile', message + ' [z=' + coords.z + ', x=' + coords.x + ', y=' + coords.y + ']');
              }
              done(cancelled ? null : error instanceof Error ? error : new Error(message), canvas);
            }
          })();
          return canvas;
        }
      });
      this.leafletHillshadeLayer = new HillshadeGridLayer({
        pane: 'hillshadePane', tileSize: 256, minZoom: 1, maxZoom: 20, maxNativeZoom: 12,
        opacity: this.hillshadeOpacity() / 100, zIndex: 250
      }).addTo(map);
      // Wait for the Hillshade GridLayer's complete visible tile batch too;
      // the base map can finish before the asynchronous native shading calls.
      this.leafletHillshadeLayer.on('load', () => {
        window.dispatchEvent(new CustomEvent('lumascope-map-display-ready'));
      });
    } else {
      this.leafletHillshadeLayer.setOpacity(this.hillshadeOpacity() / 100);
    }
  }

  private applyMapOpacity(): void {
    const opacity = this.mapVisible() ? this.mapOpacity() / 100 : 0;
    this.offlineRenderer?.setBasemapOpacity(opacity);
    this.tileLayer?.setOpacity(opacity);

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

  private gpxSpeedColor(speedKmh: number, track: GpxTrackFile): string {
    const minimum = Math.max(0, track.speedMinKmh ?? 0);
    const maximum = Math.max(minimum + 1, track.speedMaxKmh ?? 120);
    const rawT = Math.max(0, Math.min(1, (speedKmh - minimum) / (maximum - minimum)));
    const t = Math.round(rawT * 23) / 23;
    const customStops = track.speedPalette === 'custom-2'
      ? [[0, track.customColor1 || '#2878ff'], [1, track.customColor3 || '#f04444']] as Array<[number, string]>
      : track.speedPalette === 'custom-3'
        ? [[0, track.customColor1 || '#2878ff'], [0.5, track.customColor2 || '#18c99a'], [1, track.customColor3 || '#f04444']] as Array<[number, string]>
        : null;
    const parseHex = (value: string): [number, number, number] => {
      const hex = value.replace('#', '');
      return [0, 2, 4].map(index => Number.parseInt(hex.slice(index, index + 2), 16)) as [number, number, number];
    };
    const stops: Array<[number, number, number, number]> = customStops
      ? customStops.map(([position, color]) => [position, ...parseHex(color)])
      : ({
          'cool-warm': [[0, 37, 115, 190], [0.5, 70, 190, 170], [1, 220, 70, 55]],
          viridis: [[0, 68, 1, 84], [0.25, 59, 82, 139], [0.5, 33, 145, 140], [0.75, 94, 201, 98], [1, 253, 231, 37]],
          plasma: [[0, 13, 8, 135], [0.25, 126, 3, 168], [0.5, 204, 71, 120], [0.75, 248, 149, 64], [1, 240, 249, 33]],
          inferno: [[0, 0, 0, 4], [0.25, 87, 16, 110], [0.5, 188, 55, 84], [0.75, 249, 142, 9], [1, 252, 255, 164]],
          terrain: [[0, 24, 58, 143], [0.25, 39, 169, 194], [0.5, 76, 175, 80], [0.75, 216, 198, 106], [1, 140, 75, 45]],
          spectrum: [[0, 40, 90, 220], [0.25, 0, 190, 220], [0.5, 40, 190, 90], [0.75, 255, 210, 0], [1, 235, 45, 35]]
        } as Record<string, Array<[number, number, number, number]>>)[track.speedPalette ?? 'spectrum'] ?? [[0, 40, 90, 220], [0.25, 0, 190, 220], [0.5, 40, 190, 90], [0.75, 255, 210, 0], [1, 235, 45, 35]];
    let lower = stops[0]!, upper = stops[stops.length - 1]!;
    for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) { lower = stops[i - 1]; upper = stops[i]; break; }
    const fraction = (t - lower[0]) / Math.max(0.0001, upper[0] - lower[0]);
    const rgb = [1, 2, 3].map(index => Math.round(lower[index] + (upper[index] - lower[index]) * fraction));
    return '#' + rgb.map(value => value.toString(16).padStart(2, '0')).join('');
  }

  private gpxSpeedSegments(track: GpxTrackFile): Array<{ coordinates: [number, number][]; color: string }> {
    const pointSegments = this.gpxPointDataByTrack.get(track.path) ?? [];
    const cacheKey = ['speed', track.speedPalette ?? 'spectrum', track.speedMinKmh ?? 0, track.speedMaxKmh ?? 120, this.timeSliderActive(), this.timeSliderStart(), this.timeSliderEnd()].join('|');
    const cached = this.gpxSpeedSegmentsCache.get(track.path);
    if (cached?.points === pointSegments && cached.key === cacheKey) return cached.segments;
    const result: Array<{ coordinates: [number, number][]; color: string }> = [];
    const radians = Math.PI / 180;
    const earthRadius = 6371000;
    for (const points of pointSegments) {
      let current: { coordinates: [number, number][]; color: string } | null = null;
      const flush = (): void => { if (current && current.coordinates.length >= 2) result.push(current); current = null; };
      const appendPair = (a: GpxTrackPoint, b: GpxTrackPoint, color: string): void => {
        const previous = current?.coordinates[current.coordinates.length - 1];
        if (current && current.color === color && previous?.[0] === a.latitude && previous?.[1] === a.longitude) {
          current.coordinates.push([b.latitude, b.longitude]);
        } else {
          flush();
          current = { coordinates: [[a.latitude, a.longitude], [b.latitude, b.longitude]], color };
        }
      };
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        if (a.inViewport === false || b.inViewport === false) { flush(); continue; }
        const timeA = a.timestamp ? Date.parse(a.timestamp) : Number.NaN;
        const timeB = b.timestamp ? Date.parse(b.timestamp) : Number.NaN;
        const elapsedMs = timeB - timeA;
        if (!Number.isFinite(timeA) || !Number.isFinite(timeB)) {
          appendPair(a, b, '#8a8a8a');
          continue;
        }
        if (elapsedMs <= 0 || elapsedMs > 30 * 60 * 1000) {
          if (!this.timeSliderActive() || (this.isTimeSliderTimestampVisible(timeA / 1000) && this.isTimeSliderTimestampVisible(timeB / 1000))) appendPair(a, b, '#8a8a8a');
          else flush();
          continue;
        }
        if (this.timeSliderActive() && (!this.isTimeSliderTimestampVisible(timeA / 1000) || !this.isTimeSliderTimestampVisible(timeB / 1000))) { flush(); continue; }
        const lat1 = a.latitude * radians, lat2 = b.latitude * radians;
        const dLat = lat2 - lat1, dLon = (b.longitude - a.longitude) * radians;
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
        const distance = 2 * earthRadius * Math.asin(Math.min(1, Math.sqrt(h)));
        if (!Number.isFinite(distance) || distance < 0.5) { flush(); continue; }
        const speedKmh = distance / (elapsedMs / 1000) * 3.6;
        if (!Number.isFinite(speedKmh) || speedKmh > 300) { flush(); continue; }
        appendPair(a, b, this.gpxSpeedColor(speedKmh, track));
      }
      flush();
    }
    this.gpxSpeedSegmentsCache.set(track.path, { points: pointSegments, key: cacheKey, segments: result });
    return result;
  }

  private gpxElevationSegments(track: GpxTrackFile): Array<{ coordinates: [number, number][]; color: string }> {
    const pointSegments = this.gpxPointDataByTrack.get(track.path) ?? [];
    const minimum = track.elevationMinM ?? 0;
    const maximum = Math.max(minimum + 1, track.elevationMaxM ?? 3000);
    const cacheKey = ['elevation', track.speedPalette ?? 'spectrum', minimum, maximum, this.timeSliderActive(), this.timeSliderStart(), this.timeSliderEnd()].join('|');
    const cached = this.gpxSpeedSegmentsCache.get(track.path);
    if (cached?.points === pointSegments && cached.key === cacheKey) return cached.segments;
    const result: Array<{ coordinates: [number, number][]; color: string }> = [];
    for (const points of pointSegments) {
      let current: { coordinates: [number, number][]; color: string } | null = null;
      const flush = (): void => { if (current && current.coordinates.length >= 2) result.push(current); current = null; };
      const appendPair = (a: GpxTrackPoint, b: GpxTrackPoint, color: string): void => {
        const previous = current?.coordinates[current.coordinates.length - 1];
        if (current && current.color === color && previous?.[0] === a.latitude && previous?.[1] === a.longitude) current.coordinates.push([b.latitude, b.longitude]);
        else { flush(); current = { coordinates: [[a.latitude, a.longitude], [b.latitude, b.longitude]], color }; }
      };
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        if (a.inViewport === false || b.inViewport === false) { flush(); continue; }
        if (this.timeSliderActive()) {
          const timeA = a.timestamp ? Date.parse(a.timestamp) / 1000 : Number.NaN;
          const timeB = b.timestamp ? Date.parse(b.timestamp) / 1000 : Number.NaN;
          if ((Number.isFinite(timeA) && !this.isTimeSliderTimestampVisible(timeA)) || (Number.isFinite(timeB) && !this.isTimeSliderTimestampVisible(timeB))) { flush(); continue; }
        }
        if (a.elevation === null || b.elevation === null || !Number.isFinite(a.elevation) || !Number.isFinite(b.elevation)) {
          appendPair(a, b, '#8a8a8a');
          continue;
        }
        const elevation = (a.elevation + b.elevation) / 2;
        appendPair(a, b, this.gpxSpeedColor(elevation, { ...track, speedMinKmh: minimum, speedMaxKmh: maximum }));
      }
      flush();
    }
    this.gpxSpeedSegmentsCache.set(track.path, { points: pointSegments, key: cacheKey, segments: result });
    return result;
  }

  private applyGpxTrack(): void {
    const renderTracks = this.gpxListMode() === 'database' ? this.gpxDatabaseTracks() : this.gpxTracks();
    const activeTracks = this.gpxVisible() ? renderTracks.filter(track => track.active !== false) : [];
    if (this.offlineRenderer) {
      this.offlineRenderer.setTrack(activeTracks.map(track => {
        const speedSegments = track.colorMode === 'speed' ? this.gpxSpeedSegments(track) : track.colorMode === 'elevation' ? this.gpxElevationSegments(track) : [];
        const normalSegments = this.visibleGpxSegments(track);
        const segments = track.colorMode === 'speed' || track.colorMode === 'elevation' ? speedSegments.map(item => item.coordinates) : normalSegments;
        const segmentColors = track.colorMode === 'speed' || track.colorMode === 'elevation' ? speedSegments.map(item => item.color) : undefined;
        return { path: track.path, segments, segmentColors, color: track.color || this.gpxColor(), lineStyle: track.lineStyle || 'solid', lineWidth: track.lineWidth || 4, showDirection: track.showDirection === true, directionStyle: track.directionStyle || 'classic', trackShadowStrength: track.trackShadowStrength ?? 0, arrowShadowStrength: track.arrowShadowStrength ?? 0, trackOutlineStrength: track.trackOutlineStrength ?? 0 };
      }), .92 * this.gpxOpacity() / 100);
      this.offlineRenderer.setTrackHoverHandler((path, latitude, longitude) => this.updateGpxHover(path, latitude, longitude));
      return;
    }
    for (const layer of this.trackLayers) layer.remove();
    this.trackLayers = [];
    if (!this.map || !this.leaflet || !this.gpxVisible()) return;
    for (const track of activeTracks) {
      const speedSegments = track.colorMode === 'speed' ? this.gpxSpeedSegments(track) : track.colorMode === 'elevation' ? this.gpxElevationSegments(track) : [];
      const normalSegments = this.visibleGpxSegments(track);
      const segments = track.colorMode === 'speed' || track.colorMode === 'elevation' ? speedSegments.map(item => item.coordinates) : normalSegments;
      for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
        const segment = segments[segmentIndex];
        if (segment.length < 2) continue;
        const color = track.colorMode === 'speed' || track.colorMode === 'elevation' ? speedSegments[segmentIndex].color : (track.color || this.gpxColor());
        const lineStyle = track.lineStyle || 'solid';
        const outlineStrength = Math.max(0, Math.min(100, track.trackOutlineStrength ?? 0));
        if (outlineStrength > 0) {
          const outlineLine = this.leaflet.polyline(segment, { color: '#080808', weight: (track.lineWidth || 4) + 2, opacity: .92 * this.gpxOpacity() / 100 * outlineStrength / 100, lineCap: 'round', lineJoin: 'round', dashArray: this.gpxLineDashArray(lineStyle) }).addTo(this.map);
          this.trackLayers.push(outlineLine);
        }
        const trackLine = this.leaflet.polyline(segment, {
          color, weight: track.lineWidth || 4, opacity: .92 * this.gpxOpacity() / 100,
          lineCap: 'round', lineJoin: 'round', dashArray: this.gpxLineDashArray(lineStyle)
        }).addTo(this.map);
        if (track.trackShadowStrength && track.trackShadowStrength > 0) {
          const element = (trackLine as unknown as { getElement?: () => SVGElement | null }).getElement?.();
          if (element) element.style.filter = 'drop-shadow(0 0 2px rgba(0,0,0,' + Math.max(0, Math.min(100, track.trackShadowStrength)) / 100 + '))';
        }
        const hoverLine = this.leaflet.polyline(segment, {
          color, weight: Math.max(14, (track.lineWidth || 4) + 10), opacity: .01,
          lineCap: 'round', lineJoin: 'round'
        }).addTo(this.map);
        hoverLine.on('mousemove', event => this.updateGpxHover(track.path, event.latlng.lat, event.latlng.lng));
        hoverLine.on('mouseout', () => this.clearGpxHover(track.path));
        this.trackLayers.push(trackLine, hoverLine);
      }
      for (const segment of normalSegments) {
        if (!track.showDirection || segment.length < 2) continue;
        const arrowSize = this.gpxDirectionArrowSize(track.directionArrowSizePx, track.directionStyle);
        for (const arrow of this.gpxDirectionArrows(segment, track.directionIntervalPx ?? 120)) {
          const icon = this.leaflet.divIcon({
            className: 'gpx-direction-arrow-icon',
            html: '<span class="gpx-direction-arrow" style="font-size:' + arrowSize + 'px;color:' + (track.color || this.gpxColor()) + ';opacity:' + (.92 * this.gpxOpacity() / 100) + ';-webkit-text-stroke-width:' + Math.max(0, Math.min(6, track.directionArrowOutlineWidthPx ?? 2)) + 'px;text-shadow:0 0 2px rgba(0,0,0,' + Math.max(0, Math.min(100, track.arrowShadowStrength ?? 0)) / 100 + ');transform:rotate(' + (arrow.bearing - 90) + 'deg)">' + this.gpxDirectionGlyph(track.directionStyle) + '</span>',
            iconSize: [arrowSize + 4, arrowSize + 4], iconAnchor: [(arrowSize + 4) / 2, (arrowSize + 4) / 2]
          });
          this.trackLayers.push(this.leaflet.marker(arrow.position, { icon }).addTo(this.map) as MapMarker & { remove(): void });
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
