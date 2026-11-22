# LumaScope feature guide

[Back to README](../README.md)

> **Platform support:** LumaScope is currently supported on **Windows only**. Linux is not currently supported because parts of the application rely on external native dependencies, platform-specific helper components and operating-system API calls that are currently Windows-specific. The Linux packaging files in the repository do not mean that the application is functional or supported on Linux.

## Browse

Browse is the folder-based image collection view embedded in the main Image View window.

- Navigate image folders and subfolders.
- Display image thumbnails and select a source image for the viewer.
- Sort and browse supported image files.
- Open images through Explorer file associations, command-line paths or drag and drop.
- Inspect thumbnail and full-size conversion cache states.
- Use keyboard zoom controls to change thumbnail size.
- Keep the browser component mounted while switching to other Image View tabs, preserving its state and cache activity.
- On Windows, open the native Windows Shell context menu for a file by right-clicking its thumbnail or using **Windows context menu** in the thumbnail's action menu.
- In the Browse favorites folder tree, right-click a folder or choose **Windows context menu** from its action menu to open that folder's native Windows Shell context menu.
- The native menu exposes the commands registered by Windows and installed Shell extensions for the selected file or folder. The feature uses the classic Shell context menu; it does not implement a separate custom LumaScope menu.

### Filename filter

The **Filter** field above the file list searches filenames. Enable its checkbox to apply the entered filter; uncheck it to temporarily show all files again.

- Enter multiple search terms separated by spaces. Every term must occur somewhere in the filename (AND logic).
- Terms can appear in any order and do not need to be adjacent. For example, `.hdr 2023` matches filenames containing both `.hdr` and `2023`.
- Matching is case-insensitive. A single term works as before, and any number of terms can be combined.
- The filter is applied to the database query, so files that do not match are excluded before the gallery pages are loaded.

Images are not imported into a central library by copying the originals. Source files remain in their original folders.

## Image View

The Image View displays the selected image and provides image-specific control tabs.

### SDR and HDR display

- Format-aware decoding and conversion for SDR, high-bit-depth and HDR-capable image formats.
- HDR and SDR viewing modes for HDR-capable images.
- Side-by-side and stacked comparison layouts, including split/overlay variants.
- Full-size comparison layouts without overlay.
- Image brightness, contrast and gamma adjustments.
- Colour intensity, black point and white point controls.
- Individual red, green and blue channel levels and channel inversion controls.
- Image zoom, fit-to-window and fullscreen presentation.

Actual HDR presentation depends on the source file, decoder path, operating-system display mode and connected display capabilities.

### Pixel loupe and histogram

- Cursor-following magnifier with configurable shape and magnification.
- SDR RGB values and HDR/scRGB pixel values.
- FP16 capture-preview sampling when a compatible capture preview is active.
- Main-image versus capture-preview pixel comparison.
- Linear and logarithmic histograms with luminance and RGB channels.
- Histogram inspection at the pointer position.

### Image control tabs

The Image section is divided into focused sub-tabs:

- **Summary** — image overview and metadata summary.
- **Actions** — image-related actions and file operations.
- **Histogram** — linear and logarithmic RGB/luminance histogram, including capture-preview analysis when enabled.
- **View** — HDR/SDR comparison modes and split controls.
- **Highlight** — image highlight and pixel-inspection controls.
- **Zoom** — image zoom and fit controls.
- **Corrections** — brightness, contrast, gamma, colour intensity, black/white point and RGB channel adjustments.
- **Cache** — source/cache information and the SQLite photo record.

### Image information

- Image dimensions and loading/conversion timing information.
- EXIF and other supported metadata.
- GPS coordinates and location-related metadata.
- The **Detailed Metadata Report** includes the resolved **GPS Date** and a **GPS Date Source** row. Its source priority is EXIF `GPSDateTime`, XMP `GPSDateTime`, EXIF `DateTimeOriginal`, XMP `DateCreated`, EXIF `CreateDate`, a validated camera timestamp in the filename (`YYYYMMDD_HHmmss`), and finally the filesystem last-modified timestamp (`FileModifyDate`). Filename timestamps are interpreted as camera-local time. The first valid timestamp is selected.
- SQLite photo-record inspection and refresh.
- Cache status for thumbnails and full-size conversions.

## Screen Capture

Screen Capture is available in its own window.

- Select a monitor as capture source.
- Select a visible application window.
- Select a screen rectangle.
- Preview the capture before using it.
- Copy capture output to the clipboard or save it as a file, depending on the selected output workflow.
- Use the HDR capture preview and FP16/scRGB inspection path where supported.
- Inspect capture geometry and source information.
- Use global shortcuts to start top-window or rectangle clipboard capture while another application is active.

The exact available output and HDR path depend on the selected source and Windows display/capture capabilities.

## Location and GPX

The Location tab connects image metadata to geographic context.

- Read GPS coordinates embedded in image metadata.
- **Fix location MANUAL** is for correcting the currently selected photo when its position can be identified visually. Enable **Show crosshair**, move the map so the fixed centre crosshair is over the photo's actual location, optionally use **Show crosshair address** to inspect the place name, and choose **Save GPS position...**. LumaScope writes the crosshair latitude/longitude to that image's GPS EXIF fields. This is a deliberate, one-photo-at-a-time correction; it does not infer a position from a timestamp or modify other photos.
- **Fix location AUTOMATIC** applies timestamp-based geotagging to a selected photo folder. It recursively scans the folder and matches photos without GPS coordinates against timestamped points in GPX tracks and timestamped GPS positions from already geotagged images stored in the cache database for the photo drive and all drives represented by Browse favorite folders. Favorite drives are searched even when their folders are not currently open. The closest valid GPX-track or geotagged-image reference candidate is selected by time deviation.
  - Matching requires a valid photo timestamp and either a pair of bracketing GPX points from the **same GPX track segment**, two bracketing cached geotagged images, or one nearby cached geotagged image. Positions are interpolated between a pair; a single image reference supplies its exact position without interpolation or extrapolation. A single image reference is accepted only within the configured maximum time difference.
  - The photo timestamp priority is EXIF `GPSDateTime`, XMP `GPSDateTime`, camera timestamp in the filename (`YYYYMMDD_HHmmss`, for example `IMG_20261009_093728.jpg`), EXIF `DateTimeOriginal`, XMP `DateCreated`, then EXIF `CreateDate`. If none is usable, GPS Auto Fix falls back to filesystem last-modified time.
  - Filename dates are validated and interpreted as camera-local time. This is important for Android/ADB transfers: Windows Created/Modified timestamps can represent the PC copy time instead of the original photo capture time, so a valid camera-generated filename timestamp is preferred over those filesystem values.
  - For a GPX pair or two image references, the nearest bracketing reference determines the candidate time deviation. For a single image anchor, the absolute time distance to that image determines the deviation. The default **Maximum time difference** is **2 minutes**. Candidates whose deviation exceeds the configured limit are counted as **Ignored (time difference too high)** and are not written. The setting accepts 0–1440 minutes in 0.5-minute steps.
  - **Check only** runs the same scan and matching logic and reports the results without changing image files. In normal mode, accepted positions are written to the original image files' GPS EXIF metadata; existing GPS coordinates are never overwritten.
  - The status report includes the selected start folder, total folders and files processed, photo/GPS counts, accepted matches, unmatched photos, candidates rejected by the time limit, min/mean/max candidate deviation in seconds, updated-file count, errors and elapsed runtime. Deviation statistics include candidates rejected by the threshold, so the report shows how far rejected candidates were from the photo timestamps as well.
  - **No GPX match** means no usable candidate was found (for example, no timestamp, no track points around the photo time, no valid same-segment GPX pair, and no nearby cached geotagged-image anchor or pair within the search window). This is distinct from a candidate that was found but rejected because its deviation exceeded the configured threshold.
  - The GPX data must already have been imported into the cache database associated with the selected folder's drive. Automatic matching searches within a single segment, considers candidate track points within a ±24-hour time window, and rejects interpolation intervals wider than 48 hours.
  - EXIF capture timestamps without an explicit timezone are interpreted as the computer's local timezone. If the camera's local time differs from the computer's timezone, correct time alignment may require adjusting the source timestamps before matching.
- For photos without GPS coordinates, use **Fix location** in the Location tab: enable **Allow fixing**, pan the currently selected online or offline map beneath the fixed centre crosshair, and choose **Save GPS position...** to write the selected latitude and longitude into the image file's GPS EXIF metadata.
- GPS fixing uses the existing map renderer and current map-source settings; it does not switch map sources or introduce a separate map service. The map source must be available and able to initialize normally.
- Display the current image position on the map.
- Inspect and copy coordinates.
- Resolve or enrich location names where a geocoding provider is configured and available.
- Import individual GPX tracks for immediate map display.
- In **Track → Advanced**, recursively import all GPX files below a selected folder into the drive-local SQLite cache database; the adjacent counters show the database totals for files, segments and track points.
- Re-import safely: unchanged files are detected by SHA-256 content hash, changed files are re-indexed, and identical GPX content is stored only once per drive database.
- Control GPX track visibility and presentation, including track colour.

The folder import is an additive database import, not a move operation: source GPX files remain untouched. See [GPX cache database](gpx-cache.md) for the schema, indexing, duplicate rules, parser scope and current limitations.
- Open the detached Location window.
- Use map navigation and zoom controls; arrow-key behaviour is map-aware when the pointer is over the map.
- Use the map time slider and playback controls where the selected map/track view supports time-based display, including animation speed, walking animation, rotation and symbol-size settings.

Location data is associated with the image record in the local database. Coordinate sources include EXIF, XMP, GPX, manual and external sources.

#### Photo marker timestamps

The timestamp used for a photo marker and the map time slider is selected in this order:

1. EXIF `GPSDateTime`.
2. XMP `GPSDateTime`.
3. Camera timestamp in the filename (`YYYYMMDD_HHmmss`, e.g. `IMG_20261009_093728.jpg`).
4. EXIF `DateTimeOriginal`.
5. XMP `DateCreated`.
6. EXIF `CreateDate`.

  During a normal GPS Auto Fix run, this selected timestamp is also synchronized to the SQLite `photos.gps_timestamp` field for every scanned photo. **Check only** does not modify the database. Filesystem last-modified time is used only when none of the metadata or filename timestamps is available.

For GPS Auto Fix only, if none of these values is available, the source file's filesystem last-modified time is used as the final fallback. Filename timestamps are interpreted as camera-local time and take precedence over Windows filesystem dates because Android/ADB copies can set those dates to the transfer time.

GPS date/time values are treated as UTC. Embedded capture dates without timezone information are interpreted in the computer's local timezone. The selected timestamp is stored with the photo's location record and is used for map time filtering and playback. A photo without valid latitude and longitude cannot be shown as a location marker and therefore has no marker timestamp.

## Maps and offline map data

The map workspace can combine online and offline sources.

- Online XYZ tile sources rendered through MapLibre.
- MBTiles databases for offline raster or vector tiles.
- OsmAnd OBF vector maps through the native OsmAnd renderer.
- Mapsforge MAP vector maps through the Java Mapsforge renderer.
- External Mapsforge XML render themes.
- External OsmAnd resources and rendering styles.
- SQLite hillshade databases for shaded-relief overlays.
- Offline map and hillshade file management through the Offline Files settings.
- Automatic discovery of supported maps, hillshade databases, Valhalla JSON configurations, OsmAnd resources and Mapsforge themes from an extracted resource-package folder. Region folder names are not fixed; existing resource paths are confirmed before replacement.

The **Offline address search** in the Location controls searches all enabled, available OsmAnd OBF files and displays the matching addresses as a selectable result list. Selecting a result moves the map to that location; the search does not automatically jump to the first match. In the map **View** controls, **Optimize OBF selection by bounds** controls which enabled OBF files are supplied to the OsmAnd renderers: when enabled, LumaScope selects files whose geographic bounds and zoom-level coverage match the current viewport, while retaining applicable world basemaps. When disabled, every enabled, available OBF file is supplied, restoring the previous all-enabled-files behavior. The setting is saved between sessions and applies to both OsmAnd and OsmAnd Atlas. Renderer-specific resources and themes affect available labels, symbols and map appearance. The **Show map bounds** option in the View controls outlines the geographic extents of enabled MBTiles and OsmAnd OBF maps (including OsmAnd Atlas) when valid bounds metadata is available. The overlay is visible only at zoom level 10 or lower. It is unavailable for online XYZ sources, Mapsforge MAP files and hillshade databases. The OfflineFiles list combines offline map files, hillshade databases and the supporting resource folders in one table. Resource rows use dedicated types for **Valhalla (offline routing)**, **OsmAnd resources (rendering)** and **Mapsforge XML theme**. Their folder paths and recursive file sizes are shown alongside the map files. See [Supported map formats](map-formats.md) and the [Offline resource package format](resource-package-format.md).

## OfflineFiles and local resources

The unified OfflineFiles table includes:

- **Valhalla (offline routing)** — one row per configuration folder, named after its region. Select the active configuration in the **Routing provider** list.
- **OsmAnd resources (rendering)** — one row for the external resources root; its File column is intentionally empty.
- **Mapsforge XML theme** — one row per discovered XML theme, using the theme filename without its extension.

Folder resource sizes include all files in the folder and its subfolders. Map data, rendering resources, themes and routing graph data remain external user-managed files; a configuration or theme file does not itself include the underlying map database.

## Routing

LumaScope integrates Valhalla for route calculation using locally available routing tiles and configuration.

- Configure local Valhalla routing data and configuration files.
- Select a travel mode/profile.
- Add, edit and remove route waypoints.
- Read routing waypoints from GPX.
- Calculate and display a route on the map.
- Manage named routes and route points.
- Select a travel mode and configure route display options.
- Package routing configuration files for sharing where their referenced resources are also available.

A configuration file alone does not contain the routing graph. Matching Valhalla tiles and required supporting data must be available on the target system.

## Cache and SQLite metadata

LumaScope maintains local cache metadata and image records in SQLite.

- Generate thumbnails for Browse.
- Generate full-size converted display files for formats that need them.
- Store cache data in a `.cache` sidecar folder near the source images.
- Identify cache entries as **Sidecar cache**, **Parallel folder**, **Missing** or invalid/stale as appropriate.
- Check existing cache files before generating new ones.
- Show distinct checking, caching and loading phases in the browser.
- Inspect image database records and location fields.
- Refresh cache status and database information.
- Clear selected cache categories and cancel supported cache operations.

Cache files are derived data. Removing them does not remove original image files. A writable sidecar folder is required for managed folders.

## General settings and diagnostics

The General and Help areas provide application-level settings and technical information, including:

- application configuration and appearance preferences;
- cache maintenance and cache-build status;
- optional image-switching diagnostics and Chromium Developer Tools controls;
- runtime status for registered global shortcuts;
- profiling of external helper processes launched during the current session;
- a reference list of the direct Windows API calls used by LumaScope.

The Help tab displays the repository README and links to the detailed Markdown reference documents.

## Windows integration

- Register supported image extensions for Explorer's Open with workflow through the installer.
- Accept image paths on application startup.
- Forward image-open requests to an already running LumaScope instance.
- Restore and focus the existing main window when a second launch requests an image.
- Register global capture shortcuts through Electron.
- Enumerate visible windows and read process and geometry information for capture-source selection.
- Read Windows display topology and advanced-colour/HDR information.
- Use the Windows Imaging Component to encode supported JPEG XR capture output.

See [Key shortcuts](shortcuts.md), [External programs](external-programs.md) and [Windows API calls](windows-api.md).
