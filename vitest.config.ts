import { defineConfig } from 'vitest/config';

/**
 * One-shot unit config. Gates always invoke `vitest run` — never watch.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'extension/**/*.test.ts'],
    // Explicitly disable watch; CI and Section Runner are non-interactive.
    watch: false,
    // Single-pass reporter; JSON evidence is written by gate-test.sh.
    passWithNoTests: false,
  },
});
