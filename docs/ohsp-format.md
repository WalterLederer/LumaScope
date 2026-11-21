# OHSP spectral measurement file format

[Back to supported image formats](image-formats.md) · [Image detail table](image-detail-table.md) · [Back to README](../README.md)

## Scope

LumaScope currently supports the **OHSP-350SF** `.ohsp` measurement-file layout. It does not treat the file as a conventional photograph. Instead, it generates a raster chart of the measured spectral power distribution. The generated chart is used for both the thumbnail and full-size cache.

This document records the file-layout observations confirmed with an OHSP-350SF sample and its matching CSV export. The binary layout is not publicly documented in the material reviewed so far; offsets below are therefore implementation findings for this instrument layout, not a claim about every OHSP model or firmware version.

## Confirmed file structure

- The file begins with the ASCII instrument identifier `OHSP-350SF`.
- The capture date is stored as a 10-byte ASCII string (`YYYY-MM-DD`) at offset `0x158`, followed by a null terminator at `0x162`.
- The capture time is stored as an 8-byte ASCII string (`HH:MM:SS`) at offset `0x163`, followed by a null terminator at `0x16B`.
- Both fields are optional for parsing: missing or unrecognized values are treated as unavailable and never invalidate otherwise valid spectral data.
- The spectral sample block begins at byte offset `0x16C`.
- The block contains **601 little-endian IEEE-754 32-bit floating-point values**.
- The 601 samples represent consecutive 1 nm wavelength steps.
- The first and last wavelength values are stored in the final eight bytes of the file:
  - the 32-bit float at `fileSize - 8` is the start wavelength in nm;
  - the 32-bit float at `fileSize - 4` is the end wavelength in nm.
- The sample values are retained exactly as stored, including leading zero values. A zero at the start of the spectrum is valid data and must not be used as a reason to shift the sample offset.

For the supplied sample, the trailing values are **350 nm** and **950 nm**. Together with the 601 samples, this gives a 1 nm interval:

`(950 - 350) / (601 - 1) = 1 nm`.

The wavelength range is read from each file rather than being hard-coded to 350–950 nm. The currently supported sample-block offset and count remain specific to the confirmed OHSP-350SF layout.

## Spectrum rendering

The spectrum chart is generated directly as a raster image; it does not require SVG loading.

- The horizontal axis is scaled from the file's start wavelength to its end wavelength.
- The spectral curve uses all 601 sample values.
- The area between the curve and the zero baseline is filled vertically.
- The fill and curve colour are derived from the corresponding wavelength, using a wavelength-to-colour gradient.
- The thumbnail and full-size chart are encoded as Ultra HDR JPEGs using linear scRGB pixels.
- The full-size chart is encoded as an Ultra HDR JPEG using linear scRGB pixels.
- The full-size chart identifies the measurement model and includes capture date/time only when valid values can be read from the header.
- It finds the maximum of all 601 spectral samples, marks the peak with a dashed vertical guide, and prints its exact wavelength and measured value in `mW/m2/nm` above the plot.
- Peak annotations are added to full-size charts only; thumbnail layout remains compact.
- The full-size chart uses a pure-black canvas; the background is not lifted to charcoal or grey during HDR conversion.
- The Image / View presentation classifies `.ohsp` files as HDR because their full-size derivatives are Ultra HDR JPEGs; the SDR source-file metadata alone must not force the generated chart into SDR presentation.
- Both thumbnail and full-size OHSP chart canvases are created directly as linear scRGB Float32 buffers; no SDR byte-buffer drawing or SDR-to-float conversion is used.
- The wavelength-coloured band below the X axis uses the same gradient as the spectrum fill, with a substantially brighter HDR core and broader light halo (scRGB peaks up to 12.0).
- The PEAK annotation also receives a gold HDR halo and a near-white emissive core.
- All glowing elements exceed reference white and are visibly emissive on HDR-capable displays; SDR displays tone-map them to the available range.
- Both thumbnail and full-size OHSP charts are encoded as Ultra HDR JPEGs. Thumbnail previews use a strong emissive wavelength-coloured gradient beneath the spectral curve. Full-size charts use a brighter saturated HDR gradient beneath the curve, with a strongly emissive peak guide and wavelength-band glow while keeping the white core restrained. The full-size chart also contains a large, emissive LumaScope exact `lumascope.ico` application icon resolved from the packaged app assets or source asset folder and composited directly into the generated image, with the local generation date and time burned in directly below it; neither is a viewer overlay. The timestamp uses the computer's local time and changes when the derivative is regenerated.
- OHSP thumbnails use cache version 11 and the `ohsp-uhdr-v5` derivative tag. The worker reopens each generated thumbnail, verifies that an Ultra HDR gain map exists, decodes it back to scRGB, and checks that the decoded peak exceeds 1.5× reference white. Previously cached thumbnails are regenerated. The full-size cache tag is `ohsp-full-spectrum-v13` (cache version 33).
- The source `.ohsp` file is not modified.

The zero-valued leading samples remain part of the curve. They are not skipped, trimmed or reinterpreted.

## CSV export observations

The matching CSV export identifies the instrument as `OHSP-350SF` and reports:

- `Start Wave(nm)` and `End Wave(nm)`;
- a `Spectrum Data(mW/m2/nm)` section;
- wavelength rows from 350 nm through 950 nm in 1 nm increments;
- 601 spectral positions per measurement column.

The CSV also contains measurement summaries and additional instrument/product/electrical fields. Those fields are **not currently parsed by LumaScope**. In particular, flicker frequency, fluctuation depth, flicker percentage and flicker exponent are intentionally left out of the current implementation.

## Current limitations

- Only the OHSP-350SF binary layout described above is currently supported.
- The sample block uses the confirmed offset `0x16C` and 601 float samples. Other OHSP instrument variants may use a different layout and are not guessed or auto-detected.
- Measurement summary values such as illuminance, CCT, CRI/Ra, dominant wavelength, flicker metrics and electrical parameters are not extracted. The peak value shown on the chart is calculated directly from the spectral sample block.
- The chart visualizes the spectral samples; it is not a full reproduction of the manufacturer's measurement report.

## Cache behaviour

LumaScope creates both the thumbnail and the full-size chart as Ultra HDR JPEGs in the normal sidecar cache. Both derivatives are generated from linear scRGB Float32 canvases. The cache format version is tracked separately so that changes to the OHSP parser or chart renderer can regenerate previously cached output.

## References and evidence

The implementation details above are based on inspection of supplied OHSP-350SF binary data and comparison with its CSV export. A hex dump confirms the ASCII date `2023-11-17` at `0x158`, the ASCII time `23:34:06` at `0x163`, the spectral data at `0x16C` (including valid leading zeros), and final float values of 350 and 950. The date/time offsets are confirmed for this inspected OHSP-350SF sample; these findings do not establish the binary layout of other OHSP models.
