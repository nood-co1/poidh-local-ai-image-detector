import { describe, expect, it } from 'vitest';
import {
  CROP_SIZE,
  CLIP_MEAN,
  CLIP_STD,
  OUTPUT_LENGTH,
  OUTPUT_SHAPE,
  SHORTEST_EDGE,
  centerCrop,
  preprocess,
  resizeShortestEdge,
  type RgbImage,
} from './preprocess.js';

/** Solid-color RGB image. */
function solidRgb(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
): RgbImage {
  const data = new Uint8ClampedArray(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    data[i * 3] = r;
    data[i * 3 + 1] = g;
    data[i * 3 + 2] = b;
  }
  return { width, height, data };
}

describe('preprocess locked constants', () => {
  it('matches standards E1 numbers', () => {
    expect(SHORTEST_EDGE).toBe(440);
    expect(CROP_SIZE).toBe(384);
    expect(CLIP_MEAN).toEqual([0.4815, 0.4578, 0.4082]);
    expect(CLIP_STD).toEqual([0.2686, 0.2613, 0.2758]);
    expect(OUTPUT_SHAPE).toEqual([1, 3, 384, 384]);
    expect(OUTPUT_LENGTH).toBe(1 * 3 * 384 * 384);
  });
});

describe('resizeShortestEdge', () => {
  it('makes the short side 440 and preserves aspect', () => {
    const img = solidRgb(200, 100, 128, 64, 32);
    const out = resizeShortestEdge(img);
    expect(Math.min(out.width, out.height)).toBe(SHORTEST_EDGE);
    // 200x100 → scale 4.4 → 880x440
    expect(out.height).toBe(440);
    expect(out.width).toBe(880);
  });
});

describe('centerCrop', () => {
  it('returns 384x384 from a larger image', () => {
    const img = solidRgb(880, 440, 10, 20, 30);
    const out = centerCrop(img);
    expect(out.width).toBe(384);
    expect(out.height).toBe(384);
    expect(out.data.length).toBe(384 * 384 * 3);
  });
});

describe('preprocess', () => {
  it('outputs NCHW shape 1x3x384x384 (flat length)', () => {
    const img = solidRgb(512, 384, 128, 128, 128);
    const tensor = preprocess(img);
    expect(tensor).toBeInstanceOf(Float32Array);
    expect(tensor.length).toBe(OUTPUT_LENGTH);
  });

  it('mean is roughly CLIP-normalized for mid-gray input', () => {
    // mid-gray 128/255 ≈ 0.502 — after (x - mean) / std, channel means ≈ that value
    const img = solidRgb(640, 480, 128, 128, 128);
    const tensor = preprocess(img);
    const plane = CROP_SIZE * CROP_SIZE;
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let i = 0; i < plane; i++) {
        sum += tensor[c * plane + i]!;
      }
      const mean = sum / plane;
      const expected = (128 / 255 - CLIP_MEAN[c]!) / CLIP_STD[c]!;
      // bilinear resize of solid stays solid; allow tiny numeric noise
      expect(mean).toBeCloseTo(expected, 4);
    }
  });

  it('rejects empty dimensions', () => {
    expect(() =>
      preprocess({ width: 0, height: 10, data: new Uint8ClampedArray(0) }),
    ).toThrow(/invalid image size/);
  });
});
