/**
 * Loadable service worker stub for Chrome (pre-build).
 * Source of truth: service_worker.ts. Build emits dist/service_worker.js.
 */

const OFFSCREEN_URL = 'offscreen.html';
const OFFSCREEN_TARGET = 'offscreen';

let offscreenCreating = null;

async function hasOffscreenDocument() {
  if (!chrome.runtime.getContexts) return false;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }
  offscreenCreating = (async () => {
    try {
      if (await hasOffscreenDocument()) return;
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ['WORKERS'],
        justification:
          'Run on-device ONNX Runtime (WebGPU/WASM) inference for AI vs Real image scoring',
      });
    } finally {
      offscreenCreating = null;
    }
  })();
  await offscreenCreating;
}

async function sendToOffscreen(message) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({ ...message, target: OFFSCREEN_TARGET });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message === null || typeof message !== 'object') {
    return false;
  }
  if (message.target === OFFSCREEN_TARGET) {
    return false;
  }

  if (message.type === 'ENSURE_OFFSCREEN' || message.type === 'PING_OFFSCREEN') {
    void ensureOffscreenDocument()
      .then(() => sendToOffscreen({ type: 'SESSION_STATUS' }))
      .then((status) => {
        sendResponse({
          type: 'OFFSCREEN_PONG',
          ready: Boolean(status && status.ready),
        });
      })
      .catch((err) => {
        sendResponse({
          type: 'OFFSCREEN_PONG',
          ready: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return true;
  }

  if (message.type === 'SESSION_STATUS') {
    void sendToOffscreen({ type: 'SESSION_STATUS' })
      .then((status) => sendResponse(status))
      .catch((err) => {
        sendResponse({
          type: 'SESSION_STATUS_RESULT',
          ready: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return true;
  }

  if (message.type === 'LOAD_MODEL') {
    void sendToOffscreen({
      type: 'LOAD_MODEL',
      modelUrl: message.modelUrl,
    })
      .then((result) => sendResponse(result))
      .catch((err) => {
        sendResponse({
          type: 'LOAD_MODEL_RESULT',
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return true;
  }

  if (message.type === 'ANALYZE_IMAGE') {
    void sendToOffscreen(message)
      .then((result) => sendResponse(result))
      .catch((err) => {
        sendResponse({
          type: 'ANALYZE_ERROR',
          scanId: typeof message.scanId === 'string' ? message.scanId : '',
          imageId: typeof message.imageId === 'string' ? message.imageId : '',
          code: 'INFER',
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return true;
  }

  return false;
});
