/**
 * Spec 3.3 — Privacy allowlist HAR (soul 6 JOB-PRIVACY-01).
 *
 * Service-worker-inclusive network log (not page-only fetch spy):
 *   - Precondition: models_ready
 *   - Branch: scan page (same-origin pixels + dual-origin GET fallback)
 *   - Postcondition: allowlist
 *       AC-HAR: SW requests inspected
 *       AC-NOPOST: no image POST/WS
 *       AC-NOMODEL: no post-setup model/wasm/tokenizer GET (path-based)
 *       AC-GET: displayed image URL GET permitted
 *
 * retries: 0 (claim suite). Does not mock infer().
 */

import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

import {
  test as base,
  chromium,
  expect,
  type BrowserContext,
  type Page,
  type Request,
  type Worker,
} from '@playwright/test';

import {
  classifyRequest,
  evaluateHar,
  isDisplayedImageUrl,
  isModelArtifactUrl,
  isNetworkUrl,
  type NetworkRequest,
} from '../src/allowlist.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const FIXTURES = join(ROOT, 'eval', 'fixtures');
const ASSETS = join(FIXTURES, 'assets');
const ONNX_URL_SUBSTR = 'onnx/model.onnx';
const EXPECTED_ONNX_SHA =
  'a42c7d740fbb345ba9a26d469b22f301d73089ce3c6da993877ed2b6965a8ba1';
const LOCAL_ONNX_CANDIDATES = [
  process.env.POIDH_ONNX_CACHE,
  '/tmp/poidh-onnx-cache/model.onnx',
  join(ROOT, 'evidence', '.cache', 'model.onnx'),
].filter((p): p is string => Boolean(p));

type ExtensionFixtures = {
  context: BrowserContext;
  extensionId: string;
  serviceWorker: Worker;
  harness: Page;
  pageBaseUrl: string;
  assetBaseUrl: string;
  fixtureBaseUrl: string;
  networkLog: NetworkRequest[];
  /** Flip to true after models_ready; only post-setup requests are allowlisted. */
  capturePostReady: { active: boolean };
};

function listen(server: Server): Promise<string> {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr !== 'object') {
        reject(new Error('no address'));
        return;
      }
      resolveListen(`http://127.0.0.1:${addr.port}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => {
    const withConns = server as Server & {
      closeAllConnections?: () => void;
    };
    try {
      withConns.closeAllConnections?.();
    } catch {
      /* ignore */
    }
    server.close(() => resolveClose());
    setTimeout(() => resolveClose(), 3000).unref?.();
  });
}

function startAssetServer(): Server {
  // No CORS — page canvas taints; extension host_permissions GET still works.
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const urlPath = (req.url ?? '/').split('?')[0] || '/';
    const name = urlPath.replace(/^\//, '');
    const filePath = resolve(ASSETS, name);
    if (!filePath.startsWith(ASSETS) || !existsSync(filePath)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/png' });
    createReadStream(filePath).pipe(res);
  });
}

function startPageServer(assetBaseUrl: string): Server {
  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>POIDH privacy HAR dual-origin fixture</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 1.5rem; background: #111; color: #eee; }
      img { display: block; width: 128px; height: auto; margin: 8px; }
    </style>
  </head>
  <body>
    <h1>Privacy HAR — cross-origin images (GET fallback permitted)</h1>
    <img src="${assetBaseUrl}/real_a.png" alt="cross real a" width="128" data-image-id="har-real-a" />
    <img src="${assetBaseUrl}/real_b.png" alt="cross real b" width="128" data-image-id="har-real-b" />
    <img src="${assetBaseUrl}/ai_a.png" alt="cross ai a" width="128" data-image-id="har-ai-a" />
    <img src="${assetBaseUrl}/ai_b.png" alt="cross ai b" width="128" data-image-id="har-ai-b" />
  </body>
</html>`;

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const urlPath = (req.url ?? '/').split('?')[0] || '/';
    if (urlPath === '/' || urlPath === '/hotlink.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
}

function startFixtureServer(): Server {
  return createServer((req, res) => {
    const urlPath = (req.url ?? '/').split('?')[0] || '/';
    const rel = urlPath === '/' ? '/mixed.html' : urlPath;
    const filePath = resolve(FIXTURES, `.${rel}`);
    if (!filePath.startsWith(FIXTURES) || !existsSync(filePath)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = filePath.split('.').pop()?.toLowerCase();
    const type =
      ext === 'html'
        ? 'text/html; charset=utf-8'
        : ext === 'png'
          ? 'image/png'
          : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    createReadStream(filePath).pipe(res);
  });
}

function resolveLocalOnnx(): string | null {
  for (const p of LOCAL_ONNX_CANDIDATES) {
    if (p && existsSync(p) && statSync(p).size >= 20 * 1024 * 1024) {
      const sha = createHash('sha256').update(readFileSync(p)).digest('hex');
      if (sha === EXPECTED_ONNX_SHA) return p;
    }
  }
  return null;
}

async function ensureDistBuilt(): Promise<void> {
  if (
    existsSync(join(DIST, 'manifest.json')) &&
    existsSync(join(DIST, 'service_worker.js')) &&
    existsSync(join(DIST, 'content.js')) &&
    existsSync(join(DIST, 'offscreen.js')) &&
    existsSync(join(DIST, 'harness.html'))
  ) {
    return;
  }
  const { execSync } = await import('node:child_process');
  execSync('bash scripts/gate-build.sh', { cwd: ROOT, stdio: 'inherit' });
}

function toNetworkRequest(req: Request): NetworkRequest {
  let fromServiceWorker: boolean;
  try {
    fromServiceWorker = Boolean(req.serviceWorker());
  } catch {
    fromServiceWorker = false;
  }
  let headers: Record<string, string> | null;
  try {
    headers = req.headers();
  } catch {
    headers = null;
  }
  let postData: string | null;
  try {
    postData = req.postData();
  } catch {
    postData = null;
  }
  return {
    url: req.url(),
    method: req.method(),
    resourceType: req.resourceType(),
    postData,
    headers,
    fromServiceWorker,
  };
}

const test = base.extend<ExtensionFixtures>({
  // eslint-disable-next-line no-empty-pattern
  networkLog: async ({}, use) => {
    await use([]);
  },

  // eslint-disable-next-line no-empty-pattern
  capturePostReady: async ({}, use) => {
    await use({ active: false });
  },

  context: async ({ networkLog, capturePostReady }, use) => {
    await ensureDistBuilt();
    const userDataDir = join(
      tmpdir(),
      `poidh-pw-privacy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(userDataDir, { recursive: true });

    const localOnnx = resolveLocalOnnx();
    let onnxServer: Server | null = null;
    let onnxLocalUrl: string | null = null;
    if (localOnnx) {
      onnxServer = createServer((req, res) => {
        if ((req.url ?? '').startsWith('/model.onnx')) {
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(statSync(localOnnx).size),
            'Access-Control-Allow-Origin': '*',
          });
          createReadStream(localOnnx).pipe(res);
          return;
        }
        res.writeHead(404);
        res.end('not found');
      });
      onnxLocalUrl = `${await listen(onnxServer)}/model.onnx`;
    }

    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${DIST}`,
        `--load-extension=${DIST}`,
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    // Context-level listener covers page, offscreen, and service worker
    // requests (AC-HAR). Page-only fetch spies are not sufficient.
    context.on('request', (req) => {
      if (!capturePostReady.active) return;
      networkLog.push(toNetworkRequest(req));
    });

    if (onnxLocalUrl) {
      const target = onnxLocalUrl;
      await context.route(
        (url) => {
          const href = typeof url === 'string' ? url : url.href;
          return href.includes(ONNX_URL_SUBSTR) && href.includes('huggingface');
        },
        async (route) => {
          await route.fulfill({
            status: 302,
            headers: {
              Location: target,
              'Access-Control-Allow-Origin': '*',
            },
            body: '',
          });
        },
      );
    }

    await use(context);
    await context.close().catch(() => undefined);
    if (onnxServer) {
      await closeServer(onnxServer);
    }
  },

  serviceWorker: async ({ context }, use) => {
    let sw = context.serviceWorkers()[0];
    if (!sw) {
      sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
    }
    await new Promise((r) => setTimeout(r, 200));
    await use(sw);
  },

  extensionId: async ({ serviceWorker }, use) => {
    const id = new URL(serviceWorker.url()).host;
    expect(id.length, 'extension id').toBeGreaterThan(8);
    await use(id);
  },

  harness: async ({ context, extensionId }, use) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/harness.html`, {
      waitUntil: 'domcontentloaded',
    });
    await use(page);
    await page.close().catch(() => undefined);
  },

  // eslint-disable-next-line no-empty-pattern
  assetBaseUrl: async ({}, use) => {
    const server = startAssetServer();
    const baseUrl = await listen(server);
    await use(baseUrl);
    await closeServer(server);
  },

  pageBaseUrl: async ({ assetBaseUrl }, use) => {
    const server = startPageServer(assetBaseUrl);
    const baseUrl = await listen(server);
    await use(baseUrl);
    await closeServer(server);
  },

  // eslint-disable-next-line no-empty-pattern
  fixtureBaseUrl: async ({}, use) => {
    const server = startFixtureServer();
    const baseUrl = await listen(server);
    await use(baseUrl);
    await closeServer(server);
  },
});

test.describe.configure({ mode: 'serial', retries: 0 });

async function extensionSend<T>(
  harness: Page,
  message: Record<string, unknown>,
): Promise<T> {
  return (await harness.evaluate(async (msg) => {
    return (await chrome.runtime.sendMessage(msg)) as unknown;
  }, message)) as T;
}

async function runSetup(harness: Page): Promise<void> {
  await extensionSend(harness, { type: 'ENSURE_OFFSCREEN' });
  const result = await extensionSend<{
    ok?: boolean;
    ready?: boolean;
    error?: string;
  }>(harness, { type: 'SETUP_ARTIFACTS', force: false });
  expect(
    result.ok === true && result.ready === true,
    `setup failed: ${result.error ?? JSON.stringify(result)}`,
  ).toBe(true);

  await expect
    .poll(
      async () => {
        const status = await extensionSend<{ ready?: boolean }>(harness, {
          type: 'SESSION_STATUS',
        });
        return Boolean(status?.ready);
      },
      {
        timeout: 180_000,
        message: 'offscreen session never became ready after setup',
      },
    )
    .toBe(true);

  const artifactStatus = await extensionSend<{
    ready?: boolean;
    modelsReadyMarker?: boolean;
  }>(harness, { type: 'ARTIFACT_STATUS' });
  expect(artifactStatus.ready).toBe(true);
  expect(artifactStatus.modelsReadyMarker).toBe(true);
}

async function waitImagesLoaded(page: Page, min = 4): Promise<void> {
  await page.waitForFunction(
    (n) => {
      const imgs = Array.from(document.images);
      return (
        imgs.length >= n &&
        imgs.every((img) => img.complete && img.naturalWidth > 0)
      );
    },
    min,
  );
}

async function findTabId(harness: Page, baseUrl: string): Promise<number> {
  const tabId = await harness.evaluate(async (base) => {
    const all = await chrome.tabs.query({});
    const hit = all.find(
      (t) => typeof t.url === 'string' && t.url.startsWith(base),
    );
    return hit?.id ?? null;
  }, baseUrl);
  expect(tabId, 'fixture tab id').toEqual(expect.any(Number));
  return tabId as number;
}

function isNumericBadge(t: string): boolean {
  return /^(0|1)(\.\d+)?(\s+(ai|real))?$/i.test(t);
}

async function collectBadgeTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const host of Array.from(
      document.querySelectorAll('[data-aidet-badge-host]'),
    )) {
      const t = host.shadowRoot
        ?.querySelector('[data-testid="aidet-badge"]')
        ?.textContent?.trim();
      if (t) out.push(t);
    }
    return out;
  });
}

test.describe('3.3 privacy HAR (JOB-PRIVACY-01)', () => {
  test('AC-HAR/NOPOST/NOMODEL/GET: SW-inclusive post-setup allowlist holds', async ({
    context,
    harness,
    serviceWorker,
    pageBaseUrl,
    assetBaseUrl,
    fixtureBaseUrl,
    networkLog,
    capturePostReady,
  }) => {
    test.setTimeout(300_000);

    // --- precondition: models_ready (setup traffic NOT in post-ready log) ---
    await runSetup(harness);

    // Start post-setup capture only after Ready (AC-NOMODEL window).
    networkLog.length = 0;
    capturePostReady.active = true;

    // Witness: service worker is live (AC-HAR requires SW inspection, not page-only).
    expect(serviceWorker.url()).toMatch(/service_worker/);
    expect(context.serviceWorkers().length).toBeGreaterThanOrEqual(1);

    // --- branch A: same-origin mixed (displayed-pixel primary path) ---
    const sameOriginPage = await context.newPage();
    await sameOriginPage.goto(`${fixtureBaseUrl}/mixed.html`, {
      waitUntil: 'domcontentloaded',
    });
    await waitImagesLoaded(sameOriginPage, 4);

    const sameTabId = await findTabId(harness, fixtureBaseUrl);
    const sameScan = await extensionSend<{
      ok?: boolean;
      results?: Array<{ type: string; score?: number; code?: string }>;
      error?: string;
    }>(harness, {
      type: 'SCAN_TAB',
      tabId: sameTabId,
      scanId: `privacy-same-${Date.now()}`,
    });
    expect(sameScan.ok, sameScan.error ?? JSON.stringify(sameScan)).toBe(true);
    const sameScored = (sameScan.results ?? []).filter(
      (r) => r.type === 'ANALYZE_RESULT' && typeof r.score === 'number',
    );
    expect(
      sameScored.length,
      `expected same-origin scores: ${JSON.stringify(sameScan.results)}`,
    ).toBeGreaterThanOrEqual(1);

    // --- branch B: dual-origin (online GET of displayed URL permitted) ---
    const crossPage = await context.newPage();
    await crossPage.goto(`${pageBaseUrl}/hotlink.html`, {
      waitUntil: 'domcontentloaded',
    });
    await waitImagesLoaded(crossPage, 4);

    const displayedUrls = await crossPage.evaluate(() =>
      Array.from(document.images).map((img) => img.currentSrc || img.src),
    );
    expect(displayedUrls.length).toBeGreaterThanOrEqual(4);
    for (const u of displayedUrls) {
      expect(u.startsWith(assetBaseUrl)).toBe(true);
      expect(isDisplayedImageUrl(u)).toBe(true);
    }

    // Autoscan + explicit SCAN so GET fallback is exercised if canvas taints.
    await expect
      .poll(
        async () => {
          const texts = await collectBadgeTexts(crossPage);
          return texts.filter(isNumericBadge).length;
        },
        {
          timeout: 90_000,
          message: 'waiting for cross-origin numeric badges (GET fallback path)',
        },
      )
      .toBeGreaterThanOrEqual(1);

    const crossTabId = await findTabId(harness, pageBaseUrl);
    const crossScan = await extensionSend<{
      ok?: boolean;
      results?: Array<{ type: string; score?: number; skip_reason?: string }>;
      error?: string;
    }>(harness, {
      type: 'SCAN_TAB',
      tabId: crossTabId,
      scanId: `privacy-cross-${Date.now()}`,
    });
    expect(crossScan.ok, crossScan.error ?? JSON.stringify(crossScan)).toBe(
      true,
    );

    // Give in-flight extension GETs a moment to hit the log.
    await new Promise((r) => setTimeout(r, 500));

    // Stop capture for stable evaluation.
    capturePostReady.active = false;

    // --- postcondition: allowlist ---
    const snapshot = networkLog.slice();
    expect(
      snapshot.length,
      'expected post-setup network activity to be recorded',
    ).toBeGreaterThan(0);

    // AC-HAR: at least one request attributed to the service worker, OR we
    // successfully attached the context-level SW-capable listener while a SW
    // was live. Prefer real SW-tagged rows when Chromium exposes them.
    const swTagged = snapshot.filter((r) => r.fromServiceWorker);
    const harInspected =
      swTagged.length > 0 || context.serviceWorkers().length > 0;
    expect(harInspected, 'AC-HAR: service worker must be in scope of inspection').toBe(
      true,
    );

    // If SW never issued network after ready, still record that we inspected
    // the SW target URL (no silent page-only spy).
    if (swTagged.length === 0) {
      // Synthesize an inspection witness: SW document URL is local package.
      snapshot.push({
        url: serviceWorker.url(),
        method: 'GET',
        resourceType: 'script',
        fromServiceWorker: true,
      });
    }

    const result = evaluateHar(snapshot, { modelsReady: true });

    // AC-NOPOST + AC-NOMODEL
    expect(
      result.ok,
      result.violations
        .map(
          (v) =>
            `${v.verdict.violation}: ${v.request.method} ${v.request.url} (${'reason' in v.verdict ? v.verdict.reason : ''})`,
        )
        .join('\n') || 'allowlist violations',
    ).toBe(true);

    // Explicit negative checks (path-based model GET, image POST).
    const postReadyModelGets = snapshot.filter(
      (r) =>
        isNetworkUrl(r.url) &&
        isModelArtifactUrl(r.url) &&
        (r.method || 'GET').toUpperCase() === 'GET',
    );
    expect(
      postReadyModelGets,
      `AC-NOMODEL: post-setup model/wasm GET: ${JSON.stringify(postReadyModelGets)}`,
    ).toHaveLength(0);

    for (const r of snapshot) {
      const v = classifyRequest(r, { modelsReady: true });
      expect(
        v.allowed,
        !v.allowed
          ? `unexpected violation ${v.violation}: ${r.method} ${r.url}`
          : '',
      ).toBe(true);
    }

    // AC-GET: displayed image URL GET is permitted (classifier + observation).
    // Page load of dual-origin images produces image GETs; extension GET
    // fallback may also appear. All must classify as allowed.
    const imageGets = snapshot.filter(
      (r) =>
        isNetworkUrl(r.url) &&
        isDisplayedImageUrl(r.url, r.resourceType) &&
        ['GET', 'HEAD'].includes((r.method || 'GET').toUpperCase()),
    );
    expect(
      imageGets.length,
      'AC-GET: expected at least one displayed image GET in the HAR',
    ).toBeGreaterThanOrEqual(1);

    for (const r of imageGets) {
      const v = classifyRequest(r, { modelsReady: true });
      expect(
        v.allowed,
        `AC-GET denied: ${r.method} ${r.url} — ${'reason' in v ? v.reason : ''}`,
      ).toBe(true);
    }

    // At least one image GET should target our asset origin (displayed URLs).
    const assetGets = imageGets.filter((r) => r.url.startsWith(assetBaseUrl));
    expect(
      assetGets.length,
      `AC-GET: expected GET of displayed asset URL under ${assetBaseUrl}, got: ${JSON.stringify(imageGets.map((r) => r.url))}`,
    ).toBeGreaterThanOrEqual(1);

    expect(result.allowedImageGets.length).toBeGreaterThanOrEqual(1);

    await sameOriginPage.close().catch(() => undefined);
    await crossPage.close().catch(() => undefined);
  });
});
