# Build

Maintainer instructions for producing a loadable Chrome MV3 package from this repository.

## Requirements

- Node.js 20+
- npm (ships with Node)

No GPU, no local model server, and no external inference API are required to **compile**.

## Compile

From the repository root:

```bash
npm ci
npm run build
```

`npm run build` runs `scripts/gate-build.sh`, which:

1. Bundles extension TypeScript/JS with esbuild into `dist/`
2. Copies `extension/manifest.json` and static HTML into `dist/`
3. Vendors ORT wasm/simd into `dist/wasm/`
4. Copies pinned `weights/manifest.json` and `weights/config.json` into `dist/weights/`

The loadable package root is **`dist/`** (the directory that contains `manifest.json`).

## Verify the package

```bash
# Typecheck only
npm run typecheck

# Unit + lint + docs-consistency
npm test

# Full CI (typecheck + staged hooks under scripts/gate-full.d/)
npm run gate:full
```

All gates are one-shot and non-interactive (no watch mode).

## What is not in the build

- Production ONNX weights are **not** embedded; first-run setup downloads the SHA-pinned Community Forensics ViT-S file.
- Proxy / golden bench image hashes and precomputed scores are **not** packaged into `dist/`.
- Internal programme planning and audit artefacts stay outside this public tree.

## Public repository

https://github.com/blockbrain-ai/poidh-local-ai-image-detector

See [INSTALL.md](./INSTALL.md) for loading the built package in Chrome.
