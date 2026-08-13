import { defineConfig } from '@playwright/test';

/**
 * Playwright config for claim e2e (section 2.3+).
 * Claim-critical suite: retries 0 (E9). Never mock ONNX.
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
    ? [['list'], ['json', { outputFile: 'evidence/playwright-offline.json' }]]
    : [['list']],
  use: {
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
});
