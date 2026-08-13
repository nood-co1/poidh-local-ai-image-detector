/**
 * MV3 service worker (section 2.1).
 * Creates the single offscreen document and relays ANALYZE_* (E4) messages.
 *
 * Chrome loads the sibling `service_worker.js` until build copies compiled
 * output into `dist/`.
 */

const OFFSCREEN_URL = 'offscreen.html';
const OFFSCREEN_TARGET = 'offscreen' as const;

/** Reasons allowed for chrome.offscreen.createDocument (Workers for ORT/WASM). */
const OFFSCREEN_REASONS: chrome.offscreen.Reason[] = [
  'WORKERS' as chrome.offscreen.Reason,
];

const OFFSCREEN_JUSTIFICATION =
  'Run on-device ONNX Runtime (WebGPU/WASM) inference for AI vs Real image scoring';

let offscreenCreating: Promise<void> | null = null;

async function hasOffscreenDocument(): Promise<boolean> {
  if (!chrome.runtime.getContexts) {
    // Older typings / runtime: best-effort create.
    return false;
  }
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

/**
 * Ensure the single offscreen inference document exists (Chrome allows one).
 */
export async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) {
    return;
  }
  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }
  offscreenCreating = (async () => {
    try {
      if (await hasOffscreenDocument()) return;
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: OFFSCREEN_REASONS,
        justification: OFFSCREEN_JUSTIFICATION,
      });
    } finally {
      offscreenCreating = null;
    }
  })();
  await offscreenCreating;
}

/**
 * Relay a message to the offscreen document and return its response.
 */
async function sendToOffscreen<T = unknown>(
  message: Record<string, unknown>,
): Promise<T> {
  await ensureOffscreenDocument();
  return (await chrome.runtime.sendMessage({
    ...message,
    target: OFFSCREEN_TARGET,
  })) as T;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message === null || typeof message !== 'object') {
    return false;
  }

  const msg = message as { type?: string; target?: string };

  // Ignore messages addressed exclusively to the offscreen document so that
  // SW → offscreen sendMessage does not re-enter this router.
  if (msg.target === OFFSCREEN_TARGET) {
    return false;
  }

  if (msg.type === 'ENSURE_OFFSCREEN' || msg.type === 'PING_OFFSCREEN') {
    void ensureOffscreenDocument()
      .then(() =>
        sendToOffscreen<{ type: string; ready: boolean }>({
          type: 'SESSION_STATUS',
        }),
      )
      .then((status) => {
        sendResponse({
          type: 'OFFSCREEN_PONG',
          ready: Boolean(status && status.ready),
        });
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        sendResponse({
          type: 'OFFSCREEN_PONG',
          ready: false,
          error: detail,
        });
      });
    return true;
  }

  if (msg.type === 'SESSION_STATUS') {
    void sendToOffscreen({ type: 'SESSION_STATUS' })
      .then((status) => sendResponse(status))
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        sendResponse({
          type: 'SESSION_STATUS_RESULT',
          ready: false,
          error: detail,
        });
      });
    return true;
  }

  if (msg.type === 'LOAD_MODEL') {
    void sendToOffscreen({
      type: 'LOAD_MODEL',
      modelUrl: (message as { modelUrl?: string }).modelUrl,
    })
      .then((result) => sendResponse(result))
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
    void sendToOffscreen(message as Record<string, unknown>)
      .then((result) => sendResponse(result))
      .catch((err: unknown) => {
        const raw = message as { scanId?: string; imageId?: string };
        const detail = err instanceof Error ? err.message : String(err);
        sendResponse({
          type: 'ANALYZE_ERROR',
          scanId: typeof raw.scanId === 'string' ? raw.scanId : '',
          imageId: typeof raw.imageId === 'string' ? raw.imageId : '',
          code: 'INFER',
          error: detail,
        });
      });
    return true;
  }

  return false;
});
