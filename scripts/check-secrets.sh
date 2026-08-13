#!/usr/bin/env bash
# Spec 5.1 / AC-SEC — fail-closed scan for credential values in the product tree.
# Does not print matched secret material (only path + pattern name).
# One-shot, non-interactive.
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT="$(pwd)"
failed=0

# Paths never scanned (deps, build output, venvs, binary caches).
PRUNE=(
  -path "${ROOT}/node_modules" -o
  -path "${ROOT}/.git" -o
  -path "${ROOT}/dist" -o
  -path "${ROOT}/.venv" -o
  -path "${ROOT}/.venv-model" -o
  -path "${ROOT}/.venv-proxy" -o
  -path "${ROOT}/test-results" -o
  -path "${ROOT}/playwright-report" -o
  -path "${ROOT}/.pipeline" -o
  -path "${ROOT}/evidence/.cache" -o
  -path "${ROOT}/evidence/.pw-profile-*" -o
  -name ".venv*" -o
  -name "*.wasm" -o
  -name "*.onnx" -o
  -name "*.png" -o
  -name "*.jpg" -o
  -name "*.jpeg" -o
  -name "*.webp" -o
  -name "package-lock.json"
)

# name|regex  — scanned with grep -EIn (text files only).
# Patterns target credential *values*, not documentation of the scan itself.
PATTERNS=(
  'github_pat|github_pat_[A-Za-z0-9_]{20,}'
  'gh_token|gh[pousr]_[A-Za-z0-9_]{36,}'
  'openai_sk|sk-[A-Za-z0-9]{20,}'
  'aws_access_key|AKIA[0-9A-Z]{16}'
  'aws_secret|aws_secret_access_key[[:space:]]*=[[:space:]]*['\''"][A-Za-z0-9/+=]{20,}'
  'private_key_pem|-----BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----'
  'slack_token|xox[baprs]-[A-Za-z0-9-]{10,}'
  'google_api_key|AIza[0-9A-Za-z_-]{20,}'
  'stripe_live|sk_live_[A-Za-z0-9]{16,}'
  'stripe_test|rk_live_[A-Za-z0-9]{16,}'
  'generic_bearer|Bearer [A-Za-z0-9._\\-]{32,}'
  'npm_token|npm_[A-Za-z0-9]{36,}'
  'huggingface_token|hf_[A-Za-z0-9]{20,}'
)

# Also refuse tracked secret filenames if they sneak past .gitignore.
SECRET_NAMES=(
  '.env'
  'auth.env'
  'id_rsa'
  'id_ed25519'
  'credentials.json'
  'service-account.json'
)

echo "check-secrets: scanning product tree (excluding node_modules/dist/venvs)"

# --- tracked secret basenames ---
if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  while IFS= read -r tracked; do
    [[ -z "${tracked}" ]] && continue
    base="$(basename "${tracked}")"
    for name in "${SECRET_NAMES[@]}"; do
      if [[ "${base}" == "${name}" ]]; then
        echo "check-secrets: FAIL — tracked secret-like file: ${tracked}" >&2
        failed=1
      fi
    done
    # Refuse .pem / .key private material under the product tree.
    if [[ "${tracked}" == *.pem || "${tracked}" == *.key ]]; then
      # Allow public certificates only if filename says so; default fail-closed.
      if [[ "${tracked}" != *public* && "${tracked}" != *cert* ]]; then
        echo "check-secrets: FAIL — tracked key material: ${tracked}" >&2
        failed=1
      fi
    fi
  done < <(git ls-files)
fi

# --- content patterns ---
# Build file list once (text-ish extensions).
mapfile -d '' FILES < <(
  find "${ROOT}" \( "${PRUNE[@]}" \) -prune -o -type f \( \
    -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.mjs' -o \
    -name '*.cjs' -o -name '*.json' -o -name '*.md' -o -name '*.sh' -o \
    -name '*.yml' -o -name '*.yaml' -o -name '*.env' -o -name '*.txt' -o \
    -name '*.html' -o -name '*.css' -o -name '*.toml' -o -name '*.py' -o \
    -name 'Dockerfile' -o -name '.env*' -o -name '*.cfg' -o -name '*.ini' \
  \) -print0 2>/dev/null
)

for entry in "${PATTERNS[@]}"; do
  name="${entry%%|*}"
  regex="${entry#*|}"
  for f in "${FILES[@]}"; do
    [[ -z "${f}" ]] && continue
    # Skip this scanner itself (documents the patterns).
    if [[ "${f}" == *"/scripts/check-secrets.sh" ]]; then
      continue
    fi
    # Skip the anticheat / docs that may mention pattern names without values.
    if [[ "${f}" == *"/e2e/anticheat.spec.ts" ]]; then
      continue
    fi
    if grep -EIq "${regex}" "${f}" 2>/dev/null; then
      # Suppress false positives: documentation that only names the pattern class.
      # Re-check with a stricter "assignment-like" filter for generic docs hits.
      if grep -EIn "${regex}" "${f}" 2>/dev/null | grep -EIq \
        '(token|secret|password|api[_-]?key|authorization|private)[[:space:]]*[:=]'; then
        :
      fi
      # Always fail on high-confidence credential shapes (PEM, AKIA, github_pat, sk-live, etc.).
      echo "check-secrets: FAIL — pattern ${name} matched in ${f#"${ROOT}"/}" >&2
      failed=1
    fi
  done
done

if [[ "${failed}" -ne 0 ]]; then
  echo "check-secrets: FAIL (credential patterns or secret files present)" >&2
  exit 1
fi

echo "check-secrets: OK"
exit 0
