import { closeSync, openSync, readSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { parentPort } from 'node:worker_threads';
import { ImageHistogram } from 'internal-api';
import Vips from 'wasm-vips';

export interface ThumbWorkerGenerateRequest {
  type?: 'generate';
  id: string;
  source: string;
  target: string;
  width: number;
  height: number;
  preserveAspectRatio?: boolean;
}

export interface ThumbWorkerCancelRequest {
  type: 'cancel';
  id: string;
}

export interface ThumbWorkerHistogramRequest {
  type: 'histogram';
  id: string;
  source: string;
}

export type ThumbWorkerRequest = ThumbWorkerGenerateRequest | ThumbWorkerCancelRequest | ThumbWorkerHistogramRequest;

export interface ThumbWorkerResponse {
  id: string;
  success: boolean;
  error?: string;
  histogram?: ImageHistogram;
  isHdr?: boolean;
}

type UhdrSaveImage = {
  uhdrsave: (target: string, options: { Q: number }) => void;
};

/** Shared Ultra HDR encoder entry point for every HDR-capable source decoder. */
function encodeScRgbAsUhdr(image: UhdrSaveImage, target: string, quality = 90): void {
  image.uhdrsave(target, { Q: quality });
}

const cancelledRequests = new Set<string>();

let vipsInstance: typeof Vips | null = null;
interface JpegXrDecoder {
  decode: (data: Uint8Array) => {
    width: number;
    height: number;
    pixelInfo: { bitDepth: string; channels: number; bgr: boolean; colorFormat?: string; bitsPerPixel?: number; hasAlpha?: boolean; premultipliedAlpha?: boolean };
    bytes: Uint8Array;
  };
}

interface AvifColorProfile {
  primaries: number;
  transfer: number;
}

interface HeifImage {
  handle: unknown;
  free: () => void;
  get_width: () => number;
  get_height: () => number;
  display: (
    imageData: { data: Uint8ClampedArray; width: number; height: number },
    callback: (result: { data: Uint8ClampedArray; width: number; height: number } | null) => void
  ) => void;
}

interface HeifDecodeResult {
  image: unknown;
  width: number;
  height: number;
  channels: Array<{ data: Uint8Array; stride: number; bits_per_pixel: number }>;
}

interface HeifDecoderModule {
  HeifDecoder: new () => { decoder: unknown; decode: (data: Uint8Array) => HeifImage[] };
  heif_context_free: (context: unknown) => void;
  heif_colorspace: { heif_colorspace_RGB: unknown };
  heif_chroma: { heif_chroma_interleaved_RRGGBB_LE: unknown };
  heif_js_decode_image2: (handle: unknown, colorSpace: unknown, chroma: unknown) => HeifDecodeResult;
  heif_image_release: (image: unknown) => void;
}

interface ExrDecoderModule {
  init: () => Promise<void>;
  decodeRgbExr: (data: Uint8Array) => {
    width: number;
    height: number;
    interleavedRgbPixels: Float32Array;
  };
}

let jpegxrInstance: Promise<JpegXrDecoder> | null = null;
let heifDecoderModule: HeifDecoderModule | null = null;
let exrDecoderModule: Promise<ExrDecoderModule> | null = null;
const transferLuts = new Map<number, Float32Array>();

interface LibRawProcessedImage {
  type_: string;
  width: number;
  height: number;
  colors: number;
  bits: number;
  data_size: number;
  data: Uint8Array;
}

interface LibRawDecoder {
  waitUntilReady: () => Promise<void>;
  open: (data: ArrayBuffer) => void;
  unpack: () => void;
  dcrawProcess: () => void;
  dcrawMakeMemImage: () => LibRawProcessedImage;
  setOutputColor: (value: number) => void;
  setOutputBps: (value: number) => void;
  setGamma: (index: number, value: number) => void;
  setNoAutoBright: (value: number) => void;
  setUseCameraWb: (value: number) => void;
  setHalfSize: (value: number) => void;
  dispose: () => void;
}

interface LibRawConstructor {
  new (): LibRawDecoder;
  initialize: (input?: ArrayBuffer | Response) => Promise<void>;
}

interface EmscriptenHeapModule {
  HEAPU8?: Uint8Array;
}

function getLibRawWasmHeapCapacity(LibRaw: LibRawConstructor): number | null {
  const module = (LibRaw as unknown as { module?: EmscriptenHeapModule }).module;
  return module?.HEAPU8?.buffer.byteLength ?? null;
}

function getWorkerErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = (error as { message?: unknown } | null)?.message;
  if (Array.isArray(message)) {
    return message.map(value => String(value)).filter(Boolean).join(': ');
  }
  if (typeof message === 'string') return message;
  return String(error);
}

function formatMemoryBytes(bytes: number | null): string {
  if (bytes === null) return 'unavailable';
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

let libRawConstructorPromise: Promise<LibRawConstructor> | null = null;

const cameraRawExtensions = new Set([ '.dng', '.rw2', '.raw' ]);

async function getLibRawConstructor(): Promise<LibRawConstructor> {
  if (!libRawConstructorPromise) {
    libRawConstructorPromise = (async () => {
      const { LibRaw } = await import('@colorhythm/libraw-wasm');
      // The package resolves its WASM payload relative to its own module URL.
      // require.resolve() is rewritten by webpack to a numeric module ID in workers,
      // which is not a filesystem path and cannot be passed to fs.readFile().
      await LibRaw.initialize();
      return LibRaw as unknown as LibRawConstructor;
    })();
  }

  return libRawConstructorPromise;
}

/** Develop a camera RAW file to linear scRGB. Thumbnail callers downsample 16-bit data before creating the Float32 image. */
async function decodeCameraRawToVips(
  vips: typeof Vips,
  source: string,
  halfSize = false,
  maxDimension = 0
): Promise<Vips.Image> {
  const LibRaw = await getLibRawConstructor();
  const libRawHeapInitialCapacity = getLibRawWasmHeapCapacity(LibRaw);
  const decoder = new LibRaw();
  await decoder.waitUntilReady();

  let decoderDisposed = false;
  let scaledPixels: Uint16Array;
  let width = 0;
  let height = 0;

  try {
    let input: Buffer | null = await readFile(source);
    const inputBytes = input.byteLength;
    let inputBuffer: ArrayBuffer | null = new ArrayBuffer(input.byteLength);
    new Uint8Array(inputBuffer).set(input);

    // LibRaw.open() copies this buffer into its own WASM heap. Release the
    // duplicate JavaScript input buffers immediately after that copy.
    decoder.open(inputBuffer);
    inputBuffer = null;
    input = null;
    decoder.setUseCameraWb(1);
    decoder.setOutputColor(1);
    decoder.setOutputBps(16);
    // Half-size decoding reduces LibRaw's initial bitmap for thumbnails/histograms.
    decoder.setHalfSize(halfSize ? 1 : 0);
    decoder.setGamma(1, 1);
    decoder.setNoAutoBright(1);
    decoder.unpack();
    decoder.dcrawProcess();

    const decoded = decoder.dcrawMakeMemImage();
    width = decoded.width;
    height = decoded.height;
    const expectedBytes = width * height * decoded.colors * 2;
    const libRawHeapCapacity = getLibRawWasmHeapCapacity(LibRaw);

    // dcrawMakeMemImage() returns an owned JavaScript copy of LibRaw's output.
    // The decoder's input, unpacked sensor data and post-processing buffers are
    // no longer needed, so release its WASM allocations before libvips starts.
    decoder.dispose();
    decoderDisposed = true;

    if (decoded.type_ !== 'LIBRAW_IMAGE_BITMAP' || decoded.bits !== 16 ||
      decoded.colors !== 3 || width <= 0 || height <= 0 ||
      decoded.data_size !== expectedBytes || decoded.data.byteLength < expectedBytes) {
      throw new Error(
        `LibRaw returned an unsupported camera RAW image (${width}x${height}, ${decoded.colors} channels, ${decoded.bits} bits).`
      );
    }

    // Let libvips resize the compact 16-bit bitmap first. Creating a full-size
    // Float32 RGB buffer here used about 137 MiB for half-resolution S25 Ultra
    // DNGs, exceeding the WASM image-memory limit before thumbnail encoding.
    const rawPixels = new Uint16Array(
      decoded.data.buffer,
      decoded.data.byteOffset,
      expectedBytes / Uint16Array.BYTES_PER_ELEMENT
    );
    using rawImage = vips.Image.newFromMemory(
      rawPixels,
      width,
      height,
      3,
      vips.BandFormat.ushort
    );
    const scale = maxDimension > 0 ? Math.min(1, maxDimension / Math.max(width, height)) : 1;
    using scaledRawImage = scale < 1
      ? rawImage.resize(scale, { kernel: vips.Kernel.linear })
      : rawImage.copy();
    const resizedPixels = scaledRawImage.writeToMemory();
    if (!(resizedPixels instanceof Uint16Array)) {
      throw new Error('libvips returned an unexpected pixel format while resizing the camera RAW thumbnail.');
    }
    scaledPixels = resizedPixels;

    width = scaledRawImage.width;
    height = scaledRawImage.height;

    const vipsHeapCapacity = (vips as unknown as EmscriptenHeapModule).HEAPU8?.buffer.byteLength ?? null;
    console.info(
      `[RawMemory] ${source}: ${width}x${height}, ${halfSize ? 'half-size' : 'full-size'}; ` +
      `file=${formatMemoryBytes(inputBytes)}; ` +
      `LibRaw WASM heap initial/after decode=${formatMemoryBytes(libRawHeapInitialCapacity)} / ${formatMemoryBytes(libRawHeapCapacity)}; ` +
      `decoded RGB16=${formatMemoryBytes(decoded.data.byteLength)}; ` +
      `resized RGB16 copy=${formatMemoryBytes(scaledPixels.byteLength)}; ` +
      `Float32 RGB=lazy libvips conversion; ` +
      `libvips WASM heap=${formatMemoryBytes(vipsHeapCapacity)}; ` +
      `libvips tracked=${formatMemoryBytes(vips.Stats.mem())}; ` +
      `libvips worker high-water=${formatMemoryBytes(vips.Stats.memHighwater())}.`
    );

  } finally {
    if (!decoderDisposed) {
      decoder.dispose();
    }
  }

  // Convert the resized 16-bit RGB pixels to linear Float32 inside libvips.
  // A JavaScript Float32Array would add another 137 MiB full-size allocation
  // before libvips creates its own image buffer, which can exceed the fixed
  // 1-GiB wasm-vips memory even though the source bitmap is only 68.7 MiB.
  using resizedImage = vips.Image.newFromMemory(
    scaledPixels!,
    width,
    height,
    3,
    vips.BandFormat.ushort
  );
  using floatImage = resizedImage.cast(vips.BandFormat.float);
  using linearImage = floatImage.linear([ 1 / 65535 ], [ 0 ]);
  return linearImage.copy({ interpretation: vips.Interpretation.scrgb });
}


async function getVips(): Promise<typeof Vips> {
  if (!vipsInstance) {
    vipsInstance = await Vips();
    // The gallery processes mostly unique files, so operation caching only retains
    // decoded source graphs without providing useful cache hits.
    vipsInstance.Cache.max(0);
    vipsInstance.Cache.maxMem(0);
  }
  return vipsInstance;
}

function getJpegXr() {
  if (!jpegxrInstance) {
    const createJpegXr = require('jpegxr') as () => Promise<JpegXrDecoder>;
    jpegxrInstance = createJpegXr();
  }

  return jpegxrInstance;
}

function getHeifDecoder(): HeifDecoderModule {
  if (!heifDecoderModule) {
    heifDecoderModule = require('libheif-js/wasm-bundle') as HeifDecoderModule;
  }

  return heifDecoderModule;
}

function releaseHeifImage(module: HeifDecoderModule, decoder: InstanceType<HeifDecoderModule['HeifDecoder']>, image?: HeifImage) {
  image?.free();
  if (decoder.decoder) {
    module.heif_context_free(decoder.decoder);
    decoder.decoder = null;
  }
}

function getExrDecoder(): Promise<ExrDecoderModule> {
  if (!exrDecoderModule) {
    const decoder = require('exrs') as ExrDecoderModule;
    exrDecoderModule = decoder.init().then(() => decoder);
  }

  return exrDecoderModule;
}

function decodeHeifToRgba(data: Uint8Array): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const module = getHeifDecoder();
  const decoder = new module.HeifDecoder();
  const image = decoder.decode(data)[0];

  if (!image) {
    releaseHeifImage(module, decoder);
    throw new Error('The HEIF file does not contain a decodable image.');
  }

  const width = image.get_width();
  const height = image.get_height();
  const imageData = { data: new Uint8ClampedArray(width * height * 4), width, height };

  return new Promise((resolve, reject) => {
    try {
      image.display(imageData, result => {
        releaseHeifImage(module, decoder, image);

        if (result) {
          resolve(result);
        } else {
          reject(new Error('The HEIF image could not be decoded.'));
        }
      });
    } catch (error) {
      releaseHeifImage(module, decoder, image);
      reject(error);
    }
  });
}

function decodeHeifHdrToVips(vips: typeof Vips, data: Uint8Array) {
  const module = getHeifDecoder();
  const decoder = new module.HeifDecoder();
  const image = decoder.decode(data)[0];

  if (!image) {
    releaseHeifImage(module, decoder);
    throw new Error('The HEIF file does not contain a decodable image.');
  }

  const width = image.get_width();
  const height = image.get_height();

  const decoded = module.heif_js_decode_image2(
    image.handle,
    module.heif_colorspace.heif_colorspace_RGB,
    module.heif_chroma.heif_chroma_interleaved_RRGGBB_LE
  );

  try {
    const channel = decoded.channels[0];
    const bits = channel?.bits_per_pixel ?? 0;
    const stride = channel?.stride ?? 0;

    if (!decoded.image || !channel || bits < 8 || bits > 16 || stride < width * 6) {
      throw new Error(`Unsupported HEIF HDR pixel format: ${bits} bits per channel.`);
    }

    const maxCode = (1 << bits) - 1;
    const pixels = new Uint16Array(width * height * 3);
    const view = new DataView(channel.data.buffer, channel.data.byteOffset, channel.data.byteLength);

    for (let y = 0; y < height; y++) {
      let sourceOffset = y * stride;
      let targetOffset = y * width * 3;

      for (let x = 0; x < width; x++) {
        pixels[targetOffset++] = Math.round(view.getUint16(sourceOffset, true) * 65535 / maxCode);
        pixels[targetOffset++] = Math.round(view.getUint16(sourceOffset + 2, true) * 65535 / maxCode);
        pixels[targetOffset++] = Math.round(view.getUint16(sourceOffset + 4, true) * 65535 / maxCode);
        sourceOffset += 6;
      }
    }

    return vips.Image.newFromMemory(pixels, width, height, 3, vips.BandFormat.ushort);
  } finally {
    if (decoded.image) {
      module.heif_image_release(decoded.image);
    }
    releaseHeifImage(module, decoder, image);
  }
}

function halfFloatToFloat(half: number): number {
  const sign = half & 0x8000 ? -1 : 1;
  const exponent = (half >>> 10) & 0x1f;
  const fraction = half & 0x03ff;

  if (exponent === 0) {
    return sign * Math.pow(2, -14) * (fraction / 1024);
  }

  if (exponent === 0x1f) {
    return fraction === 0 ? sign * Infinity : Number.NaN;
  }

  return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
}


function summarizeJxrPixels(values: ArrayLike<number>, channels: number, scale = 1) {
  const channelNames = [ 'R', 'G', 'B', 'A' ];
  const stats = Array.from({ length: channels }, (_, channel) => ({
    channel: channelNames[channel] ?? String(channel),
    min: Infinity,
    max: -Infinity,
    negative: 0,
    zero: 0,
    aboveOne: 0,
    nonFinite: 0
  }));

  for (let index = 0; index + channels <= values.length; index += channels) {
    for (let channel = 0; channel < channels; channel++) {
      const value = Number(values[index + channel]) * scale;
      const item = stats[channel];

      if (!Number.isFinite(value)) {
        item.nonFinite++;
        continue;
      }

      item.min = Math.min(item.min, value);
      item.max = Math.max(item.max, value);
      if (value < 0) item.negative++;
      if (value === 0) item.zero++;
      if (value > 1) item.aboveOne++;
    }
  }

  return stats.map(item => ({
    ...item,
    min: Number.isFinite(item.min) ? item.min : null,
    max: Number.isFinite(item.max) ? item.max : null
  }));
}

function summarizePixelRegion(
  values: ArrayLike<number>,
  imageWidth: number,
  imageHeight: number,
  channels: number,
  region: { left: number; top: number; width: number; height: number },
  scale = 1
) {
  const left = Math.max(0, Math.min(imageWidth, Math.floor(region.left)));
  const top = Math.max(0, Math.min(imageHeight, Math.floor(region.top)));
  const right = Math.max(left, Math.min(imageWidth, Math.ceil(region.left + region.width)));
  const bottom = Math.max(top, Math.min(imageHeight, Math.ceil(region.top + region.height)));
  const channelNames = [ 'R', 'G', 'B', 'A' ];
  const results = Array.from({ length: channels }, (_, channel) => ({
    channel: channelNames[channel] ?? String(channel),
    min: Infinity,
    max: -Infinity,
    sum: 0,
    values: [] as number[],
    maxPosition: null as { x: number; y: number } | null,
    nonFinite: 0
  }));

  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const pixelOffset = (y * imageWidth + x) * channels;
      for (let channel = 0; channel < channels; channel++) {
        const value = Number(values[pixelOffset + channel]) * scale;
        const item = results[channel];
        if (!Number.isFinite(value)) {
          item.nonFinite++;
          continue;
        }
        item.min = Math.min(item.min, value);
        item.sum += value;
        item.values.push(value);
        if (value > item.max) {
          item.max = value;
          item.maxPosition = { x, y };
        }
      }
    }
  }

  return {
    region: { left, top, right, bottom, width: right - left, height: bottom - top },
    pixelCount: (right - left) * (bottom - top),
    channels: results.map(item => {
      item.values.sort((a, b) => a - b);
      const percentile = (p: number) => item.values.length
        ? item.values[Math.min(item.values.length - 1, Math.max(0, Math.ceil(p / 100 * item.values.length) - 1))]
        : null;
      return {
        channel: item.channel,
        min: Number.isFinite(item.min) ? item.min : null,
        max: Number.isFinite(item.max) ? item.max : null,
        mean: item.values.length ? item.sum / item.values.length : null,
        median: percentile(50),
        p90: percentile(90),
        p99: percentile(99),
        p99_9: percentile(99.9),
        maxPosition: item.maxPosition,
        nonFinite: item.nonFinite
      };
    })
  };
}

function summarizeDetailedRgbPixels(values: ArrayLike<number>, sampleLimit = 250_000, scale = 1) {
  const channels = 3;
  const pixelCount = Math.floor(values.length / channels);
  const sampleCount = Math.min(pixelCount, sampleLimit);
  const sampleStride = Math.max(1, Math.floor(pixelCount / sampleCount));
  const channelNames = [ 'R', 'G', 'B' ];
  const percentiles = [ 0.01, 0.1, 1, 10, 50, 90, 99, 99.9, 99.99 ];
  const results = channelNames.map((channel, channelIndex) => {
    const samples = new Float64Array(sampleCount);
    let sampleIndex = 0;
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let negative = 0;
    let zero = 0;
    let atOrBelow0001 = 0;
    let atOrBelow001 = 0;
    let atOrBelow01 = 0;
    let aboveOne = 0;
    let aboveFour = 0;
    let aboveTen = 0;
    let aboveTwenty = 0;
    let nonFinite = 0;

    for (let pixel = 0; pixel < pixelCount; pixel++) {
      const value = Number(values[pixel * channels + channelIndex]) * scale;

      if (!Number.isFinite(value)) {
        nonFinite++;
        continue;
      }

      min = Math.min(min, value);
      max = Math.max(max, value);
      sum += value;
      if (value < 0) negative++;
      if (value === 0) zero++;
      if (value <= 0.0001) atOrBelow0001++;
      if (value <= 0.001) atOrBelow001++;
      if (value <= 0.01) atOrBelow01++;
      if (value > 1) aboveOne++;
      if (value > 4) aboveFour++;
      if (value > 10) aboveTen++;
      if (value > 20) aboveTwenty++;

      if (pixel % sampleStride === 0 && sampleIndex < sampleCount) {
        samples[sampleIndex++] = value;
      }
    }

    const sortedSamples = Array.from(samples.subarray(0, sampleIndex)).sort((a, b) => a - b);
    const sampledPercentiles = Object.fromEntries(percentiles.map(percentile => {
      const index = Math.min(sortedSamples.length - 1, Math.max(0, Math.ceil(percentile / 100 * sortedSamples.length) - 1));
      return [String(percentile), sortedSamples.length ? sortedSamples[index] : null];
    }));

    return {
      channel,
      min: Number.isFinite(min) ? min : null,
      max: Number.isFinite(max) ? max : null,
      mean: pixelCount - nonFinite > 0 ? sum / (pixelCount - nonFinite) : null,
      negative,
      zero,
      atOrBelow0001,
      atOrBelow001,
      atOrBelow01,
      aboveOne,
      aboveFour,
      aboveTen,
      aboveTwenty,
      nonFinite,
      percentileSample: {
        count: sampleIndex,
        stride: sampleStride,
        values: sampledPercentiles
      }
    };
  });

  return { pixelCount, sampleLimit, channels: results };
}

interface JxrContainerMetadata {
  byteOrder: 'little-endian' | 'unknown';
  version: number | null;
  firstIfdOffset: number | null;
  ifdEntries: number;
  colorSpace: { tag: number; type: number; count: number; value: number | number[] | null } | null;
  pixelFormat: { tag: number; type: number; count: number; hex: string } | null;
  iccProfile: { offset: number; size: number; signature: string; version: string; deviceClass: string; dataColorSpace: string; connectionSpace: string; renderingIntent: number; xyzColorantTags: string[] } | null;
  warnings: string[];
}

function inspectJxrContainer(data: Uint8Array): JxrContainerMetadata {
  const result: JxrContainerMetadata = {
    byteOrder: 'unknown', version: null, firstIfdOffset: null, ifdEntries: 0,
    colorSpace: null, pixelFormat: null, iccProfile: null, warnings: []
  };
  if (data.length < 8 || data[0] !== 0x49 || data[1] !== 0x49 || data[2] !== 0xBC) {
    result.warnings.push('Not a recognized little-endian JPEG XR tag-based container header.');
    return result;
  }
  result.byteOrder = 'little-endian';
  result.version = data[3];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ifdOffset = view.getUint32(4, true);
  result.firstIfdOffset = ifdOffset;
  if (ifdOffset < 8 || ifdOffset + 2 > data.length) {
    result.warnings.push('First IFD offset is outside the file.');
    return result;
  }
  const entryCount = view.getUint16(ifdOffset, true);
  const entriesStart = ifdOffset + 2;
  const entriesEnd = entriesStart + entryCount * 12;
  if (entriesEnd + 4 > data.length) {
    result.warnings.push('First IFD entries exceed the file boundary.');
    return result;
  }
  result.ifdEntries = entryCount;
  const typeSizes: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
  for (let index = 0; index < entryCount; index++) {
    const entryOffset = entriesStart + index * 12;
    const tag = view.getUint16(entryOffset, true);
    const type = view.getUint16(entryOffset + 2, true);
    const count = view.getUint32(entryOffset + 4, true);
    const typeSize = typeSizes[type];
    if (!typeSize || count === 0) continue;
    const byteLength = typeSize * count;
    const valueOffset = byteLength <= 4 ? entryOffset + 8 : view.getUint32(entryOffset + 8, true);
    if (valueOffset + byteLength > data.length) {
      if (tag === 0xA001 || tag === 0xBC01 || tag === 34675) result.warnings.push(`Metadata tag 0x${tag.toString(16)} points outside the file.`);
      continue;
    }
    if (tag === 0xA001) {
      const values: number[] = [];
      for (let item = 0; item < Math.min(count, 16); item++) values.push(type === 3 ? view.getUint16(valueOffset + item * 2, true) : data[valueOffset + item]);
      result.colorSpace = { tag, type, count, value: values.length === 1 ? values[0] : values };
    } else if (tag === 0xBC01) {
      const bytes = data.subarray(valueOffset, valueOffset + Math.min(byteLength, 16));
      result.pixelFormat = { tag, type, count, hex: Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('') };
    } else if (tag === 34675 && type === 7 && byteLength >= 128) {
      const profile = new DataView(data.buffer, data.byteOffset + valueOffset, byteLength);
      const ascii = (offset: number, length: number) => String.fromCharCode(...data.subarray(valueOffset + offset, valueOffset + offset + length));
      const declaredSize = profile.getUint32(0, false);
      if (ascii(36, 4) !== 'acsp' || declaredSize < 128 || declaredSize > byteLength) {
        result.warnings.push('ICC tag exists, but its profile header is invalid or truncated.');
        continue;
      }
      const tagCount = declaredSize >= 132 ? profile.getUint32(128, false) : 0;
      const xyzColorantTags: string[] = [];
      if (132 + tagCount * 12 <= declaredSize) {
        for (let tagIndex = 0; tagIndex < tagCount; tagIndex++) {
          const tagOffset = 132 + tagIndex * 12, signature = ascii(tagOffset, 4);
          if (['rXYZ', 'gXYZ', 'bXYZ'].includes(signature)) xyzColorantTags.push(signature);
        }
      }
      result.iccProfile = {
        offset: valueOffset, size: declaredSize, signature: ascii(36, 4),
        version: `${profile.getUint8(8)}.${profile.getUint8(9) >> 4}`,
        deviceClass: ascii(12, 4), dataColorSpace: ascii(16, 4), connectionSpace: ascii(20, 4),
        renderingIntent: profile.getUint32(64, false), xyzColorantTags
      };
    }
  }
  return result;
}

function getHeifColorProfile(data: Uint8Array): AvifColorProfile | null {
  for (let index = 0; index <= data.length - 11; index++) {
    if (data[index] === 0x6e && data[index + 1] === 0x63 && data[index + 2] === 0x6c && data[index + 3] === 0x78) {
      return {
        primaries: (data[index + 4] << 8) | data[index + 5],
        transfer: (data[index + 6] << 8) | data[index + 7]
      };
    }
  }

  return null;
}

function hasComfyUiPqVae(source: string): boolean {
  // ComfyUI embeds its workflow in PNG text chunks. This targeted marker also
  // covers files whose HDR colour-profile chunks (cICP/mDCV/cLLI) are absent.
  // Search the raw PNG bytes so both tEXt and uncompressed iTXt metadata work.
  try {
    const data = require('node:fs').readFileSync(source) as Buffer;
    return data.includes(Buffer.from('sdxlRec2100PQVAEFor_v10.safetensors', 'ascii'));
  } catch {
    return false;
  }
}

function getPngColorProfile(source: string): AvifColorProfile | null {
  let fd: number | undefined;

  try {
    fd = openSync(source, 'r');
    const signature = Buffer.alloc(8);

    if (readSync(fd, signature, 0, signature.length, 0) !== signature.length ||
      !signature.equals(Buffer.from([ 137, 80, 78, 71, 13, 10, 26, 10 ]))) {
      return null;
    }

    let offset = 8;

    // PNG colour-profile chunks, including cICP, appear before the image data.
    while (true) {
      const header = Buffer.alloc(8);

      if (readSync(fd, header, 0, header.length, offset) !== header.length) {
        return null;
      }

      const length = header.readUInt32BE(0);
      const type = header.toString('ascii', 4, 8);

      if (type === 'cICP' && length >= 4) {
        const profile = Buffer.alloc(4);

        if (readSync(fd, profile, 0, profile.length, offset + 8) !== profile.length) {
          return null;
        }

        return { primaries: profile[0], transfer: profile[1] };
      }

      if (type === 'IDAT' || type === 'IEND') {
        return null;
      }

      offset += 12 + length;
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function getHdrTransferLut(transfer: number): Float32Array {
  const cached = transferLuts.get(transfer);
  if (cached) {
    return cached;
  }

  const lut = new Float32Array(65536);

  for (let code = 0; code < lut.length; code++) {
    const value = code / 65535;

    if (transfer === 16) {
      const m1 = 2610 / 16384;
      const m2 = 2523 / 32;
      const c1 = 3424 / 4096;
      const c2 = 2413 / 128;
      const c3 = 2392 / 128;
      const powered = Math.pow(value, 1 / m2);
      const numerator = Math.max(powered - c1, 0);
      const denominator = c2 - c3 * powered;
      lut[code] = Math.pow(numerator / denominator, 1 / m1) * 10000 / 80;
    } else {
      const a = 0.17883277;
      const b = 1 - 4 * a;
      const c = 0.5 - a * Math.log(4 * a);
      lut[code] = value <= 0.5
        ? value * value / 3
        : (Math.exp((value - c) / a) + b) / 12;
    }
  }

  transferLuts.set(transfer, lut);
  return lut;
}

function hlgOotf(vips: typeof Vips, sceneLinear: Vips.Image): Vips.Image {
  using luminanceMatrix = vips.Image.newMatrix(3, 1, [ 0.2627, 0.6780, 0.0593 ]);
  using sceneLuminance = sceneLinear.recomb(luminanceMatrix);
  using displayScale = sceneLuminance.pow(0.2).linear([ 1000 / 80 ], [ 0 ]);
  return sceneLinear.multiply(displayScale);
}

async function histogramForImage(vips: typeof Vips, source: string): Promise<ImageHistogram> {
  const sourceExtension = extname(source).toLowerCase();
  using fullImage = cameraRawExtensions.has(sourceExtension)
    ? await decodeCameraRawToVips(vips, source, true, 512)
    : vips.Image.newFromFile(source, { access: 'random' });
  const scale = Math.min(1, 512 / fullImage.width, 512 / fullImage.height);
  using smallImage = scale < 1 ? fullImage.resize(scale, { kernel: vips.Kernel.linear }) : fullImage.copy();
  using rgb = smallImage.bands >= 3 ? smallImage.extractBand(0, { n: 3 }) : vips.Image.bandjoin([
    smallImage.extractBand(0), smallImage.extractBand(0), smallImage.extractBand(0)
  ]);
  const sdrPixels = rgb.writeToMemory();
  const sdrMax = sdrPixels instanceof Uint8Array ? 255 : sdrPixels instanceof Uint16Array ? 65535 : 1;
  const pixelCount = Math.floor(sdrPixels.length / 3);
  let hdrPixels: typeof sdrPixels | null = null;

  if (fullImage.format === 'float' && cameraRawExtensions.has(sourceExtension)) {
    // Camera RAW development already returns scene-linear scRGB float pixels.
    hdrPixels = rgb.writeToMemory();
  }

  if (!hdrPixels) {
    try {
      using hdrImage = fullImage.uhdr2scRGB();
      using hdrSmall = scale < 1 ? hdrImage.resize(scale, { kernel: vips.Kernel.linear }) : hdrImage.copy();
      using hdrRgb = hdrSmall.bands >= 3 ? hdrSmall.extractBand(0, { n: 3 }) : hdrSmall;
      hdrPixels = hdrRgb.writeToMemory();
    } catch {
      // Ordinary SDR images do not contain an Ultra HDR gain map.
    }
  }

  if (!hdrPixels && fullImage.format === 'uchar' && fullImage.bands >= 3 &&
    extname(source).toLowerCase() === '.png') {
    const profile = getPngColorProfile(source);

    if ((profile?.primaries === 9 && profile.transfer === 16) || hasComfyUiPqVae(source)) {
      // Convert 8-bit Rec. 2020 PQ codes to the 16-bit LUT domain.
      using encodedRgb = fullImage.extractBand(0, { n: 3 }).cast(vips.BandFormat.ushort).linear([ 257 ], [ 0 ]);
      using lut = vips.Image.newFromMemory(getHdrTransferLut(16), 65536, 1, 1, vips.BandFormat.float);
      using linearRec2020 = encodedRgb.maplut(lut);
      using matrix = vips.Image.newMatrix(3, 3, [
        1.660491, -0.587641, -0.072850,
        -0.124550, 1.132900, -0.008349,
        -0.018151, -0.100579, 1.118730
      ]);
      using linearScRgb = linearRec2020.recomb(matrix);
      using smallHdr = scale < 1 ? linearScRgb.resize(scale, { kernel: vips.Kernel.linear }) : linearScRgb.copy();
      hdrPixels = smallHdr.writeToMemory();
    }
  }

  if (!hdrPixels && fullImage.format === 'ushort' && fullImage.bands >= 3 &&
    [ '.jxl', '.png' ].includes(extname(source).toLowerCase())) {
    using encodedRgb = fullImage.extractBand(0, { n: 3 });
    using lut = vips.Image.newFromMemory(getHdrTransferLut(18), 65536, 1, 1, vips.BandFormat.float);
    using sceneLinear = encodedRgb.maplut(lut);
    using linearRec2020 = hlgOotf(vips, sceneLinear);
    using matrix = vips.Image.newMatrix(3, 3, [
      1.660491, -0.587641, -0.072850,
      -0.124550, 1.132900, -0.008349,
      -0.018151, -0.100579, 1.118730
    ]);
    using linearScRgb = linearRec2020.recomb(matrix);
    using smallHdr = scale < 1 ? linearScRgb.resize(scale, { kernel: vips.Kernel.linear }) : linearScRgb.copy();
    hdrPixels = smallHdr.writeToMemory();
  }

  const isFloatHdr = hdrPixels !== null &&
    (hdrPixels instanceof Float32Array || hdrPixels instanceof Float64Array);
  const minimumLogNits = 0.1;
  const linear = {
    white: new Array<number>(128).fill(0),
    red: new Array<number>(128).fill(0),
    green: new Array<number>(128).fill(0),
    blue: new Array<number>(128).fill(0)
  };
  const logarithmic = {
    white: new Array<number>(128).fill(0),
    red: new Array<number>(128).fill(0),
    green: new Array<number>(128).fill(0),
    blue: new Array<number>(128).fill(0)
  };
  const luminance = (r: number, g: number, b: number) =>
    Math.max(0, 0.2126 * r + 0.7152 * g + 0.0722 * b);
  const srgbToLinear = (value: number) => {
    const encoded = Math.max(0, Math.min(1, value));
    return encoded <= 0.04045 ? encoded / 12.92 : Math.pow((encoded + 0.055) / 1.055, 2.4);
  };
  let actualMaximumNits = 0;
  const samples: Array<{ white: number; red: number; green: number; blue: number }> = [];

  for (let index = 0; index < pixelCount; index++) {
    const offset = index * 3;
    let redNits: number;
    let greenNits: number;
    let blueNits: number;

    if (isFloatHdr && hdrPixels && offset + 2 < hdrPixels.length) {
      // Ultra HDR, PQ and HLG decoders above provide linear scRGB values (1.0 = 80 cd/m²).
      redNits = Math.max(0, Number(hdrPixels[offset]) * 80);
      greenNits = Math.max(0, Number(hdrPixels[offset + 1]) * 80);
      blueNits = Math.max(0, Number(hdrPixels[offset + 2]) * 80);
    } else {
      // Interpret ordinary SDR code values as sRGB with reference white at 100 cd/m².
      redNits = srgbToLinear(Number(sdrPixels[offset]) / sdrMax) * 100;
      greenNits = srgbToLinear(Number(sdrPixels[offset + 1]) / sdrMax) * 100;
      blueNits = srgbToLinear(Number(sdrPixels[offset + 2]) / sdrMax) * 100;
    }

    const whiteNits = luminance(redNits, greenNits, blueNits);
    actualMaximumNits = Math.max(actualMaximumNits, whiteNits, redNits, greenNits, blueNits);
    samples.push({ white: whiteNits, red: redNits, green: greenNits, blue: blueNits });
  }

  // Derive the range from this image, not a fixed 10,000 cd/m² ceiling.
  const maximumNits = Math.max(minimumLogNits * 1.01, actualMaximumNits * 1.02);
  const linearBin = (nits: number) =>
    Math.min(127, Math.max(0, Math.floor(nits / maximumNits * 128)));
  const logarithmicBin = (nits: number) =>
    Math.min(127, Math.max(0, Math.floor(
      Math.log(Math.max(minimumLogNits, nits) / minimumLogNits) /
      Math.log(maximumNits / minimumLogNits) * 128
    )));

  for (const sample of samples) {
    for (const channel of [ 'white', 'red', 'green', 'blue' ] as const) {
      linear[channel][linearBin(sample[channel])]++;
      logarithmic[channel][logarithmicBin(sample[channel])]++;
    }
  }

  return {
    linear,
    logarithmic,
    maximumNits,
    minimumLogNits,
    hasGainmap: extname(source).toLowerCase() === '.jpg' || extname(source).toLowerCase() === '.jpeg'
      ? hdrPixels !== null
      : false
  };
}

function hasHdrHeadroom(values: ArrayLike<number>): boolean {
  for (let index = 0; index < values.length; index++) {
    const value = Number(values[index]);
    if (Number.isFinite(value) && value > 1) return true;
  }
  return false;
}

function hasUltraHdrGainMap(vips: typeof Vips, source: string): boolean {
  if (![ '.jpg', '.jpeg' ].includes(extname(source).toLowerCase())) return false;
  try {
    // Read the Ultra HDR metadata only. Decoding the full HDR image merely to
    // determine whether a gain map exists is wasteful for ordinary JPEG files
    // and repeatedly allocates large buffers in the WASM heap.
    using image = vips.Image.newFromFile(source);
    return image.getTypeof('gainmap-data') !== 0;
  } catch {
    return false;
  }
}

// Pre-initialize Vips in worker
getVips().catch(err => {
  console.error('[ThumbWorker] Failed to initialize Vips:', err);
});

function cancelRequest(id: string) {
  parentPort?.postMessage(
    {
      id,
      success: false,
      error: 'Cancelled'
    } satisfies ThumbWorkerResponse
  );
}

if (parentPort) {
  parentPort.on('message', async (request: ThumbWorkerRequest) => {
    if (request.type === 'cancel') {
      cancelledRequests.add(request.id);
      return;
    }

    if (request.type === 'histogram') {
      try {
        const histogram = await histogramForImage(await getVips(), request.source);
        parentPort?.postMessage({ id: request.id, success: true, histogram } satisfies ThumbWorkerResponse);
      } catch (err: unknown) {
        const errorMessage = getWorkerErrorMessage(err);
        parentPort?.postMessage({ id: request.id, success: false, error: errorMessage } satisfies ThumbWorkerResponse);
      }
      return;
    }

    const { id, source, target, width, height, preserveAspectRatio = false } = request;

    console.log(`[ThumbWorker] Processing ${source}...`);
    let processingStage = 'initialization';
    let isHdr = false;

    try {
      if (cancelledRequests.has(id)) {
        cancelRequest(id);
        return;
      }

      try {
        await stat(target);
        parentPort?.postMessage({ id, success: false } satisfies ThumbWorkerResponse);

        return;
      } catch (_) {
        // Target does not exist, proceed to create thumbnail
      }

      if (cancelledRequests.has(id)) {
        cancelRequest(id);
        return;
      }

      const vips = await getVips();

      if (cancelledRequests.has(id)) {
        cancelRequest(id);
        return;
      }

      const sourceExtension = extname(source).toLowerCase();

      if (sourceExtension === '.ohsp') {
        processingStage = 'reading OHSP spectral measurements';
        const data = await readFile(source);
        const instrument = data.toString('ascii', 0, 10);
        if (instrument !== 'OHSP-350SF') throw new Error(`Unsupported OHSP instrument layout: ${instrument || 'unknown'}.`);
        // Capture date/time fields are optional: the binary header layout has
        // not yet been verified across the user's complete OHSP file collection.
        // Never reject an otherwise valid spectrum because these fields are absent
        // or encoded differently. Only show a timestamp when both values validate.
        const rawCaptureDate = data.toString('ascii', 0x156, 0x160).trim();
        const rawCaptureTime = data.toString('ascii', 0x163, 0x16b).trim();
        const captureDate = /^\d{4}-\d{2}-\d{2}$/.test(rawCaptureDate) ? rawCaptureDate : '';
        const captureTime = /^\d{2}:\d{2}:\d{2}$/.test(rawCaptureTime) ? rawCaptureTime : '';
        const captureTimestamp = captureDate && captureTime ? `${captureDate} ${captureTime}` : '';
        const offset = 0x16c;
        const sampleCount = 601;
        const metadataSize = 8;
        if (data.length < offset + sampleCount * 4 + metadataSize) throw new Error('Invalid OHSP file: spectral sample block or trailing wavelength metadata is truncated.');
        // The OHSP-350SF file stores the wavelength range as two little-endian
        // IEEE-754 float values in the final eight bytes: start wavelength, end wavelength.
        const startWavelength = data.readFloatLE(data.length - metadataSize);
        const endWavelength = data.readFloatLE(data.length - 4);
        if (!Number.isFinite(startWavelength) || !Number.isFinite(endWavelength) ||
          startWavelength < 100 || endWavelength > 2000 || endWavelength <= startWavelength) {
          throw new Error('Invalid OHSP file: trailing wavelength range is missing or invalid.');
        }
        const values = Array.from({ length: sampleCount }, (_, index) => data.readFloatLE(offset + index * 4));
        if (values.some(value => !Number.isFinite(value))) throw new Error('Invalid OHSP file: spectral values contain non-finite numbers.');
        const outputWidth = Math.max(320, width > 0 ? width : 1600);
        const outputHeight = Math.max(180, height > 0 ? height : 900);
        const isFullSize = width === 0 && height === 0;
        const pixels = Buffer.alloc(outputWidth * outputHeight * 3);
        for (let i = 0; i < pixels.length; i += 3) { pixels[i] = 16; pixels[i + 1] = 18; pixels[i + 2] = 22; }
        const setPixel = (x: number, y: number, color: [number, number, number]) => {
          if (x < 0 || y < 0 || x >= outputWidth || y >= outputHeight) return;
          const p = (Math.floor(y) * outputWidth + Math.floor(x)) * 3;
          pixels[p] = color[0]; pixels[p + 1] = color[1]; pixels[p + 2] = color[2];
        };
        const line = (x0: number, y0: number, x1: number, y1: number, color: [number, number, number]) => {
          x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
          const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
          let error = dx + dy;
          while (true) { setPixel(x0, y0, color); if (x0 === x1 && y0 === y1) break; const twice = 2 * error; if (twice >= dy) { error += dy; x0 += sx; } if (twice <= dx) { error += dx; y0 += sy; } }
        };
        const glyphs: Record<string, string[]> = {
          '0':['01110','10001','10011','10101','11001','10001','01110'],'1':['00100','01100','00100','00100','00100','00100','01110'],
          '2':['01110','10001','00001','00010','00100','01000','11111'],'3':['11110','00001','00001','01110','00001','00001','11110'],
          '4':['00010','00110','01010','10010','11111','00010','00010'],'5':['11111','10000','10000','11110','00001','00001','11110'],
          '6':['01110','10000','10000','11110','10001','10001','01110'],'7':['11111','00001','00010','00100','01000','01000','01000'],
          '8':['01110','10001','10001','01110','10001','10001','01110'],'9':['01110','10001','10001','01111','00001','00001','01110'],
          'A':['01110','10001','10001','11111','10001','10001','10001'],'B':['11110','10001','10001','11110','10001','10001','11110'],
          'C':['01111','10000','10000','10000','10000','10000','01111'],'D':['11110','10001','10001','10001','10001','10001','11110'],
          'E':['11111','10000','10000','11110','10000','10000','11111'],'F':['11111','10000','10000','11110','10000','10000','10000'],
          'G':['01111','10000','10000','10111','10001','10001','01111'],'H':['10001','10001','10001','11111','10001','10001','10001'],
          'I':['111','010','010','010','010','010','111'],'K':['10001','10010','10100','11000','10100','10010','10001'],
          'L':['10000','10000','10000','10000','10000','10000','11111'],
          'M':['10001','11011','10101','10101','10001','10001','10001'],'N':['10001','11001','10101','10011','10001','10001','10001'],
          'O':['01110','10001','10001','10001','10001','10001','01110'],
          'P':['11110','10001','10001','11110','10000','10000','10000'],'R':['11110','10001','10001','11110','10100','10010','10001'],
          'S':['01111','10000','10000','01110','00001','00001','11110'],'T':['11111','00100','00100','00100','00100','00100','00100'],
          'U':['10001','10001','10001','10001','10001','10001','01110'],'V':['10001','10001','10001','10001','10001','01010','00100'],
          'W':['10001','10001','10001','10101','10101','10101','01010'],'Y':['10001','10001','01010','00100','00100','00100','00100'],
          '(':['001','010','100','100','100','010','001'],')':['100','010','001','001','001','010','100'],
          '-':['00000','00000','00000','11111','00000','00000','00000'],'.':['000','000','000','000','000','011','011'],
          ':':['000','011','011','000','011','011','000'],'/':['00001','00010','00010','00100','01000','01000','10000'],
          '=':['00000','11111','00000','11111','00000','00000','00000'],' ':['000','000','000','000','000','000','000']
        };
        const drawText = (text: string, x: number, y: number, scale: number, color: [number, number, number]) => {
          let cursor = x;
          for (const rawChar of text.toUpperCase()) { const glyph = glyphs[rawChar] ?? glyphs[' ']; for (let gy = 0; gy < glyph.length; gy++) for (let gx = 0; gx < glyph[gy].length; gx++) if (glyph[gy][gx] === '1') for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) setPixel(cursor + gx * scale + sx, y + gy * scale + sy, color); cursor += (glyph[0].length + 1) * scale; }
        };
        const left = Math.round(outputWidth * 0.09), right = Math.round(outputWidth * 0.025), top = Math.round(outputHeight * (isFullSize ? 0.13 : 0.07)), bottom = Math.round(outputHeight * 0.15);
        const plotWidth = outputWidth - left - right, plotHeight = outputHeight - top - bottom;
        const minimum = Math.min(0, ...values), maximum = Math.max(0, ...values), range = maximum - minimum || 1;
        const yFor = (value: number) => top + (maximum - value) / range * plotHeight, zeroY = yFor(0);
        const spectrumColor = (wavelength: number): [number, number, number] => {
          const stops: Array<[number, number, number, number]> = [[350,110,0,180],[380,90,0,255],[440,0,0,255],[490,0,255,255],[510,0,255,0],[580,255,255,0],[645,255,0,0],[700,255,0,0],[950,80,0,40]];
          let index = 0; while (index < stops.length - 2 && wavelength > stops[index + 1][0]) index++;
          const a = stops[index], b = stops[index + 1], t = (wavelength-a[0])/(b[0]-a[0]), factor = wavelength < 420 ? 0.65+0.35*(wavelength-350)/70 : wavelength > 700 ? 0.3+0.7*(950-wavelength)/250 : 1;
          return [1,2,3].map(i => Math.round(Math.max(0,Math.min(255,(a[i]+(b[i]-a[i])*t)*factor)))) as [number,number,number];
        };
        const gridColor: [number,number,number] = [65,68,74], axisColor: [number,number,number] = [210,214,220], labelColor: [number,number,number] = [190,195,202];
        for (let tick = 0; tick <= 5; tick++) { const value = maximum - tick / 5 * range, y = yFor(value); line(left,y,outputWidth-right,y,gridColor); drawText(value.toPrecision(3), Math.max(2,left-78), y-4, 2, labelColor); }
        for (let tick = 0; tick <= 6; tick++) { const nm = startWavelength + (endWavelength - startWavelength) * tick / 6; const x = left + tick / 6 * plotWidth; line(x,top,x,top+plotHeight,gridColor); drawText(String(Math.round(nm)),x-18,top+plotHeight+10,2,labelColor); }
        for (let x = 0; x < plotWidth; x++) { const index = Math.min(600,Math.round(x/plotWidth*600)), y = Math.round(yFor(values[index])); const wavelength = startWavelength + index / (sampleCount - 1) * (endWavelength - startWavelength); const color = spectrumColor(wavelength); for (let fy = Math.round(Math.min(y,zeroY)); fy <= Math.round(Math.max(y,zeroY)); fy++) setPixel(left+x,fy,color); }
        for (let index = 1; index < sampleCount; index++) line(left+(index-1)/(sampleCount-1)*plotWidth,yFor(values[index-1]),left+index/(sampleCount-1)*plotWidth,yFor(values[index]),[245,245,245]);
        const peakValue = Math.max(...values);
        const peakIndex = values.indexOf(peakValue);
        const peakWavelength = startWavelength + peakIndex / (sampleCount - 1) * (endWavelength - startWavelength);
        const peakX = left + peakIndex / (sampleCount - 1) * plotWidth;
        const peakY = yFor(peakValue);
        const peakLineColor: [number, number, number] = [255, 205, 80];
        if (isFullSize) {
          // Draw a dashed guide from the measured peak down to the wavelength axis.
          for (let y = Math.ceil(peakY); y < top + plotHeight; y += 16) {
            line(peakX, y, peakX, Math.min(y + 8, top + plotHeight), peakLineColor);
          }
          line(peakX - 5, peakY, peakX + 5, peakY, peakLineColor);
          line(peakX, peakY - 5, peakX, peakY + 5, peakLineColor);
        }
        line(left,zeroY,outputWidth-right,zeroY,[245,245,245]); line(left,top,left,top+plotHeight,axisColor); line(left,top+plotHeight,outputWidth-right,top+plotHeight,axisColor);
        const textScale = Math.max(1,Math.floor(outputWidth/1200));
        const headerScale = Math.max(2, Math.floor(outputWidth / 1200));
        const headerColor: [number, number, number] = [235, 239, 245];
        const peakLabelColor: [number, number, number] = [255, 205, 80];
        if (isFullSize) {
          drawText(`MODEL ${instrument}${captureTimestamp ? `  ${captureTimestamp}` : ''}`, left, 8, headerScale, headerColor);
          drawText(`PEAK ${peakWavelength.toFixed(2)} NM = ${String(peakValue)} MW/M2/NM`, left, 8 + 10 * headerScale, headerScale, peakLabelColor);
        }
        drawText('WAVELENGTH (NM)',Math.max(left,Math.round(outputWidth*.39)),outputHeight-bottom+Math.round(bottom*.48),textScale,[235,235,235]);
        drawText('SPECTRAL VALUE',3,Math.round(outputHeight*.43),textScale,[235,235,235]);
        processingStage = 'encoding OHSP spectral chart';
        using image = vips.Image.newFromMemory(pixels, outputWidth, outputHeight, 3, vips.BandFormat.uchar);
        image.jpegsave(target, { Q: width > 0 ? 82 : 92 });
      } else if (cameraRawExtensions.has(sourceExtension)) {
        processingStage = 'developing camera RAW with LibRaw';
        using cameraRawImage = await decodeCameraRawToVips(vips, source, width > 0 && height > 0, width > 0 && height > 0 ? Math.max(width, height) : 0);

        if (cancelledRequests.has(id)) {
          cancelRequest(id);
          return;
        }

        if (width > 0 && height > 0) {
          const scale = preserveAspectRatio
            ? Math.min(width / cameraRawImage.width, height / cameraRawImage.height)
            : Math.max(width / cameraRawImage.width, height / cameraRawImage.height) + 0.0001;
          using resized = cameraRawImage.resize(scale, { kernel: vips.Kernel.linear });
          using output = preserveAspectRatio
            ? resized.copy()
            : resized.extractArea(
              Math.max(0, Math.floor((resized.width - width) / 2)),
              Math.max(0, Math.floor((resized.height - height) / 2)),
              width,
              height
            );
          processingStage = 'encoding linear camera RAW thumbnail as Ultra HDR JPEG';
          using scrgb = output.copy({ interpretation: vips.Interpretation.scrgb });
          encodeScRgbAsUhdr(scrgb, target, 90);
        } else {
          processingStage = 'encoding full-size linear camera RAW derivative as Ultra HDR JPEG';
          using scrgb = cameraRawImage.copy({ interpretation: vips.Interpretation.scrgb });
          encodeScRgbAsUhdr(scrgb, target, 90);
        }
        isHdr = cameraRawImage.max() > 1;
      } else if (sourceExtension === '.exr') {
        processingStage = 'loading EXR decoder';
        const decoder = await getExrDecoder();
        processingStage = 'decoding EXR pixels';
        const decoded = decoder.decodeRgbExr(await readFile(source));
        isHdr = hasHdrHeadroom(decoded.interleavedRgbPixels);

        if (decoded.interleavedRgbPixels.length !== decoded.width * decoded.height * 3) {
          throw new Error('The EXR image does not contain standard RGB channels.');
        }

        processingStage = 'creating libvips float image';
        using image = vips.Image.newFromMemory(
          decoded.interleavedRgbPixels,
          decoded.width,
          decoded.height,
          3,
          vips.BandFormat.float
        );

        if (width > 0 && height > 0) {
          const scale = preserveAspectRatio
            ? Math.min(width / image.width, height / image.height)
            : Math.max(width / image.width, height / image.height) + 0.0001;
          using resized = image.resize(scale, { kernel: vips.Kernel.linear });
          using output = preserveAspectRatio
            ? resized.copy()
            : resized.extractArea(
            Math.max(0, Math.floor((resized.width - width) / 2)),
            Math.max(0, Math.floor((resized.height - height) / 2)),
            width,
            height
            );
          processingStage = 'resizing EXR thumbnail';
          using scrgb = output.copy({ interpretation: vips.Interpretation.scrgb });
          processingStage = 'encoding EXR thumbnail as Ultra HDR JPEG';
          encodeScRgbAsUhdr(scrgb, target, 90);
        } else {
          using scrgb = image.copy({ interpretation: vips.Interpretation.scrgb });
          processingStage = 'encoding full-size EXR derivative as Ultra HDR JPEG';
          encodeScRgbAsUhdr(scrgb, target, 90);
        }
      } else if (sourceExtension === '.hdr') {
        using encodedHdr = vips.Image.newFromFile(source);
        using linearHdr = encodedHdr.rad2float();
        isHdr = hasHdrHeadroom(linearHdr.writeToMemory());

        if (width > 0 && height > 0) {
          const scale = preserveAspectRatio
            ? Math.min(width / linearHdr.width, height / linearHdr.height)
            : Math.max(width / linearHdr.width, height / linearHdr.height) + 0.0001;
          using resized = linearHdr.resize(scale, { kernel: vips.Kernel.linear });
          using output = preserveAspectRatio
            ? resized.copy()
            : resized.extractArea(
            Math.max(0, Math.floor((resized.width - width) / 2)),
            Math.max(0, Math.floor((resized.height - height) / 2)),
            width,
            height
            );
          using scrgb = output.copy({ interpretation: vips.Interpretation.scrgb });
          scrgb.jpegsave(target, { Q: 80 });
        } else {
          using scrgb = linearHdr.copy({ interpretation: vips.Interpretation.scrgb });
          scrgb.jpegsave(target, { Q: 90 });
        }
      } else if ([ '.tif', '.tiff' ].includes(sourceExtension)) {
        using sourceImage = vips.Image.newFromFile(source, { access: 'random' });

        // Untagged 16-bit TIFF samples from FFmpeg use Rec. 2020 HLG codes.
        // Floating-point TIFFs are already linear and are treated as scRGB.
        if ([ 'float', 'double' ].includes(sourceImage.format) && sourceImage.bands >= 3) {
          isHdr = sourceImage.max() > 1;
          using linearScRgb = sourceImage.extractBand(0, { n: 3 })
            .cast(vips.BandFormat.float)
            .copy({ interpretation: vips.Interpretation.scrgb });

          if (width > 0 && height > 0) {
            const scale = preserveAspectRatio
              ? Math.min(width / linearScRgb.width, height / linearScRgb.height)
              : Math.max(width / linearScRgb.width, height / linearScRgb.height) + 0.0001;
            using resized = linearScRgb.resize(scale, { kernel: vips.Kernel.linear });
            using output = preserveAspectRatio
              ? resized.copy()
              : resized.extractArea(
              Math.max(0, Math.floor((resized.width - width) / 2)),
              Math.max(0, Math.floor((resized.height - height) / 2)),
              width,
              height
              );
            using scrgb = output.copy({ interpretation: vips.Interpretation.scrgb });
            encodeScRgbAsUhdr(scrgb, target, 90);
          } else {
            encodeScRgbAsUhdr(linearScRgb, target, 90);
          }
        } else if (sourceImage.format === 'ushort' && sourceImage.bands >= 3) {
          // This path explicitly decodes the untagged 16-bit TIFF data as Rec. 2020 HLG.
          using rgb = sourceImage.extractBand(0, { n: 3 });
          using lutImage = vips.Image.newFromMemory(
            getHdrTransferLut(18),
            65536,
            1,
            1,
            vips.BandFormat.float
          );
          using linearRec2020 = rgb.maplut(lutImage);
          using displayRec2020 = hlgOotf(vips, linearRec2020);
          using rec2020ToScRgb = vips.Image.newMatrix(
            3,
            3,
            [
              1.660491, -0.587641, -0.072850,
              -0.124550, 1.132900, -0.008349,
              -0.018151, -0.100579, 1.118730
            ]
          );
          using image = displayRec2020.recomb(rec2020ToScRgb);
          isHdr = image.max() > 1;

          if (width > 0 && height > 0) {
            const scale = preserveAspectRatio
              ? Math.min(width / image.width, height / image.height)
              : Math.max(width / image.width, height / image.height) + 0.0001;
            using resized = image.resize(scale, { kernel: vips.Kernel.linear });
            using output = preserveAspectRatio
              ? resized.copy()
              : resized.extractArea(
              Math.max(0, Math.floor((resized.width - width) / 2)),
              Math.max(0, Math.floor((resized.height - height) / 2)),
              width,
              height
              );
            using scrgb = output.copy({ interpretation: vips.Interpretation.scrgb });
            encodeScRgbAsUhdr(scrgb, target, 90);
          } else {
            using scrgb = image.copy({ interpretation: vips.Interpretation.scrgb });
            encodeScRgbAsUhdr(scrgb, target, 90);
          }
        } else if (width > 0 && height > 0) {
          using thumb = vips.Image.thumbnail(source, width, { height, size: 2, crop: preserveAspectRatio ? 0 : 1 });
          using jpeg = thumb.cast(vips.BandFormat.uchar).copy({ interpretation: vips.Interpretation.srgb });
          jpeg.jpegsave(target, { Q: 80 });
        } else {
          using jpeg = sourceImage.cast(vips.BandFormat.uchar).copy({ interpretation: vips.Interpretation.srgb });
          jpeg.jpegsave(target, { Q: 90 });
        }
      } else if (sourceExtension === '.heif' || sourceExtension === '.heic') {
        const heifData = await readFile(source);
        const profile = getHeifColorProfile(heifData);

        if (profile?.primaries === 9 && (profile.transfer === 16 || profile.transfer === 18)) {
          isHdr = true;
          using hdrSource = decodeHeifHdrToVips(vips, heifData);
          const lut = getHdrTransferLut(profile.transfer);

          if (hdrSource.format !== 'ushort' || hdrSource.bands < 3) {
            throw new Error(`Unsupported HDR HEIF pixel format: ${hdrSource.format}/${hdrSource.bands}.`);
          }

          using lutImage = vips.Image.newFromMemory(lut, lut.length, 1, 1, vips.BandFormat.float);
          using linearRec2020 = hdrSource.maplut(lutImage);
          using displayRec2020 = profile.transfer === 18
            ? hlgOotf(vips, linearRec2020)
            : linearRec2020.copy();
          using rec2020ToScRgb = vips.Image.newMatrix(
            3,
            3,
            [
              1.660491, -0.587641, -0.072850,
              -0.124550, 1.132900, -0.008349,
              -0.018151, -0.100579, 1.118730
            ]
          );
          using image = displayRec2020.recomb(rec2020ToScRgb);

          if (width > 0 && height > 0) {
            const scale = preserveAspectRatio
              ? Math.min(width / image.width, height / image.height)
              : Math.max(width / image.width, height / image.height) + 0.0001;
            using resized = image.resize(scale, { kernel: vips.Kernel.linear });
            using output = preserveAspectRatio
              ? resized.copy()
              : resized.extractArea(
              Math.max(0, Math.floor((resized.width - width) / 2)),
              Math.max(0, Math.floor((resized.height - height) / 2)),
              width,
              height
              );
            using scrgb = output.copy({ interpretation: vips.Interpretation.scrgb });
            scrgb.jpegsave(target, { Q: 80 });
          } else {
            using scrgb = image.copy({ interpretation: vips.Interpretation.scrgb });
            scrgb.jpegsave(target, { Q: 90 });
          }
        } else {
          const rgba = await decodeHeifToRgba(heifData);
          using decodedImage = vips.Image.newFromMemory(
            new Uint8Array(rgba.data.buffer, rgba.data.byteOffset, rgba.data.byteLength),
            rgba.width,
            rgba.height,
            4,
            vips.BandFormat.uchar
          );
          using rgb = decodedImage.extractBand(0, { n: 3 }).copy({ interpretation: vips.Interpretation.srgb });

          if (width > 0 && height > 0) {
            const scale = preserveAspectRatio
              ? Math.min(width / rgb.width, height / rgb.height)
              : Math.max(width / rgb.width, height / rgb.height) + 0.0001;
            using resized = rgb.resize(scale, { kernel: vips.Kernel.lanczos3 });
            using output = preserveAspectRatio
              ? resized.copy()
              : resized.extractArea(
              Math.max(0, Math.floor((resized.width - width) / 2)),
              Math.max(0, Math.floor((resized.height - height) / 2)),
              width,
              height
              );
            output.jpegsave(target, { Q: 80 });
          } else {
            rgb.jpegsave(target, { Q: 90 });
          }
        }
      } else if (sourceExtension === '.avif') {
        const heifData = await readFile(source);
        const profile = getHeifColorProfile(heifData);

        if (profile?.primaries === 9 && (profile.transfer === 16 || profile.transfer === 18)) {
          isHdr = true;
          using hdrSource = vips.Image.heifload(source, { unlimited: true });
          const lut = getHdrTransferLut(profile.transfer);

          if (hdrSource.format !== 'ushort' || hdrSource.bands < 3) {
            throw new Error(`Unsupported HDR HEIF/AVIF pixel format: ${hdrSource.format}/${hdrSource.bands}.`);
          }

          using lutImage = vips.Image.newFromMemory(
            lut,
            lut.length,
            1,
            1,
            vips.BandFormat.float
          );
          using linearRec2020 = hdrSource.maplut(lutImage);
          using displayRec2020 = profile.transfer === 18
            ? hlgOotf(vips, linearRec2020)
            : linearRec2020.copy();
          using rec2020ToScRgb = vips.Image.newMatrix(
            3,
            3,
            [
              1.660491, -0.587641, -0.072850,
              -0.124550, 1.132900, -0.008349,
              -0.018151, -0.100579, 1.118730
            ]
          );
          using image = displayRec2020.recomb(rec2020ToScRgb);

          if (width > 0 && height > 0) {
            const scale = preserveAspectRatio
              ? Math.min(width / image.width, height / image.height)
              : Math.max(width / image.width, height / image.height) + 0.0001;
            using resized = image.resize(scale, { kernel: vips.Kernel.linear });
            using output = preserveAspectRatio
              ? resized.copy()
              : resized.extractArea(
              Math.max(0, Math.floor((resized.width - width) / 2)),
              Math.max(0, Math.floor((resized.height - height) / 2)),
              width,
              height
              );
            using scrgb = output.copy({ interpretation: vips.Interpretation.scrgb });
            scrgb.jpegsave(target, { Q: 80 });
          } else {
            using scrgb = image.copy({ interpretation: vips.Interpretation.scrgb });
            scrgb.jpegsave(target, { Q: 90 });
          }
        } else {
          if (width > 0 && height > 0) {
            using thumb = vips.Image.thumbnail(
              source,
              width,
              { height, size: 2, crop: preserveAspectRatio ? 0 : 1 }
            );

            thumb.writeToFile(target, { Q: 80 });
          } else {
            using image = vips.Image.newFromFile(source, { access: 'sequential' });
            using rgb = image.extractBand(0, { n: Math.min(3, image.bands) })
              .cast(vips.BandFormat.uchar)
              .copy({ interpretation: vips.Interpretation.srgb });
            rgb.jpegsave(target, { Q: 90 });
          }
        }
      } else if (extname(source).toLowerCase() === '.jxr') {
        const [vips, jpegxr] = await Promise.all([ getVips(), getJpegXr() ]);
        const jxrData = await readFile(source);
        const containerMetadata = inspectJxrContainer(jxrData);
        const decoded = jpegxr.decode(jxrData);

        const { bitDepth, channels, bgr } = decoded.pixelInfo;
        let pixels: Uint8Array | Uint16Array | Float32Array;
        let format: typeof vips.BandFormat.uchar | typeof vips.BandFormat.ushort | typeof vips.BandFormat.float;

        if (bitDepth === '32Float') {
          format = vips.BandFormat.float;
          pixels = new Float32Array(
            decoded.bytes.buffer.slice(decoded.bytes.byteOffset, decoded.bytes.byteOffset + decoded.bytes.byteLength)
          );
        } else if (bitDepth === '16Float') {
          const halfPixels = new Uint16Array(
            decoded.bytes.buffer.slice(decoded.bytes.byteOffset, decoded.bytes.byteOffset + decoded.bytes.byteLength)
          );
          const floatPixels = new Float32Array(halfPixels.length);

          for (let index = 0; index < halfPixels.length; index++) {
            floatPixels[index] = halfFloatToFloat(halfPixels[index]);
          }

          format = vips.BandFormat.float;
          pixels = floatPixels;
        } else if (bitDepth === '16') {
          format = vips.BandFormat.ushort;
          pixels = new Uint16Array(
            decoded.bytes.buffer.slice(decoded.bytes.byteOffset, decoded.bytes.byteOffset + decoded.bytes.byteLength)
          );
        } else if (bitDepth === '8') {
          format = vips.BandFormat.uchar;
          pixels = decoded.bytes;
        } else {
          throw new Error(`Unsupported JPEG XR pixel format: ${decoded.pixelInfo.bitDepth}.`);
        }

        isHdr = (bitDepth === '16Float' || bitDepth === '32Float') && hasHdrHeadroom(pixels);
        const isFullSize = width === 0 && height === 0;
        const sampleScale = bitDepth === '8' ? 1 / 255 : bitDepth === '16' ? 1 / 65535 : 1;
        if (isFullSize) {
          console.info('[ThumbWorker] JXR FULL-SIZE decoded pixel diagnostics', {
            source,
            dimensions: { width: decoded.width, height: decoded.height },
            pixelInfo: decoded.pixelInfo,
            containerMetadata,
            decodedSamples: summarizeJxrPixels(pixels, channels, sampleScale)
          });
        }

        if (channels < 1 || channels === 2) {
          throw new Error(`Unsupported JPEG XR channel count: ${channels}.`);
        }

        using sourceImage = vips.Image.newFromMemory(
          pixels,
          decoded.width,
          decoded.height,
          channels,
          format
        );
        using convertedImage = sourceImage.cast(vips.BandFormat.float);
        using floatImage = convertedImage.linear([
          bitDepth.endsWith('Float') ? 1 : 1 / (bitDepth === '8' ? 255 : 65535)
        ], [ 0 ]);
        using orderedRgb = channels === 1
          ? vips.Image.bandjoin([
            floatImage.extractBand(0),
            floatImage.extractBand(0),
            floatImage.extractBand(0)
          ])
          : bgr
            ? vips.Image.bandjoin([
              floatImage.extractBand(2),
              floatImage.extractBand(1),
              floatImage.extractBand(0)
            ])
            : floatImage.extractBand(0, { n: 3 });

        const sunRegion = { left: 1910, top: 815, width: 100, height: 80 };
        const sunContextRegion = { left: 1860, top: 775, width: 200, height: 160 };
        if (isFullSize) {
          const orderedRgbPixels = orderedRgb.writeToMemory();
          console.info('[ThumbWorker] JXR FULL-SIZE ordered RGB diagnostics\\n' + JSON.stringify({
            source,
            dimensions: { width: decoded.width, height: decoded.height },
            channelOrder: channels === 1 ? 'grayscale replicated to RGB' : bgr ? 'BGR converted to RGB' : 'RGB',
            orderedRgb: summarizeJxrPixels(orderedRgbPixels, 3),
            detailedRgb: summarizeDetailedRgbPixels(orderedRgbPixels),
            sunCore: summarizePixelRegion(orderedRgbPixels, decoded.width, decoded.height, 3, sunRegion),
            sunContext: summarizePixelRegion(orderedRgbPixels, decoded.width, decoded.height, 3, sunContextRegion)
          }, null, 2));
        }

        if (width > 0 && height > 0) {
          const coverScale = Math.max(width / decoded.width, height / decoded.height) + 0.0001;
          const fitScale = Math.min(width / decoded.width, height / decoded.height);
          using resized = orderedRgb.resize(preserveAspectRatio ? fitScale : coverScale, { kernel: vips.Kernel.linear });
          const cropLeft = Math.max(0, Math.floor((resized.width - width) / 2));
          const cropTop = Math.max(0, Math.floor((resized.height - height) / 2));
          using output = preserveAspectRatio
            ? resized.copy()
            : resized.extractArea(cropLeft, cropTop, width, height);
          using scrgb = output.copy({ interpretation: vips.Interpretation.scrgb });
          encodeScRgbAsUhdr(scrgb, target, 80);
        } else {
          using scrgb = orderedRgb.copy({ interpretation: vips.Interpretation.scrgb });
          const encoderInputPixels = scrgb.writeToMemory();
          console.info('[ThumbWorker] JXR FULL-SIZE UHDR encoder input diagnostics\\n' + JSON.stringify({
            source,
            dimensions: { width: scrgb.width, height: scrgb.height },
            detailedRgb: summarizeDetailedRgbPixels(encoderInputPixels),
            sunCore: summarizePixelRegion(encoderInputPixels, scrgb.width, scrgb.height, 3, sunRegion),
            sunContext: summarizePixelRegion(encoderInputPixels, scrgb.width, scrgb.height, 3, sunContextRegion)
          }, null, 2));
          encodeScRgbAsUhdr(scrgb, target, 90);
        }

        // Only inspect the full-size JPEG. Thumbnail derivatives are deliberately
        // excluded so their resize/crop statistics cannot be confused with the image.
        if (isFullSize) {
          // Reopen the generated Ultra HDR JPEG and inspect the decoded HDR pixels.
          // This isolates the JXR decoder from libvips' UltraHDR encoder/decoder path.
          try {
          using encodedJpeg = vips.Image.newFromFile(target);
          using decodedHdr = encodedJpeg.uhdr2scRGB();
          using decodedRgb = decodedHdr.extractBand(0, { n: 3 });
          const gainmap = encodedJpeg.gainmap;
          const metadataFields = [
            'gainmap-max-content-boost',
            'gainmap-min-content-boost',
            'gainmap-gamma',
            'gainmap-offset-sdr',
            'gainmap-offset-hdr',
            'gainmap-hdr-capacity-min',
            'gainmap-hdr-capacity-max',
            'gainmap-use-base-cg'
          ];
          const gainmapMetadata: Record<string, unknown> = {};
          for (const field of metadataFields) {
            try {
              const type = encodedJpeg.getTypeof(field);
              if (type === 0) continue;
              if (field.endsWith('content-boost') || field.endsWith('gamma')
                || field.endsWith('offset-sdr') || field.endsWith('offset-hdr')) {
                gainmapMetadata[field] = encodedJpeg.getArrayDouble(field);
              } else {
                try {
                  gainmapMetadata[field] = encodedJpeg.getDouble(field);
                } catch {
                  gainmapMetadata[field] = encodedJpeg.getInt(field);
                }
              }
            } catch (metadataError) {
              gainmapMetadata[field] = {
                readError: metadataError instanceof Error ? metadataError.message : String(metadataError)
              };
            }
          }

          const gainmapStats = gainmap
            ? {
              width: gainmap.width,
              height: gainmap.height,
              format: gainmap.format,
              bands: gainmap.bands,
              interpretation: gainmap.interpretation,
              pixels: summarizeJxrPixels(gainmap.writeToMemory(), gainmap.bands)
            }
            : null;

          const sdrBasePixels = encodedJpeg.writeToMemory();
          const gainmapPixels = gainmap?.writeToMemory();
          const decodedHdrPixels = decodedRgb.writeToMemory();
          const gainmapSunRegion = {
            left: sunRegion.left / 2,
            top: sunRegion.top / 2,
            width: sunRegion.width / 2,
            height: sunRegion.height / 2
          };
          const gainmapContextRegion = {
            left: sunContextRegion.left / 2,
            top: sunContextRegion.top / 2,
            width: sunContextRegion.width / 2,
            height: sunContextRegion.height / 2
          };
          const diagnostics = {
            source,
            target,
            sunRegion: {
              sourceCoordinates: sunRegion,
              contextCoordinates: sunContextRegion,
              gainmapCoordinates: gainmapSunRegion,
              gainmapContextCoordinates: gainmapContextRegion
            },
            sdrBase: {
              sunCore: summarizePixelRegion(sdrBasePixels, encodedJpeg.width, encodedJpeg.height, 3, sunRegion, 1 / 255),
              sunContext: summarizePixelRegion(sdrBasePixels, encodedJpeg.width, encodedJpeg.height, 3, sunContextRegion, 1 / 255),
              width: encodedJpeg.width,
              height: encodedJpeg.height,
              format: encodedJpeg.format,
              bands: encodedJpeg.bands,
              interpretation: encodedJpeg.interpretation,
              pixels: summarizeJxrPixels(sdrBasePixels, encodedJpeg.bands, 1 / 255),
              detailedRgb: summarizeDetailedRgbPixels(sdrBasePixels, 250_000, 1 / 255)
            },
            gainmap: gainmap && gainmapStats ? {
              ...gainmapStats,
              sunCore: gainmapPixels
                ? summarizePixelRegion(gainmapPixels, gainmap.width, gainmap.height, gainmap.bands, gainmapSunRegion)
                : null,
              sunContext: gainmapPixels
                ? summarizePixelRegion(gainmapPixels, gainmap.width, gainmap.height, gainmap.bands, gainmapContextRegion)
                : null
            } : null,
            gainmapMetadata: {
              fields: metadataFields.filter(field => encodedJpeg.getTypeof(field) !== 0),
              values: gainmapMetadata
            },
            encoded: {
              width: encodedJpeg.width,
              height: encodedJpeg.height,
              format: encodedJpeg.format,
              bands: encodedJpeg.bands,
              fields: encodedJpeg.getFields().size()
            },
            decodedHdr: {
              width: decodedHdr.width,
              height: decodedHdr.height,
              format: decodedHdr.format,
              bands: decodedHdr.bands,
              sunCore: summarizePixelRegion(decodedHdrPixels, decodedHdr.width, decodedHdr.height, 3, sunRegion),
              sunContext: summarizePixelRegion(decodedHdrPixels, decodedHdr.width, decodedHdr.height, 3, sunContextRegion),
              rgb: summarizeJxrPixels(decodedHdrPixels, 3),
              detailedRgb: summarizeDetailedRgbPixels(decodedHdrPixels)
            }
          };
          // Emit a JSON string so nested channel statistics are visible in every console.
          console.info('[ThumbWorker] JXR FULL-SIZE UltraHDR JPEG diagnostics\n' + JSON.stringify(diagnostics, null, 2));
          } catch (diagnosticError) {
            console.error('[ThumbWorker] JXR FULL-SIZE UltraHDR derivative verification failed', {
              source,
              target,
              error: diagnosticError instanceof Error
                ? `${diagnosticError.name}: ${diagnosticError.message}`
                : String(diagnosticError)
            });
          }
        }
      } else {
        processingStage = 'checking Ultra HDR metadata';
        isHdr = hasUltraHdrGainMap(vips, source);
        const sourceExtension = extname(source).toLowerCase();
        if (sourceExtension === '.png') {
          const profile = getPngColorProfile(source);
          isHdr = isHdr || (profile?.primaries === 9 && (profile.transfer === 16 || profile.transfer === 18))
            || hasComfyUiPqVae(source);
        } else if (sourceExtension === '.jxl') {
          const profile = getHeifColorProfile(await readFile(source));
          isHdr = profile?.primaries === 9 && (profile.transfer === 16 || profile.transfer === 18);
        }
        processingStage = 'generating thumbnail with libvips';
        using thumb = vips.Image.thumbnail(
          source,
          width,
          {
            height,
            size: 2,
            crop: preserveAspectRatio ? 0 : 1
          }
        );

        if (cancelledRequests.has(id)) {
          cancelRequest(id);
          return;
        }

        thumb.writeToFile(target, { Q: 80 });
      }

      if (extname(source).toLowerCase() === '.exr') {
        // Verify the encoded JPEG by reopening it through libvips' UltraHDR loader.
        // This distinguishes a missing/invalid gain map from a rendering issue in Chromium.
        processingStage = 'verifying generated Ultra HDR JPEG';
        using encoded = vips.Image.newFromFile(target);
        const fields = encoded.getFields();
        const gainmapFields: string[] = [];
        let hasGainmapData = false;
        let hasCapacityMax = false;

        // wasm-vips exposes getFields() as an embind Vector, not a JavaScript array.
        // The capacity field is a gdouble, so only report its presence here; getString()
        // is valid for string metadata such as gainmap-data, not numeric fields.
        for (let i = 0; i < fields.size(); i++) {
          const field = fields.get(i);
          if (field === 'gainmap-data') hasGainmapData = true;
          if (field === 'gainmap-hdr-capacity-max') hasCapacityMax = true;
          if (field.startsWith('gainmap-') || field === 'gainmap-data') gainmapFields.push(field);
        }

        console.info(
          `[ThumbWorker] EXR UltraHDR verification: ${source} -> ${target}; loader=${hasGainmapData ? 'gainmap-present' : 'gainmap-missing'}; capacity-max-field=${hasCapacityMax ? 'present' : 'missing'}; metadata=${gainmapFields.join(',') || 'none'}`
        );
      }

      parentPort?.postMessage({ id, success: true, isHdr } satisfies ThumbWorkerResponse);
    } catch (err: unknown) {
      const errorMessage = getWorkerErrorMessage(err);
      const errorDetails = err instanceof Error
        ? `${err.name}: ${errorMessage}${err.stack ? `\\n${err.stack}` : ''}`
        : `${Object.prototype.toString.call(err)}: ${errorMessage}`;
      console.error(`[ThumbWorker] Thumbnail generation error (${source}) at stage "${processingStage}": ${errorMessage}`);
      console.error('[ThumbWorker] Thumbnail error details:', errorDetails, err);
      parentPort?.postMessage(
        {
          id,
          success: false,
          error: errorMessage
        } satisfies ThumbWorkerResponse
      );
    } finally {
      cancelledRequests.delete(id);
    }
  });
}
