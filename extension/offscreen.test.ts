/**
 * Lightweight checks that the offscreen entry + manifest wiring is present
 * (AC-EP, AC-CSP). Runtime Chrome APIs are not exercised here.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('offscreen MV3 wiring', () => {
  it('manifest lists offscreen permission and wasm-unsafe-eval CSP (AC-EP, AC-CSP)', () => {
    const manifest = readFileSync(join(root, 'extension/manifest.json'), 'utf8');
    const json = JSON.parse(manifest) as {
      permissions?: string[];
      content_security_policy?: { extension_pages?: string };
    };
    expect(json.permissions).toContain('offscreen');
    const csp = json.content_security_policy?.extension_pages ?? '';
    expect(csp).toContain('wasm-unsafe-eval');
    expect(csp).toContain("script-src 'self'");
  });

  it('offscreen.html loads offscreen.js as a module', () => {
    const html = readFileSync(join(root, 'extension/offscreen.html'), 'utf8');
    expect(html).toMatch(/offscreen\.js/);
    expect(html).toMatch(/type=["']module["']/);
  });

  it('offscreen.ts uses infer + ort webgpu, not transformers.js', () => {
    const src = readFileSync(join(root, 'extension/offscreen.ts'), 'utf8');
    expect(src).toMatch(/from ['"]\.\.\/src\/infer\.js['"]/);
    expect(src).toMatch(/onnxruntime-web\/webgpu/);
    expect(src).not.toMatch(/@xenova\/transformers|transformers\.js|image-classification/);
  });

  it('service worker creates offscreen document and relays ANALYZE_IMAGE', () => {
    const src = readFileSync(join(root, 'extension/service_worker.ts'), 'utf8');
    expect(src).toMatch(/chrome\.offscreen\.createDocument/);
    expect(src).toMatch(/ANALYZE_IMAGE/);
    expect(src).toMatch(/offscreen\.html/);
  });
});
