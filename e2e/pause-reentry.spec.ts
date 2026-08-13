/**
 * Spec 3.2 — Pause scanning reentry (G-REENTRY / AC-PAUSE).
 *
 * Pause → reload Chrome (new persistent context, same userDataDir) → still paused.
 * While paused, eligible images do not get new badges.
 */

import { createServer, type Server } from 'node:http';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  test as base,
  chromium,
  expect,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';

import { PAUSE_STORAGE_KEY } from '../src/label.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const FIXTURES = join(ROOT, 'eval', 'fixtures');

type ExtensionFixtures = {
  userDataDir: string;
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

async function ensureDistBuilt(): Promise<void> {
  if (
    existsSync(join(DIST, 'manifest.json')) &&
    existsSync(join(DIST, 'service_worker.js')) &&
    existsSync(join(DIST, 'content.js')) &&
    existsSync(join(DIST, 'popup.js')) &&
    existsSync(join(DIST, 'popup.html'))
  ) {
    return;
  }
  const { execSync } = await import('node:child_process');
  execSync('bash scripts/gate-build.sh', { cwd: ROOT, stdio: 'inherit' });
}

async function launchExtension(
  userDataDir: string,
): Promise<{ context: BrowserContext; extensionId: string; sw: Worker }> {
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

  let sw = context.serviceWorkers()[0];
  if (!sw) {
    sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  }
  await new Promise((r) => setTimeout(r, 200));
  const extensionId = new URL(sw.url()).host;
  expect(extensionId.length).toBeGreaterThan(8);
  return { context, extensionId, sw };
}

async function openPopup(
  context: BrowserContext,
  extensionId: string,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#pause');
  return page;
}

async function readPausedFromPopup(popup: Page): Promise<boolean> {
  const pressed = await popup.locator('#pause').getAttribute('aria-pressed');
  if (pressed === 'true') return true;
  if (pressed === 'false') return false;
  const text = (await popup.locator('#pause').textContent()) ?? '';
  return /resume/i.test(text);
}

async function readPausedFromStorage(
  harness: Page,
): Promise<boolean | undefined> {
  return harness.evaluate(async (key) => {
    const stored = await chrome.storage.local.get(key);
    return stored[key] as boolean | undefined;
  }, PAUSE_STORAGE_KEY);
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

const test = base.extend<ExtensionFixtures>({
  // eslint-disable-next-line no-empty-pattern
  userDataDir: async ({}, use) => {
    await ensureDistBuilt();
    const dir = join(
      tmpdir(),
      `poidh-pw-pause-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(dir, { recursive: true });
    await use(dir);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  },

  // eslint-disable-next-line no-empty-pattern
  fixtureBaseUrl: async ({}, use) => {
    const { server, baseUrl } = await startFixtureServer();
    await use(baseUrl);
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  },
});

test.describe.configure({ mode: 'serial', retries: 0 });

test.describe('3.2 pause reentry (G-REENTRY / AC-PAUSE)', () => {
  test('pause → reload Chrome → still paused; no new badges while paused', async ({
    userDataDir,
    fixtureBaseUrl,
  }) => {
    test.setTimeout(120_000);

    // --- Session 1: pause scanning ---
    const session1 = await launchExtension(userDataDir);
    const popup1 = await openPopup(session1.context, session1.extensionId);

    await expect(popup1.locator('#pause')).toHaveText(/Pause scanning/i);
    await popup1.locator('#pause').click();
    await expect(popup1.locator('#pause')).toHaveText(/Resume scanning/i);
    expect(await readPausedFromPopup(popup1)).toBe(true);

    const harness1 = await session1.context.newPage();
    await harness1.goto(
      `chrome-extension://${session1.extensionId}/harness.html`,
      { waitUntil: 'domcontentloaded' },
    );
    await expect
      .poll(async () => readPausedFromStorage(harness1), {
        timeout: 10_000,
        message: 'storage.local scanningPaused never true',
      })
      .toBe(true);

    await popup1.close();
    await harness1.close();
    await session1.context.close();

    // --- Session 2: "reload Chrome" via same userDataDir ---
    const session2 = await launchExtension(userDataDir);
    const popup2 = await openPopup(session2.context, session2.extensionId);

    // AC-PAUSE / G-REENTRY: pause flag survived Chrome reload.
    await expect(popup2.locator('#pause')).toHaveText(/Resume scanning/i);
    expect(await readPausedFromPopup(popup2)).toBe(true);

    const harness2 = await session2.context.newPage();
    await harness2.goto(
      `chrome-extension://${session2.extensionId}/harness.html`,
      { waitUntil: 'domcontentloaded' },
    );
    expect(await readPausedFromStorage(harness2)).toBe(true);

    // While paused, visiting a fixture page must not create new badges.
    const page = await session2.context.newPage();
    await page.goto(`${fixtureBaseUrl}/mixed.html`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() => {
      const imgs = Array.from(document.images);
      return (
        imgs.length > 0 &&
        imgs.every((img) => img.complete && img.naturalWidth > 0)
      );
    });

    // Give autoscan time to fire if pause were broken.
    await page.waitForTimeout(2500);
    const textsWhilePaused = await collectBadgeTexts(page);
    expect(
      textsWhilePaused,
      `expected no new badges while paused, got: ${JSON.stringify(textsWhilePaused)}`,
    ).toEqual([]);

    // CONTENT_PING reports scanningPaused.
    const tabId = await harness2.evaluate(async (base) => {
      const all = await chrome.tabs.query({});
      const hit = all.find(
        (t) => typeof t.url === 'string' && t.url.startsWith(base),
      );
      return hit?.id ?? null;
    }, fixtureBaseUrl);
    expect(tabId).toEqual(expect.any(Number));

    const pong = await harness2.evaluate(async (id) => {
      return (await chrome.tabs.sendMessage(id!, {
        type: 'CONTENT_PING',
      })) as { scanningPaused?: boolean };
    }, tabId);
    expect(pong.scanningPaused).toBe(true);

    // Resume → pause control flips; storage cleared.
    await popup2.locator('#pause').click();
    await expect(popup2.locator('#pause')).toHaveText(/Pause scanning/i);
    expect(await readPausedFromStorage(harness2)).toBe(false);

    await page.close();
    await popup2.close();
    await harness2.close();
    await session2.context.close();
  });
});
