#!/usr/bin/env bash
# Stage 10: unit + lint + docs-consistency (gate:test).
# Later stages (20-e2e, 30-proxy-ba) are appended by 3.x / 4.2 — do not invent them here.
set -euo pipefail
cd "$(dirname "$0")/../.."

bash scripts/gate-test.sh
