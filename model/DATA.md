# Legal training / calibration data inventory (section 4.1)

> **Rule:** never train, fine-tune, or calibrate on frozen proxy hashes or golden-ten hashes.
> H1 runs only on the **named calib split** (`model/splits/calib_v1.json`). Soul-7 BA is **not** measured here (section 4.2).

## Named splits

| Split | Path | Purpose |
|-------|------|---------|
| `calib_v1` | `model/splits/calib_v1.json` | H1 zero-shot + Platt fit; post-FT TNR check |
| train pool | built at runtime from sources below, minus calib shas | fine-tune if H1 REFUTED |

Proxy leak gate: `model/test_no_proxy_leak.py` and `train.refuse_if_proxy_leak` refuse any row whose `sha256` appears in `eval/proxy/manifest.json` or `eval/goldens/README.md`.

## Sources (named, legal)

| Source | Role | Location (box defaults) | License / terms | Notes |
|--------|------|-------------------------|-----------------|-------|
| **DRAGON** test leftovers | AI calib / train | `$PROXY_DRAGON_DIR` default `/mnt/HC_Volume_105994188/poidh-cache/dragon_extract` | CC-BY-SA-4.0 (`lesc-unifi/dragon`) | Proxy construction used stems index `0..27` per family (`sdxl_`, `flux_1_`, `pixart_alpha_`). **4.1 uses stems ≥ 28 only** so content is construction-disjoint, and every file is still hash-checked against the freeze. |
| **Picsum** reals | Real calib / train | `/data/poidh-legal-proxy-staging/images/real/picsum/` | Picsum / Unsplash source terms (staging inventory) | Legal staging reals; **not** part of the frozen proxy. |
| **Pollinations** gens (if present) | AI supplement | `/data/poidh-legal-proxy-staging/images/ai/` | Hosted generator ToS via staging | Optional thin AI families; hash-checked. |
| **OpenFake core train** (optional) | AI train | `$OPENFAKE_TRAIN_DIR` default `/mnt/HC_Volume_105994188/poidh-cache/openfake_train` | OpenFake / CC-BY-SA-4.0 terms | **Train split only.** Proxy used OpenFake **test**; do not point this at `openfake_test`. |
| **COCO val2017** (optional extra) | Real train | `images.cocodataset.org/val2017/` | COCO / Flickr original licenses | Only IDs **not** listed in `eval/proxy/coco_val_ids.txt`. |

## Explicitly forbidden

| Material | Why |
|----------|-----|
| `eval/proxy/images/**` and any `sha256` in `eval/proxy/manifest.json` | Frozen soul-7 admission set (R-NO-PEEK / AC-SEP) |
| Golden ten hashes in `eval/goldens/README.md` | H5 parity set; train-disjoint |
| CIFAKE | Not a legal named source for this programme |
| Stolen commercial dumps (Midjourney / Firefly scrape packs) | Not licensed |
| Procedural sine/PRNG textures labeled as SDXL/Flux/etc. | Rejected by AC-REALGEN |

## Augmentations (fine-tune only)

When H1 is REFUTED, in-wave fine-tune applies **JPEG q40/q70** and **screenshot-like** nearest-neighbor down/up scales on legal train stills (mirrors proxy corruption taxonomy without reading proxy files).

## Upstream weights

| Artifact | Source |
|----------|--------|
| Zero-shot backbone | `buildborderless/CommunityForensics-DeepfakeDet-ViT` revision `ac6ee457bea904a373065754107451793b56db00` |
| Official ONNX pin (2.2) | `onnx/model.onnx` sha256 `a42c7d740fbb345ba9a26d469b22f301d73089ce3c6da993877ed2b6965a8ba1` |
| 4.1 calibrated export | `weights/onnx/model-calib-4.1-fp32.onnx` (+ fp16); SHA in `weights/manifest.json` → **`calibratedExports`** (not `artifacts[]`) so 2.2 setup does not download them |

## Environment overrides

| Variable | Meaning |
|----------|---------|
| `CF_ONNX` | Path to base ONNX for H1 / export |
| `PROXY_DRAGON_DIR` | DRAGON PNG extract root |
| `LEGAL_STAGING_DIR` | Staging reals/AI root |
| `OPENFAKE_TRAIN_DIR` | OpenFake **train** images (optional) |

## Missing GPU or legal data

If CUDA is unavailable when fine-tune is required, or if the legal pool cannot form a calib split, the run exits **`NEED_ACCESS`** (terminal). No random-net stub. Do not start 5.1.
