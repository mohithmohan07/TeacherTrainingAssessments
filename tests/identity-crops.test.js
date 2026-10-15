import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { cropIdentityPanel, IdentityCropError, IDENTITY_CROP_LIMITS } from '../server/identity-crops.js';

// All images are generated in memory. No teacher data or model calls.
function raster(width = 100, height = 80, sixteen = false) {
  const data = sixteen ? new Uint16Array(width * height * 4) : Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    data.set(sixteen ? [x * 313, y * 719, x * 193 + y * 17, 65535 - y * 13] : [x * 2, y * 3, (x + y) % 256, 255 - y], offset);
  }
  return { width, height, data };
}
const source = raster();
const png = PNG.sync.write(source);
const jpegBuffer = jpeg.encode(source, 95).data;
const bounds = Object.freeze({ x: 0.25, y: 0.25, width: 0.5, height: 0.25 });
const crop = (extra = {}) => cropIdentityPanel({ buffer: png, mimeType: 'image/png', bounds, ...extra });

function expectCode(code, action) {
  assert.throws(action, (error) => error instanceof IdentityCropError && error.code === code);
}

function assertCropPixels(result, original, sixteen = false) {
  const decoded = PNG.sync.read(result.buffer, { skipRescale: sixteen });
  const { x, y, width, height } = result.pixelBounds;
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  for (let row = 0; row < height; row++) {
    const offset = ((y + row) * original.width + x) * 4;
    assert.deepEqual([...decoded.data.subarray(row * width * 4, (row + 1) * width * 4)], [...original.data.subarray(offset, offset + width * 4)]);
  }
}

test('PNG crop is pixel-correct, keeps adjacent context, and reports exact geometry', () => {
  const result = crop();
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.sourceWidth, 100);
  assert.equal(result.sourceHeight, 80);
  assert.deepEqual(result.panelBounds, bounds);
  assert.deepEqual(result.pixelBounds, { x: 20, y: 16, width: 60, height: 28 });
  assert.deepEqual(result.normalizedBounds, { x: 0.2, y: 0.2, width: 0.6, height: 0.35 });
  assertCropPixels(result, source);
  // This left-side pixel lies outside the model's panel; notation there must
  // survive. No top-of-page/header-location heuristic is involved.
  assert.equal(PNG.sync.read(result.buffer).data[0], source.data[(16 * 100 + 20) * 4]);
});

test('JPEG crop exactly matches decoded source pixels with no lossy re-encode', () => {
  const result = crop({ buffer: jpegBuffer, mimeType: 'image/jpeg', contextMargin: 0 });
  assert.deepEqual(result.pixelBounds, { x: 25, y: 20, width: 50, height: 20 });
  assertCropPixels(result, jpeg.decode(jpegBuffer));
});

test('16-bit PNG retains every channel without 8-bit quantization', () => {
  const original = raster(100, 80, true);
  const result = crop({ buffer: PNG.sync.write(original, { bitDepth: 16 }), contextMargin: 0 });
  assert.equal(result.buffer[24], 16);
  assertCropPixels(result, original, true);
});

test('only context is clipped at edges, and fractional bounds round outward', () => {
  const result = crop({ bounds: { x: 0, y: 0.9, width: 0.125, height: 0.1 }, contextMargin: 0.15 });
  assert.deepEqual(result.pixelBounds, { x: 0, y: 60, width: 28, height: 20 });
  assertCropPixels(result, source);
  const fractional = crop({ bounds: { x: 0.251, y: 0.251, width: 0.102, height: 0.101 }, contextMargin: 0 });
  assert.deepEqual(fractional.pixelBounds, { x: 25, y: 20, width: 11, height: 9 });
  assert.deepEqual(fractional.normalizedBounds, { x: 0.25, y: 0.25, width: 0.11, height: 0.1125 });
});

test('source buffers and caller geometry remain unchanged on success and failure', () => {
  for (const [buffer, mimeType] of [[png, 'image/png'], [jpegBuffer, 'image/jpeg']]) {
    const before = Buffer.from(buffer), mutableBounds = { ...bounds };
    const result = crop({ buffer, mimeType, bounds: mutableBounds });
    result.buffer.fill(0);
    result.panelBounds.x = 0;
    assert.deepEqual(buffer, before);
    assert.deepEqual(mutableBounds, bounds);
    expectCode('IDENTITY_CROP_SOURCE_LIMIT', () => crop({ buffer, mimeType, limits: { maxSourcePixels: 1 } }));
    assert.deepEqual(buffer, before);
  }
});

test('missing, non-finite, non-normalized and zero-area bounds never get a guessed crop', () => {
  for (const invalid of [undefined, null, [], {}, { ...bounds, x: '0.25' }, { ...bounds, x: NaN },
    { ...bounds, y: Infinity }, { ...bounds, x: -0.1 }, { ...bounds, y: 0.9 },
    { ...bounds, width: 0 }, { ...bounds, height: -1 }, { ...bounds, width: 2 },
    { ...bounds, x: 1, width: Number.MIN_VALUE }, { ...bounds, width: Number.MIN_VALUE }]) {
    expectCode('IDENTITY_CROP_INVALID_BOUNDS', () => crop({ bounds: invalid }));
  }
  for (const margin of [-0.01, 0.151, Infinity, NaN, '0.05', null]) {
    expectCode('IDENTITY_CROP_INVALID_BOUNDS', () => crop({ contextMargin: margin }));
  }
});

test('resource ceilings are enforced before crop decode/allocation and cannot be raised', () => {
  for (const key of ['maxSourceBytes', 'maxSourcePixels', 'maxSourceDimension']) {
    expectCode('IDENTITY_CROP_SOURCE_LIMIT', () => crop({ limits: { [key]: 1 } }));
  }
  expectCode('IDENTITY_CROP_CROP_LIMIT', () => crop({ limits: { maxCropPixels: 1 } }));
  expectCode('IDENTITY_CROP_MEMORY_LIMIT', () => crop({ limits: { maxWorkingBytes: 1 } }));
  expectCode('IDENTITY_CROP_OUTPUT_LIMIT', () => crop({ limits: { maxOutputBytes: 1 } }));
  for (const limits of [null, [], { unknown: 1 }, { maxSourcePixels: NaN }, { maxWorkingBytes: 0 },
    { maxSourceBytes: '123' }, { maxSourcePixels: IDENTITY_CROP_LIMITS.maxSourcePixels + 1 }]) {
    expectCode('IDENTITY_CROP_INVALID_LIMITS', () => crop({ limits }));
  }
});

test('unsupported, mismatched, truncated and CRC-corrupted images fail typed', () => {
  expectCode('IDENTITY_CROP_UNSUPPORTED_FORMAT', () => crop({ mimeType: 'image/webp' }));
  expectCode('IDENTITY_CROP_UNSUPPORTED_FORMAT', () => crop({ buffer: Buffer.from('GIF89a') }));
  expectCode('IDENTITY_CROP_MALFORMED_IMAGE', () => crop({ mimeType: 'image/jpeg' }));
  for (const buffer of [null, new Uint8Array(png), Buffer.alloc(0), png.subarray(0, 30), png.subarray(0, -5)]) {
    expectCode('IDENTITY_CROP_MALFORMED_IMAGE', () => crop({ buffer }));
  }
  const broken = Buffer.from(png);
  broken[29] ^= 1;
  expectCode('IDENTITY_CROP_MALFORMED_IMAGE', () => crop({ buffer: broken }));
  expectCode('IDENTITY_CROP_MALFORMED_IMAGE', () => crop({ buffer: jpegBuffer.subarray(0, 30), mimeType: 'image/jpeg' }));
});

// Tiny PNG construction permits hostile headers/streams without allocating a
// huge fixture. The checksum is part of the real PNG, not a decoder mock.
function chunk(type, data = Buffer.alloc(0)) {
  const label = Buffer.from(type), result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  label.copy(result, 4);
  data.copy(result, 8);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([label, data])) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

function syntheticPng(width, height, inflated, interlace = 0, beforeIdat = []) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[12] = interlace;
  return Buffer.concat([png.subarray(0, 8), chunk('IHDR', header), ...beforeIdat, chunk('IDAT', deflateSync(inflated)), chunk('IEND')]);
}

test('oversized source headers are rejected without decoding compressed pixels', () => {
  expectCode('IDENTITY_CROP_SOURCE_LIMIT', () => crop({ buffer: syntheticPng(0xffffffff, 0xffffffff, Buffer.alloc(0)) }));
  expectCode('IDENTITY_CROP_MALFORMED_IMAGE', () => crop({ buffer: syntheticPng(0, 1, Buffer.alloc(0)) }));
  const giantJpeg = Buffer.from(jpegBuffer);
  const frame = giantJpeg.indexOf(Buffer.from([0xff, 0xc0]));
  assert.ok(frame >= 0);
  giantJpeg.writeUInt16BE(65535, frame + 5);
  giantJpeg.writeUInt16BE(65535, frame + 7);
  expectCode('IDENTITY_CROP_SOURCE_LIMIT', () => crop({ buffer: giantJpeg, mimeType: 'image/jpeg' }));
});

test('both PNG inflate paths reject extra/deceptive scanlines with bounded decompression', () => {
  for (const interlace of [0, 1]) {
    for (const inflated of [Buffer.alloc(4), Buffer.alloc(1_000_000)]) {
      expectCode('IDENTITY_CROP_MALFORMED_IMAGE', () => crop({ buffer: syntheticPng(1, 1, inflated, interlace) }));
    }
  }
  const interlaced = crop({ buffer: syntheticPng(1, 1, Buffer.from([0, 11, 22, 33, 255]), 1) });
  assert.deepEqual([...PNG.sync.read(interlaced.buffer).data], [11, 22, 33, 255]);
});

test('multi-pass interlaced PNG crops retain exact pixels and alpha', () => {
  const original = raster(17, 19), rows = [];
  for (const [x, y, dx, dy] of [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]) {
    for (let py = y; py < original.height; py += dy) {
      rows.push(Buffer.from([0]));
      for (let px = x; px < original.width; px += dx) {
        const start = (py * original.width + px) * 4;
        rows.push(original.data.subarray(start, start + 4));
      }
    }
  }
  assertCropPixels(crop({ buffer: syntheticPng(original.width, original.height, Buffer.concat(rows), 1) }), original);
});

test('duplicate PNG headers and excessive tiny chunks cannot bypass resource preflight', () => {
  const duplicate = Buffer.concat([png.subarray(0, 33), png.subarray(8)]);
  expectCode('IDENTITY_CROP_MALFORMED_IMAGE', () => crop({ buffer: duplicate }));
  const tooMany = syntheticPng(1, 1, Buffer.alloc(5), 0, Array.from({ length: 10_000 }, () => chunk('tEXt')));
  expectCode('IDENTITY_CROP_SOURCE_LIMIT', () => crop({ buffer: tooMany }));
  for (const palettes of [[chunk('PLTE', Buffer.alloc(771))], [chunk('PLTE', Buffer.alloc(3)), chunk('PLTE', Buffer.alloc(3))]]) {
    expectCode('IDENTITY_CROP_MALFORMED_IMAGE', () => crop({ buffer: syntheticPng(1, 1, Buffer.alloc(5), 0, palettes) }));
  }
});

test('animated PNG and ambiguous EXIF orientation never silently select a different raster', () => {
  expectCode('IDENTITY_CROP_UNSUPPORTED_FORMAT', () => crop({ buffer: syntheticPng(1, 1, Buffer.alloc(5), 0, [chunk('acTL', Buffer.alloc(8))]) }));
  const exif = Buffer.alloc(26);
  exif.write('II'); exif.writeUInt16LE(42, 2); exif.writeUInt32LE(8, 4);
  exif.writeUInt16LE(1, 8); exif.writeUInt16LE(0x0112, 10);
  exif.writeUInt16LE(3, 12); exif.writeUInt32LE(1, 14); exif.writeUInt16LE(6, 18);
  const segment = Buffer.concat([Buffer.from([0xff, 0xe1, 0, 34]), Buffer.from('Exif\0\0'), exif]);
  expectCode('IDENTITY_CROP_UNSUPPORTED_ORIENTATION', () => crop({ buffer: Buffer.concat([jpegBuffer.subarray(0, 2), segment, jpegBuffer.subarray(2)]), mimeType: 'image/jpeg' }));
  expectCode('IDENTITY_CROP_UNSUPPORTED_ORIENTATION', () => crop({ buffer: syntheticPng(1, 1, Buffer.alloc(5), 0, [chunk('eXIf', exif)]) }));
  exif.writeUInt16LE(1, 18);
  const normal = crop({ buffer: syntheticPng(1, 1, Buffer.from([0, 11, 22, 33, 255]), 0, [chunk('eXIf', exif)]) });
  assert.deepEqual([...PNG.sync.read(normal.buffer).data], [11, 22, 33, 255]);
});
