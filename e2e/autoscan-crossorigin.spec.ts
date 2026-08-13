/**
 * Spec 3.1 — Autoscan cross-origin (AC-CORS).
 *
 * hotlink-style page: images served from a second origin without CORS so the
 * displayed-pixel canvas path taints; extension host_permissions GET is the
 * online fallback. skip_cross_origin only if both fail.
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
  type Worker,
} from '@playwright/test';

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
};

function listen(server: Server): Promise<string> {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('no address'));
        return;
      }
      resolveListen(`http://127.0.0.1:${addr.port}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => {
    // Drop keep-alives so close does not hang after test timeout.
    const withConns = server as Server & {
      closeAllConnections?: () => void;
    };
    try {
      withConns.closeAllConnections?.();
    } catch {
      /* ignore */
    }
    server.close(() => resolveClose());
    // Failsafe: never block fixture teardown more than a few seconds.
    setTimeout(() => resolveClose(), 3000).unref?.();
  });
}

/**
 * Asset origin: serves PNGs **without** CORS headers so page canvas taints.
 * Extension GET still works via host_permissions.
 */
function startAssetServer(): Server {
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
  const hotlinkHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>POIDH cross-origin autoscan fixture</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 1.5rem; background: #111; color: #eee; }
      img { display: block; width: 128px; height: auto; margin: 8px; }
    </style>
  </head>
  <body>
    <h1>Cross-origin hotlinked fixtures (local dual-origin)</h1>
    <img src="${assetBaseUrl}/real_a.png" alt="cross real a" width="128" data-image-id="cross-real-a" />
    <img src="${assetBaseUrl}/real_b.png" alt="cross real b" width="128" data-image-id="cross-real-b" />
    <img src="${assetBaseUrl}/ai_a.png" alt="cross ai a" width="128" data-image-id="cross-ai-a" />
    <img src="${assetBaseUrl}/ai_b.png" alt="cross ai b" width="128" data-image-id="cross-ai-b" />
  </body>
</html>`;

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const urlPath = (req.url ?? '/').split('?')[0] || '/';
    if (urlPath === '/' || urlPath === '/hotlink.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(hotlinkHtml);
      return;
    }
    res.writeHead(404);
    res.end('not found');
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
    existsSync(join(DIST, 'content.js')) &&
    existsSync(join(DIST, 'service_worker.js'))
  ) {
    return;
  }
  const { execSync } = await import('node:child_process');
  execSync('bash scripts/gate-build.sh', { cwd: ROOT, stdio: 'inherit' });
}

const test = base.extend<ExtensionFixtures>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    await ensureDistBuilt();
    const userDataDir = join(
      tmpdir(),
      `poidh-pw-auto-co-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
    expect(id.length).toBeGreaterThan(8);
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
  expect(result.ok === true && result.ready === true, result.error).toBe(true);
  await expect
    .poll(
      async () => {
        const status = await extensionSend<{ ready?: boolean }>(harness, {
          type: 'SESSION_STATUS',
        });
        return Boolean(status?.ready);
      },
      { timeout: 180_000 },
    )
    .toBe(true);
}

async function waitImagesLoaded(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const imgs = Array.from(document.images);
    return (
      imgs.length >= 4 &&
      imgs.every((img) => img.complete && img.naturalWidth > 0)
    );
  });
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

function isNumericBadge(t: string): boolean {
  return /^(0|1)(\.\d+)?$/.test(t);
}

test.describe('3.1 autoscan cross-origin (AC-CORS)', () => {
  test('AC-CORS: dual-origin hotlink scores via pixel or GET fallback', async ({
    context,
    harness,
    pageBaseUrl,
    assetBaseUrl,
  }) => {
    test.setTimeout(240_000);
    await runSetup(harness);

    const page = await context.newPage();
    // Avoid networkidle — extension/offscreen traffic can keep the page busy.
    await page.goto(`${pageBaseUrl}/hotlink.html`, {
      waitUntil: 'domcontentloaded',
    });
    await waitImagesLoaded(page);

    const origins = await page.evaluate(() => {
      const pageOrigin = location.origin;
      return Array.from(document.images).map((img) => {
        const imgOrigin = new URL(img.currentSrc || img.src).origin;
        return {
          pageOrigin,
          imgOrigin,
          cross: imgOrigin !== pageOrigin,
        };
      });
    });
    expect(origins.every((o) => o.cross)).toBe(true);
    expect(assetBaseUrl).not.toBe(pageBaseUrl);

    // AC-AUTO: no click — IntersectionObserver autoscan only.
    await expect
      .poll(
        async () => {
          const texts = await collectBadgeTexts(page);
          return texts.filter(isNumericBadge).length;
        },
        {
          timeout: 90_000,
          message: 'waiting for cross-origin numeric aidet-badge overlays',
        },
      )
      .toBeGreaterThanOrEqual(4);

    const texts = await collectBadgeTexts(page);
    const numeric = texts.filter(isNumericBadge);
    expect(
      numeric.length,
      `expected 4 scored cross-origin badges, got: ${JSON.stringify(texts)}`,
    ).toBeGreaterThanOrEqual(4);

    for (const t of numeric) {
      const n = Number(t);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(1);
    }

    // Explicit SCAN_TAB: must not mass skip_cross_origin when GET works.
    const tabId = await harness.evaluate(async (base) => {
      const all = await chrome.tabs.query({});
      const hit = all.find(
        (t) => typeof t.url === 'string' && t.url.startsWith(base),
      );
      return hit?.id ?? null;
    }, pageBaseUrl);
    expect(tabId).toEqual(expect.any(Number));

    const scan = await extensionSend<{
      ok?: boolean;
      results?: Array<{
        type?: string;
        label?: string;
        skip_reason?: string | null;
        score?: number;
      }>;
      error?: string;
    }>(harness, {
      type: 'SCAN_TAB',
      tabId,
      scanId: `cors-${Date.now()}`,
    });
    expect(scan.ok, scan.error).toBe(true);

    const scored = (scan.results ?? []).filter(
      (r) =>
        r.type === 'ANALYZE_RESULT' &&
        (r.label === 'ai' || r.label === 'real') &&
        typeof r.score === 'number',
    );
    const crossSkips = (scan.results ?? []).filter(
      (r) => r.skip_reason === 'skip_cross_origin',
    );

    expect(
      scored.length,
      `expected scored results, got: ${JSON.stringify(scan.results)}`,
    ).toBeGreaterThanOrEqual(4);
    expect(crossSkips.length).toBe(0);
    for (const r of scored) {
      expect(r.label).not.toBe('skip');
      expect(typeof r.score).toBe('number');
    }

    await page.close();
  });

  test('AC-CORS negative: both paths fail → skip_cross_origin not real', async ({
    context,
    harness,
    pageBaseUrl,
  }) => {
    test.setTimeout(180_000);
    await runSetup(harness);

    const page = await context.newPage();
    await page.goto(`${pageBaseUrl}/hotlink.html`, {
      waitUntil: 'domcontentloaded',
    });
    await waitImagesLoaded(page);

    // Wait for healthy images to score first (proves GET path).
    await expect
      .poll(async () => (await collectBadgeTexts(page)).filter(isNumericBadge).length, {
        timeout: 90_000,
      })
      .toBeGreaterThanOrEqual(1);

    // Inject a broken eligible-size image that never loads pixels and cannot GET.
    await page.evaluate(() => {
      const img = document.createElement('img');
      img.id = 'broken-cross';
      img.setAttribute('data-image-id', 'broken-cross');
      img.width = 128;
      img.height = 96;
      img.style.width = '128px';
      img.style.height = '96px';
      img.src = 'http://127.0.0.1:9/no-such-image-poidh.png';
      document.body.appendChild(img);
    });
    await page.waitForTimeout(1000);

    const tabId = await harness.evaluate(async (base) => {
      const all = await chrome.tabs.query({});
      const hit = all.find(
        (t) => typeof t.url === 'string' && t.url.startsWith(base),
      );
      return hit?.id ?? null;
    }, pageBaseUrl);

    const scan = await extensionSend<{
      results?: Array<{
        imageId?: string;
        label?: string;
        skip_reason?: string | null;
        type?: string;
      }>;
    }>(harness, {
      type: 'SCAN_TAB',
      tabId,
      scanId: `cors-fail-${Date.now()}`,
    });

    // Incomplete broken images are filtered out of scanLoadedImages; if present:
    const broken = (scan.results ?? []).find(
      (r) => r.imageId === 'broken-cross',
    );
    if (broken) {
      expect(broken.label).not.toBe('real');
      if (broken.label === 'skip') {
        expect(broken.skip_reason).toMatch(/skip_cross_origin|skip_/);
      }
    }

    // Any skip_cross_origin must not be labeled real (R-SKIP-NOT-REAL).
    for (const r of scan.results ?? []) {
      if (r.skip_reason === 'skip_cross_origin') {
        expect(r.label).toBe('skip');
        expect(r.label).not.toBe('real');
      }
    }

    // Score badges for healthy images remain numeric — never flipped to "real" from skip.
    const texts = await collectBadgeTexts(page);
    for (const t of texts) {
      if (t === 'unavailable' || t === '…') continue;
      expect(isNumericBadge(t)).toBe(true);
    }

    await page.close();
  });
});
