# Windows API calls

[Back to README](../README.md)

This reference lists **31 direct Windows API entries** used by LumaScope. It does not include calls made internally by Electron, Qt, the Java runtime or third-party libraries.

| DLL / component | API call | Purpose |
| --- | --- | --- |
| `user32.dll` | `EnumWindows` | Enumerates top-level windows in Z-order and supplies handles used to build the capture-source list. |
| `user32.dll` | `IsWindow` | Checks whether a previously selected HWND still identifies an existing window. |
| `user32.dll` | `IsWindowVisible` | Filters out hidden top-level windows when discovering capture sources. |
| `user32.dll` | `IsIconic` | Detects minimized windows so they are not offered as usable capture sources. |
| `user32.dll` | `GetWindowTextW` | Reads the Unicode title of a window for the capture-source list and diagnostics. |
| `user32.dll` | `GetClassNameW` | Reads the window class to exclude desktop, shell and other non-application windows. |
| `user32.dll` | `GetWindowThreadProcessId` | Maps a window handle to its owning process ID. |
| `user32.dll` | `GetWindowRect` | Reads window bounds; also serves as a fallback when DWM extended frame bounds are unavailable. |
| `user32.dll` | `GetWindow` | Reads the owner window (GW_OWNER) to distinguish owned windows from top-level application windows. |
| `user32.dll` | `GetWindowLongPtrW` | Reads extended window styles (GWL_EXSTYLE), including WS_EX_TOOLWINDOW filtering. |
| `user32.dll` | `MonitorFromWindow` | Finds the monitor nearest to a selected window. |
| `user32.dll` | `MonitorFromRect` | Finds the monitor nearest to an enumerated window rectangle. |
| `user32.dll` | `GetMonitorInfoW` | Reads monitor and work-area bounds plus the Windows display-device name. |
| `user32.dll` | `SetProcessDpiAwarenessContext` | Requests per-monitor-v2 DPI awareness before reading physical window and monitor coordinates. |
| `user32.dll` | `GetDisplayConfigBufferSizes` | Queries the buffer sizes needed to enumerate active Windows display paths and modes. |
| `user32.dll` | `QueryDisplayConfig` | Reads active display topology so monitor identifiers can be matched to their display configuration. |
| `user32.dll` | `DisplayConfigGetDeviceInfo (source name)` | Retrieves the GDI display-device name for a display path. |
| `user32.dll` | `DisplayConfigGetDeviceInfo (advanced color)` | Reads advanced-colour / HDR capability and active colour information for each display, including current and legacy packet versions. |
| `dwmapi.dll` | `DwmGetWindowAttribute` | Reads DWMWA_EXTENDED_FRAME_BOUNDS for the visible window frame; GetWindowRect is used as fallback. |
| `kernel32.dll` | `OpenProcess` | Opens the owning process with query-limited-information access when a window is large enough to be a useful capture source. |
| `kernel32.dll` | `QueryFullProcessImageNameW` | Retrieves the executable path of the process that owns an enumerated window. |
| `kernel32.dll` | `CloseHandle` | Releases process handles used during window enumeration and the duplicated stdout handle when the native Atlas helper shuts down. |
| `kernel32.dll` | `GetStdHandle` | In the native C++ OsmAnd Atlas helper, obtains the original stdout and stderr handles for its binary frame protocol. |
| `kernel32.dll` | `GetCurrentProcess` | Supplies the current-process pseudo-handle when duplicating the Atlas helper protocol output handle. |
| `kernel32.dll` | `DuplicateHandle` | Keeps a dedicated copy of the Atlas helper's original stdout handle for binary tile-frame output. |
| `kernel32.dll` | `SetStdHandle` | Redirects the Atlas helper's standard output to stderr so diagnostic text cannot corrupt the binary frame protocol. |
| `kernel32.dll` | `WriteFile` | Writes the Atlas helper's binary frame header and RGBA pixel payload to the preserved stdout handle. |
| `ole32.dll` | `CoInitializeEx / CoUninitialize` | Initializes and releases the COM multithreaded apartment used by the native JPEG XR encoder. |
| `ole32.dll` | `CoCreateInstance` | Creates the Windows Imaging Component (WIC) imaging factory used by the JPEG XR encoder. |
| `oleaut32.dll` | `VariantInit / VariantClear` | Initializes and releases the VARIANT value used to pass JPEG XR encoder quality settings through WIC. |
| Windows Imaging Component (COM) | `IWICImagingFactory / IWICStream / IWICBitmapEncoder / IWICBitmapFrameEncode` | Creates the output stream and JPEG XR encoder, configures image dimensions, pixel format and quality, writes FP16 pixel rows, and commits the encoded image. |
