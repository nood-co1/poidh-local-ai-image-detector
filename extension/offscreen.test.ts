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

  it('offscreen.ts uses infer + artifact-store + ort webgpu, not transformers.js', () => {
    const src = readFileSync(join(root, 'extension/offscreen.ts'), 'utf8');
    expect(src).toMatch(/from ['"]\.\.\/src\/infer\.js['"]/);
    expect(src).toMatch(/from ['"]\.\.\/src\/artifact-store\.js['"]/);
    expect(src).toMatch(/loadProductionOnnxBytes|loadFromArtifactStore|LOAD_FROM_STORE/);
    expect(src).toMatch(/onnxruntime-web\/webgpu/);
    expect(src).not.toMatch(/@xenova\/transformers|transformers\.js|image-classification/);
  });

  it('offscreen requires target===offscreen so SW relay is the only ANALYZE_IMAGE path', () => {
    // Untargeted ANALYZE_IMAGE would be delivered to both offscreen and SW;
    // SW re-sends with target:'offscreen', racing concurrent ORT session.run().
    const src = readFileSync(join(root, 'extension/offscreen.ts'), 'utf8');
    expect(src).toMatch(/msg\.target\s*!==\s*TARGET/);
    // Must not accept untargeted (legacy) messages for inference.
    expect(src).not.toMatch(/target\s*!==\s*undefined\s*&&\s*msg\.target\s*!==\s*TARGET/);
    const sw = readFileSync(join(root, 'extension/service_worker.ts'), 'utf8');
    expect(sw).toMatch(/target:\s*OFFSCREEN_TARGET/);
    expect(sw).toMatch(/ANALYZE_IMAGE/);
  });

  it('service worker creates offscreen document, relays ANALYZE_IMAGE, and runs setup', () => {
    const src = readFileSync(join(root, 'extension/service_worker.ts'), 'utf8');
    expect(src).toMatch(/chrome\.offscreen\.createDocument/);
    expect(src).toMatch(/ANALYZE_IMAGE/);
    expect(src).toMatch(/offscreen\.html/);
    expect(src).toMatch(/SETUP_ARTIFACTS/);
    expect(src).toMatch(/ARTIFACT_STATUS/);
    expect(src).toMatch(/CLEAR_ARTIFACTS/);
    expect(src).toMatch(/SCAN_TAB/);
    expect(src).toMatch(/from ['"]\.\/setup\.js['"]/);
  });

  it('manifest registers content script for page pixel scan (2.3)', () => {
    const manifest = readFileSync(join(root, 'extension/manifest.json'), 'utf8');
    const json = JSON.parse(manifest) as {
      content_scripts?: Array<{ js?: string[]; matches?: string[] }>;
      permissions?: string[];
    };
    expect(json.permissions).toContain('tabs');
    expect(json.content_scripts?.length).toBeGreaterThanOrEqual(1);
    const cs = json.content_scripts![0]!;
    expect(cs.js).toContain('content.js');
    expect(cs.matches?.some((m) => m.includes('http'))).toBe(true);
  });

  it('content script uses createImageBitmap on loaded img (no src re-GET primary)', () => {
    const src = readFileSync(join(root, 'extension/content.ts'), 'utf8');
    expect(src).toMatch(/createImageBitmap/);
    expect(src).toMatch(/SCAN_PAGE/);
    expect(src).toMatch(/ANALYZE_IMAGE/);
    // Must send raw image pixels, not rely on src fetch for the primary path.
    expect(src).toMatch(/image:\s*\{/);
    // Content must not re-GET img.src itself; online fallback is ANALYZE_IMAGE.src → offscreen.
    expect(src).not.toMatch(/fetch\s*\(\s*img\.src/);
    expect(src).toMatch(/IntersectionObserver/);
    expect(src).toMatch(/skip_cross_origin/);
    expect(src).toMatch(/skip_small/);
  });

  it('resultCache must not short-circuit ANALYZE_IMAGE / SCAN_PAGE (AC-MISS)', () => {
    const src = readFileSync(join(root, 'extension/content.ts'), 'utf8');
    // Overlay cache exists for scroll restore only.
    expect(src).toMatch(/resultCache/);
    expect(src).toMatch(/AC-CACHE|scroll restore|overlay/i);
    // analyzeOneImage must not return early from resultCache.get before sendMessage.
    // Reject the old short-circuit pattern: cache hit → return ANALYZE_RESULT without ANALYZE_IMAGE.
    expect(src).not.toMatch(
      /resultCache\.get\([^)]+\)[\s\S]{0,200}return\s*\{[\s\S]{0,120}type:\s*['"]ANALYZE_RESULT['"]/,
    );
    // Explicit statement that analysis always hits the endpoint.
    expect(src).toMatch(/Always hits ANALYZE_IMAGE|no resultCache short-circuit/i);
  });


  it('badge module exposes data-testid=aidet-badge (3.1)', () => {
    const src = readFileSync(join(root, 'extension/badge.ts'), 'utf8');
    expect(src).toMatch(/aidet-badge/);
    expect(src).toMatch(/attachShadow/);
    expect(src).toMatch(/unavailable/);
    // Skips must never render as real.
    expect(src).toMatch(/Never show "real" for skips/);
  });

  it('debug.html is test-only with a single Infer button', () => {
    const html = readFileSync(join(root, 'extension/debug.html'), 'utf8');
    expect(html).toMatch(/id=["']infer["']/);
    expect(html).toMatch(/debug\.js/);
    expect(html).toMatch(/test only|not soul-3/i);
  });
});

