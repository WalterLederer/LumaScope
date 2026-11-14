# Supported image formats

[Back to README](../README.md)

Bit depth is per channel unless stated otherwise. HDR capability is format- and file-dependent; the presence of a format in this table does not mean every file using that extension contains HDR data.

| Format | Extensions | HDR path | Full-size cache | Bit depth | Decoder / conversion path | Details |
| --- | --- | --- | --- | --- | --- | --- |
| AVIF | `.avif` | Yes | Yes | 8, 10 or 12 bit/channel | wasm-vips / libvips; custom PQ/HLG to scRGB for HDR | HDR preview for Rec. 2020 PQ and HLG profiles. |
| BMP | `.bmp` | No | No | 1, 4, 8, 16, 24 or 32 bit/pixel | Chromium / Electron | Raster bitmap format. |
| GIF | `.gif` | No | No | Up to 8 bit indexed colour | Chromium / Electron | Palette-based raster format; animation is supported by the image viewer. |
| HEIF / HEIC | `.heif`, `.heic` | Yes | Yes | 8 bit SDR; HDR 10 bit and above | libheif-js + wasm-vips; custom PQ/HLG HDR path | HDR preview for Rec. 2020 PQ and HLG profiles. |
| JPEG | `.jpg`, `.jpeg` | No, normally SDR | No | 8 bit/channel | Chromium / Electron | Raster image, usually SDR. Ultra HDR JPEG is listed separately because it carries a gain map. |
| JPEG XL | `.jxl` | Yes, when present and exposed by decoder | No | 8–16 bit integer; 16/32 bit float | Chromium / Electron | Supports high bit depth and HDR where the file and decoder expose it. |
| JPEG XR | `.jxr` | Yes | Yes | 8/16 bit integer; 16/32 bit float | jpegxr + wasm-vips; HDR converted to scRGB/JPEG for display | High-bit-depth and floating-point images use the HDR display path. |
| OpenEXR | `.exr` | Yes | Yes | 16 bit half or 32 bit float | exrs; EXR converted to scRGB/JPEG for display | HDR; the viewer currently uses the standard RGB channels. |
| PNG | `.png` | Yes, for supported high-bit-depth content | No | 1/2/4/8/16 bit/channel | Chromium / Electron | Lossless raster format with transparency and high-bit-depth support. |
| Radiance HDR | `.hdr` | Yes | Yes | 32 bit RGBE per pixel | wasm-vips / libvips; expanded to floating-point RGB and converted for display | Radiance RGBE image format. |
| SVG | `.svg` | No | No | Not applicable | Chromium / Electron | Vector graphics; rasterized for display at the required size. |
| TIFF | `.tif`, `.tiff` | Yes, depending on file | Yes | Depends on file; common 8/16 bit integer and float variants | wasm-vips / libvips; custom HDR conversion path | 16-bit HDR TIFF images use the HDR display path; other TIFFs are converted for display. |
| Ultra HDR JPEG | `.jpg`, `.jpeg` | Yes, when an embedded gain map is supported | No | 8 bit base image + HDR gain map | Chromium / Electron native image path | JPEG with an embedded gain map; HDR is displayed when the image contains a supported gain map. |
| WebP | `.webp` | No | No | 8 bit/channel | Chromium / Electron | Lossy or lossless raster format with transparency and animation. |

## Decoder notes

The application uses several decoding families:

- **Chromium / Electron** for formats handled by the browser image decoder.
- **wasm-vips / libvips** for AVIF, Radiance HDR, TIFF and parts of the HDR conversion pipeline.
- **libheif-js + wasm-vips** for HEIF and HEIC.
- **jpegxr** for JPEG XR decoding and conversion.
- **exrs** for OpenEXR.

Some formats use an intermediate converted image for display. The full-size cache column indicates whether LumaScope generates and manages a full-size converted cache entry for that format; it does not indicate whether the original file is modified.
