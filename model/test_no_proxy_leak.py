#!/usr/bin/env python3
"""
Named tests for section 4.1:

1. script refuses if any train file sha is in proxy manifest
2. platt monotonic
3. export produces onnx loadable by onnxruntime (when artifact present)

Run:  python model/test_no_proxy_leak.py
Exit 0 on pass.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

MODEL_DIR = Path(__file__).resolve().parent
REPO_ROOT = MODEL_DIR.parent
sys.path.insert(0, str(MODEL_DIR))

from platt import PlattParams, fit_platt, is_monotonic, sigmoid  # noqa: E402
from train import (  # noqa: E402
    Sample,
    load_forbidden_shas,
    refuse_if_proxy_leak,
    sha256_file,
)


def test_refuse_proxy_sha() -> None:
    forbidden = load_forbidden_shas()
    assert forbidden, "proxy/golden sha set must be non-empty"
    # Pick one proxy sha and craft a fake sample claiming that hash.
    proxy_sha = next(iter(forbidden))
    fake = Sample(
        path=Path("/tmp/not-used-for-hash.png"),
        sha256=proxy_sha,
        label=0,
        family="leak-test",
        split="train",
    )
    try:
        refuse_if_proxy_leak([fake], forbidden)
        raise AssertionError("expected refuse_if_proxy_leak to SystemExit")
    except SystemExit as e:
        msg = str(e)
        assert "REFUSE" in msg or "proxy" in msg.lower()
    print("PASS test_refuse_proxy_sha")


def test_calib_split_no_leak() -> None:
    split = MODEL_DIR / "splits" / "calib_v1.json"
    if not split.is_file():
        print("SKIP test_calib_split_no_leak (calib_v1.json not built yet)")
        return
    data = json.loads(split.read_text(encoding="utf-8"))
    forbidden = load_forbidden_shas()
    samples = []
    for row in data.get("rows") or []:
        samples.append(
            Sample(
                path=Path(row["path"]),
                sha256=row["sha256"],
                label=1 if row["label"] == "ai" else 0,
                family=row.get("family", ""),
                split="calib_v1",
            )
        )
    refuse_if_proxy_leak(samples, forbidden)
    # Also verify on-disk hashes if files exist
    for s in samples:
        if s.path.is_file():
            h = sha256_file(s.path)
            assert h.lower() == s.sha256.lower()
            assert h.lower() not in forbidden
    print(f"PASS test_calib_split_no_leak n={len(samples)}")


def test_platt_monotonic() -> None:
    import numpy as np

    rng = np.random.default_rng(42)
    z_real = rng.normal(-1.5, 0.8, 40)
    z_ai = rng.normal(1.5, 0.8, 40)
    z = np.concatenate([z_real, z_ai])
    y = np.concatenate([np.zeros(40, dtype=int), np.ones(40, dtype=int)])
    params = fit_platt(z.tolist(), y.tolist())
    assert params.a > 0, f"expected a>0, got {params.a}"
    assert is_monotonic(params), "Platt mapping must be monotonic in logit"
    # Score order preserved for sorted logits
    probe = np.linspace(-5, 5, 50)
    scores = params.apply_score(probe)
    assert all(scores[i] <= scores[i + 1] + 1e-9 for i in range(len(scores) - 1))
    print("PASS test_platt_monotonic", params.to_json())


def test_export_onnx_loadable() -> None:
    onnx_path = REPO_ROOT / "weights" / "onnx" / "model-calib-4.1-fp32.onnx"
    if not onnx_path.is_file():
        # Also accept export under model/out for intermediate runs
        alt = MODEL_DIR / "out" / "model-calib-4.1-fp32.onnx"
        onnx_path = alt if alt.is_file() else onnx_path
    if not onnx_path.is_file():
        print("SKIP test_export_onnx_loadable (artifact not exported yet)")
        return
    from export_onnx import MIN_ONNX_BYTES, assert_onnx_loadable

    info = assert_onnx_loadable(onnx_path)
    assert info["ok"] is True
    assert info["bytes"] >= MIN_ONNX_BYTES
    assert len(info["sha256"]) == 64
    # SHA must be recorded under calibratedExports (not runtime artifacts[]).
    man = json.loads((REPO_ROOT / "weights" / "manifest.json").read_text(encoding="utf-8"))
    exports = [
        a
        for a in man.get("calibratedExports") or []
        if str(a.get("id", "")).endswith("model-calib-4.1-fp32.onnx")
    ]
    assert exports, "manifest.calibratedExports missing calibrated fp32 pin"
    assert exports[0]["sha256"] == info["sha256"]
    # Must NOT appear in runtime artifacts (would break setup/models_ready).
    runtime_leak = [
        a
        for a in man.get("artifacts") or []
        if "model-calib" in str(a.get("id", "")) or a.get("role") == "calibrated"
    ]
    assert not runtime_leak, (
        "calibrated ONNX must not be in artifacts[] (ensureArtifacts would require it)"
    )
    print("PASS test_export_onnx_loadable", info["sha256"][:12], info["bytes"])


def test_official_pin_preserved() -> None:
    man = json.loads((REPO_ROOT / "weights" / "manifest.json").read_text(encoding="utf-8"))
    prod = [
        a
        for a in man.get("artifacts") or []
        if a.get("kind") == "onnx" and a.get("role") == "production"
    ]
    assert prod, "2.2 production pin missing"
    assert prod[0]["sha256"] == (
        "a42c7d740fbb345ba9a26d469b22f301d73089ce3c6da993877ed2b6965a8ba1"
    )
    # Runtime list must stay free of 4.1 calibrated rows.
    for a in man.get("artifacts") or []:
        assert a.get("role") != "calibrated"
        assert "model-calib" not in str(a.get("id", ""))
    assert man.get("calibratedExports"), "calibratedExports side field required"
    print("PASS test_official_pin_preserved")


def main() -> int:
    failures = 0
    for fn in [
        test_refuse_proxy_sha,
        test_calib_split_no_leak,
        test_platt_monotonic,
        test_export_onnx_loadable,
        test_official_pin_preserved,
    ]:
        try:
            fn()
        except Exception as exc:  # noqa: BLE001
            failures += 1
            print(f"FAIL {fn.__name__}: {exc}", file=sys.stderr)
    if failures:
        print(f"{failures} test(s) failed", file=sys.stderr)
        return 1
    print("All 4.1 named tests passed (or skipped pending artifacts)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
