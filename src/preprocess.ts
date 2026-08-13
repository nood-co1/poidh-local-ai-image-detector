/**
 * Locked preprocess (train = eval = extension). Standards E1 / R-PREPROCESS.
 *
 * Pipeline:
 *   RGB → shortest edge 440 (aspect preserved) → center-crop 384
 *   → CLIP mean/std normalize → NCHW float32 [1, 3, 384, 384]
 *
 * Do not change these numbers without owner amendment.
 */

/** Shortest-edge resize target (aspect preserved). */
export const SHORTEST_EDGE = 440;

/** Center-crop edge length after resize. */
export const CROP_SIZE = 384;

/** CLIP mean (RGB), locked. */
export const CLIP_MEAN: readonly [number, number, number] = [
  0.4815, 0.4578, 0.4082,
];

/** CLIP std (RGB), locked. */
export const CLIP_STD: readonly [number, number, number] = [
  0.2686, 0.2613, 0.2758,
];

/** Output tensor shape: NCHW batch of one. */
export const OUTPUT_SHAPE = [1, 3, CROP_SIZE, CROP_SIZE] as const;

/** Flat length of the NCHW float32 tensor. */
export const OUTPUT_LENGTH = 1 * 3 * CROP_SIZE * CROP_SIZE;

export interface RgbImage {
  width: number;
  height: number;
  /**
   * Interleaved RGB (no alpha), length `width * height * 3`, values 0–255.
   * Accepts Uint8Array or Uint8ClampedArray (ImageData-compatible).
   */
  data: Uint8Array | Uint8ClampedArray;
}

/**
 * Resize so the shortest edge equals `SHORTEST_EDGE`, preserving aspect ratio.
 * Bilinear sampling; pure TypeScript (no Node/browser-only APIs).
 */
export function resizeShortestEdge(
  image: RgbImage,
  shortestEdge: number = SHORTEST_EDGE,
): RgbImage {
  const { width: w, height: h, data } = image;
  if (w < 1 || h < 1) {
    throw new Error(`preprocess: invalid image size ${w}x${h}`);
  }
  if (data.length < w * h * 3) {
    throw new Error(
      `preprocess: RGB buffer too short (${data.length} < ${w * h * 3})`,
    );
  }

  const scale = shortestEdge / Math.min(w, h);
  const outW = Math.max(1, Math.round(w * scale));
  const outH = Math.max(1, Math.round(h * scale));

  if (outW === w && outH === h) {
    return { width: w, height: h, data: data.slice(0, w * h * 3) };
  }

  const out = new Uint8ClampedArray(outW * outH * 3);
  const xRatio = w / outW;
  const yRatio = h / outH;

  for (let y = 0; y < outH; y++) {
    const sy = (y + 0.5) * yRatio - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(h - 1, y0 + 1);
    const fy = sy - y0;

    for (let x = 0; x < outW; x++) {
      const sx = (x + 0.5) * xRatio - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(w - 1, x0 + 1);
      const fx = sx - x0;

      const i00 = (y0 * w + x0) * 3;
      const i01 = (y0 * w + x1) * 3;
      const i10 = (y1 * w + x0) * 3;
      const i11 = (y1 * w + x1) * 3;
      const o = (y * outW + x) * 3;

      for (let c = 0; c < 3; c++) {
        const v0 = data[i00 + c]! * (1 - fx) + data[i01 + c]! * fx;
        const v1 = data[i10 + c]! * (1 - fx) + data[i11 + c]! * fx;
        out[o + c] = Math.round(v0 * (1 - fy) + v1 * fy);
      }
    }
  }

  return { width: outW, height: outH, data: out };
}

/**
 * Center-crop a square of `size`×`size`. Image must be at least size on both axes.
 */
export function centerCrop(image: RgbImage, size: number = CROP_SIZE): RgbImage {
  const { width: w, height: h, data } = image;
  if (w < size || h < size) {
    throw new Error(
      `preprocess: image ${w}x${h} too small for center-crop ${size}`,
    );
  }
  const left = Math.floor((w - size) / 2);
  const top = Math.floor((h - size) / 2);
  const out = new Uint8ClampedArray(size * size * 3);

  for (let y = 0; y < size; y++) {
    const srcRow = ((top + y) * w + left) * 3;
    const dstRow = y * size * 3;
    out.set(data.subarray(srcRow, srcRow + size * 3), dstRow);
  }

  return { width: size, height: size, data: out };
}

/**
 * Full locked preprocess: RGB → shortest-440 → crop-384 → CLIP normalize → NCHW.
 * Returns a Float32Array of length `OUTPUT_LENGTH` laid out as [1, 3, 384, 384].
 */
export function preprocess(image: RgbImage): Float32Array {
  const resized = resizeShortestEdge(image, SHORTEST_EDGE);
  const cropped = centerCrop(resized, CROP_SIZE);
  const { data } = cropped;

  const out = new Float32Array(OUTPUT_LENGTH);
  const plane = CROP_SIZE * CROP_SIZE;
  // NCHW: channel planes contiguous
  for (let y = 0; y < CROP_SIZE; y++) {
    for (let x = 0; x < CROP_SIZE; x++) {
      const si = (y * CROP_SIZE + x) * 3;
      const di = y * CROP_SIZE + x;
      for (let c = 0; c < 3; c++) {
        const v = data[si + c]! / 255;
        out[c * plane + di] = (v - CLIP_MEAN[c]!) / CLIP_STD[c]!;
      }
    }
  }
  return out;
}

/**
 * Convert RGBA (ImageData layout) to RGB for preprocess.
 */
export function rgbaToRgb(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): RgbImage {
  const n = width * height;
  if (rgba.length < n * 4) {
    throw new Error(`rgbaToRgb: buffer too short (${rgba.length} < ${n * 4})`);
  }
  const rgb = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n; i++) {
    rgb[i * 3] = rgba[i * 4]!;
    rgb[i * 3 + 1] = rgba[i * 4 + 1]!;
    rgb[i * 3 + 2] = rgba[i * 4 + 2]!;
  }
  return { width, height, data: rgb };
}
