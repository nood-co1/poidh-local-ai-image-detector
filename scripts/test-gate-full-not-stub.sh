#!/usr/bin/env bash
# E9 named test (AC-STAGE): gate-full.sh must not regress to a stub.
# Fails if gate-full.sh is missing, non-executable, empty, or only `exit 0`.
# Also self-checks negative fixtures so the ratchet property cannot silently rot.
# One-shot, non-interactive. Does not print env secrets.
set -euo pipefail
cd "$(dirname "$0")/.."

# Returns 0 if path is a real non-stub gate-full script; 1 otherwise.
# Prints a FAIL reason on stderr when rejecting.
assert_not_stub() {
  local path="$1"
  local label="${2:-$path}"

  if [[ ! -e "${path}" ]]; then
    echo "FAIL: ${label} is missing" >&2
    return 1
  fi
  if [[ ! -f "${path}" ]]; then
    echo "FAIL: ${label} is not a regular file" >&2
    return 1
  fi
  if [[ ! -x "${path}" ]]; then
    echo "FAIL: ${label} is not executable" >&2
    return 1
  fi
  if [[ ! -s "${path}" ]]; then
    echo "FAIL: ${label} is empty" >&2
    return 1
  fi

  # Meaningful lines: strip blank and comment-only lines.
  local body
  body="$(grep -vE '^\s*(#|$)' "${path}" || true)"
  if [[ -z "${body//[[:space:]]/}" ]]; then
    echo "FAIL: ${label} has no non-comment content" >&2
    return 1
  fi

  # exit-0-only stub: every meaningful line is `exit 0` (optional trailing ;).
  if ! grep -qvE '^\s*exit\s+0\s*;?\s*$' <<<"${body}"; then
    echo "FAIL: ${label} is only \`exit 0\` (stub)" >&2
    return 1
  fi

  return 0
}

expect_fail() {
  local label="$1"
  shift
  set +e
  "$@" 2>/dev/null
  local rc=$?
  set -e
  if [[ ${rc} -eq 0 ]]; then
    echo "FAIL: expected ${label} to be rejected, but assert_not_stub passed" >&2
    exit 1
  fi
}

# --- negative fixtures: prove the ratchet fails closed ---
tmpdir="$(mktemp -d)"
trap 'rm -rf "${tmpdir}"' EXIT

# missing
expect_fail "missing fixture" assert_not_stub "${tmpdir}/does-not-exist.sh" "missing fixture"

# empty (executable)
: >"${tmpdir}/empty.sh"
chmod +x "${tmpdir}/empty.sh"
expect_fail "empty fixture" assert_not_stub "${tmpdir}/empty.sh" "empty fixture"

# non-executable (non-empty, real body)
printf '%s\n' '#!/usr/bin/env bash' 'echo real-work' >"${tmpdir}/noexec.sh"
chmod a-x "${tmpdir}/noexec.sh"
expect_fail "non-executable fixture" assert_not_stub "${tmpdir}/noexec.sh" "non-executable fixture"

# exit-0-only stub (shebang + comment + exit 0)
printf '%s\n' '#!/usr/bin/env bash' '# stub full-ci' 'exit 0' >"${tmpdir}/stub.sh"
chmod +x "${tmpdir}/stub.sh"
expect_fail "exit-0-only fixture" assert_not_stub "${tmpdir}/stub.sh" "exit-0-only fixture"

# multi-line exit-0-only
printf '%s\n' 'exit 0' 'exit 0;' >"${tmpdir}/stub2.sh"
chmod +x "${tmpdir}/stub2.sh"
expect_fail "multi exit-0 fixture" assert_not_stub "${tmpdir}/stub2.sh" "multi exit-0 fixture"

# --- positive: the real gate-full.sh must pass ---
assert_not_stub "scripts/gate-full.sh" "scripts/gate-full.sh"

echo "test-gate-full-not-stub: OK (gate-full.sh is real; stubs rejected)"
