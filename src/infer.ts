/**
 * On-device inference (section 2.1). Standards E1 (preprocess) / E4 (messages).
 *
 * Uses onnxruntime-web (WebGPU → WASM fallback) with the locked 440/384 CLIP
 * preprocess from `src/preprocess.ts`. Never uses transformers.js ImageNet defaults.
 *
 * Missing session → fail-closed ModelMissingError (ANALYZE_ERROR MODEL_MISSING),
 * never a synthetic 0.5 "real" score.
 */

import {
  CROP_SIZE,
  OUTPUT_LENGTH,
  preprocess,
  rgbaToRgb,
  type RgbImage,
} from './preprocess.js';
import { labelFromScore } from './label.js';

// Re-export A1 helper so existing importers keep working; source of truth is label.ts.
export { labelFromScore } from './label.js';

// ---------------------------------------------------------------------------
// E4 message contract
// ---------------------------------------------------------------------------

export type AnalyzeLabel = 'ai' | 'real' | 'skip' | 'error';

export type ErrorCode = 'MODEL_MISSING' | 'DECODE' | 'INFER';

/** Content / SW → offscreen (or SW relay). */
export interface AnalyzeImageMessage {
  type: 'ANALYZE_IMAGE';
  scanId: string;
  imageId: string;
  /** Displayed image URL (online decode path). */
  src?: string;
  /**
   * Optional raw RGB (0–255 interleaved) when the caller already has pixels.
   * Prefer this in tests; production content path may send `src`.
   */
  image?: {
    width: number;
    height: number;
    /** Interleaved RGB bytes, length width*height*3. */
    data: ArrayLike<number>;
  };
}

export interface AnalyzeResultMessage {
  type: 'ANALYZE_RESULT';
  scanId: string;
  imageId: string;
  score: number;
  label: AnalyzeLabel;
  skip_reason: string | null;
}

export interface AnalyzeErrorMessage {
  type: 'ANALYZE_ERROR';
  scanId: string;
  imageId: string;
  code: ErrorCode;
  /** Actionable local failure detail (for popup/badge diagnostics). */
  error?: string;
}

export type InferMessage =
  | AnalyzeImageMessage
  | AnalyzeResultMessage
  | AnalyzeErrorMessage
  | { type: 'LOAD_MODEL'; modelUrl: string }
  | { type: 'LOAD_MODEL_RESULT'; ok: boolean; error?: string }
  | { type: 'SESSION_STATUS' }
  | { type: 'SESSION_STATUS_RESULT'; ready: boolean; error?: string };

// ---------------------------------------------------------------------------
// Session abstraction (real ORT or unit-test mock)
// ---------------------------------------------------------------------------

/** Minimal tensor surface used by run path (real ORT Tensor or mock). */
export interface InferTensor {
  readonly data: Float32Array | number[];
  dispose(): void;
}

/**
 * Session surface shared by onnxruntime-web InferenceSession and test doubles.
 * Unit tests inject a tiny mock; claim e2e uses a real session (section 2.2+).
 */
export interface InferSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(
    feeds: Record<string, InferTensor>,
    options?: unknown,
  ): Promise<Record<string, InferTensor>>;
  release?(): Promise<void>;
}

/** Factory for input tensors — production wires ort.Tensor; tests use a mock. */
export type TensorFactory = (
  type: 'float32',
  data: Float32Array,
  dims: number[],
) => InferTensor;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ModelMissingError extends Error {
  readonly code = 'MODEL_MISSING' as const;
  constructor(message = 'MODEL_MISSING') {
    super(message);
    this.name = 'ModelMissingError';
  }
}

export class DecodeError extends Error {
  readonly code = 'DECODE' as const;
  constructor(message = 'DECODE') {
    super(message);
    this.name = 'DecodeError';
  }
}

export class InferError extends Error {
  readonly code = 'INFER' as const;
  constructor(message = 'INFER') {
    super(message);
    this.name = 'InferError';
  }
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let session: InferSession | null = null;
let tensorFactory: TensorFactory | null = null;
let ortConfigured = false;

/** Default relative path for the ONNX weights (populated by 2.2 artifact store). */
export const DEFAULT_MODEL_URL = 'model.onnx';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Logistic sigmoid. Numerically stable for large |logit|.
 * Score = P(AI) for the Community Forensics single-logit head.
 */
export function sigmoid(logit: number): number {
  if (logit >= 0) {
    const z = Math.exp(-logit);
    return 1 / (1 + z);
  }
  const z = Math.exp(logit);
  return z / (1 + z);
}

/** Validate ANALYZE_IMAGE shape (E4 — Zod-equivalent). */
export function parseAnalyzeImageMessage(
  raw: unknown,
): AnalyzeImageMessage | null {
  if (raw === null || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m['type'] !== 'ANALYZE_IMAGE') return null;
  if (typeof m['scanId'] !== 'string' || m['scanId'].length === 0) return null;
  if (typeof m['imageId'] !== 'string' || m['imageId'].length === 0) return null;

  const out: AnalyzeImageMessage = {
    type: 'ANALYZE_IMAGE',
    scanId: m['scanId'],
    imageId: m['imageId'],
  };

  if (typeof m['src'] === 'string') {
    out.src = m['src'];
  }

  if (m['image'] !== undefined) {
    if (m['image'] === null || typeof m['image'] !== 'object') return null;
    const img = m['image'] as Record<string, unknown>;
    if (typeof img['width'] !== 'number' || typeof img['height'] !== 'number') {
      return null;
    }
    if (img['width'] < 1 || img['height'] < 1) return null;
    if (img['data'] == null) return null;
    out.image = {
      width: img['width'],
      height: img['height'],
      data: img['data'] as ArrayLike<number>,
    };
  }

  if (!out.src && !out.image) return null;
  return out;
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export function getSession(): InferSession | null {
  return session;
}

export function isSessionReady(): boolean {
  return session !== null;
}

/**
 * Inject a mock session + tensor factory for unit tests.
 * Pass null to clear (MODEL_MISSING path).
 */
export function setSessionForTests(
  next: InferSession | null,
  factory?: TensorFactory | null,
): void {
  session = next;
  tensorFactory = factory ?? (next ? defaultMockTensorFactory : null);
}

function defaultMockTensorFactory(
  _type: 'float32',
  data: Float32Array,
  _dims: number[],
): InferTensor {
  return {
    data,
    dispose() {
      /* no-op for mock */
    },
  };
}

/**
 * Configure ORT wasm paths and thread count for the MV3 offscreen document.
 * Call once before create. `wasmBaseUrl` must be an extension URL ending with `/`
 * (e.g. `chrome.runtime.getURL('wasm/')`).
 */
export function configureOrtEnv(
  ortEnv: {
    wasm: {
      // ORT accepts a path prefix string or a file-path map; we always set a prefix.
      wasmPaths?: unknown;
      numThreads?: number;
    };
  },
  wasmBaseUrl: string,
): void {
  ortEnv.wasm.wasmPaths = wasmBaseUrl;
  ortEnv.wasm.numThreads = 1;
  ortConfigured = true;
}

export function isOrtConfigured(): boolean {
  return ortConfigured;
}

/**
 * Install a live session (real ORT InferenceSession or test double).
 * `factory` builds input tensors matching the session backend.
 */
export function installSession(
  next: InferSession,
  factory: TensorFactory,
): void {
  session = next;
  tensorFactory = factory;
}

/** Drop the current session (tests / teardown). Does not delete weight files. */
export async function clearSession(): Promise<void> {
  const prev = session;
  session = null;
  tensorFactory = null;
  if (prev?.release) {
    try {
      await prev.release();
    } catch {
      /* ignore release errors on teardown */
    }
  }
}

/**
 * Load an ONNX model via onnxruntime-web (WebGPU, then WASM).
 * On failure leaves session null and throws ModelMissingError (fail-closed).
 *
 * Does **not** download weights — caller supplies a local URL / ArrayBuffer
 * (artifact store lands in 2.2).
 */
export async function loadSession(
  modelSource: string | ArrayBuffer | Uint8Array,
  options?: {
    /** Base URL for wasm binaries (extension package). */
    wasmBaseUrl?: string;
    /** Override execution providers (default webgpu → wasm). */
    executionProviders?: string[];
  },
): Promise<InferSession> {
  // Dynamic import keeps unit tests that never load a real model free of ORT init.
  const ort = await import('onnxruntime-web/webgpu');

  if (options?.wasmBaseUrl) {
    configureOrtEnv(ort.env, options.wasmBaseUrl);
  } else if (!ortConfigured) {
    // Safe defaults when running under Node tests with a real session later.
    ort.env.wasm.numThreads = 1;
  }

  const providers = options?.executionProviders ?? ['webgpu', 'wasm'];
  const sessionOptions = { executionProviders: providers };

  try {
    // Branch by source type so TS can pick a single InferenceSession.create overload.
    let created: InferSession;
    if (typeof modelSource === 'string') {
      created = (await ort.InferenceSession.create(
        modelSource,
        sessionOptions,
      )) as unknown as InferSession;
    } else if (modelSource instanceof ArrayBuffer) {
      created = (await ort.InferenceSession.create(
        modelSource,
        sessionOptions,
      )) as unknown as InferSession;
    } else {
      created = (await ort.InferenceSession.create(
        modelSource,
        sessionOptions,
      )) as unknown as InferSession;
    }

    const factory: TensorFactory = (type, data, dims) => {
      const t = new ort.Tensor(type, data, dims);
      return t as unknown as InferTensor;
    };

    installSession(created, factory);
    return created;
  } catch (err) {
    session = null;
    tensorFactory = null;
    const detail = err instanceof Error ? err.message : String(err);
    throw new ModelMissingError(`MODEL_MISSING: ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// Run path
// ---------------------------------------------------------------------------

export interface InferResult {
  /** Sigmoid score in [0, 1] — P(AI). */
  score: number;
  /** Raw model logit before sigmoid. */
  logit: number;
  label: 'ai' | 'real';
}

/**
 * Preprocess with locked E1 pipeline, run session, apply sigmoid, dispose tensors.
 * Throws ModelMissingError when no session is installed.
 */
export async function runInference(image: RgbImage): Promise<InferResult> {
  if (!session || !tensorFactory) {
    throw new ModelMissingError();
  }

  // Locked preprocess only — never transformers.js ImageNet defaults.
  const nchw = preprocess(image);
  if (nchw.length !== OUTPUT_LENGTH) {
    throw new InferError(
      `INFER: preprocess length ${nchw.length} != ${OUTPUT_LENGTH}`,
    );
  }

  const dims = [1, 3, CROP_SIZE, CROP_SIZE];
  const inputTensor = tensorFactory('float32', nchw, dims);
  const inputName = session.inputNames[0];
  if (!inputName) {
    inputTensor.dispose();
    throw new InferError('INFER: session has no input names');
  }

  let outputs: Record<string, InferTensor> | undefined;
  try {
    outputs = await session.run({ [inputName]: inputTensor });
    const outName = session.outputNames[0];
    const outTensor = outName ? outputs[outName] : undefined;
    if (!outTensor) {
      // Fallback: first output value
      const first = Object.values(outputs)[0];
      if (!first) {
        throw new InferError('INFER: empty outputs');
      }
      const logit = Number(first.data[0]);
      if (!Number.isFinite(logit)) {
        throw new InferError('INFER: non-finite logit');
      }
      const score = sigmoid(logit);
      return { score, logit, label: labelFromScore(score) };
    }

    const logit = Number(outTensor.data[0]);
    if (!Number.isFinite(logit)) {
      throw new InferError('INFER: non-finite logit');
    }
    const score = sigmoid(logit);
    return { score, logit, label: labelFromScore(score) };
  } catch (err) {
    if (
      err instanceof ModelMissingError ||
      err instanceof InferError ||
      err instanceof DecodeError
    ) {
      throw err;
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new InferError(`INFER: ${detail}`);
  } finally {
    try {
      inputTensor.dispose();
    } catch {
      /* ignore */
    }
    if (outputs) {
      for (const t of Object.values(outputs)) {
        try {
          t.dispose();
        } catch {
          /* ignore */
        }
      }
    }
  }
}

/**
 * Resolve ANALYZE_IMAGE payload to RGB, run inference, build E4 result/error.
 * Never returns a fake 0.5 real when the model is missing.
 */
export async function handleAnalyzeImage(
  msg: AnalyzeImageMessage,
): Promise<AnalyzeResultMessage | AnalyzeErrorMessage> {
  const { scanId, imageId } = msg;

  if (!session) {
    return {
      type: 'ANALYZE_ERROR',
      scanId,
      imageId,
      code: 'MODEL_MISSING',
    };
  }

  let rgb: RgbImage;
  try {
    rgb = await resolveRgb(msg);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      type: 'ANALYZE_ERROR',
      scanId,
      imageId,
      code: 'DECODE',
      error: detail,
    };
  }

  try {
    const result = await runInference(rgb);
    return {
      type: 'ANALYZE_RESULT',
      scanId,
      imageId,
      score: result.score,
      label: result.label,
      skip_reason: null,
    };
  } catch (err) {
    if (err instanceof ModelMissingError) {
      return {
        type: 'ANALYZE_ERROR',
        scanId,
        imageId,
        code: 'MODEL_MISSING',
        error: err.message,
      };
    }
    const detail = err instanceof Error ? err.message : String(err);
    return {
      type: 'ANALYZE_ERROR',
      scanId,
      imageId,
      code: 'INFER',
      error: detail,
    };
  }
}

async function resolveRgb(msg: AnalyzeImageMessage): Promise<RgbImage> {
  if (msg.image) {
    const { width, height, data } = msg.image;
    const expected = width * height * 3;
    if (data.length < expected) {
      throw new DecodeError(
        `DECODE: RGB buffer too short (${data.length} < ${expected})`,
      );
    }
    const copy = new Uint8ClampedArray(expected);
    for (let i = 0; i < expected; i++) {
      copy[i] = data[i]!;
    }
    return { width, height, data: copy };
  }

  if (msg.src) {
    return decodeImageSrc(msg.src);
  }

  throw new DecodeError('DECODE: no src or image payload');
}

/**
 * Decode an image URL to RGB via fetch + createImageBitmap + OffscreenCanvas.
 * Used in the offscreen document (browser). Throws DecodeError on failure.
 */
export async function decodeImageSrc(src: string): Promise<RgbImage> {
  let response: Response;
  try {
    const ctrl = new AbortController();
    const kill = setTimeout(() => ctrl.abort(), 8000);
    try {
      response = await fetch(src, {
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
        signal: ctrl.signal,
        headers: { Accept: 'image/*,*/*;q=0.8' },
      });
    } finally {
      clearTimeout(kill);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new DecodeError(`DECODE: fetch failed: ${detail}`);
  }
  if (!response.ok) {
    throw new DecodeError(`DECODE: HTTP ${response.status}`);
  }

  let blob: Blob;
  try {
    blob = await response.blob();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new DecodeError(`DECODE: blob: ${detail}`);
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new DecodeError(`DECODE: createImageBitmap: ${detail}`);
  }

  try {
    if (typeof OffscreenCanvas === 'undefined') {
      throw new DecodeError('DECODE: OffscreenCanvas unavailable');
    }
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new DecodeError('DECODE: 2d context unavailable');
    }
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return rgbaToRgb(imageData.data, imageData.width, imageData.height);
  } finally {
    bitmap.close();
  }
}
