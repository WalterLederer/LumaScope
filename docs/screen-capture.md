# Screen Capture

The Screen Capture window provides separate workflows for saving a capture to a file and copying a capture to the clipboard. It supports monitor, application-window and rectangular-area sources.

## Capture source

Use the **Source** selector to choose what to capture:

- **Top Window** automatically captures the foreground window. The Advanced Settings option controls whether the LumaScope capture window remains visible during this workflow.
- **Rectangle** lets you drag out an area directly on the screen. Press Esc to cancel the selection.
- **Monitor** captures a complete display.
- **Window** captures a specific visible application window.

The source list includes monitor/window dimensions, display mode, window title and status information. Use the star to add or remove a favorite. **Refresh** re-enumerates the available capture sources.

Unavailable or minimized windows cannot be selected. If a window is missing or its state has changed, refresh the source list.

## FILE Capture

The **FILE Capture** section saves a capture to the selected output folder.

1. Select a capture source.
2. Choose an output format.
3. Choose the destination folder.
4. Optionally select **Preview** to inspect the capture before saving.
5. Use **Save** to capture and write a new file.

**Save preview** writes the already displayed preview without capturing the source again. The Summary in Advanced Settings shows the selected source, format, destination and output filename.

Available formats:

- **OpenEXR (.exr)** — high-dynamic-range image format.
- **JPEG XR (.jxr)** — JPEG XR output, encoded through the Windows Imaging Component helper.
- **Ultra HDR JPEG (.jpg, gain map)** — JPEG output with an HDR gain map.

The selected format controls the file output path; it does not change the clipboard workflow.

## CLIPBOARD Capture

The **CLIPBOARD Capture** section copies a capture to the Windows clipboard.

- **Preview** generates the SDR tone-mapped preview.
- **Clipboard copy preview** copies the already displayed, brightness-adjusted SDR preview without capturing again.
- **Clipboard copy** captures the selected source and copies the result.
- **TOP WINDOW copy** copies the foreground window.
- **RECTANGLE copy** lets you select a screen area and copy it.

The Brightness slider adjusts the SDR clipboard output. **Reset** returns it to 1.00×.

## Preview

The file workflow displays an HDR FP16/scRGB preview where supported. The clipboard workflow displays an SDR tone-mapped preview generated from the FP16/scRGB capture data.

Previewing is separate from saving or copying: use the explicit Save or Clipboard copy action for the desired output. A preview can be reused with **Save preview** or **Clipboard copy preview**.

## Advanced Settings

Expand **Advanced Settings** for additional controls:

- **Include the capture window (keep application windows visible)** — available for Top Window capture. Controls whether the LumaScope capture window is included/left visible during capture.
- **Gamma correction (saved file only)** — applies the configured gamma correction to saved file output. It does not affect clipboard output.
- **Gamma value** — sets the correction strength when gamma correction is enabled.
- **Encoder quality** — available for JPEG XR and Ultra HDR JPEG output; it is not shown for OpenEXR.
- **Summary** — reports the current source, format, destination and output filename.
- **SDR / FP16 diagnostics** — appears when diagnostic data is available and reports capture range, brightness factor, channel maxima and luminance statistics.

## Keyboard shortcuts

The application can register global shortcuts for top-window and rectangle clipboard capture. The shortcut combinations and their current registration status are documented in [Key shortcuts](shortcuts.md) and the Help panel.

## Troubleshooting

- **No monitors detected:** refresh the source list. If it remains empty, the capture API could not enumerate displays in the current Windows session.
- **A window is unavailable:** it may be minimized, too small, or no longer capturable. Refresh and select another source.
- **HDR is not available:** check the Windows display mode and the selected monitor/source. HDR capability depends on the display, Windows configuration and capture backend.
- **Preview is blank or fails:** check the selected source and refresh the list. Some protected or elevated windows may not be capturable.
- **The saved image differs from the clipboard preview:** file output and clipboard output use different output paths and processing options. Gamma correction is for saved files only; clipboard brightness is controlled separately.
