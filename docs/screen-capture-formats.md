# Screen Capture formats and image processing

This reference explains the file formats, preview paths and output-specific adjustments in the Screen Capture window.

## OpenEXR (.exr)

OpenEXR is the default high-dynamic-range file format. It is intended to preserve HDR capture data rather than reducing it to an ordinary SDR image.

The capture preview uses FP16/scRGB data where the capture backend supplies it. The preview is a display representation; use the saved EXR when you need the high-dynamic-range file output.

## JPEG XR (.jxr)

JPEG XR output is encoded through the Windows Imaging Component (WIC) helper. The **Encoder quality** slider controls the encoder quality setting.

## Ultra HDR JPEG (.jpg, gain map)

Ultra HDR JPEG stores a conventional JPEG image together with an HDR gain map. The output remains a JPEG file, with HDR-capable rendering dependent on software and display support. The **Encoder quality** slider controls the encoder quality setting.

## HDR preview and SDR clipboard preview

The file capture preview is an HDR FP16/scRGB preview rendered through WebGPU when supported.

The clipboard preview is an SDR tone-mapped representation derived directly from the FP16/scRGB capture data. Its **Brightness** control adjusts the clipboard preview/output. It is independent of the saved-file gamma correction setting.

The two previews therefore serve different purposes and should not be treated as identical renderings of the same output format.

## Gamma correction

**Gamma correction (saved file only)** applies the selected gamma value to saved file output when enabled. The value can be adjusted from 0.1 to 2.2.

This setting does not apply to clipboard capture. Use the clipboard **Brightness** control for the SDR clipboard path instead.

## Encoder quality

The quality slider is shown for JPEG XR and Ultra HDR JPEG. OpenEXR does not expose this lossy encoder-quality control in the capture panel.

## Diagnostics

When available, **SDR / FP16 diagnostics** provide additional information about the capture conversion, including:

- applied brightness factor and whether the capture is in SDR or HDR range;
- FP16 maximum values for the red, green and blue channels;
- counts of pixels above selected channel or luminance thresholds;
- luminance percentiles from the diagnostic histograms.

These values are intended for inspecting capture and tone-mapping behaviour. They are not a substitute for calibrated display measurements.
