# Golden ten — logit parity protocol

> Reserved for extension ↔ CLI logit parity (H5 / E9). **Disjoint from train.**
>
> Do not use these hashes in 4.1 train, fine-tune, or calib.

## Protocol

1. Run the **same** locked preprocess (`src/preprocess.ts`) in the extension offscreen path and the eval CLI.
2. Score these **ten** images; compare logits / scores within the H5 tolerance (fp16: |Δz| tight; page BA within 1pp of extension file-walk when applicable).
3. Integration target (later sections): golden 10-image logit parity ±1e-3 where specified.
4. These rows are drawn from the frozen proxy and remain part of the **full** soul-7 set — goldens are not a substitute admission certificate.

## Hashes (source of truth)

| # | sha256 | relpath (under eval/proxy/) | label | family | corruption |
|---|--------|------------------------------|-------|--------|------------|
| 1 | `ed429899ac830ee6c96ef38e793e530594b79eed0dafe1eed1984c04d974c4b8` | `images/real/coco_000000000139_none.png` | real | coco-val2017 | none |
| 2 | `1b4e0c5fa87b19f62f8a694d3db2a79787df4ee17a53f9a72ffb53bfb9e072f6` | `images/real/coco_000000003934_jpeg_q70.jpg` | real | coco-val2017 | jpeg_q70 |
| 3 | `bb3af1ea767ef232cf43496cba9aec30f7273d092db7e599b8d49474d9c2086e` | `images/real/coco_000000007991_jpeg_q40.jpg` | real | coco-val2017 | jpeg_q40 |
| 4 | `f7c5db4afaaf131043b55166156098d17f932883aa7602a77dc58ddf4914f34c` | `images/real/coco_000000012670_webp.webp` | real | coco-val2017 | webp |
| 5 | `1b3f038e1f70dc3a01bbcf37e20afee543c1980817d52bf9899ddf7a26543538` | `images/real/coco_000000016598_screenshot.png` | real | coco-val2017 | screenshot |
| 6 | `8018ac70efec3a6f99a04a10b0f8469745d425dd0e32a2c1ad2277647addc2e8` | `images/ai/sdxl/sdxl_000_none.png` | ai | sdxl | none |
| 7 | `3d5906326e2bfe231d6481370b2c05f682ab865bb0f8dffb91d7027ffb753247` | `images/ai/sdxl/sdxl_001_jpeg_q70.jpg` | ai | sdxl | jpeg_q70 |
| 8 | `970885f43cc08e079837ef4a9743b515836bba3411bc385242556bd94efd3632` | `images/ai/sdxl/sdxl_002_jpeg_q40.jpg` | ai | sdxl | jpeg_q40 |
| 9 | `4df090a9276ad12a7f4bd5829f2e9f7a99ccf000b30351d5329fcd1aafcd676b` | `images/ai/sdxl/sdxl_003_webp.webp` | ai | sdxl | webp |
| 10 | `af17baad3d1e1e2633e09b054e71e5e6aacf04d36600a10895b471c70a029403` | `images/ai/sdxl/sdxl_004_screenshot.png` | ai | sdxl | screenshot |

## Disjointness

- **Train:** none of these sha256 values may appear in 4.1 training or calib sets.
- **Proxy freeze:** hashes are listed in `eval/proxy/manifest.json`; changing them requires owner amendment after 4.1 starts.
- **Anti-cheat (soul 9):** packaged `dist/` must not embed precomputed scores for these hashes.
