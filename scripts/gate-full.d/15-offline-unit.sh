#!/usr/bin/env bash
# Stage 15: offline e2e proof (section 2.3 / soul 3).
# Claim suite: retries 0, real ORT session, no mocked infer().
# One-shot, non-interactive. Does not print env secrets.
set -euo pipefail
cd "$(dirname "$0")/../.."

ROOT="$(pwd)"
EVIDENCE_DIR="${ROOT}/evidence"
mkdir -p "${EVIDENCE_DIR}"

echo "15-offline: build dist/"
bash "${ROOT}/scripts/gate-build.sh"

# Prefer a SHA-pinned local ONNX cache so the suite does not re-download 87MB.
ONNX_CACHE="${POIDH_ONNX_CACHE:-/tmp/poidh-onnx-cache/model.onnx}"
EXPECTED_SHA="a42c7d740fbb345ba9a26d469b22f301d73089ce3c6da993877ed2b6965a8ba1"
if [[ ! -f "${ONNX_CACHE}" ]]; then
  echo "15-offline: caching production ONNX to ${ONNX_CACHE}"
  mkdir -p "$(dirname "${ONNX_CACHE}")"
  curl -fsSL --max-time 600 \
    -o "${ONNX_CACHE}" \
    "https://huggingface.co/buildborderless/CommunityForensics-DeepfakeDet-ViT/resolve/ac6ee457bea904a373065754107451793b56db00/onnx/model.onnx"
fi
got_sha="$(sha256sum "${ONNX_CACHE}" | awk '{print $1}')"
if [[ "${got_sha}" != "${EXPECTED_SHA}" ]]; then
  echo "15-offline: FAIL — ONNX SHA ${got_sha} != ${EXPECTED_SHA}" >&2
  exit 1
fi
export POIDH_ONNX_CACHE="${ONNX_CACHE}"

# Playwright chromium (extensions need full chromium under a display).
export CI="${CI:-1}"
echo "15-offline: playwright e2e/offline.spec.ts (retries=0)"
if command -v xvfb-run >/dev/null 2>&1; then
  xvfb-run -a npx playwright test e2e/offline.spec.ts --retries=0
else
  npx playwright test e2e/offline.spec.ts --retries=0
fi

echo "15-offline: OK"
