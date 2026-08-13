/**
 * Spec 3.3 — Privacy allowlist unit tests (E9).
 *
 * Adversarial:
 *   - POST/WS with image bytes → fail
 *   - post-setup path-based model/wasm/tokenizer GET → fail
 *   - HF host serving a fixture image GET → allow
 *   - GET of displayed image URL → allow
 */

import { describe, expect, it } from 'vitest';
import {
  carriesImageBytes,
  classifyRequest,
  evaluateHar,
  isDisplayedImageUrl,
  isLocalOrExtensionUrl,
  isModelArtifactUrl,
  isNetworkUrl,
  requestPath,
  type NetworkRequest,
} from './allowlist.js';

describe('path helpers', () => {
  it('requestPath strips origin and keeps path', () => {
    expect(
      requestPath(
        'https://huggingface.co/org/repo/resolve/main/onnx/model.onnx',
      ),
    ).toBe('/org/repo/resolve/main/onnx/model.onnx');
  });

  it('isNetworkUrl / isLocalOrExtensionUrl', () => {
    expect(isNetworkUrl('https://example.com/a.png')).toBe(true);
    expect(isNetworkUrl('chrome-extension://abc/wasm/x.wasm')).toBe(false);
    expect(isLocalOrExtensionUrl('chrome-extension://abc/offscreen.html')).toBe(
      true,
    );
    expect(isLocalOrExtensionUrl('blob:https://x/1')).toBe(true);
    expect(isLocalOrExtensionUrl('https://example.com/a.png')).toBe(false);
  });
});

describe('isModelArtifactUrl (path-based, not host-based)', () => {
  it('flags .onnx / .wasm / tokenizer paths on any host', () => {
    expect(
      isModelArtifactUrl(
        'https://huggingface.co/buildborderless/CommunityForensics-DeepfakeDet-ViT/resolve/ac6ee457bea904a373065754107451793b56db00/onnx/model.onnx',
      ),
    ).toBe(true);
    expect(
      isModelArtifactUrl('https://cdn.example.com/weights/model.onnx?download=1'),
    ).toBe(true);
    expect(
      isModelArtifactUrl(
        'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
      ),
    ).toBe(true);
    expect(
      isModelArtifactUrl('https://hf.co/x/resolve/main/tokenizer.json'),
    ).toBe(true);
    expect(
      isModelArtifactUrl('https://hf.co/x/resolve/main/tokenizer_config.json'),
    ).toBe(true);
    expect(isModelArtifactUrl('https://hf.co/x/resolve/main/vocab.txt')).toBe(
      true,
    );
    expect(
      isModelArtifactUrl('https://hf.co/x/resolve/main/model.safetensors'),
    ).toBe(true);
  });

  it('does NOT flag fixture images even on Hugging Face (path-based)', () => {
    expect(
      isModelArtifactUrl(
        'https://huggingface.co/datasets/foo/resolve/main/images/real_a.png',
      ),
    ).toBe(false);
    expect(
      isModelArtifactUrl('https://images.cocodataset.org/val2017/000000000139.jpg'),
    ).toBe(false);
    expect(
      isModelArtifactUrl('http://127.0.0.1:8765/assets/real_a.png'),
    ).toBe(false);
  });
});

describe('isDisplayedImageUrl', () => {
  it('matches common image extensions and resourceType', () => {
    expect(isDisplayedImageUrl('http://127.0.0.1/assets/ai_a.png')).toBe(true);
    expect(isDisplayedImageUrl('https://x.test/photo.JPEG')).toBe(true);
    expect(isDisplayedImageUrl('https://x.test/blob', 'image')).toBe(true);
    expect(isDisplayedImageUrl('https://x.test/api/score')).toBe(false);
  });
});

describe('carriesImageBytes / adversarial POST', () => {
  it('detects Content-Type image/* on POST', () => {
    expect(
      carriesImageBytes('POST', null, { 'Content-Type': 'image/png' }),
    ).toBe(true);
  });

  it('detects PNG magic in POST body', () => {
    const png = `\x89PNG\r\n\x1a\n${'x'.repeat(32)}`;
    expect(carriesImageBytes('POST', png, null)).toBe(true);
  });

  it('detects data:image URL and large base64 image JSON fields', () => {
    expect(
      carriesImageBytes('POST', 'data:image/png;base64,iVBORw0KGgoAAA=', null),
    ).toBe(true);
    const b64 = 'A'.repeat(300);
    expect(
      carriesImageBytes(
        'POST',
        JSON.stringify({ image: b64 }),
        { 'content-type': 'application/json' },
      ),
    ).toBe(true);
  });

  it('detects multipart filename=*.png', () => {
    const body =
      '------bound\r\nContent-Disposition: form-data; name="f"; filename="x.png"\r\n\r\nbytes';
    expect(
      carriesImageBytes('POST', body, {
        'content-type': 'multipart/form-data; boundary=----bound',
      }),
    ).toBe(true);
  });

  it('WebSocket with image payload is flagged', () => {
    const png = `\x89PNG\r\n\x1a\n${'y'.repeat(16)}`;
    expect(
      carriesImageBytes('GET', png, null, 'websocket'),
    ).toBe(true);
    expect(carriesImageBytes('WebSocket', png, null)).toBe(true);
  });

  it('plain GET and non-image POST are not flagged', () => {
    expect(carriesImageBytes('GET', null, null, 'image')).toBe(false);
    expect(
      carriesImageBytes(
        'POST',
        JSON.stringify({ score: 0.5 }),
        { 'content-type': 'application/json' },
      ),
    ).toBe(false);
  });
});

describe('classifyRequest', () => {
  it('adversarial: POST image bytes → post_image', () => {
    const verdict = classifyRequest(
      {
        url: 'https://evil.example/upload',
        method: 'POST',
        postData: 'data:image/png;base64,iVBORw0KGgo=',
        headers: { 'content-type': 'application/json' },
      },
      { modelsReady: true },
    );
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.violation).toBe('post_image');
    }
  });

  it('adversarial: post-setup HF model.onnx GET → model_fetch', () => {
    const url =
      'https://huggingface.co/buildborderless/CommunityForensics-DeepfakeDet-ViT/resolve/ac6ee457bea904a373065754107451793b56db00/onnx/model.onnx';
    const verdict = classifyRequest(
      { url, method: 'GET', resourceType: 'fetch' },
      { modelsReady: true },
    );
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.violation).toBe('model_fetch');
      expect(verdict.reason).toMatch(/model\/wasm\/tokenizer/i);
    }
  });

  it('adversarial: post-setup wasm GET on non-HF host → model_fetch', () => {
    const verdict = classifyRequest(
      {
        url: 'https://cdn.example.com/ort-wasm-simd-threaded.wasm',
        method: 'GET',
      },
      { modelsReady: true },
    );
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.violation).toBe('model_fetch');
    }
  });

  it('adversarial: post-setup tokenizer GET → model_fetch', () => {
    const verdict = classifyRequest(
      {
        url: 'https://huggingface.co/x/resolve/main/tokenizer.json',
        method: 'GET',
      },
      { modelsReady: true },
    );
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.violation).toBe('model_fetch');
    }
  });

  it('during setup (modelsReady=false), model GET is not blocked by allowlist', () => {
    const verdict = classifyRequest(
      {
        url: 'https://huggingface.co/x/resolve/main/onnx/model.onnx',
        method: 'GET',
      },
      { modelsReady: false },
    );
    expect(verdict.allowed).toBe(true);
  });

  it('AC-GET: displayed image URL GET is permitted', () => {
    const verdict = classifyRequest(
      {
        url: 'http://127.0.0.1:8765/assets/real_a.png',
        method: 'GET',
        resourceType: 'image',
      },
      { modelsReady: true },
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toMatch(/displayed image|online fallback/i);
  });

  it('HF serving a fixture image (not model path) is permitted after ready', () => {
    const verdict = classifyRequest(
      {
        url: 'https://huggingface.co/datasets/foo/resolve/main/fixtures/ai_b.png',
        method: 'GET',
      },
      { modelsReady: true },
    );
    expect(verdict.allowed).toBe(true);
  });

  it('chrome-extension package wasm is local, not model_fetch', () => {
    const verdict = classifyRequest(
      {
        url: 'chrome-extension://abcdefghijklmnop/wasm/ort-wasm-simd-threaded.wasm',
        method: 'GET',
      },
      { modelsReady: true },
    );
    expect(verdict.allowed).toBe(true);
  });
});

describe('evaluateHar', () => {
  it('aggregates violations, SW requests, and allowed image GETs', () => {
    const requests: NetworkRequest[] = [
      {
        url: 'chrome-extension://id/service_worker.js',
        method: 'GET',
        fromServiceWorker: true,
      },
      {
        url: 'http://127.0.0.1:9/assets/real_a.png',
        method: 'GET',
        resourceType: 'image',
        fromServiceWorker: false,
      },
      {
        url: 'https://huggingface.co/x/resolve/main/onnx/model.onnx',
        method: 'GET',
        fromServiceWorker: true,
      },
      {
        url: 'https://evil.test/upload',
        method: 'POST',
        postData: 'data:image/jpeg;base64,/9j/4AAQ',
        fromServiceWorker: false,
      },
    ];

    const result = evaluateHar(requests, { modelsReady: true });
    expect(result.ok).toBe(false);
    expect(result.serviceWorkerRequests.length).toBe(2);
    expect(result.allowedImageGets.length).toBe(1);
    expect(result.violations.map((v) => v.verdict.violation).sort()).toEqual(
      ['model_fetch', 'post_image'].sort(),
    );
  });

  it('clean scan log (images + extension only) is ok', () => {
    const result = evaluateHar(
      [
        {
          url: 'chrome-extension://id/offscreen.html',
          method: 'GET',
          fromServiceWorker: true,
        },
        {
          url: 'http://127.0.0.1:1/assets/ai_a.png',
          method: 'GET',
          resourceType: 'image',
        },
        {
          url: 'http://127.0.0.1:2/assets/real_b.png',
          method: 'GET',
        },
      ],
      { modelsReady: true },
    );
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.allowedImageGets.length).toBe(2);
    expect(result.serviceWorkerRequests.length).toBe(1);
  });
});
