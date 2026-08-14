/**
 * MV3 offscreen document entry (sections 2.1–2.2).
 * Hosts the ORT-web session (WebGPU → WASM) and answers ANALYZE_* messages (E4).
 * Loads production ONNX + wasm from the artifact store (OPFS/Cache API) after setup.
 *
 * Created by the service worker via chrome.offscreen.createDocument.
 * Single instance (Chrome limit).
 */

import {
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
let artifactStoreLoad: Promise<boolean> | null = null;

/** Optional field so SW and content messages do not loop. */
interface TargetedMessage {
  target?: string;
  type?: string;
}

function wasmBaseUrl(): string {
  return chrome.runtime.getURL(WASM_DIR);
}

/** Tell the service worker that pages which saw MODEL_MISSING can rescan. */
async function announceSessionReady(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: 'SESSION_READY' });
  } catch {
    // The session remains usable even if the worker is between lifetimes.
  }
}

/**
 * Load production ONNX (and wasm path map when available) from OPFS/Cache.
 * Does not contact the weight host.
 */
async function reportOrtError(err: unknown): Promise<void> {
  const detail = err instanceof Error ? err.message : String(err);
  try {
    await chrome.storage.local.set({ lastOrtError: detail });
  } catch {
    /* ignore */
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function loadFromArtifactStore(): Promise<boolean> {
  const ready = await isModelsReady();
  if (!ready) {
    return false;
  }

  const modelBytes = await loadProductionOnnxBytes();
  // Packaged wasm/ only. OPFS blob wasmPaths have hung InferenceSession.create
  // in real Chrome (session never became ready).
  const opts = {
    wasmBaseUrl: wasmBaseUrl(),
    executionProviders: ['wasm'],
  };
  try {
    await withTimeout(
      loadSession(modelBytes, opts),
      90_000,
      'ORT wasm loadSession',
    );
  } catch (err) {
    await reportOrtError(err);
    throw err;
  }
  try {
    await chrome.storage.local.remove('lastOrtError');
  } catch {
    /* ignore */
  }
  void announceSessionReady();
  return true;
}

/** Share one expensive ORT create across boot, setup, and page scan requests. */
async function ensureLoadFromArtifactStore(): Promise<boolean> {
  if (isSessionReady()) return true;
  if (artifactStoreLoad) return artifactStoreLoad;

  artifactStoreLoad = loadFromArtifactStore();
  try {
    return await artifactStoreLoad;
  } finally {
    artifactStoreLoad = null;
  }
}

/**
 * Attempt artifact-store load first; fall back to on-package model URL
 * (expected to fail until 2.2 setup has run).
 */
async function tryLoadDefaultModel(): Promise<void> {
  try {
    const ok = await ensureLoadFromArtifactStore();
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
    const ready = isSessionReady();
    void chrome.storage.local
      .get('lastOrtError')
      .then((stored) => {
        sendResponse({
          type: 'SESSION_STATUS_RESULT',
          ready,
          error:
            !ready && typeof stored.lastOrtError === 'string'
              ? stored.lastOrtError
              : undefined,
        });
      })
      .catch(() => {
        sendResponse({ type: 'SESSION_STATUS_RESULT', ready });
      });
    return true;
  }

  if (msg.type === 'LOAD_FROM_STORE') {
    void ensureLoadFromArtifactStore()
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
          const ok = await ensureLoadFromArtifactStore();
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
