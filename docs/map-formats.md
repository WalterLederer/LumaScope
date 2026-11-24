# Supported map formats

[Back to README](../README.md)

The Help reference lists **5 map source types**.

## Fixing missing photo GPS coordinates

The Location tab's **Fix location** feature reuses whichever map source is currently selected, including online XYZ and all supported offline sources. It does not perform a separate source selection or fallback. Enable **Allow fixing**, pan the map so the fixed centre crosshair marks the desired position, and use **Save GPS position...** to write the selected coordinates into the image file's GPS EXIF metadata. The current map-source setting is left unchanged.

| Format / source | Extension / source | Online | Renderer | Details |
| --- | --- | --- | --- | --- |
| Online map (XYZ tiles) | URL / XYZ tile endpoint | Yes | Leaflet (map window) | Online raster tiles loaded from tile-server URLs; requires an internet connection. |
| MBTiles | `.mbtiles` | No | LumaScope / MapLibre | Offline raster or vector tile database. |
| OsmAnd | `.obf` | No | OsmAnd native renderer | Offline vector map data; labels depend on the selected OsmAnd renderer and its resources/style. |
| Mapsforge | `.map` | No | Mapsforge 0.25.0 | Offline vector map data; visible detail depends on the selected XML render theme. |
| Hillshade database | `.sqlite` | No | Hillshade renderer | SQLite elevation database used to generate shaded-relief overlays; not a standalone base map. |

## Local resources

### OsmAnd

The OsmAnd Atlas renderer reads selected OBF map files, an external OsmAnd resources folder and the selected rendering-style XML. It renders native 256×256 XYZ tiles as RGBA pixels, applies display-density scaling and caches rendered tiles on disk.

The separate OsmAnd hillshade renderer reads elevation data directly from selected SQLite hillshade databases and returns rendered raster tiles.

### OBF search and renderer selection

The Location controls provide an **Offline address search** across all enabled, available OsmAnd OBF files. Matching addresses are shown in a result list so the user can choose the intended match; selecting a result moves the map to its coordinates.

The View control **Optimize OBF selection by bounds** determines which enabled OBF files are passed to the OsmAnd and OsmAnd Atlas renderers:

- **Enabled:** select OBF files whose geographic bounds and zoom-level coverage intersect the current map viewport. Applicable world basemaps are retained.
- **Disabled:** pass every enabled, available OBF file to the renderer, matching the previous behavior.

This option is persisted across sessions. Disabling it is useful for compatibility or when testing map coverage, while the optimized mode avoids loading unrelated regional OBF files for each viewport.

## Map bounds overlay

The **Show map bounds** option in the map View controls draws the geographic extents of enabled offline maps when valid bounds metadata is available. The overlay is available for:

- **MBTiles** databases, using their stored geographic bounds metadata.
- **OsmAnd OBF** maps, including maps displayed through the OsmAnd Atlas renderer.

The bounds overlay is displayed only at zoom level 10 or lower to keep the map readable at closer scales. The option is enabled only when the selected renderer has at least one enabled supported map with bounds available.

Online XYZ tile sources do not provide per-file geographic bounds for this feature. Mapsforge MAP files are not currently supported by the overlay because LumaScope does not yet expose their bounds to the map view. Hillshade databases are overlays rather than standalone base maps and are not included.

### basemap.at online styles

The online map style selector includes three basemap.at raster WMTS products, loaded by the existing Leaflet tile layer without replacing the map renderer or the independent GPX, routing and photo overlays:

- **basemap.at Standard:** `https://mapsneu.wien.gv.at/basemap/geolandbasemap/normal/google3857/{z}/{y}/{x}.png`
- **basemap.at Grau:** `https://mapsneu.wien.gv.at/basemap/bmapgrau/normal/google3857/{z}/{y}/{x}.png`
- **basemap.at Orthofoto:** `https://mapsneu.wien.gv.at/basemap/bmaporthofoto30cm/normal/google3857/{z}/{y}/{x}.jpeg`

All three use EPSG:3857 and the WMTS `google3857` tile matrix. The row/column order in the service URL is `{y}/{x}`. The map displays the required linked attribution **Datenquelle: basemap.at**. The service covers Austria; outside its coverage area, tiles may be empty. The products are provided online and require an internet connection.

### Mapsforge

The Java Mapsforge renderer (version 0.25.0) reads selected MAP vector files. It uses an external XML render theme when configured, otherwise Mapsforge's built-in default theme. It renders 256×256 vector tiles and applies Windows display-density scaling to text and symbols.

### Valhalla routing

Valhalla is the routing engine and is configured separately from the map renderers. Routing configuration files describe how routing is performed; they do not replace the routing graph tiles. The required Valhalla tiles and supporting resources must be available locally for route calculation.
