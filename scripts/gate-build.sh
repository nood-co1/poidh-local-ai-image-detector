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

# Content script: displayed-pixel scan path (2.3; overlay + label in 3.1/3.2).
npx esbuild \
  extension/content.ts \
  --bundle \
  --format=iife \
  --platform=browser \
  --target=chrome120 \
  --outfile="${DIST}/content.js"

# Popup: setup + pause + threshold rule (bundles src/label.ts for A1 text).
npx esbuild \
  extension/popup.js \
  --bundle \
  --format=esm \
  --platform=browser \
  --target=chrome120 \
  --outfile="${DIST}/popup.js"

# Copy static extension assets unchanged.
cp extension/manifest.json "${DIST}/manifest.json"
cp extension/popup.html "${DIST}/popup.html"
cp extension/offscreen.html "${DIST}/offscreen.html"
cp extension/debug.html "${DIST}/debug.html"
cp extension/debug.js "${DIST}/debug.js"
cp extension/harness.html "${DIST}/harness.html"

# Fixture images for debug.html (test only) + same-origin extension packaging.
mkdir -p "${DIST}/fixtures/assets"
cp eval/fixtures/assets/*.png "${DIST}/fixtures/assets/"

# Pinned artifact manifest + vendored CF config (num_labels=1 assert).
mkdir -p "${DIST}/weights"
cp weights/manifest.json "${DIST}/weights/manifest.json"
cp weights/config.json "${DIST}/weights/config.json"

# ORT wasm/simd binaries (paths configured via ort.env.wasm.wasmPaths in offscreen).
# First-run setup copies these into OPFS/Cache after SHA verify (section 2.2).
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
test -f "${DIST}/content.js"
test -f "${DIST}/debug.html"
test -f "${DIST}/debug.js"
test -f "${DIST}/harness.html"
test -f "${DIST}/weights/manifest.json"
test -f "${DIST}/fixtures/assets/real_a.png"

# AC-CSP: wasm-unsafe-eval must be present for ORT wasm.
grep -q "wasm-unsafe-eval" "${DIST}/manifest.json"

# AC-EP: offscreen permission present.
grep -q '"offscreen"' "${DIST}/manifest.json"

# AC-ALL: wasm listed in weights manifest.
grep -q 'ort-wasm-simd' "${DIST}/weights/manifest.json"

echo "gate-build: wrote loadable package under dist/"
