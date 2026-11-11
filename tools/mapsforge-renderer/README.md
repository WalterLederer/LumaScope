# LumaScope Mapsforge renderer

This is an isolated Java desktop renderer for Mapsforge `.map` files. It does not read or convert OsmAnd `.obf` files and is not connected to the existing OsmAnd renderer process.

## Requirements

- JDK 17 or newer
- Apache Maven 3.9+
- One valid Mapsforge `.map` file

## Build

From the repository root:

```powershell
mvn -f tools/mapsforge-renderer/pom.xml clean package
```

The standalone jar is created at:

`tools/mapsforge-renderer/target/mapsforge-renderer.jar`

## Render one XYZ tile (one-shot PoC)

```powershell
java -jar tools/mapsforge-renderer/target/mapsforge-renderer.jar "D:\Maps\region.map" 12 2140 1360 "D:\Temp\mapsforge-poc.png"
```

Optional custom XML render theme:

```powershell
java -jar tools/mapsforge-renderer/target/mapsforge-renderer.jar "D:\Maps\region.map" 12 2140 1360 "D:\Temp\mapsforge-custom.png" "D:\Maps\theme.xml"
```

## Persistent worker

Start the process:

```powershell
java -jar tools/mapsforge-renderer/target/mapsforge-renderer.jar --worker
```

The worker reads one JSON request per stdin line and writes exactly one JSON response per stdout line. Diagnostics are written to stderr. Commands are processed sequentially by the same JVM and renderer instance.

Open one map (the theme path is optional; null selects Mapsforge's built-in default theme):

```json
{"command":"open","map_path":"D:\\Maps\\MapsForge\\maps\\v5\\austria.map","theme_path":null}
```

Open multiple map files in one combined datastore:

```json
{"command":"open","map_paths":["D:\\Maps\\region-a.map","D:\\Maps\\region-b.map"],"theme_path":null}
```

The worker combines the supplied maps with Mapsforge's `MultiMapDataStore` using `DEDUPLICATE`. Each requested tile is checked against the individual map coverage first; the combined datastore then reads the maps that support that tile. A render response includes `covering_map_count`, the number of loaded map files that report coverage for that tile. Existing `map_path` requests remain supported.

Render tiles from the already-open map set:

```json
{"command":"render","request_id":1,"z":14,"x":8937,"y":5681}
{"command":"render","request_id":2,"z":14,"x":8938,"y":5681}
```

A successful render response contains `status`, `request_id`, XYZ coordinates, `width`, `height`, `format: "png"`, and `png_base64`. An error response has `status: "error"` and a `message`.

Scan a directory recursively and read metadata from every `.map` file without keeping the maps open:

```json
{"command":"catalog","root_path":"D:\\\\Maps\\\\MapsForge\\\\maps\\\\v5"}
```

The catalog response contains each readable map's path, bounding box, min/max zoom, start zoom, file size, map date, creator and file version. Invalid or unreadable files are returned separately in `errors`. This is a metadata scan; it does not render tiles or load the whole collection into memory.

Other commands:

- `{"command":"ping"}` reports whether a map is open.
- `{"command":"close"}` closes the current map but keeps the worker process alive.
- `{"command":"quit"}` closes the map and exits the process.

The worker can open one or multiple explicitly supplied map files in a combined datastore and handles render requests sequentially. The catalog command can scan a complete directory tree, but automatic selection and prioritization of maps for each viewport is not yet implemented. The worker is deliberately separate from the OsmAnd OBF renderer.

## Next integration steps

1. Verify repeated requests in one persistent JVM process.
2. Add Mapsforge map registration as its own map type in the offline map catalogue.
3. Add multiple-map coverage selection and runtime theme switching.
4. Add Mapsforge hillshading.
5. Stage a dedicated Java runtime/helper beside the application package.
