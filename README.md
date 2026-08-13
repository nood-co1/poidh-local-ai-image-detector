# POIDH Local AI Image Detector

MIT-licensed Chrome **Manifest V3** extension that scores already-displayed page images **on-device** (AI vs Real at threshold `0.65`) after a one-time public-weight download.

**Public repository:** https://github.com/nood-co1/poidh-local-ai-image-detector

Package name: `poidh-local-ai-image-detector`. Maintainer build and install docs: [docs/BUILD.md](./docs/BUILD.md), [docs/INSTALL.md](./docs/INSTALL.md).

## Requirements

- Google Chrome (or Chromium) recent enough for MV3
- Node.js 20+ (for typecheck / unit tests; **not** required to load the extension once built)

No local server is required to install or run the extension.

## Install from source (load unpacked)

Canonical path (soul 8 / repro): produce a loadable package, then load it in Chrome.

```bash
npm ci
npm run build    # writes dist/ (JS Chrome can load; not raw TypeScript)
```

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode** (toggle in the top-right).
3. Click **Load unpacked**.
4. Select the **`dist/`** directory (the folder that contains `manifest.json` after build).
5. Confirm the extension appears in the list. Click its action (toolbar icon) — the popup should say **models not ready** until you run setup.

No local server is required. Full steps: [docs/INSTALL.md](./docs/INSTALL.md).

### First-run model setup

1. Open the extension popup.
2. Click **Start setup**. The extension downloads the pinned Community Forensics ViT-S ONNX (`onnx/model.onnx`) and verifies SHA256, then copies ORT wasm/simd into OPFS or the Cache API (never `chrome.storage` for weights).
3. When finished, the popup shows **Ready** and a short SHA of the production ONNX.
4. A later launch does **not** re-fetch weight-host URLs while artifacts remain valid (matching hash is a no-op). Use **Retry** / **Re-verify** only to force recovery.

Pinned revision and hashes live in `weights/manifest.json`. Production ONNX under 20 MB is rejected as a dummy.

### What you should see

| Check | Expected |
|-------|----------|
| Extension list | Name **POIDH Local AI Image Detector**, version **0.1.0**, no errors |
| Popup (before setup) | Text: **models not ready** + **Start setup** |
| Popup (after setup) | **Ready** + SHA256 short hash |
| Pages | Eligible images (≥64px CSS) show `aidet-badge` scores automatically after setup |

### Failure class: Chrome rejects the package

If Chrome refuses to load the extension, the error is usually one of:

- **Manifest file is missing or unreadable** — you selected the repo root or `extension/` instead of **`dist/`** after `npm run build`.
- **Required value 'manifest_version' is missing or invalid** — `manifest.json` is not MV3 or is corrupt.
- **Service worker registration failed** — `background.service_worker` path does not resolve to a JS file in `dist/`.
- **Permission / host permission errors** — keys under `permissions` / `host_permissions` are misspelled or unsupported.

Fix the path or manifest keys and use **Reload** on `chrome://extensions`.

## Decision threshold

The only source of the decision threshold is:

```ts
// src/threshold.ts
export const THRESHOLD = 0.65;
```

UI, scorer, and docs must import this constant. Do not duplicate `0.65` elsewhere.

## Develop

```bash
npm ci
npm run build            # esbuild: extension + src → dist/
npm run gate:typecheck   # tsc --noEmit (one-shot)
npm run gate:test        # vitest run + eslint + docs-consistency (one-shot)
npm run gate:full        # typecheck + staged scripts/gate-full.d/*
npm test                 # same as gate:test
```

All gates are foreground, non-interactive, and never use watch mode.

Compile details: [docs/BUILD.md](./docs/BUILD.md).

## License

MIT — see [LICENSE](./LICENSE).

## Security

- No secrets in the repository. `scripts/check-secrets.sh` fails on common token patterns.
- Credential patterns (`.env`, `auth.env`, `*.pem`) are gitignored.
- Packaged `dist/` must not contain proxy/golden bench hashes or precomputed scores (`e2e/anticheat.spec.ts`).
- Result / score cache is empty at first install; scores come only from live on-device inference.
- Do not commit model weights with private keys or precomputed golden scores.
