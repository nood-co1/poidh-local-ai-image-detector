#!/usr/bin/env bash
# Stage 05: credential / token pattern scan (section 5.1 / AC-SEC).
# One-shot, non-interactive. Does not print env secrets.
set -euo pipefail
cd "$(dirname "$0")/../.."

bash scripts/check-secrets.sh
