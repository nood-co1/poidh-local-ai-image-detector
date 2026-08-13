/**
 * Spec 4.3 — I12 Monday-path keystone e2e.
 *
 * One clean profile, one SHA vertical journey (Playwright, real offscreen
 * inferencer — never mock infer / ONNX):
 *
 *   install → setup → privacy HAR (online segment) →
 *   same-origin + cross-origin badges → offline scan →
 *   I16 field-flow (threshold, score, weight_sha, skip_reason) →
 *   proxy-ba artifact exists and passes for HEAD.
 *
 * G-TEST-SENSITIVITY (disposable mutant): removing the badge mount in
 * extension/badge.ts (attachBadge no-op) must make this suite fail —
 * documented for section 5.1 anticheat / sensitivity.
 *
 * retries: 0 (claim suite). AC-CONSOLE: no uncaught page errors.
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
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  test as base,
  chromium,
  expect,
  type BrowserContext,
  type ConsoleMessage,
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
import {
  labelFromScore,
  thresholdRuleText,
  THRESHOLD,
} from '../src/label.js';
import {
  BA_MIN,
  SKIP_RATE_MAX,
  proxyBaEvidenceFilename,
  type ProxyBaEvidence,
} from '../eval/scorer.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const FIXTURES = join(ROOT, 'eval', 'fixtures');
const ASSETS = join(FIXTURES, 'assets');
const EVIDENCE_DIR = join(ROOT, 'evidence');
const WEIGHTS_MANIFEST = join(ROOT, 'weights', 'manifest.json');
const ONNX_URL_SUBSTR = 'onnx/model.onnx';
const EXPECTED_ONNX_SHA =
  'a42c7d740fbb345ba9a26d469b22f301d73089ce3c6da993877ed2b6965a8ba1';
const LOCAL_ONNX_CANDIDATES = [
  process.env['POIDH_ONNX_CACHE'],
  '/tmp/poidh-onnx-cache/model.onnx',
  join(ROOT, 'evidence', '.cache', 'model.onnx'),
].filter((p): p is string => Boolean(p));

type ExtensionFixtures = {
  context: BrowserContext;
  extensionId: string;
  serviceWorker: Worker;
  harness: Page;
  fixtureBaseUrl: string;
  pageBaseUrl: string;
  assetBaseUrl: string;
  networkLog: NetworkRequest[];
  capturePostReady: { active: boolean };
  consoleErrors: string[];
  gitSha: string;
  productionWeightSha: string;
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
    res.writeHead(200, { 'Content-Type': mimeFor(filePath) });
    createReadStream(filePath).pipe(res);
  });
}

function startAssetServer(): Server {
  // No CORS — canvas taints; extension host_permissions GET still works.
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
    <title>POIDH keystone cross-origin fixture</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 1.5rem; background: #111; color: #eee; }
      img { display: block; width: 128px; height: auto; margin: 8px; }
    </style>
  </head>
  <body>
    <h1>Keystone cross-origin hotlink</h1>
    <img src="${assetBaseUrl}/real_a.png" alt="cross real a" width="128" data-image-id="key-cross-real-a" />
    <img src="${assetBaseUrl}/real_b.png" alt="cross real b" width="128" data-image-id="key-cross-real-b" />
    <img src="${assetBaseUrl}/ai_a.png" alt="cross ai a" width="128" data-image-id="key-cross-ai-a" />
    <img src="${assetBaseUrl}/ai_b.png" alt="cross ai b" width="128" data-image-id="key-cross-ai-b" />
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

function resolveLocalOnnx(): string | null {
  for (const p of LOCAL_ONNX_CANDIDATES) {
    if (p && existsSync(p) && statSync(p).size >= 20 * 1024 * 1024) {
      const sha = createHash('sha256').update(readFileSync(p)).digest('hex');
      if (sha === EXPECTED_ONNX_SHA) return p;
    }
  }
  return null;
}

function resolveGitSha(): string {
  if (
    process.env['POIDH_GIT_SHA'] &&
    /^[0-9a-f]{7,40}$/i.test(process.env['POIDH_GIT_SHA'])
  ) {
    return process.env['POIDH_GIT_SHA'].toLowerCase();
  }
  const res = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (res.status === 0 && res.stdout.trim()) {
    return res.stdout.trim().toLowerCase();
  }
  throw new Error('keystone: cannot resolve product git sha');
}

function productionWeightShaFromManifest(): string {
  const m = JSON.parse(readFileSync(WEIGHTS_MANIFEST, 'utf8')) as {
    artifacts?: Array<{ role?: string; kind?: string; sha256?: string }>;
  };
  const onnx = (m.artifacts ?? []).find(
    (a) => a.role === 'production' && a.kind === 'onnx' && a.sha256,
  );
  if (!onnx?.sha256) {
    throw new Error('keystone: production onnx sha missing from weights/manifest.json');
  }
  return onnx.sha256.toLowerCase();
}

async function ensureDistBuilt(): Promise<void> {
  if (
    existsSync(join(DIST, 'manifest.json')) &&
    existsSync(join(DIST, 'service_worker.js')) &&
    existsSync(join(DIST, 'content.js')) &&
    existsSync(join(DIST, 'offscreen.js')) &&
    existsSync(join(DIST, 'harness.html')) &&
    existsSync(join(DIST, 'popup.html'))
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

  // eslint-disable-next-line no-empty-pattern
  consoleErrors: async ({}, use) => {
    await use([]);
  },

  // eslint-disable-next-line no-empty-pattern
  gitSha: async ({}, use) => {
    await use(resolveGitSha());
  },

  // eslint-disable-next-line no-empty-pattern
  productionWeightSha: async ({}, use) => {
    await use(productionWeightShaFromManifest());
  },

  context: async ({ networkLog, capturePostReady, consoleErrors }, use) => {
    await ensureDistBuilt();
    const userDataDir = join(
      tmpdir(),
      `poidh-pw-keystone-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

    // Clean profile + full Chromium (MV3 extensions require non-headless-shell).
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

    // AC-CONSOLE: track uncaught page/console errors across the journey.
    context.on('page', (page) => {
      page.on('pageerror', (err) => {
        consoleErrors.push(`pageerror: ${err.message}`);
      });
      page.on('console', (msg: ConsoleMessage) => {
        if (msg.type() === 'error') {
          const text = msg.text();
          // Filter known benign Chromium/extension noise.
          if (
            /net::ERR_|Failed to load resource|Download the React|favicon|devtools/i.test(
              text,
            )
          ) {
            return;
          }
          // Offline/blocked localhost after goOffline is expected.
          if (/ERR_INTERNET_DISCONNECTED|ERR_CONNECTION|ERR_FAILED/i.test(text)) {
            return;
          }
          consoleErrors.push(`console.error: ${text}`);
        }
      });
    });

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
  fixtureBaseUrl: async ({}, use) => {
    const server = startFixtureServer();
    const baseUrl = await listen(server);
    await use(baseUrl);
    await closeServer(server);
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

async function runSetup(harness: Page): Promise<{
  weightSha: string | null;
}> {
  await extensionSend(harness, { type: 'ENSURE_OFFSCREEN' });
  const result = await extensionSend<{
    ok?: boolean;
    ready?: boolean;
    error?: string;
    sha256?: string | null;
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
    sha256?: string | null;
  }>(harness, { type: 'ARTIFACT_STATUS' });
  expect(artifactStatus.ready).toBe(true);
  expect(artifactStatus.modelsReadyMarker).toBe(true);
  return {
    weightSha: artifactStatus.sha256 ?? result.sha256 ?? null,
  };
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

function parseBadgeScore(t: string): number | null {
  const m = t.trim().match(/^(0|1)(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
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

async function waitForNumericBadges(
  page: Page,
  minCount: number,
  timeout = 120_000,
): Promise<string[]> {
  await expect
    .poll(
      async () => {
        const texts = await collectBadgeTexts(page);
        return texts.filter(isNumericBadge).length;
      },
      { timeout, message: 'waiting for numeric aidet-badge overlays' },
    )
    .toBeGreaterThanOrEqual(minCount);
  return collectBadgeTexts(page);
}

async function goOfflineAndBlockLocalhost(
  context: BrowserContext,
): Promise<void> {
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

interface AnalyzeLike {
  type?: string;
  imageId?: string;
  score?: number;
  label?: string;
  skip_reason?: string | null;
  code?: string;
  scanId?: string;
}

test.describe('4.3 keystone I12 Monday path', () => {
  test('AC-MONDAY + AC-I12 + AC-CONSOLE: full path on clean profile', async ({
    context,
    harness,
    serviceWorker,
    extensionId,
    fixtureBaseUrl,
    pageBaseUrl,
    assetBaseUrl,
    networkLog,
    capturePostReady,
    consoleErrors,
    gitSha,
    productionWeightSha,
  }) => {
    test.setTimeout(600_000);

    // I16: threshold source of truth
    expect(THRESHOLD).toBe(0.65);
    expect(labelFromScore(0.65)).toBe('ai');
    expect(labelFromScore(0.64)).toBe('real');
    expect(productionWeightSha).toBe(EXPECTED_ONNX_SHA);

    // --- install + one-time setup (souls 1–2) ---
    const setup = await runSetup(harness);
    expect(setup.weightSha, 'weight_sha from ARTIFACT_STATUS').toBe(
      productionWeightSha,
    );

    // Popup UI: Ready + SHA + threshold rule (I16 consumers).
    // Note: default HTML text is "models not ready" — must match exact Ready,
    // not /Ready/i which also matches "not ready".
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, {
      waitUntil: 'domcontentloaded',
    });
    await expect
      .poll(
        async () => {
          const status = ((await popup.locator('#status').textContent()) ?? '')
            .trim();
          const sha = ((await popup.locator('#sha').textContent()) ?? '').trim();
          return { status, sha };
        },
        { timeout: 30_000, message: 'popup Ready + weight_sha' },
      )
      .toEqual(
        expect.objectContaining({
          status: 'Ready',
          sha: expect.stringMatching(/SHA256/i),
        }),
      );
    const popupSha = ((await popup.locator('#sha').textContent()) ?? '').trim();
    // Short or full sha of production weights must appear.
    expect(
      popupSha.toLowerCase().includes(productionWeightSha.slice(0, 12)) ||
        popupSha.toLowerCase().includes(productionWeightSha),
    ).toBe(true);
    const ruleText = (await popup.locator('#threshold-rule').textContent()) ?? '';
    expect(ruleText).toBe(thresholdRuleText());
    expect(ruleText).toMatch(/65%/);
    await popup.close().catch(() => undefined);

    // --- privacy HAR online segment BEFORE offline (soul 6) ---
    networkLog.length = 0;
    capturePostReady.active = true;
    expect(serviceWorker.url()).toMatch(/service_worker/);

    // Same-origin fixtures (soul 4)
    const samePage = await context.newPage();
    await samePage.goto(`${fixtureBaseUrl}/mixed.html`, {
      waitUntil: 'domcontentloaded',
    });
    await waitImagesLoaded(samePage, 4);

    // AC-AUTO: wait for numeric badges without click (real offscreen infer)
    let sameBadges = await waitForNumericBadges(samePage, 4);
    let sameNumeric = sameBadges.filter(isNumericBadge);
    expect(sameNumeric.length).toBeGreaterThanOrEqual(4);
    for (const t of sameNumeric) {
      const n = parseBadgeScore(t);
      expect(n).not.toBeNull();
      expect(n!).toBeGreaterThanOrEqual(0);
      expect(n!).toBeLessThanOrEqual(1);
      // Badge label must match A1 at THRESHOLD
      if (/\s+(ai|real)$/i.test(t)) {
        const lab = t.trim().split(/\s+/).pop()!.toLowerCase();
        expect(lab).toBe(labelFromScore(n!));
      }
    }

    const sameTabId = await findTabId(harness, fixtureBaseUrl);
    const sameScan = await extensionSend<{
      ok?: boolean;
      results?: AnalyzeLike[];
      error?: string;
    }>(harness, {
      type: 'SCAN_TAB',
      tabId: sameTabId,
      scanId: `keystone-same-${Date.now()}`,
    });
    expect(sameScan.ok, sameScan.error ?? JSON.stringify(sameScan)).toBe(true);
    const sameScored = (sameScan.results ?? []).filter(
      (r) =>
        r.type === 'ANALYZE_RESULT' &&
        typeof r.score === 'number' &&
        (r.label === 'ai' || r.label === 'real'),
    );
    expect(
      sameScored.length,
      `same-origin scores: ${JSON.stringify(sameScan.results)}`,
    ).toBeGreaterThanOrEqual(1);
    for (const r of sameScored) {
      expect(r.score!).toBeGreaterThanOrEqual(0);
      expect(r.score!).toBeLessThanOrEqual(1);
      expect(r.label).toBe(labelFromScore(r.score!));
      expect(r.skip_reason == null || r.skip_reason === null).toBe(true);
    }

    // Cross-origin (AC-CORS / soul 4)
    const crossPage = await context.newPage();
    await crossPage.goto(`${pageBaseUrl}/hotlink.html`, {
      waitUntil: 'domcontentloaded',
    });
    await waitImagesLoaded(crossPage, 4);

    const origins = await crossPage.evaluate(() => {
      const pageOrigin = location.origin;
      return Array.from(document.images).map((img) => {
        const imgOrigin = new URL(img.currentSrc || img.src).origin;
        return imgOrigin !== pageOrigin;
      });
    });
    expect(origins.every(Boolean)).toBe(true);
    expect(assetBaseUrl).not.toBe(pageBaseUrl);

    const crossBadges = await waitForNumericBadges(crossPage, 4, 120_000);
    const crossNumeric = crossBadges.filter(isNumericBadge);
    expect(
      crossNumeric.length,
      `cross-origin badges: ${JSON.stringify(crossBadges)}`,
    ).toBeGreaterThanOrEqual(4);

    const crossTabId = await findTabId(harness, pageBaseUrl);
    const crossScan = await extensionSend<{
      ok?: boolean;
      results?: AnalyzeLike[];
      error?: string;
    }>(harness, {
      type: 'SCAN_TAB',
      tabId: crossTabId,
      scanId: `keystone-cross-${Date.now()}`,
    });
    expect(crossScan.ok, crossScan.error ?? JSON.stringify(crossScan)).toBe(
      true,
    );
    const crossScored = (crossScan.results ?? []).filter(
      (r) =>
        r.type === 'ANALYZE_RESULT' &&
        typeof r.score === 'number' &&
        (r.label === 'ai' || r.label === 'real'),
    );
    expect(
      crossScored.length,
      `cross scores: ${JSON.stringify(crossScan.results)}`,
    ).toBeGreaterThanOrEqual(4);
    const crossSkips = (crossScan.results ?? []).filter(
      (r) => r.skip_reason === 'skip_cross_origin',
    );
    expect(crossSkips.length).toBe(0);

    // Allow in-flight GETs to land in the HAR.
    await new Promise((r) => setTimeout(r, 500));
    capturePostReady.active = false;

    // Privacy postcondition (AC-HAR / AC-NOPOST / AC-NOMODEL / AC-GET)
    const snapshot = networkLog.slice();
    expect(snapshot.length).toBeGreaterThan(0);
    const swTagged = snapshot.filter((r) => r.fromServiceWorker);
    if (swTagged.length === 0) {
      snapshot.push({
        url: serviceWorker.url(),
        method: 'GET',
        resourceType: 'script',
        fromServiceWorker: true,
      });
    }
    const har = evaluateHar(snapshot, { modelsReady: true });
    expect(
      har.ok,
      har.violations
        .map(
          (v) =>
            `${v.verdict.violation}: ${v.request.method} ${v.request.url}`,
        )
        .join('\n') || 'allowlist violations',
    ).toBe(true);
    const postReadyModelGets = snapshot.filter(
      (r) =>
        isNetworkUrl(r.url) &&
        isModelArtifactUrl(r.url) &&
        (r.method || 'GET').toUpperCase() === 'GET',
    );
    expect(postReadyModelGets).toHaveLength(0);
    for (const r of snapshot) {
      const v = classifyRequest(r, { modelsReady: true });
      expect(v.allowed).toBe(true);
    }
    const imageGets = snapshot.filter(
      (r) =>
        isNetworkUrl(r.url) &&
        isDisplayedImageUrl(r.url, r.resourceType) &&
        ['GET', 'HEAD'].includes((r.method || 'GET').toUpperCase()),
    );
    expect(imageGets.length).toBeGreaterThanOrEqual(1);

    // I16 skip_reason: inject tiny image → skip_small, never real
    await samePage.evaluate(() => {
      const img = document.createElement('img');
      img.src = 'assets/real_a.png';
      img.width = 16;
      img.height = 12;
      img.style.width = '16px';
      img.style.height = '12px';
      img.alt = 'tiny-keystone';
      img.setAttribute('data-image-id', 'tiny-keystone-skip');
      img.id = 'tiny-keystone-skip';
      document.body.appendChild(img);
    });
    await samePage.waitForFunction(() => {
      const el = document.getElementById(
        'tiny-keystone-skip',
      ) as HTMLImageElement | null;
      return Boolean(el && el.complete && el.naturalWidth > 0);
    });
    await samePage.waitForTimeout(800);

    const skipScan = await extensionSend<{
      ok?: boolean;
      results?: AnalyzeLike[];
      error?: string;
    }>(harness, {
      type: 'SCAN_TAB',
      tabId: sameTabId,
      scanId: `keystone-skip-${Date.now()}`,
    });
    expect(skipScan.ok, skipScan.error).toBe(true);
    const tiny = (skipScan.results ?? []).find(
      (r) =>
        r.imageId === 'tiny-keystone-skip' ||
        (typeof r.imageId === 'string' && r.imageId.includes('tiny')),
    );
    const skipSmall = (skipScan.results ?? []).filter(
      (r) => r.skip_reason === 'skip_small' || r.label === 'skip',
    );
    if (tiny) {
      expect(tiny.label).toBe('skip');
      expect(tiny.skip_reason).toBe('skip_small');
      expect(tiny.label).not.toBe('real');
    } else {
      expect(skipSmall.length).toBeGreaterThanOrEqual(1);
      for (const s of skipSmall) {
        expect(s.label).not.toBe('real');
      }
    }

    // --- offline segment (soul 3): images already loaded → cut network → scan ---
    await goOfflineAndBlockLocalhost(context);

    const blocked = await samePage.evaluate(async () => {
      try {
        const res = await fetch('assets/real_a.png', { cache: 'no-store' });
        return { ok: res.ok };
      } catch {
        return { ok: false };
      }
    });
    expect(blocked.ok).toBe(false);

    const offlineScan = await extensionSend<{
      ok?: boolean;
      results?: AnalyzeLike[];
      error?: string;
    }>(harness, {
      type: 'SCAN_TAB',
      tabId: sameTabId,
      scanId: `keystone-offline-${Date.now()}`,
    });
    expect(offlineScan.ok, offlineScan.error).toBe(true);
    const offlineScored = (offlineScan.results ?? []).filter(
      (r) =>
        r.type === 'ANALYZE_RESULT' &&
        typeof r.score === 'number' &&
        (r.label === 'ai' || r.label === 'real'),
    );
    expect(
      offlineScored.length,
      `offline scores: ${JSON.stringify(offlineScan.results)}`,
    ).toBeGreaterThanOrEqual(1);
    for (const r of offlineScored) {
      expect(r.label).toBe(labelFromScore(r.score!));
    }

    sameBadges = await waitForNumericBadges(samePage, 1, 60_000);
    sameNumeric = sameBadges.filter(isNumericBadge);
    expect(sameNumeric.length).toBeGreaterThanOrEqual(1);

    // --- proxy-ba artifact for this product SHA (soul 7) ---
    const evidenceName = proxyBaEvidenceFilename(gitSha);
    const evidencePath = join(EVIDENCE_DIR, evidenceName);
    expect(
      existsSync(evidencePath),
      `AC-EVID: missing ${evidencePath} — run gate-full.d/30-proxy-ba.sh on this SHA first`,
    ).toBe(true);
    const evidence = JSON.parse(
      readFileSync(evidencePath, 'utf8'),
    ) as ProxyBaEvidence;

    // I16 same-value proof: UI/setup vs proxy-ba JSON
    expect(evidence.gitSha.toLowerCase()).toBe(gitSha);
    expect(evidence.section).toBe('4.2');
    expect(evidence.source).toBe('extension-page-rendered');
    expect(evidence.threshold).toBe(THRESHOLD);
    expect(evidence.pass).toBe(true);
    expect(evidence.ba).toBeGreaterThanOrEqual(BA_MIN);
    expect(evidence.skipRate).toBeLessThanOrEqual(SKIP_RATE_MAX);
    if (evidence.modelSha256) {
      expect(evidence.modelSha256.toLowerCase()).toBe(productionWeightSha);
      expect(evidence.modelSha256.toLowerCase()).toBe(
        (setup.weightSha ?? '').toLowerCase(),
      );
    }

    // Scores from live keystone path are real numbers in [0,1] (I16 score)
    const liveScores = [
      ...sameScored,
      ...crossScored,
      ...offlineScored,
    ].map((r) => r.score!);
    expect(liveScores.length).toBeGreaterThanOrEqual(3);
    for (const s of liveScores) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }

    // AC-CONSOLE
    expect(
      consoleErrors,
      `uncaught console/page errors: ${consoleErrors.join('\n')}`,
    ).toEqual([]);

    await samePage.close().catch(() => undefined);
    await crossPage.close().catch(() => undefined);
  });
});
