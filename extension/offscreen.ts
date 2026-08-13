/**
 * MV3 offscreen document entry (sections 2.1–2.2).
 * Hosts the ORT-web session (WebGPU → WASM) and answers ANALYZE_* messages (E4).
 * Loads production ONNX + wasm from the artifact store (OPFS/Cache API) after setup.
 *
 * Created by the service worker via chrome.offscreen.createDocument.
 * Single instance (Chrome limit).
 */

import {
  buildWasmPathsFromStore,
  isModelsReady,
  loadProductionOnnxBytes,
} from '../src/artifact-store.js';
import {
  clearSession,
  configureOrtEnv,
  DEFAULT_MODEL_URL,
  handleAnalyzeImage,
  isSessionReady,
  loadSession,
  parseAnalyzeImageMessage,
  type AnalyzeErrorMessage,
  type AnalyzeResultMessage,
} from '../src/infer.js';

const WASM_DIR = 'wasm/';
const TARGET = 'offscreen' as const;

/** Optional field so SW and content messages do not loop. */
interface TargetedMessage {
  target?: string;
  type?: string;
}

function wasmBaseUrl(): string {
  return chrome.runtime.getURL(WASM_DIR);
}

/**
 * Load production ONNX (and wasm path map when available) from OPFS/Cache.
 * Does not contact the weight host.
 */
async function loadFromArtifactStore(): Promise<boolean> {
  const ready = await isModelsReady();
  if (!ready) {
    return false;
  }

  const modelBytes = await loadProductionOnnxBytes();

  // Prefer wasm blobs from the store; fall back to packaged extension wasm/.
  let wasmOption: { wasmBaseUrl?: string } = {
    wasmBaseUrl: wasmBaseUrl(),
  };
  try {
    const { wasmPaths } = await buildWasmPathsFromStore();
    const ort = await import('onnxruntime-web/webgpu');
    // ORT accepts a filename → URL map for wasmPaths.
    ort.env.wasm.wasmPaths = wasmPaths as unknown as typeof ort.env.wasm.wasmPaths;
    ort.env.wasm.numThreads = 1;
    wasmOption = {};
  } catch {
    const ort = await import('onnxruntime-web/webgpu');
    configureOrtEnv(ort.env, wasmBaseUrl());
  }

  await loadSession(modelBytes, wasmOption);
  return true;
}

/**
 * Attempt artifact-store load first; fall back to on-package model URL
 * (expected to fail until 2.2 setup has run).
 */
async function tryLoadDefaultModel(): Promise<void> {
  try {
    const ok = await loadFromArtifactStore();
    if (ok) return;
  } catch {
    await clearSession();
  }

  // Legacy path: packaged model.onnx (not shipped; fail-closed until setup).
  try {
    const ort = await import('onnxruntime-web/webgpu');
    configureOrtEnv(ort.env, wasmBaseUrl());
    const modelUrl = chrome.runtime.getURL(DEFAULT_MODEL_URL);
    await loadSession(modelUrl, { wasmBaseUrl: wasmBaseUrl() });
  } catch {
    await clearSession();
  }
}

void tryLoadDefaultModel();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const msg = message as TargetedMessage;
  // SW is the sole router: only handle messages explicitly addressed here.
  // Untargeted ANALYZE_IMAGE from content/debug would otherwise be handled both
  // here and again via the SW relay, racing concurrent InferenceSession.run().
  if (msg.target !== TARGET) {
    return false;
  }

  if (msg.type === 'SESSION_STATUS') {
    sendResponse({
      type: 'SESSION_STATUS_RESULT',
      ready: isSessionReady(),
    });
    return false;
  }

  if (msg.type === 'LOAD_FROM_STORE') {
    void loadFromArtifactStore()
      .then((ok) => {
        sendResponse({
          type: 'LOAD_MODEL_RESULT',
          ok,
          error: ok ? undefined : 'artifacts not ready',
        });
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        sendResponse({
          type: 'LOAD_MODEL_RESULT',
          ok: false,
          error: detail,
        });
      });
    return true;
  }

  if (msg.type === 'LOAD_MODEL') {
    const modelUrl =
      typeof (message as { modelUrl?: unknown }).modelUrl === 'string'
        ? (message as { modelUrl: string }).modelUrl
        : chrome.runtime.getURL(DEFAULT_MODEL_URL);

    void (async () => {
      // Prefer store when ready (never re-hit weight host for the default path).
      if (!modelUrl || modelUrl === chrome.runtime.getURL(DEFAULT_MODEL_URL)) {
        try {
          const ok = await loadFromArtifactStore();
          if (ok) {
            sendResponse({ type: 'LOAD_MODEL_RESULT', ok: true });
            return;
          }
        } catch {
          /* fall through to URL load */
        }
      }
      await loadSession(modelUrl, { wasmBaseUrl: wasmBaseUrl() });
      sendResponse({ type: 'LOAD_MODEL_RESULT', ok: true });
    })().catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      sendResponse({
        type: 'LOAD_MODEL_RESULT',
        ok: false,
        error: detail,
      });
    });
    return true;
  }

  if (msg.type === 'CLEAR_SESSION') {
    void clearSession()
      .then(() => sendResponse({ type: 'CLEAR_SESSION_RESULT', ok: true }))
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        sendResponse({
          type: 'CLEAR_SESSION_RESULT',
          ok: false,
          error: detail,
        });
      });
    return true;
  }

  if (msg.type === 'ANALYZE_IMAGE') {
    const parsed = parseAnalyzeImageMessage(message);
    if (!parsed) {
      const raw = message as { scanId?: string; imageId?: string };
      const err: AnalyzeErrorMessage = {
        type: 'ANALYZE_ERROR',
        scanId: typeof raw.scanId === 'string' ? raw.scanId : '',
        imageId: typeof raw.imageId === 'string' ? raw.imageId : '',
        code: 'DECODE',
      };
      sendResponse(err);
      return false;
    }

    void handleAnalyzeImage(parsed).then(
      (result: AnalyzeResultMessage | AnalyzeErrorMessage) => {
        sendResponse(result);
      },
    );
    return true; // async sendResponse
  }

  return false;
});
