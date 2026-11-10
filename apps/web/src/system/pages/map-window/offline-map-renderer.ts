import { addProtocol, Map as MapLibreMap, ScaleControl, setWorkerUrl, type MapOptions, type StyleSpecification, type MapLayerMouseEvent } from 'maplibre-gl';
import type { Desktop, OsmAndHillshadeDatabase } from 'internal-api';
import 'maplibre-gl/dist/maplibre-gl.css';

// Angular copies the worker and its shared module to the renderer root.
// Resolve against the page URL so this also works in the packaged file:// app.
setWorkerUrl(new URL('maplibre-gl-worker.mjs', document.baseURI).toString());

const AUSTRIA_BOUNDS: [number, number, number, number] = [9.52678, 46.36979, 17.16408, 49.02403];

export type OfflineMapStyle = 'lumascope' | 'versatiles-colorful' | 'versatiles-neutrino';

let osmAndProtocolRegistered = false;
let osmAndAtlasProtocolRegistered = false;
let osmAndAtlasDisplayScaleProvider: (() => number) | null = null;
let osmAndHillshadeDatabasesProvider: (() => OsmAndHillshadeDatabase[]) | null = null;
let osmAndHillshadeProtocolRegistered = false;

const EMPTY_HILLSHADE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAQAAAD2e2DtAAAAlUlEQVR42u3BAQ0AAADCoPdP7ewBFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3AR4AAY/4QuAAAAAASUVORK5CYII=';
const EMPTY_HILLSHADE_PNG = Uint8Array.from(atob(EMPTY_HILLSHADE_PNG_BASE64), character => character.charCodeAt(0));

type OsmAndTileProtocol = 'osmand' | 'osmand-atlas' | 'maplibre';
type OsmAndTileStatus = 'loading' | 'cache-loading' | 'rerendering' | 'loaded' | 'warning' | 'error' | 'cancelled' | 'diagnostic';
interface OsmAndTileStatusEventDetail {
  protocol: OsmAndTileProtocol;
  sourceId?: string;
  zoom: number;
  column: number;
  row: number;
  status: OsmAndTileStatus;
  error?: string;
}

function isUniformBlankTile(pixels: ArrayLike<number>): boolean {
  if (pixels.length < 4 || pixels.length % 4 !== 0) return false;
  const red = pixels[0], green = pixels[1], blue = pixels[2], alpha = pixels[3];
  if (alpha !== 255) return false;
  // A truly empty OsmAnd tile is a flat opaque renderer background. Requiring
  // every pixel to match avoids flagging ordinary low-detail coast/ocean tiles.
  for (let offset = 4; offset < pixels.length; offset += 4) {
    if (pixels[offset] !== red || pixels[offset + 1] !== green
      || pixels[offset + 2] !== blue || pixels[offset + 3] !== alpha) return false;
  }
  return true;
}

function emitOsmAndTileStatus(detail: OsmAndTileStatusEventDetail): void {
  window.dispatchEvent(new CustomEvent<OsmAndTileStatusEventDetail>('lumascope-osmand-tile-status', { detail }));
}

/**
 * MapLibre requests OsmAnd tiles as decoded images. The IPC boundary carries
 * the native RGBA8 bytes; ImageBitmap hands those pixels to MapLibre's normal
 * raster/WebGL upload path without encoding or decoding PNG data.
 */
export function registerOsmAndTileProtocol(desktop: Desktop): void {
  if (osmAndProtocolRegistered) return;
  addProtocol('osmand', async (request, abortController) => {
    const match = /^osmand:\/\/(\d+)\/(\d+)\/(\d+)(?:\?refresh=\d+)?$/.exec(request.url);
    if (!match) throw new Error('Invalid OsmAnd XYZ tile URL: ' + request.url);
    const [, zoomText, columnText, rowText] = match;
    const zoom = Number(zoomText);
    const column = Number(columnText);
    const row = Number(rowText);
    const tileCoordinates = { protocol: 'osmand' as const, zoom, column, row };
    emitOsmAndTileStatus({ ...tileCoordinates, status: 'loading' });
    try {
      // A displayed 512px MapLibre tile is assembled from four native 256px
      // OsmAnd tiles at the next zoom level, preserving the intended detail.
      const nativeZoom = zoom + 1;
      const nativeColumn = column * 2;
      const nativeRow = row * 2;
      const coordinates = [
        [nativeColumn, nativeRow], [nativeColumn + 1, nativeRow],
        [nativeColumn, nativeRow + 1], [nativeColumn + 1, nativeRow + 1]
      ] as const;
      const tiles = await Promise.all(coordinates.map(([x, y]) => desktop.OsmAnd.renderTile(nativeZoom, x, y)));
      if (abortController.signal.aborted) throw new Error('OsmAnd tile request was cancelled.');
      // A displayed 512px tile is a cache hit only when all four native
      // 256px tiles came from disk; mixed cache/render tiles remain "Rendering".
      if (tiles.every(tile => tile.cacheHit)) {
        emitOsmAndTileStatus({ ...tileCoordinates, status: 'cache-loading' });
      }
      const pixels = new Uint8ClampedArray(512 * 512 * 4);
      for (let index = 0; index < tiles.length; index++) {
        const tile = tiles[index];
        if (tile.width !== 256 || tile.height !== 256 || tile.stride !== 1024 || tile.pixels.byteLength !== 256 * 256 * 4) {
          throw new Error('OsmAnd returned an invalid RGBA8 tile.');
        }
        const source = new Uint8Array(tile.pixels);
        const offsetX = (index % 2) * 256;
        const offsetY = Math.floor(index / 2) * 256;
        for (let y = 0; y < 256; y++) {
          const sourceOffset = y * 1024;
          const targetOffset = ((offsetY + y) * 512 + offsetX) * 4;
          pixels.set(source.subarray(sourceOffset, sourceOffset + 1024), targetOffset);
        }
      }
      const bitmap = await createImageBitmap(new ImageData(pixels, 512, 512));
      if (abortController.signal.aborted) {
        bitmap.close();
        throw new Error('OsmAnd tile request was cancelled.');
      }
      emitOsmAndTileStatus({ ...tileCoordinates,
        status: zoom < 8 && isUniformBlankTile(pixels) ? 'warning' : 'loaded',
        ...(zoom < 8 && isUniformBlankTile(pixels) ? { error: 'World_basemap.obf needed' } : {})
      });
      return { data: bitmap };
    } catch (error) {
      emitOsmAndTileStatus({ ...tileCoordinates, status: abortController.signal.aborted ? 'cancelled' : 'error', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });
  osmAndProtocolRegistered = true;
}


/**
 * Atlas renders a viewport-sized frame rather than an XYZ tile. LumaScope
 * requests a 512px frame centered on each XYZ tile's geographic midpoint.
 */
export function registerOsmAndAtlasTileProtocol(desktop: Desktop, getDisplayScale: () => number): void {
  // The protocol is global, but the map window component can be recreated.
  // Always refresh the provider before the one-time protocol registration so
  // requests never keep reading a destroyed component's stale density value.
  osmAndAtlasDisplayScaleProvider = getDisplayScale;
  if (osmAndAtlasProtocolRegistered) return;
  addProtocol('osmand-atlas', async (request, abortController) => {
    const match = /^osmand-atlas:\/\/(\d+)\/(\d+)\/(\d+)(?:\?refresh=\d+)?$/.exec(request.url);
    if (!match) throw new Error('Invalid OsmAnd Atlas XYZ tile URL: ' + request.url);
    const [, zoomText, columnText, rowText] = match;
    const zoom = Number(zoomText);
    const requestedColumn = Number(columnText);
    const row = Number(rowText);
    if (!Number.isInteger(zoom) || zoom < 2 || zoom > 21
      || !Number.isInteger(requestedColumn) || !Number.isInteger(row)) {
      throw new Error('Invalid OsmAnd Atlas tile coordinates.');
    }
    const tileCount = 2 ** zoom;
    // MapLibre can request wrapped world copies with x outside [0, 2^z).
    // XYZ columns wrap horizontally; they are not invalid tile coordinates.
    const column = ((requestedColumn % tileCount) + tileCount) % tileCount;
    const tileCoordinates = { protocol: 'osmand-atlas' as const, zoom, column, row };
    if (row < 0 || row >= tileCount) {
      const empty = new Uint8ClampedArray(512 * 512 * 4);
      return { data: await createImageBitmap(new ImageData(empty, 512, 512)) };
    }
    emitOsmAndTileStatus({ ...tileCoordinates, status: 'loading' });
    try {
      const displayScale = osmAndAtlasDisplayScaleProvider?.() ?? window.devicePixelRatio ?? 1;
      // One MapLibre 512px tile represents a 2x2 group of 256px Atlas XYZ tiles.
      // Shift to the next Atlas zoom and address the NW tile of that 2x2 group.
      let tile: Awaited<ReturnType<Desktop['OsmAndAtlas']['renderTile']>>;
      try {
        tile = await desktop.OsmAndAtlas.renderTile(zoom + 1, column * 2, row * 2, displayScale);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (abortController.signal.aborted || /\\b(cancelled|canceled)\\b/i.test(message)) {
          emitOsmAndTileStatus({ ...tileCoordinates, status: 'cancelled', error: message });
          return { data: await createImageBitmap(new ImageData(new Uint8ClampedArray(512 * 512 * 4), 512, 512)) };
        }
        throw error;
      }
      if (abortController.signal.aborted) {
        emitOsmAndTileStatus({ ...tileCoordinates, status: 'cancelled', error: 'Atlas tile request aborted after rendering.' });
        return { data: await createImageBitmap(new ImageData(new Uint8ClampedArray(512 * 512 * 4), 512, 512)) };
      }
      // Only explicit helper warnings/errors belong in the Error tab.
      // Geometry traces and ordinary helper lifecycle messages are diagnostics,
      // not application errors; keep them in the console only.
      for (const diagnostic of tile.diagnostics?.geometryMessages ?? []) {
        if (!/^(ERROR|WARNING):/i.test(diagnostic.trim())) continue;
        emitOsmAndTileStatus({ ...tileCoordinates, status: 'diagnostic', error: diagnostic });
      }
      if (tile.cacheHit) emitOsmAndTileStatus({ ...tileCoordinates, status: 'cache-loading' });
      // Atlas returns one 512px frame at the same geographic extent as this
      // MapLibre tile, avoiding the previous 2x supersampled framebuffer.
      if (tile.width !== 512
        || tile.height !== tile.width
        || tile.stride !== tile.width * 4
        || tile.pixels.byteLength !== tile.width * tile.height * 4) {
        throw new Error('OsmAnd Atlas returned an invalid RGBA8 frame.');
      }
      const pixels = new Uint8ClampedArray(tile.pixels.byteLength);
      pixels.set(tile.pixels);
      const bitmap = await createImageBitmap(new ImageData(pixels, tile.width, tile.height));
      if (abortController.signal.aborted) {
        bitmap.close();
        throw new Error('OsmAnd Atlas tile request was cancelled.');
      }
      emitOsmAndTileStatus({ ...tileCoordinates,
        status: zoom < 8 && isUniformBlankTile(pixels) ? 'warning' : 'loaded',
        ...(zoom < 8 && isUniformBlankTile(pixels) ? { error: 'World_basemap.obf needed' } : {})
      });
      return { data: bitmap };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = abortController.signal.aborted || /\b(cancelled|canceled)\b/i.test(message);
      emitOsmAndTileStatus({ ...tileCoordinates, status: cancelled ? 'cancelled' : 'error', error: message });
      throw error;
    }
  });
  osmAndAtlasProtocolRegistered = true;
}


interface HillshadePngDiagnostics {
  byteLength: number;
  width: number | null;
  height: number | null;
  bitDepth: number | null;
  colorType: number | null;
  compression: number | null;
  filter: number | null;
  interlace: number | null;
  idatBytes: number;
  hasIend: boolean;
}

function inspectHillshadePng(png: Uint8Array): HillshadePngDiagnostics {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const signatureValid = png.byteLength >= 8
    && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47
    && png[4] === 0x0d && png[5] === 0x0a && png[6] === 0x1a && png[7] === 0x0a;
  const result: HillshadePngDiagnostics = {
    byteLength: png.byteLength, width: null, height: null, bitDepth: null,
    colorType: null, compression: null, filter: null, interlace: null,
    idatBytes: 0, hasIend: false
  };
  if (!signatureValid) return result;

  let offset = 8;
  while (offset + 12 <= png.byteLength) {
    const length = view.getUint32(offset, false);
    const typeOffset = offset + 4;
    const dataOffset = offset + 8;
    const chunkEnd = dataOffset + length + 4;
    if (chunkEnd > png.byteLength) break;
    const type = String.fromCharCode(png[typeOffset], png[typeOffset + 1], png[typeOffset + 2], png[typeOffset + 3]);
    if (type === 'IHDR' && length === 13) {
      result.width = view.getUint32(dataOffset, false);
      result.height = view.getUint32(dataOffset + 4, false);
      result.bitDepth = png[dataOffset + 8];
      result.colorType = png[dataOffset + 9];
      result.compression = png[dataOffset + 10];
      result.filter = png[dataOffset + 11];
      result.interlace = png[dataOffset + 12];
    } else if (type === 'IDAT') {
      result.idatBytes += length;
    } else if (type === 'IEND') {
      result.hasIend = length === 0;
      break;
    }
    offset = chunkEnd;
  }
  return result;
}

async function validateHillshadePngForBrowser(png: Uint8Array, tile: string): Promise<void> {
  const diagnostics = inspectHillshadePng(png);
  const details = JSON.stringify(diagnostics);
  if (diagnostics.width === null || diagnostics.height === null || !diagnostics.hasIend
    || diagnostics.idatBytes === 0 || diagnostics.width <= 0 || diagnostics.height <= 0) {
    throw new Error('Hillshade helper returned an incomplete or invalid PNG (' + tile + '; ' + details + ').');
  }
  try {
    // Decode with Chromium before handing the original encoded bytes to MapLibre.
    // This isolates malformed PNG payloads from MapLibre source/tile handling.
    const pngBuffer = new ArrayBuffer(png.byteLength);
    new Uint8Array(pngBuffer).set(png);
    const bitmap = await createImageBitmap(new Blob([pngBuffer], { type: 'image/png' }));
    try {
      if (bitmap.width !== diagnostics.width || bitmap.height !== diagnostics.height) {
        throw new Error('Decoded dimensions do not match the PNG IHDR.');
      }
    } finally {
      bitmap.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error('Hillshade PNG could not be decoded by Chromium (' + tile + '; ' + details + '; decode=' + message + ').');
  }
}

/** Hillshade databases are merged into one raster tile. Overlapping pixels are taken
 * from the first database that covers them, so raster opacity is applied only once. */
export function registerOsmAndHillshadeTileProtocol(desktop: Desktop, getDatabases: () => OsmAndHillshadeDatabase[]): void {
  osmAndHillshadeDatabasesProvider = getDatabases;
  if (osmAndHillshadeProtocolRegistered) return;
  addProtocol('osmand-hillshade', async (request, abortController) => {
    const match = /^osmand-hillshade:\/\/combined\/(\d+)\/(\d+)\/(\d+)(?:\?refresh=\d+)?$/.exec(request.url);
    if (!match) throw new Error('Invalid combined OsmAnd Hillshade XYZ tile URL: ' + request.url);
    const [, zoomText, columnText, rowText] = match;
    const zoom = Number(zoomText), requestedColumn = Number(columnText), row = Number(rowText);
    if (!Number.isInteger(zoom) || zoom < 0 || zoom > 24
      || !Number.isInteger(requestedColumn) || !Number.isInteger(row)) {
      throw new Error('Invalid OsmAnd Hillshade tile coordinates.');
    }
    const tileCount = 2 ** zoom;
    const column = ((requestedColumn % tileCount) + tileCount) % tileCount;
    if (row < 0 || row >= tileCount) {
      return { data: EMPTY_HILLSHADE_PNG.slice().buffer as ArrayBuffer };
    }

    const databases = (osmAndHillshadeDatabasesProvider?.() ?? [])
      .filter(database => database.enabled && database.available);
    if (!databases.length) {
      return { data: EMPTY_HILLSHADE_PNG.slice().buffer as ArrayBuffer };
    }

    const canvas = new OffscreenCanvas(256, 256);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Unable to create the Hillshade tile composition canvas.');
    const merged = new Uint8ClampedArray(256 * 256 * 4);
    const tile = 'z' + zoom + '/x' + column + '/y' + row;
    let hasPixels = false;

    for (const database of databases) {
      if (abortController.signal.aborted) throw new Error('OsmAnd Hillshade tile request was cancelled.');
      let png: Uint8Array;
      try {
        png = await desktop.OsmAndAtlas.renderHillshadeTile(database.path, zoom, column, row, 0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/Hillshade tile not found/i.test(message)) continue;
        throw error;
      }

      await validateHillshadePngForBrowser(png, tile + '; database=' + database.id);
      const pngBuffer = new ArrayBuffer(png.byteLength);
      new Uint8Array(pngBuffer).set(png);
      const bitmap = await createImageBitmap(new Blob([pngBuffer], { type: 'image/png' }));
      try {
        if (bitmap.width !== 256 || bitmap.height !== 256) {
          throw new Error('Hillshade tile has unexpected dimensions (' + bitmap.width + 'x' + bitmap.height + ').');
        }
        context.clearRect(0, 0, 256, 256);
        context.drawImage(bitmap, 0, 0);
        const pixels = context.getImageData(0, 0, 256, 256).data;
        for (let offset = 0; offset < pixels.length; offset += 4) {
          // Preserve the first database's pixel where coverage overlaps. Copy
          // later databases only into transparent areas of earlier tiles.
          if (pixels[offset + 3] === 0 || merged[offset + 3] !== 0) continue;
          merged[offset] = pixels[offset];
          merged[offset + 1] = pixels[offset + 1];
          merged[offset + 2] = pixels[offset + 2];
          merged[offset + 3] = pixels[offset + 3];
          hasPixels = true;
        }
      } finally {
        bitmap.close();
      }
    }

    if (abortController.signal.aborted) throw new Error('OsmAnd Hillshade tile request was cancelled.');
    if (!hasPixels) {
      return { data: EMPTY_HILLSHADE_PNG.slice().buffer as ArrayBuffer };
    }

    context.putImageData(new ImageData(merged, 256, 256), 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return { data: await blob.arrayBuffer() };
  });
  osmAndHillshadeProtocolRegistered = true;
}

export function createOsmAndAtlasMapStyle(): StyleSpecification {
  return {
    version: 8,
    name: 'LumaScope OsmAnd Atlas',
    sources: {
      'osmand-atlas': {
        type: 'raster',
        tiles: ['osmand-atlas://{z}/{x}/{y}'],
        tileSize: 512,
        minzoom: 2,
        maxzoom: 21,
        attribution: '© OpenStreetMap contributors'
      }
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#d9e1e5' } },
      { id: 'osmand-atlas-raster', type: 'raster', source: 'osmand-atlas', paint: { 'raster-fade-duration': 0 } }
    ]
  };
}

function withOsmAndHillshadeOverlay(style: StyleSpecification): StyleSpecification {
  // Hillshade sources are installed dynamically from the persisted database list.
  return JSON.parse(JSON.stringify(style)) as StyleSpecification;
}

export function createOsmAndMapStyle(): StyleSpecification {
  return {
    version: 8,
    name: 'LumaScope OsmAnd OBF',
    sources: {
      osmand: {
        type: 'raster',
        tiles: ['osmand://{z}/{x}/{y}'],
        tileSize: 512,
        minzoom: 2,
        maxzoom: 19,
        attribution: '© OpenStreetMap contributors'
      }
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#d9e1e5' } },
      { id: 'osmand-raster', type: 'raster', source: 'osmand', paint: { 'raster-fade-duration': 0 } }
    ]
  };
}


export function buildPhotoMarkerPreviewHtml(path: string, fileName: string): string {
  const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character] ?? character);
  const previewUrl = 'atom://app/thumbs?image=' + encodeURIComponent(path) + '&width=180&height=120';
  return '<div class="folder-marker-preview"><img src="' + previewUrl + '" alt="" loading="lazy"><span>'
    + escapeHtml(fileName) + '</span></div>';
}

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
    { id: 'background', type: 'background', paint: { 'background-color': '#f5f2ea' } },
    { id: 'land', type: 'fill', source: 'shortbread', 'source-layer': 'land', paint: { 'fill-color': ['match', ['get', 'kind'], 'forest', '#c8d9b8', 'grass', '#dce5c8', 'meadow', '#e2e8c9', 'orchard', '#d5e1b8', 'vineyard', '#d9dfb1', '#e6e1d5'], 'fill-opacity': 0.95 } },
    { id: 'ocean', type: 'fill', source: 'shortbread', 'source-layer': 'ocean', paint: { 'fill-color': '#a9d5e5' } },
    { id: 'water-polygons', type: 'fill', source: 'shortbread', 'source-layer': 'water_polygons', paint: { 'fill-color': '#a9d5e5' } },
    { id: 'water-lines', type: 'line', source: 'shortbread', 'source-layer': 'water_lines', paint: { 'line-color': '#a9d5e5', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 14, 2] } },
    { id: 'boundaries', type: 'line', source: 'shortbread', 'source-layer': 'boundaries', paint: { 'line-color': '#a58aa2', 'line-width': 1, 'line-dasharray': [2, 2] } },
    { id: 'dam-polygons', type: 'fill', source: 'shortbread', 'source-layer': 'dam_polygons', paint: { 'fill-color': '#91bdce', 'fill-outline-color': '#6f9eaf' } },
    { id: 'pier-polygons', type: 'fill', source: 'shortbread', 'source-layer': 'pier_polygons', paint: { 'fill-color': '#c9c4b8' } },
    { id: 'sites', type: 'fill', source: 'shortbread', 'source-layer': 'sites', minzoom: 10, paint: { 'fill-color': ['match', ['get', 'kind'], 'sports_centre', '#d8e5c9', 'university', '#e6dfc8', 'college', '#e6dfc8', 'school', '#e8e1c9', 'hospital', '#f0d9d5', 'parking', '#dedbd4', 'construction', '#e9d8b9', 'danger_area', '#e8d0c8', '#e3dfd4'], 'fill-outline-color': '#c9c3b7', 'fill-opacity': 0.82 } },
    { id: 'street-polygons', type: 'fill', source: 'shortbread', 'source-layer': 'street_polygons', minzoom: 12, paint: { 'fill-color': '#f8f5ed', 'fill-outline-color': '#e5dfd4' } },
    { id: 'street-casing', type: 'line', source: 'shortbread', 'source-layer': 'streets', minzoom: 5, paint: { 'line-color': '#b5ad9e', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.65, 10, 2.1, 14, 6, 18, 12], 'line-opacity': 0.9 } },
    {
      id: 'streets', type: 'line', source: 'shortbread', 'source-layer': 'streets', minzoom: 5,
      paint: {
        'line-color': ['match', ['get', 'kind'], 'motorway', '#d66f67', 'motorway_link', '#d9897f', 'trunk', '#d99b4c', 'trunk_link', '#e1b26e', 'primary', '#e1ad64', 'primary_link', '#e9c18a', 'secondary', '#fff8e8', 'secondary_link', '#fff8e8', 'tertiary', '#fffaf0', 'residential', '#fffdf7', 'unclassified', '#fffdf7', 'living_street', '#f8f1df', 'service', '#f3eddf', 'pedestrian', '#f1e8d5', 'track', '#d5c8a9', 'path', '#c9b994', 'footway', '#c9b994', 'cycleway', '#a9c5b5', 'steps', '#c9b994', 'rail', '#8f8b85', 'railway', '#8f8b85', 'runway', '#c7c2b8', '#f5f0e5'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.6, 10, 1.5, 14, 3.5, 18, 7],
        'line-opacity': 0.95
      }
    },
    { id: 'bridges', type: 'line', source: 'shortbread', 'source-layer': 'bridges', minzoom: 11, paint: { 'line-color': '#b89d7e', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1, 16, 4] } },
    { id: 'ferries', type: 'line', source: 'shortbread', 'source-layer': 'ferries', minzoom: 8, paint: { 'line-color': '#5797b3', 'line-width': 1.5, 'line-dasharray': [2, 2] } },
    { id: 'aerialways', type: 'line', source: 'shortbread', 'source-layer': 'aerialways', minzoom: 10, paint: { 'line-color': '#9a7b9c', 'line-width': 1.2, 'line-dasharray': [1, 2] } },
    { id: 'dam-lines', type: 'line', source: 'shortbread', 'source-layer': 'dam_lines', paint: { 'line-color': '#6f9eaf', 'line-width': 1.5 } },
    { id: 'pier-lines', type: 'line', source: 'shortbread', 'source-layer': 'pier_lines', paint: { 'line-color': '#b9b1a2', 'line-width': 1.5 } },
    { id: 'public-transport', type: 'circle', source: 'shortbread', 'source-layer': 'public_transport', minzoom: 12, paint: { 'circle-radius': 2.5, 'circle-color': '#765b9a', 'circle-stroke-color': '#fff', 'circle-stroke-width': 0.6 } },
    { id: 'buildings', type: 'fill', source: 'shortbread', 'source-layer': 'buildings', minzoom: 12, paint: { 'fill-color': '#d9cfc4', 'fill-outline-color': '#b9aa9b', 'fill-opacity': 0.92 } },
    { id: 'pois', type: 'circle', source: 'shortbread', 'source-layer': 'pois', minzoom: 12, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 1.8, 18, 4], 'circle-color': '#a36b42', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 0.6 } },
    // Nearly transparent anchor layers let the renderer obtain label geometry
    // without requesting remote MapLibre glyph PBF files.
    { id: 'label-places-anchor', type: 'circle', source: 'shortbread', 'source-layer': 'place_labels', minzoom: 2, paint: { 'circle-radius': 2, 'circle-opacity': 0.01 } },
    { id: 'label-boundaries-anchor', type: 'circle', source: 'shortbread', 'source-layer': 'boundary_labels', minzoom: 3, paint: { 'circle-radius': 2, 'circle-opacity': 0.01 } },
    { id: 'label-streets-anchor', type: 'line', source: 'shortbread', 'source-layer': 'street_labels', minzoom: 11, paint: { 'line-width': 8, 'line-opacity': 0.01 } },
    { id: 'label-water-anchor', type: 'line', source: 'shortbread', 'source-layer': 'water_lines_labels', minzoom: 10, paint: { 'line-width': 6, 'line-opacity': 0.01 } },
    { id: 'label-water-polygons-anchor', type: 'circle', source: 'shortbread', 'source-layer': 'water_polygons_labels', minzoom: 4, paint: { 'circle-radius': 2, 'circle-opacity': 0.01 } },
    { id: 'label-street-polygons-anchor', type: 'circle', source: 'shortbread', 'source-layer': 'streets_polygons_labels', minzoom: 14, paint: { 'circle-radius': 2, 'circle-opacity': 0.01 } },
    { id: 'label-street-points-anchor', type: 'circle', source: 'shortbread', 'source-layer': 'street_labels_points', minzoom: 14, paint: { 'circle-radius': 2, 'circle-opacity': 0.01 } },
    { id: 'label-public-transport-anchor', type: 'circle', source: 'shortbread', 'source-layer': 'public_transport', minzoom: 14, paint: { 'circle-radius': 2, 'circle-opacity': 0.01 } },
    { id: 'label-pois-anchor', type: 'circle', source: 'shortbread', 'source-layer': 'pois', minzoom: 14, paint: { 'circle-radius': 2, 'circle-opacity': 0.01 } }
  ]
};


function createOpenMapTilesStyle(styleName: OfflineMapStyle, mapId: string, minZoom: number, maxZoom: number, bounds: [number, number, number, number] | undefined, vectorLayers: string[]): StyleSpecification {
  const available = new Set(vectorLayers);
  const dark = styleName === 'versatiles-neutrino';
  const colorful = styleName === 'versatiles-colorful';
  const palette = dark
    ? { background: '#202b36', land: '#34434a', forest: '#354f45', grass: '#40544a', water: '#29485c', road: '#aab5bd', casing: '#596773', building: '#46545d', poi: '#c39b73', boundary: '#77808d' }
    : colorful
      ? { background: '#f7f5ed', land: '#e7e3d7', forest: '#b9d7a2', grass: '#d8e8b8', water: '#8bc9e8', road: '#fffdf5', casing: '#a99b86', building: '#d9c9b9', poi: '#c47b45', boundary: '#9b7db0' }
      : { background: '#f5f2ea', land: '#e6e1d5', forest: '#c8d9b8', grass: '#dce5c8', water: '#a9d5e5', road: '#f5f0e5', casing: '#b5ad9e', building: '#d9cfc4', poi: '#a36b42', boundary: '#a58aa2' };
  const style: StyleSpecification = {
    version: 8,
    name: 'LumaScope OpenMapTiles',
    sources: {
      shortbread: {
        type: 'vector',
        tiles: ['atom://app/offline-tiles/{z}/{x}/{y}?map=' + encodeURIComponent(mapId)],
        minzoom: minZoom, maxzoom: maxZoom,
        ...(bounds ? { bounds } : {}),
        attribution: '© OpenStreetMap contributors'
      }
    },
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': palette.background } }]
  };
  const add = (layer: StyleSpecification['layers'][number]): void => { style.layers.push(layer); };
  if (available.has('landcover')) add({ id: 'omt-landcover', type: 'fill', source: 'shortbread', 'source-layer': 'landcover', paint: { 'fill-color': ['match', ['get', 'class'], 'wood', palette.forest, 'forest', palette.forest, 'grass', palette.grass, 'scrub', palette.grass, 'wetland', palette.water, 'ice', '#e8edf0', 'sand', '#e5d5ad', palette.land], 'fill-opacity': 0.96 } });
  if (available.has('landuse')) add({ id: 'omt-landuse', type: 'fill', source: 'shortbread', 'source-layer': 'landuse', paint: { 'fill-color': ['match', ['get', 'class'], 'park', palette.grass, 'grass', palette.grass, 'cemetery', palette.forest, 'wood', palette.forest, 'residential', palette.land, 'commercial', palette.land, 'industrial', palette.land, palette.land], 'fill-opacity': 0.65 } });
  if (available.has('water')) add({ id: 'omt-water', type: 'fill', source: 'shortbread', 'source-layer': 'water', paint: { 'fill-color': palette.water } });
  if (available.has('waterway')) add({ id: 'omt-waterway', type: 'line', source: 'shortbread', 'source-layer': 'waterway', paint: { 'line-color': palette.water, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 14, 2.2] } });
  if (available.has('boundary')) add({ id: 'omt-boundary', type: 'line', source: 'shortbread', 'source-layer': 'boundary', paint: { 'line-color': palette.boundary, 'line-width': 1, 'line-dasharray': [2, 2] } });
  if (available.has('transportation')) {
    add({ id: 'omt-transportation-casing', type: 'line', source: 'shortbread', 'source-layer': 'transportation', minzoom: 5, paint: { 'line-color': palette.casing, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1, 10, 2.5, 14, 6, 18, 12] } });
    add({ id: 'omt-transportation', type: 'line', source: 'shortbread', 'source-layer': 'transportation', minzoom: 5, paint: { 'line-color': ['match', ['get', 'class'], 'motorway', '#d66f67', 'trunk', '#d99b4c', 'primary', '#e1ad64', 'secondary', '#fff0c9', 'tertiary', '#fffaf0', 'minor', palette.road, 'service', palette.road, 'path', palette.casing, 'track', palette.casing, 'rail', palette.casing, palette.road], 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.6, 10, 1.5, 14, 3.5, 18, 7] } });
  }
  if (available.has('building')) add({ id: 'omt-building', type: 'fill', source: 'shortbread', 'source-layer': 'building', minzoom: 12, paint: { 'fill-color': palette.building, 'fill-outline-color': palette.casing, 'fill-opacity': 0.9 } });
  if (available.has('poi')) add({ id: 'omt-poi', type: 'circle', source: 'shortbread', 'source-layer': 'poi', minzoom: 12, paint: { 'circle-radius': 2.5, 'circle-color': palette.poi, 'circle-stroke-color': '#fff', 'circle-stroke-width': 0.6 } });
  if (available.has('place')) add({ id: 'omt-label-places-anchor', type: 'circle', source: 'shortbread', 'source-layer': 'place', minzoom: 2, paint: { 'circle-radius': 2, 'circle-opacity': 0.01 } });
  if (available.has('boundary')) add({ id: 'omt-label-boundaries-anchor', type: 'line', source: 'shortbread', 'source-layer': 'boundary', minzoom: 3, paint: { 'line-width': 5, 'line-opacity': 0.01 } });
  if (available.has('water_name')) add({ id: 'omt-label-water-anchor', type: 'line', source: 'shortbread', 'source-layer': 'water_name', minzoom: 5, paint: { 'line-width': 5, 'line-opacity': 0.01 } });
  if (available.has('transportation_name')) add({ id: 'omt-label-streets-anchor', type: 'line', source: 'shortbread', 'source-layer': 'transportation_name', minzoom: 11, paint: { 'line-width': 6, 'line-opacity': 0.01 } });
  if (available.has('poi')) add({ id: 'omt-label-pois-anchor', type: 'circle', source: 'shortbread', 'source-layer': 'poi', minzoom: 14, paint: { 'circle-radius': 2, 'circle-opacity': 0.01 } });
  style.name = dark ? 'LumaScope OpenMapTiles Neutrino' : colorful ? 'LumaScope OpenMapTiles Colorful' : 'LumaScope OpenMapTiles';
  return style;
}

export function createOfflineMapStyle(styleName: OfflineMapStyle, mapId: string, minZoom = 0, maxZoom = 14, bounds?: [number, number, number, number], schema: 'shortbread' | 'openmaptiles' = 'shortbread', vectorLayers: string[] = []): StyleSpecification {
  if (schema === 'openmaptiles') return createOpenMapTilesStyle(styleName, mapId, minZoom, maxZoom, bounds, vectorLayers);
  const style = JSON.parse(JSON.stringify(AUSTRIA_SHORTBREAD_STYLE)) as StyleSpecification;
  const source = style.sources?.['shortbread'];
  if (source && source.type === 'vector') { source.tiles = ['atom://app/offline-tiles/{z}/{x}/{y}?map=' + encodeURIComponent(mapId)]; source.minzoom = minZoom; source.maxzoom = maxZoom; if (bounds) source.bounds = bounds; }
  style.name = 'LumaScope ' + (styleName === 'lumascope' ? 'Shortbread' : styleName);
  const palette = styleName === 'versatiles-colorful'
    ? {
      background: '#f7f5ed', land: '#e7e3d7', forest: '#b9d7a2', grass: '#d8e8b8',
      water: '#8bc9e8', boundary: '#9b7db0', casing: '#a99b86', road: '#fffdf5',
      motorway: '#e56f62', primary: '#f2b85b', secondary: '#fff0c9', tertiary: '#fff9e8',
      building: '#d9c9b9', site: '#e9d9a8', poi: '#c47b45', transport: '#7758a6'
    }
    : styleName === 'versatiles-neutrino'
      ? {
        background: '#202b36', land: '#34434a', forest: '#354f45', grass: '#40544a',
        water: '#29485c', boundary: '#77808d', casing: '#596773', road: '#aab5bd',
        motorway: '#d18b82', primary: '#c6a77b', secondary: '#84939e', tertiary: '#647581',
        building: '#46545d', site: '#48565c', poi: '#c39b73', transport: '#a18cbd'
      }
      : {
        background: '#f5f2ea', land: '#e6e1d5', forest: '#c8d9b8', grass: '#dce5c8',
        water: '#a9d5e5', boundary: '#a58aa2', casing: '#b5ad9e', road: '#f5f0e5',
        motorway: '#d66f67', primary: '#e1ad64', secondary: '#fff8e8', tertiary: '#fffaf0',
        building: '#d9cfc4', site: '#e3dfd4', poi: '#a36b42', transport: '#765b9a'
      };
  const setPaint = (id: string, values: Record<string, unknown>): void => {
    const layer = style.layers.find(candidate => candidate.id === id);
    if (layer && 'paint' in layer && layer.paint !== undefined) Object.assign(layer.paint, values);
  };
  const landColor = ['match', ['get', 'kind'], 'forest', palette.forest, 'grass', palette.grass,
    'meadow', palette.grass, 'orchard', palette.grass, 'vineyard', palette.grass, palette.land];
  const roadColor = ['match', ['get', 'kind'],
    'motorway', palette.motorway, 'motorway_link', palette.motorway,
    'trunk', palette.primary, 'trunk_link', palette.primary, 'primary', palette.primary, 'primary_link', palette.primary,
    'secondary', palette.secondary, 'secondary_link', palette.secondary,
    'tertiary', palette.tertiary, 'residential', palette.road, 'unclassified', palette.road,
    'living_street', palette.road, 'service', palette.road, 'pedestrian', palette.road,
    'track', palette.casing, 'path', palette.casing, 'footway', palette.casing, 'cycleway', palette.grass,
    'steps', palette.casing, 'rail', palette.casing, 'railway', palette.casing, palette.road];
  setPaint('background', { 'background-color': palette.background });
  setPaint('land', { 'fill-color': landColor });
  setPaint('ocean', { 'fill-color': palette.water });
  setPaint('water-polygons', { 'fill-color': palette.water });
  setPaint('water-lines', { 'line-color': palette.water });
  setPaint('boundaries', { 'line-color': palette.boundary });
  setPaint('street-casing', { 'line-color': palette.casing });
  setPaint('streets', { 'line-color': roadColor });
  setPaint('buildings', { 'fill-color': palette.building, 'fill-outline-color': palette.casing });
  setPaint('sites', { 'fill-color': palette.site, 'fill-outline-color': palette.casing });
  setPaint('pois', { 'circle-color': palette.poi });
  setPaint('public-transport', { 'circle-color': palette.transport });
  style.name = styleName === 'lumascope' ? 'LumaScope' :
    styleName === 'versatiles-colorful' ? 'VersaTiles Colorful (local Shortbread palette)' :
    'VersaTiles Neutrino (local Shortbread palette)';
  return style;
}

export class OfflineMapRenderer {
  readonly map: MapLibreMap;
  private trackHoverHandler: ((path: string, latitude: number, longitude: number) => void) | null = null;
  readonly ready: Promise<void>;
  private currentMarkerElement: HTMLElement | null = null;
  private hillshadeDatabases: OsmAndHillshadeDatabase[] = [];
  private hillshadeSourceRevision = 0;
  private hillshadeOpacity = 0.65;
  private hillshadeVisible = false;
  private currentLocation: [number, number] | null = null;
  private readonly overlayElement: HTMLDivElement;
  private readonly tileProtocol: OsmAndTileProtocol | null;
  private readonly tileStatusLayer: HTMLDivElement;
  private readonly tileStatuses = new Map<string, OsmAndTileStatusEventDetail>();
  private tileVisualsEnabled = true;
  private readonly tileStatusElements = new Map<string, HTMLDivElement>();
  private atlasZoomCheckTimer: number | null = null;
  private readonly onMapZoomEnd = (): void => {
    if (this.tileProtocol !== 'osmand-atlas') return;
    if (this.atlasZoomCheckTimer !== null) window.clearTimeout(this.atlasZoomCheckTimer);
    // Coalesce rapid wheel/key zoom steps. Re-registering the same tile template
    // makes MapLibre rebuild the source's current viewport coverage and request
    // any tiles it failed to request during the zoom sequence. Existing Atlas
    // disk-cache entries are reused by the protocol.
    this.atlasZoomCheckTimer = window.setTimeout(() => {
      this.atlasZoomCheckTimer = null;
      // Do not gate this on map.isStyleLoaded(): it can be false precisely
      // while raster tiles are still pending, which is when the refresh is
      // needed. The source object is available independently of tile completion.
      const source = this.map.getSource('osmand-atlas') as { setTiles?: (tiles: string[]) => unknown } | undefined;
      if (!source?.setTiles) {
        console.warn('[OsmAnd Atlas] Could not recheck tiles after zoom: raster source is unavailable.');
        return;
      }
      // Use a fresh URL template after each settled zoom. Reapplying the
      // identical template can leave MapLibre's in-memory raster tile cache
      // attached to stale tile instances; a unique query forces a new source
      // tile identity while the native Atlas disk cache remains reusable.
      const refresh = Date.now();
      source.setTiles([`osmand-atlas://{z}/{x}/{y}?refresh=${refresh}`]);
      console.info('[OsmAnd Atlas] Rechecked visible tiles after zoom', {
        zoom: this.map.getZoom(),
        refresh,
        sourceReloadRequested: true
      });
    }, 180);
  };
  private readonly onMapMoveStart = (): void => {
    if (this.atlasZoomCheckTimer !== null) {
      window.clearTimeout(this.atlasZoomCheckTimer);
      this.atlasZoomCheckTimer = null;
    }
    // Status overlays belong to a specific viewport. Remove them immediately
    // when the camera starts moving; requests from the settled viewport will
    // publish fresh entries. Late completions for aborted requests are ignored
    // by the protocol's cancelled status.
    this.tileStatuses.clear();
    for (const element of this.tileStatusElements.values()) element.remove();
    this.tileStatusElements.clear();
    this.updateOsmAndTileStatusPositions();
  };
  private readonly onMapLibreTileLoading = (event: unknown): void => {
    const data = event as { sourceId?: string; sourceDataType?: string; coord?: { canonical?: { z: number; x: number; y: number } } };
    const canonical = data.coord?.canonical;
    if (!canonical || data.sourceDataType !== 'content' || data.sourceId === 'osmand' || data.sourceId === 'osmand-atlas' || data.sourceId === 'osmand-hillshade' || String(data.sourceId ?? '').startsWith('osmand-hillshade-')) return;
    this.setMapLibreTileStatus(data.sourceId ?? 'map', canonical.z, canonical.x, canonical.y, 'loading');
  };
  private readonly onMapLibreTileLoaded = (event: unknown): void => {
    const data = event as { sourceId?: string; sourceDataType?: string; coord?: { canonical?: { z: number; x: number; y: number } } };
    const canonical = data.coord?.canonical;
    if (!canonical || data.sourceDataType !== 'content' || data.sourceId === 'osmand-hillshade' || String(data.sourceId ?? '').startsWith('osmand-hillshade-')) return;
    this.setMapLibreTileStatus(data.sourceId ?? 'map', canonical.z, canonical.x, canonical.y, 'loaded');
  };
  private readonly onMapLibreTileError = (event: unknown): void => {
    const data = event as { sourceId?: string; coord?: { canonical?: { z: number; x: number; y: number } }; error?: unknown };
    if (data.sourceId === 'osmand' || data.sourceId === 'osmand-atlas' || data.sourceId === 'osmand-hillshade' || String(data.sourceId ?? '').startsWith('osmand-hillshade-')) return;
    const message = data.error instanceof Error ? data.error.message : String(data.error ?? 'Unknown tile loading error');
    const canonical = data.coord?.canonical;
    if (canonical) {
      this.setMapLibreTileStatus(data.sourceId ?? 'map', canonical.z, canonical.x, canonical.y, 'error', message);
      return;
    }
    // Some MapLibre source errors do not expose the failing tile coordinate.
    // Keep the affected source's currently loading tiles visibly marked as failed.
    for (const [key, status] of this.tileStatuses) {
      if (status.protocol === 'maplibre' && status.sourceId === data.sourceId && status.status === 'loading') {
        this.tileStatuses.set(key, { ...status, status: 'error', error: message });
      }
    }
    this.updateOsmAndTileStatusPositions();
  };
  private setMapLibreTileStatus(sourceId: string, zoom: number, column: number, row: number, status: OsmAndTileStatus, error?: string): void {
    const detail: OsmAndTileStatusEventDetail = { protocol: 'maplibre', sourceId, zoom, column, row, status, ...(error ? { error } : {}) };
    const key = `maplibre/${sourceId}/${zoom}/${column}/${row}`;
    if (status === 'loaded' || status === 'cancelled') {
      this.tileStatuses.delete(key);
      this.tileStatusElements.get(key)?.remove();
      this.tileStatusElements.delete(key);
    } else {
      this.tileStatuses.set(key, detail);
    }
    this.updateOsmAndTileStatusPositions();
  }
  private readonly onTileVisualsChanged = (event: Event): void => {
    const detail = (event as CustomEvent<{ enabled?: boolean }>).detail;
    this.tileVisualsEnabled = detail?.enabled !== false;
    this.tileStatusLayer.style.display = this.tileVisualsEnabled ? '' : 'none';
    if (!this.tileVisualsEnabled) {
      // Remove existing tile overlays as well as hiding the layer. Tab changes
      // and subsequent status events must not make disabled visuals reappear.
      for (const element of this.tileStatusElements.values()) element.remove();
      this.tileStatusElements.clear();
      return;
    }
    this.updateOsmAndTileStatusPositions();
  };
  private readonly onOsmAndTileStatus = (event: Event): void => {
    if (!this.tileProtocol) return;
    const detail = (event as CustomEvent<OsmAndTileStatusEventDetail>).detail;
    if (!detail || detail.protocol !== this.tileProtocol) return;
    const key = `${detail.protocol}/${detail.sourceId ?? ''}/${detail.zoom}/${detail.column}/${detail.row}`;
    if (detail.status === 'loaded' || detail.status === 'cancelled') {
      this.tileStatuses.delete(key);
      this.tileStatusElements.get(key)?.remove();
      this.tileStatusElements.delete(key);
    } else {
      this.tileStatuses.set(key, detail);
    }
    this.updateOsmAndTileStatusPositions();
  };
  private readonly clusterLabels = new Map<number, { element: HTMLSpanElement; coordinates: [number, number] }>();
  private readonly textLabels = new Map<string, { element: HTMLSpanElement; coordinates: [number, number] }>();
  private textLabelOpacity = 1;
  private photoOpacity = 1;
  private photoClustersVisible = true;
  private photoClusterColor = 'dynamic';
  private photoClusterShape: 'double-circle' | 'hexagon' | 'circle' | 'square' = 'double-circle';
  private onPhotoSelected: ((path: string) => void) | null = null;
  private photoPreviewElement: HTMLDivElement | null = null;
  private activePhotoPreviewKey: string | null = null;
  private activePhotoPreviewCoordinates: [number, number] | null = null;
  private clusterPreviewRequestId = 0;
  private lastMapError: string | null = null;
  private labelSourceDiagnosticLogged = false;
  private vectorSourceDiagnosticLogged = false;
  private readonly resizeObserver: ResizeObserver;
  private lastPointerObservation: Record<string, unknown> | null = null;
  private dragEventCount = 0;
  private dragDiagnostic: {
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    startZoom: number;
    startCenter: [number, number];
    startContainerRect: DOMRect;
    startCanvasRect: DOMRect;
    startCanvasWidth: number;
    startCanvasHeight: number;
    pointerSamples: Array<Record<string, unknown>>;
    dragSamples: Array<Record<string, unknown>>;
    cameraSamples: Array<Record<string, unknown>>;
  } | null = null;
  private readonly onDiagnosticPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const container = this.map.getContainer();
    const canvas = this.map.getCanvas();
    this.dragDiagnostic = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      startZoom: this.map.getZoom(),
      startCenter: this.map.getCenter().toArray() as [number, number],
      startContainerRect: container.getBoundingClientRect(),
      startCanvasRect: canvas.getBoundingClientRect(),
      startCanvasWidth: canvas.width,
      startCanvasHeight: canvas.height,
      pointerSamples: [],
      dragSamples: [],
      cameraSamples: [this.getCameraDiagnosticSnapshot()]
    };
    this.dragDiagnostic.pointerSamples.push({
      timeMs: performance.now(),
      x: event.clientX,
      y: event.clientY,
      movementX: event.movementX,
      movementY: event.movementY,
      camera: this.getCameraDiagnosticSnapshot()
    });
  };
  private readonly onDiagnosticPointerMove = (event: PointerEvent): void => {
    this.lastPointerObservation = {
      timeMs: performance.now(), pointerId: event.pointerId,
      x: event.clientX, y: event.clientY,
      movementX: event.movementX, movementY: event.movementY,
      buttons: event.buttons, target: (event.target as HTMLElement | null)?.tagName ?? null
    };
    if (!this.dragDiagnostic || event.pointerId !== this.dragDiagnostic.pointerId) return;
    this.dragDiagnostic.lastX = event.clientX;
    this.dragDiagnostic.lastY = event.clientY;
    if (this.dragDiagnostic.pointerSamples.length < 300) {
      this.dragDiagnostic.pointerSamples.push({
        timeMs: performance.now(),
        x: event.clientX,
        y: event.clientY,
        movementX: event.movementX,
        movementY: event.movementY
      });
    }
  };
  private readonly onDiagnosticMapDragStart = (): void => {
    this.dragEventCount = 0;
    console.info('[OfflineMap][DragStart]', {
      timeMs: performance.now(),
      pointer: this.lastPointerObservation,
      center: this.map.getCenter().toArray(),
      zoom: this.map.getZoom(), pitch: this.map.getPitch(), bearing: this.map.getBearing()
    });
  };
  private readonly onDiagnosticMapDrag = (): void => {
    const sample = {
      timeMs: performance.now(),
      pointer: this.lastPointerObservation,
      trackedPointer: this.dragDiagnostic ? [this.dragDiagnostic.lastX, this.dragDiagnostic.lastY] : null,
      center: this.map.getCenter().toArray(),
      zoom: this.map.getZoom(), pitch: this.map.getPitch(), bearing: this.map.getBearing()
    };
    this.dragEventCount++;
    const diagnostic = this.dragDiagnostic;
    if (diagnostic && diagnostic.dragSamples.length < 300) diagnostic.dragSamples.push(sample);
  };
  private readonly onDiagnosticMapDragEnd = (): void => {
    console.info('[OfflineMap][DragEnd]', {
      timeMs: performance.now(), dragEventCount: this.dragEventCount,
      pointer: this.lastPointerObservation,
      center: this.map.getCenter().toArray(),
      zoom: this.map.getZoom(), pitch: this.map.getPitch(), bearing: this.map.getBearing()
    });
  };
  private readonly onDiagnosticMapMove = (): void => {
    const diagnostic = this.dragDiagnostic;
    if (!diagnostic || diagnostic.cameraSamples.length >= 300) return;
    diagnostic.cameraSamples.push(this.getCameraDiagnosticSnapshot());
  };
  private getCameraDiagnosticSnapshot(): Record<string, unknown> {
    return {
      timeMs: performance.now(),
      zoom: this.map.getZoom(),
      pitch: this.map.getPitch(),
      bearing: this.map.getBearing(),
      center: this.map.getCenter().toArray(),
      projection: this.map.getProjection()
    };
  }
  private readonly onDiagnosticPointerEnd = (event: PointerEvent): void => {
    const start = this.dragDiagnostic;
    if (!start || event.pointerId !== start.pointerId) return;
    this.dragDiagnostic = null;

    const container = this.map.getContainer();
    const canvas = this.map.getCanvas();
    const containerRect = container.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const endX = event.clientX;
    const endY = event.clientY;
    const startZoom = start.startZoom;
    const endZoom = this.map.getZoom();
    const startMapPoint: [number, number] = [
      start.startX - start.startContainerRect.left,
      start.startY - start.startContainerRect.top
    ];
    const endMapPoint: [number, number] = [
      endX - containerRect.left,
      endY - containerRect.top
    ];
    const startGeo = this.map.unproject(startMapPoint);
    const endGeo = this.map.unproject(endMapPoint);
    const center = this.map.getCenter().toArray();

    console.info('[OfflineMap][DragDiagnostic]', {
      pointer: { start: [start.startX, start.startY], end: [endX, endY],
        deltaCssPixels: [endX - start.startX, endY - start.startY] },
      zoom: { start: startZoom, end: endZoom,
        startIntegerLevel: Math.floor(startZoom), endIntegerLevel: Math.floor(endZoom),
        sourceMaxZoom: 14 },
      center: { start: start.startCenter, end: center },
      mapPoint: { start: startMapPoint, end: endMapPoint },
      geographicUnderPointer: {
        start: [startGeo.lng, startGeo.lat],
        end: [endGeo.lng, endGeo.lat]
      },
      container: {
        startClient: [container.clientWidth, container.clientHeight],
        startRect: [start.startContainerRect.width, start.startContainerRect.height],
        endClient: [container.clientWidth, container.clientHeight],
        endRect: [containerRect.width, containerRect.height],
        cssScale: [containerRect.width / Math.max(1, container.clientWidth),
          containerRect.height / Math.max(1, container.clientHeight)]
      },
      canvas: {
        startRect: [start.startCanvasRect.width, start.startCanvasRect.height],
        endRect: [canvasRect.width, canvasRect.height],
        backingStore: [start.startCanvasWidth, start.startCanvasHeight, canvas.width, canvas.height],
        backingScale: [canvas.width / Math.max(1, canvasRect.width),
          canvas.height / Math.max(1, canvasRect.height)]
      },
      devicePixelRatio: window.devicePixelRatio,
      lastObservedPointer: [start.lastX, start.lastY],
      dragSamples: start.dragSamples,
      cameraSamples: start.cameraSamples,
      pointerSamples: start.pointerSamples
    });
  };

  constructor(container: HTMLElement, center: [number, number], zoom: number, private readonly onError?: (message: string) => void, private readonly styleName: OfflineMapStyle = 'lumascope', private readonly mapId = '', private readonly minZoom = 0, private readonly maxZoom = 14, private readonly bounds?: [number, number, number, number], private readonly schema: 'shortbread' | 'openmaptiles' = 'shortbread', private readonly vectorLayers: string[] = [], styleOverride?: StyleSpecification) {
    const options: MapOptions = {
      container, style: withOsmAndHillshadeOverlay(styleOverride ?? createOfflineMapStyle(styleName, mapId, minZoom, maxZoom, bounds, schema, vectorLayers)),
      center, zoom,
      minZoom: styleOverride ? 2 : 0, maxZoom: 20,
      // Lock the offline map to a flat 2D Mercator view for drag diagnostics.
      pitch: 0,
      bearing: 0,
      maxPitch: 0,
      dragRotate: false,
      touchPitch: false,
      // Disable MapLibre 6's partial overscaling strategy. Split overzoomed vector tiles
      // consistently above the MBTiles native maxzoom (14) to avoid unstable camera transforms.
      zoomLevelsToOverscale: 0,
      attributionControl: { compact: false },
      // Disable drag inertia: at high zoom levels it can make the map continue
      // moving far beyond the user's drag distance.
      reduceMotion: true,
      // Use the public MapLibre API to anchor wheel zoom to the map center.
      scrollZoom: { around: 'center' },
      cooperativeGestures: false, renderWorldCopies: false
    };
    this.map = new MapLibreMap(options);
    this.map.addControl(new ScaleControl({ maxWidth: 140, unit: 'metric' }), 'bottom-left');
    // MapLibre puts all controls in a low-z-index stacking context (2).
    // Raise that parent above our geographic marker overlay (z-index 20),
    // otherwise the scale control remains hidden regardless of its own z-index.
    const controlContainer = this.map.getContainer().querySelector<HTMLElement>('.maplibregl-control-container');
    if (controlContainer) controlContainer.style.zIndex = '30';
    const scaleContainer = this.map.getContainer().querySelector<HTMLElement>('.maplibregl-ctrl-bottom-left');
    const scaleControl = scaleContainer?.querySelector<HTMLElement>('.maplibregl-ctrl-scale');
    if (scaleControl) {
      // Detach the scale from MapLibre's control stacking context. The map's
      // geographic marker overlay can otherwise cover it even with raised z-indexes.
      scaleControl.style.position = 'absolute';
      scaleControl.style.left = '10px';
      scaleControl.style.bottom = '10px';
      scaleControl.style.margin = '0';
      scaleControl.style.zIndex = '10000';
      scaleControl.style.pointerEvents = 'auto';
      this.map.getContainer().appendChild(scaleControl);
    }
    this.tileProtocol = styleOverride?.name === 'LumaScope OsmAnd Atlas'
      ? 'osmand-atlas'
      : styleOverride?.name === 'LumaScope OsmAnd OBF' ? 'osmand' : null;
    this.tileStatusLayer = document.createElement('div');
    this.tileStatusLayer.className = 'osmand-tile-status-layer';
    this.tileStatusLayer.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:15;';
    const tileStatusStyle = document.createElement('style');
    tileStatusStyle.textContent = '@keyframes osmand-tile-spin{to{transform:rotate(360deg)}}';
    this.tileStatusLayer.appendChild(tileStatusStyle);
    this.map.getContainer().appendChild(this.tileStatusLayer);
    window.addEventListener('lumascope-osmand-tile-status', this.onOsmAndTileStatus);
    window.addEventListener('lumascope-osmand-tile-visuals', this.onTileVisualsChanged);
    this.map.on('sourcedataloading', this.onMapLibreTileLoading);
    this.map.on('sourcedata', this.onMapLibreTileLoaded);
    this.map.on('error', this.onMapLibreTileError);
    this.map.on('movestart', this.onMapMoveStart);
    this.map.on('zoomend', this.onMapZoomEnd);
    // Use a dedicated geographic overlay rather than MapLibre DOM Marker. The
    // overlay is positioned from MapLibre's current projection on every render,
    // avoiding marker CSS transforms that can drift relative to the tile canvas.
    this.overlayElement = document.createElement('div');
    this.overlayElement.className = 'offline-map-geographic-overlay';
    this.overlayElement.style.cssText = 'position:absolute;inset:0;overflow:visible;pointer-events:none;z-index:20;';
    this.map.getContainer().appendChild(this.overlayElement);
    this.map.on('render', this.updateOverlayPositions);
    // Temporary diagnostics: compare physical pointer movement with MapLibre's
    // container/canvas geometry and camera state for each completed drag.
    const mapContainer = this.map.getContainer();
    mapContainer.addEventListener('pointerdown', this.onDiagnosticPointerDown, true);
    window.addEventListener('pointermove', this.onDiagnosticPointerMove, true);
    window.addEventListener('pointerup', this.onDiagnosticPointerEnd, true);
    window.addEventListener('pointercancel', this.onDiagnosticPointerEnd, true);
    this.map.on('move', this.onDiagnosticMapMove);
    // MapLibre emits 'drag' after its drag-pan handler has updated the camera.
    // Pair this with the window-level pointer samples to compare input and output.
    this.map.on('dragstart', this.onDiagnosticMapDragStart);
    this.map.on('dragend', this.onDiagnosticMapDragEnd);
    // Log the exact layout transition when the settings panel changes the map viewport.
    // This helps distinguish stale canvas dimensions from incorrect drag coordinate mapping.
    let previousObservedSize: [number, number] | null = null;
    this.resizeObserver = new ResizeObserver(entries => {
      const entry = entries[0];
      const rect = container.getBoundingClientRect();
      const observedSize: [number, number] = [rect.width, rect.height];
      const changed = !previousObservedSize
        || previousObservedSize[0] !== observedSize[0]
        || previousObservedSize[1] !== observedSize[1];
      if (!changed) return;

      const previousSize = previousObservedSize;
      previousObservedSize = observedSize;
      const canvas = this.map.getCanvas();
      console.info('[OfflineMap][ResizeObserver]', {
        timeMs: performance.now(),
        previousContainerSize: previousSize,
        observedContentRect: entry ? [entry.contentRect.width, entry.contentRect.height] : null,
        containerClientSize: [container.clientWidth, container.clientHeight],
        containerRect: observedSize,
        canvasRectBeforeResize: (() => {
          const canvasRect = canvas.getBoundingClientRect();
          return [canvasRect.width, canvasRect.height];
        })(),
        canvasBackingStoreBeforeResize: [canvas.width, canvas.height]
      });

      this.map.resize();

      const resizedCanvasRect = canvas.getBoundingClientRect();
      console.info('[OfflineMap][ResizeComplete]', {
        timeMs: performance.now(),
        containerClientSize: [container.clientWidth, container.clientHeight],
        containerRect: [rect.width, rect.height],
        canvasRect: [resizedCanvasRect.width, resizedCanvasRect.height],
        canvasBackingStore: [canvas.width, canvas.height],
        mapCenter: this.map.getCenter().toArray(),
        zoom: this.map.getZoom()
      });
    });
    this.resizeObserver.observe(container);
    // Keep mouse-wheel zoom deliberately slow; the anchor is configured
    // through MapOptions.scrollZoom above (no private MapLibre fields).
    this.map.scrollZoom.setWheelZoomRate(1 / 1200);
    let mapErrorCount = 0;
    this.map.on('error', event => {
      const diagnostic = event as typeof event & {
        sourceId?: string;
        coord?: { canonical?: { z: number; x: number; y: number } };
        tile?: { tileID?: { canonical?: { z: number; x: number; y: number } } };
      };
      const message = event.error instanceof Error ? event.error.message : String(event.error);
      const canonical = diagnostic.coord?.canonical ?? diagnostic.tile?.tileID?.canonical;
      const context = [
        diagnostic.sourceId ? `source=${diagnostic.sourceId}` : '',
        canonical ? `tile=z${canonical.z}/x${canonical.x}/y${canonical.y}` : ''
      ].filter(Boolean);
      this.lastMapError = context.length ? `${message} (${context.join(', ')})` : message;
      if (mapErrorCount++ < 50) {
        console.error('[OfflineMap] MapLibre error details:', {
          message,
          sourceId: diagnostic.sourceId ?? null,
          tile: canonical ?? null,
          error: event.error
        });
        onError?.(this.lastMapError);
      }
    });
    this.map.on('style.load', () => {
      // Style reloads recreate paint properties. Reapply the current user values
      // after every load, not only when the opacity controls are interacted with.
      this.setBasemapOpacity(this.basemapOpacity);
      this.setHillshadeOpacity(this.hillshadeOpacity);
      this.setTextLabelOpacity(this.textLabelOpacity);
    });
    this.map.on('load', () => { console.info('[OfflineMap] MapLibre style loaded.'); this.syncHillshadeLayers(); });
    this.ready = new Promise((resolve, reject) => {
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        const detail = this.lastMapError ? ` Last MapLibre error: ${this.lastMapError}` : ' No MapLibre error event was reported.';
        reject(new Error('MapLibre did not finish loading the offline map within 15 seconds.' + detail + ' Check whether [OfflineMap] Protocol request received appears in the application log.'));
      }, 15000);
      // Do not wait for raster tiles to finish: overlays must initialize even
      // when the native tile helper is still failing or the OBF has no coverage.
      this.map.once('style.load', () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        try {
          this.initializePhotoLayers();
          resolve();
        } catch (error) {
          reject(error);
        }
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
    const gpxLineStyles: Array<{ id: string; style: string; dash?: number[] }> = [
      { id: 'gpx-track-line', style: 'solid' },
      { id: 'gpx-track-line-dashed', style: 'dashed', dash: [3, 2] },
      { id: 'gpx-track-line-dotted', style: 'dotted', dash: [1, 2] },
      { id: 'gpx-track-line-long-dashed', style: 'long-dashed', dash: [6, 2] },
      { id: 'gpx-track-line-short-dashed', style: 'short-dashed', dash: [2, 2] },
      { id: 'gpx-track-line-dash-dot', style: 'dash-dot', dash: [4, 2, 1, 2] },
      { id: 'gpx-track-line-dash-dot-dot', style: 'dash-dot-dot', dash: [4, 2, 1, 2, 1, 2] }
    ];
    for (const line of gpxLineStyles) {
      this.map.addLayer({
        id: line.id, type: 'line', source: 'gpx-track', filter: ['==', ['get', 'lineStyle'], line.style],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-opacity': 0.92,
          ...(line.dash ? { 'line-dasharray': line.dash } : {})
        }
      });
    }
    for (const layerId of gpxLineStyles.map(line => line.id)) {
      this.map.on('mousemove', layerId, (event: MapLayerMouseEvent) => {
        const feature = event.features?.[0];
        const path = feature?.properties?.['path'];
        if (typeof path === 'string') this.trackHoverHandler?.(path, event.lngLat.lat, event.lngLat.lng);
      });
      this.map.on('mouseleave', layerId, () => this.trackHoverHandler?.('', Number.NaN, Number.NaN));
    }
    this.map.addLayer({
      id: 'gpx-track-direction-arrows', type: 'symbol', source: 'gpx-track',
      filter: ['==', ['get', 'showDirection'], true],
      layout: {
        'symbol-placement': 'line', 'symbol-spacing': 23,
        'text-field': ['match', ['get', 'directionStyle'], 'chevron', '❯', 'triangle', '▶', 'thin', '➜', 'large-classic', '➤', 'large-chevron', '❯', 'large-triangle', '▶', '➤'],
        'text-font': ['Open Sans Semibold', 'Arial Unicode MS Regular'],
        'text-size': ['match', ['get', 'directionStyle'], 'large-classic', 24, 'large-chevron', 24, 'large-triangle', 24, 18],
        'text-rotation-alignment': 'map', 'text-keep-upright': false,
        'text-allow-overlap': true, 'text-ignore-placement': true
      },
      paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#ffffff', 'text-halo-width': 1.5, 'text-opacity': 0.92 }
    });
    // Reconcile overlays after tile/camera updates; retain existing DOM markers.
    const refreshOverlays = (): void => {
      this.refreshClusterLabels();
      this.refreshTextLabels();
      this.logVectorSourceDiagnostics();
    };
    // Re-run after source tiles finish loading as well as after camera movement.
    // This is important when switching online/offline: the first idle can occur
    // before the final Shortbread label tiles are queryable, while no drag follows.
    this.map.on('idle', refreshOverlays);
    this.map.on('moveend', refreshOverlays);
    this.map.on('zoomend', refreshOverlays);
    this.map.on('sourcedata', event => {
      if ((event.sourceId === 'shortbread' || event.sourceId === 'photo-markers') && event.isSourceLoaded) refreshOverlays();
    });
    this.map.on('click', 'photo-clusters', event => {
      this.clusterPreviewRequestId++;
      this.clearPhotoPreview();
      const feature = event.features?.[0];
      const clusterId = feature?.properties?.['cluster_id'];
      const coordinates = feature?.geometry?.type === 'Point' ? feature.geometry.coordinates : null;
      if (typeof clusterId !== 'number' || !coordinates) return;
      const source = this.map.getSource('photo-markers');
      if (!source || !('getClusterExpansionZoom' in source)) return;
      void (source as import('maplibre-gl').GeoJSONSource)
        .getClusterExpansionZoom(clusterId)
        .then(zoom => this.map.easeTo({ center: coordinates as [number, number], zoom }))
        .catch(() => undefined);
    });
    this.map.on('mouseenter', 'photo-clusters', event => {
      const feature = event.features?.[0];
      const clusterId = feature?.properties?.['cluster_id'];
      const coordinates = feature?.geometry?.type === 'Point' ? feature.geometry.coordinates : null;
      if (typeof clusterId !== 'number' || !coordinates) return;
      const source = this.map.getSource('photo-markers');
      if (!source || !('getClusterLeaves' in source)) return;

      const requestId = ++this.clusterPreviewRequestId;
      void (source as import('maplibre-gl').GeoJSONSource)
        .getClusterLeaves(clusterId, 1, 0)
        .then(leaves => {
          if (requestId !== this.clusterPreviewRequestId) return;
          const properties = leaves[0]?.properties;
          const path = properties?.['path'];
          const fileName = properties?.['fileName'];
          if (typeof path !== 'string' || typeof fileName !== 'string') return;
          this.showPhotoPreview(path, fileName, coordinates as [number, number]);
        })
        .catch(() => undefined);
    });
    this.map.on('mouseleave', 'photo-clusters', () => {
      this.clusterPreviewRequestId++;
      this.clearPhotoPreview();
    });
    this.map.on('click', 'photo-unclustered', event => {
      const path = event.features?.[0]?.properties?.['path'];
      if (typeof path === 'string') {
        this.clearPhotoPreview();
        this.onPhotoSelected?.(path);
      }
    });
    // Use the geographic DOM overlay for previews. MapLibre Popup is attached
    // to the map container and can end up underneath the custom geographic overlay.
    // A DOM preview inside that overlay has a deterministic stacking order.
    this.map.on('mousemove', event => {
      const point = event.point;
      // Cluster previews are loaded asynchronously by the cluster-layer
      // mouseenter handler. Do not clear them while the pointer remains on a cluster.
      if (this.map.queryRenderedFeatures(point, { layers: ['photo-clusters'] }).length > 0) return;
      const features = this.map.queryRenderedFeatures(
        [[point.x - 12, point.y - 12], [point.x + 12, point.y + 12]],
        { layers: ['photo-unclustered'] }
      );
      const feature = features[0];
      const path = feature?.properties?.['path'];
      const fileName = feature?.properties?.['fileName'];
      if (typeof path !== 'string' || typeof fileName !== 'string' || feature?.geometry.type !== 'Point') {
        if (this.activePhotoPreviewKey !== null) this.clearPhotoPreview();
        return;
      }
      const coordinates = feature.geometry.coordinates as [number, number];
      if (this.activePhotoPreviewKey !== path || !this.photoPreviewElement) {
        this.showPhotoPreview(path, fileName, coordinates);
      } else {
        this.activePhotoPreviewCoordinates = coordinates;
        this.updatePhotoPreviewPosition();
      }
    });
    this.map.on('mouseout', () => this.clearPhotoPreview());
    this.map.on('mouseenter', 'photo-clusters', () => { this.map.getCanvas().style.cursor = 'pointer'; });
    this.map.on('mouseleave', 'photo-clusters', () => { this.map.getCanvas().style.cursor = ''; });
    this.map.on('mouseenter', 'photo-unclustered', () => { this.map.getCanvas().style.cursor = 'pointer'; });
    this.map.on('mouseleave', 'photo-unclustered', () => { this.map.getCanvas().style.cursor = ''; });
  }

  private logVectorSourceDiagnostics(): void {
    // This diagnostic inspects Shortbread MVT features only. Atlas and the
    // legacy OsmAnd renderer use raster sources, while OpenMapTiles uses a
    // different vector-layer schema; neither should be reported as an empty
    // Shortbread source.
    if (this.vectorSourceDiagnosticLogged || this.schema !== 'shortbread') return;
    const shortbreadSource = this.map.getStyle().sources?.['shortbread'];
    if (!shortbreadSource || shortbreadSource.type !== 'vector') return;
    this.vectorSourceDiagnosticLogged = true;
    const sourceLayers = [
      'land', 'ocean', 'water_polygons', 'water_lines', 'boundaries',
      'streets', 'buildings', 'pois', 'place_labels', 'street_labels'
    ];
    const counts = sourceLayers.map(sourceLayer => ({
      layer: sourceLayer,
      count: this.map.querySourceFeatures('shortbread', { sourceLayer }).length
    }));
    console.info('[OfflineMap] Vector source feature counts:', counts);
    if (counts.every(item => item.count === 0)) {
      const message = 'Offline tiles are being retrieved, but MapLibre exposes no vector features from the Shortbread source. Check the MBTiles tile contents and vector-layer metadata.';
      console.error('[OfflineMap]', message);
      this.onError?.(message);
    }
  }

  private refreshClusterLabels(): void {
    if (!this.map.getLayer('photo-clusters')) return;
    if (!this.photoClustersVisible || this.photoOpacity <= 0) {
      for (const marker of this.clusterLabels.values()) marker.element.remove();
      this.clusterLabels.clear();
      return;
    }
    const visible = new Set<number>();
    // Keep the hit-test geometry at the real cluster radius. Its paint opacity
    // is almost zero, while the visible artwork is drawn in our geographic
    // overlay. A 1.5px hit circle was too small and could disappear from
    // queryRenderedFeatures() at ordinary map scales.
    const features = this.map.queryRenderedFeatures({ layers: ['photo-clusters'] });
    for (const feature of features) {
      if (feature.geometry.type !== 'Point') continue;
      const count = feature.properties?.['point_count'];
      const clusterId = feature.properties?.['cluster_id'];
      if (typeof count !== 'number' || typeof clusterId !== 'number') continue;
      const coordinates = feature.geometry.coordinates as [number, number];
      visible.add(clusterId);
      let marker = this.clusterLabels.get(clusterId);
      if (!marker) {
        const element = document.createElement('span');
        element.style.cssText = 'display:block;width:56px;height:56px;pointer-events:none;position:absolute;left:0;top:0;transform:translate(-50%,-50%);z-index:10000;filter:drop-shadow(0 1px 3px #0009);';
        marker = { element, coordinates };
        this.overlayElement.appendChild(element);
        this.clusterLabels.set(clusterId, marker);
      }
      marker.coordinates = coordinates;
      const fill = this.photoClusterColor === 'dynamic'
        ? count < 10 ? '#34c759' : count < 100 ? '#ffd60a' : '#ff3b30'
        : this.photoClusterColor;
      const shapeMarkup = this.photoClusterShape === 'double-circle'
        ? `<circle cx="28" cy="28" r="25" fill="${fill}" stroke="#fff" stroke-width="2.5"/><circle cx="28" cy="28" r="18" fill="none" stroke="#fff" stroke-width="1.5" opacity=".9"/>`
        : this.photoClusterShape === 'hexagon'
          ? `<polygon points="28,2 51,15 51,41 28,54 5,41 5,15" fill="${fill}" stroke="#fff" stroke-width="2.5"/>`
          : this.photoClusterShape === 'circle'
            ? `<circle cx="28" cy="28" r="25" fill="${fill}" stroke="#fff" stroke-width="2.5"/>`
            : `<rect x="3" y="3" width="50" height="50" rx="3" fill="${fill}" stroke="#fff" stroke-width="2.5"/>`;
      marker.element.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 56 56"><g opacity="${this.photoOpacity}">${shapeMarkup}<text x="28" y="33" text-anchor="middle" font-family="Segoe UI,Arial,sans-serif" font-size="${count < 100 ? 15 : 14}" font-weight="700" fill="#fff" stroke="#222" stroke-width=".6" paint-order="stroke">${count}</text></g></svg>`;
    }
    for (const [clusterId, marker] of this.clusterLabels) {
      if (visible.has(clusterId)) continue;
      marker.element.remove();
      this.clusterLabels.delete(clusterId);
    }
    this.updateOverlayPositions();
  }

  private refreshTextLabels(): void {
    const visible = new Set<string>();
    const labelSources = this.schema === 'openmaptiles'
      ? [
        { layerId: 'omt-label-places-anchor', sourceLayer: 'place', kind: 'place' },
        { layerId: 'omt-label-boundaries-anchor', sourceLayer: 'boundary', kind: 'boundary' },
        { layerId: 'omt-label-water-anchor', sourceLayer: 'water_name', kind: 'water' },
        { layerId: 'omt-label-streets-anchor', sourceLayer: 'transportation_name', kind: 'street' },
        { layerId: 'omt-label-pois-anchor', sourceLayer: 'poi', kind: 'poi' }
      ]
      : [
        { layerId: 'label-places-anchor', sourceLayer: 'place_labels', kind: 'place' },
        { layerId: 'label-boundaries-anchor', sourceLayer: 'boundary_labels', kind: 'boundary' },
        { layerId: 'label-water-polygons-anchor', sourceLayer: 'water_polygons_labels', kind: 'water' },
        { layerId: 'label-street-polygons-anchor', sourceLayer: 'streets_polygons_labels', kind: 'street' },
        { layerId: 'label-street-points-anchor', sourceLayer: 'street_labels_points', kind: 'street' },
        { layerId: 'label-public-transport-anchor', sourceLayer: 'public_transport', kind: 'poi' },
        { layerId: 'label-pois-anchor', sourceLayer: 'pois', kind: 'poi' }
      ];
    // OsmAnd OBF and Atlas styles are rendered by the native renderer and
    // may expose no MapLibre label-anchor layers at all. Query only layers
    // that are actually part of the active style; passing a missing layer ID
    // to queryRenderedFeatures throws and can abort tile/overlay refreshes.
    const activeLabelSources = labelSources.filter(source => this.map.getLayer(source.layerId));
    const candidates: Array<{ key: string; x: number; y: number; longitude: number; latitude: number; text: string; kind: string; priority: number }> = [];

    for (const source of activeLabelSources) {
      // Rendered features expose geographic coordinates. Raw source features can
      // retain vector-tile coordinates, which must not be passed to project()/Marker.
      const features = this.map.queryRenderedFeatures({ layers: [source.layerId] });
      for (const feature of features) {
        const properties = feature.properties ?? {};
        const text = String(properties['name:de'] || properties['name_de'] || properties['name'] || properties['name:latin'] || properties['name_int'] || properties['name:en'] || properties['name_en'] || '').trim();
        if (!text) continue;

        const geometry = feature.geometry as unknown as { type: string; coordinates: unknown };
        let point: [number, number] | null = null;
        if (geometry.type === 'Point' && Array.isArray(geometry.coordinates)) {
          point = geometry.coordinates as [number, number];
        } else if (geometry.type === 'LineString' && Array.isArray(geometry.coordinates)) {
          point = this.getLineMidpoint(geometry.coordinates as [number, number][]);
        } else if (geometry.type === 'MultiLineString' && Array.isArray(geometry.coordinates)) {
          const lines = geometry.coordinates as [number, number][][];
          const longest = lines.reduce((best, line) => this.getProjectedLineLength(line) > this.getProjectedLineLength(best) ? line : best, []);
          point = this.getLineMidpoint(longest);
        }
        if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])
          || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) continue;

        const screenPoint = this.map.project(point);
        const width = this.map.getContainer().clientWidth;
        const height = this.map.getContainer().clientHeight;
        if (!Number.isFinite(screenPoint.x) || !Number.isFinite(screenPoint.y)
          || screenPoint.x < -260 || screenPoint.y < -30
          || screenPoint.x > width + 260 || screenPoint.y > height + 30) continue;

        const placeKind = String(properties['kind'] ?? source.kind);
        const priority = source.kind === 'place' ? 0 : source.kind === 'boundary' ? 1 : source.kind === 'water' ? 2 : source.kind === 'street' ? 3 : 4;
        const rawCoordinates = geometry.coordinates as unknown;
        const firstCoordinate = geometry.type === 'Point'
          ? rawCoordinates as [number, number]
          : geometry.type === 'MultiLineString'
            ? (rawCoordinates as [number, number][][])[0]?.[0]
            : (rawCoordinates as [number, number][])[0];
        // Vector-tile line features may be split into different fragments at
        // tile boundaries. Prefer the stable source feature ID over fragment
        // coordinates so the same road/river keeps one label identity.
        const featureId = feature.id;
        const key = source.sourceLayer + ':' + text + ':'
          + (featureId !== undefined ? 'id:' + String(featureId) + ':' : '')
          + (firstCoordinate?.[0]?.toFixed(5) ?? point[0].toFixed(5)) + ':'
          + (firstCoordinate?.[1]?.toFixed(5) ?? point[1].toFixed(5));
        candidates.push({ key, x: screenPoint.x, y: screenPoint.y, longitude: point[0], latitude: point[1], text, kind: placeKind, priority });
      }
    }

    candidates.sort((a, b) => a.priority - b.priority);
    const occupied: Array<[number, number, number, number]> = [];
    const seen = new Set<string>();
    const width = this.map.getContainer().clientWidth;
    const height = this.map.getContainer().clientHeight;

    for (const candidate of candidates) {
      const zoom = this.map.getZoom();
      const maxLabels = zoom < 8 ? 18 : zoom < 10 ? 28 : zoom < 12 ? 42 : zoom < 14 ? 60 : zoom < 16 ? 90 : 130;
      if (visible.size >= maxLabels) break;
      const { key, x, y, longitude, latitude, text, kind } = candidate;
      if (x < 0 || y < 0 || x > width || y > height) continue;
      const dedupeKey = `${kind}:${text}:${Math.round(x / 24)}:${Math.round(y / 24)}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const fontSize = kind === 'capital' ? 18 : kind === 'state_capital' ? 17 : kind === 'city' ? 17 : kind === 'town' ? 15 : kind === 'village' ? 14 : kind === 'street' ? 12 : kind === 'water' ? 13 : kind === 'boundary' ? 14 : kind === 'poi' ? 11 : 13;
      const labelWidth = Math.min(260, Math.max(24, text.length * fontSize * 0.56 + 8));
      const labelHeight = fontSize + 7;
      const box: [number, number, number, number] = [x - labelWidth / 2, y - labelHeight / 2, x + labelWidth / 2, y + labelHeight / 2];
      if (occupied.some(other => box[0] < other[2] + 4 && box[2] > other[0] - 4 && box[1] < other[3] + 3 && box[3] > other[1] - 3)) continue;
      occupied.push(box);
      visible.add(key);
      const existingLabel = this.textLabels.get(key);
      if (existingLabel) {
        existingLabel.element.textContent = text;
        continue;
      }
      const element = document.createElement('span');
      element.textContent = text;
      const darkStyle = this.styleName === 'versatiles-neutrino';
      const color = darkStyle ? (kind === 'water' ? '#9bcde4' : kind === 'boundary' ? '#c0a8d0' : '#f0f1f2')
        : kind === 'street' ? '#625d55' : kind === 'water' ? '#397b9a' : kind === 'boundary' ? '#806b83' : kind === 'poi' ? '#73583d' : '#393832';
      const halo = darkStyle ? '#202b36' : '#f1efe8';
      const weight = kind === 'capital' || kind === 'state_capital' || kind === 'city' ? 700 : kind === 'town' ? 600 : 500;
      const style = kind === 'water' ? 'italic' : 'normal';
      element.style.cssText = `display:block;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${color};font:${style} ${weight} ${fontSize}px/1.2 Segoe UI,Arial,sans-serif;text-shadow:-1px -1px 0 ${halo},1px -1px 0 ${halo},-1px 1px 0 ${halo},1px 1px 0 ${halo},0 0 3px ${halo};pointer-events:none;text-align:center;opacity:${this.textLabelOpacity};transition:opacity .12s ease;`;
      element.style.position = 'absolute';
      element.style.left = '0';
      element.style.top = '0';
      element.style.transform = 'translate(-50%, -50%)';
      const coordinates: [number, number] = [longitude, latitude];
      this.overlayElement.appendChild(element);
      this.textLabels.set(key, { element, coordinates });
    }
    for (const [key, marker] of this.textLabels) {
      if (visible.has(key)) continue;
      // This refresh runs on MapLibre 'idle': visible tiles and label queries
      // are settled. Remove labels no longer selected at the current zoom so
      // zooming out cannot accumulate stale labels from earlier zoom levels.
      marker.element.remove();
      this.textLabels.delete(key);
    }
    if (!this.labelSourceDiagnosticLogged) {
      this.labelSourceDiagnosticLogged = true;
      console.info('[OfflineMap] Rendered label features:', activeLabelSources.map(source => ({
        layer: source.sourceLayer,
        count: this.map.queryRenderedFeatures({ layers: [source.layerId] }).length
      })));
    }
  }

  private getProjectedLineLength(coordinates: [number, number][]): number {
    if (coordinates.length < 2) return 0;
    let length = 0;
    let previous = this.map.project(coordinates[0]);
    for (let i = 1; i < coordinates.length; i++) {
      const current = this.map.project(coordinates[i]);
      length += Math.hypot(current.x - previous.x, current.y - previous.y);
      previous = current;
    }
    return length;
  }

  private getLineMidpoint(coordinates: [number, number][]): [number, number] | null {
    if (coordinates.length < 2) return coordinates[0] ?? null;
    const projected = coordinates.map(coordinate => this.map.project(coordinate));
    const segmentLengths: number[] = [];
    let totalLength = 0;
    for (let i = 1; i < projected.length; i++) {
      const length = Math.hypot(projected[i].x - projected[i - 1].x, projected[i].y - projected[i - 1].y);
      segmentLengths.push(length);
      totalLength += length;
    }
    if (!Number.isFinite(totalLength) || totalLength <= 0) return coordinates[0];

    let remaining = totalLength / 2;
    for (let i = 0; i < segmentLengths.length; i++) {
      const length = segmentLengths[i];
      if (remaining <= length || i === segmentLengths.length - 1) {
        const ratio = length > 0 ? Math.min(1, remaining / length) : 0;
        const start = coordinates[i];
        const end = coordinates[i + 1];
        return [
          start[0] + (end[0] - start[0]) * ratio,
          start[1] + (end[1] - start[1]) * ratio
        ];
      }
      remaining -= length;
    }
    return coordinates[coordinates.length - 1];
  }

  private showPhotoPreview(path: string, fileName: string, coordinates: [number, number]): void {
    this.clearPhotoPreview();
    const preview = document.createElement('div');
    preview.className = 'folder-marker-tooltip offline-photo-marker-preview';
    preview.innerHTML = buildPhotoMarkerPreviewHtml(path, fileName);
    preview.style.cssText = [
      'position:absolute',
      'z-index:10001',
      'pointer-events:none',
      'padding:5px 7px',
      'background:var(--color-surface-default-high,#303238)',
      'border:1px solid #777',
      'border-radius:6px',
      'color:var(--color-content-default-high,#fff)',
      'box-shadow:0 3px 12px #0008',
      'transform:translate(-50%,calc(-100% - 14px))',
      'width:max-content'
    ].join(';');
    this.photoPreviewElement = preview;
    this.activePhotoPreviewKey = path;
    this.activePhotoPreviewCoordinates = coordinates;
    this.overlayElement.appendChild(preview);
    this.updatePhotoPreviewPosition();
  }

  private updatePhotoPreviewPosition(): void {
    if (!this.photoPreviewElement || !this.activePhotoPreviewCoordinates) return;
    const point = this.map.project(this.activePhotoPreviewCoordinates);
    this.photoPreviewElement.style.left = `${point.x}px`;
    this.photoPreviewElement.style.top = `${point.y}px`;
  }

  private clearPhotoPreview(): void {
    this.photoPreviewElement?.remove();
    this.photoPreviewElement = null;
    this.activePhotoPreviewKey = null;
    this.activePhotoPreviewCoordinates = null;
  }

  private readonly updateOverlayPositions = (): void => {
    if (this.currentMarkerElement && this.currentLocation) {
      const point = this.map.project(this.currentLocation);
      this.currentMarkerElement.style.left = `${point.x}px`;
      this.currentMarkerElement.style.top = `${point.y}px`;
    }
    for (const label of this.textLabels.values()) {
      const point = this.map.project(label.coordinates);
      label.element.style.left = `${point.x}px`;
      label.element.style.top = `${point.y}px`;
    }
    for (const marker of this.clusterLabels.values()) {
      const point = this.map.project(marker.coordinates);
      marker.element.style.left = `${point.x}px`;
      marker.element.style.top = `${point.y}px`;
    }
    this.updatePhotoPreviewPosition();
    this.updateOsmAndTileStatusPositions();
  };

  private updateOsmAndTileStatusPositions(): void {
    if (!this.tileVisualsEnabled || !this.tileProtocol || !this.tileStatusLayer) return;
    for (const [key, status] of this.tileStatuses) {
      let element = this.tileStatusElements.get(key);
      if (!element) {
        element = document.createElement('div');
        element.style.cssText = 'position:absolute;display:flex;align-items:center;justify-content:center;box-sizing:border-box;border:1px solid rgba(255,255,255,.78);background:rgba(12,20,28,.20);';
        const label = document.createElement('div');
        label.style.cssText = 'display:flex;align-items:center;gap:8px;box-sizing:border-box;max-width:calc(100% - 16px);max-height:calc(100% - 16px);padding:7px 11px;border:1px solid rgba(255,255,255,.28);border-radius:5px;background:rgba(20,27,34,.90);color:#fff;font:600 12px/1.3 system-ui,sans-serif;text-align:left;box-shadow:0 2px 8px rgba(0,0,0,.28);overflow:auto;';
        const spinner = document.createElement('span');
        spinner.style.cssText = 'width:13px;height:13px;flex:0 0 13px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:osmand-tile-spin .8s linear infinite;';
        const message = document.createElement('span');
        label.append(spinner, message);
        element.appendChild(label);
        this.tileStatusLayer.appendChild(element);
        this.tileStatusElements.set(key, element);
      }
      const count = 2 ** status.zoom;
      const west = status.column / count * 360 - 180;
      const east = (status.column + 1) / count * 360 - 180;
      const latitudeAt = (y: number): number => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / count))) * 180 / Math.PI;
      const north = latitudeAt(status.row);
      const south = latitudeAt(status.row + 1);
      const topLeft = this.map.project([west, north]);
      const bottomRight = this.map.project([east, south]);
      element.style.left = `${topLeft.x}px`;
      element.style.top = `${topLeft.y}px`;
      element.style.width = `${Math.max(0, bottomRight.x - topLeft.x)}px`;
      element.style.height = `${Math.max(0, bottomRight.y - topLeft.y)}px`;
      // Native rendering must be clearly visible while a tile is pending.
      // Only cache hits use the subdued overlay; normal loading previously
      // used 20% opacity and was easy to mistake for no rendering indicator.
      element.style.opacity = status.status === 'cache-loading' ? '0.2' : '1';
      const label = element.firstElementChild as HTMLDivElement;
      const spinner = label.firstElementChild as HTMLSpanElement;
      const message = label.lastElementChild as HTMLSpanElement;
      if (status.status === 'error' || status.status === 'warning') {
        spinner.style.display = 'none';
        const warning = status.status === 'warning';
        label.style.borderColor = warning ? 'rgba(255,205,90,.9)' : 'rgba(255,125,110,.8)';
        label.style.background = warning ? 'rgba(92,66,18,.94)' : 'rgba(92,24,20,.94)';
        message.style.cssText = 'min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;';
        message.textContent = warning
          ? 'World_basemap.obf needed'
          : 'Tile rendering failed:\n' + (status.error || 'Unknown rendering error');
        label.title = status.error ?? (warning ? 'World overview map data is missing.' : 'Unknown rendering error');
      } else {
        spinner.style.display = '';
        label.style.borderColor = 'rgba(255,255,255,.28)';
        label.style.background = 'rgba(20,27,34,.90)';
        message.textContent = status.status === 'rerendering'
          ? 'Rerendering tile …'
          : status.status === 'cache-loading' ? 'Loading cached tile …' : 'Loading tile …';
        label.title = status.status === 'rerendering'
          ? 'Forcing a fresh native render for this visible tile'
          : status.status === 'cache-loading' ? 'Loading cached OsmAnd tile' : 'Loading tile data';
      }
    }
  }

  setCurrentLocation(latitude: number, longitude: number, color: string, opacity: number, shape: 'pin' | 'circle' | 'square' | 'diamond' = 'pin'): void {
    const element = document.createElement('div');
    element.className = 'offline-current-location-marker';
    const shapeMarkup = shape === 'pin'
      ? `<path d="M24 2C12.4 2 4 10.5 4 21c0 14 20 35 20 35s20-21 20-35C44 10.5 35.6 2 24 2Z" fill="${color}" stroke="#fff" stroke-width="3"/><circle cx="24" cy="21" r="7.5" fill="#fff" stroke="#222" stroke-width="1.5"/>`
      : shape === 'circle'
        ? `<circle cx="20" cy="20" r="16" fill="${color}" stroke="#fff" stroke-width="3"/><circle cx="20" cy="20" r="6" fill="#fff" stroke="#222" stroke-width="1.5"/>`
        : shape === 'square'
          ? `<rect x="4" y="4" width="32" height="32" rx="3" fill="${color}" stroke="#fff" stroke-width="3"/><circle cx="20" cy="20" r="6" fill="#fff" stroke="#222" stroke-width="1.5"/>`
          : `<polygon points="20,2 38,20 20,38 2,20" fill="${color}" stroke="#fff" stroke-width="3"/><circle cx="20" cy="20" r="6" fill="#fff" stroke="#222" stroke-width="1.5"/>`;
    const width = shape === 'pin' ? 36 : 36;
    const height = shape === 'pin' ? 44 : 36;
    element.style.cssText = `width:${width}px;height:${height}px;display:block;pointer-events:none;filter:drop-shadow(0 1px 3px #000b);opacity:${opacity};`;
    element.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${shape === 'pin' ? '0 0 48 58' : '0 0 40 40'}" style="display:block;overflow:visible">${shapeMarkup}</svg>`;
    if (this.currentMarkerElement) this.currentMarkerElement.remove();
    element.style.position = 'absolute';
    element.style.left = '0';
    element.style.top = '0';
    element.style.transform = shape === 'pin' ? 'translate(-50%, -100%)' : 'translate(-50%, -50%)';
    element.style.zIndex = '10000';
    this.currentMarkerElement = element;
    this.currentLocation = [longitude, latitude];
    this.overlayElement.appendChild(element);
    this.updateOverlayPositions();
  }

  updateCurrentLocation(latitude: number, longitude: number): void {
    this.currentLocation = [longitude, latitude];
    this.updateOverlayPositions();
  }

  setCurrentOpacity(opacity: number): void {
    if (this.currentMarkerElement) this.currentMarkerElement.style.opacity = String(opacity);
  }

  setPhotoMarkers(markers: OfflinePhotoMarker[], onSelected: (path: string) => void, opacity: number): void {
    this.onPhotoSelected = onSelected;
    const source = this.map.getSource('photo-markers') as import('maplibre-gl').GeoJSONSource | undefined;
    if (!source) return;
    this.clearPhotoPreview();
    source.setData({
      type: 'FeatureCollection',
      features: markers.map(marker => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [marker.longitude, marker.latitude] },
        properties: { path: marker.path, fileName: marker.fileName }
      }))
    });
    this.photoOpacity = opacity;
    this.map.setPaintProperty('photo-unclustered', 'circle-opacity', opacity);
    this.map.setPaintProperty('photo-unclustered', 'circle-stroke-opacity', opacity);
    // Cluster circles are replaced by SVG DOM markers; keep the native
    // MapLibre circles hidden when the marker opacity changes.
    // Keep a one-pixel, near-transparent hit layer so queryRenderedFeatures()
    // can still return cluster points while the full-size SVG markers sit above it.
    this.map.setPaintProperty('photo-clusters', 'circle-opacity', 0.01);
    this.map.setPaintProperty('photo-clusters', 'circle-radius', ['step', ['get', 'point_count'], 19, 10, 23, 100, 27]);
    this.map.setPaintProperty('photo-clusters', 'circle-stroke-opacity', 0);
    this.map.setPaintProperty('photo-clusters', 'circle-stroke-width', 0);
    this.refreshClusterLabels();
  }

  setScaleVisible(visible: boolean): void {
    const scale = this.map.getContainer().querySelector<HTMLElement>('.maplibregl-ctrl-scale');
    if (scale) scale.style.display = visible ? '' : 'none';
  }

  setTextLabelOpacity(opacity: number): void {
    this.textLabelOpacity = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1;
    for (const label of this.textLabels.values()) {
      label.element.style.opacity = String(this.textLabelOpacity);
    }
  }

  setHillshadeDatabases(databases: OsmAndHillshadeDatabase[]): void {
    this.hillshadeDatabases = databases.slice();
    this.syncHillshadeLayers();
  }

  setHillshadeVisibility(visible: boolean): void {
    this.hillshadeVisible = visible;
    if (!this.map.isStyleLoaded()) return;
    for (const layer of this.map.getStyle().layers) {
      if (layer.id === 'osmand-hillshade-raster' || layer.id.startsWith('osmand-hillshade-raster-')) {
        this.map.setLayoutProperty(layer.id, 'visibility', visible ? 'visible' : 'none');
      }
    }
  }

  setHillshadeOpacity(opacity: number): void {
    this.hillshadeOpacity = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 0.65;
    if (!this.map.isStyleLoaded()) return;
    for (const layer of this.map.getStyle().layers) {
      if (layer.id === 'osmand-hillshade-raster' || layer.id.startsWith('osmand-hillshade-raster-')) {
        this.map.setPaintProperty(layer.id, 'raster-opacity', this.hillshadeOpacity);
      }
    }
  }

  refreshHillshadeTiles(): void {
    if (!this.map.isStyleLoaded()) return;
    const refresh = Date.now();
    const sourceId = Object.keys(this.map.getStyle().sources).find(id => id.startsWith('osmand-hillshade-source-'));
    const source = sourceId
      ? this.map.getSource(sourceId) as { setTiles?: (tiles: string[]) => unknown } | undefined
      : undefined;
    source?.setTiles?.(['osmand-hillshade://combined/{z}/{x}/{y}?refresh=' + refresh]);
  }

  private syncHillshadeLayers(): void {
    if (!this.map.isStyleLoaded()) return;
    const style = this.map.getStyle();
    for (const layer of style.layers.filter(item => item.id.startsWith('osmand-hillshade-raster-'))) {
      this.map.removeLayer(layer.id);
    }
    for (const sourceId of Object.keys(style.sources).filter(id => id.startsWith('osmand-hillshade-source-'))) {
      this.map.removeSource(sourceId);
    }
    const beforeLayer = this.map.getStyle().layers.find(layer =>
      /road|street|building|poi|label|symbol|boundary|rail|bridge|transport/i.test(layer.id)
    )?.id;
    if (this.hillshadeDatabases.some(database => database.enabled && database.available)) {
      // Use a new MapLibre source identity for every database selection change.
      // A new URL alone is insufficient if MapLibre keeps the old SourceCache
      // when a source is removed and re-added under the same ID.
      const revision = ++this.hillshadeSourceRevision;
      const sourceId = 'osmand-hillshade-source-' + revision;
      const layerId = 'osmand-hillshade-raster-' + revision;
      this.map.addSource(sourceId, {
        type: 'raster',
        tiles: ['osmand-hillshade://combined/{z}/{x}/{y}?refresh=' + Date.now()],
        tileSize: 256,
        minzoom: 1,
        maxzoom: 12,
        attribution: '© OpenStreetMap contributors'
      });
      this.map.addLayer({
        id: layerId,
        type: 'raster',
        source: sourceId,
        layout: { visibility: this.hillshadeVisible ? 'visible' : 'none' },
        paint: { 'raster-fade-duration': 0, 'raster-opacity': this.hillshadeOpacity }
      }, beforeLayer);
    }
    this.map.triggerRepaint();
  }

  private readonly basemapOpacityDefaults = new Map<string, unknown>();
  private basemapOpacity = 1;

  setBasemapOpacity(opacity: number): void {
    const value = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1;
    this.basemapOpacity = value;
    if (!this.map.isStyleLoaded()) return;

    // Apply concrete numeric paint values. MapLibre raster-opacity is not
    // expression-capable, so expressions such as ['*', 1, value] can make
    // the basemap layer fail to render. Preserve numeric style defaults and
    // use the requested value for properties whose default is implicit.
    for (const layer of this.map.getStyle().layers) {
      if (layer.id === 'osmand-hillshade-raster' || layer.id.startsWith('osmand-hillshade-raster-')
        || (('source' in layer) && (layer.source === 'photo-markers' || layer.source === 'gpx-track'
          || layer.source === 'osmand-hillshade' || String(layer.source).startsWith('osmand-hillshade-')))) continue;

      const paint = 'paint' in layer && layer.paint ? layer.paint as Record<string, unknown> : {};
      const typeDefaults: Record<string, string[]> = {
        background: ['background-opacity'],
        fill: ['fill-opacity'],
        line: ['line-opacity'],
        circle: ['circle-opacity', 'circle-stroke-opacity'],
        raster: ['raster-opacity'],
        symbol: ['icon-opacity', 'text-opacity'],
        'fill-extrusion': ['fill-extrusion-opacity'],
        heatmap: ['heatmap-opacity']
      };
      const properties = new Set([
        ...(typeDefaults[layer.type] ?? []),
        ...Object.keys(paint).filter(key => key.endsWith('-opacity'))
      ]);

      for (const property of properties) {
        const paintProperty = property as Parameters<MapLibreMap['getPaintProperty']>[1];
        const key = layer.id + ':' + property;
        if (!this.basemapOpacityDefaults.has(key)) {
          this.basemapOpacityDefaults.set(key, this.map.getPaintProperty(layer.id, paintProperty));
        }
        const original = this.basemapOpacityDefaults.get(key);
        const scaled = typeof original === 'number' ? original * value : value;
        try {
          this.map.setPaintProperty(layer.id, paintProperty, scaled);
        } catch (error) {
          console.warn('[Map opacity] Could not update paint property:', layer.id, property, error);
        }
      }
    }
  }

  setPhotoClusterStyle(color: string, visible: boolean, shape: 'double-circle' | 'hexagon' | 'circle' | 'square' = this.photoClusterShape): void {
    this.photoClustersVisible = visible;
    this.photoClusterColor = color;
    this.photoClusterShape = shape;
    if (!this.map.getLayer('photo-clusters')) return;
    // Cluster artwork is rendered as SVG DOM markers so all four shapes remain
    // crisp at every zoom level and match the online cluster icon geometry.
    // Keep a one-pixel, near-transparent hit layer so queryRenderedFeatures()
    // can still return cluster points while the full-size SVG markers sit above it.
    this.map.setPaintProperty('photo-clusters', 'circle-opacity', 0.01);
    this.map.setPaintProperty('photo-clusters', 'circle-radius', 1.5);
    this.map.setPaintProperty('photo-clusters', 'circle-stroke-opacity', 0);
    this.map.setPaintProperty('photo-clusters', 'circle-stroke-width', 0);
    if (!visible) {
      for (const marker of this.clusterLabels.values()) marker.element.remove();
      this.clusterLabels.clear();
    } else {
      this.refreshClusterLabels();
    }
  }

  setPhotoOpacity(opacity: number): void {
    this.photoOpacity = opacity;
    if (!this.map.getLayer('photo-unclustered')) return;
    this.map.setPaintProperty('photo-unclustered', 'circle-opacity', opacity);
    this.map.setPaintProperty('photo-unclustered', 'circle-stroke-opacity', opacity);
    // Cluster circles are replaced by SVG DOM markers; keep the native
    // MapLibre circles hidden when the marker opacity changes.
    // Keep a one-pixel, near-transparent hit layer so queryRenderedFeatures()
    // can still return cluster points while the full-size SVG markers sit above it.
    this.map.setPaintProperty('photo-clusters', 'circle-opacity', 0.01);
    this.map.setPaintProperty('photo-clusters', 'circle-radius', 1.5);
    this.map.setPaintProperty('photo-clusters', 'circle-stroke-opacity', 0);
    this.map.setPaintProperty('photo-clusters', 'circle-stroke-width', 0);
    if (opacity <= 0) {
      for (const marker of this.clusterLabels.values()) marker.element.remove();
      this.clusterLabels.clear();
    } else {
      this.refreshClusterLabels();
    }
  }

  setTrackHoverHandler(handler: ((path: string, latitude: number, longitude: number) => void) | null): void { this.trackHoverHandler = handler; }

  setTrack(tracks: Array<{ path: string; segments: [number, number][][]; color: string; lineStyle: 'solid' | 'dashed' | 'dotted' | 'long-dashed' | 'short-dashed' | 'dash-dot' | 'dash-dot-dot'; lineWidth: number; showDirection?: boolean; directionStyle?: string }>, opacity: number): void {
    const source = this.map.getSource('gpx-track') as import('maplibre-gl').GeoJSONSource | undefined;
    if (!source) return;
    source.setData({
      type: 'FeatureCollection',
      features: tracks.flatMap(track => track.segments.filter(segment => segment.length >= 2).map(segment => ({
        type: 'Feature' as const,
        geometry: { type: 'LineString' as const, coordinates: segment.map(([latitude, longitude]) => [longitude, latitude]) },
        properties: { path: track.path, color: track.color, lineStyle: track.lineStyle, width: track.lineWidth, showDirection: track.showDirection === true, directionStyle: track.directionStyle || 'classic' }
      })))
    });
    for (const layerId of ['gpx-track-line', 'gpx-track-line-dashed', 'gpx-track-line-dotted', 'gpx-track-line-long-dashed', 'gpx-track-line-short-dashed', 'gpx-track-line-dash-dot', 'gpx-track-line-dash-dot-dot']) {
      this.map.setPaintProperty(layerId, 'line-opacity', opacity);
    }
    this.map.setPaintProperty('gpx-track-direction-arrows', 'text-opacity', opacity);
  }

  refreshVisibleTiles(): void {
    if (this.tileProtocol !== 'osmand' && this.tileProtocol !== 'osmand-atlas') {
      throw new Error('Visible tile refresh is only available for OsmAnd renderers.');
    }
    const sourceId = this.tileProtocol;
    const source = this.map.getSource(sourceId) as { setTiles?: (tiles: string[]) => unknown } | undefined;
    if (!source?.setTiles) {
      throw new Error(`The ${sourceId} raster source is unavailable for refresh.`);
    }
    // A unique URL identity makes MapLibre request the viewport again while
    // the native OsmAnd protocol continues to serve tiles from its disk cache.
    const refresh = Date.now();
    source.setTiles([`${sourceId}://{z}/{x}/{y}?refresh=${refresh}`]);
    this.map.triggerRepaint();
    console.info(`[${sourceId}] Refreshed visible tiles from the existing disk cache`, {
      zoom: this.map.getZoom(),
      refresh
    });
  }

  async rerenderVisibleTiles(
    renderOsmAndTile: (z: number, x: number, y: number, forceRender: boolean) => Promise<unknown>,
    renderAtlasTile: (z: number, x: number, y: number, displayScale: number, forceRender: boolean) => Promise<unknown>,
    displayScale: number,
    onProgress?: (completed: number, total: number) => void
  ): Promise<number> {
    if (this.tileProtocol !== 'osmand' && this.tileProtocol !== 'osmand-atlas') {
      throw new Error('Visible tile rerendering is only available for OsmAnd renderers.');
    }

    // MapLibre raster sources use the integer zoom level below the current
    // fractional camera zoom. Calculate the complete viewport coverage in XYZ.
    const zoom = Math.max(2, Math.min(this.tileProtocol === 'osmand-atlas' ? 21 : 18,
      Math.floor(this.map.getZoom())));
    const tileCount = 2 ** zoom;
    const bounds = this.map.getBounds();
    const clampLatitude = (latitude: number): number =>
      Math.max(-85.05112878, Math.min(85.05112878, latitude));
    const xForLongitude = (longitude: number): number =>
      Math.max(0, Math.min(tileCount - 1, Math.floor((longitude + 180) / 360 * tileCount)));
    const yForLatitude = (latitude: number): number => {
      const radians = clampLatitude(latitude) * Math.PI / 180;
      const mercator = Math.asinh(Math.tan(radians));
      return Math.max(0, Math.min(tileCount - 1,
        Math.floor((1 - mercator / Math.PI) / 2 * tileCount)));
    };

    const minX = xForLongitude(bounds.getWest());
    const maxX = xForLongitude(bounds.getEast() - 1e-10);
    const minY = yForLatitude(bounds.getNorth());
    const maxY = yForLatitude(bounds.getSouth());
    const visibleTiles: Array<{ x: number; y: number }> = [];
    for (let y = Math.min(minY, maxY); y <= Math.max(minY, maxY); y++) {
      for (let x = Math.min(minX, maxX); x <= Math.max(minX, maxX); x++) {
        visibleTiles.push({ x, y });
      }
    }
    if (!visibleTiles.length) return 0;

    if (this.tileProtocol === 'osmand-atlas') {
      // One MapLibre tile maps to one 512px Atlas metatile.
      onProgress?.(0, visibleTiles.length);
      let completed = 0;
      const forcedResults = await Promise.all(visibleTiles.map(async ({ x, y }) => {
        const tileCoordinates = { protocol: 'osmand-atlas' as const, zoom, column: x, row: y };
        emitOsmAndTileStatus({ ...tileCoordinates, status: 'rerendering' });
        try {
          const result = await renderAtlasTile(zoom + 1, x * 2, y * 2, displayScale, true);
          emitOsmAndTileStatus({ ...tileCoordinates, status: 'loaded' });
          onProgress?.(++completed, visibleTiles.length);
          return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          emitOsmAndTileStatus({
            ...tileCoordinates,
            status: /\b(cancelled|canceled)\b/i.test(message) ? 'cancelled' : 'error',
            error: message
          });
          throw error;
        }
      }));
      console.info('[osmand-atlas] Forced render diagnostics', forcedResults.map((result, index) => {
        const tileResult = result as {
          diagnostics?: {
            helperPath?: string;
            geometryEnabled?: boolean;
            nativeRender?: boolean;
            forceRender?: boolean;
            geometryMessages?: string[];
          };
        };
        return {
          tile: visibleTiles[index],
          ...(tileResult?.diagnostics ?? { diagnosticsMissing: true })
        };
      }));
    } else {
      // One MapLibre tile is composed from four native 256px OsmAnd tiles.
      onProgress?.(0, visibleTiles.length);
      let completed = 0;
      await Promise.all(visibleTiles.map(async ({ x, y }) => {
        const tileCoordinates = { protocol: 'osmand' as const, zoom, column: x, row: y };
        emitOsmAndTileStatus({ ...tileCoordinates, status: 'rerendering' });
        try {
          const nativeX = x * 2;
          const nativeY = y * 2;
          await Promise.all([
            renderOsmAndTile(zoom + 1, nativeX, nativeY, true),
            renderOsmAndTile(zoom + 1, nativeX + 1, nativeY, true),
            renderOsmAndTile(zoom + 1, nativeX, nativeY + 1, true),
            renderOsmAndTile(zoom + 1, nativeX + 1, nativeY + 1, true)
          ]);
          emitOsmAndTileStatus({ ...tileCoordinates, status: 'loaded' });
          onProgress?.(++completed, visibleTiles.length);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          emitOsmAndTileStatus({
            ...tileCoordinates,
            status: /\b(cancelled|canceled)\b/i.test(message) ? 'cancelled' : 'error',
            error: message
          });
          throw error;
        }
      }));
    }

    const sourceId = this.tileProtocol === 'osmand-atlas' ? 'osmand-atlas' : 'osmand';
    const protocol = this.tileProtocol;
    const style = this.map.getStyle();
    const sourceSpec = style.sources[sourceId];
    const sourceLayers = style.layers.filter(layer => 'source' in layer && layer.source === sourceId);
    if (!sourceSpec || !('tiles' in sourceSpec) || sourceLayers.length === 0) {
      throw new Error(`The ${protocol} raster source or its style layer is unavailable after rerendering.`);
    }

    // Replacing only the URL template can leave MapLibre's existing tile
    // objects/textures attached to the source cache. Recreate the source and
    // its raster layer so every visible tile is requested and uploaded again.
    const sourceLayerIds = new Set(sourceLayers.map(layer => layer.id));
    const lastSourceLayerIndex = Math.max(...style.layers
      .map((layer, index) => sourceLayerIds.has(layer.id) ? index : -1));
    const beforeLayerId = style.layers.slice(lastSourceLayerIndex + 1)
      .find(layer => !sourceLayerIds.has(layer.id))?.id;

    for (const layer of [...sourceLayers].reverse()) {
      this.map.removeLayer(layer.id);
    }
    this.map.removeSource(sourceId);
    this.map.addSource(sourceId, {
      ...sourceSpec,
      tiles: [`${protocol}://{z}/{x}/{y}?refresh=${Date.now()}`]
    });
    for (const layer of sourceLayers) {
      this.map.addLayer(layer, beforeLayerId);
    }
    this.map.triggerRepaint();

    console.info(`[${protocol}] Rerendered visible tiles and recreated MapLibre source`, {
      zoom,
      count: visibleTiles.length,
      nativeTileCount: this.tileProtocol === 'osmand' ? visibleTiles.length * 4 : visibleTiles.length,
      displayScale: this.tileProtocol === 'osmand-atlas' ? displayScale : undefined
    });
    return visibleTiles.length;
  }

  resize(): void { this.map.resize(); }
  remove(): void {
    this.resizeObserver.disconnect();
    window.removeEventListener('lumascope-osmand-tile-status', this.onOsmAndTileStatus);
    window.removeEventListener('lumascope-osmand-tile-visuals', this.onTileVisualsChanged);
    this.map.off('sourcedataloading', this.onMapLibreTileLoading);
    this.map.off('sourcedata', this.onMapLibreTileLoaded);
    this.map.off('error', this.onMapLibreTileError);
    this.map.off('movestart', this.onMapMoveStart);
    this.map.off('zoomend', this.onMapZoomEnd);
    if (this.atlasZoomCheckTimer !== null) window.clearTimeout(this.atlasZoomCheckTimer);
    this.atlasZoomCheckTimer = null;
    this.tileStatuses.clear();
    this.tileStatusElements.clear();
    this.tileStatusLayer.remove();
    this.map.getContainer().removeEventListener('pointerdown', this.onDiagnosticPointerDown, true);
    window.removeEventListener('pointermove', this.onDiagnosticPointerMove, true);
    window.removeEventListener('pointerup', this.onDiagnosticPointerEnd, true);
    window.removeEventListener('pointercancel', this.onDiagnosticPointerEnd, true);
    this.map.off('move', this.onDiagnosticMapMove);
    this.map.off('dragstart', this.onDiagnosticMapDragStart);
    this.map.off('dragend', this.onDiagnosticMapDragEnd);
    this.map.off('render', this.updateOverlayPositions);
    this.clearPhotoPreview();
    this.currentMarkerElement?.remove();
    this.currentMarkerElement = null;
    this.currentLocation = null;
    for (const marker of this.clusterLabels.values()) marker.element.remove();
    this.clusterLabels.clear();
    for (const marker of this.textLabels.values()) marker.element.remove();
    this.textLabels.clear();
    this.overlayElement.remove();
    this.map.remove();
  }
}
