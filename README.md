# LumaScope

<img src="docs/images/lumaScope_icon.png" alt="LumaScope Image View" width="30%"> <img src="docs/images/Screenshot_2025-07-28_13-52-11_jpg_thumb.jpg" alt="LumaScope Image View"> 

**LumaScope is a desktop image viewer and visual workspace for SDR and HDR photography, screen capture, photo browsing, geographic image organisation, and offline map-based route planning.**

It combines a high-bit-depth image pipeline with a folder-based photo browser, sidecar caching, image metadata and GPS tools, screen capture, and a multi-engine map view. It is designed to make HDR image data inspectable and useful rather than treating HDR files as ordinary SDR pictures.

This README describes the current LumaScope application, its present feature set and the build configuration maintained in this repository.

> **Project origin:** LumaScope is a fork of [Light Matter](https://github.com/Auxx/light-matter), originally created by [Auxx](https://github.com/Auxx). LumaScope has since been developed further as a separate project, with its own features, architecture and release history. The original project is acknowledged here as the starting point.

> **Platform support:** LumaScope is currently supported on **Windows only**. See [Platform support](docs/platform-support.md) for the current status and the work required to support Linux or macOS.

## Main capabilities

| Area | What LumaScope provides |
| --- | --- |
| **Browse** | Navigate folders, inspect image thumbnails, sort and select images, and open images from Windows Explorer or by drag and drop. |
| **Image View** | Display SDR and HDR images, compare HDR and SDR renderings, inspect pixel values, view histograms and adjust image presentation. |
| **Screen Capture** | Capture a monitor, selected rectangle or application window; preview captures and copy or save the result. |
| **Location** | Read image GPS metadata, show image positions on a map, inspect location information, import GPX tracks and display them with photos. |
| **Maps and routing** | Combine online maps and offline MBTiles, OsmAnd, Mapsforge and hillshade sources; calculate routes with Valhalla. |
| **Cache and database** | Build local thumbnails and full-size conversions in sidecar cache folders, track image metadata in SQLite and inspect cache status. |
| **Windows integration** | Open supported image files from Explorer, use global capture shortcuts, enumerate capture windows and detect display/HDR capabilities. |

## Image viewing

LumaScope supports common raster and vector image formats as well as high-bit-depth and HDR-capable formats. The viewer distinguishes SDR and HDR-capable sources and uses format-specific decoding and conversion paths.

For HDR-capable images, the viewer provides:

- HDR and SDR presentation modes;
- split, stacked and full-size side-by-side comparison layouts where applicable;
- image brightness, contrast, gamma, colour intensity, black/white point and RGB-channel adjustments;
- a pixel magnifier (loupe) with SDR RGB and HDR/scRGB pixel readouts;
- linear and logarithmic histograms with channel and luminance information;
- image dimensions, metadata and source information;
- capture-preview comparison when a compatible capture frame is available.

See [Supported image formats](docs/image-formats.md) for bit depth, decoder and cache behaviour.

## Browse and file handling

The **Browse** area is the folder-oriented entry point to the image collection. It supports folder navigation, thumbnail browsing, image selection and cache-status inspection. Images can also be opened by:

- using **Open with** from Windows Explorer after installing LumaScope and registering its file associations;
- passing an image path to the application at startup;
- dragging an image file into the application.

When LumaScope is already running, a second launch with an image path is forwarded to the existing application window. The folder containing the image is opened and the image is selected in the viewer.

## Screen Capture

The separate **Screen Capture** window supports monitor, application-window and rectangle capture sources. The workflow includes source selection, preview, clipboard and file output, and HDR-capable capture paths where supported by the display and Windows capture APIs.

Global shortcuts can be used while LumaScope is not focused. Their registration status is checked at runtime; see [Key shortcuts](docs/shortcuts.md).

## Location, maps and routes

Images containing GPS coordinates can be positioned on the location map. LumaScope can read location metadata, display coordinates and location details, and use GPX tracks as an additional geographic reference.

The map workspace supports online XYZ tile sources and offline map data. Depending on the selected source and installed resources, map rendering is provided by MapLibre, the OsmAnd native renderers or Mapsforge. Hillshade databases can be used as shaded-relief overlays.

![LumaScope Image View](docs/images/2026_11_11_09_27_41__Zwischenablagebild_(1).Png) 

For route planning, LumaScope integrates the Valhalla routing engine. Routing configuration files can be selected locally and shared; the selected routing profile and available map data determine the routes that can be calculated. See [Supported map formats](docs/map-formats.md) and [Feature guide](docs/features.md).

## Cache and image database

LumaScope uses a local SQLite database for image-related metadata and cache status. Generated files are stored beside the source collection in a `.cache` sidecar folder, rather than relying on one central cache directory.

The cache system distinguishes thumbnail files from full-size conversions and identifies whether a usable file is stored in a sidecar cache or a parallel folder. It also tracks image and location metadata used by Browse, Image and Location views.

The cache is designed to be rebuildable: source images remain the originals, while thumbnails and converted display files are derived data. A writable sidecar location is required when adding a folder to the managed Browse collection.

## Supported formats

### Images

LumaScope currently documents AVIF, BMP, GIF, HEIF/HEIC, JPEG, JPEG XL, JPEG XR, OpenEXR, PNG, Radiance HDR, SVG, TIFF, Ultra HDR JPEG and WebP. HDR capability is format- and file-dependent; not every file with an extension is necessarily HDR.

See the complete table in [Supported image formats](docs/image-formats.md).

### Maps

Supported map sources include online XYZ tile endpoints, MBTiles, OsmAnd OBF maps, Mapsforge MAP files and SQLite hillshade databases.

See [Supported map formats](docs/map-formats.md).

## Documentation

The Help tab in the application displays this README. The detailed reference tables are maintained as separate Markdown documents:

- [Feature guide](docs/features.md) — Browse, Image View, capture, location, maps, routing, cache and Windows integration.
- [Supported image formats](docs/image-formats.md) — decoder, HDR support, bit depth and full-size cache behaviour.
- [Supported map formats](docs/map-formats.md) — map source, online/offline availability and renderer.
- [Key shortcuts](docs/shortcuts.md) — local and global keyboard shortcuts.
- [External programs](docs/external-programs.md) — helper processes and their responsibilities.
- [Build from source](docs/build-from-source.md) — prerequisites and compilation steps for the native SDKs, routing engine, renderers and application.
- [Windows API calls](docs/windows-api.md) — direct Win32 and Windows Imaging Component calls documented by the Help tab.

## Installation and running

Use the current installer or release package published for this repository:

- [LumaScope releases](https://github.com/WalterLederer/LumaScope/releases)
- [LumaScope source repository](https://github.com/WalterLederer/LumaScope)

On Windows, install the release package and launch LumaScope from the Start menu or its installed shortcut. The installer registers supported image file associations so LumaScope can be selected through Explorer's **Open with** workflow. Windows may still require the user to choose LumaScope as the preferred application for a particular extension.

## Building from source

The repository is an Nx workspace containing the Angular renderer and Electron desktop application. The production build also stages native and Java map/capture helpers.

Typical production packaging command on a configured Windows development machine:

```powershell
npm run make:prod
```

The production script builds the JPEG XR WIC encoder, the Mapsforge renderer, the Angular frontend and Electron backend, stages the OsmAnd and Valhalla helpers, and creates the desktop package.

See **[Build from source](docs/build-from-source.md)** for detailed prerequisites and step-by-step compilation instructions for the OsmAnd Core SDK integration, Valhalla routing helper, Mapsforge renderer, JPEG XR WIC encoder and the main Angular/Electron application. The guide also explains which map and routing resources are external runtime data and are not compiled or bundled.

Additional scripts and packaging targets are defined in the root `package.json`. Native build prerequisites and helper source projects are maintained under `tools/`.

## Help reference tables

The five reference areas previously shown in the in-app Help panel are maintained in Markdown:

1. [Supported map formats](docs/map-formats.md)
2. [Supported image formats](docs/image-formats.md)
3. [Key shortcuts](docs/shortcuts.md)
4. [External Programs](docs/external-programs.md)
5. [Windows API calls](docs/windows-api.md)

Runtime-only information is identified as such in the relevant document. Global shortcut registration and the list of processes launched during a session can change between runs.
