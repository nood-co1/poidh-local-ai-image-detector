/**
 * MV3 service worker (sections 2.1–2.2).
 * Creates the single offscreen document, relays ANALYZE_* (E4), and
 * runs one-time artifact setup (OPFS/Cache API — never chrome.storage weights).
 */

import { clearAllArtifacts } from '../src/artifact-store.js';
import { querySetupStatus, runSetup } from './setup.js';

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

/**
 * After successful setup, ask offscreen to load the model from the artifact store.
 */
async function notifyOffscreenLoadFromStore(): Promise<void> {
  await ensureOffscreenDocument();
  await sendToOffscreen({ type: 'LOAD_FROM_STORE' });
}

async function waitOffscreenSessionReady(timeoutMs = 180_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const status = await sendToOffscreen<{ ready?: boolean }>({
        type: 'SESSION_STATUS',
      });
      if (status?.ready) return true;
    } catch {
      /* booting */
    }
    try {
      await sendToOffscreen({ type: 'LOAD_FROM_STORE' });
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function broadcastModelsReady(): Promise<void> {
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  await Promise.all(
    tabs.map(async (tab) => {
      if (typeof tab.id !== 'number') return;
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'MODELS_READY' });
      } catch {
        /* tab has no content script */
      }
    }),
  );
}

async function notifyTabModelsReady(tabId: number): Promise<void> {
  try {
    const status = await sendToOffscreen<{ ready?: boolean }>({
      type: 'SESSION_STATUS',
    });
    if (!status?.ready) return;
    await chrome.tabs.sendMessage(tabId, { type: 'MODELS_READY' });
  } catch {
    /* offscreen booting or tab has no content script */
  }
}

// Extension reload can inject content scripts after SESSION_READY already fired.
void waitOffscreenSessionReady(180_000).then((ready) => {
  if (ready) void broadcastModelsReady();
});

chrome.tabs.onActivated.addListener((info) => {
  void notifyTabModelsReady(info.tabId);
});

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

  if (msg.type === 'SESSION_READY') {
    // Offscreen can finish loading after the content script's bounded
    // MODEL_MISSING retries. Wake every injected page exactly when usable.
    void chrome.storage.local
      .remove('lastOrtError')
      .catch(() => undefined)
      .then(() => broadcastModelsReady());
    return false;
  }

  if (msg.type === 'SESSION_ERROR') {
    const detail = (message as { error?: unknown }).error;
    if (typeof detail === 'string' && detail) {
      void chrome.storage.local.set({ lastOrtError: detail });
    }
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

  if (msg.type === 'ARTIFACT_STATUS' || msg.type === 'GET_ARTIFACT_STATUS') {
    void querySetupStatus()
      .then((status) => sendResponse(status))
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        sendResponse({
          type: 'ARTIFACT_STATUS_RESULT',
          ready: false,
          sha256: null,
          sha256Short: null,
          backend: 'unknown',
          modelsReadyMarker: false,
          error: detail,
        });
      });
    return true;
  }

  if (msg.type === 'SETUP_ARTIFACTS') {
    const force = Boolean((message as { force?: unknown }).force);
    void runSetup(force)
      .then(async (result) => {
        if (result.ok) {
          try {
            await notifyOffscreenLoadFromStore();
          } catch {
            // Offscreen also loads from the artifact store on boot.
          }
        }
        sendResponse(result);
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        sendResponse({
          type: 'SETUP_ARTIFACTS_RESULT',
          ok: false,
          ready: false,
          noop: false,
          sha256: null,
          sha256Short: null,
          backend: 'unknown',
          fetched: [],
          skipped: [],
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
    void (async () => {
      await waitOffscreenSessionReady(180_000);
      return sendToOffscreen(message as Record<string, unknown>);
    })()
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

  /**
   * Wipe OPFS/Cache artifacts and drop the offscreen session (e2e AC-MISS).
   * Does not network-fetch. After this, ANALYZE_IMAGE must fail closed.
   */
  if (msg.type === 'CLEAR_ARTIFACTS') {
    void (async () => {
      const cleared = await clearAllArtifacts();
      try {
        await sendToOffscreen({ type: 'CLEAR_SESSION' });
      } catch {
        /* offscreen may not exist yet */
      }
      sendResponse({
        type: 'CLEAR_ARTIFACTS_RESULT',
        ok: true,
        ...cleared,
      });
    })().catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      sendResponse({
        type: 'CLEAR_ARTIFACTS_RESULT',
        ok: false,
        error: detail,
      });
    });
    return true;
  }

  /**
   * Ask a tab's content script to scan already-loaded <img> pixels (soul 3).
   * Used by e2e and later by the popup; does not re-GET image URLs.
   */
  if (msg.type === 'SCAN_TAB') {
    const tabId = (message as { tabId?: unknown }).tabId;
    const scanId = (message as { scanId?: unknown }).scanId;
    if (typeof tabId !== 'number' || typeof scanId !== 'string' || !scanId) {
      sendResponse({
        type: 'SCAN_TAB_RESULT',
        ok: false,
        error: 'tabId (number) and scanId (string) required',
      });
      return false;
    }
    void chrome.tabs
      .sendMessage(tabId, { type: 'SCAN_PAGE', scanId })
      .then((result) => sendResponse(result))
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        sendResponse({
          type: 'SCAN_TAB_RESULT',
          ok: false,
          error: detail,
        });
      });
    return true;
  }

  return false;
});
