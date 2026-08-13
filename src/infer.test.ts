import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  clearSession,
  handleAnalyzeImage,
  isSessionReady,
  labelFromScore,
  ModelMissingError,
  parseAnalyzeImageMessage,
  runInference,
  setSessionForTests,
  sigmoid,
  type InferSession,
  type InferTensor,
} from './infer.js';
import { OUTPUT_LENGTH, type RgbImage } from './preprocess.js';
import { THRESHOLD } from './threshold.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

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

/** Tiny mock session that returns a fixed logit and tracks dispose. */
function makeMockSession(logit: number): {
  session: InferSession;
  disposed: { input: number; output: number };
} {
  const disposed = { input: 0, output: 0 };
  const session: InferSession = {
    inputNames: ['pixel_values'],
    outputNames: ['logits'],
    async run(feeds) {
      for (const t of Object.values(feeds)) {
        // Ensure preprocess tensor reached the session with locked length.
        expect(t.data.length).toBe(OUTPUT_LENGTH);
        // Do not dispose here — runInference owns cleanup (finally).
        void t;
        disposed.input += 1;
      }
      const out: InferTensor = {
        data: new Float32Array([logit]),
        dispose() {
          disposed.output += 1;
        },
      };
      return { logits: out };
    },
  };
  return { session, disposed };
}

afterEach(async () => {
  await clearSession();
});

describe('sigmoid mapping', () => {
  it('maps 0 → 0.5', () => {
    expect(sigmoid(0)).toBeCloseTo(0.5, 10);
  });

  it('maps large positive → ~1', () => {
    expect(sigmoid(20)).toBeCloseTo(1, 6);
  });

  it('maps large negative → ~0', () => {
    expect(sigmoid(-20)).toBeCloseTo(0, 6);
  });

  it('is monotonic', () => {
    expect(sigmoid(-2)).toBeLessThan(sigmoid(0));
    expect(sigmoid(0)).toBeLessThan(sigmoid(2));
  });

  it('labelFromScore uses THRESHOLD (A1)', () => {
    expect(labelFromScore(THRESHOLD)).toBe('ai');
    expect(labelFromScore(THRESHOLD - 1e-9)).toBe('real');
    expect(labelFromScore(0)).toBe('real');
    expect(labelFromScore(1)).toBe('ai');
  });
});

describe('MODEL_MISSING path (fail-closed)', () => {
  it('runInference throws ModelMissingError when session is null', async () => {
    setSessionForTests(null);
    expect(isSessionReady()).toBe(false);
    const img = solidRgb(64, 64, 10, 20, 30);
    await expect(runInference(img)).rejects.toBeInstanceOf(ModelMissingError);
  });

  it('handleAnalyzeImage returns ANALYZE_ERROR MODEL_MISSING, not score 0.5', async () => {
    setSessionForTests(null);
    const result = await handleAnalyzeImage({
      type: 'ANALYZE_IMAGE',
      scanId: 'scan-1',
      imageId: 'img-1',
      image: {
        width: 64,
        height: 64,
        data: solidRgb(64, 64, 1, 2, 3).data,
      },
    });

    expect(result.type).toBe('ANALYZE_ERROR');
    if (result.type === 'ANALYZE_ERROR') {
      expect(result.code).toBe('MODEL_MISSING');
      expect(result.scanId).toBe('scan-1');
      expect(result.imageId).toBe('img-1');
    }
    // Fail-closed: must not invent a mid-point "real" score.
    expect(result).not.toMatchObject({ score: 0.5 });
    expect(result).not.toHaveProperty('label', 'real');
  });
});

describe('mock session run (preprocess + sigmoid + dispose)', () => {
  it('returns sigmoid(logit) and disposes tensors', async () => {
    const logit = 2;
    const { session, disposed } = makeMockSession(logit);
    setSessionForTests(session);

    const img = solidRgb(100, 80, 200, 100, 50);
    const result = await runInference(img);

    expect(result.logit).toBe(logit);
    expect(result.score).toBeCloseTo(sigmoid(logit), 10);
    expect(result.label).toBe(labelFromScore(result.score));
    // run() saw one input; finally disposed the output tensor once.
    expect(disposed.input).toBe(1);
    expect(disposed.output).toBe(1);
  });

  it('handleAnalyzeImage returns ANALYZE_RESULT with numeric score', async () => {
    const logit = 0;
    const { session } = makeMockSession(logit);
    setSessionForTests(session);

    const result = await handleAnalyzeImage({
      type: 'ANALYZE_IMAGE',
      scanId: 's2',
      imageId: 'i2',
      image: {
        width: 50,
        height: 50,
        data: solidRgb(50, 50, 0, 0, 0).data,
      },
    });

    expect(result.type).toBe('ANALYZE_RESULT');
    if (result.type === 'ANALYZE_RESULT') {
      expect(typeof result.score).toBe('number');
      expect(result.score).toBeCloseTo(0.5, 10);
      expect(result.label).toBe('real'); // 0.5 < THRESHOLD 0.65
      expect(result.skip_reason).toBeNull();
    }
  });
});

describe('parseAnalyzeImageMessage', () => {
  it('accepts valid E4-shaped messages', () => {
    expect(
      parseAnalyzeImageMessage({
        type: 'ANALYZE_IMAGE',
        scanId: 'a',
        imageId: 'b',
        src: 'https://example.com/x.png',
      }),
    ).toEqual({
      type: 'ANALYZE_IMAGE',
      scanId: 'a',
      imageId: 'b',
      src: 'https://example.com/x.png',
    });
  });

  it('rejects incomplete messages', () => {
    expect(parseAnalyzeImageMessage({ type: 'ANALYZE_IMAGE' })).toBeNull();
    expect(
      parseAnalyzeImageMessage({
        type: 'ANALYZE_IMAGE',
        scanId: 'a',
        imageId: 'b',
      }),
    ).toBeNull();
    expect(parseAnalyzeImageMessage(null)).toBeNull();
  });
});

describe('negative: no transformers.js ImageNet pipeline', () => {
  /** Import / call sites only (comments may mention the ban). */
  const bannedImport =
    /(?:from|import|require)\s*\(?\s*['"][^'"]*(?:@xenova\/transformers|@huggingface\/transformers|transformers\.js)/;
  const bannedPipeline =
    /pipeline\s*\(\s*['"]image-classification|AutoModelForImageClassification/;

  it('src/infer.ts does not import transformers.js classification', () => {
    const src = readFileSync(join(root, 'src/infer.ts'), 'utf8');
    expect(src).not.toMatch(bannedImport);
    expect(src).not.toMatch(bannedPipeline);
    // Must use locked preprocess module (440/384), not ImageNet resize constants.
    expect(src).toMatch(/from ['"]\.\/preprocess\.js['"]/);
    expect(src).toMatch(/\bpreprocess\b/);
    // No hardcoded ImageNet size in executable code (comments excluded).
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/\b224\b/);
  });

  it('extension offscreen entry does not import transformers.js', () => {
    const pathTs = join(root, 'extension/offscreen.ts');
    const pathJs = join(root, 'extension/offscreen.js');
    let src: string;
    try {
      src = readFileSync(pathTs, 'utf8');
    } catch {
      src = readFileSync(pathJs, 'utf8');
    }
    expect(src).not.toMatch(bannedImport);
    expect(src).not.toMatch(bannedPipeline);
    expect(src).toMatch(/infer/);
  });

  it('package.json does not depend on @xenova/transformers', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    expect(all['@xenova/transformers']).toBeUndefined();
    expect(all['@huggingface/transformers']).toBeUndefined();
    expect(all['onnxruntime-web']).toBeDefined();
  });
});
