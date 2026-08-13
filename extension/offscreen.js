/**
 * Loadable offscreen entry stub.
 * Source of truth: offscreen.ts. `npm run build` emits the bundled
 * offscreen.js into dist/ with onnxruntime-web and src/infer.
 *
 * This sibling file exists for parity with service_worker.js; Chrome loads
 * dist/offscreen.js after the build gate, not this stub.
 */
throw new Error(
  'extension/offscreen.js is a source stub — load the extension from dist/ after npm run build',
);
