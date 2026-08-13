/**
 * Single proxy BA formula (standards E2 / constitution Article IV).
 *
 * - attempted N = all rows attempted
 * - skip-rate = skips / N
 * - BA = (TPR + TNR) / 2 on **scored** images only
 * - A1: AI iff score >= THRESHOLD else real
 * - Skip is **not** scored as real
 * - Gate passes only if BA >= 0.750 **and** skip-rate <= 0.10
 */

import { THRESHOLD } from '../src/threshold.js';

/** Ground-truth proxy label. */
export type ProxyLabel = 'real' | 'ai';

/** Predicted decision label (A1). */
export type DecisionLabel = 'real' | 'ai';

/** One attempted row outcome. */
export type AttemptOutcome =
  | { kind: 'scored'; score: number }
  | { kind: 'skip'; reason: string };

export interface ScoredRow {
  /** Ground truth from manifest. */
  label: ProxyLabel;
  outcome: AttemptOutcome;
}

export interface ProxyMetrics {
  /** Attempted N (full proxy; no subset). */
  attempted: number;
  skips: number;
  scored: number;
  skipRate: number;
  /** True positives (AI predicted AI) among scored. */
  tp: number;
  /** False negatives (AI predicted real) among scored. */
  fn: number;
  /** True negatives (real predicted real) among scored. */
  tn: number;
  /** False positives (real predicted AI) among scored. */
  fp: number;
  /** TPR = tp / (tp + fn); 0 when no scored AI. */
  tpr: number;
  /** TNR = tn / (tn + fp); 0 when no scored real. */
  tnr: number;
  /** Balanced accuracy on scored only. */
  ba: number;
  /** Gate: BA >= BA_MIN and skipRate <= SKIP_RATE_MAX. */
  pass: boolean;
}

/** Admission floor: BA >= 0.750. */
export const BA_MIN = 0.75;

/** Admission cap: skip-rate <= 0.10. */
export const SKIP_RATE_MAX = 0.1;

/**
 * A1 decision: AI iff score >= THRESHOLD, else real.
 * Imports THRESHOLD — never hardcode 0.65 here.
 */
export function decide(score: number): DecisionLabel {
  return score >= THRESHOLD ? 'ai' : 'real';
}

/**
 * Compute proxy metrics for a full attempted set.
 * Fail-closed: empty attempt list yields pass=false.
 */
export function computeProxyMetrics(rows: readonly ScoredRow[]): ProxyMetrics {
  const attempted = rows.length;
  if (attempted === 0) {
    return {
      attempted: 0,
      skips: 0,
      scored: 0,
      skipRate: 0,
      tp: 0,
      fn: 0,
      tn: 0,
      fp: 0,
      tpr: 0,
      tnr: 0,
      ba: 0,
      pass: false,
    };
  }

  let skips = 0;
  let tp = 0;
  let fn = 0;
  let tn = 0;
  let fp = 0;

  for (const row of rows) {
    if (row.outcome.kind === 'skip') {
      skips += 1;
      continue;
    }
    const predicted = decide(row.outcome.score);
    if (row.label === 'ai') {
      if (predicted === 'ai') tp += 1;
      else fn += 1;
    } else {
      if (predicted === 'real') tn += 1;
      else fp += 1;
    }
  }

  const scored = attempted - skips;
  const skipRate = skips / attempted;
  const aiCount = tp + fn;
  const realCount = tn + fp;
  const tpr = aiCount > 0 ? tp / aiCount : 0;
  const tnr = realCount > 0 ? tn / realCount : 0;
  const ba = (tpr + tnr) / 2;
  const pass = ba >= BA_MIN && skipRate <= SKIP_RATE_MAX;

  return {
    attempted,
    skips,
    scored,
    skipRate,
    tp,
    fn,
    tn,
    fp,
    tpr,
    tnr,
    ba,
    pass,
  };
}
