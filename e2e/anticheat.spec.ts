/**
 * Spec 5.1 — Release anticheat (soul 9 JOB-ANTICHEAT-01).
 *
 * AC-AC: packaged dist/ contains no proxy/golden bench sha256 and no scores
 *        lookup table (zip-grep style walk of every file under dist/).
 * AC-EMPTY: result / artifact score cache is empty at first install (clean
 *           profile, before setup).
 * AC-MIT / AC-DOC / AC-NOPLAN: LICENSE MIT; INSTALL.md matches e2e-install;
 *           product git has no packs / ACTIVE-RUNS / audit reviews / constitution.
 * AC-NOCLAIM: this suite does not submit or assert an on-chain POIDH TX.
 *
 * retries: 0 (claim suite). Does not mock infer(). Does not require ONNX download
 * for the empty-cache-at-install path.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const PROXY_MANIFEST = join(ROOT, 'eval', 'proxy', 'manifest.json');
const GOLDENS_README = join(ROOT, 'eval', 'goldens', 'README.md');
const LICENSE_PATH = join(ROOT, 'LICENSE');
const INSTALL_MD = join(ROOT, 'docs', 'INSTALL.md');
const BUILD_MD = join(ROOT, 'docs', 'BUILD.md');
const README_PATH = join(ROOT, 'README.md');
const PUBLIC_REMOTE = 'https://github.com/blockbrain-ai/poidh-local-ai-image-detector';

type ExtensionFixtures = {
  context: BrowserContext;
  extensionId: string;
  serviceWorker: Worker;
  harness: Page;
};

// ---------------------------------------------------------------------------
// dist walk + hash collectors
// ---------------------------------------------------------------------------

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) {
      walkFiles(abs, out);
    } else if (ent.isFile()) {
      out.push(abs);
    }
  }
  return out;
}

function loadProxyAndGoldenHashes(): Set<string> {
  const hashes = new Set<string>();
  if (!existsSync(PROXY_MANIFEST)) {
    throw new Error(`missing proxy manifest: ${PROXY_MANIFEST}`);
  }
  const manifest = JSON.parse(readFileSync(PROXY_MANIFEST, 'utf8')) as {
    rows?: Array<{ sha256?: string }>;
  };
  for (const row of manifest.rows ?? []) {
    const h = (row.sha256 ?? '').toLowerCase();
    if (/^[0-9a-f]{64}$/.test(h)) hashes.add(h);
  }
  if (existsSync(GOLDENS_README)) {
    const text = readFileSync(GOLDENS_README, 'utf8');
    for (const m of text.matchAll(/\b([0-9a-f]{64})\b/gi)) {
      hashes.add(m[1].toLowerCase());
    }
  }
  if (hashes.size < 10) {
    throw new Error(
      `expected ≥10 proxy/golden hashes for anticheat; got ${hashes.size}`,
    );
  }
  return hashes;
}

/** Weight / ORT pins that legitimately appear in dist/weights/manifest.json. */
function loadAllowedWeightHashes(): Set<string> {
  const allowed = new Set<string>();
  const candidates = [
    join(ROOT, 'weights', 'manifest.json'),
    join(DIST, 'weights', 'manifest.json'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    for (const m of text.matchAll(/\b([0-9a-f]{64})\b/gi)) {
      allowed.add(m[1].toLowerCase());
    }
  }
  return allowed;
}

function fileLooksText(path: string): boolean {
  const ext = extname(path).toLowerCase();
  if (
    [
      '.js',
      '.mjs',
      '.cjs',
      '.json',
      '.html',
      '.htm',
      '.css',
      '.txt',
      '.md',
      '.map',
      '.svg',
      '.xml',
      '.csv',
    ].includes(ext)
  ) {
    return true;
  }
  // Probe first bytes for printable ratio (catch extensionless embeds).
  try {
    const buf = readFileSync(path);
    const sample = buf.subarray(0, Math.min(buf.length, 4096));
    if (sample.length === 0) return true;
    let printable = 0;
    for (const b of sample) {
      if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)) printable++;
    }
    return printable / sample.length > 0.85;
  } catch {
    return false;
  }
}

/**
 * AC-AC zip-grep: every file under dist/ is searched for forbidden bench hashes
 * and score-lookup table shapes. Binary files are also scanned as latin1 so a
 * packed table cannot hide as bytes.
 */
function scanDistForAnticheatViolations(
  forbidden: Set<string>,
  allowed: Set<string>,
): string[] {
  const violations: string[] = [];
  const files = walkFiles(DIST);
  if (files.length === 0) {
    violations.push('dist/ is empty — run npm run build first');
    return violations;
  }

  // Patterns that look like a precomputed scores lookup table.
  const lookupPatterns: Array<{ name: string; re: RegExp }> = [
    {
      name: 'scoreByHash',
      re: /scoreByHash|scoresBySha|score_by_sha|SCORE_TABLE|precomputedScores|precomputed_scores/i,
    },
    {
      name: 'sha-to-score-object',
      re: /["']([0-9a-f]{64})["']\s*:\s*(0?\.\d+|1(\.0+)?)\b/i,
    },
    {
      name: 'sha-score-pair-array',
      re: /"sha256"\s*:\s*"[0-9a-f]{64}"\s*,\s*"score"\s*:\s*-?[\d.]+/i,
    },
    {
      name: 'score-sha-pair-array',
      re: /"score"\s*:\s*-?[\d.]+\s*,\s*"sha256"\s*:\s*"[0-9a-f]{64}"/i,
    },
  ];

  const activeForbidden = [...forbidden].filter((h) => !allowed.has(h));
  // Single alternation regex — far cheaper than 200+ includes() on multi-MB wasm.
  const forbiddenRe =
    activeForbidden.length > 0
      ? new RegExp(activeForbidden.join('|'), 'i')
      : null;

  for (const abs of files) {
    const rel = relative(ROOT, abs);
    let content: string;
    try {
      const buf = readFileSync(abs);
      // Always latin1 so binary embeds of ascii hex still match.
      content = buf.toString('latin1');
    } catch (err) {
      violations.push(`cannot read ${rel}: ${err}`);
      continue;
    }

    // Forbidden proxy/golden hashes (not weight pins).
    if (forbiddenRe) {
      const m = content.match(forbiddenRe);
      if (m) {
        violations.push(
          `bench hash ${m[0].toLowerCase().slice(0, 12)}… found in ${rel}`,
        );
      }
    }

    // Scores lookup shapes only in text-ish payloads (avoid false positives in wasm).
    if (fileLooksText(abs) || extname(abs).toLowerCase() === '.json') {
      for (const { name, re } of lookupPatterns) {
        if (re.test(content)) {
          violations.push(`scores lookup pattern "${name}" in ${rel}`);
        }
      }
    }
  }

  // Zip-grep: pack dist/ and re-scan archive bytes so a release tarball cannot
  // smuggle bench hashes that a plain walk would miss after compression tricks.
  try {
    const zipPath = join(
      tmpdir(),
      `poidh-anticheat-dist-${Date.now()}.tar.gz`,
    );
    const tar = spawnSync('tar', ['-czf', zipPath, '-C', DIST, '.'], {
      encoding: 'utf8',
    });
    if (tar.status === 0 && existsSync(zipPath) && forbiddenRe) {
      const ztext = readFileSync(zipPath).toString('latin1');
      const m = ztext.match(forbiddenRe);
      if (m) {
        violations.push(
          `bench hash ${m[0].toLowerCase().slice(0, 12)}… found in dist archive (zip-grep)`,
        );
      }
      try {
        unlinkSync(zipPath);
      } catch {
        /* ignore cleanup */
      }
    }
  } catch {
    // Archive step is best-effort; file walk above is authoritative.
  }

  return violations;
}

function ensureDistBuilt(): void {
  if (
    existsSync(join(DIST, 'manifest.json')) &&
    existsSync(join(DIST, 'service_worker.js')) &&
    existsSync(join(DIST, 'content.js')) &&
    existsSync(join(DIST, 'popup.js'))
  ) {
    return;
  }
  execSync('bash scripts/gate-build.sh', { cwd: ROOT, stdio: 'inherit' });
}

// ---------------------------------------------------------------------------
// Playwright fixtures — clean profile, no setup
// ---------------------------------------------------------------------------

const test = base.extend<ExtensionFixtures>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    ensureDistBuilt();
    const userDataDir = join(
      tmpdir(),
      `poidh-pw-anticheat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(userDataDir, { recursive: true });

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

    await use(context);
    await context.close();
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('5.1 anticheat JOB-ANTICHEAT-01', () => {
  test('AC-AC: dist has no proxy/golden hashes or scores lookup (zip-grep)', () => {
    ensureDistBuilt();
    const forbidden = loadProxyAndGoldenHashes();
    const allowed = loadAllowedWeightHashes();
    // Sanity: weight pin must not be treated as a bench hash (if somehow listed).
    for (const h of allowed) {
      // Weight pins may theoretically collide; still skip them in the scan.
      void h;
    }
    const violations = scanDistForAnticheatViolations(forbidden, allowed);
    expect(
      violations,
      violations.length
        ? `anticheat violations:\n${violations.join('\n')}`
        : 'clean',
    ).toEqual([]);
  });

  test('AC-MIT + AC-DOC: LICENSE MIT, INSTALL matches e2e-install, public GitHub URL', () => {
    expect(existsSync(LICENSE_PATH), 'LICENSE missing').toBe(true);
    const license = readFileSync(LICENSE_PATH, 'utf8');
    expect(license).toMatch(/MIT/);
    expect(license).toMatch(/Copyright/i);

    expect(existsSync(INSTALL_MD), 'docs/INSTALL.md missing').toBe(true);
    expect(existsSync(BUILD_MD), 'docs/BUILD.md missing').toBe(true);
    const install = readFileSync(INSTALL_MD, 'utf8');
    const readme = readFileSync(README_PATH, 'utf8');

    // e2e-install contract: build → load unpacked dist/ → models not ready.
    expect(install).toMatch(/npm run build/);
    expect(install).toMatch(/Load unpacked/i);
    expect(install).toMatch(/dist\//);
    expect(install).toMatch(/chrome:\/\/extensions/);
    expect(install).toMatch(/models not ready/);
    expect(install).toMatch(/Developer mode/i);
    expect(install).toMatch(/manifest\.json/);

    // Public remote recorded (README + INSTALL).
    expect(readme).toContain(PUBLIC_REMOTE);
    expect(install).toContain(PUBLIC_REMOTE);
    expect(readme).toMatch(/poidh-local-ai-image-detector/);
    expect(readme).toMatch(/MIT/);

    // Maintainer build docs only — no planning / constitution narrative.
    for (const text of [install, readFileSync(BUILD_MD, 'utf8')]) {
      expect(text).not.toMatch(/00_CONSTITUTION|ACTIVE-RUNS|field_validated|Pass B|G7 AGREE/i);
      expect(text).not.toMatch(/on-chain|arbitrum tx|claim transaction/i);
    }
  });

  test('AC-NOPLAN: git ls-files has no packs, ACTIVE-RUNS, audit reviews, constitution drafts', () => {
    let tracked: string;
    try {
      tracked = execSync('git ls-files', {
        cwd: ROOT,
        encoding: 'utf8',
      });
    } catch {
      test.skip(true, 'git unavailable');
      return;
    }
    const lines = tracked.split('\n').filter(Boolean);
    const forbiddenGlobs: Array<{ label: string; test: (p: string) => boolean }> =
      [
        {
          label: 'aid-* pack',
          test: (p) => /(^|\/)aid-[0-9]/.test(p),
        },
        {
          label: 'ACTIVE-RUNS',
          test: (p) => /ACTIVE-RUNS/i.test(p),
        },
        {
          label: 'constitution draft',
          test: (p) =>
            /00_CONSTITUTION|CONSTITUTION\.md/i.test(p) &&
            !p.includes('check-docs'),
        },
        {
          label: 'livability / requirements / hypothesis matrices',
          test: (p) =>
            /02_LIVABILITY|REQUIREMENTS_MATRIX|HYPOTHESIS_REGISTER|BUILD_CHECKLIST/i.test(
              p,
            ),
        },
        {
          label: 'audit reviews',
          test: (p) =>
            p === 'evidence/reviews' ||
            p.startsWith('evidence/reviews/') ||
            /FINDINGS_LEDGER|Pass[BG]|G4-review|G7-review/i.test(p),
        },
        {
          label: 'engineering-standards control plane',
          test: (p) => /engineering-standards\.md$/i.test(p),
        },
      ];

    const hits: string[] = [];
    for (const p of lines) {
      for (const g of forbiddenGlobs) {
        if (g.test(p)) hits.push(`${g.label}: ${p}`);
      }
    }
    expect(hits, hits.length ? hits.join('\n') : 'clean tree').toEqual([]);
  });

  test('AC-EMPTY: empty result / artifact cache at first install (clean profile)', async ({
    context,
    harness,
    extensionId,
  }) => {
    test.setTimeout(120_000);

    // Popup must report models not ready — install shell, no pre-warmed scores.
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, {
      waitUntil: 'domcontentloaded',
    });
    await expect
      .poll(
        async () => ((await popup.locator('#status').textContent()) ?? '').trim(),
        { timeout: 15_000, message: 'popup status at install' },
      )
      .toMatch(/models not ready/i);
    const shaText = ((await popup.locator('#sha').textContent()) ?? '').trim();
    // No production weight SHA displayed before setup.
    expect(shaText === '' || /not ready|—|-/i.test(shaText) || shaText.length < 8).toBe(
      true,
    );
    await popup.close().catch(() => undefined);

    // Artifact store must not be ready (empty OPFS/Cache at install).
    const status = await extensionSend<{
      ready?: boolean;
      sha256?: string | null;
      modelsReadyMarker?: boolean;
      error?: string;
    }>(harness, { type: 'ARTIFACT_STATUS' });
    expect(
      status?.ready,
      `ARTIFACT_STATUS should be not-ready at install: ${JSON.stringify(status)}`,
    ).toBeFalsy();
    expect(status?.sha256 ?? null).toBeNull();

    // chrome.storage.local must not hold a precomputed scores map or bench table.
    const storageDump = await harness.evaluate(async () => {
      const all = await chrome.storage.local.get(null);
      return all as Record<string, unknown>;
    });
    const storageJson = JSON.stringify(storageDump).toLowerCase();
    expect(storageJson).not.toMatch(/scorebyhash|precomputedscores|score_table/);
    // No 64-hex → float table keys
    expect(storageJson).not.toMatch(
      /"[0-9a-f]{64}"\s*:\s*(0?\.\d+|1(\.0+)?)/,
    );

    // Cache API: no poidh score-table caches; artifact bucket may exist empty.
    const cacheProbe = await harness.evaluate(async () => {
      if (typeof caches === 'undefined') {
        return { names: [] as string[], scoreHits: 0 };
      }
      const names = await caches.keys();
      let scoreHits = 0;
      for (const name of names) {
        if (/score|golden|proxy-ba|lookup/i.test(name)) scoreHits++;
        const cache = await caches.open(name);
        const reqs = await cache.keys();
        for (const req of reqs) {
          const url = req.url.toLowerCase();
          if (/score-table|precomputed|golden-score|proxy-score/.test(url)) {
            scoreHits++;
          }
        }
      }
      return { names, scoreHits };
    });
    expect(
      cacheProbe.scoreHits,
      `unexpected score caches: ${JSON.stringify(cacheProbe)}`,
    ).toBe(0);

    // Content-script resultCache is in-memory only; inject a page and confirm no
    // pre-existing badges before any scan (empty overlay cache at install).
    const page = await context.newPage();
    await page.setContent(
      '<!DOCTYPE html><html><body><p id="t">anticheat empty</p></body></html>',
      { waitUntil: 'domcontentloaded' },
    );
    const badgeCount = await page.evaluate(() => {
      return document.querySelectorAll(
        '[data-aidet-badge-host], [data-testid="aidet-badge"]',
      ).length;
    });
    expect(badgeCount, 'no pre-seeded badges at install').toBe(0);
    await page.close().catch(() => undefined);

    // AC-NOCLAIM: suite records no chain TX (document via assertion on README).
    const readme = readFileSync(README_PATH, 'utf8');
    expect(readme).not.toMatch(/0x[a-fA-F0-9]{64}/); // no eth tx hash claim
  });
});
