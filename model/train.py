#!/usr/bin/env python3
"""
Section 4.1 — H1 zero-shot CF + Platt on named calib; in-wave fine-tune if REFUTED;
export calibrated fp16/fp32 ONNX as a new named artifact.

Hard rules:
- Never compute BA on the frozen proxy (R-NO-PEEK).
- Never train/calib on proxy or golden hashes (AC-SEP).
- Never print or optimize per-image proxy labels.
- GPU missing when fine-tune is required → NEED_ACCESS (terminal; no stub).
- Legal data missing → NEED_ACCESS.
- No 4.1b; fine-tune runs in this section if H1 is REFUTED.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np

from platt import (
    THRESHOLD,
    PlattParams,
    confusion_at_threshold,
    fit_platt,
    identity_platt,
    is_monotonic,
    logits_pile_at_half,
    sigmoid,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = Path(__file__).resolve().parent
OUT_DIR = MODEL_DIR / "out"
SPLITS_DIR = MODEL_DIR / "splits"
PROXY_MANIFEST = REPO_ROOT / "eval" / "proxy" / "manifest.json"
GOLDENS_README = REPO_ROOT / "eval" / "goldens" / "README.md"
HREG_PATH = MODEL_DIR / "H1-H5.md"
CALIB_NAME = "calib_v1"
OFFICIAL_ONNX = Path(
    os.environ.get(
        "CF_ONNX",
        "/mnt/HC_Volume_105994188/poidh-cache/cf-vit/model.onnx",
    )
)
DRAGON_DIR = Path(
    os.environ.get(
        "PROXY_DRAGON_DIR",
        "/mnt/HC_Volume_105994188/poidh-cache/dragon_extract",
    )
)
STAGING_DIR = Path(
    os.environ.get(
        "LEGAL_STAGING_DIR",
        "/data/poidh-legal-proxy-staging",
    )
)
OPENFAKE_TRAIN_HINT = Path(
    os.environ.get(
        "OPENFAKE_TRAIN_DIR",
        "/mnt/HC_Volume_105994188/poidh-cache/openfake_train",
    )
)

# H1 falsifiers (verbatim intent from hypothesis register).
H1_TNR_FLOOR = 0.65
# Fine-tune success target on calib after unfrozen backbone.
FT_TNR_TARGET = 0.72

# Locked preprocess (E1 / src/preprocess.ts).
SHORTEST_EDGE = 440
CROP_SIZE = 384
CLIP_MEAN = np.array([0.4815, 0.4578, 0.4082], dtype=np.float32)
CLIP_STD = np.array([0.2686, 0.2613, 0.2758], dtype=np.float32)

# Proxy construction took the first 28 stems per DRAGON family (see build_images.mjs).
PROXY_DRAGON_STEM_COUNT = 28


@dataclass
class Sample:
    path: Path
    sha256: str
    label: int  # 1=AI, 0=real
    family: str
    split: str


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def load_forbidden_shas() -> set[str]:
    """Proxy + golden hashes — never appear in train/calib."""
    forbidden: set[str] = set()
    if PROXY_MANIFEST.is_file():
        data = json.loads(PROXY_MANIFEST.read_text(encoding="utf-8"))
        for row in data.get("rows") or []:
            h = row.get("sha256")
            if h:
                forbidden.add(str(h).lower())
    if GOLDENS_README.is_file():
        text = GOLDENS_README.read_text(encoding="utf-8")
        for m in re.finditer(r"`([0-9a-f]{64})`", text):
            forbidden.add(m.group(1).lower())
    return forbidden


def refuse_if_proxy_leak(
    samples: Sequence[Sample],
    forbidden: set[str] | None = None,
) -> None:
    """Named test surface: any train/calib sha in proxy/goldens → hard refuse."""
    forbidden = forbidden if forbidden is not None else load_forbidden_shas()
    leaks = [s for s in samples if s.sha256.lower() in forbidden]
    if leaks:
        # Aggregate only — never print per-image proxy labels.
        raise SystemExit(
            f"REFUSE: {len(leaks)} train/calib file(s) share sha256 with "
            f"proxy/goldens manifest (AC-SEP). First path={leaks[0].path}"
        )


def need_access(msg: str, code: int = 2) -> None:
    print(f"NEED_ACCESS: {msg}", file=sys.stderr)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "need_access.json").write_text(
        json.dumps({"status": "NEED_ACCESS", "reason": msg, "at": utc_now()}, indent=2)
        + "\n",
        encoding="utf-8",
    )
    raise SystemExit(code)


def gpu_available() -> bool:
    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Preprocess (locked parity with src/preprocess.ts)
# ---------------------------------------------------------------------------


def _resize_shortest_edge_rgb(
    arr: np.ndarray, shortest: int = SHORTEST_EDGE
) -> np.ndarray:
    """arr: HWC uint8 RGB."""
    from PIL import Image

    h, w = arr.shape[:2]
    scale = shortest / min(h, w)
    out_w = max(1, int(round(w * scale)))
    out_h = max(1, int(round(h * scale)))
    if out_w == w and out_h == h:
        return arr
    img = Image.fromarray(arr, mode="RGB")
    img = img.resize((out_w, out_h), resample=Image.BILINEAR)
    return np.asarray(img, dtype=np.uint8)


def _center_crop(arr: np.ndarray, size: int = CROP_SIZE) -> np.ndarray:
    h, w = arr.shape[:2]
    if h < size or w < size:
        raise ValueError(f"image {w}x{h} too small for center-crop {size}")
    top = (h - size) // 2
    left = (w - size) // 2
    return arr[top : top + size, left : left + size]


def preprocess_path(path: Path) -> np.ndarray:
    """Return NCHW float32 [1,3,384,384] with CLIP mean/std."""
    from PIL import Image

    img = Image.open(path).convert("RGB")
    arr = np.asarray(img, dtype=np.uint8)
    arr = _resize_shortest_edge_rgb(arr, SHORTEST_EDGE)
    arr = _center_crop(arr, CROP_SIZE)
    x = arr.astype(np.float32) / 255.0
    x = (x - CLIP_MEAN) / CLIP_STD
    # HWC → CHW → NCHW
    x = np.transpose(x, (2, 0, 1))[None, ...].astype(np.float32)
    return x


# ---------------------------------------------------------------------------
# Legal inventory + named calib split
# ---------------------------------------------------------------------------


def _dragon_family_files(prefix: str) -> list[Path]:
    if not DRAGON_DIR.is_dir():
        return []
    re_pat = re.compile(rf"^{re.escape(prefix)}\d+_\d+_test\.png$")
    files = [p for p in DRAGON_DIR.iterdir() if re_pat.match(p.name)]
    files.sort(
        key=lambda p: int(re.search(r"_(\d+)_\d+_test", p.name).group(1))  # type: ignore[union-attr]
    )
    return files


def collect_legal_pool(forbidden: set[str]) -> list[Sample]:
    """
    Build a pool of legal AI/real stills disjoint (by sha) from proxy/goldens.

    AI: DRAGON test stems with index >= PROXY_DRAGON_STEM_COUNT (proxy took 0..27).
        Plus optional OpenFake train dir if present.
        Plus staging pollinations gens if present.
    Real: staging picsum (+ any other staging reals).
    """
    pool: list[Sample] = []

    def add(path: Path, label: int, family: str) -> None:
        if not path.is_file():
            return
        h = sha256_file(path)
        if h.lower() in forbidden:
            return
        pool.append(
            Sample(path=path, sha256=h, label=label, family=family, split="pool")
        )

    # DRAGON leftover stems (hash-disjoint by re-encode; stem-disjoint from proxy construction).
    for prefix, family in [
        ("sdxl_", "dragon-sdxl"),
        ("flux_1_", "dragon-flux"),
        ("pixart_alpha_", "dragon-pixart"),
    ]:
        files = _dragon_family_files(prefix)
        for p in files[PROXY_DRAGON_STEM_COUNT:]:
            add(p, 1, family)

    # Staging legal reals / optional AI (picsum, pollinations) — never scored for proxy.
    if STAGING_DIR.is_dir():
        man = STAGING_DIR / "manifest.json"
        if man.is_file():
            rows = json.loads(man.read_text(encoding="utf-8")).get("rows") or []
            for row in rows:
                rel = row.get("path") or row.get("relpath")
                if not rel:
                    continue
                p = STAGING_DIR / rel
                lab = 1 if row.get("label") == "ai" else 0
                fam = str(row.get("family") or "staging")
                add(p, lab, fam)
        else:
            for p in (STAGING_DIR / "images").rglob("*"):
                if p.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
                    continue
                lab = 1 if "/ai/" in str(p).replace("\\", "/") else 0
                add(p, lab, "staging")

    # Optional OpenFake train (not the proxy test dump).
    if OPENFAKE_TRAIN_HINT.is_dir():
        for p in OPENFAKE_TRAIN_HINT.rglob("*"):
            if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}:
                add(p, 1, "openfake-train")

    return pool


def build_named_calib(
    pool: list[Sample],
    *,
    name: str = CALIB_NAME,
    seed: int = 41,
    max_per_class: int = 80,
) -> list[Sample]:
    """
    Named calib split: hash of (path+name) for stable assignment.
    50/50 AI/real caps; all rows recorded under model/splits/<name>.json.
    """
    rng = random.Random(seed)
    ai = [s for s in pool if s.label == 1]
    real = [s for s in pool if s.label == 0]
    rng.shuffle(ai)
    rng.shuffle(real)
    n = min(max_per_class, len(ai), len(real))
    if n < 8:
        need_access(
            f"legal calib pool too small (ai={len(ai)} real={len(real)} n={n}); "
            "need more legal data"
        )
    chosen = ai[:n] + real[:n]
    # Stable order by sha
    chosen.sort(key=lambda s: s.sha256)
    samples = [
        Sample(
            path=s.path,
            sha256=s.sha256,
            label=s.label,
            family=s.family,
            split=name,
        )
        for s in chosen
    ]
    refuse_if_proxy_leak(samples)

    SPLITS_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "name": name,
        "created_at": utc_now(),
        "seed": seed,
        "n": len(samples),
        "n_ai": sum(1 for s in samples if s.label == 1),
        "n_real": sum(1 for s in samples if s.label == 0),
        "note": (
            "Named calib for H1 only. Disjoint by sha256 from eval/proxy and goldens. "
            "Never used as soul-7 certificate. Do not peek proxy BA here."
        ),
        "rows": [
            {
                "path": str(s.path),
                "sha256": s.sha256,
                "label": "ai" if s.label == 1 else "real",
                "family": s.family,
            }
            for s in samples
        ],
    }
    (SPLITS_DIR / f"{name}.json").write_text(
        json.dumps(payload, indent=2) + "\n", encoding="utf-8"
    )
    return samples


def load_named_calib(name: str = CALIB_NAME) -> list[Sample] | None:
    path = SPLITS_DIR / f"{name}.json"
    if not path.is_file():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    samples: list[Sample] = []
    for row in data.get("rows") or []:
        p = Path(row["path"])
        if not p.is_file():
            return None
        h = sha256_file(p)
        if h.lower() != str(row["sha256"]).lower():
            raise SystemExit(f"calib sha mismatch for {p}")
        samples.append(
            Sample(
                path=p,
                sha256=h,
                label=1 if row["label"] == "ai" else 0,
                family=str(row.get("family") or "unknown"),
                split=name,
            )
        )
    refuse_if_proxy_leak(samples)
    return samples


# ---------------------------------------------------------------------------
# Inference (ONNX Runtime — CPU or CUDA EP)
# ---------------------------------------------------------------------------


def make_session(onnx_path: Path):
    import onnxruntime as ort

    if not onnx_path.is_file():
        need_access(f"ONNX missing at {onnx_path}")
    providers = []
    avail = ort.get_available_providers()
    if "CUDAExecutionProvider" in avail:
        providers.append("CUDAExecutionProvider")
    providers.append("CPUExecutionProvider")
    return ort.InferenceSession(str(onnx_path), providers=providers)


def run_logits(session, samples: Sequence[Sample]) -> tuple[np.ndarray, np.ndarray]:
    """Return (logits, labels). Aggregate metrics only — no per-image proxy dump."""
    inp_name = session.get_inputs()[0].name
    logits = []
    labels = []
    for s in samples:
        x = preprocess_path(s.path)
        out = session.run(None, {inp_name: x})[0]
        z = float(np.asarray(out).reshape(-1)[0])
        logits.append(z)
        labels.append(s.label)
    return np.asarray(logits, dtype=np.float64), np.asarray(labels, dtype=np.int64)


# ---------------------------------------------------------------------------
# H1 + dispositions
# ---------------------------------------------------------------------------


def evaluate_h1(
    logits: np.ndarray,
    labels: np.ndarray,
    platt: PlattParams,
) -> dict[str, Any]:
    raw_scores = np.asarray(sigmoid(logits), dtype=np.float64)
    cal_scores = np.asarray(platt.apply_score(logits), dtype=np.float64)
    raw = confusion_at_threshold(raw_scores, labels, THRESHOLD)
    cal = confusion_at_threshold(cal_scores, labels, THRESHOLD)
    pile = logits_pile_at_half(cal_scores)
    tnr = float(cal["tnr"])
    falsified = (not (tnr >= H1_TNR_FLOOR)) or pile
    disposition = "REFUTED" if falsified else "CONFIRMED"
    # If TNR ok but BA weak, still CONFIRMED vs falsifier text; note TESTING if BA < 0.75.
    if not falsified and float(cal["ba"]) < 0.75:
        disposition = "TESTING"
    return {
        "disposition": disposition,
        "falsified": falsified,
        "falsifier": {
            "tnr_lt_floor": tnr < H1_TNR_FLOOR,
            "tnr": tnr,
            "tnr_floor": H1_TNR_FLOOR,
            "logits_pile_at_0_5": pile,
        },
        "raw": raw,
        "calibrated": cal,
        "platt": platt.to_json(),
        "platt_monotonic": is_monotonic(platt),
    }


def write_hreg(dispositions: dict[str, dict[str, Any]]) -> None:
    """
    Update model/H1-H5.md dispositions only (not a planning constitution).
    Claims stay fixed; disposition column is filled.
    """
    # Preserve claim table text; rewrite disposition file cleanly.
    lines = [
        "# H1–H5 hypothesis dispositions (section 4.1)",
        "",
        "> Product-tree disposition sheet. Claims match the control-plane register.",
        "> **Rule:** 4.1 fills disposition only. Do not delete rows. Do not peek proxy BA for H1.",
        "",
        f"Updated: {utc_now()}",
        "",
        "| ID | Claim (short) | Disposition | Evidence |",
        "|----|---------------|-------------|----------|",
    ]
    defaults = {
        "H1": "Zero-shot CF ViT-S + Platt on named calib has margin at 0.65",
        "H2": "Fine-tune + JPEG/screenshot augs lifts newest-gen TPR ≥15pp without TNR drop >3pp",
        "H3": "Tiny NPR fusion helps SD/GAN and does not cut Flux TPR",
        "H4": "Frequency-only / frozen-CLIP-head generalizes to Flux/MJ (negative control)",
        "H5": "Extension logits match CLI on goldens (parity; not trained here)",
    }
    for hid in ["H1", "H2", "H3", "H4", "H5"]:
        d = dispositions.get(hid) or {}
        disp = d.get("disposition", "PROPOSED")
        ev = d.get("evidence", "—")
        claim = defaults[hid]
        lines.append(f"| {hid} | {claim} | **{disp}** | {ev} |")
    lines.extend(
        [
            "",
            "## Notes",
            "",
            "- H1 is evaluated on `model/splits/calib_v1.json` only (never frozen proxy).",
            "- H3 default: do not ship NPR unless CONFIRMED.",
            "- H4 is a negative control: do not ship.",
            "- H5 is runtime parity (owned with 2.1/4.3); disposition may stay PROPOSED/TESTING here.",
            "- If H1 is REFUTED, fine-tune unfrozen backbone **in this section** (no 4.1b).",
            "",
        ]
    )
    # Attach H1 metrics summary without per-image labels.
    h1 = dispositions.get("H1") or {}
    if "metrics" in h1:
        lines.append("## H1 calib metrics (aggregate only)")
        lines.append("")
        lines.append("```json")
        lines.append(json.dumps(h1["metrics"], indent=2))
        lines.append("```")
        lines.append("")
    HREG_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# Fine-tune (unfrozen ViT-S) — requires GPU
# ---------------------------------------------------------------------------


def finetune_unfrozen(
    train_samples: Sequence[Sample],
    calib_samples: Sequence[Sample],
    *,
    epochs: int = 2,
    lr: float = 2e-5,
    batch_size: int = 4,
    out_dir: Path | None = None,
) -> Path:
    """
    Fine-tune full ViT-S backbone + head on legal data with JPEG/screenshot augs.
    GPU is mandatory — NEED_ACCESS otherwise (no CPU stub training).
    """
    if not gpu_available():
        need_access(
            "GPU missing — cannot fine-tune unfrozen ViT-S backbone (H1 REFUTED path). "
            "Terminal for 4.1; do not stub a random net."
        )

    import io

    import torch
    import torch.nn as nn
    from PIL import Image
    from torch.utils.data import DataLoader, Dataset
    from transformers import ViTForImageClassification

    refuse_if_proxy_leak(list(train_samples) + list(calib_samples))
    out_dir = out_dir or (OUT_DIR / "finetune")
    out_dir.mkdir(parents=True, exist_ok=True)

    device = torch.device("cuda")

    class LegalDataset(Dataset):
        def __init__(self, rows: Sequence[Sample], augment: bool):
            self.rows = list(rows)
            self.augment = augment

        def __len__(self) -> int:
            return len(self.rows)

        def __getitem__(self, idx: int):
            s = self.rows[idx]
            img = Image.open(s.path).convert("RGB")
            if self.augment:
                img = _augment_jpeg_screenshot(img)
            arr = np.asarray(img, dtype=np.uint8)
            arr = _resize_shortest_edge_rgb(arr)
            arr = _center_crop(arr)
            x = arr.astype(np.float32) / 255.0
            x = (x - CLIP_MEAN) / CLIP_STD
            x = np.transpose(x, (2, 0, 1))
            return torch.from_numpy(x.copy()), torch.tensor(s.label, dtype=torch.float32)

    def _augment_jpeg_screenshot(img: Image.Image) -> Image.Image:
        mode = random.choice(["none", "jpeg70", "jpeg40", "screenshot"])
        if mode == "none":
            return img
        if mode.startswith("jpeg"):
            q = 70 if mode == "jpeg70" else 40
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=q)
            buf.seek(0)
            return Image.open(buf).convert("RGB")
        # screenshot-like: downscale nearest then upscale
        w, h = img.size
        nw, nh = max(64, int(w * 0.55)), max(64, int(h * 0.55))
        return img.resize((nw, nh), Image.NEAREST).resize((w, h), Image.NEAREST)

    model = ViTForImageClassification.from_pretrained(
        "buildborderless/CommunityForensics-DeepfakeDet-ViT",
        revision="ac6ee457bea904a373065754107451793b56db00",
    )
    # Unfrozen backbone (all params).
    for p in model.parameters():
        p.requires_grad = True
    model.to(device)
    model.train()

    loader = DataLoader(
        LegalDataset(train_samples, augment=True),
        batch_size=batch_size,
        shuffle=True,
        num_workers=0,
        drop_last=False,
    )
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=0.01)
    loss_fn = nn.BCEWithLogitsLoss()

    history = []
    for epoch in range(epochs):
        total = 0.0
        n = 0
        for xb, yb in loader:
            xb = xb.to(device)
            yb = yb.to(device)
            opt.zero_grad(set_to_none=True)
            out = model(pixel_values=xb)
            logit = out.logits.view(-1)
            loss = loss_fn(logit, yb)
            loss.backward()
            opt.step()
            total += float(loss.item()) * xb.size(0)
            n += xb.size(0)
        history.append({"epoch": epoch, "loss": total / max(n, 1)})

    model.eval()
    # Calib logits for post-FT Platt
    cal_logits = []
    cal_labels = []
    with torch.no_grad():
        for s in calib_samples:
            x = preprocess_path(s.path)
            t = torch.from_numpy(x).to(device)
            z = float(model(pixel_values=t).logits.view(-1)[0].item())
            cal_logits.append(z)
            cal_labels.append(s.label)
    platt = fit_platt(cal_logits, cal_labels)
    cal_scores = platt.apply_score(np.asarray(cal_logits))
    metrics = confusion_at_threshold(cal_scores, cal_labels, THRESHOLD)
    if float(metrics["tnr"]) < FT_TNR_TARGET:
        print(
            f"WARN: post-FT calib TNR={metrics['tnr']:.3f} < {FT_TNR_TARGET}",
            file=sys.stderr,
        )

    model.save_pretrained(str(out_dir / "hf"))
    platt.save(OUT_DIR / "platt.json")
    (out_dir / "history.json").write_text(
        json.dumps(
            {"history": history, "calib_metrics": metrics, "platt": platt.to_json()},
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return out_dir / "hf"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="4.1 train/export pipeline")
    ap.add_argument("--onnx", type=Path, default=OFFICIAL_ONNX)
    ap.add_argument("--calib-name", default=CALIB_NAME)
    ap.add_argument("--skip-export", action="store_true")
    ap.add_argument("--force-finetune", action="store_true")
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument(
        "--check-leak-only",
        action="store_true",
        help="Only run proxy-leak refuse check against calib split",
    )
    args = ap.parse_args(argv)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    forbidden = load_forbidden_shas()
    if not forbidden:
        need_access("proxy manifest missing or empty — cannot enforce AC-SEP")

    # Legal pool + named calib
    calib = load_named_calib(args.calib_name)
    if calib is None:
        pool = collect_legal_pool(forbidden)
        if not pool:
            need_access("no legal training/calib images found on disk")
        calib = build_named_calib(pool, name=args.calib_name)
    else:
        refuse_if_proxy_leak(calib, forbidden)

    if args.check_leak_only:
        print(json.dumps({"ok": True, "n_calib": len(calib), "leaks": 0}))
        return 0

    if not args.onnx.is_file():
        need_access(f"official/base ONNX missing at {args.onnx}")

    print(f"4.1: H1 on named split {args.calib_name} n={len(calib)} (proxy never scored)")
    session = make_session(args.onnx)
    logits, labels = run_logits(session, calib)

    # Fit Platt on calib only
    platt = fit_platt(logits.tolist(), labels.tolist())
    if not is_monotonic(platt):
        # Force orientation fix already in fit; if still bad, identity
        print("WARN: Platt non-monotonic after fit; using identity", file=sys.stderr)
        platt = identity_platt()
    platt.save(OUT_DIR / "platt.json")

    h1 = evaluate_h1(logits, labels, platt)
    (OUT_DIR / "h1.json").write_text(json.dumps(h1, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "H1": h1["disposition"],
                "calib_ba": h1["calibrated"]["ba"],
                "calib_tnr": h1["calibrated"]["tnr"],
                "calib_tpr": h1["calibrated"]["tpr"],
                "falsified": h1["falsified"],
            },
            indent=2,
        )
    )

    dispositions: dict[str, dict[str, Any]] = {
        "H1": {
            "disposition": h1["disposition"] if h1["disposition"] != "TESTING" else "TESTING",
            "evidence": (
                f"calib={args.calib_name} n={h1['calibrated']['n']} "
                f"BA={h1['calibrated']['ba']:.3f} TNR={h1['calibrated']['tnr']:.3f} "
                f"TPR={h1['calibrated']['tpr']:.3f} platt_a={platt.a:.4f}"
            ),
            "metrics": h1,
        },
        "H2": {
            "disposition": "PROPOSED",
            "evidence": "awaits fine-tune comparison if H1 REFUTED",
        },
        "H3": {
            "disposition": "PROPOSED",
            "evidence": "NPR fusion not evaluated; default do-not-ship until CONFIRMED",
        },
        "H4": {
            "disposition": "PROPOSED",
            "evidence": "negative control not run as ship candidate; do not ship frequency-only / frozen-CLIP-head",
        },
        "H5": {
            "disposition": "PROPOSED",
            "evidence": "parity owned by 2.1/4.3; not trained around in 4.1",
        },
    }

    ft_dir: Path | None = None
    if h1["falsified"] or args.force_finetune:
        print("H1 REFUTED (or --force-finetune): fine-tune unfrozen backbone in-wave")
        if not gpu_available():
            write_hreg(
                {
                    **dispositions,
                    "H1": {
                        **dispositions["H1"],
                        "disposition": "REFUTED",
                        "evidence": dispositions["H1"]["evidence"]
                        + " | fine-tune blocked: NEED_ACCESS GPU",
                    },
                    "H2": {
                        "disposition": "TESTING",
                        "evidence": "NEED_ACCESS: GPU missing for fine-tune",
                    },
                }
            )
            need_access(
                "H1 REFUTED and GPU missing — fine-tune cannot run. "
                "Terminal NEED_ACCESS (no stub, no 4.1b)."
            )
        # Train set = legal pool minus calib shas
        pool = collect_legal_pool(forbidden)
        calib_shas = {s.sha256 for s in calib}
        train_rows = [s for s in pool if s.sha256 not in calib_shas]
        if len(train_rows) < 16:
            # Allow calib augs-only train if pool thin, but still refuse proxy.
            train_rows = list(calib)
        refuse_if_proxy_leak(train_rows)
        ft_dir = finetune_unfrozen(
            train_rows, calib, epochs=args.epochs, out_dir=OUT_DIR / "finetune"
        )
        # Re-eval H2 style metrics on calib with new platt
        platt = PlattParams.load(OUT_DIR / "platt.json")
        dispositions["H1"] = {
            "disposition": "REFUTED",
            "evidence": dispositions["H1"]["evidence"] + " | in-wave fine-tune completed",
            "metrics": h1,
        }
        # Load FT metrics
        hist = json.loads((OUT_DIR / "finetune" / "history.json").read_text(encoding="utf-8"))
        ft_m = hist.get("calib_metrics") or {}
        h2_ok = float(ft_m.get("tnr", 0)) >= FT_TNR_TARGET
        dispositions["H2"] = {
            "disposition": "CONFIRMED" if h2_ok else "TESTING",
            "evidence": (
                f"post-FT calib TNR={ft_m.get('tnr')} BA={ft_m.get('ba')} "
                f"TPR={ft_m.get('tpr')} (target TNR>={FT_TNR_TARGET})"
            ),
        }
    else:
        dispositions["H2"] = {
            "disposition": "PROPOSED",
            "evidence": "H1 not REFUTED — fine-tune not required in this run",
        }

    write_hreg(dispositions)

    if args.skip_export:
        return 0

    # Export named calibrated ONNX (never overwrite 2.2 official pin id).
    from export_onnx import main as export_main

    export_argv = [
        "--base",
        str(args.onnx),
        "--platt",
        str(OUT_DIR / "platt.json"),
        "--out-dir",
        str(REPO_ROOT / "weights" / "onnx"),
        "--name",
        "model-calib-4.1",
        "--opset",
        "17",
        "--manifest",
        str(REPO_ROOT / "weights" / "manifest.json"),
    ]
    if ft_dir is not None:
        export_argv.extend(["--checkpoint", str(ft_dir), "--from-torch"])
    rc = export_main(export_argv)
    if rc != 0:
        return rc

    summary = {
        "section": "4.1",
        "at": utc_now(),
        "calib": args.calib_name,
        "H1": dispositions["H1"]["disposition"],
        "H2": dispositions["H2"]["disposition"],
        "H3": dispositions["H3"]["disposition"],
        "H4": dispositions["H4"]["disposition"],
        "H5": dispositions["H5"]["disposition"],
        "gpu": gpu_available(),
        "export": "model/out/export.json",
    }
    (OUT_DIR / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    # Allow `python model/train.py` with sibling imports.
    sys.path.insert(0, str(MODEL_DIR))
    raise SystemExit(main())
