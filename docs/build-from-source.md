# Building LumaScope and its native dependencies

[Back to README](../README.md)

This guide describes how the buildable components in this repository are compiled, where their source code comes from, which tools are required, and how the resulting binaries are staged for the LumaScope application.

For inherited and third-party license terms, including the Light Matter MIT notice and the licensing differences between OsmAnd Core and OsmAnd resources, see [Licensing and third-party notices](licensing.md).

The instructions reflect the current Windows build setup. LumaScope is currently supported on Windows. Some OsmAnd helper projects contain experimental Linux/macOS build scripts, but those are not equivalent to a supported application build.

## 1. Build overview

The production build combines several independently compiled components:

| Component | Source | Build system | Output / purpose |
| --- | --- | --- | --- |
| LumaScope renderer and desktop app | `apps/`, `libs/` | Nx, Angular, Electron | Main application |
| OsmAnd native SDK integration | Upstream OsmAnd Core sources in local `vendor/osmand/`, plus `tools/osmand_render_helper_native/` | CMake, Qt 6, MinGW | OBF map renderer and Atlas helper executables |
| Valhalla routing engine | Separate local Valhalla checkout | CMake, Visual Studio, vcpkg | Valhalla libraries and routing helper |
| Mapsforge renderer | `tools/mapsforge-renderer/` | Maven, Java | Self-contained Java renderer JAR |
| JPEG XR WIC encoder | `tools/jxr-wic-prototype/` | CMake, MSVC | Windows FP16-to-JPEG-XR encoder |
| OsmAnd map resources | Separate upstream data repository | No compilation | Rendering styles and other runtime resources |
| Mapsforge map/theme files | External user-provided data | No compilation | Map data and XML rendering themes |
| Valhalla routing tiles/configuration | External routing data/configuration | No compilation by LumaScope | Graph data and routing profiles |

A normal production package is created with:

```powershell
npm run make:prod
```

This command builds the JPEG XR encoder, Mapsforge JAR, Angular/Electron application, stages the OsmAnd and Valhalla helpers, and packages the desktop application. It does **not** compile the upstream OsmAnd Core SDK or the complete upstream Valhalla source tree from scratch. Those source trees must already be present locally and their respective build prerequisites must be installed.

For a build that follows the repository's more defensive cleanup and verification sequence, use the root `build.ps1` script:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\build.ps1
```

The script checks out the `main` branch, pulls it, runs `npm run build:all`, stages the native helpers, packages the application, verifies the staged OsmAnd helper files and starts the unpacked application.

## 2. Common prerequisites

Install and make the following tools available on `PATH`, unless a script parameter points to a specific executable:

- Git for Windows, including Git Bash.
- Node.js and npm versions compatible with the versions pinned in the root `package.json`.
- PowerShell 7 (the OsmAnd and Valhalla staging scripts require it).
- CMake 3.24 or newer for the native helper projects.
- Visual Studio 2022 C++ build tools and a Windows 10/11 SDK.
- Qt 6 and the matching compiler toolchain for the OsmAnd helper.
- A JDK 17+ and Apache Maven 3.9+ for Mapsforge.
- Python is only required by the optional OsmAnd official-workspace build flow when its configured Python environment is used.

Use the compiler/toolchain combination expected by each project. In particular, do not mix Qt's MinGW libraries with an MSVC-built helper or reuse a CMake build directory after changing compiler, generator, architecture or Qt installation.

## 3. OsmAnd Core SDK and native helpers

### 3.1 Source layout

The native helper project expects the upstream OsmAnd Core source tree to be available locally at:

```text
vendor/
  osmand/
    core/
    core-legacy/
    build/
    resources/
```

Both `core/CMakeLists.txt` and `core-legacy/CMakeLists.txt` must exist. The source is not compiled from a Java OsmAnd SDK artifact: LumaScope links against the native **OsmAnd Core** C++ libraries.

The repository's helper implementation is in `tools/osmand_render_helper_native/`. Its top-level CMake project includes the upstream OsmAnd build utilities and core CMake files, configures system Qt, and builds these targets:

- `osmand_render_helper` — command-line OBF tile renderer.
- `osmand_atlas_render_helper` — persistent Atlas rendering process used by the map window.
- `osmand_atlas_frame_poc` — separate framebuffer proof-of-concept executable.
- `osmand_native_widget` — native widget library used by the experimental native-widget path.

The production package currently stages the command-line renderer and persistent Atlas helper. The proof-of-concept executable and native widget DLL are deliberately excluded from the production staging directory.

### 3.2 Windows toolchain

The default values in `tools/osmand_render_helper_native/build_helper.ps1` are:

- Qt: `C:\Qt\6.12.0\mingw_64`
- MinGW: `C:\Qt\Tools\mingw1310_64`
- CMake: the CMake executable installed with Visual Studio 2022
- Generator: `MinGW Makefiles`
- Build configuration: `Release`

Install a Qt 6 MinGW kit and its matching MinGW toolchain. The CMake project requires Qt 6 Core, Network, Gui, Widgets, OpenGL, OpenGLWidgets and Sql. It also uses Git Bash for parts of the upstream OsmAnd build system. If your installation paths differ, pass the actual paths to the script.

### 3.3 Compile the OsmAnd helper targets

Run from the repository root in PowerShell 7:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tools\osmand_render_helper_native\build_helper.ps1
```

Example with non-default installation paths:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tools\osmand_render_helper_native\build_helper.ps1 `
  -QtRoot "C:\Qt\6.12.0\mingw_64" `
  -MinGWRoot "C:\Qt\Tools\mingw1310_64" `
  -BuildType Release
```

The script:

1. Verifies Git Bash, Qt, MinGW, CMake and the two OsmAnd source trees.
2. Adds Git Bash, Qt and MinGW to the process `PATH`.
3. Configures CMake with the MinGW compiler and the local `vendor/osmand` source tree.
4. Builds all four targets listed above.
5. Writes the executables and runtime dependencies to `tools/osmand_render_helper_native/dist/`.

Expected production helper files include:

- `osmand_render_helper.exe`
- `osmand_atlas_render_helper.exe`
- Qt 6 runtime DLLs
- MinGW runtime DLLs (`libgcc_s_seh-1.dll`, `libstdc++-6.dll`, `libwinpthread-1.dll`)

The build script also contains a separate `build_helper_official.ps1` workflow for building against an official OsmAnd workspace, and `build_native_widget_msvc.ps1` for the experimental MSVC native-widget path. These are specialised workflows; the standard production helper build uses `build_helper.ps1` and MinGW.

### 3.4 Stage the compiled helpers

After a successful compile:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tools\osmand-runtime\stage-helpers.ps1
```

This synchronises the required helper executables and runtime DLLs to:

```text
tools/osmand-runtime/stage/helpers/
```

The staging script checks that the Atlas helper accepts the current display-scale argument. An older executable is rejected rather than silently packaged.

### 3.5 OsmAnd resources are data, not SDK binaries

The OsmAnd resources repository is separate from OsmAnd Core and is not compiled by the helper build. Obtain it from [OsmAnd-resources](https://github.com/osmandapp/OsmAnd-resources), extract it, and select its root folder in LumaScope. The selected root must contain:

```text
rendering_styles/default.render.xml
```

The resources remain external to the application package. See [OsmAnd resource notice](../tools/osmand-runtime/OSMAND-RESOURCES-NOTICE.md).

## 4. Valhalla routing engine and LumaScope helper

### 4.1 Separate upstream build

The Valhalla source checkout is maintained separately from this repository. The current Windows build layout expects a sibling directory named `Valhalla` with a configured CMake build directory:

```text
<workspace>  LumaScope  Valhalla    <Valhalla source files>
    build-release      CMakeCache.txt
      ...
```

The helper staging script locates the build directory in this layout by default. To use another location, set `LUMASCOPE_VALHALLA_BUILD` to the absolute path of the Valhalla CMake build directory.

Build and configure the upstream Valhalla project using its current Windows build instructions and the same Visual Studio/vcpkg toolchain used to create that build directory. The CMake cache must describe a valid Valhalla source tree. The LumaScope repository does not contain a second copy of the upstream Valhalla source and does not bootstrap its vcpkg dependencies.

Once the upstream CMake build directory has been configured, compile the Valhalla libraries from the repository root (adjust the path if your checkout is elsewhere):

```powershell
cmake --build .\..\Valhalla\build-release --config RelWithDebInfo --parallel 8
```

This builds the default targets enabled by that upstream CMake configuration. The required Valhalla libraries and runtime DLLs must be present before building/staging the LumaScope helper in the next step. The exact first-time CMake configuration and dependency options belong to the selected Valhalla revision; follow its current Windows/vcpkg instructions rather than reusing a stale cache or guessed options.

Upstream project and build documentation: [Valhalla on GitHub](https://github.com/valhalla/valhalla).

### 4.2 Compile the LumaScope routing helper

LumaScope maintains its own helper source at `tools/valhalla-runtime/src/lumascope_route_helper.cpp`. It links to the `valhalla` library produced by the upstream build. The CMake hook in `tools/valhalla-runtime/cmake/LumaScopeValhallaHelper.cmake` injects this target into the existing Valhalla CMake project without modifying the external checkout.

From the repository root, run:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tools\valhalla-runtime\stage-helpers.ps1
```

The script performs the following operations:

1. Locates the configured Valhalla build directory (default: sibling `Valhalla\build-release`).
2. Reads `CMAKE_HOME_DIRECTORY` from `CMakeCache.txt` to identify the exact upstream source directory.
3. Re-runs CMake configuration with `LumaScopeValhallaHelper.cmake` and the LumaScope helper source.
4. Builds the `valhalla_route_helper` target in the `RelWithDebInfo` configuration, using up to eight parallel jobs.
5. Copies the helper executable and the required Valhalla/vcpkg runtime DLLs into `tools/valhalla-runtime/stage/helpers/`.

To specify a non-default build directory:

```powershell
$env:LUMASCOPE_VALHALLA_BUILD = "D:\Dev\Valhalla\build-release"
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tools\valhalla-runtime\stage-helpers.ps1
Remove-Item Env:\LUMASCOPE_VALHALLA_BUILD
```

The output directory contains `valhalla_route_helper.exe` and its runtime DLL dependencies. The script clears the staging directory before copying so stale DLLs from a previous build cannot remain beside the new executable.

### 4.3 Routing data and configuration are not compiled

Valhalla routing tiles/graph data and JSON configuration files are runtime inputs. Compiling Valhalla or the LumaScope helper does not create regional routing data. The configuration must refer to available Valhalla tiles and the selected travel profile.

## 5. Mapsforge Java renderer

The Mapsforge renderer is a standalone Java application implemented in `tools/mapsforge-renderer/`. It uses Mapsforge 0.25.0 libraries and packages its dependencies into one executable JAR.

### Requirements

- JDK 17 or newer.
- Apache Maven 3.9 or newer.
- Network access on the first build so Maven can download declared dependencies.

### Compile

From the repository root:

```powershell
mvn -f tools/mapsforge-renderer/pom.xml clean package
```

Maven compiles the Java sources, shades the runtime dependencies and creates:

```text
tools/mapsforge-renderer/target/mapsforge-renderer.jar
```

The renderer can be started in worker mode with:

```powershell
java -jar tools/mapsforge-renderer/target/mapsforge-renderer.jar --worker
```

See [Mapsforge renderer README](../tools/mapsforge-renderer/README.md) for the worker protocol, catalog command, tile-rendering examples and optional XML theme parameter.

## 6. JPEG XR Windows Imaging Component encoder

The JPEG XR encoder is a small native Windows executable in `tools/jxr-wic-prototype/`. It receives packed RGBA FP16 pixels and writes JPEG XR through the Windows Imaging Component (WIC). It is Windows-only and uses the Windows SDK's WIC interfaces rather than a separately built JPEG XR library.

### Requirements

- Windows 10/11.
- Visual Studio 2022 C++ build tools and Windows SDK.
- CMake 3.24 or newer.
- An x64 Visual Studio Developer PowerShell or Developer Command Prompt.

### Compile

From the repository root:

```powershell
npm run build:jxr-wic-encoder
```

This runs `tools/jxr-wic-prototype/build.mjs`, which executes:

```powershell
cmake -S . -B build -A x64
cmake --build build --config Release
```

The working directory for those commands is `tools/jxr-wic-prototype/`. The resulting executable is:

```text
tools/jxr-wic-prototype/build/Release/jxr-wic-encoder.exe
```

The production build invokes this npm script automatically. See [JPEG XR encoder README](../tools/jxr-wic-prototype/README.md) for the raw FP16 input layout and standalone encoding example.

## 7. Main Angular/Electron application

The renderer and desktop application are built through the Nx workspace. The root `package.json` defines the scripts:

- `npm run build:all` — Mapsforge renderer, Angular production build and Electron desktop production build.
- `npm run build:mapsforge-renderer` — Maven build of the Mapsforge JAR.
- `npm run build:jxr-wic-encoder` — CMake build of the WIC encoder.
- `nx run desktop:make` — desktop packaging after the helper staging steps.
- `npm run make:prod` — complete production sequence.

Install the Node dependencies first:

```powershell
npm install
```

Then build the application without creating the installer:

```powershell
npm run build:all
```

For the full Windows production package, including the native helper staging steps:

```powershell
npm run make:prod
```

The root `build.ps1` adds repository-branch checking, process cleanup, output cleanup, staged OsmAnd file verification and application startup. It is the preferred entry point for the established local Windows build workflow.

## 8. Components that do not need compilation

The following are external data inputs, not native application projects:

- OsmAnd `.obf` map files.
- OsmAnd resources and rendering styles.
- Mapsforge `.map` files and XML themes.
- MBTiles databases.
- SQLite hillshade databases.
- Valhalla routing tiles and JSON configuration files.
- GPX tracks.

They are downloaded or prepared separately and selected in LumaScope's Offline Files or map settings. Packaging the application does not convert or bundle these regional datasets.

## 9. Troubleshooting and clean rebuilds

- **CMake uses the wrong compiler:** use a fresh build directory after changing the CMake generator, compiler, Qt kit or architecture. CMake caches compiler paths.
- **OsmAnd source missing:** verify that both `vendor/osmand/core/CMakeLists.txt` and `vendor/osmand/core-legacy/CMakeLists.txt` exist.
- **OsmAnd runtime DLL missing:** rebuild with the matching Qt/MinGW kit, then rerun `tools/osmand-runtime/stage-helpers.ps1`.
- **Atlas helper rejected during staging:** rebuild the current `osmand_atlas_render_helper` target; the staging check intentionally rejects older command-line interfaces.
- **Valhalla build directory not found:** set `LUMASCOPE_VALHALLA_BUILD` to the directory containing the Valhalla `CMakeCache.txt`.
- **Valhalla helper does not link:** ensure the selected build directory was configured from the intended Valhalla source tree and has completed the required Valhalla library build for `RelWithDebInfo`.
- **Mapsforge JAR missing:** install JDK/Maven, run the Maven command from the repository root and check `tools/mapsforge-renderer/target/`.
- **WIC encoder missing:** use an x64 Visual Studio developer environment and rerun `npm run build:jxr-wic-encoder`.

For component-specific implementation details, consult the README files next to each tool's source code. This document explains the repository build workflow; upstream projects remain authoritative for their own source acquisition, licensing and dependency setup.
