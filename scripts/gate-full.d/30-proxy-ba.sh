#!/usr/bin/env bash
# Stage 30: soul-7 proxy BA gate (section 4.2 / JOB-PROXY-01).
#
# Drives the **loaded extension** over **page-rendered** images for every
# row in eval/proxy/manifest.json. Writes evidence/proxy-ba-<gitsha>.json.
# CLI-only JSON is inadmissible. Phase audit cannot override a fail.
#
# Also runs G-FALSE-GREEN-WITNESS (constant-0.5 model must fail).
set -euo pipefail
cd "$(dirname "$0")/../.."

ROOT="$(pwd)"
EVIDENCE_DIR="${ROOT}/evidence"
mkdir -p "${EVIDENCE_DIR}"

echo "30-proxy-ba: build dist/"
bash "${ROOT}/scripts/gate-build.sh"

# Prefer a SHA-pinned local ONNX cache so the suite does not re-download 87MB.
ONNX_CACHE="${POIDH_ONNX_CACHE:-/tmp/poidh-onnx-cache/model.onnx}"
EXPECTED_SHA="a42c7d740fbb345ba9a26d469b22f301d73089ce3c6da993877ed2b6965a8ba1"
if [[ ! -f "${ONNX_CACHE}" ]]; then
  echo "30-proxy-ba: caching production ONNX to ${ONNX_CACHE}"
  mkdir -p "$(dirname "${ONNX_CACHE}")"
  curl -fsSL --max-time 600 \
    -o "${ONNX_CACHE}" \
    "https://huggingface.co/buildborderless/CommunityForensics-DeepfakeDet-ViT/resolve/ac6ee457bea904a373065754107451793b56db00/onnx/model.onnx"
fi
got_sha="$(sha256sum "${ONNX_CACHE}" | awk '{print $1}')"
if [[ "${got_sha}" != "${EXPECTED_SHA}" ]]; then
  echo "30-proxy-ba: FAIL — ONNX SHA ${got_sha} != ${EXPECTED_SHA}" >&2
  exit 1
fi
export POIDH_ONNX_CACHE="${ONNX_CACHE}"

echo "30-proxy-ba: G-FALSE-GREEN-WITNESS (constant-0.5 must fail)"
bash "${ROOT}/scripts/mutant-constant-model.sh"

export CI="${CI:-1}"
GIT_SHA="$(git rev-parse HEAD)"
export POIDH_GIT_SHA="${GIT_SHA}"
echo "30-proxy-ba: playwright e2e/proxy-ba.spec.ts (retries=0) sha=${GIT_SHA}"

# Full proxy over extension WASM can take several minutes.
if command -v xvfb-run >/dev/null 2>&1; then
  xvfb-run -a npx playwright test e2e/proxy-ba.spec.ts --retries=0
else
  npx playwright test e2e/proxy-ba.spec.ts --retries=0
fi

# AC-SHA: evidence file must exist for this product git sha.
EVIDENCE_FILE="${EVIDENCE_DIR}/proxy-ba-${GIT_SHA}.json"
if [[ ! -f "${EVIDENCE_FILE}" ]]; then
  echo "30-proxy-ba: FAIL — missing ${EVIDENCE_FILE}" >&2
  exit 1
fi

# Fail-closed: pass must be true, BA>=0.75, skip<=0.10, source=extension.
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const p = process.argv[1];
  const j = JSON.parse(readFileSync(p, "utf8"));
  const fail = (m) => { console.error("30-proxy-ba: FAIL —", m); process.exit(1); };
  if (j.source !== "extension-page-rendered") fail("source must be extension-page-rendered (CLI inadmissible)");
  if (j.section !== "4.2") fail("section != 4.2");
  if (j.pass !== true) fail(`pass!=true ba=${j.ba} skip=${j.skipRate}`);
  if (typeof j.ba !== "number" || j.ba < 0.75) fail(`BA ${j.ba} < 0.75`);
  if (typeof j.skipRate !== "number" || j.skipRate > 0.10) fail(`skipRate ${j.skipRate} > 0.10`);
  if (typeof j.attempted !== "number" || j.attempted < 200) fail(`attempted ${j.attempted} < 200`);
  if (!Array.isArray(j.perFamily) || j.perFamily.length < 1) fail("missing perFamily");
  console.log(JSON.stringify({
    ok: true,
    ba: j.ba,
    tpr: j.tpr,
    tnr: j.tnr,
    skipRate: j.skipRate,
    attempted: j.attempted,
    gitSha: j.gitSha,
  }));
' "${EVIDENCE_FILE}"

echo "30-proxy-ba: OK (${EVIDENCE_FILE})"
