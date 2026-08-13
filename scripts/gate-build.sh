#!/usr/bin/env bash
# One-shot extension build: src/* + extension/* → dist/ (JS Chrome can load).
# No watch mode. No interactive prompts. Does not print env secrets.
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT="$(pwd)"
DIST="${ROOT}/dist"
ORT_DIST="${ROOT}/node_modules/onnxruntime-web/dist"

rm -rf "${DIST}"
mkdir -p "${DIST}/wasm"

# Service worker (message router + offscreen createDocument).
npx esbuild \
  extension/service_worker.ts \
  --bundle \
  --format=esm \
  --platform=browser \
  --target=chrome120 \
  --outfile="${DIST}/service_worker.js"

# Offscreen document: ORT-web + locked preprocess/infer.
# Use extern-wasm condition so wasm binaries load from extension URLs (E1 / 2.1).
npx esbuild \
  extension/offscreen.ts \
  --bundle \
  --format=esm \
  --platform=browser \
  --target=chrome120 \
  --conditions=onnxruntime-web-use-extern-wasm \
  --outfile="${DIST}/offscreen.js"

# Copy static extension assets unchanged.
cp extension/manifest.json "${DIST}/manifest.json"
cp extension/popup.html "${DIST}/popup.html"
cp extension/popup.js "${DIST}/popup.js"
cp extension/offscreen.html "${DIST}/offscreen.html"

# ORT wasm/simd binaries (paths configured via ort.env.wasm.wasmPaths in offscreen).
if [[ -d "${ORT_DIST}" ]]; then
  cp "${ORT_DIST}/ort-wasm-simd-threaded.wasm" "${DIST}/wasm/" 2>/dev/null || true
  cp "${ORT_DIST}/ort-wasm-simd-threaded.mjs" "${DIST}/wasm/" 2>/dev/null || true
  cp "${ORT_DIST}/ort-wasm-simd-threaded.jsep.wasm" "${DIST}/wasm/" 2>/dev/null || true
  cp "${ORT_DIST}/ort-wasm-simd-threaded.jsep.mjs" "${DIST}/wasm/" 2>/dev/null || true
  cp "${ORT_DIST}/ort-wasm-simd-threaded.asyncify.wasm" "${DIST}/wasm/" 2>/dev/null || true
  cp "${ORT_DIST}/ort-wasm-simd-threaded.asyncify.mjs" "${DIST}/wasm/" 2>/dev/null || true
  cp "${ORT_DIST}/ort-wasm-simd-threaded.jspi.wasm" "${DIST}/wasm/" 2>/dev/null || true
  cp "${ORT_DIST}/ort-wasm-simd-threaded.jspi.mjs" "${DIST}/wasm/" 2>/dev/null || true
fi

# Ensure required outputs exist (fail closed).
test -f "${DIST}/manifest.json"
test -f "${DIST}/service_worker.js"
test -f "${DIST}/popup.html"
test -f "${DIST}/popup.js"
test -f "${DIST}/offscreen.html"
test -f "${DIST}/offscreen.js"

# AC-CSP: wasm-unsafe-eval must be present for ORT wasm.
grep -q "wasm-unsafe-eval" "${DIST}/manifest.json"

# AC-EP: offscreen permission present.
grep -q '"offscreen"' "${DIST}/manifest.json"

echo "gate-build: wrote loadable package under dist/"
