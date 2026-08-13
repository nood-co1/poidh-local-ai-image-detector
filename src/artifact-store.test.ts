/**
 * Artifact store unit tests (section 2.2 / E9).
 * - SHA mismatch rejects
 * - Matching hash is a no-op (no second fetch)
 * - Production ONNX under 20 MB is refused
 * - models_ready blocks weight-host network fetch
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MANIFEST,
  MemoryArtifactStorage,
  MIN_PRODUCTION_ONNX_BYTES,
  NetworkFetchRefusedError,
  READY_MARKER_ID,
  ShaMismatchError,
  clearAllArtifacts,
  ensureArtifacts,
  getArtifactStatus,
  getProductionOnnx,
  isModelsReady,
  isWeightHostUrl,
  listWasmArtifacts,
  sha256Hex,
  shortSha,
  type FetchLike,
  type Manifest,
  type ManifestArtifact,
} from './artifact-store.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function bytesOf(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

async function bufferWithHash(
  content: string,
): Promise<{ data: ArrayBuffer; sha256: string }> {
  const data = bytesOf(content);
  const sha256 = await sha256Hex(data);
  return { data, sha256 };
}

function makeManifest(
  artifacts: ManifestArtifact[],
  overrides: Partial<Manifest> = {},
): Manifest {
  return {
    version: 1,
    repo: 'test/repo',
    revision: 'abc123',
    minProductionOnnxBytes: MIN_PRODUCTION_ONNX_BYTES,
    artifacts,
    ...overrides,
  };
}

/** Build a fake production ONNX buffer of at least min size with known content prefix. */
async function bigOnnx(
  seed = 'CF-VIT-S-PRODUCTION',
  size = MIN_PRODUCTION_ONNX_BYTES + 64,
): Promise<{ data: ArrayBuffer; sha256: string }> {
  const buf = new Uint8Array(size);
  const prefix = new TextEncoder().encode(seed);
  buf.set(prefix, 0);
  for (let i = prefix.length; i < size; i++) {
    buf[i] = i % 251;
  }
  const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return { data, sha256: await sha256Hex(data) };
}

function trackingFetch(
  responses: Map<string, ArrayBuffer>,
): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetchFn: FetchLike = async (input) => {
    calls.push(input);
    const body = responses.get(input);
    if (!body) {
      return new Response(null, { status: 404, statusText: 'Not Found' });
    }
    return new Response(body.slice(0), {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  };
  return { fetch: fetchFn, calls };
}

describe('manifest pin (AC-REAL, AC-ALL)', () => {
  it('pins CF ViT-S official onnx/model.onnx revision and production size', () => {
    const onnx = getProductionOnnx(DEFAULT_MANIFEST);
    expect(DEFAULT_MANIFEST.repo).toBe(
      'buildborderless/CommunityForensics-DeepfakeDet-ViT',
    );
    expect(DEFAULT_MANIFEST.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(onnx.id).toBe('onnx/model.onnx');
    expect(onnx.role).toBe('production');
    expect(onnx.kind).toBe('onnx');
    expect(onnx.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(onnx.bytes ?? 0).toBeGreaterThanOrEqual(MIN_PRODUCTION_ONNX_BYTES);
    expect(onnx.url).toContain(DEFAULT_MANIFEST.revision);
    expect(onnx.url).toContain('onnx/model.onnx');
    // Must not pin INT8/Q4 as production.
    expect(onnx.url).not.toMatch(/int8|q4|uint8|quantized/i);
  });

  it('lists ORT wasm/simd artifacts in the manifest (AC-ALL)', () => {
    const wasm = listWasmArtifacts(DEFAULT_MANIFEST);
    expect(wasm.length).toBeGreaterThanOrEqual(2);
    const ids = wasm.map((w) => w.id).join(' ');
    expect(ids).toMatch(/ort-wasm-simd/);
    for (const w of wasm) {
      expect(w.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(w.kind).toBe('wasm');
    }
  });

  it('vendored config asserts num_labels=1 and heads=6', () => {
    const cfgPath = join(root, 'weights/config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
      num_labels: number;
      num_attention_heads: number;
    };
    expect(cfg.num_labels).toBe(1);
    expect(cfg.num_attention_heads).toBe(6);

    const art = DEFAULT_MANIFEST.artifacts.find((a) => a.kind === 'config');
    expect(art?.assert?.num_labels).toBe(1);
    expect(art?.assert?.num_attention_heads).toBe(6);
  });

  it('never writes weights via chrome.storage (source guard)', () => {
    const src = readFileSync(join(root, 'src/artifact-store.ts'), 'utf8');
    // Must not call chrome.storage for binary persistence.
    expect(src).not.toMatch(/chrome\.storage\.(local|sync|session)\.(set|get)/);
    expect(src).toMatch(/OPFS|getDirectory|caches\.open|CacheApi/);
  });
});

describe('sha256 helpers', () => {
  it('hashes known vector', async () => {
    // sha256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    const empty = await sha256Hex(new ArrayBuffer(0));
    expect(empty).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(shortSha(empty)).toBe('e3b0c44298fc');
  });
});

describe('ensureArtifacts — SHA reject / no-op (AC-SHA, E6)', () => {
  it('rejects SHA mismatch on download', async () => {
    const { data } = await bigOnnx('wrong-payload');
    const expectedSha = 'a'.repeat(64);
    const url = 'https://huggingface.co/test/model.onnx';
    const manifest = makeManifest([
      {
        id: 'onnx/model.onnx',
        role: 'production',
        kind: 'onnx',
        url,
        sha256: expectedSha,
        bytes: data.byteLength,
      },
    ]);
    const storage = new MemoryArtifactStorage();
    const { fetch, calls } = trackingFetch(new Map([[url, data]]));

    const result = await ensureArtifacts({
      manifest,
      storage,
      fetch,
      resolveUrl: (a) => a.url,
    });

    expect(result.ready).toBe(false);
    expect(result.error).toMatch(/SHA256 mismatch/i);
    expect(calls).toEqual([url]);
    expect(await storage.has('onnx/model.onnx')).toBe(false);
    // Surface as ShaMismatchError message class for AC-SHA.
    expect(result.error).toContain(expectedSha);
    void ShaMismatchError;
  });

  it('matching hash is a no-op on second ensure (no second fetch)', async () => {
    const onnx = await bigOnnx('seed-ok');
    const cfg = await bufferWithHash(
      JSON.stringify({ num_labels: 1, num_attention_heads: 6 }),
    );
    const wasm = await bufferWithHash('fake-wasm-bytes');

    const urls = {
      onnx: 'https://huggingface.co/test/onnx/model.onnx',
      cfg: 'https://huggingface.co/test/config.json',
      wasm: 'wasm/ort-wasm-simd-threaded.wasm',
    };

    const manifest = makeManifest([
      {
        id: 'onnx/model.onnx',
        role: 'production',
        kind: 'onnx',
        url: urls.onnx,
        sha256: onnx.sha256,
        bytes: onnx.data.byteLength,
      },
      {
        id: 'config.json',
        role: 'config',
        kind: 'config',
        url: urls.cfg,
        sha256: cfg.sha256,
        assert: { num_labels: 1, num_attention_heads: 6 },
      },
      {
        id: 'wasm/ort-wasm-simd-threaded.wasm',
        role: 'runtime',
        kind: 'wasm',
        url: urls.wasm,
        packagePath: urls.wasm,
        sha256: wasm.sha256,
      },
    ]);

    const responses = new Map<string, ArrayBuffer>([
      [urls.onnx, onnx.data],
      [urls.cfg, cfg.data],
      [urls.wasm, wasm.data],
    ]);
    const storage = new MemoryArtifactStorage();
    const first = trackingFetch(responses);

    const setup1 = await ensureArtifacts({
      manifest,
      storage,
      fetch: first.fetch,
      resolveUrl: (a) => a.url,
    });

    expect(setup1.ready).toBe(true);
    expect(setup1.noop).toBe(false);
    expect(setup1.fetched.sort()).toEqual(
      ['onnx/model.onnx', 'config.json', 'wasm/ort-wasm-simd-threaded.wasm'].sort(),
    );
    expect(setup1.sha256).toBe(onnx.sha256);
    expect(first.calls.length).toBe(3);

    // Second launch: same storage, fresh fetch tracker — must not call fetch.
    const second = trackingFetch(responses);
    const setup2 = await ensureArtifacts({
      manifest,
      storage,
      fetch: second.fetch,
      resolveUrl: (a) => a.url,
    });

    expect(setup2.ready).toBe(true);
    expect(setup2.noop).toBe(true);
    expect(setup2.fetched).toEqual([]);
    expect(setup2.skipped.length).toBe(3);
    expect(second.calls).toEqual([]);
    expect(await isModelsReady({ storage, manifest })).toBe(true);
  });

  it('refuses production ONNX under 20 MB (no dummy)', async () => {
    const tiny = bytesOf('not-a-real-onnx');
    const sha = await sha256Hex(tiny);
    const url = 'https://huggingface.co/test/tiny.onnx';
    const manifest = makeManifest([
      {
        id: 'onnx/model.onnx',
        role: 'production',
        kind: 'onnx',
        url,
        sha256: sha,
        bytes: tiny.byteLength,
      },
    ]);
    const storage = new MemoryArtifactStorage();
    const { fetch } = trackingFetch(new Map([[url, tiny]]));

    const result = await ensureArtifacts({
      manifest,
      storage,
      fetch,
      resolveUrl: (a) => a.url,
    });

    expect(result.ready).toBe(false);
    expect(result.error).toMatch(/too small|dummy|stub|20/i);
  });

  it('after Ready, refuses weight-host re-fetch without force (AC-ONCE)', async () => {
    const onnx = await bigOnnx('once');
    const url = 'https://huggingface.co/test/onnx/model.onnx';
    const manifest = makeManifest([
      {
        id: 'onnx/model.onnx',
        role: 'production',
        kind: 'onnx',
        url,
        sha256: onnx.sha256,
        bytes: onnx.data.byteLength,
      },
    ]);
    const storage = new MemoryArtifactStorage();
    const { fetch: fetch1 } = trackingFetch(new Map([[url, onnx.data]]));

    const ok = await ensureArtifacts({
      manifest,
      storage,
      fetch: fetch1,
      resolveUrl: (a) => a.url,
    });
    expect(ok.ready).toBe(true);

    // Corrupt / delete the blob while leaving models_ready marker.
    await storage.delete('onnx/model.onnx');
    // Re-write marker only path: marker remains if we only delete onnx —
    // ensureArtifacts wrote marker; after delete of onnx, marker still present.
    expect((await getArtifactStatus({ storage, manifest })).modelsReadyMarker).toBe(
      true,
    );

    const calls: string[] = [];
    const fetchBlocked: FetchLike = async (input) => {
      calls.push(input);
      return new Response(onnx.data.slice(0), { status: 200 });
    };

    const refused = await ensureArtifacts({
      manifest,
      storage,
      fetch: fetchBlocked,
      resolveUrl: (a) => a.url,
      force: false,
    });

    expect(refused.ready).toBe(false);
    expect(refused.error).toMatch(/refusing network fetch|models_ready/i);
    // Weight-host URL must not have been requested.
    expect(calls.every((c) => !isWeightHostUrl(c) || false)).toBe(true);
    expect(calls).toEqual([]);
    void NetworkFetchRefusedError;
  });

  it('force:true (Retry) may re-download after Ready', async () => {
    const onnx = await bigOnnx('force-retry');
    const url = 'https://huggingface.co/test/onnx/model.onnx';
    const manifest = makeManifest([
      {
        id: 'onnx/model.onnx',
        role: 'production',
        kind: 'onnx',
        url,
        sha256: onnx.sha256,
        bytes: onnx.data.byteLength,
      },
    ]);
    const storage = new MemoryArtifactStorage();
    const { fetch: fetch1 } = trackingFetch(new Map([[url, onnx.data]]));
    await ensureArtifacts({
      manifest,
      storage,
      fetch: fetch1,
      resolveUrl: (a) => a.url,
    });
    await storage.delete('onnx/model.onnx');

    const second = trackingFetch(new Map([[url, onnx.data]]));
    const result = await ensureArtifacts({
      manifest,
      storage,
      fetch: second.fetch,
      resolveUrl: (a) => a.url,
      force: true,
    });

    expect(result.ready).toBe(true);
    expect(second.calls).toEqual([url]);
  });
});

describe('getArtifactStatus', () => {
  it('reports not ready on empty storage', async () => {
    const storage = new MemoryArtifactStorage();
    const status = await getArtifactStatus({
      storage,
      manifest: makeManifest([
        {
          id: 'onnx/model.onnx',
          role: 'production',
          kind: 'onnx',
          url: 'https://example.com/m.onnx',
          sha256: 'b'.repeat(64),
        },
      ]),
    });
    expect(status.ready).toBe(false);
    expect(status.modelsReadyMarker).toBe(false);
  });
});

describe('clearAllArtifacts (AC-MISS helper)', () => {
  it('removes artifacts and ready marker so isModelsReady is false', async () => {
    const onnx = await bigOnnx('clear-me');
    const url = 'https://huggingface.co/test/onnx/model.onnx';
    const manifest = makeManifest([
      {
        id: 'onnx/model.onnx',
        role: 'production',
        kind: 'onnx',
        url,
        sha256: onnx.sha256,
        bytes: onnx.data.byteLength,
      },
    ]);
    const storage = new MemoryArtifactStorage();
    const { fetch } = trackingFetch(new Map([[url, onnx.data]]));
    const setup = await ensureArtifacts({
      manifest,
      storage,
      fetch,
      resolveUrl: (a) => a.url,
    });
    expect(setup.ready).toBe(true);
    expect(await isModelsReady({ storage, manifest })).toBe(true);

    const cleared = await clearAllArtifacts({ storage, manifest });
    expect(cleared.cleared).toContain('onnx/model.onnx');
    expect(cleared.cleared).toContain(READY_MARKER_ID);
    expect(await storage.has('onnx/model.onnx')).toBe(false);
    expect(await storage.has(READY_MARKER_ID)).toBe(false);
    expect(await isModelsReady({ storage, manifest })).toBe(false);
  });
});
