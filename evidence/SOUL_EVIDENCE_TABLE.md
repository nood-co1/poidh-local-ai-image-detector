# Soul evidence table — poidh-aidet (runtime paths)

> **Purpose:** Product-repo map of soul → e2e / gate log paths.  
> **Not** a planning checklist (control-plane BUILD_CHECKLIST stays in RUNS_DIR).  
> **Checker:** `node scripts/check-evidence.mjs` — no REQUIRED row may be SKIPPED; proxy-ba SHA must match `git rev-parse HEAD`.

**Claim SHA:** fill at gate time via `proxy-ba-<HEAD>.json` (see soul 7).  
**Keystone:** `e2e/keystone.spec.ts` (I12 Monday path, retries 0).  
**G-TEST-SENSITIVITY:** disposable mutant — remove badge mount in `extension/badge.ts` (`attachBadge` no-op) → keystone fails (no numeric `data-testid=aidet-badge`). Documented here and in keystone header for 5.1.

| soul_id | required | status | evidence_path | notes |
|---------|----------|--------|---------------|-------|
| SOUL-1 | REQUIRED | PASS | `extension/manifest.json`; `e2e/keystone.spec.ts`; `scripts/gate-build.sh` | JOB-INSTALL-01 — load unpacked from dist/ |
| SOUL-2 | REQUIRED | PASS | `e2e/keystone.spec.ts`; `e2e/offline.spec.ts`; `weights/manifest.json` | JOB-SETUP-01 — one-time download, Ready + weight_sha |
| SOUL-3 | REQUIRED | PASS | `e2e/offline.spec.ts`; `e2e/keystone.spec.ts`; `evidence/playwright-offline.json` | JOB-OFFLINE-01 — load images → offline → scan pixels |
| SOUL-4 | REQUIRED | PASS | `e2e/autoscan-sameorigin.spec.ts`; `e2e/autoscan-crossorigin.spec.ts`; `e2e/keystone.spec.ts` | JOB-SCAN-01 — same-origin + cross-origin badges |
| SOUL-5 | REQUIRED | PASS | `e2e/threshold.spec.ts`; `e2e/keystone.spec.ts`; `src/threshold.ts` | JOB-SCORE-01 — score + A1 @ 0.65 |
| SOUL-6 | REQUIRED | PASS | `e2e/privacy-har.spec.ts`; `e2e/keystone.spec.ts`; `src/allowlist.ts` | JOB-PRIVACY-01 — SW-inclusive HAR online segment |
| SOUL-7 | REQUIRED | PASS | `evidence/proxy-ba-<HEAD>.json`; `e2e/proxy-ba.spec.ts`; `e2e/keystone.spec.ts` | JOB-PROXY-01 — extension BA cert; SHA must = HEAD |
| SOUL-8 | REQUIRED | PASS | `scripts/gate-build.sh`; `scripts/gate-full.sh`; `package.json` | JOB-REPRO-01 — npm ci && build → dist/ |
| SOUL-9 | OPEN | OPEN | `e2e/anticheat.spec.ts` | JOB-ANTICHEAT-01 — owner 5.1; not REQUIRED until 5.1 |

## Log files written by gates

| log | writer | role |
|-----|--------|------|
| `evidence/playwright-e2e.json` | Playwright CI reporter (`CI=1`) | e2e claim suite dump |
| `evidence/playwright-offline.json` | offline unit gate (15-offline) | soul 3 offline proof |
| `evidence/proxy-ba-<gitsha>.json` | `e2e/proxy-ba.spec.ts` via 30-proxy-ba | soul 7 admission certificate |
| `evidence/gate-test.json` | `scripts/gate-test.sh` | unit + eslint + docs gate summary |

## I16 same-value proof (keystone)

| field | UI / runtime | proxy-ba JSON |
|-------|--------------|---------------|
| threshold | popup `#threshold-rule`, `src/threshold.ts` | `threshold: 0.65` |
| score | badge text `[0,1] ai\|real` | scored rows under BA formula |
| weight_sha | popup `#sha`, ARTIFACT_STATUS | `modelSha256` |
| skip_reason | badge `unavailable` + SCAN_TAB | skip-rate / per-row skips |

Exact status values for REQUIRED rows: **PASS** only (no partial, no SKIP).
