/**
 * Spec 4.2 — Proxy BA gate (soul 7 / JOB-PROXY-01).
 *
 * Drive the **loaded extension** over **page-rendered** images for every row
 * in eval/proxy/manifest.json. Write evidence/proxy-ba-<gitsha>.json.
 *
 * Certificate rules:
 * - AC-FULL: all manifest rows attempted
 * - AC-BA: BA >= 0.750 at THRESHOLD (0.65)
 * - AC-SKIP: skip-rate <= 0.10
 * - AC-SHA: evidence file names product git sha
 * - AC-EXT: only loaded extension on page-rendered images (not CLI)
 *
 * retries: 0 (claim suite). Does not mock ONNX.
 */

import { createServer, type Server } from 'node:http';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { execSync, spawnSync } from 'node:child_process';

import {
  test as base,
  chromium,
  expect,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';

import {
  BA_MIN,
  SKIP_RATE_MAX,
  buildProxyBaEvidence,
  proxyBaEvidenceFilename,
  type ProxyLabel,
  type ScoredRow,
} from '../eval/scorer.js';
import { THRESHOLD } from '../src/threshold.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const PROXY_DIR = join(ROOT, 'eval', 'proxy');
const MANIFEST_PATH = join(PROXY_DIR, 'manifest.json');
const EVIDENCE_DIR = join(ROOT, 'evidence');
const ONNX_URL_SUBSTR = 'onnx/model.onnx';
const EXPECTED_ONNX_SHA =
  'a42c7d740fbb345ba9a26d469b22f301d73089ce3c6da993877ed2b6965a8ba1';
const LOCAL_ONNX_CANDIDATES = [
  process.env['POIDH_ONNX_CACHE'],
  '/tmp/poidh-onnx-cache/model.onnx',
  join(ROOT, 'evidence', '.cache', 'model.onnx'),
].filter((p): p is string => Boolean(p));

/** Images per HTML page (content script scans sequentially). */
const BATCH_SIZE = 12;

interface ManifestRow {
  relpath: string;
  sha256: string;
  label: ProxyLabel;
  family: string;
  corruption: string;
  license: string;
}

interface Manifest {
  version: number;
  rows: ManifestRow[];
}

type ExtensionFixtures = {
  context: BrowserContext;
  extensionId: string;
  serviceWorker: Worker;
  harness: Page;
  proxyBaseUrl: string;
  manifest: Manifest;
  gitSha: string;
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
    case '.webp':
      return 'image/webp';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json';
    default:
      return 'application/octet-stream';
  }
}

function loadManifest(): Manifest {
  const m = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
  if (!Array.isArray(m.rows) || m.rows.length === 0) {
    throw new Error('proxy manifest empty (fail-closed)');
  }
  return m;
}

function resolveGitSha(): string {
  if (process.env['POIDH_GIT_SHA'] && /^[0-9a-f]{7,40}$/i.test(process.env['POIDH_GIT_SHA'])) {
    return process.env['POIDH_GIT_SHA'].toLowerCase();
  }
  const res = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (res.status === 0 && res.stdout.trim()) {
    return res.stdout.trim().toLowerCase();
  }
  throw new Error('proxy-ba: cannot resolve product git sha');
}

function buildBatchHtml(batch: ManifestRow[], batchIndex: number): string {
  const figures = batch
    .map((row) => {
      // Serve under /proxy/<relpath> so paths stay under the proxy tree.
      const src = `/proxy/${row.relpath.split('/').map(encodeURIComponent).join('/')}`;
      return `
      <figure data-sha256="${row.sha256}" data-label="${row.label}" data-family="${row.family}">
        <img
          src="${src}"
          data-image-id="${row.sha256}"
          alt="${row.relpath}"
          width="256"
          height="256"
          style="width:256px;height:256px;object-fit:contain;display:block;background:#222"
        />
        <figcaption>${row.family} / ${row.label} / ${row.corruption}</figcaption>
      </figure>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>proxy-ba batch ${batchIndex}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 1rem; background: #111; color: #eee; }
    .grid { display: flex; flex-wrap: wrap; gap: 12px; }
    figure { margin: 0; padding: 8px; background: #222; border-radius: 6px; }
    figcaption { font-size: 0.7rem; color: #aaa; max-width: 256px; word-break: break-all; }
  </style>
</head>
<body>
  <h1>Proxy BA batch ${batchIndex} (n=${batch.length})</h1>
  <p>Page-rendered images for soul-7 extension certificate. CSS ≥ 64px.</p>
  <div class="grid" id="grid">
    ${figures}
  </div>
</body>
</html>`;
}

async function startProxyServer(
  manifest: Manifest,
): Promise<{ server: Server; baseUrl: string }> {
  const batches: ManifestRow[][] = [];
  for (let i = 0; i < manifest.rows.length; i += BATCH_SIZE) {
    batches.push(manifest.rows.slice(i, i + BATCH_SIZE));
  }

  const server = createServer((req, res) => {
    const urlPath = (req.url ?? '/').split('?')[0] || '/';

    // /batch/<i>.html
    const batchMatch = /^\/batch\/(\d+)\.html$/.exec(urlPath);
    if (batchMatch) {
      const idx = Number(batchMatch[1]);
      const batch = batches[idx];
      if (!batch) {
        res.writeHead(404);
        res.end('batch not found');
        return;
      }
      const html = buildBatchHtml(batch, idx);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (urlPath === '/meta.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          batchCount: batches.length,
          batchSize: BATCH_SIZE,
          total: manifest.rows.length,
        }),
      );
      return;
    }

    // /proxy/images/...
    if (urlPath.startsWith('/proxy/')) {
      const rel = decodeURIComponent(urlPath.slice('/proxy/'.length));
      const filePath = resolve(PROXY_DIR, rel);
      if (!filePath.startsWith(PROXY_DIR) || !existsSync(filePath)) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': mimeFor(filePath) });
      createReadStream(filePath).pipe(res);
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('proxy server has no address');
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
  execSync('bash scripts/gate-build.sh', { cwd: ROOT, stdio: 'inherit' });
}

const test = base.extend<ExtensionFixtures>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    await ensureDistBuilt();
    const userDataDir = join(
      tmpdir(),
      `poidh-pw-proxyba-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
  manifest: async ({}, use) => {
    await use(loadManifest());
  },

  // eslint-disable-next-line no-empty-pattern
  gitSha: async ({}, use) => {
    await use(resolveGitSha());
  },

  proxyBaseUrl: async ({ manifest }, use) => {
    const { server, baseUrl } = await startProxyServer(manifest);
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

async function runSetup(harness: Page): Promise<string | null> {
  await extensionSend(harness, { type: 'ENSURE_OFFSCREEN' });
  const result = await extensionSend<{
    ok?: boolean;
    ready?: boolean;
    error?: string;
    sha256?: string | null;
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

  const status = await extensionSend<{ sha256?: string | null }>(harness, {
    type: 'ARTIFACT_STATUS',
  });
  return status?.sha256 ?? result.sha256 ?? null;
}

async function waitImagesLoaded(page: Page, expected: number): Promise<void> {
  await page.waitForFunction(
    (n) => {
      const imgs = Array.from(document.images);
      return (
        imgs.length >= n &&
        imgs.every((img) => img.complete && img.naturalWidth > 0)
      );
    },
    expected,
    { timeout: 60_000 },
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
  expect(tabId, 'proxy batch tab id').toEqual(expect.any(Number));
  return tabId as number;
}

interface AnalyzeLike {
  type?: string;
  imageId?: string;
  score?: number;
  label?: string;
  skip_reason?: string | null;
  code?: string;
}

function outcomeFromResult(r: AnalyzeLike | undefined): ScoredRow['outcome'] {
  if (!r) {
    return { kind: 'skip', reason: 'no_result' };
  }
  if (r.type === 'ANALYZE_ERROR') {
    return { kind: 'skip', reason: r.code ?? 'ANALYZE_ERROR' };
  }
  if (r.label === 'skip' || r.skip_reason) {
    return {
      kind: 'skip',
      reason: r.skip_reason ?? r.label ?? 'skip',
    };
  }
  if (typeof r.score === 'number' && Number.isFinite(r.score)) {
    // Scored path (ai|real) — label is recomputed via THRESHOLD in scorer.
    return { kind: 'scored', score: r.score };
  }
  return { kind: 'skip', reason: 'unscored' };
}

test.describe('4.2 proxy BA gate (JOB-PROXY-01)', () => {
  test('AC-FULL + AC-BA + AC-SKIP + AC-SHA + AC-EXT: extension scores full proxy', async ({
    context,
    harness,
    proxyBaseUrl,
    manifest,
    gitSha,
  }) => {
    test.setTimeout(1_200_000); // up to 20 min for full proxy over WASM

    expect(THRESHOLD).toBe(0.65);
    expect(manifest.rows.length).toBeGreaterThanOrEqual(200);

    const modelSha = await runSetup(harness);
    expect(modelSha === null || modelSha === EXPECTED_ONNX_SHA).toBe(true);

    const bySha = new Map(manifest.rows.map((r) => [r.sha256, r]));
    const resultsBySha = new Map<string, AnalyzeLike>();

    const batchCount = Math.ceil(manifest.rows.length / BATCH_SIZE);
    const page = await context.newPage();

    for (let b = 0; b < batchCount; b++) {
      const batch = manifest.rows.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
      const batchUrl = `${proxyBaseUrl}/batch/${b}.html`;
      await page.goto(batchUrl, { waitUntil: 'domcontentloaded' });
      await waitImagesLoaded(page, batch.length);

      // Ensure content script is ready before SCAN_TAB.
      await expect
        .poll(
          async () => {
            const tabId = await findTabId(harness, proxyBaseUrl);
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
          { timeout: 30_000, message: `content script not ready batch ${b}` },
        )
        .toBe(true);

      const tabId = await findTabId(harness, proxyBaseUrl);
      const scanId = `proxy-ba-${gitSha.slice(0, 12)}-b${b}`;
      const scan = await extensionSend<{
        ok?: boolean;
        results?: AnalyzeLike[];
        error?: string;
        type?: string;
      }>(harness, {
        type: 'SCAN_TAB',
        tabId,
        scanId,
      });

      expect(scan.ok !== false, scan.error ?? `batch ${b} scan failed`).toBe(
        true,
      );
      const results = scan.results ?? [];
      expect(
        results.length,
        `batch ${b}: expected ${batch.length} results, got ${results.length}`,
      ).toBeGreaterThanOrEqual(batch.length);

      for (const r of results) {
        const id = r.imageId;
        if (typeof id === 'string' && bySha.has(id)) {
          resultsBySha.set(id, r);
        }
      }

      // Progress for long runs (playwright list reporter surfaces this).
      console.log(
        `proxy-ba: batch ${b + 1}/${batchCount} scored=${resultsBySha.size}/${manifest.rows.length}`,
      );
    }

    await page.close().catch(() => undefined);

    // AC-FULL: every manifest row attempted (missing result → skip, still counted).
    const scoredRows: ScoredRow[] = manifest.rows.map((row) => {
      const r = resultsBySha.get(row.sha256);
      return {
        label: row.label,
        family: row.family,
        sha256: row.sha256,
        relpath: row.relpath,
        outcome: outcomeFromResult(r),
      };
    });

    expect(scoredRows.length).toBe(manifest.rows.length);

    const evidence = buildProxyBaEvidence({
      gitSha,
      rows: scoredRows,
      source: 'extension-page-rendered',
      modelSha256: modelSha,
      note: 'soul-7 admission certificate (loaded extension, page-rendered images)',
    });

    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const filename = proxyBaEvidenceFilename(gitSha);
    const evidencePath = join(EVIDENCE_DIR, filename);
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', 'utf8');

    console.log(
      `proxy-ba: wrote ${evidencePath} BA=${evidence.ba.toFixed(4)} skip=${evidence.skipRate.toFixed(4)} pass=${evidence.pass}`,
    );

    // AC-SHA
    expect(existsSync(evidencePath)).toBe(true);
    expect(filename).toContain(gitSha);

    // AC-EXT
    expect(evidence.source).toBe('extension-page-rendered');
    expect(evidence.section).toBe('4.2');
    expect(evidence.threshold).toBe(THRESHOLD);

    // AC-FULL
    expect(evidence.attempted).toBe(manifest.rows.length);
    expect(evidence.attempted).toBeGreaterThanOrEqual(200);
    expect(evidence.perFamily.length).toBeGreaterThanOrEqual(4);

    // AC-SKIP
    expect(evidence.skipRate).toBeLessThanOrEqual(SKIP_RATE_MAX);

    // AC-BA
    expect(evidence.ba).toBeGreaterThanOrEqual(BA_MIN);
    expect(evidence.pass).toBe(true);
  });
});
