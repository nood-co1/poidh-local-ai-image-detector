"""
Platt scaling for single-logit AI detectors (section 4.1).

Fits logistic regression on raw logits so scores are better calibrated at
THRESHOLD=0.65. Fit **only** on a named calib split (never the frozen proxy).

Monotonicity: for A > 0, score = sigmoid(A * logit + B) is strictly increasing
in logit (named test: platt monotonic).
"""

from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable, Sequence

import numpy as np

# Decision threshold (must match src/threshold.ts). Do not re-declare 0.65 elsewhere for policy.
# Import path is TS-only; Python mirrors the constant for metrics only.
THRESHOLD = 0.65


def sigmoid(x: float | np.ndarray) -> float | np.ndarray:
    """Numerically stable logistic sigmoid."""
    x_arr = np.asarray(x, dtype=np.float64)
    out = np.empty_like(x_arr, dtype=np.float64)
    pos = x_arr >= 0
    out[pos] = 1.0 / (1.0 + np.exp(-x_arr[pos]))
    exp_x = np.exp(x_arr[~pos])
    out[~pos] = exp_x / (1.0 + exp_x)
    if np.isscalar(x):
        return float(out)
    return out


@dataclass(frozen=True)
class PlattParams:
    """Affine map on logits: calibrated_logit = a * logit + b."""

    a: float
    b: float
    n: int
    method: str = "sklearn_logistic"
    note: str = ""

    def apply_logit(self, logit: float | np.ndarray) -> float | np.ndarray:
        return self.a * np.asarray(logit, dtype=np.float64) + self.b

    def apply_score(self, logit: float | np.ndarray) -> float | np.ndarray:
        return sigmoid(self.apply_logit(logit))

    def to_json(self) -> dict:
        return asdict(self)

    @classmethod
    def from_json(cls, d: dict) -> "PlattParams":
        return cls(
            a=float(d["a"]),
            b=float(d["b"]),
            n=int(d.get("n", 0)),
            method=str(d.get("method", "sklearn_logistic")),
            note=str(d.get("note", "")),
        )

    def save(self, path: Path | str) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_json(), indent=2) + "\n", encoding="utf-8")

    @classmethod
    def load(cls, path: Path | str) -> "PlattParams":
        return cls.from_json(json.loads(Path(path).read_text(encoding="utf-8")))


def fit_platt(
    logits: Sequence[float],
    labels: Sequence[int],
    *,
    max_iter: int = 1000,
) -> PlattParams:
    """
    Fit Platt parameters on calib logits.

    labels: 1 = AI, 0 = real (matches A1: AI iff score >= 0.65).
    Uses sklearn LogisticRegression on shape (n, 1) features = raw logit.
    Falls back to a simple grid search if sklearn is unavailable.
    """
    z = np.asarray(logits, dtype=np.float64).reshape(-1)
    y = np.asarray(labels, dtype=np.int64).reshape(-1)
    if z.shape[0] != y.shape[0]:
        raise ValueError("logits and labels length mismatch")
    if z.shape[0] < 4:
        raise ValueError("need at least 4 calib samples for Platt")
    if len(np.unique(y)) < 2:
        raise ValueError("Platt requires both AI and real labels in calib")

    try:
        from sklearn.linear_model import LogisticRegression

        clf = LogisticRegression(
            solver="lbfgs",
            max_iter=max_iter,
            fit_intercept=True,
        )
        clf.fit(z.reshape(-1, 1), y)
        a = float(clf.coef_.ravel()[0])
        b = float(clf.intercept_.ravel()[0])
        method = "sklearn_logistic"
    except Exception:
        # Fallback: maximize Bernoulli log-likelihood on a coarse (a, b) grid.
        a, b = _fit_platt_grid(z, y)
        method = "grid_mle"

    # Ensure positive orientation (AI ↔ high score). If flipped, invert.
    scores = sigmoid(a * z + b)
    # Point-biserial: mean score on AI should exceed mean on real.
    if scores[y == 1].mean() < scores[y == 0].mean():
        a, b = -a, -b

    return PlattParams(a=a, b=b, n=int(z.shape[0]), method=method)


def _fit_platt_grid(z: np.ndarray, y: np.ndarray) -> tuple[float, float]:
    best = (-1e18, 1.0, 0.0)
    for a in np.linspace(0.1, 5.0, 40):
        for b in np.linspace(-5.0, 5.0, 41):
            p = sigmoid(a * z + b)
            p = np.clip(p, 1e-7, 1 - 1e-7)
            ll = float(np.sum(y * np.log(p) + (1 - y) * np.log(1 - p)))
            if ll > best[0]:
                best = (ll, float(a), float(b))
    return best[1], best[2]


def is_monotonic(
    params: PlattParams,
    logits: Iterable[float] | None = None,
) -> bool:
    """
    Named test helper: Platt mapping is strictly increasing in logit when a > 0.
    """
    if params.a <= 0:
        return False
    if logits is None:
        probe = np.linspace(-20.0, 20.0, 401)
    else:
        probe = np.sort(np.asarray(list(logits), dtype=np.float64))
        if probe.size < 2:
            probe = np.linspace(-20.0, 20.0, 401)
    scores = np.asarray(params.apply_score(probe), dtype=np.float64)
    return bool(np.all(scores[1:] >= scores[:-1] - 1e-12))


def confusion_at_threshold(
    scores: Sequence[float],
    labels: Sequence[int],
    threshold: float = THRESHOLD,
) -> dict:
    """TPR/TNR/BA at a fixed decision threshold (A1). Never prints per-image rows."""
    s = np.asarray(scores, dtype=np.float64)
    y = np.asarray(labels, dtype=np.int64)
    pred = (s >= threshold).astype(np.int64)
    tp = int(np.sum((pred == 1) & (y == 1)))
    tn = int(np.sum((pred == 0) & (y == 0)))
    fp = int(np.sum((pred == 1) & (y == 0)))
    fn = int(np.sum((pred == 0) & (y == 1)))
    n_pos = tp + fn
    n_neg = tn + fp
    tpr = tp / n_pos if n_pos else float("nan")
    tnr = tn / n_neg if n_neg else float("nan")
    ba = 0.5 * (tpr + tnr) if n_pos and n_neg else float("nan")
    return {
        "threshold": threshold,
        "n": int(s.shape[0]),
        "n_ai": n_pos,
        "n_real": n_neg,
        "tp": tp,
        "tn": tn,
        "fp": fp,
        "fn": fn,
        "tpr": tpr,
        "tnr": tnr,
        "ba": ba,
        "mean_score": float(s.mean()) if s.size else float("nan"),
        "score_std": float(s.std()) if s.size else float("nan"),
    }


def logits_pile_at_half(scores: Sequence[float], band: float = 0.05) -> bool:
    """H1 falsifier helper: most mass piled near 0.5 ⇒ no margin."""
    s = np.asarray(scores, dtype=np.float64)
    if s.size == 0:
        return True
    frac = float(np.mean(np.abs(s - 0.5) <= band))
    return frac >= 0.80


def identity_platt() -> PlattParams:
    """No-op calibration (a=1, b=0)."""
    return PlattParams(a=1.0, b=0.0, n=0, method="identity", note="no-op")


if __name__ == "__main__":
    # Self-check: synthetic separable logits → monotonic Platt.
    rng = np.random.default_rng(0)
    z_real = rng.normal(-2.0, 0.5, 50)
    z_ai = rng.normal(2.0, 0.5, 50)
    z = np.concatenate([z_real, z_ai])
    y = np.concatenate([np.zeros(50, dtype=int), np.ones(50, dtype=int)])
    p = fit_platt(z, y)
    assert is_monotonic(p), "Platt must be monotonic"
    raw = confusion_at_threshold(sigmoid(z), y)
    cal = confusion_at_threshold(p.apply_score(z), y)
    print(json.dumps({"params": p.to_json(), "raw": raw, "cal": cal}, indent=2))
