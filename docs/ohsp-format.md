# OHSP spectral measurement file format

[Back to supported image formats](image-formats.md) · [Image detail table](image-detail-table.md) · [Back to README](../README.md)

## Scope

LumaScope currently supports the **OHSP-350SF** `.ohsp` measurement-file layout. It does not treat the file as a conventional photograph. Instead, it generates a raster chart of the measured spectral power distribution. The generated chart is used for both the thumbnail and full-size cache.

This document records the file-layout observations confirmed with an OHSP-350SF sample and its matching CSV export. The binary layout is not publicly documented in the material reviewed so far; offsets below are therefore implementation findings for this instrument layout, not a claim about every OHSP model or firmware version.

## Confirmed file structure

- The file begins with the ASCII instrument identifier `OHSP-350SF`.
- The supplied file stores the measurement date as ASCII at byte offset `0x156` (10 characters, `YYYY-MM-DD`) and the measurement time at `0x163` (8 characters, `HH:MM:SS`). These offsets are confirmed against the supplied binary and matching CSV export.
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

The spectrum chart is generated directly as an RGB raster image; it does not require SVG loading.

- The horizontal axis is scaled from the file's start wavelength to its end wavelength.
- The spectral curve uses all 601 sample values.
- The area between the curve and the zero baseline is filled vertically.
- The fill and curve colour are derived from the corresponding wavelength, using a wavelength-to-colour gradient.
- The chart is encoded as JPEG for the thumbnail and full-size cache.
- The full-size chart identifies the measurement model and the capture date/time from the OHSP header.
- It finds the maximum of all 601 spectral samples, marks the peak with a dashed vertical guide, and prints its exact wavelength and measured value in `mW/m2/nm` above the plot.
- Peak annotations are added to full-size charts only; thumbnail layout remains compact.
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

LumaScope creates a thumbnail and a full-size JPEG chart in the normal sidecar cache. The cache format version is tracked separately so that changes to the OHSP parser or chart renderer can regenerate previously cached output.

## References and evidence

The implementation details above are based on inspection of the supplied OHSP-350SF binary file and comparison with its CSV export. The file begins with the `OHSP-350SF` identifier, the spectral data at `0x16C` includes valid leading zeros, and the final two float values in the sample are 350 and 950. These findings confirm the current supported sample layout; they do not establish the binary layout of other OHSP models.
