#!/usr/bin/env bash
# One-shot extension build: src/* + extension/* → dist/ (JS Chrome can load).
# No watch mode. No interactive prompts. Does not print env secrets.
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT="$(pwd)"
DIST="${ROOT}/dist"

rm -rf "${DIST}"
mkdir -p "${DIST}"

# Compile TypeScript entry points to JS (Chrome cannot load raw .ts).
npx esbuild \
  extension/service_worker.ts \
  --bundle \
  --format=esm \
  --platform=browser \
  --target=chrome120 \
  --outfile="${DIST}/service_worker.js"

# Copy static extension assets unchanged.
cp extension/manifest.json "${DIST}/manifest.json"
cp extension/popup.html "${DIST}/popup.html"
cp extension/popup.js "${DIST}/popup.js"

# Ensure required outputs exist (fail closed).
test -f "${DIST}/manifest.json"
test -f "${DIST}/service_worker.js"
test -f "${DIST}/popup.html"
test -f "${DIST}/popup.js"

echo "gate-build: wrote loadable package under dist/"
