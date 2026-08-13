#!/usr/bin/env bash
# Stage 40: anticheat / release zip-grep (section 5.1 / soul 9 JOB-ANTICHEAT-01).
# Proves dist/ has no proxy/golden bench hashes or scores lookup; empty cache at install.
# Claim suite: retries 0. One-shot, non-interactive. Does not print env secrets.
set -euo pipefail
cd "$(dirname "$0")/../.."

ROOT="$(pwd)"
EVIDENCE_DIR="${ROOT}/evidence"
mkdir -p "${EVIDENCE_DIR}"

echo "40-anticheat: build dist/"
bash "${ROOT}/scripts/gate-build.sh"

export CI="${CI:-1}"
echo "40-anticheat: playwright e2e/anticheat.spec.ts (retries=0)"
if command -v xvfb-run >/dev/null 2>&1; then
  xvfb-run -a npx playwright test e2e/anticheat.spec.ts --retries=0
else
  npx playwright test e2e/anticheat.spec.ts --retries=0
fi

echo "40-anticheat: OK"
