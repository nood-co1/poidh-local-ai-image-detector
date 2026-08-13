#!/usr/bin/env bash
# One-shot typecheck (E5). No watch. No interactive prompts.
set -euo pipefail
cd "$(dirname "$0")/.."

npx tsc --noEmit
