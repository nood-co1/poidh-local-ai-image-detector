#!/usr/bin/env bash
# Live smoke journey (GATE_LIVE_SMOKE_CMD / section 3.3 AC-JOURNEY).
# One-shot, non-interactive. Does not print env secrets.
#
# JOB-SCAN   — autoscan same-origin + cross-origin (+ threshold/pause already in 20-e2e)
# JOB-OFFLINE — offline inference proof
# JOB-PRIVACY — service-worker-inclusive privacy HAR allowlist
#
# Later sections (4.3 keystone) may append steps; do not rewrite as a stub.
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT="$(pwd)"
EVIDENCE_DIR="${ROOT}/evidence"
mkdir -p "${EVIDENCE_DIR}"

echo "gate-journey: build dist/"
bash "${ROOT}/scripts/gate-build.sh"

# Prefer a SHA-pinned local ONNX cache so the suite does not re-download 87MB.
ONNX_CACHE="${POIDH_ONNX_CACHE:-/tmp/poidh-onnx-cache/model.onnx}"
EXPECTED_SHA="a42c7d740fbb345ba9a26d469b22f301d73089ce3c6da993877ed2b6965a8ba1"
if [[ ! -f "${ONNX_CACHE}" ]]; then
  echo "gate-journey: caching production ONNX to ${ONNX_CACHE}"
  mkdir -p "$(dirname "${ONNX_CACHE}")"
  curl -fsSL --max-time 600 \
    -o "${ONNX_CACHE}" \
    "https://huggingface.co/buildborderless/CommunityForensics-DeepfakeDet-ViT/resolve/ac6ee457bea904a373065754107451793b56db00/onnx/model.onnx"
fi
got_sha="$(sha256sum "${ONNX_CACHE}" | awk '{print $1}')"
if [[ "${got_sha}" != "${EXPECTED_SHA}" ]]; then
  echo "gate-journey: FAIL — ONNX SHA ${got_sha} != ${EXPECTED_SHA}" >&2
  exit 1
fi
export POIDH_ONNX_CACHE="${ONNX_CACHE}"
export CI="${CI:-1}"

run_pw() {
  local label="$1"
  shift
  echo "gate-journey: ${label}"
  if command -v xvfb-run >/dev/null 2>&1; then
    xvfb-run -a npx playwright test "$@" --retries=0
  else
    npx playwright test "$@" --retries=0
  fi
}

# JOB-OFFLINE-01 (soul 3)
run_pw "JOB-OFFLINE (e2e/offline.spec.ts)" e2e/offline.spec.ts

# JOB-SCAN-01 (soul 4) + score/pause (soul 5) for a continuous page journey
run_pw "JOB-SCAN (autoscan + threshold + pause)" \
  e2e/autoscan-sameorigin.spec.ts \
  e2e/autoscan-crossorigin.spec.ts \
  e2e/threshold.spec.ts \
  e2e/pause-reentry.spec.ts

# JOB-PRIVACY-01 (soul 6)
run_pw "JOB-PRIVACY (e2e/privacy-har.spec.ts)" e2e/privacy-har.spec.ts

echo "gate-journey: OK (JOB-OFFLINE + JOB-SCAN + JOB-PRIVACY)"
