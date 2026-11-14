# Supported map formats

[Back to README](../README.md)

| Format / source | Extension / source | Online | Renderer | Details |
| --- | --- | --- | --- | --- |
| Online map (XYZ tiles) | URL / XYZ tile endpoint | Yes | MapLibre | Online raster or vector tiles loaded from a tile-server URL; requires an internet connection. |
| MBTiles | `.mbtiles` | No | LumaScope / MapLibre | Offline raster or vector tile database. |
| OsmAnd | `.obf` | No | OsmAnd native renderer | Offline vector map data; labels depend on the selected OsmAnd renderer and its resources/style. |
| Mapsforge | `.map` | No | Mapsforge 0.25.0 | Offline vector map data; visible detail depends on the selected XML render theme. |
| Hillshade database | `.sqlite` | No | Hillshade renderer | SQLite elevation database used to generate shaded-relief overlays; not a standalone base map. |

## Local resources

### OsmAnd

The OsmAnd Atlas renderer reads selected OBF map files, an external OsmAnd resources folder and the selected rendering-style XML. It renders 2×2 XYZ metatiles as RGBA pixels, applies display-density scaling and caches rendered metatiles on disk.

The separate OsmAnd hillshade renderer reads elevation data directly from selected SQLite hillshade databases and returns rendered raster tiles.

### Mapsforge

The Java Mapsforge renderer (version 0.25.0) reads selected MAP vector files. It uses an external XML render theme when configured, otherwise Mapsforge's built-in default theme. It renders 256×256 vector tiles and applies Windows display-density scaling to text and symbols.

### Valhalla routing

Valhalla is the routing engine and is configured separately from the map renderers. Routing configuration files describe how routing is performed; they do not replace the routing graph tiles. The required Valhalla tiles and supporting resources must be available locally for route calculation.
