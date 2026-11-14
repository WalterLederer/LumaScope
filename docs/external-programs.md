# External programs

[Back to README](../README.md)

LumaScope uses dedicated helper processes for selected native or third-party tasks. The in-app Help panel also profiles short-lived external processes when they are launched. Repeated calls to the same program for the same function are grouped in the current session.

| Program | Function |
| --- | --- |
| `osmand_atlas_render_helper.exe` | Native C++ OsmAnd Atlas vector-map renderer (OsmAnd Core / Qt). Loads selected OBF map files, external OsmAnd resources and the selected rendering-style XML; renders 2×2 XYZ metatiles as RGBA pixels, applies display-density scaling and caches rendered metatiles on disk. |
| `osmand_render_helper.exe` | Native C++ OsmAnd hillshade renderer. Reads elevation data directly from selected SQLite hillshade databases and returns rendered raster tiles. It runs independently of the Atlas OBF renderer. |
| `java.exe` | Java Mapsforge renderer (Mapsforge 0.25.0). Runs the bundled `mapsforge-renderer.jar` as a persistent worker, reads selected MAP files and renders 256×256 vector-map tiles using an external XML theme or the built-in default theme. Windows display density is applied to text and symbols. |
| `jxr-wic-encoder.exe` | Encodes an FP16 HDR capture as JPEG XR using the native Windows Imaging Component encoder. |

## Dynamically profiled processes

Other programs appear in the Help panel when LumaScope launches them through its external-process wrapper. The displayed list is session-specific and reflects the programs actually started during that session.

Process memory information is collected without PowerShell:
- **Windows:** Electron's `app.getAppMetrics()` supplies working-set and private-memory values for the main process; the built-in `tasklist.exe` reports working-set memory for external helpers. Private bytes for those external helpers are unavailable.
- **Linux:** process information is read from `/proc`; resident memory comes from `statm`, and private memory is read from `smaps_rollup` when permissions allow it.
- **macOS:** the built-in `ps` command reports resident memory. Private bytes are not currently available.

Processes can exit or become inaccessible while a snapshot is being collected, so the list is best-effort and may vary between refreshes.
