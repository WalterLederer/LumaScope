# Platform support

[Back to README](../README.md)

## Current support status

LumaScope is currently supported on **Windows only**. Linux and macOS are not currently supported. Although packaging configuration exists for some Linux formats, this does not mean that the application or its native helpers are portable or that a working Linux release is available.

## What would be required for Linux or macOS support?

The Angular UI and much of the Electron application logic could provide a shared cross-platform foundation, but a port would require more than adding another Electron package target. The main platform-specific work includes:

- **Screen capture and display/HDR detection:** Replace the current Windows capture path and Windows display inspection with platform-specific implementations. Linux would need to account for both X11 and Wayland (including PipeWire/desktop portal permissions and compositor limitations); macOS would need ScreenCaptureKit and the relevant screen-recording permissions. Monitor enumeration, physical-pixel geometry, DPI/scaling, colour spaces and HDR state would also need native implementations and validation on each platform.
- **Windows API and COM dependencies:** The direct Win32 calls documented in [Windows API calls](windows-api.md), plus the Desktop Window Manager and Windows Imaging Component (WIC) integration, cannot run unchanged on Linux or macOS. They need platform-specific replacements behind a common API, or the related features must be disabled where no equivalent is available. In particular, the current JPEG XR FP16 capture encoder is a WIC-based native helper and would need a portable encoder or separate native implementations.
- **Windows shell integration:** Explorer **Open with**, file associations, startup arguments/second-instance handling, global shortcuts and window activation need to be integrated with each desktop environment and operating system. The runtime process-memory monitor is now PowerShell-free: it uses `tasklist.exe` on Windows, `/proc` on Linux and `ps` on macOS. PowerShell remains in Windows-specific development and packaging scripts, not in this monitoring path.
- **Native helper programs:** Build and package the OsmAnd C++/Qt renderers for each target OS, including their Qt and native-library dependencies. The Mapsforge Java worker is more portable, but its Java runtime, process lifecycle, file paths and packaging still need cross-platform handling. The Valhalla routing helper and its native dependencies also need target-specific builds and staging; the current production scripts use Windows PowerShell.
- **Build and release pipeline:** Add and test native build prerequisites, helper staging, Electron packaging, signing/notarisation where applicable, installers and update/release workflows separately for Linux distributions and macOS architectures.
- **Feature and regression testing:** Verify image decoding and HDR presentation, capture output, monitor handling, maps, routing, cache/database access, file opening and permissions on real Linux and macOS systems. Features without a reliable platform equivalent should be clearly marked as unavailable rather than silently behaving differently.

## Suggested implementation approach

A practical implementation would first introduce platform-neutral interfaces for capture, display information, window discovery, file integration and helper-process management. Windows would remain one implementation; Linux and macOS implementations could then be added and tested independently.

Until that work is completed, the Linux packaging files are configuration scaffolding only, not evidence of supported Linux functionality.
