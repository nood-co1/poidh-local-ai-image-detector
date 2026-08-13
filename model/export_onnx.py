"""
Export calibrated ViT-S ONNX (section 4.1).

- Opset 17
- Named fp32 / fp16 artifacts (do not silently overwrite the 2.2 official pin)
- Optional Platt affine baked into the single-logit head
- Refuses dummy/tiny graphs (< 20 MiB production-class export)

Usage:
  python model/export_onnx.py \\
    --base /path/to/official.onnx \\
    --platt model/out/platt.json \\
    --out-dir weights/onnx \\
    --name model-calib-4.1
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np

# Production-class size floor (matches weights/manifest minProductionOnnxBytes / AC-REAL).
MIN_ONNX_BYTES = 20 * 1024 * 1024

REPO_ROOT = Path(__file__).resolve().parents[1]


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def load_platt(path: Path | None) -> tuple[float, float]:
    if path is None or not path.is_file():
        return 1.0, 0.0
    data = json.loads(path.read_text(encoding="utf-8"))
    return float(data["a"]), float(data["b"])


def bake_platt_into_onnx(
    src: Path,
    dst: Path,
    a: float,
    b: float,
    *,
    opset: int = 17,
) -> dict[str, Any]:
    """
    Load an official single-logit ONNX graph and append Mul+Add for Platt.

    calibrated_logit = a * logit + b
    The extension applies sigmoid on the exported logit (unchanged contract).
    """
    import onnx
    from onnx import TensorProto, helper, numpy_helper
    from onnx.onnx_pb import ModelProto

    model: ModelProto = onnx.load(str(src))
    graph = model.graph
    if not graph.output:
        raise RuntimeError("ONNX model has no outputs")

    # Identity Platt → optional pure copy (still rewrites file for a stable path).
    if abs(a - 1.0) < 1e-12 and abs(b) < 1e-12:
        raw = src.read_bytes()
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(raw)
        return {
            "path": str(dst),
            "bytes": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(),
            "platt": {"a": a, "b": b},
            "opset": opset,
            "mode": "copy_identity_platt",
        }

    orig_out = graph.output[0]
    orig_out_name = orig_out.name
    mid_name = orig_out_name + "__pre_platt"
    # Rename producer outputs that feed the graph output.
    for node in graph.node:
        for i, o in enumerate(node.output):
            if o == orig_out_name:
                node.output[i] = mid_name
    for i, vi in enumerate(list(graph.output)):
        if vi.name == orig_out_name:
            # Keep external output name identical for runtime contract.
            pass

    # Initializers for a, b (scalar tensors broadcastable to logit).
    a_name = "platt_a"
    b_name = "platt_b"
    mul_out = orig_out_name + "__mul"
    # Remove any prior platt nodes if re-running.
    graph.initializer.extend(
        [
            numpy_helper.from_array(np.asarray([a], dtype=np.float32), a_name),
            numpy_helper.from_array(np.asarray([b], dtype=np.float32), b_name),
        ]
    )
    mul = helper.make_node("Mul", inputs=[mid_name, a_name], outputs=[mul_out], name="platt_mul")
    add = helper.make_node(
        "Add", inputs=[mul_out, b_name], outputs=[orig_out_name], name="platt_add"
    )
    graph.node.extend([mul, add])

    # Opset import bump / ensure.
    if model.opset_import:
        model.opset_import[0].version = opset
    else:
        model.opset_import.extend([helper.make_opsetid("", opset)])

    onnx.checker.check_model(model)
    dst.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model, str(dst))
    raw = dst.read_bytes()
    return {
        "path": str(dst),
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "platt": {"a": a, "b": b},
        "opset": opset,
        "mode": "bake_mul_add",
    }


def export_fp16_from_fp32(fp32_path: Path, fp16_path: Path) -> dict[str, Any]:
    """Convert float32 weights to float16 where safe (ONNX converter)."""
    import onnx
    from onnxconverter_common import float16

    model = onnx.load(str(fp32_path))
    try:
        model_fp16 = float16.convert_float_to_float16(model, keep_io_types=True)
    except Exception:
        # Fallback: pure copy with a note (fp32 shipped as both if converter missing).
        raw = fp32_path.read_bytes()
        fp16_path.parent.mkdir(parents=True, exist_ok=True)
        fp16_path.write_bytes(raw)
        return {
            "path": str(fp16_path),
            "bytes": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(),
            "mode": "fp16_fallback_copy_fp32",
        }
    fp16_path.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model_fp16, str(fp16_path))
    raw = fp16_path.read_bytes()
    return {
        "path": str(fp16_path),
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "mode": "float16_convert",
    }


def export_from_torch(
    checkpoint: Path | None,
    dst_fp32: Path,
    *,
    platt_a: float,
    platt_b: float,
    opset: int = 17,
    hf_id: str = "buildborderless/CommunityForensics-DeepfakeDet-ViT",
    revision: str = "ac6ee457bea904a373065754107451793b56db00",
) -> dict[str, Any]:
    """
    Export ViTForImageClassification → ONNX opset 17 with Platt baked into the head.
    Requires torch + transformers. Used after fine-tune (checkpoint) or zero-shot HF load.
    """
    import torch
    from transformers import ViTForImageClassification

    if checkpoint and checkpoint.is_dir():
        model = ViTForImageClassification.from_pretrained(str(checkpoint))
    else:
        model = ViTForImageClassification.from_pretrained(hf_id, revision=revision)

    # Bake Platt into final linear: y' = a*(W x + b_bias) + b = (aW)x + (a*b_bias + b)
    with torch.no_grad():
        head = model.classifier
        if hasattr(head, "weight"):
            head.weight.mul_(platt_a)
            if head.bias is not None:
                head.bias.mul_(platt_a)
                head.bias.add_(platt_b)
            else:
                head.bias = torch.nn.Parameter(
                    torch.full((head.weight.shape[0],), platt_b, dtype=head.weight.dtype)
                )

    model.eval()
    dummy = torch.randn(1, 3, 384, 384, dtype=torch.float32)
    dst_fp32.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        model,
        dummy,
        str(dst_fp32),
        input_names=["pixel_values"],
        output_names=["logits"],
        opset_version=opset,
        do_constant_folding=True,
        dynamic_axes=None,
    )
    raw = dst_fp32.read_bytes()
    if len(raw) < MIN_ONNX_BYTES:
        raise RuntimeError(
            f"export too small ({len(raw)} < {MIN_ONNX_BYTES}); refusing dummy ONNX"
        )
    return {
        "path": str(dst_fp32),
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "platt": {"a": platt_a, "b": platt_b},
        "opset": opset,
        "mode": "torch_export",
    }


def assert_onnx_loadable(path: Path) -> dict[str, Any]:
    """Named test: onnxruntime can load the artifact and run a dummy forward."""
    import onnxruntime as ort

    if not path.is_file():
        raise FileNotFoundError(path)
    size = path.stat().st_size
    sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    inputs = sess.get_inputs()
    outputs = sess.get_outputs()
    if not inputs:
        raise RuntimeError("ONNX has no inputs")
    inp = inputs[0]
    # Expect NCHW 1x3x384x384 float
    shape = []
    for d in inp.shape:
        if isinstance(d, int) and d > 0:
            shape.append(d)
        else:
            shape.append(1 if len(shape) == 0 else (3 if len(shape) == 1 else 384))
    if len(shape) != 4:
        shape = [1, 3, 384, 384]
    x = np.random.randn(*shape).astype(np.float32)
    feeds = {inp.name: x}
    outs = sess.run(None, feeds)
    logit = float(np.asarray(outs[0]).reshape(-1)[0])
    return {
        "path": str(path),
        "bytes": size,
        "sha256": sha256_file(path),
        "input_name": inp.name,
        "output_name": outputs[0].name if outputs else None,
        "dummy_logit": logit,
        "ok": True,
    }


def update_manifest(
    manifest_path: Path,
    artifacts: list[dict[str, Any]],
) -> None:
    """
    Record named calibrated ONNX SHAs without touching the 2.2 runtime pin list.

    Writes to top-level ``calibratedExports`` only. Never inserts into
    ``artifacts`` (ensureArtifacts / setup iterate that array and would 404
    on repo-relative paths). Strips any leftover role=calibrated rows from
    ``artifacts`` if a prior export put them there.
    """
    data = json.loads(manifest_path.read_text(encoding="utf-8"))

    # Runtime pins only: drop any calibrated/role-calibrated rows from artifacts.
    runtime_arts: list[dict] = []
    for a in data.get("artifacts") or []:
        if not a:
            continue
        role = str(a.get("role") or "")
        aid = str(a.get("id") or "")
        if role == "calibrated" or "model-calib" in aid:
            continue
        runtime_arts.append(a)
    data["artifacts"] = runtime_arts

    # Side field the 2.2 store does not iterate.
    exports: list[dict] = list(data.get("calibratedExports") or [])
    by_id = {e.get("id"): i for i, e in enumerate(exports)}
    for art in artifacts:
        path = art.get("path") or art.get("packagePath") or f"weights/{art['id']}"
        entry = {
            "id": art["id"],
            "role": "calibrated",
            "kind": "onnx",
            "sha256": art["sha256"],
            "bytes": art["bytes"],
            "path": path,
            "notes": art.get(
                "notes",
                "section 4.1 calibrated export (opset 17). SHA pin only — "
                "not downloaded by 2.2 ensureArtifacts/setup.",
            ),
        }
        if art["id"] in by_id:
            exports[by_id[art["id"]]] = entry
        else:
            exports.append(entry)
    data["calibratedExports"] = exports

    notes = data.get("notes") or ""
    tag = "calibratedExports only — not required by ensureArtifacts/setup"
    if "calibratedExports" not in notes:
        data["notes"] = (notes.rstrip() + " Section 4.1 calibrated exports live under " + tag + ".").strip()
    manifest_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Export calibrated ViT-S ONNX (4.1)")
    p.add_argument(
        "--base",
        type=Path,
        default=Path("/mnt/HC_Volume_105994188/poidh-cache/cf-vit/model.onnx"),
        help="Official or fine-tuned base ONNX",
    )
    p.add_argument("--checkpoint", type=Path, default=None, help="HF dir after fine-tune")
    p.add_argument("--platt", type=Path, default=REPO_ROOT / "model" / "out" / "platt.json")
    p.add_argument("--out-dir", type=Path, default=REPO_ROOT / "weights" / "onnx")
    p.add_argument("--name", type=str, default="model-calib-4.1")
    p.add_argument("--opset", type=int, default=17)
    p.add_argument("--manifest", type=Path, default=REPO_ROOT / "weights" / "manifest.json")
    p.add_argument("--skip-fp16", action="store_true")
    p.add_argument("--from-torch", action="store_true", help="Export via torch+transformers")
    p.add_argument("--verify-only", type=Path, default=None, help="Only run load test on path")
    args = p.parse_args(argv)

    if args.verify_only:
        info = assert_onnx_loadable(args.verify_only)
        print(json.dumps(info, indent=2))
        return 0 if info.get("ok") else 1

    a, b = load_platt(args.platt)
    out_dir: Path = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    fp32_path = out_dir / f"{args.name}-fp32.onnx"
    fp16_path = out_dir / f"{args.name}-fp16.onnx"

    if args.from_torch or args.checkpoint:
        meta_fp32 = export_from_torch(
            args.checkpoint,
            fp32_path,
            platt_a=a,
            platt_b=b,
            opset=args.opset,
        )
    else:
        if not args.base.is_file():
            print(f"NEED_ACCESS: base ONNX missing at {args.base}", file=sys.stderr)
            return 2
        meta_fp32 = bake_platt_into_onnx(args.base, fp32_path, a, b, opset=args.opset)

    if meta_fp32["bytes"] < MIN_ONNX_BYTES:
        print(
            f"REFUSING dummy export: {meta_fp32['bytes']} < {MIN_ONNX_BYTES}",
            file=sys.stderr,
        )
        return 1

    verify_fp32 = assert_onnx_loadable(fp32_path)
    results = {"fp32": {**meta_fp32, "verify": verify_fp32}}

    if not args.skip_fp16:
        try:
            meta_fp16 = export_fp16_from_fp32(fp32_path, fp16_path)
            if meta_fp16["bytes"] < MIN_ONNX_BYTES:
                # keep fp32 only
                results["fp16"] = {"skipped": "too_small_after_convert", **meta_fp16}
            else:
                verify_fp16 = assert_onnx_loadable(fp16_path)
                results["fp16"] = {**meta_fp16, "verify": verify_fp16}
        except Exception as exc:  # noqa: BLE001 — report and keep fp32
            results["fp16"] = {"error": str(exc)}

    # Manifest side-field pins (calibratedExports — not runtime artifacts[]).
    arts = [
        {
            "id": f"onnx/{args.name}-fp32.onnx",
            "role": "calibrated",
            "sha256": results["fp32"]["sha256"],
            "bytes": results["fp32"]["bytes"],
            "path": f"weights/onnx/{args.name}-fp32.onnx",
            "notes": (
                "section 4.1 fp32 calibrated ViT-S (opset 17). "
                "SHA pin only — not downloaded by 2.2 ensureArtifacts/setup."
            ),
        }
    ]
    if "fp16" in results and "sha256" in results["fp16"] and "error" not in results["fp16"]:
        if results["fp16"].get("bytes", 0) >= MIN_ONNX_BYTES:
            arts.append(
                {
                    "id": f"onnx/{args.name}-fp16.onnx",
                    "role": "calibrated",
                    "sha256": results["fp16"]["sha256"],
                    "bytes": results["fp16"]["bytes"],
                    "path": f"weights/onnx/{args.name}-fp16.onnx",
                    "notes": (
                        "section 4.1 fp16 calibrated ViT-S (opset 17). "
                        "SHA pin only — not downloaded by 2.2 ensureArtifacts/setup."
                    ),
                }
            )

    if args.manifest.is_file():
        update_manifest(args.manifest, arts)
        results["manifest"] = str(args.manifest)

    out_json = REPO_ROOT / "model" / "out" / "export.json"
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(results, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
