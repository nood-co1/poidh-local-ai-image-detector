# Proxy construction protocol (frozen — section 1.3)

> **Status:** FROZEN before 4.1. Changing this freeze after 4.1 starts requires **owner amendment**.
> Builder must **not** iterate the freeze after seeing model scores (R-NO-PEEK).

This file defines how the **full frozen proxy** in `manifest.json` was built. Soul 7 admission uses the **entire** list — **no hashed subset**, no 20-image toy, no “representative sample” certificate.

---

## Purpose

- **Admission gate** for `dogfood_ready` (soul 7 / JOB-PROXY-01), not the POIDH hidden maintainer set.
- Instrument-first: lock preprocess + full proxy **before** training (4.1).
- On-disk bytes under `images/` must match each row’s `sha256` (unit test).

---

## Never train on this list (AC-NOTRAIN)

**Forbidden:** using any `sha256` or file from this proxy (or the golden ten) as training, fine-tune, or calibration data in 4.1.

- Train / calib splits must be **disjoint** from every hash in `manifest.json` and `eval/goldens/README.md`.
- Do not copy Track B bakeoff images into this proxy after seeing model scores.
- Do not use CIFAKE as the freeze.

---

## Full proxy only (AC-NOSUBSET)

- Soul 7 measures the **full** frozen proxy (every row in `manifest.json`).
- Language allowing a hashed subset, CLI-only walk, or “same ORT worker instead of the loaded extension” is **out of constitution**.
- 4.2 drives the **loaded extension** over **page-rendered** images for **every** row. CLI is parity only, not the certificate.

---

## Row schema

Every row in `manifest.json`:

| field | meaning |
|-------|---------|
| `relpath` | Path relative to `eval/proxy/` (under `images/`) |
| `sha256` | Hex digest of on-disk file bytes |
| `label` | `real` \| `ai` |
| `family` | Source / generator family tag |
| `corruption` | `none` \| `jpeg_q70` \| `jpeg_q40` \| `webp` \| `screenshot` |
| `license` | Named legal source note |

Fail-closed: empty manifest is invalid. A row without a readable file whose bytes match `sha256` fails unit tests.

---

## Families and sources (legal generators only)

### Real (≥ 100)

| family | source | notes |
|--------|--------|-------|
| `coco-val2017` | [COCO](https://cocodataset.org/) val2017 stills | Flickr original licenses; research use. IDs in `coco_val_ids.txt`. Fetched via `http://images.cocodataset.org/val2017/`. |

Do **not** use Hugging Face image URLs for **fixtures** (privacy HAR). Proxy construction may materialize legal datasets offline (not as hotlink targets).

### AI (≥ 100, ≥ 4 real generator families)

| family | generator / dataset | how obtained | license |
|--------|---------------------|--------------|---------|
| `sdxl` | **SDXL** images from **DRAGON** test set (`lesc-unifi/dragon`, model tag `SDXL`) | Extract `sdxl_*_test.png` from DRAGON test tar; re-encode + corrupt + **metadata strip** into `images/ai/sdxl/` | CC-BY-SA-4.0 (DRAGON) |
| `flux-schnell` | **Flux.1-schnell** images from **DRAGON** test set (model tag `Flux_1`; DRAGON paper uses Flux.1-schnell) | Extract `flux_1_*_test.png`; same post-process | CC-BY-SA-4.0 (DRAGON) |
| `pixart` | **PixArt-α** images from **DRAGON** test set (model tag `PixArt_Alpha`) | Extract `pixart_alpha_*_test.png`; same post-process | CC-BY-SA-4.0 (DRAGON) |
| `openfake` | **OpenFake** core **test** split, `label=fake` only (**train-disjoint**) | Materialize from `ComplexDataLab/OpenFake` parquet `core/test-*`; save PNGs; same post-process | OpenFake / CC-BY-SA-4.0 terms |

**Forbidden construction (rejected by audit):** inventing abstract JS/PRNG textures and tagging them as SDXL / Flux / PixArt / OpenFake. Family tags must name the **actual** generator or legal generative set used.

Commercial gens (MJ / Firefly / GPT-image / Nano-Banana) may be **added** if legally obtainable; their absence does **not** license fake family tags. Named legal sources only — **no stolen commercial dumps**. CF eval is **not** the promotion set (this proxy is the admission set). CIFAKE is not used.

### Source materialization (operator)

```bash
# DRAGON test (example: first shard; extract model PNGs)
# https://huggingface.co/datasets/lesc-unifi/dragon
# Extract sdxl_*, flux_1_*, pixart_alpha_* test PNGs into:
#   $PROXY_DRAGON_DIR  (default /mnt/HC_Volume_105994188/poidh-cache/dragon_extract)

# OpenFake core test fakes → $PROXY_OPENFAKE_DIR
#   default /mnt/HC_Volume_105994188/poidh-cache/openfake_test

node eval/proxy/build_images.mjs
# or
bash eval/proxy/fetch.sh
```

Environment overrides: `PROXY_DRAGON_DIR`, `PROXY_OPENFAKE_DIR`.

---

## Corruptions

Applied at freeze time (stored bytes already corrupted):

| tag | transform |
|-----|-----------|
| `none` | PNG, metadata stripped |
| `jpeg_q70` | JPEG quality 70 |
| `jpeg_q40` | JPEG quality 40 |
| `webp` | WebP quality 80 |
| `screenshot` | Nearest downscale→upscale, then PNG (display-capture style) |

---

## Metadata stripped (AC-STRIP)

All stored proxy images are re-encoded so **EXIF / XMP / ICC orientation payloads are stripped**. Construction applies strip on every write (`build_images.mjs` re-encodes without attaching metadata). Do not reintroduce camera EXIF into frozen bytes.

---

## Counts (this freeze)

See `manifest.json` header and unit test:

- Total rows ≥ 200
- Real ≥ 100 (`coco-val2017`)
- AI ≥ 100 across **four** families: `sdxl`, `flux-schnell`, `pixart`, `openfake`

---

## Rebuild / fetch

```bash
# From repo root (network for COCO; pre-materialized AI dirs for DRAGON + OpenFake):
node eval/proxy/build_images.mjs
# or
bash eval/proxy/fetch.sh
```

After 4.1 starts, do **not** run rebuilds that change hashes without owner amendment.

---

## Scorer formula (standards E2)

- Attempted **N** = all manifest rows
- **skip-rate** = skips / N
- **BA** = (TPR + TNR) / 2 on **scored only** (A1: AI iff score ≥ 0.65)
- Skip is **not** the label `real`
- Pass only if **BA ≥ 0.750** and **skip-rate ≤ 0.10**

---

## Goldens

Ten images listed in `eval/goldens/README.md` are reserved for logit parity (extension ↔ CLI). They are **disjoint from train** and drawn from this freeze; their hashes must not enter 4.1 train.
