#!/usr/bin/env npx tsx
/**
 * CLI proxy / golden scorer — **parity only** (H5 / E9).
 *
 * Soul-7 admission certificate is produced exclusively by
 * `e2e/proxy-ba.spec.ts` (loaded extension, page-rendered images).
 * JSON written by this CLI is **inadmissible** as the proxy-ba certificate.
 *
 * Usage:
 *   npx tsx eval/eval_proxy.ts              # full frozen proxy (file path)
 *   npx tsx eval/eval_proxy.ts --goldens    # golden ten only
 *   npx tsx eval/eval_proxy.ts --out path   # write CLI JSON (inadmissible)
 *
 * Scoring path: sharp decode → src/preprocess.ts → onnxruntime (Python ORT
 * via the model venv, or constant-score mode for the mutant witness).
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import sharp from 'sharp';

import { preprocess, type RgbImage } from '../src/preprocess.js';
import { THRESHOLD } from '../src/threshold.js';
import {
  BA_MIN,
  SKIP_RATE_MAX,
  buildProxyBaEvidence,
  computeProxyMetrics,
  type ProxyLabel,
  type ScoredRow,
} from './scorer.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROXY_DIR = join(ROOT, 'eval', 'proxy');
const MANIFEST_PATH = join(PROXY_DIR, 'manifest.json');
const GOLDENS_README = join(ROOT, 'eval', 'goldens', 'README.md');

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

function parseArgs(argv: string[]): {
  goldens: boolean;
  out: string | null;
  constantScore: number | null;
  model: string | null;
  help: boolean;
} {
  let goldens = false;
  let out: string | null = null;
  let constantScore: number | null = null;
  let model: string | null = null;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--goldens') goldens = true;
    else if (a === '--help' || a === '-h') help = true;
    else if (a === '--out') {
      out = argv[++i] ?? null;
    } else if (a === '--constant-score') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v)) {
        throw new Error('--constant-score requires a number');
      }
      constantScore = v;
    } else if (a === '--model') {
      model = argv[++i] ?? null;
    } else if (a.startsWith('-')) {
      throw new Error(`unknown flag: ${a}`);
    }
  }
  return { goldens, out, constantScore, model, help };
}

function loadManifest(): Manifest {
  const raw = readFileSync(MANIFEST_PATH, 'utf8');
  const m = JSON.parse(raw) as Manifest;
  if (!Array.isArray(m.rows) || m.rows.length === 0) {
    throw new Error('proxy manifest empty (fail-closed)');
  }
  return m;
}

function goldenHashes(): Set<string> {
  const text = readFileSync(GOLDENS_README, 'utf8');
  const hashes = new Set<string>();
  for (const m of text.matchAll(/`([a-f0-9]{64})`/g)) {
    hashes.add(m[1]!);
  }
  if (hashes.size !== 10) {
    throw new Error(
      `expected 10 golden hashes in ${GOLDENS_README}, got ${hashes.size}`,
    );
  }
  return hashes;
}

function sha256File(abs: string): string {
  return createHash('sha256').update(readFileSync(abs)).digest('hex');
}

async function loadRgb(abs: string): Promise<RgbImage> {
  const { data, info } = await sharp(abs)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  if (channels < 3) {
    throw new Error(`decode: expected >=3 channels, got ${channels}`);
  }
  const rgb = new Uint8ClampedArray(width * height * 3);
  for (let i = 0, j = 0; i < width * height; i++, j += channels) {
    rgb[i * 3] = data[j]!;
    rgb[i * 3 + 1] = data[j + 1]!;
    rgb[i * 3 + 2] = data[j + 2]!;
  }
  return { width, height, data: rgb };
}

/**
 * Score one NCHW float32 tensor via Python onnxruntime (model venv).
 * Keeps the TS preprocess locked; Python only runs the session + sigmoid.
 */
function scoreWithPythonOrt(
  nchw: Float32Array,
  modelPath: string,
): { logit: number; score: number } {
  const pyCandidates = [
    join(ROOT, '.venv-model', 'bin', 'python'),
    'python3',
  ];
  let python: string | null = null;
  for (const c of pyCandidates) {
    if (c === 'python3' || existsSync(c)) {
      python = c;
      break;
    }
  }
  if (!python) {
    throw new Error('no python interpreter for ORT CLI parity');
  }

  // Write tensor to a temp-ish path under /tmp via stdin as base64 length prefix.
  const script = `
import sys, struct, numpy as np, onnxruntime as ort
model = sys.argv[1]
raw = sys.stdin.buffer.read()
n = struct.unpack("<I", raw[:4])[0]
arr = np.frombuffer(raw[4:4+n*4], dtype=np.float32).reshape(1,3,384,384)
sess = ort.InferenceSession(model, providers=["CPUExecutionProvider"])
inp = sess.get_inputs()[0].name
out = sess.run(None, {inp: arr})[0]
logit = float(np.asarray(out).reshape(-1)[0])
if logit >= 0:
    score = 1.0 / (1.0 + np.exp(-logit))
else:
    z = np.exp(logit)
    score = float(z / (1.0 + z))
print(f"{logit:.10f} {score:.10f}")
`;

  const payload = Buffer.alloc(4 + nchw.byteLength);
  payload.writeUInt32LE(nchw.length, 0);
  Buffer.from(nchw.buffer, nchw.byteOffset, nchw.byteLength).copy(payload, 4);

  const res = spawnSync(python, ['-c', script, modelPath], {
    input: payload,
    maxBuffer: 16 * 1024 * 1024,
    encoding: 'buffer',
  });
  if (res.status !== 0) {
    const err = (res.stderr ?? Buffer.alloc(0)).toString('utf8');
    throw new Error(`python ORT failed: ${err || `exit ${res.status}`}`);
  }
  const line = (res.stdout ?? Buffer.alloc(0)).toString('utf8').trim().split('\n').pop()!;
  const [ls, ss] = line.split(/\s+/);
  const logit = Number(ls);
  const score = Number(ss);
  if (!Number.isFinite(logit) || !Number.isFinite(score)) {
    throw new Error(`bad ORT output: ${line}`);
  }
  return { logit, score };
}

function resolveModelPath(cliModel: string | null): string {
  if (cliModel) {
    const abs = resolve(cliModel);
    if (!existsSync(abs)) throw new Error(`model not found: ${abs}`);
    return abs;
  }
  const candidates = [
    process.env['POIDH_ONNX_CACHE'],
    '/tmp/poidh-onnx-cache/model.onnx',
    join(ROOT, 'evidence', '.cache', 'model.onnx'),
    join(ROOT, 'weights', 'onnx', 'model-calib-4.1-fp32.onnx'),
  ].filter((p): p is string => Boolean(p));
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    'no ONNX model found (set POIDH_ONNX_CACHE or pass --model)',
  );
}

async function scoreRows(
  rows: ManifestRow[],
  opts: { constantScore: number | null; model: string | null },
): Promise<{ scored: ScoredRow[]; logits: Map<string, number> }> {
  const scored: ScoredRow[] = [];
  const logits = new Map<string, number>();
  const modelPath =
    opts.constantScore === null ? resolveModelPath(opts.model) : null;

  for (const row of rows) {
    const abs = join(PROXY_DIR, row.relpath);
    if (!existsSync(abs)) {
      scored.push({
        label: row.label,
        family: row.family,
        sha256: row.sha256,
        relpath: row.relpath,
        outcome: { kind: 'skip', reason: 'missing_file' },
      });
      continue;
    }
    const got = sha256File(abs);
    if (got !== row.sha256) {
      scored.push({
        label: row.label,
        family: row.family,
        sha256: row.sha256,
        relpath: row.relpath,
        outcome: { kind: 'skip', reason: 'sha_mismatch' },
      });
      continue;
    }

    try {
      if (opts.constantScore !== null) {
        scored.push({
          label: row.label,
          family: row.family,
          sha256: row.sha256,
          relpath: row.relpath,
          outcome: { kind: 'scored', score: opts.constantScore },
        });
        logits.set(row.sha256, 0);
        continue;
      }

      const rgb = await loadRgb(abs);
      const nchw = preprocess(rgb);
      const { logit, score } = scoreWithPythonOrt(nchw, modelPath!);
      logits.set(row.sha256, logit);
      scored.push({
        label: row.label,
        family: row.family,
        sha256: row.sha256,
        relpath: row.relpath,
        outcome: { kind: 'scored', score },
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      scored.push({
        label: row.label,
        family: row.family,
        sha256: row.sha256,
        relpath: row.relpath,
        outcome: { kind: 'skip', reason: `cli_error:${detail.slice(0, 80)}` },
      });
    }
  }

  return { scored, logits };
}

function gitSha(): string {
  const res = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (res.status === 0 && res.stdout.trim()) {
    return res.stdout.trim();
  }
  return 'unknown';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      [
        'eval/eval_proxy.ts — CLI proxy scorer (parity only; inadmissible)',
        '',
        '  --goldens           score golden ten only',
        '  --out <path>        write CLI JSON (inadmissible as soul-7 cert)',
        '  --model <path>      ONNX model path',
        '  --constant-score N  G-FALSE-GREEN witness (no ORT)',
        '',
      ].join('\n'),
    );
    return;
  }

  const manifest = loadManifest();
  let rows = manifest.rows;
  if (args.goldens) {
    const want = goldenHashes();
    rows = manifest.rows.filter((r) => want.has(r.sha256));
    if (rows.length !== 10) {
      throw new Error(`golden filter matched ${rows.length}, expected 10`);
    }
  }

  process.stderr.write(
    `eval_proxy: scoring ${rows.length} rows` +
      (args.constantScore !== null
        ? ` (constant-score=${args.constantScore})`
        : '') +
      ' [CLI parity — inadmissible]\n',
  );

  const { scored, logits } = await scoreRows(rows, {
    constantScore: args.constantScore,
    model: args.model,
  });
  const metrics = computeProxyMetrics(scored);
  const evidence = buildProxyBaEvidence({
    gitSha: gitSha(),
    rows: scored,
    source: 'cli-parity-inadmissible',
    note:
      args.constantScore !== null
        ? `constant-score=${args.constantScore} (G-FALSE-GREEN-WITNESS path)`
        : args.goldens
          ? 'golden ten CLI parity (H5)'
          : 'full proxy CLI walk (inadmissible)',
  });

  const summary = {
    admissible: false as const,
    source: 'cli-parity-inadmissible' as const,
    threshold: THRESHOLD,
    baMin: BA_MIN,
    skipRateMax: SKIP_RATE_MAX,
    metrics,
    evidence,
    goldens: args.goldens
      ? scored.map((r) => ({
          sha256: r.sha256,
          label: r.label,
          family: r.family,
          relpath: r.relpath,
          outcome: r.outcome,
          logit: r.sha256 ? (logits.get(r.sha256) ?? null) : null,
        }))
      : undefined,
  };

  process.stdout.write(
    JSON.stringify(
      {
        pass: metrics.pass,
        ba: metrics.ba,
        tpr: metrics.tpr,
        tnr: metrics.tnr,
        skipRate: metrics.skipRate,
        attempted: metrics.attempted,
        scored: metrics.scored,
        skips: metrics.skips,
        admissible: false,
        source: 'cli-parity-inadmissible',
      },
      null,
      2,
    ) + '\n',
  );

  if (args.out) {
    const outPath = resolve(args.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
    process.stderr.write(
      `eval_proxy: wrote inadmissible CLI JSON ${outPath}\n`,
    );
  }

  // CLI never exits 0 on gate pass as a certificate — but exit code reflects
  // metrics for local iteration. Mutant constant-score must exit non-zero.
  if (args.constantScore !== null) {
    if (metrics.pass) {
      process.stderr.write(
        'eval_proxy: FAIL G-FALSE-GREEN — constant model unexpectedly passed\n',
      );
      process.exit(2);
    }
    process.stderr.write(
      'eval_proxy: OK G-FALSE-GREEN — constant model failed gate as required\n',
    );
    process.exit(0);
  }

  process.exit(metrics.pass ? 0 : 1);
}

main().catch((err: unknown) => {
  const detail = err instanceof Error ? err.message : String(err);
  process.stderr.write(`eval_proxy: ${detail}\n`);
  process.exit(1);
});
