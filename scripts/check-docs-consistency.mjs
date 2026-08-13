#!/usr/bin/env node
/**
 * Docs-consistency gate (0.1 hand-off → 1.2 product script).
 *
 * Product tree checks (always):
 *  - No constitution / livability / hypothesis / BUILD_CHECKLIST / audit reviews
 *  - LICENSE contains MIT (+ Copyright)
 *  - README.md exists
 *
 * Control-plane checks (when RUNS_DIR is resolvable):
 *  - Souls 1–9 and SOUL-1…SOUL-9 appear in constitution, livability, BUILD_CHECKLIST
 *  - BC-1…BC-9 present; no win-critical DEFER rows
 *
 * Fails if a soul row is deleted from the control plane.
 * Never prints env secrets.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

function fail(msg) {
  errors.push(msg);
}

function readText(path) {
  return readFileSync(path, 'utf8');
}

function pathExists(p) {
  return existsSync(p);
}

// --- product tree: forbidden control-plane artefacts ---
const FORBIDDEN_RELATIVE = [
  'docs/00_CONSTITUTION.md',
  'docs/02_LIVABILITY_MATRIX.md',
  'docs/REQUIREMENTS_MATRIX.md',
  'docs/HYPOTHESIS_REGISTER.md',
  'BUILD_CHECKLIST.md',
];

for (const rel of FORBIDDEN_RELATIVE) {
  const abs = join(ROOT, rel);
  if (pathExists(abs)) {
    fail(`product tree must not contain ${rel}`);
  }
}

const reviewsDir = join(ROOT, 'evidence', 'reviews');
if (pathExists(reviewsDir)) {
  fail('product tree must not contain evidence/reviews/');
}

// Also refuse if git tracks any of these (even if deleted from worktree).
try {
  const tracked = execSync('git ls-files', {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const lines = tracked.split('\n').filter(Boolean);
  for (const rel of FORBIDDEN_RELATIVE) {
    if (lines.includes(rel)) {
      fail(`product git tree must not track ${rel}`);
    }
  }
  if (lines.some((l) => l === 'evidence/reviews' || l.startsWith('evidence/reviews/'))) {
    fail('product git tree must not track evidence/reviews/');
  }
} catch {
  // Not a git repo or git unavailable — worktree checks above still apply.
}

// --- LICENSE ---
const licensePath = join(ROOT, 'LICENSE');
if (!pathExists(licensePath)) {
  fail('LICENSE missing');
} else {
  const license = readText(licensePath);
  if (!license.includes('MIT')) {
    fail('LICENSE must contain MIT');
  }
  if (!/Copyright/i.test(license)) {
    fail('LICENSE must contain a Copyright line');
  }
}

// --- README (required after 1.1) ---
if (!pathExists(join(ROOT, 'README.md'))) {
  fail('README.md missing');
}

// --- control plane souls 1–9 (optional path; required when resolvable) ---
function resolveRunsDir() {
  const candidates = [];
  if (process.env.RUNS_DIR) {
    candidates.push(process.env.RUNS_DIR);
  }
  // Common twins used by Section Runner / local volume layout.
  candidates.push(
    '/data/ClawdPoidhAidetRuns',
    '/mnt/HC_Volume_105994188/ClawdPoidhAidetRuns',
  );
  // Sibling of workspace when checked out next to the product repo.
  candidates.push(resolve(ROOT, '..', 'ClawdPoidhAidetRuns'));

  for (const c of candidates) {
    if (
      pathExists(join(c, 'docs', '00_CONSTITUTION.md')) &&
      pathExists(join(c, 'docs', '02_LIVABILITY_MATRIX.md')) &&
      pathExists(join(c, 'BUILD_CHECKLIST.md'))
    ) {
      return c;
    }
  }
  return null;
}

const runsDir = resolveRunsDir();
if (runsDir) {
  const constitution = join(runsDir, 'docs', '00_CONSTITUTION.md');
  const livability = join(runsDir, 'docs', '02_LIVABILITY_MATRIX.md');
  const checklist = join(runsDir, 'BUILD_CHECKLIST.md');
  const files = [constitution, livability, checklist];
  const texts = files.map((f) => ({ path: f, text: readText(f) }));

  for (let n = 1; n <= 9; n++) {
    for (const { path, text } of texts) {
      if (!text.includes(`soul ${n}`)) {
        fail(`MISSING soul ${n} in ${path}`);
      }
      if (!text.includes(`SOUL-${n}`)) {
        fail(`MISSING SOUL-${n} in ${path}`);
      }
    }
    const bc = readText(checklist);
    if (!bc.includes(`BC-${n}`)) {
      fail(`MISSING BC-${n} in ${checklist}`);
    }
  }

  // Win-critical DEFER on a BC row is forbidden (soul row deleted/optionalised).
  for (const { path, text } of texts) {
    const deferRows = text
      .split('\n')
      .filter((line) => /^\|\s*BC-[1-9]\b/.test(line) && /\|\s*DEFER\s*\|/.test(line));
    for (const row of deferRows) {
      fail(`win-critical DEFER forbidden in ${path}: ${row.trim()}`);
    }
    if (/Win-critical:\s*no/i.test(text)) {
      fail(`"Win-critical: no" forbidden in ${path}`);
    }
  }

  // JOB ids from programme contract.
  const jobs = [
    'JOB-INSTALL-01',
    'JOB-SETUP-01',
    'JOB-OFFLINE-01',
    'JOB-SCAN-01',
    'JOB-SCORE-01',
    'JOB-PRIVACY-01',
    'JOB-PROXY-01',
    'JOB-REPRO-01',
    'JOB-ANTICHEAT-01',
  ];
  const constitutionText = readText(constitution);
  for (const job of jobs) {
    if (!constitutionText.includes(job)) {
      fail(`MISSING ${job} in ${constitution}`);
    }
  }
} else {
  // Product-only environments still pass product checks; note the skip for operators.
  console.log(
    'check-docs-consistency: RUNS_DIR not found; skipped control-plane soul checks (product checks applied)',
  );
}

if (errors.length > 0) {
  for (const e of errors) {
    console.error(`docs-consistency FAIL: ${e}`);
  }
  process.exit(1);
}

console.log('docs-consistency: OK');
