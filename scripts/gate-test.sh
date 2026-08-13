#!/usr/bin/env bash
# One-shot test gate (E5): unit + eslint + docs-consistency.
# No watch mode. No interactive prompts. Does not print env secrets.
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT="$(pwd)"
EVIDENCE_DIR="${ROOT}/evidence"
mkdir -p "${EVIDENCE_DIR}"

unit_passed=0
unit_failed=0
eslint_ok=0
docs_ok=0
status="pass"

# --- unit tests (threshold + future co-located *.test.ts) ---
# vitest run is one-shot; never `vitest` / `vitest watch`.
set +e
unit_out="$(npx vitest run --reporter=json --outputFile="${EVIDENCE_DIR}/.vitest-raw.json" 2>&1)"
unit_rc=$?
set -e

if [[ -f "${EVIDENCE_DIR}/.vitest-raw.json" ]]; then
  # Extract counts from vitest JSON reporter when available.
  counts="$(node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const p = process.argv[1];
    try {
      const j = JSON.parse(readFileSync(p, "utf8"));
      const t = j.numTotalTests ?? j.testResults?.reduce((a, r) => a + (r.assertionResults?.length ?? 0), 0) ?? 0;
      const f = j.numFailedTests ?? j.testResults?.reduce((a, r) => a + (r.assertionResults?.filter(x => x.status === "failed").length ?? 0), 0) ?? 0;
      const pss = j.numPassedTests ?? (t - f);
      process.stdout.write(String(pss) + " " + String(f));
    } catch {
      process.stdout.write("0 1");
    }
  ' "${EVIDENCE_DIR}/.vitest-raw.json")"
  unit_passed="${counts%% *}"
  unit_failed="${counts##* }"
  rm -f "${EVIDENCE_DIR}/.vitest-raw.json"
else
  if [[ ${unit_rc} -eq 0 ]]; then
    unit_passed=1
    unit_failed=0
  else
    unit_passed=0
    unit_failed=1
  fi
fi

if [[ ${unit_rc} -ne 0 ]]; then
  echo "${unit_out}" >&2
  status="fail"
fi

# --- eslint (config committed; no first-run prompt) ---
set +e
eslint_out="$(npx eslint . 2>&1)"
eslint_rc=$?
set -e
if [[ ${eslint_rc} -eq 0 ]]; then
  eslint_ok=1
else
  echo "${eslint_out}" >&2
  eslint_ok=0
  status="fail"
fi

# --- docs-consistency (souls leak / LICENSE / README) ---
set +e
docs_out="$(node scripts/check-docs-consistency.mjs 2>&1)"
docs_rc=$?
set -e
if [[ ${docs_rc} -eq 0 ]]; then
  docs_ok=1
else
  echo "${docs_out}" >&2
  docs_ok=0
  status="fail"
fi

# --- evidence JSON (counts only; never dump env) ---
node --input-type=module -e '
  import { writeFileSync } from "node:fs";
  const [out, status, unitPassed, unitFailed, eslintOk, docsOk] = process.argv.slice(1);
  const payload = {
    section: "1.2",
    gate: "gate:test",
    status,
    generatedAt: new Date().toISOString(),
    counts: {
      unitPassed: Number(unitPassed),
      unitFailed: Number(unitFailed),
      unitTotal: Number(unitPassed) + Number(unitFailed),
      eslintOk: Number(eslintOk),
      docsConsistencyOk: Number(docsOk),
    },
  };
  writeFileSync(out, JSON.stringify(payload, null, 2) + "\n", "utf8");
' "${EVIDENCE_DIR}/gate-test.json" "${status}" "${unit_passed}" "${unit_failed}" "${eslint_ok}" "${docs_ok}"

echo "gate-test: status=${status} unit_passed=${unit_passed} unit_failed=${unit_failed} eslint_ok=${eslint_ok} docs_ok=${docs_ok}"
echo "gate-test: wrote ${EVIDENCE_DIR}/gate-test.json"

if [[ "${status}" != "pass" ]]; then
  exit 1
fi
