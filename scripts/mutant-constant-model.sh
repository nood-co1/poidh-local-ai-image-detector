#!/usr/bin/env bash
# G-FALSE-GREEN-WITNESS (section 4.2 / soul 7).
#
# Swapping in a constant-0.5 score model must **fail** the proxy BA gate.
# Score 0.5 < THRESHOLD (0.65) → always "real" → BA = 0.5 when both classes
# are present → pass=false. If this script exits 0 after a green gate, the
# formula is broken (false green).
#
# Does not rewrite proxy labels. Does not produce an admissible certificate.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "mutant-constant-model: constant-0.5 must fail BA gate (G-FALSE-GREEN-WITNESS)"

# Path A: pure formula witness via eval_proxy constant-score (no ORT needed).
set +e
out="$(npx tsx eval/eval_proxy.ts --constant-score 0.5 --goldens 2>&1)"
rc=$?
set -e

echo "${out}"

if [[ ${rc} -ne 0 ]]; then
  # eval_proxy exits 0 when the constant model correctly fails the gate;
  # non-zero means the witness itself broke (or unexpectedly passed → exit 2).
  echo "mutant-constant-model: FAIL — constant-score path rc=${rc}" >&2
  exit 1
fi

# Path B: unit-level witness (vitest G-FALSE-GREEN-WITNESS).
set +e
unit_out="$(npx vitest run eval/scorer.test.ts -t 'G-FALSE-GREEN' 2>&1)"
unit_rc=$?
set -e
if [[ ${unit_rc} -ne 0 ]]; then
  echo "${unit_out}" >&2
  echo "mutant-constant-model: FAIL — unit witness" >&2
  exit 1
fi

# Sanity: BA of constant-0.5 on balanced labels must be < 0.75.
npx tsx --eval '
import { constantModelWitnessRows, computeProxyMetrics, BA_MIN } from "./eval/scorer.ts";
const labels = Array.from({ length: 100 }, (_, i) => (i < 50 ? "ai" as const : "real" as const));
const m = computeProxyMetrics(constantModelWitnessRows(labels, 0.5));
if (m.pass || m.ba >= BA_MIN) {
  console.error("false green: constant-0.5 passed", m);
  process.exit(1);
}
console.log(JSON.stringify({ ba: m.ba, pass: m.pass, tpr: m.tpr, tnr: m.tnr }));
'

echo "mutant-constant-model: OK (constant-0.5 fails gate)"
