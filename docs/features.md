# LumaScope feature guide

[Back to README](../README.md)

## Browse

Browse is the folder-based image collection view embedded in the main Image View window.

- Navigate image folders and subfolders.
- Display image thumbnails and select a source image for the viewer.
- Sort and browse supported image files.
- Open images through Explorer file associations, command-line paths or drag and drop.
- Inspect thumbnail and full-size conversion cache states.
- Use keyboard zoom controls to change thumbnail size.
- Keep the browser component mounted while switching to other Image View tabs, preserving its state and cache activity.

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
- Display the current image position on the map.
- Inspect and copy coordinates.
- Resolve or enrich location names where a geocoding provider is configured and available.
- Import GPX tracks and display them on the map.
- Control GPX track visibility and presentation, including track colour.
- Open the detached Location window.
- Use map navigation and zoom controls; arrow-key behaviour is map-aware when the pointer is over the map.
- Use the map time slider and playback controls where the selected map/track view supports time-based display, including animation speed, walking animation, rotation and symbol-size settings.

Location data is associated with the image record in the local database. Coordinate sources include EXIF, XMP, GPX, manual and external sources.

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

Renderer-specific resources and themes affect available labels, symbols and map appearance. The Offline Files settings organise local resources into dedicated groups, including **Valhalla routing configurations**, the **OsmAnd resources folder** and the **Mapsforge XML theme folder**. See [Supported map formats](map-formats.md).

## Offline Files and local resources

The Offline Files settings separate local map resources by purpose so they can be selected and managed independently:

- **Valhalla routing configurations** — local routing configuration files used by the Valhalla route engine.
- **OsmAnd resources folder** — external resources used by the native OsmAnd map renderer, including rendering styles.
- **Mapsforge XML theme folder** — external XML themes used to control Mapsforge map rendering.

Map data files and their supporting resources remain user-managed local files. A configuration or theme file does not itself include the underlying map database.

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
