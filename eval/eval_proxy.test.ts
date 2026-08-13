/**
 * CLI eval_proxy parity harness tests (H5 / E9).
 * CLI JSON remains inadmissible as the soul-7 certificate.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  BA_MIN,
  SKIP_RATE_MAX,
  buildProxyBaEvidence,
  computeProxyMetrics,
  constantModelWitnessRows,
  type ScoredRow,
} from './scorer.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDENS_README = join(ROOT, 'eval', 'goldens', 'README.md');
const MANIFEST_PATH = join(ROOT, 'eval', 'proxy', 'manifest.json');

describe('eval_proxy golden parity protocol (H5)', () => {
  it('goldens are ten hashes present in the frozen proxy', () => {
    expect(existsSync(GOLDENS_README)).toBe(true);
    expect(existsSync(MANIFEST_PATH)).toBe(true);
    const text = readFileSync(GOLDENS_README, 'utf8');
    const hashes = [...text.matchAll(/`([a-f0-9]{64})`/g)].map((m) => m[1]!);
    expect(hashes.length).toBe(10);

    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
      rows: Array<{ sha256: string; label: string; relpath: string }>;
    };
    const set = new Set(manifest.rows.map((r) => r.sha256));
    for (const h of hashes) {
      expect(set.has(h), `golden ${h} missing from proxy`).toBe(true);
    }

    // 5 real + 5 ai per goldens README layout
    const rows = manifest.rows.filter((r) => hashes.includes(r.sha256));
    expect(rows.length).toBe(10);
    expect(rows.filter((r) => r.label === 'real').length).toBe(5);
    expect(rows.filter((r) => r.label === 'ai').length).toBe(5);
  });

  it('CLI evidence source is marked inadmissible', () => {
    const rows: ScoredRow[] = [
      { label: 'ai', outcome: { kind: 'scored', score: 0.9 } },
      { label: 'real', outcome: { kind: 'scored', score: 0.1 } },
    ];
    const ev = buildProxyBaEvidence({
      gitSha: 'abc1234',
      rows,
      source: 'cli-parity-inadmissible',
    });
    expect(ev.source).toBe('cli-parity-inadmissible');
    // Gate formula still evaluates, but source flag makes it inadmissible.
    expect(ev.pass).toBe(true);
    expect(ev.source).not.toBe('extension-page-rendered');
  });

  it('constant-0.5 golden scores fail BA (G-FALSE-GREEN path used by CLI)', () => {
    const labels = Array.from({ length: 10 }, (_, i) =>
      i < 5 ? ('ai' as const) : ('real' as const),
    );
    const m = computeProxyMetrics(constantModelWitnessRows(labels, 0.5));
    expect(m.ba).toBeLessThan(BA_MIN);
    expect(m.skipRate).toBeLessThanOrEqual(SKIP_RATE_MAX);
    expect(m.pass).toBe(false);
  });
});
