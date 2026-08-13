/**
 * Spec 3.1 — Autoscan same-origin (soul 4 JOB-SCAN-01).
 *
 * Visit mixed.html; eligible images (>= 64px CSS) get data-testid=aidet-badge
 * without clicking. Primary path: displayed pixels. Offline scan still scores.
 * skip_small is not labeled real. Cache survives scroll away/back.
 *
 * retries: 0 (claim suite). Does not mock infer().
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
      `poidh-pw-auto-so-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
      await new Promise<void>((resolveListen, reject) => {
        onnxServer!.once('error', reject);
        onnxServer!.listen(0, '127.0.0.1', () => resolveListen());
      });
      const addr = onnxServer.address();
      if (addr && typeof addr !== 'string') {
        onnxLocalUrl = `http://127.0.0.1:${addr.port}/model.onnx`;
      }
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
      { timeout: 180_000, message: 'offscreen session never ready' },
    )
    .toBe(true);
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

/** Badges live in open shadow roots; collect text via page evaluate. */
async function collectBadgeTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const hosts = Array.from(
      document.querySelectorAll('[data-aidet-badge-host]'),
    );
    for (const host of hosts) {
      const badge = host.shadowRoot?.querySelector(
        '[data-testid="aidet-badge"]',
      );
      if (badge?.textContent) out.push(badge.textContent.trim());
    }
    // Also pierce any non-host testid (defensive).
    document.querySelectorAll('[data-testid="aidet-badge"]').forEach((el) => {
      const t = el.textContent?.trim();
      if (t && !out.includes(t)) out.push(t);
    });
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
        const numeric = texts.filter((t) => /^(0|1)(\.\d+)?$/.test(t));
        return numeric.length;
      },
      { timeout, message: 'waiting for numeric aidet-badge overlays' },
    )
    .toBeGreaterThanOrEqual(minCount);
  return collectBadgeTexts(page);
}

test.describe('3.1 autoscan same-origin (JOB-SCAN-01)', () => {
  test('AC-AUTO + AC-TESTID: badges appear without click on mixed.html', async ({
    context,
    harness,
    fixtureBaseUrl,
  }) => {
    await runSetup(harness);

    const page = await context.newPage();
    await page.goto(`${fixtureBaseUrl}/mixed.html`, {
      waitUntil: 'domcontentloaded',
    });
    const imageCount = await waitImagesLoaded(page);
    expect(imageCount).toBeGreaterThanOrEqual(4);

    // AC-AUTO: no click, no SCAN_TAB — IntersectionObserver autoscan only.
    const texts = await waitForNumericBadges(page, 4);
    const numeric = texts.filter((t) => /^(0|1)(\.\d+)?$/.test(t));
    expect(numeric.length).toBeGreaterThanOrEqual(4);

    // AC-TESTID: each badge has text content.
    for (const t of numeric) {
      expect(t.length).toBeGreaterThan(0);
      const n = Number(t);
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(1);
    }

    await page.close();
  });

  test('AC-OFFLINE-SCAN: load → offline → scan still yields numeric badges', async ({
    context,
    harness,
    fixtureBaseUrl,
  }) => {
    await runSetup(harness);

    const page = await context.newPage();
    await page.goto(`${fixtureBaseUrl}/mixed.html`, {
      waitUntil: 'domcontentloaded',
    });
    await waitImagesLoaded(page);

    // Give autoscan a moment if it races; then force offline and re-scan.
    await page.waitForTimeout(500);

    await goOfflineAndBlockLocalhost(context);

    const blocked = await page.evaluate(async () => {
      try {
        const res = await fetch('assets/real_a.png', { cache: 'no-store' });
        return { ok: res.ok };
      } catch {
        return { ok: false };
      }
    });
    expect(blocked.ok).toBe(false);

    const fixtureTabId = await findFixtureTabId(harness, fixtureBaseUrl);
    const scanId = `offline-auto-${Date.now()}`;
    const scan = await extensionSend<{
      ok?: boolean;
      results?: Array<{ type?: string; score?: number; label?: string }>;
      error?: string;
    }>(harness, {
      type: 'SCAN_TAB',
      tabId: fixtureTabId,
      scanId,
    });
    expect(scan.ok, scan.error).toBe(true);

    const texts = await waitForNumericBadges(page, 1, 60_000);
    const numeric = texts.filter((t) => /^(0|1)(\.\d+)?$/.test(t));
    expect(
      numeric.length,
      `expected numeric badges offline, got: ${JSON.stringify(texts)}`,
    ).toBeGreaterThanOrEqual(1);

    // Fail closed: no badge text that pretends skip is real without a score path.
    for (const t of texts) {
      if (t === 'unavailable' || t === '…') continue;
      expect(/^(0|1)(\.\d+)?$/.test(t)).toBe(true);
    }

    await page.close();
  });

  test('AC-CACHE: scroll away/back keeps numeric badge (no real flicker)', async ({
    context,
    harness,
    fixtureBaseUrl,
  }) => {
    await runSetup(harness);

    const page = await context.newPage();
    await page.goto(`${fixtureBaseUrl}/mixed.html`, {
      waitUntil: 'domcontentloaded',
    });
    await waitImagesLoaded(page);

    const before = await waitForNumericBadges(page, 4);
    const beforeNumeric = before.filter((t) => /^(0|1)(\.\d+)?$/.test(t));

    // Scroll far away then back.
    await page.evaluate(() => window.scrollTo(0, 5000));
    await page.waitForTimeout(200);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);

    const after = await collectBadgeTexts(page);
    const afterNumeric = after.filter((t) => /^(0|1)(\.\d+)?$/.test(t));
    expect(afterNumeric.length).toBeGreaterThanOrEqual(beforeNumeric.length);

    // Cached scores must still be numeric — never blank then "real".
    for (const t of afterNumeric) {
      expect(/^(0|1)(\.\d+)?$/.test(t)).toBe(true);
    }

    await page.close();
  });

  test('Negative: skip_small not labeled real', async ({
    context,
    harness,
    fixtureBaseUrl,
  }) => {
    await runSetup(harness);

    const page = await context.newPage();
    await page.goto(`${fixtureBaseUrl}/mixed.html`, {
      waitUntil: 'domcontentloaded',
    });
    await waitImagesLoaded(page);
    await waitForNumericBadges(page, 1);

    // Inject a tiny icon well under 64px CSS.
    await page.evaluate(() => {
      const img = document.createElement('img');
      img.src = 'assets/real_a.png';
      img.width = 16;
      img.height = 12;
      img.style.width = '16px';
      img.style.height = '12px';
      img.alt = 'tiny-icon';
      img.setAttribute('data-image-id', 'tiny-skip-small');
      img.id = 'tiny-skip-small';
      document.body.appendChild(img);
    });
    await page.waitForFunction(() => {
      const el = document.getElementById('tiny-skip-small') as HTMLImageElement | null;
      return Boolean(el && el.complete && el.naturalWidth > 0);
    });

    // Allow autoscan to observe the new node.
    await page.waitForTimeout(1500);

    const tinyState = await page.evaluate(() => {
      const tiny = document.getElementById(
        'tiny-skip-small',
      ) as HTMLImageElement | null;
      if (!tiny) return { found: false as const };
      const hosts = Array.from(
        document.querySelectorAll('[data-aidet-badge-host]'),
      ) as Array<HTMLElement & { __aidetImg?: HTMLImageElement }>;
      // Hosts store img weakly via closure; count badges near tiny rect.
      const tRect = tiny.getBoundingClientRect();
      let badgeNearTiny = 0;
      const badgeTexts: string[] = [];
      for (const host of hosts) {
        const hRect = host.getBoundingClientRect();
        const near =
          Math.abs(hRect.top - tRect.top) < 40 &&
          Math.abs(hRect.left - tRect.left) < 40;
        const text =
          host.shadowRoot
            ?.querySelector('[data-testid="aidet-badge"]')
            ?.textContent?.trim() ?? '';
        if (near && text) {
          badgeNearTiny += 1;
          badgeTexts.push(text);
        }
      }
      return { found: true as const, badgeNearTiny, badgeTexts };
    });

    expect(tinyState.found).toBe(true);
    // No score badge on skip_small; if anything appears it must not be "real".
    if (tinyState.badgeNearTiny && tinyState.badgeNearTiny > 0) {
      for (const t of tinyState.badgeTexts ?? []) {
        expect(t.toLowerCase()).not.toBe('real');
        expect(t).toBe('unavailable');
      }
    }

    // Explicit SCAN_PAGE must also report skip_small, never real.
    const fixtureTabId = await findFixtureTabId(harness, fixtureBaseUrl);
    const scan = await extensionSend<{
      results?: Array<{
        imageId?: string;
        label?: string;
        skip_reason?: string | null;
        type?: string;
      }>;
    }>(harness, {
      type: 'SCAN_TAB',
      tabId: fixtureTabId,
      scanId: `skip-small-${Date.now()}`,
    });
    const tinyResult = (scan.results ?? []).find(
      (r) =>
        r.imageId === 'tiny-skip-small' ||
        (typeof r.imageId === 'string' && r.imageId.includes('tiny')),
    );
    // Prefer the data-image-id hit; if the scan uses src as id, match skip_small any.
    const skips = (scan.results ?? []).filter(
      (r) => r.skip_reason === 'skip_small' || r.label === 'skip',
    );
    if (tinyResult) {
      expect(tinyResult.label).toBe('skip');
      expect(tinyResult.skip_reason).toBe('skip_small');
      expect(tinyResult.label).not.toBe('real');
    } else {
      expect(skips.length).toBeGreaterThanOrEqual(1);
      for (const s of skips) {
        expect(s.label).not.toBe('real');
      }
    }

    await page.close();
  });
});
