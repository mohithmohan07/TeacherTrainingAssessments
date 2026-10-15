import { inflateSync } from 'node:zlib';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

const MiB = 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// Callers may tighten these ceilings, never raise them. The working-memory
// allowance includes decoder scratch space, the crop, and encoding buffers.
export const IDENTITY_CROP_LIMITS = Object.freeze({
  maxSourceBytes: 20 * MiB,
  maxSourcePixels: 24_000_000,
  maxSourceDimension: 12_000,
  maxCropPixels: 8_000_000,
  maxOutputBytes: 20 * MiB,
  maxWorkingBytes: 256 * MiB,
});

export class IdentityCropError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'IdentityCropError';
    this.code = code;
    this.userMessage = message;
  }
}

function fail(code, message) {
  throw new IdentityCropError(code, message);
}

function validatedLimits(overrides) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    fail('IDENTITY_CROP_INVALID_LIMITS', 'Identity crop limits must be an object.');
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(IDENTITY_CROP_LIMITS, key) || !Number.isSafeInteger(value) || value < 1 || value > IDENTITY_CROP_LIMITS[key]) {
      fail('IDENTITY_CROP_INVALID_LIMITS', `Invalid identity crop limit: ${key}.`);
    }
  }
  return { ...IDENTITY_CROP_LIMITS, ...overrides };
}

function validatedBounds(bounds) {
  const keys = ['x', 'y', 'width', 'height'];
  if (!bounds || typeof bounds !== 'object' || Array.isArray(bounds) ||
      !keys.every((key) => typeof bounds[key] === 'number' && Number.isFinite(bounds[key])) ||
      bounds.x < 0 || bounds.x >= 1 || bounds.y < 0 || bounds.y >= 1 || bounds.width <= 0 || bounds.height <= 0 ||
      bounds.x + bounds.width <= bounds.x || bounds.y + bounds.height <= bounds.y ||
      bounds.x + bounds.width > 1 || bounds.y + bounds.height > 1) {
    fail('IDENTITY_CROP_INVALID_BOUNDS', 'Identity panel bounds must be finite normalized coordinates entirely inside the source image.');
  }
  return Object.fromEntries(keys.map((key) => [key, bounds[key]]));
}

function validateDimensions(width, height, limits) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    fail('IDENTITY_CROP_MALFORMED_IMAGE', 'The source image has invalid dimensions.');
  }
  if (width > limits.maxSourceDimension || height > limits.maxSourceDimension || width * height > limits.maxSourcePixels) {
    fail('IDENTITY_CROP_SOURCE_LIMIT', 'The source image exceeds the identity crop dimension or pixel limit.');
  }
}

// Coordinates must address exactly the raster that the model saw. Rather than
// silently ignoring EXIF rotation/mirroring, fail closed on oriented sources.
function validateExif(tiff) {
  if (tiff.length < 8) fail('IDENTITY_CROP_MALFORMED_IMAGE', 'Malformed image orientation metadata.');
  const order = tiff.toString('ascii', 0, 2);
  if (!['II', 'MM'].includes(order)) fail('IDENTITY_CROP_MALFORMED_IMAGE', 'Malformed image orientation metadata.');
  const uint16 = (offset) => order === 'II' ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset);
  const uint32 = (offset) => order === 'II' ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset);
  if (uint16(2) !== 42) fail('IDENTITY_CROP_MALFORMED_IMAGE', 'Malformed image orientation metadata.');
  const start = uint32(4);
  if (start < 8 || start + 2 > tiff.length) fail('IDENTITY_CROP_MALFORMED_IMAGE', 'Malformed image orientation metadata.');
  const count = uint16(start);
  if (start + 2 + count * 12 + 4 > tiff.length) fail('IDENTITY_CROP_MALFORMED_IMAGE', 'Malformed image orientation metadata.');
  for (let offset = start + 2; offset < start + 2 + count * 12; offset += 12) {
    if (uint16(offset) !== 0x0112) continue;
    if (uint16(offset + 2) !== 3 || uint32(offset + 4) !== 1) {
      fail('IDENTITY_CROP_MALFORMED_IMAGE', 'Malformed image orientation metadata.');
    }
    if (uint16(offset + 8) !== 1) {
      fail('IDENTITY_CROP_UNSUPPORTED_ORIENTATION', 'Identity cropping requires a source raster with normal image orientation.');
    }
  }
}

function inspectJpeg(buffer, limits) {
  let offset = 2, dimensions;
  while (offset < buffer.length) {
    if (buffer[offset++] !== 0xff) fail('IDENTITY_CROP_MALFORMED_IMAGE', 'Malformed JPEG marker.');
    while (buffer[offset] === 0xff) offset++;
    const marker = buffer[offset++];
    if (marker === 0xda) {
      if (!dimensions) fail('IDENTITY_CROP_MALFORMED_IMAGE', 'JPEG has no supported image frame.');
      return dimensions;
    }
    if (marker === 0xd9 || marker === undefined || offset + 2 > buffer.length) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) fail('IDENTITY_CROP_MALFORMED_IMAGE', 'Truncated JPEG segment.');
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (dimensions || length < 8 || buffer[offset + 2] !== 8) {
        fail('IDENTITY_CROP_MALFORMED_IMAGE', 'JPEG has an unsupported or malformed image frame.');
      }
      const height = buffer.readUInt16BE(offset + 3), width = buffer.readUInt16BE(offset + 5);
      validateDimensions(width, height, limits);
      dimensions = { width, height, depth: 8 };
    }
    if (marker === 0xe1 && buffer.toString('ascii', offset + 2, offset + 8) === 'Exif\0\0') {
      validateExif(buffer.subarray(offset + 8, offset + length));
    }
    offset += length;
  }
  fail('IDENTITY_CROP_MALFORMED_IMAGE', 'JPEG has no complete image scan.');
}

function pngScanlineBytes(width, height, channels, depth, interlace) {
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  return passes.reduce((total, [x, y, dx, dy]) => {
    const columns = Math.max(0, Math.ceil((width - x) / dx)), rows = Math.max(0, Math.ceil((height - y) / dy));
    return total + (columns && rows ? rows * (1 + Math.ceil(columns * channels * depth / 8)) : 0);
  }, 0);
}

function inspectPng(buffer, limits) {
  let offset = 8, dimensions, ended = false, idatEnded = false, chunks = 0;
  let paletteEntries = 0, transparencySeen = false, gammaSeen = false;
  const compressed = [];
  while (offset < buffer.length) {
    // A byte ceiling alone does not bound the JS object overhead of millions
    // of zero-length chunks. Ordinary page scans use far fewer chunks.
    if (++chunks > 10_000) fail('IDENTITY_CROP_SOURCE_LIMIT', 'The source PNG exceeds the identity crop chunk limit.');
    if (offset + 12 > buffer.length) fail('IDENTITY_CROP_MALFORMED_IMAGE', 'Truncated PNG chunk.');
    const length = buffer.readUInt32BE(offset), type = buffer.toString('ascii', offset + 4, offset + 8);
    if (offset + 12 + length > buffer.length) fail('IDENTITY_CROP_MALFORMED_IMAGE', 'Truncated PNG chunk.');
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (!dimensions && type !== 'IHDR') fail('IDENTITY_CROP_MALFORMED_IMAGE', 'PNG must begin with an image header.');
    if (type === 'IHDR') {
      if (dimensions || length !== 13) fail('IDENTITY_CROP_MALFORMED_IMAGE', 'PNG has a malformed or duplicate image header.');
      const width = data.readUInt32BE(0), height = data.readUInt32BE(4), depth = data[8], color = data[9], interlace = data[12];
      validateDimensions(width, height, limits);
      const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
      const depths = color === 0 ? [1, 2, 4, 8, 16] : color === 3 ? [1, 2, 4, 8] : [8, 16];
      if (!channels || !depths.includes(depth) || data[10] || data[11] || interlace > 1) {
        fail('IDENTITY_CROP_MALFORMED_IMAGE', 'PNG has an unsupported or malformed pixel format.');
      }
      dimensions = { width, height, depth, color, scanlineBytes: pngScanlineBytes(width, height, channels, depth, interlace) };
    }
    // pngjs expands each palette entry into a JS array. Enforce PNG's small
    // palette limit before decode so a forged PLTE cannot amplify memory.
    if (type === 'PLTE') {
      if (paletteEntries || compressed.length || ![2, 3, 6].includes(dimensions.color) || length < 3 || length > 768 || length % 3 ||
          (dimensions.color === 3 && length / 3 > 2 ** dimensions.depth)) {
        fail('IDENTITY_CROP_MALFORMED_IMAGE', 'PNG has an invalid palette.');
      }
      paletteEntries = length / 3;
    }
    if (type === 'tRNS') {
      const validLength = dimensions.color === 0 ? length === 2 : dimensions.color === 2 ? length === 6 :
        dimensions.color === 3 && paletteEntries && length > 0 && length <= paletteEntries;
      if (transparencySeen || compressed.length || !validLength) fail('IDENTITY_CROP_MALFORMED_IMAGE', 'PNG has invalid transparency metadata.');
      transparencySeen = true;
    }
    if (type === 'gAMA') {
      if (gammaSeen || paletteEntries || compressed.length || length !== 4 || !data.readUInt32BE(0)) {
        fail('IDENTITY_CROP_MALFORMED_IMAGE', 'PNG has invalid gamma metadata.');
      }
      gammaSeen = true;
    }
    if (['acTL', 'fcTL', 'fdAT'].includes(type)) fail('IDENTITY_CROP_UNSUPPORTED_FORMAT', 'Animated PNGs are not supported for identity cropping.');
    if (type === 'eXIf') validateExif(data);
    if (type === 'IDAT') {
      if (idatEnded || (dimensions.color === 3 && !paletteEntries)) fail('IDENTITY_CROP_MALFORMED_IMAGE', 'PNG image data is missing its palette or is out of order.');
      compressed.push(data);
    } else if (compressed.length) idatEnded = true;
    offset += length + 12;
    if (type === 'IEND') {
      if (length !== 0 || offset !== buffer.length || !compressed.length) fail('IDENTITY_CROP_MALFORMED_IMAGE', 'PNG has an invalid end chunk.');
      ended = true;
      break;
    }
  }
  if (!ended) fail('IDENTITY_CROP_MALFORMED_IMAGE', 'PNG has no complete image data.');
  return { ...dimensions, compressed };
}

/**
 * Crop only a model-located panel, never a guessed page region. Bounds and
 * contextMargin are fractions of the original, normally oriented image.
 * Pixel bounds round outward and normalizedBounds describe that exact crop.
 * PNG samples (including 16-bit samples) are retained; JPEG samples undergo
 * their necessary source decode once and no further lossy recompression.
 */
export function cropIdentityPanel({ buffer, mimeType, bounds, contextMargin = 0.05, limits = {} } = {}) {
  const ceiling = validatedLimits(limits), panelBounds = validatedBounds(bounds);
  if (typeof contextMargin !== 'number' || !Number.isFinite(contextMargin) || contextMargin < 0 || contextMargin > 0.15) {
    fail('IDENTITY_CROP_INVALID_BOUNDS', 'Identity crop context margin must be between 0 and 0.15.');
  }
  if (!Buffer.isBuffer(buffer) || !buffer.length) fail('IDENTITY_CROP_MALFORMED_IMAGE', 'An original image Buffer is required.');
  if (buffer.length > ceiling.maxSourceBytes) fail('IDENTITY_CROP_SOURCE_LIMIT', 'The source image exceeds the identity crop byte limit.');
  const isPng = buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
  const isJpeg = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8;
  if (!['image/png', 'image/jpeg'].includes(mimeType) || (!isPng && !isJpeg)) {
    fail('IDENTITY_CROP_UNSUPPORTED_FORMAT', 'Only original PNG and JPEG images can be cropped for identity verification.');
  }
  if ((mimeType === 'image/png') !== isPng) fail('IDENTITY_CROP_MALFORMED_IMAGE', 'The source image bytes do not match its declared MIME type.');
  try {
    const metadata = isPng ? inspectPng(buffer, ceiling) : inspectJpeg(buffer, ceiling);
    const { width, height, depth } = metadata;
    const x = Math.max(0, Math.floor((panelBounds.x - contextMargin) * width));
    const y = Math.max(0, Math.floor((panelBounds.y - contextMargin) * height));
    const right = Math.min(width, Math.ceil((panelBounds.x + panelBounds.width + contextMargin) * width));
    const bottom = Math.min(height, Math.ceil((panelBounds.y + panelBounds.height + contextMargin) * height));
    const pixelBounds = { x, y, width: right - x, height: bottom - y };
    const cropPixels = pixelBounds.width * pixelBounds.height;
    if (cropPixels > ceiling.maxCropPixels) fail('IDENTITY_CROP_CROP_LIMIT', 'The identity panel crop exceeds its pixel limit.');
    // Includes raw 16-bit PNG planes / JPEG blocks and temporary scanline,
    // conversion and encoding buffers. jpeg-js also enforces its own budget.
    const fixedBytes = buffer.length * 4 + cropPixels * (depth === 16 ? 48 : 24) + MiB;
    if (fixedBytes + width * height * (depth === 16 ? 64 : 32) > ceiling.maxWorkingBytes) {
      fail('IDENTITY_CROP_MEMORY_LIMIT', 'The identity crop exceeds its working-memory limit.');
    }
    if (isPng) {
      // pngjs truncates excess non-interlaced data and its interlaced decoder
      // does not cap inflate output. Verify the whole zlib stream first, with
      // a strict output ceiling calculated from the validated PNG header.
      const inflated = inflateSync(Buffer.concat(metadata.compressed), { maxOutputLength: metadata.scanlineBytes });
      if (inflated.length !== metadata.scanlineBytes) fail('IDENTITY_CROP_MALFORMED_IMAGE', 'PNG scanline length does not match its dimensions.');
    }
    const decoded = isPng ? PNG.sync.read(buffer, { checkCRC: true, skipRescale: depth === 16 }) : jpeg.decode(buffer, {
      useTArray: true, formatAsRGBA: true, tolerantDecoding: false,
      maxResolutionInMP: ceiling.maxSourcePixels / 1_000_000,
      maxMemoryUsageInMB: (ceiling.maxWorkingBytes - fixedBytes) / MiB,
    });
    if (decoded.width !== width || decoded.height !== height || decoded.data.length !== width * height * 4) {
      fail('IDENTITY_CROP_MALFORMED_IMAGE', 'Decoded image dimensions do not match the source header.');
    }
    const samples = depth === 16 ? new Uint16Array(cropPixels * 4) : Buffer.alloc(cropPixels * 4);
    for (let row = 0; row < pixelBounds.height; row++) {
      const start = ((y + row) * width + x) * 4;
      samples.set(decoded.data.subarray(start, start + pixelBounds.width * 4), row * pixelBounds.width * 4);
    }
    const output = PNG.sync.write({ width: pixelBounds.width, height: pixelBounds.height, data: samples, gamma: decoded.gamma }, {
      colorType: 6, inputColorType: 6, inputHasAlpha: true, bitDepth: depth === 16 ? 16 : 8,
    });
    if (output.length > ceiling.maxOutputBytes) fail('IDENTITY_CROP_OUTPUT_LIMIT', 'The encoded identity crop exceeds its byte limit.');
    return { buffer: output, mimeType: 'image/png', sourceWidth: width, sourceHeight: height, panelBounds, pixelBounds,
      normalizedBounds: { x: x / width, y: y / height, width: pixelBounds.width / width, height: pixelBounds.height / height } };
  } catch (error) {
    if (error instanceof IdentityCropError) throw error;
    const memory = /maxMemoryUsageInMB|maxResolutionInMP/.test(error.message ?? '');
    throw new IdentityCropError(memory ? 'IDENTITY_CROP_MEMORY_LIMIT' : 'IDENTITY_CROP_MALFORMED_IMAGE',
      memory ? 'The image decoder exceeded the identity crop resource limit.' : 'The source image could not be decoded safely for identity verification.', { cause: error });
  }
}

export default cropIdentityPanel;
