import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Committed flat config — no first-run prompt, no interactive setup.
 * One-shot only (eslint never invoked with --watch from gates).
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'evidence/**',
      '.pipeline/**',
      'package-lock.json',
      // Built/copied static stubs and test-only debug companion.
      'extension/offscreen.js',
      'extension/debug.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        chrome: 'readonly',
      },
    },
    rules: {
      // Scaffold intentionally uses void to mark unused params in stubs.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
);
