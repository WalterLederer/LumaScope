# OsmAnd OBF rendering prototype

This is an isolated developer test. It does not change the LumaScope map window or the existing MBTiles renderer.

## Purpose

Render the repository test map `tools/Spain_ceuta_europe.obf` with the OsmAndCore renderer and the OsmAnd `default.render.xml` style. The prototype produces a PNG screenshot so the OBF data, renderer, style and Windows runtime can be checked before any LumaScope integration.

The test uses the external [PySide6-OsmAnd-SDK](https://github.com/OliverZhaohaibin/PySide6-OsmAnd-SDK) as a standalone GPL-3.0-or-later test application. Its source and binaries are downloaded into `%LOCALAPPDATA%\LumaScope\OsmAnd-SDK`, outside this repository. They are not bundled with LumaScope.

## Requirements

- Windows x64
- Git
- Python 3.12 or newer
- CMake
- Qt 6.10.1 MinGW kit at `C:\Qt\6.10.1\mingw_64`
- MinGW 13.1 at `C:\Qt\Tools\mingw1310_64`

The SDK's helper build currently uses the Qt/MinGW toolchain. Visual Studio alone is not sufficient for this first raster-renderer test.

## Run

From the LumaScope repository root, run:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tools\osmand-obf-prototype\render-spain-ceuta.ps1
```

The script:
1. Checks prerequisites before downloading anything.
2. Checks out the SDK at a fixed commit.
3. Creates an isolated Python virtual environment and installs its declared dependencies.
4. Builds the SDK's helper executable.
5. Points the SDK at this repository's OBF file and the SDK's OsmAnd rendering resources.
6. Renders a screenshot centered on Ceuta.

The screenshot is written to:

```text
%TEMP%\LumaScope-OsmAnd-Spain-Ceuta.png
```

You can override the SDK folder, Qt/MinGW folders, Python executable and CMake executable through script parameters. Run the script with `-?` for the parameter list.

## What this test proves

A successful screenshot confirms that the selected OBF file can be opened and rendered by the external OsmAndCore-based renderer on this Windows machine. It does not yet prove that the renderer can run headlessly as a long-lived LumaScope tile service, or that its visual output matches the exact Android profile. Those are the next integration checks.

## Licensing boundary

The external SDK declares GPL-3.0-or-later and includes OsmAnd source trees. This prototype keeps that software outside the LumaScope repository and does not package it with LumaScope. Do not copy its source or binaries into the LumaScope application or distribute them with LumaScope until the licensing implications have been reviewed.
