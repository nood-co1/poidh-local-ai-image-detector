/**
 * MV3 offscreen document entry (section 2.1).
 * Hosts the ORT-web session (WebGPU → WASM) and answers ANALYZE_* messages (E4).
 *
 * Created by the service worker via chrome.offscreen.createDocument.
 * Single instance (Chrome limit).
 */

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
 * Attempt to load default on-package model. Missing weights leave session null
 * (fail-closed MODEL_MISSING on analyze). Download/cache is section 2.2.
 */
async function tryLoadDefaultModel(): Promise<void> {
  const ort = await import('onnxruntime-web/webgpu');
  configureOrtEnv(ort.env, wasmBaseUrl());

  const modelUrl = chrome.runtime.getURL(DEFAULT_MODEL_URL);
  try {
    await loadSession(modelUrl, { wasmBaseUrl: wasmBaseUrl() });
  } catch {
    // Expected until 2.2 pins weights into the package / OPFS.
    await clearSession();
  }
}

void tryLoadDefaultModel();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const msg = message as TargetedMessage;
  // Only handle messages addressed to the offscreen document (or legacy untargeted ANALYZE_*).
  if (msg.target !== undefined && msg.target !== TARGET) {
    return false;
  }

  if (msg.type === 'SESSION_STATUS') {
    sendResponse({
      type: 'SESSION_STATUS_RESULT',
      ready: isSessionReady(),
    });
    return false;
  }

  if (msg.type === 'LOAD_MODEL') {
    const modelUrl =
      typeof (message as { modelUrl?: unknown }).modelUrl === 'string'
        ? (message as { modelUrl: string }).modelUrl
        : chrome.runtime.getURL(DEFAULT_MODEL_URL);

    void loadSession(modelUrl, { wasmBaseUrl: wasmBaseUrl() })
      .then(() => {
        sendResponse({ type: 'LOAD_MODEL_RESULT', ok: true });
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
