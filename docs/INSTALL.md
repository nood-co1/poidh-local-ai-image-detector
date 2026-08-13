# Install (load unpacked)

Maintainer path matching the e2e install job: build `dist/`, then load it in Chrome. No local server is required.

## Prerequisites

- Google Chrome (or Chromium) recent enough for Manifest V3
- Node.js 20+ to build from source

## Build the package

```bash
npm ci
npm run build
```

Confirm `dist/manifest.json` exists. The package root is **`dist/`**, not the repository root and not `extension/`.

## Load unpacked in Chrome

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select the **`dist/`** directory (the folder that contains `manifest.json`).
5. Confirm the extension appears: name **POIDH Local AI Image Detector**, version **0.1.0**, no errors.
6. Click the toolbar action. The popup must show **models not ready** and **Start setup** before first-run weight download.

### First-run model setup

1. In the popup, click **Start setup**.
2. The extension downloads the pinned public ONNX (`onnx/model.onnx`) and verifies SHA256, then stores ORT wasm/simd in OPFS or the Cache API (never `chrome.storage` for weights).
3. When finished, the popup shows **Ready** and a short SHA of the production ONNX.
4. Later launches do not re-fetch weight-host URLs while artifacts remain valid.

Pinned revision and hashes: `weights/manifest.json`.

### Expected checks

| Check | Expected |
|-------|----------|
| Extension list | Name **POIDH Local AI Image Detector**, version **0.1.0**, no errors |
| Popup (before setup) | **models not ready** + **Start setup** |
| Popup (after setup) | **Ready** + SHA256 short hash |
| Result / score cache | Empty at first install — scores appear only after live inference |
| Pages (after setup) | Eligible images (≥64px CSS) show `aidet-badge` scores |

### Failure classes

| Chrome message | Typical cause |
|----------------|---------------|
| Manifest file is missing or unreadable | Selected repo root or `extension/` instead of **`dist/`** after build |
| Required value `manifest_version` missing/invalid | Corrupt or non-MV3 `manifest.json` |
| Service worker registration failed | `background.service_worker` path does not resolve under `dist/` |
| Permission / host permission errors | Misspelled `permissions` / `host_permissions` keys |

Fix the path or manifest and use **Reload** on `chrome://extensions`.

## Public repository

https://github.com/nood-co1/poidh-local-ai-image-detector

MIT licensed — see [LICENSE](../LICENSE). Compile details: [BUILD.md](./BUILD.md).
