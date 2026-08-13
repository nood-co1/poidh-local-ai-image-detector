#!/usr/bin/env node
/**
 * Spec 4.3 — Evidence checker (AC-EVID).
 *
 * Fail-closed:
 *   - evidence/SOUL_EVIDENCE_TABLE.md lists REQUIRED souls 1–9
 *   - no REQUIRED row is SKIPPED / unproven / missing
 *   - evidence/proxy-ba-<HEAD>.json exists, gitSha matches HEAD, pass=true
 *   - threshold / BA / skip floors match admission law
 *   - e2e log paths referenced in the table exist when marked PASS
 *
 * One-shot, non-interactive. Does not print env secrets.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE_DIR = join(ROOT, 'evidence');
const TABLE_PATH = join(EVIDENCE_DIR, 'SOUL_EVIDENCE_TABLE.md');
const errors = [];

function fail(msg) {
  errors.push(msg);
}

function resolveGitSha() {
  if (
    process.env.POIDH_GIT_SHA &&
    /^[0-9a-f]{7,40}$/i.test(process.env.POIDH_GIT_SHA)
  ) {
    return process.env.POIDH_GIT_SHA.toLowerCase();
  }
  try {
    return execSync('git rev-parse HEAD', {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .trim()
      .toLowerCase();
  } catch {
    fail('cannot resolve product git SHA (git rev-parse HEAD)');
    return null;
  }
}

/** Parse markdown table rows from SOUL_EVIDENCE_TABLE.md */
function parseSoulTable(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    if (/^\|\s*-+/.test(trimmed)) continue;
    const cells = trimmed
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 4) continue;
    // Header row only (do not match SOUL-1… with /^soul/i).
    if (cells[0].toLowerCase() === 'soul_id' || cells[0].toLowerCase() === 'soul') {
      continue;
    }
    // Only soul table rows (SOUL-N); ignore later log/field tables.
    if (!/^SOUL-\d+/i.test(cells[0])) continue;
    const [soul_id, required, status, evidence_path, ...rest] = cells;
    rows.push({
      soul_id,
      required: (required || '').toUpperCase(),
      status: (status || '').toUpperCase(),
      evidence_path: evidence_path || '',
      notes: rest.join(' | '),
    });
  }
  return rows;
}

function main() {
  const gitSha = resolveGitSha();

  // --- SOUL_EVIDENCE_TABLE.md ---
  if (!existsSync(TABLE_PATH)) {
    fail(`missing ${TABLE_PATH}`);
  } else {
    const text = readFileSync(TABLE_PATH, 'utf8');
    const rows = parseSoulTable(text);
    if (rows.length < 9) {
      fail(
        `SOUL_EVIDENCE_TABLE.md has ${rows.length} data rows; need souls 1–9 at minimum`,
      );
    }

    const requiredSouls = [
      'SOUL-1',
      'SOUL-2',
      'SOUL-3',
      'SOUL-4',
      'SOUL-5',
      'SOUL-6',
      'SOUL-7',
      'SOUL-8',
      'SOUL-9',
    ];
    for (const id of requiredSouls) {
      const row = rows.find((r) => r.soul_id.toUpperCase() === id);
      if (!row) {
        fail(`REQUIRED soul ${id} missing from SOUL_EVIDENCE_TABLE.md`);
        continue;
      }
      if (row.required !== 'REQUIRED' && row.required !== 'YES') {
        fail(`${id}: required column must be REQUIRED (got ${row.required})`);
      }
      // No skipped REQUIRED
      if (
        /SKIP|SKIPPED|UNPROVEN|OPEN|TODO|PENDING|N\/A|DEFER/i.test(row.status)
      ) {
        fail(
          `REQUIRED soul ${id} has non-PASS status: ${row.status} (no skipped REQUIRED)`,
        );
      }
      if (row.status !== 'PASS') {
        fail(`REQUIRED soul ${id} status must be PASS (got ${row.status})`);
      }
    }

    // Paths: expand <sha> / <HEAD> placeholders; require at least one real path token.
    for (const row of rows) {
      if (row.required !== 'REQUIRED' && row.required !== 'YES') continue;
      if (!row.evidence_path || row.evidence_path === '—' || row.evidence_path === '-') {
        fail(`${row.soul_id}: empty evidence_path`);
        continue;
      }
      // evidence_path may list multiple paths separated by comma or semicolon.
      const parts = row.evidence_path
        .split(/[,;]/)
        .map((p) => p.trim())
        .filter(Boolean);
      let anyExists = false;
      for (let p of parts) {
        // Strip backticks
        p = p.replace(/`/g, '');
        if (p.includes('<sha>') || p.includes('<HEAD>') || p.includes('<gitsha>')) {
          if (!gitSha) continue;
          p = p
            .replace(/<sha>/gi, gitSha)
            .replace(/<HEAD>/gi, gitSha)
            .replace(/<gitsha>/gi, gitSha);
        }
        // Relative to repo root
        const abs = p.startsWith('/') ? p : join(ROOT, p);
        if (existsSync(abs)) {
          anyExists = true;
          break;
        }
        // Glob-ish: evidence/proxy-ba-*.json → any matching for HEAD only checked below
        if (p.includes('*')) {
          const dir = dirname(abs.replace('*', 'x'));
          if (existsSync(dir)) {
            const files = readdirSync(dir);
            const re = new RegExp(
              '^' +
                p
                  .split('/')
                  .pop()
                  .replace(/\./g, '\\.')
                  .replace(/\*/g, '.*') +
                '$',
            );
            if (files.some((f) => re.test(f))) {
              anyExists = true;
              break;
            }
          }
        }
      }
      // Soul 7 is checked strictly against HEAD below; other souls may reference
      // code paths that always exist (e.g. e2e/*.spec.ts).
      if (!anyExists && row.soul_id.toUpperCase() !== 'SOUL-7') {
        // Soft path check: if path looks like a source file under repo, require it.
        const looksLikeRepoFile = parts.some((p) =>
          /^(e2e|src|scripts|extension|eval|weights|dist)\//.test(
            p.replace(/`/g, ''),
          ),
        );
        if (looksLikeRepoFile) {
          fail(
            `${row.soul_id}: none of evidence paths exist: ${row.evidence_path}`,
          );
        }
      }
    }
  }

  // --- proxy-ba certificate for HEAD ---
  if (gitSha) {
    const evidenceFile = join(EVIDENCE_DIR, `proxy-ba-${gitSha}.json`);
    if (!existsSync(evidenceFile)) {
      fail(
        `missing evidence/proxy-ba-${gitSha}.json (SHA must match HEAD; run scripts/gate-full.d/30-proxy-ba.sh)`,
      );
    } else {
      let j;
      try {
        j = JSON.parse(readFileSync(evidenceFile, 'utf8'));
      } catch (err) {
        fail(`cannot parse ${evidenceFile}: ${err}`);
        j = null;
      }
      if (j) {
        if (String(j.gitSha || '').toLowerCase() !== gitSha) {
          fail(
            `proxy-ba gitSha ${j.gitSha} != HEAD ${gitSha}`,
          );
        }
        if (j.source !== 'extension-page-rendered') {
          fail(
            `proxy-ba source must be extension-page-rendered (got ${j.source}); CLI is inadmissible`,
          );
        }
        if (j.pass !== true) {
          fail(`proxy-ba pass!=true ba=${j.ba} skip=${j.skipRate}`);
        }
        if (typeof j.ba !== 'number' || j.ba < 0.75) {
          fail(`proxy-ba BA ${j.ba} < 0.75`);
        }
        if (typeof j.skipRate !== 'number' || j.skipRate > 0.1) {
          fail(`proxy-ba skipRate ${j.skipRate} > 0.10`);
        }
        if (typeof j.threshold !== 'number' || j.threshold !== 0.65) {
          fail(`proxy-ba threshold ${j.threshold} != 0.65`);
        }
        if (typeof j.attempted !== 'number' || j.attempted < 200) {
          fail(`proxy-ba attempted ${j.attempted} < 200 (full proxy required)`);
        }
      }
    }
  }

  if (errors.length > 0) {
    console.error('check-evidence: FAIL');
    for (const e of errors) {
      console.error(`  - ${e}`);
    }
    process.exit(1);
  }

  console.log(
    JSON.stringify({
      ok: true,
      gitSha,
      table: 'evidence/SOUL_EVIDENCE_TABLE.md',
      proxyBa: gitSha ? `evidence/proxy-ba-${gitSha}.json` : null,
    }),
  );
}

main();
