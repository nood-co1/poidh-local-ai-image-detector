import { defineConfig } from '@playwright/test';

/**
 * Playwright config for claim e2e (sections 2.3 offline + 3.1 autoscan).
 * Claim-critical suite: retries 0 (E9). Never mock ONNX.
 * Suites: e2e/offline.spec.ts, e2e/autoscan-*.spec.ts (see scripts/gate-full.d/).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  timeout: 300_000,
  expect: {
    timeout: 60_000,
  },
  reporter: process.env.CI
    ? [['list'], ['json', { outputFile: 'evidence/playwright-e2e.json' }]]
    : [['list']],
  use: {
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
});
