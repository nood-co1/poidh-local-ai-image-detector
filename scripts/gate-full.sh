#!/usr/bin/env bash
# Full CI gate (E5): typecheck + staged hooks under scripts/gate-full.d/.
# Later sections append 20-e2e.sh / 30-proxy-ba.sh here — never rewrite this file.
# NOT a stub: never "exit 0" without running required steps.
# One-shot, non-interactive. Does not print env secrets.
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT="$(pwd)"
HOOK_DIR="${ROOT}/scripts/gate-full.d"

echo "gate-full: typecheck"
bash "${ROOT}/scripts/gate-typecheck.sh"

if [[ ! -d "${HOOK_DIR}" ]]; then
  echo "gate-full: missing ${HOOK_DIR}" >&2
  exit 1
fi

shopt -s nullglob
hooks=("${HOOK_DIR}"/*.sh)
shopt -u nullglob

if [[ ${#hooks[@]} -eq 0 ]]; then
  echo "gate-full: no hooks in ${HOOK_DIR} (expected at least 10-unit.sh)" >&2
  exit 1
fi

# Sort by filename so 10-unit runs before 20-e2e / 30-proxy-ba.
IFS=$'\n' sorted=($(printf '%s\n' "${hooks[@]}" | sort))
unset IFS

failed=0
for hook in "${sorted[@]}"; do
  echo "gate-full: run $(basename "${hook}")"
  set +e
  bash "${hook}"
  rc=$?
  set -e
  if [[ ${rc} -ne 0 ]]; then
    echo "gate-full: FAILED $(basename "${hook}") (exit ${rc})" >&2
    failed=1
    # Fail closed: do not continue past a registered failure (no silent skip).
    break
  fi
done

if [[ ${failed} -ne 0 ]]; then
  echo "gate-full: FAILED" >&2
  exit 1
fi

echo "gate-full: OK"
