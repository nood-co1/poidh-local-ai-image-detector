import { describe, expect, it } from 'vitest';
import { THRESHOLD } from '../src/threshold.js';
import {
  BA_MIN,
  SKIP_RATE_MAX,
  computeProxyMetrics,
  decide,
  type ScoredRow,
} from './scorer.js';

describe('decide (A1)', () => {
  it('uses THRESHOLD from src/threshold.ts', () => {
    expect(THRESHOLD).toBe(0.65);
    expect(decide(THRESHOLD)).toBe('ai');
    expect(decide(THRESHOLD - 1e-9)).toBe('real');
    expect(decide(0)).toBe('real');
    expect(decide(1)).toBe('ai');
  });
});

describe('computeProxyMetrics', () => {
  it('computes BA of a toy 4-vector at 0.65', () => {
    // 2 real + 2 ai, all scored:
    // real 0.10 → TN, real 0.90 → FP, ai 0.90 → TP, ai 0.10 → FN
    // TPR = 0.5, TNR = 0.5, BA = 0.5
    const rows: ScoredRow[] = [
      { label: 'real', outcome: { kind: 'scored', score: 0.1 } },
      { label: 'real', outcome: { kind: 'scored', score: 0.9 } },
      { label: 'ai', outcome: { kind: 'scored', score: 0.9 } },
      { label: 'ai', outcome: { kind: 'scored', score: 0.1 } },
    ];
    const m = computeProxyMetrics(rows);
    expect(m.attempted).toBe(4);
    expect(m.skips).toBe(0);
    expect(m.scored).toBe(4);
    expect(m.tp).toBe(1);
    expect(m.fn).toBe(1);
    expect(m.tn).toBe(1);
    expect(m.fp).toBe(1);
    expect(m.tpr).toBeCloseTo(0.5);
    expect(m.tnr).toBeCloseTo(0.5);
    expect(m.ba).toBeCloseTo(0.5);
    expect(m.pass).toBe(false);
  });

  it('scores at exact threshold 0.65 as AI', () => {
    const rows: ScoredRow[] = [
      { label: 'ai', outcome: { kind: 'scored', score: 0.65 } },
      { label: 'real', outcome: { kind: 'scored', score: 0.65 } },
    ];
    const m = computeProxyMetrics(rows);
    expect(m.tp).toBe(1);
    expect(m.fp).toBe(1);
    expect(m.tn).toBe(0);
    expect(m.fn).toBe(0);
  });

  it('fails gate when 2/10 skipped (skip-rate 0.20 > 0.10)', () => {
    // 10 attempted: 2 skips + 8 perfect scores → BA = 1.0 but skip-rate = 0.2
    const rows: ScoredRow[] = [
      { label: 'ai', outcome: { kind: 'skip', reason: 'skip_small' } },
      { label: 'real', outcome: { kind: 'skip', reason: 'skip_cross_origin' } },
      { label: 'ai', outcome: { kind: 'scored', score: 0.9 } },
      { label: 'ai', outcome: { kind: 'scored', score: 0.9 } },
      { label: 'ai', outcome: { kind: 'scored', score: 0.9 } },
      { label: 'ai', outcome: { kind: 'scored', score: 0.9 } },
      { label: 'real', outcome: { kind: 'scored', score: 0.1 } },
      { label: 'real', outcome: { kind: 'scored', score: 0.1 } },
      { label: 'real', outcome: { kind: 'scored', score: 0.1 } },
      { label: 'real', outcome: { kind: 'scored', score: 0.1 } },
    ];

    const m = computeProxyMetrics(rows);
    expect(m.attempted).toBe(10);
    expect(m.skips).toBe(2);
    expect(m.skipRate).toBeCloseTo(0.2);
    expect(m.scored).toBe(8);
    expect(m.ba).toBeCloseTo(1.0);
    expect(m.skipRate).toBeGreaterThan(SKIP_RATE_MAX);
    expect(m.pass).toBe(false);
  });

  it('skip is not scored as real (does not inflate TNR)', () => {
    const rows: ScoredRow[] = [
      { label: 'ai', outcome: { kind: 'skip', reason: 'skip_canvas' } },
      { label: 'real', outcome: { kind: 'scored', score: 0.1 } },
      { label: 'ai', outcome: { kind: 'scored', score: 0.9 } },
    ];
    const m = computeProxyMetrics(rows);
    expect(m.skips).toBe(1);
    expect(m.scored).toBe(2);
    expect(m.tn).toBe(1);
    expect(m.tp).toBe(1);
    // If skip were coerced to real we'd mis-count; tn stays 1 not 2
    expect(m.fn).toBe(0);
  });

  it('passes when BA >= 0.75 and skip-rate <= 0.10', () => {
    // 10 images, 1 skip (0.10), perfect scores on rest
    const rows: ScoredRow[] = [
      { label: 'ai', outcome: { kind: 'scored', score: 0.9 } },
      { label: 'ai', outcome: { kind: 'scored', score: 0.8 } },
      { label: 'ai', outcome: { kind: 'scored', score: 0.7 } },
      { label: 'ai', outcome: { kind: 'scored', score: 0.95 } },
      { label: 'real', outcome: { kind: 'scored', score: 0.1 } },
      { label: 'real', outcome: { kind: 'scored', score: 0.2 } },
      { label: 'real', outcome: { kind: 'scored', score: 0.05 } },
      { label: 'real', outcome: { kind: 'scored', score: 0.3 } },
      { label: 'ai', outcome: { kind: 'scored', score: 0.66 } },
      { label: 'real', outcome: { kind: 'skip', reason: 'skip_small' } },
    ];
    const m = computeProxyMetrics(rows);
    expect(m.skipRate).toBeLessThanOrEqual(SKIP_RATE_MAX);
    expect(m.ba).toBeGreaterThanOrEqual(BA_MIN);
    expect(m.pass).toBe(true);
  });

  it('fails closed on empty attempt list', () => {
    const m = computeProxyMetrics([]);
    expect(m.attempted).toBe(0);
    expect(m.pass).toBe(false);
  });
});
