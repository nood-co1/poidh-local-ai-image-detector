/**
 * Spec 2.3 — Offline proof (soul 3).
 *
 * After artifacts are cached:
 *   1. Open a **page fixture** with images already loaded
 *   2. Go offline + block 127.0.0.1 / localhost
 *   3. Trigger content-script scan of **already-displayed pixels**
 * Scores must come from createImageBitmap/draw of the loaded <img>, not a new GET.
 *
 * retries: 0 (claim suite). Does **not** mock infer().
 * debug.html is not soul-3 evidence — this suite uses eval/fixtures/mixed.html.
 */

import { createServer, type Server } from 'node:http';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
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
const ONNX_URL_SUBSTR = 'onnx/model.onnx';
const EXPECTED_ONNX_SHA =
  'a42c7d740fbb345ba9a26d469b22f301d73089ce3c6da993877ed2b6965a8ba1';
const LOCAL_ONNX_CANDIDATES = [
  process.env.POIDH_ONNX_CACHE,
  '/tmp/poidh-onnx-cache/model.onnx',
  join(ROOT, 'evidence', '.cache', 'model.onnx'),
].filter((p): p is string => Boolean(p));

type AnalyzeLike = {
  type: string;
  scanId?: string;
  imageId?: string;
  score?: number;
  label?: string;
  skip_reason?: string | null;
  code?: string;
};

type ScanPageResult = {
  type: string;
  ok?: boolean;
  scanId?: string;
  results?: AnalyzeLike[];
  error?: string;
};

type ExtensionFixtures = {
  context: BrowserContext;
  extensionId: string;
  serviceWorker: Worker;
  harness: Page;
  fixtureBaseUrl: string;
};

function mimeFor(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json';
    default:
      return 'application/octet-stream';
  }
}

/** Serve eval/fixtures over 127.0.0.1 so AC-LOCAL can later block localhost. */
async function startFixtureServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    const urlPath = (req.url ?? '/').split('?')[0] || '/';
    const rel = urlPath === '/' ? '/mixed.html' : urlPath;
    const filePath = resolve(FIXTURES, `.${rel}`);
    if (!filePath.startsWith(FIXTURES) || !existsSync(filePath)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mimeFor(filePath) });
    createReadStream(filePath).pipe(res);
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('fixture server has no address');
  }
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
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

const test = base.extend<ExtensionFixtures>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    await ensureDistBuilt();
    const userDataDir = join(
      tmpdir(),
      `poidh-pw-offline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(userDataDir, { recursive: true });

    const localOnnx = resolveLocalOnnx();

    // Serve the pinned ONNX over plain HTTP (not CDP route.fulfill — 87MB blows
    // the DevTools pipe). Extension fetch is redirected to this loopback server.
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
      await new Promise<void>((resolveListen, reject) => {
        onnxServer!.once('error', reject);
        onnxServer!.listen(0, '127.0.0.1', () => resolveListen());
      });
      const addr = onnxServer.address();
      if (addr && typeof addr !== 'string') {
        onnxLocalUrl = `http://127.0.0.1:${addr.port}/model.onnx`;
      }
    }

    // Full Chromium is required for MV3 extensions (headless-shell cannot load them).
    // CI runs under xvfb-run (see scripts/gate-full.d/15-offline-unit.sh).
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

    // Tiny redirect only — never push ONNX bytes through CDP.
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
    await context.close();
    if (onnxServer) {
      await new Promise<void>((resolveClose) =>
        onnxServer!.close(() => resolveClose()),
      );
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
  fixtureBaseUrl: async ({}, use) => {
    const { server, baseUrl } = await startFixtureServer();
    await use(baseUrl);
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  },
});

test.describe.configure({ mode: 'serial', retries: 0 });

async function extensionSend<T>(
  harness: Page,
  message: Record<string, unknown>,
): Promise<T> {
  const result = await harness.evaluate(async (msg) => {
    return (await chrome.runtime.sendMessage(msg)) as unknown;
  }, message);
  return result as T;
}

async function runSetup(harness: Page): Promise<void> {
  // Precondition branch: ensure offscreen exists, then download/verify artifacts.
  await extensionSend(harness, { type: 'ENSURE_OFFSCREEN' });

  const result = await extensionSend<{
    type?: string;
    ok?: boolean;
    ready?: boolean;
    error?: string;
    sha256?: string | null;
  }>(harness, { type: 'SETUP_ARTIFACTS', force: false });

  expect(result, `SETUP_ARTIFACTS response: ${JSON.stringify(result)}`).toBeTruthy();
  expect(
    result.ok === true && result.ready === true,
    `setup failed: ${result.error ?? JSON.stringify(result)}`,
  ).toBe(true);

  // Wait until offscreen session reports ready (model loaded from store).
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

async function waitImagesLoaded(page: Page): Promise<number> {
  await page.waitForFunction(() => {
    const imgs = Array.from(document.images);
    return (
      imgs.length > 0 &&
      imgs.every((img) => img.complete && img.naturalWidth > 0)
    );
  });
  return page.evaluate(() => document.images.length);
}

/**
 * Go offline and refuse localhost / 127.0.0.1 so any re-GET of fixture assets fails.
 */
async function goOfflineAndBlockLocalhost(context: BrowserContext): Promise<void> {
  await context.setOffline(true);
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('chrome-extension://') || url.startsWith('blob:')) {
      await route.continue();
      return;
    }
    if (
      url.includes('127.0.0.1') ||
      url.includes('localhost') ||
      url.startsWith('http://[::1]')
    ) {
      await route.abort('connectionfailed');
      return;
    }
    if (url.startsWith('http://') || url.startsWith('https://')) {
      await route.abort('internetdisconnected');
      return;
    }
    await route.continue();
  });
}

async function findFixtureTabId(
  harness: Page,
  fixtureBaseUrl: string,
): Promise<number> {
  const tabId = await harness.evaluate(async (base) => {
    const all = await chrome.tabs.query({});
    const hit = all.find(
      (t) => typeof t.url === 'string' && t.url.startsWith(base),
    );
    return hit?.id ?? null;
  }, fixtureBaseUrl);
  expect(tabId, 'fixture tab id').toEqual(expect.any(Number));
  return tabId as number;
}

test.describe('2.3 offline inference proof (soul 3)', () => {
  test('AC-OFF + AC-LOCAL: score from displayed pixels while offline and localhost blocked', async ({
    context,
    harness,
    fixtureBaseUrl,
  }) => {
    // --- precondition: models_ready ---
    await runSetup(harness);

    // --- open fixture page (not debug.html) and wait for images loaded ---
    const page = await context.newPage();
    await page.goto(`${fixtureBaseUrl}/mixed.html`, {
      waitUntil: 'networkidle',
    });
    const imageCount = await waitImagesLoaded(page);
    expect(imageCount).toBeGreaterThanOrEqual(4);

    const fixtureTabId = await findFixtureTabId(harness, fixtureBaseUrl);

    // Content-script witness: images loaded on the fixture page.
    const ping = await harness.evaluate(async (tabId) => {
      return (await chrome.tabs.sendMessage(tabId, {
        type: 'CONTENT_PING',
      })) as { imagesLoaded?: number; imagesTotal?: number };
    }, fixtureTabId);
    expect(ping.imagesLoaded ?? 0).toBeGreaterThanOrEqual(4);

    // --- branch: offline + localhost blocked ---
    await goOfflineAndBlockLocalhost(context);

    // Witness: a fresh GET of a fixture asset must fail (AC-LOCAL / offline).
    const blocked = await page.evaluate(async () => {
      try {
        const res = await fetch('assets/real_a.png', { cache: 'no-store' });
        return { ok: res.ok, status: res.status };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });
    expect(blocked.ok).toBe(false);

    // --- trigger content-script scan of already-displayed pixels ---
    const scanId = `offline-${Date.now()}`;
    const scan = await extensionSend<ScanPageResult>(harness, {
      type: 'SCAN_TAB',
      tabId: fixtureTabId,
      scanId,
    });

    expect(scan, JSON.stringify(scan)).toBeTruthy();
    expect(scan.ok, scan.error ?? JSON.stringify(scan)).toBe(true);
    expect(scan.results?.length ?? 0).toBeGreaterThanOrEqual(1);

    const scored = (scan.results ?? []).filter((r) => r.type === 'ANALYZE_RESULT');
    const errors = (scan.results ?? []).filter((r) => r.type === 'ANALYZE_ERROR');

    // Postcondition: numeric scores (not skips-as-real, not MODEL_MISSING).
    expect(
      scored.length,
      `expected ANALYZE_RESULT scores, got: ${JSON.stringify(scan.results)}`,
    ).toBeGreaterThanOrEqual(1);
    expect(errors.filter((e) => e.code === 'MODEL_MISSING')).toHaveLength(0);

    for (const r of scored) {
      expect(typeof r.score).toBe('number');
      expect(Number.isFinite(r.score!)).toBe(true);
      expect(r.score!).toBeGreaterThanOrEqual(0);
      expect(r.score!).toBeLessThanOrEqual(1);
      expect(['ai', 'real']).toContain(r.label);
      expect(r.scanId).toBe(scanId);
    }

    await page.close();
  });

  test('AC-MISS: deleting OPFS then offline yields ANALYZE_ERROR (not real)', async ({
    context,
    harness,
    fixtureBaseUrl,
  }) => {
    await runSetup(harness);

    const page = await context.newPage();
    await page.goto(`${fixtureBaseUrl}/mixed.html`, {
      waitUntil: 'networkidle',
    });
    await waitImagesLoaded(page);

    const fixtureTabId = await findFixtureTabId(harness, fixtureBaseUrl);

    // Delete OPFS/Cache artifacts + drop session (negative path).
    const cleared = await extensionSend<{ ok?: boolean; error?: string }>(
      harness,
      { type: 'CLEAR_ARTIFACTS' },
    );
    expect(cleared.ok, cleared.error).toBe(true);

    const status = await extensionSend<{ ready?: boolean }>(harness, {
      type: 'ARTIFACT_STATUS',
    });
    expect(status.ready).toBe(false);

    await goOfflineAndBlockLocalhost(context);

    const scanId = `miss-${Date.now()}`;
    const scan = await extensionSend<ScanPageResult>(harness, {
      type: 'SCAN_TAB',
      tabId: fixtureTabId,
      scanId,
    });

    expect(scan.ok, scan.error).toBe(true);
    expect(scan.results?.length ?? 0).toBeGreaterThanOrEqual(1);

    for (const r of scan.results ?? []) {
      // Fail closed: ANALYZE_ERROR, never a synthetic "real" score.
      expect(r.type).toBe('ANALYZE_ERROR');
      expect(r.code).toMatch(/MODEL_MISSING|INFER|DECODE/);
      expect(r.label).not.toBe('real');
      expect(r.score).toBeUndefined();
    }

    await page.close();
  });
});
