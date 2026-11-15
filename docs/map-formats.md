# Supported map formats

[Back to README](../README.md)

The Help reference lists **5 map source types**.

| Format / source | Extension / source | Online | Renderer | Details |
| --- | --- | --- | --- | --- |
| Online map (XYZ tiles) | URL / XYZ tile endpoint | Yes | MapLibre | Online raster or vector tiles loaded from a tile-server URL; requires an internet connection. |
| MBTiles | `.mbtiles` | No | LumaScope / MapLibre | Offline raster or vector tile database. |
| OsmAnd | `.obf` | No | OsmAnd native renderer | Offline vector map data; labels depend on the selected OsmAnd renderer and its resources/style. |
| Mapsforge | `.map` | No | Mapsforge 0.25.0 | Offline vector map data; visible detail depends on the selected XML render theme. |
| Hillshade database | `.sqlite` | No | Hillshade renderer | SQLite elevation database used to generate shaded-relief overlays; not a standalone base map. |

## Local resources

### OsmAnd

The OsmAnd Atlas renderer reads selected OBF map files, an external OsmAnd resources folder and the selected rendering-style XML. It renders native 256×256 XYZ tiles as RGBA pixels, applies display-density scaling and caches rendered tiles on disk.

The separate OsmAnd hillshade renderer reads elevation data directly from selected SQLite hillshade databases and returns rendered raster tiles.

## Map bounds overlay

The **Show map bounds** option in the map View controls draws the geographic extents of enabled offline maps when valid bounds metadata is available. The overlay is available for:

- **MBTiles** databases, using their stored geographic bounds metadata.
- **OsmAnd OBF** maps, including maps displayed through the OsmAnd Atlas renderer.

The bounds overlay is displayed only below zoom level 10 to keep the map readable at closer scales. The option is enabled only when the selected renderer has at least one enabled supported map with bounds available.

Online XYZ tile sources do not provide per-file geographic bounds for this feature. Mapsforge MAP files are not currently supported by the overlay because LumaScope does not yet expose their bounds to the map view. Hillshade databases are overlays rather than standalone base maps and are not included.

### Mapsforge

The Java Mapsforge renderer (version 0.25.0) reads selected MAP vector files. It uses an external XML render theme when configured, otherwise Mapsforge's built-in default theme. It renders 256×256 vector tiles and applies Windows display-density scaling to text and symbols.

### Valhalla routing

Valhalla is the routing engine and is configured separately from the map renderers. Routing configuration files describe how routing is performed; they do not replace the routing graph tiles. The required Valhalla tiles and supporting resources must be available locally for route calculation.
