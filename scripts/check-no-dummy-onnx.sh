#!/usr/bin/env bash
# Fail if a production-labeled ONNX is under 20 MB (section 2.2 / AC-REAL).
# Checks weights/manifest.json pins and any committed *.onnx files.
# One-shot, non-interactive. Does not print env secrets.
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT="$(pwd)"
MIN_BYTES=$((20 * 1024 * 1024))
MANIFEST="${ROOT}/weights/manifest.json"
status=0

if [[ ! -f "${MANIFEST}" ]]; then
  echo "check-no-dummy-onnx: FAIL — weights/manifest.json missing" >&2
  exit 1
fi

# --- manifest: every production onnx must declare bytes >= 20 MiB and real CF URL ---
node --input-type=module -e '
  import { readFileSync } from "node:fs";

  const minBytes = Number(process.argv[1]);
  const manifestPath = process.argv[2];
  const j = JSON.parse(readFileSync(manifestPath, "utf8"));
  const arts = Array.isArray(j.artifacts) ? j.artifacts : [];
  const production = arts.filter(
    (a) => a && a.kind === "onnx" && a.role === "production",
  );
  if (production.length === 0) {
    console.error("check-no-dummy-onnx: FAIL — no production onnx in manifest");
    process.exit(1);
  }
  let failed = 0;
  for (const a of production) {
    const bytes = Number(a.bytes ?? 0);
    const sha = String(a.sha256 ?? "");
    const url = String(a.url ?? "");
    if (!Number.isFinite(bytes) || bytes < minBytes) {
      console.error(
        `check-no-dummy-onnx: FAIL — production ${a.id} bytes=${bytes} < ${minBytes}`,
      );
      failed = 1;
    }
    if (!/^[0-9a-f]{64}$/i.test(sha)) {
      console.error(
        `check-no-dummy-onnx: FAIL — production ${a.id} missing sha256 pin`,
      );
      failed = 1;
    }
    if (!/CommunityForensics-DeepfakeDet-ViT/i.test(url) || !/onnx\/model\.onnx/i.test(url)) {
      console.error(
        `check-no-dummy-onnx: FAIL — production ${a.id} URL is not CF ViT-S onnx/model.onnx`,
      );
      failed = 1;
    }
    if (/int8|q4|uint8|quantized|dummy|random/i.test(url + String(a.id))) {
      console.error(
        `check-no-dummy-onnx: FAIL — production artifact must not be INT8/Q4/dummy: ${a.id}`,
      );
      failed = 1;
    }
  }
  // minProductionOnnxBytes must be >= 20 MiB
  const minPin = Number(j.minProductionOnnxBytes ?? 0);
  if (minPin < minBytes) {
    console.error(
      `check-no-dummy-onnx: FAIL — minProductionOnnxBytes=${minPin} < ${minBytes}`,
    );
    failed = 1;
  }
  // wasm must be listed
  const wasm = arts.filter((a) => a && a.kind === "wasm");
  if (wasm.length < 1) {
    console.error("check-no-dummy-onnx: FAIL — no wasm artifacts in manifest (AC-ALL)");
    failed = 1;
  }
  process.exit(failed);
' "${MIN_BYTES}" "${MANIFEST}" || status=1

# --- any committed production-looking .onnx must be >= 20 MiB ---
while IFS= read -r -d '' f; do
  size=$(wc -c < "${f}" | tr -d ' ')
  # Skip clearly non-production names if any; still enforce size on *.onnx
  if [[ "${size}" -lt "${MIN_BYTES}" ]]; then
    # Allow test fixtures under explicit dummy/test paths only if not labeled production.
    case "${f}" in
      *dummy*|*fixture*|*test*|*stub*)
        echo "check-no-dummy-onnx: skip non-production path ${f} (${size} bytes)"
        ;;
      *)
        echo "check-no-dummy-onnx: FAIL — ${f} is ${size} bytes (< ${MIN_BYTES}); production ONNX must not be a stub" >&2
        status=1
        ;;
    esac
  fi
# Prune deps/venvs (local train venvs may ship tiny ORT/onnx test graphs).
done < <(find "${ROOT}" \( \
  -path "${ROOT}/node_modules" -o \
  -path "${ROOT}/.git" -o \
  -path "${ROOT}/dist" -o \
  -path "${ROOT}/.venv-proxy" -o \
  -path "${ROOT}/.venv-model" -o \
  -path "${ROOT}/.venv" -o \
  -name ".venv*" \
\) -prune -o -type f -name "*.onnx" -print0 2>/dev/null)

if [[ "${status}" -ne 0 ]]; then
  echo "check-no-dummy-onnx: FAIL" >&2
  exit 1
fi

echo "check-no-dummy-onnx: OK (production ONNX pin >= 20 MiB, wasm listed)"
exit 0
