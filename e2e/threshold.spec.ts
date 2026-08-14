/**
 * Spec 3.2 — Score and threshold (soul 5 JOB-SCORE-01).
 *
 * - AC-NUM: badge shows numeric score in [0,1]
 * - AC-A1: label from src/label.ts THRESHOLD only (0.64 real, 0.65 ai)
 * - AC-ERR: errors/skips are "unavailable", never Real
 *
 * Injected results for the 0.64/0.65 boundary; live scan for real path.
 * retries: 0 (claim suite).
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

import {
  formatBadgeText,
  labelFromScore,
  PAUSE_STORAGE_KEY,
  THRESHOLD,
  thresholdRuleText,
} from '../src/label.js';

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
    existsSync(join(DIST, 'popup.js')) &&
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
      `poidh-pw-threshold-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

async function collectBadgeDetails(
  page: Page,
): Promise<Array<{ text: string; label: string | null; state: string | null }>> {
  return page.evaluate(() => {
    const out: Array<{
      text: string;
      label: string | null;
      state: string | null;
    }> = [];
    for (const host of Array.from(
      document.querySelectorAll('[data-aidet-badge-host]'),
    )) {
      const badge = host.shadowRoot?.querySelector(
        '[data-testid="aidet-badge"]',
      ) as HTMLElement | null;
      if (!badge) continue;
      out.push({
        text: badge.textContent?.trim() ?? '',
        label: badge.dataset['label'] ?? null,
        state: badge.dataset['state'] ?? null,
      });
    }
    return out;
  });
}

function isScoreLabelBadge(t: string): boolean {
  return /^(0|1)(\.\d+)?\s+(ai|real)$/i.test(t);
}

function parseScoreLabel(t: string): { score: number; label: string } | null {
  const m = t.trim().match(/^((?:0|1)(?:\.\d+)?)\s+(ai|real)$/i);
  if (!m) return null;
  return { score: Number(m[1]), label: m[2]!.toLowerCase() };
}

test.describe('3.2 score and threshold (JOB-SCORE-01)', () => {
  test('module boundary: 0.64 real, 0.65 ai (THRESHOLD)', () => {
    expect(THRESHOLD).toBe(0.65);
    expect(labelFromScore(0.64)).toBe('real');
    expect(labelFromScore(0.65)).toBe('ai');
    expect(formatBadgeText(0.64)).toBe('0.64 Real');
    expect(formatBadgeText(0.65)).toBe('0.65 AI');
    expect(thresholdRuleText()).toBe('AI if >= 65%');
  });

  test('AC-A1 + AC-NUM: injected 0.64/0.65 scores label via label.ts', async ({
    context,
    harness,
    fixtureBaseUrl,
    extensionId,
  }) => {
    // No model setup required — injected scores exercise badge + label path.
    const page = await context.newPage();
    await page.goto(`${fixtureBaseUrl}/mixed.html`, {
      waitUntil: 'domcontentloaded',
    });
    await waitImagesLoaded(page);

    // Wait for content script to attach.
    await expect
      .poll(
        async () => {
          const tabId = await findFixtureTabId(harness, fixtureBaseUrl);
          const pong = await harness.evaluate(async (id) => {
            try {
              return (await chrome.tabs.sendMessage(id, {
                type: 'CONTENT_PING',
              })) as { type?: string } | null;
            } catch {
              return null;
            }
          }, tabId);
          return pong?.type === 'CONTENT_PONG';
        },
        { timeout: 30_000, message: 'content script not ready' },
      )
      .toBe(true);

    const tabId = await findFixtureTabId(harness, fixtureBaseUrl);

    const inject = async (score: number, index: number) => {
      return harness.evaluate(
        async ({ id, score: s, index: i }) => {
          return (await chrome.tabs.sendMessage(id, {
            type: 'SET_BADGE_SCORE',
            score: s,
            index: i,
          })) as {
            ok?: boolean;
            label?: string;
            text?: string;
            error?: string;
          };
        },
        { id: tabId, score, index },
      );
    };

    // Pause first so autoscan cannot race and overwrite injected scores.
    await harness.evaluate(async (key) => {
      await chrome.storage.local.set({ [key]: true });
    }, PAUSE_STORAGE_KEY);
    // Brief settle for storage.onChanged in content scripts.
    await page.waitForTimeout(300);

    const r64 = await inject(0.64, 0);
    expect(r64.ok, r64.error).toBe(true);
    expect(r64.label).toBe('real');
    expect(r64.text).toBe(formatBadgeText(0.64));
    expect(r64.text).toBe('0.64 Real');

    const r65 = await inject(0.65, 1);
    expect(r65.ok, r65.error).toBe(true);
    expect(r65.label).toBe('ai');
    expect(r65.text).toBe(formatBadgeText(0.65));
    expect(r65.text).toBe('0.65 AI');

    await expect
      .poll(
        async () => {
          const texts = await collectBadgeTexts(page);
          return (
            texts.includes('0.64 Real') && texts.includes('0.65 AI')
          );
        },
        { timeout: 10_000, message: 'injected score badges not visible' },
      )
      .toBe(true);

    const details = await collectBadgeDetails(page);
    const texts = details.map((d) => d.text);
    expect(texts).toEqual(expect.arrayContaining(['0.64 Real', '0.65 AI']));

    for (const d of details) {
      if (!isScoreLabelBadge(d.text)) continue;
      const parsed = parseScoreLabel(d.text);
      expect(parsed).not.toBeNull();
      expect(parsed!.label).toBe(labelFromScore(parsed!.score));
      expect(d.label).toBe(parsed!.label);
      expect(d.state).toBe('score');
    }

    // Popup rule line from the same module.
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(popup.locator('#threshold-rule')).toHaveText(
      thresholdRuleText(),
    );
    await expect(popup.locator('#threshold-rule')).toHaveText('AI if >= 65%');
    await popup.close();

    await page.close();
  });

  test('AC-NUM + AC-A1: live scan badges show score+label consistent with THRESHOLD', async ({
    context,
    harness,
    fixtureBaseUrl,
  }) => {
    test.setTimeout(240_000);
    await runSetup(harness);

    const page = await context.newPage();
    await page.goto(`${fixtureBaseUrl}/mixed.html`, {
      waitUntil: 'domcontentloaded',
    });
    await waitImagesLoaded(page);

    await expect
      .poll(
        async () => {
          const texts = await collectBadgeTexts(page);
          return texts.filter(isScoreLabelBadge).length;
        },
        {
          timeout: 120_000,
          message: 'waiting for score+label aidet-badge overlays',
        },
      )
      .toBeGreaterThanOrEqual(1);

    const details = await collectBadgeDetails(page);
    const scored = details.filter((d) => isScoreLabelBadge(d.text));
    expect(scored.length).toBeGreaterThanOrEqual(1);

    for (const d of scored) {
      const parsed = parseScoreLabel(d.text);
      expect(parsed, d.text).not.toBeNull();
      expect(parsed!.score).toBeGreaterThanOrEqual(0);
      expect(parsed!.score).toBeLessThanOrEqual(1);
      // AC-A1: visible label matches labelFromScore from src/label.ts.
      expect(parsed!.label).toBe(labelFromScore(parsed!.score));
      expect(d.label).toBe(parsed!.label);
    }

    await page.close();
  });

  test('AC-ERR: MODEL_MISSING / skip shows unavailable, not Real', async ({
    context,
    harness,
    fixtureBaseUrl,
  }) => {
    // Clear artifacts so ANALYZE fails closed (no model).
    await extensionSend(harness, { type: 'CLEAR_ARTIFACTS' });

    const page = await context.newPage();
    await page.goto(`${fixtureBaseUrl}/mixed.html`, {
      waitUntil: 'domcontentloaded',
    });
    await waitImagesLoaded(page);

    // Force a scan so badges settle to unavailable (or stay loading then error).
    const tabId = await findFixtureTabId(harness, fixtureBaseUrl);
    await extensionSend(harness, {
      type: 'SCAN_TAB',
      tabId,
      scanId: `err-${Date.now()}`,
    });

    await expect
      .poll(
        async () => {
          const details = await collectBadgeDetails(page);
          return details.some(
            (d) =>
              d.text === 'unavailable' ||
              d.state === 'unavailable' ||
              d.text === '…',
          );
        },
        { timeout: 60_000, message: 'waiting for unavailable/loading badges' },
      )
      .toBe(true);

    const details = await collectBadgeDetails(page);
    for (const d of details) {
      // AC-ERR: never show bare "real" or coerce skip/error to real.
      expect(d.text.toLowerCase()).not.toBe('real');
      if (d.state === 'unavailable' || d.text === 'unavailable') {
        expect(d.label).not.toBe('real');
        expect(d.text).toBe('unavailable');
      }
    }

    await page.close();
  });
});
