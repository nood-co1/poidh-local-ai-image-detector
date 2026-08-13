/**
 * Single proxy BA formula (standards E2 / constitution Article IV).
 *
 * - attempted N = all rows attempted
 * - skip-rate = skips / N
 * - BA = (TPR + TNR) / 2 on **scored** images only
 * - A1: AI iff score >= THRESHOLD else real
 * - Skip is **not** scored as real
 * - Gate passes only if BA >= 0.750 **and** skip-rate <= 0.10
 *
 * Soul-7 certificate is produced only by the loaded extension on
 * page-rendered images (e2e/proxy-ba.spec.ts → evidence/proxy-ba-<sha>.json).
 * CLI JSON from eval/eval_proxy.ts is parity only and inadmissible.
 */

import {
  labelFromScore,
  THRESHOLD,
  type DecisionLabel,
} from '../src/label.js';

export { THRESHOLD };
export type { DecisionLabel };

/** Ground-truth proxy label. */
export type ProxyLabel = 'real' | 'ai';

/** One attempted row outcome. */
export type AttemptOutcome =
  | { kind: 'scored'; score: number }
  | { kind: 'skip'; reason: string };

export interface ScoredRow {
  /** Ground truth from manifest. */
  label: ProxyLabel;
  outcome: AttemptOutcome;
  /** Optional family tag for per-family breakdown. */
  family?: string;
  /** Optional sha256 identity from the frozen manifest. */
  sha256?: string;
  /** Optional relpath under eval/proxy/. */
  relpath?: string;
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

/** Per-family slice of the same BA formula (on that family's rows only). */
export interface FamilyMetrics extends ProxyMetrics {
  family: string;
}

/**
 * Soul-7 admission evidence written to evidence/proxy-ba-<gitsha>.json.
 * Certificate only when source === 'extension-page-rendered'.
 */
export interface ProxyBaEvidence {
  section: '4.2';
  /** Product git SHA (short or full) used in the filename. */
  gitSha: string;
  /** Must be extension-page-rendered for the admission certificate. */
  source: 'extension-page-rendered' | 'cli-parity-inadmissible';
  /** A1 decision threshold (from src/threshold.ts). */
  threshold: number;
  formula: string;
  baMin: number;
  skipRateMax: number;
  attempted: number;
  scored: number;
  skips: number;
  skipRate: number;
  tp: number;
  tn: number;
  fp: number;
  fn: number;
  tpr: number;
  tnr: number;
  ba: number;
  pass: boolean;
  perFamily: FamilyMetrics[];
  /** ISO timestamp when the certificate was written. */
  writtenAt: string;
  /** Production ONNX sha when known (extension path). */
  modelSha256?: string | null;
  /** Optional note (e.g. mutant run). */
  note?: string;
}

/** Admission floor: BA >= 0.750. */
export const BA_MIN = 0.75;

/** Admission cap: skip-rate <= 0.10. */
export const SKIP_RATE_MAX = 0.1;

export const PROXY_BA_FORMULA =
  'attempted N; skip-rate=skips/N; BA=(TPR+TNR)/2 on scored only; pass iff BA>=0.750 and skip-rate<=0.10';

/**
 * A1 decision via src/label.ts (THRESHOLD only — never hardcode 0.65).
 */
export function decide(score: number): DecisionLabel {
  return labelFromScore(score);
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
  // When a class is absent (e.g. pure-real family slice), its rate is undefined.
  // Overall proxy always has both classes; family slices may not.
  const tpr = aiCount > 0 ? tp / aiCount : 0;
  const tnr = realCount > 0 ? tn / realCount : 0;
  let ba: number;
  if (aiCount > 0 && realCount > 0) {
    ba = (tpr + tnr) / 2;
  } else if (aiCount > 0) {
    ba = tpr;
  } else if (realCount > 0) {
    ba = tnr;
  } else {
    ba = 0;
  }
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

/**
 * Per-family metrics using the same formula on each family subset.
 * Families are sorted alphabetically for stable evidence JSON.
 */
export function computeFamilyMetrics(
  rows: readonly ScoredRow[],
): FamilyMetrics[] {
  const byFamily = new Map<string, ScoredRow[]>();
  for (const row of rows) {
    const fam = row.family && row.family.length > 0 ? row.family : 'unknown';
    const list = byFamily.get(fam);
    if (list) list.push(row);
    else byFamily.set(fam, [row]);
  }
  const families = Array.from(byFamily.keys()).sort();
  return families.map((family) => ({
    family,
    ...computeProxyMetrics(byFamily.get(family)!),
  }));
}

/**
 * Build the soul-7 evidence document (extension path only is admissible).
 */
export function buildProxyBaEvidence(opts: {
  gitSha: string;
  rows: readonly ScoredRow[];
  source: ProxyBaEvidence['source'];
  modelSha256?: string | null;
  note?: string;
  writtenAt?: string;
}): ProxyBaEvidence {
  const metrics = computeProxyMetrics(opts.rows);
  const perFamily = computeFamilyMetrics(opts.rows);
  return {
    section: '4.2',
    gitSha: opts.gitSha,
    source: opts.source,
    threshold: THRESHOLD,
    formula: PROXY_BA_FORMULA,
    baMin: BA_MIN,
    skipRateMax: SKIP_RATE_MAX,
    attempted: metrics.attempted,
    scored: metrics.scored,
    skips: metrics.skips,
    skipRate: metrics.skipRate,
    tp: metrics.tp,
    tn: metrics.tn,
    fp: metrics.fp,
    fn: metrics.fn,
    tpr: metrics.tpr,
    tnr: metrics.tnr,
    ba: metrics.ba,
    pass: metrics.pass,
    perFamily,
    writtenAt: opts.writtenAt ?? new Date().toISOString(),
    modelSha256: opts.modelSha256 ?? null,
    note: opts.note,
  };
}

/**
 * G-FALSE-GREEN-WITNESS: constant score 0.5 on every row must fail the gate.
 * Score 0.5 < THRESHOLD → always "real" → TPR=0, TNR=1, BA=0.5 when both classes present.
 */
export function constantModelWitnessRows(
  labels: readonly ProxyLabel[],
  score = 0.5,
): ScoredRow[] {
  return labels.map((label) => ({
    label,
    outcome: { kind: 'scored', score },
  }));
}

/** Evidence filename for a product git SHA (full or short). */
export function proxyBaEvidenceFilename(gitSha: string): string {
  const sha = gitSha.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(sha)) {
    throw new Error(`proxy-ba: invalid git sha for evidence name: ${gitSha}`);
  }
  return `proxy-ba-${sha}.json`;
}
