/**
 * One-time inference artifact store (section 2.2).
 * Standards E2 (no post-ready egress of inference assets) / E6 (upsert-by-SHA no-op).
 *
 * - First setup downloads ONNX + ORT wasm/simd (+ config), verifies SHA256
 * - Persists to OPFS (preferred) or Cache API — never chrome.storage for weights
 * - After models_ready: matching local hashes are a no-op; network fetch of
 *   inference assets is refused unless `force: true` (explicit Retry)
 */

import pinnedManifest from '../weights/manifest.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Production ONNX must be at least 20 MiB (reject stubs / dummy exports). */
export const MIN_PRODUCTION_ONNX_BYTES = 20 * 1024 * 1024;

/** Cache API bucket for binary artifacts. */
export const CACHE_NAME = 'poidh-artifacts-v1';

/** OPFS subdirectory name. */
export const OPFS_DIR = 'poidh-artifacts';

/** Marker file written after a successful verified setup (not chrome.storage). */
export const READY_MARKER_ID = 'models_ready.json';

/** Default pinned manifest (bundled). Tests may pass overrides. */
export const DEFAULT_MANIFEST = pinnedManifest as Manifest;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ArtifactKind = 'onnx' | 'wasm' | 'config' | string;
export type ArtifactRole = 'production' | 'runtime' | 'config' | string;

export interface ArtifactAssert {
  num_labels?: number;
  num_attention_heads?: number;
  [key: string]: unknown;
}

export interface ManifestArtifact {
  id: string;
  role: ArtifactRole;
  kind: ArtifactKind;
  /** Absolute weight-host URL or package-relative path. */
  url: string;
  /** Optional path under the extension package (wasm vendored in dist/). */
  packagePath?: string;
  sha256: string;
  bytes?: number;
  assert?: ArtifactAssert;
}

export interface Manifest {
  version: number;
  repo: string;
  revision: string;
  minProductionOnnxBytes: number;
  notes?: string;
  artifacts: ManifestArtifact[];
}

export interface ArtifactStatus {
  ready: boolean;
  /** Full SHA256 of the production ONNX when ready. */
  sha256: string | null;
  /** First 12 hex chars of the production ONNX SHA (popup display). */
  sha256Short: string | null;
  /** Storage backend in use. */
  backend: 'opfs' | 'cache' | 'memory' | 'unknown';
  /** Human-readable detail when not ready. */
  error?: string;
  /** True when a prior setup completed (marker present). */
  modelsReadyMarker: boolean;
}

export interface SetupResult {
  ready: boolean;
  /** true when no network download was performed (local match / no-op). */
  noop: boolean;
  sha256: string | null;
  sha256Short: string | null;
  backend: ArtifactStatus['backend'];
  /** Artifact ids that were fetched from the network (or package URL). */
  fetched: string[];
  /** Artifact ids that were already present with matching hash. */
  skipped: string[];
  error?: string;
}

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<Response>;

/**
 * Binary artifact persistence. Weights never go through chrome.storage.
 */
export interface ArtifactStorage {
  readonly backend: ArtifactStatus['backend'];
  get(id: string): Promise<ArrayBuffer | null>;
  put(id: string, data: ArrayBuffer): Promise<void>;
  has(id: string): Promise<boolean>;
  delete(id: string): Promise<void>;
}

export interface EnsureArtifactsOptions {
  /** When true, allow re-download even if models_ready (user Retry). */
  force?: boolean;
  /** Injected fetch (tests). Defaults to global fetch. */
  fetch?: FetchLike;
  /** Injected storage (tests). Defaults to OPFS → Cache API. */
  storage?: ArtifactStorage;
  /** Override manifest (tests). */
  manifest?: Manifest;
  /**
   * Resolve a manifest URL to an absolute fetchable URL.
   * Defaults to chrome.runtime.getURL for relative package paths.
   */
  resolveUrl?: (artifact: ManifestArtifact) => string;
}

// ---------------------------------------------------------------------------
// SHA-256
// ---------------------------------------------------------------------------

/**
 * Hex-encode a SHA-256 digest of the given buffer.
 * Uses Web Crypto (browser + Node 20+).
 */
export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes =
    data instanceof Uint8Array
      ? data
      : new Uint8Array(data);
  // Ensure an ArrayBuffer-backed view for SubtleCrypto (avoid SharedArrayBuffer).
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return bufferToHex(digest);
}

function bufferToHex(buf: ArrayBuffer): string {
  const arr = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < arr.length; i++) {
    out += arr[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

export function shortSha(sha256: string, len = 12): string {
  return sha256.slice(0, len);
}

// ---------------------------------------------------------------------------
// Storage backends
// ---------------------------------------------------------------------------

/** In-memory store for unit tests. Never used for production weights. */
export class MemoryArtifactStorage implements ArtifactStorage {
  readonly backend = 'memory' as const;
  private readonly map = new Map<string, ArrayBuffer>();

  async get(id: string): Promise<ArrayBuffer | null> {
    const v = this.map.get(id);
    return v ? v.slice(0) : null;
  }

  async put(id: string, data: ArrayBuffer): Promise<void> {
    this.map.set(id, data.slice(0));
  }

  async has(id: string): Promise<boolean> {
    return this.map.has(id);
  }

  async delete(id: string): Promise<void> {
    this.map.delete(id);
  }

  clear(): void {
    this.map.clear();
  }
}

/** OPFS-backed store (preferred). */
export class OpfsArtifactStorage implements ArtifactStorage {
  readonly backend = 'opfs' as const;
  private root: FileSystemDirectoryHandle | null = null;

  private async getRoot(): Promise<FileSystemDirectoryHandle> {
    if (this.root) return this.root;
    if (
      typeof navigator === 'undefined' ||
      typeof navigator.storage?.getDirectory !== 'function'
    ) {
      throw new Error('OPFS unavailable');
    }
    const base = await navigator.storage.getDirectory();
    this.root = await base.getDirectoryHandle(OPFS_DIR, { create: true });
    return this.root;
  }

  private async getFileHandle(
    id: string,
    create: boolean,
  ): Promise<FileSystemFileHandle> {
    const root = await this.getRoot();
    const parts = id.split('/').filter(Boolean);
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i]!, { create: true });
    }
    const name = parts[parts.length - 1]!;
    return dir.getFileHandle(name, { create });
  }

  async get(id: string): Promise<ArrayBuffer | null> {
    try {
      const fh = await this.getFileHandle(id, false);
      const file = await fh.getFile();
      return await file.arrayBuffer();
    } catch {
      return null;
    }
  }

  async put(id: string, data: ArrayBuffer): Promise<void> {
    const fh = await this.getFileHandle(id, true);
    const writable = await fh.createWritable();
    try {
      await writable.write(data);
    } finally {
      await writable.close();
    }
  }

  async has(id: string): Promise<boolean> {
    const buf = await this.get(id);
    return buf !== null;
  }

  async delete(id: string): Promise<void> {
    try {
      const root = await this.getRoot();
      const parts = id.split('/').filter(Boolean);
      if (parts.length === 1) {
        await root.removeEntry(parts[0]!);
        return;
      }
      let dir = root;
      for (let i = 0; i < parts.length - 1; i++) {
        dir = await dir.getDirectoryHandle(parts[i]!);
      }
      await dir.removeEntry(parts[parts.length - 1]!);
    } catch {
      /* ignore missing */
    }
  }
}

/** Cache API fallback when OPFS is unavailable. */
export class CacheApiArtifactStorage implements ArtifactStorage {
  readonly backend = 'cache' as const;
  private cache: Cache | null = null;

  private keyUrl(id: string): string {
    // Synthetic origin-relative keys; never used as a real network URL.
    return `https://poidh-artifacts.local/${id}`;
  }

  private async getCache(): Promise<Cache> {
    if (this.cache) return this.cache;
    if (typeof caches === 'undefined') {
      throw new Error('Cache API unavailable');
    }
    this.cache = await caches.open(CACHE_NAME);
    return this.cache;
  }

  async get(id: string): Promise<ArrayBuffer | null> {
    try {
      const cache = await this.getCache();
      const res = await cache.match(this.keyUrl(id));
      if (!res) return null;
      return await res.arrayBuffer();
    } catch {
      return null;
    }
  }

  async put(id: string, data: ArrayBuffer): Promise<void> {
    const cache = await this.getCache();
    const res = new Response(data, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(data.byteLength),
      },
    });
    await cache.put(this.keyUrl(id), res);
  }

  async has(id: string): Promise<boolean> {
    try {
      const cache = await this.getCache();
      const res = await cache.match(this.keyUrl(id));
      return res !== undefined;
    } catch {
      return false;
    }
  }

  async delete(id: string): Promise<void> {
    try {
      const cache = await this.getCache();
      await cache.delete(this.keyUrl(id));
    } catch {
      /* ignore */
    }
  }
}

/**
 * Prefer OPFS; fall back to Cache API. Throws if neither is available
 * (unit tests should inject MemoryArtifactStorage).
 */
export async function createDefaultStorage(): Promise<ArtifactStorage> {
  const canOpfs =
    typeof navigator !== 'undefined' &&
    typeof navigator.storage === 'object' &&
    navigator.storage !== null &&
    typeof (navigator.storage as StorageManager & { getDirectory?: unknown })
      .getDirectory === 'function';
  if (canOpfs) {
    try {
      const opfs = new OpfsArtifactStorage();
      // Probe write capability with a tiny round-trip on the ready marker path.
      await opfs.put('.__probe', new Uint8Array([1]).buffer);
      await opfs.delete('.__probe');
      return opfs;
    } catch {
      /* fall through */
    }
  }
  if (typeof caches !== 'undefined') {
    return new CacheApiArtifactStorage();
  }
  throw new Error(
    'No OPFS or Cache API available for artifact storage (never use chrome.storage for weights)',
  );
}

// ---------------------------------------------------------------------------
// Manifest helpers
// ---------------------------------------------------------------------------

export function getProductionOnnx(
  manifest: Manifest = DEFAULT_MANIFEST,
): ManifestArtifact {
  const onnx = manifest.artifacts.find(
    (a) => a.kind === 'onnx' && a.role === 'production',
  );
  if (!onnx) {
    throw new Error('manifest missing production onnx artifact');
  }
  return onnx;
}

export function listWasmArtifacts(
  manifest: Manifest = DEFAULT_MANIFEST,
): ManifestArtifact[] {
  return manifest.artifacts.filter((a) => a.kind === 'wasm');
}

export function isWeightHostUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export function defaultResolveUrl(artifact: ManifestArtifact): string {
  const path = artifact.packagePath ?? artifact.url;
  if (isWeightHostUrl(path)) {
    return path;
  }
  // Package-relative (wasm under dist/wasm/).
  if (
    typeof chrome !== 'undefined' &&
    chrome.runtime?.getURL &&
    typeof chrome.runtime.getURL === 'function'
  ) {
    return chrome.runtime.getURL(path.replace(/^\//, ''));
  }
  return path;
}

// ---------------------------------------------------------------------------
// Config assert (num_labels=1)
// ---------------------------------------------------------------------------

export function assertConfigPayload(
  bytes: ArrayBuffer,
  expected: ArtifactAssert,
): void {
  const text = new TextDecoder().decode(bytes);
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ShaMismatchError(`config.json is not valid JSON: ${detail}`);
  }
  if (expected.num_labels !== undefined) {
    if (json['num_labels'] !== expected.num_labels) {
      throw new ShaMismatchError(
        `config num_labels=${String(json['num_labels'])} != ${expected.num_labels}`,
      );
    }
  }
  if (expected.num_attention_heads !== undefined) {
    if (json['num_attention_heads'] !== expected.num_attention_heads) {
      throw new ShaMismatchError(
        `config num_attention_heads=${String(json['num_attention_heads'])} != ${expected.num_attention_heads}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ShaMismatchError extends Error {
  readonly code = 'SHA_MISMATCH' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ShaMismatchError';
  }
}

export class ArtifactTooSmallError extends Error {
  readonly code = 'ARTIFACT_TOO_SMALL' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactTooSmallError';
  }
}

export class NetworkFetchRefusedError extends Error {
  readonly code = 'NETWORK_FETCH_REFUSED' as const;
  constructor(message: string) {
    super(message);
    this.name = 'NetworkFetchRefusedError';
  }
}

// ---------------------------------------------------------------------------
// Ready marker
// ---------------------------------------------------------------------------

interface ReadyMarker {
  ready: true;
  sha256: string;
  revision: string;
  repo: string;
  at: string;
}

async function readReadyMarker(
  storage: ArtifactStorage,
): Promise<ReadyMarker | null> {
  const buf = await storage.get(READY_MARKER_ID);
  if (!buf) return null;
  try {
    const json = JSON.parse(new TextDecoder().decode(buf)) as ReadyMarker;
    if (json && json.ready === true && typeof json.sha256 === 'string') {
      return json;
    }
  } catch {
    /* corrupt marker */
  }
  return null;
}

async function writeReadyMarker(
  storage: ArtifactStorage,
  manifest: Manifest,
  onnxSha: string,
): Promise<void> {
  const marker: ReadyMarker = {
    ready: true,
    sha256: onnxSha,
    revision: manifest.revision,
    repo: manifest.repo,
    at: new Date().toISOString(),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(marker));
  await storage.put(READY_MARKER_ID, bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ));
}

// ---------------------------------------------------------------------------
// Core: verify local / download / ensure
// ---------------------------------------------------------------------------

async function verifyStoredArtifact(
  storage: ArtifactStorage,
  artifact: ManifestArtifact,
  minProductionOnnxBytes: number,
): Promise<'match' | 'missing' | 'mismatch'> {
  const existing = await storage.get(artifact.id);
  if (!existing) return 'missing';
  if (
    artifact.kind === 'onnx' &&
    artifact.role === 'production' &&
    existing.byteLength < minProductionOnnxBytes
  ) {
    return 'mismatch';
  }
  const hash = await sha256Hex(existing);
  if (hash.toLowerCase() !== artifact.sha256.toLowerCase()) {
    return 'mismatch';
  }
  if (artifact.kind === 'config' && artifact.assert) {
    try {
      assertConfigPayload(existing, artifact.assert);
    } catch {
      return 'mismatch';
    }
  }
  return 'match';
}

async function downloadAndStore(
  artifact: ManifestArtifact,
  storage: ArtifactStorage,
  fetchFn: FetchLike,
  resolveUrl: (a: ManifestArtifact) => string,
  minProductionOnnxBytes: number,
  allowNetwork: boolean,
): Promise<void> {
  const url = resolveUrl(artifact);
  const isNetwork = isWeightHostUrl(url);

  if (isNetwork && !allowNetwork) {
    throw new NetworkFetchRefusedError(
      `models_ready: refusing network fetch of ${artifact.id} (${url})`,
    );
  }

  let response: Response;
  try {
    response = await fetchFn(url);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`download failed for ${artifact.id}: ${detail}`, {
      cause: err,
    });
  }
  if (!response.ok) {
    throw new Error(
      `download failed for ${artifact.id}: HTTP ${response.status}`,
    );
  }

  const data = await response.arrayBuffer();

  if (
    artifact.kind === 'onnx' &&
    artifact.role === 'production' &&
    data.byteLength < minProductionOnnxBytes
  ) {
    throw new ArtifactTooSmallError(
      `production ONNX ${artifact.id} is ${data.byteLength} bytes (< ${minProductionOnnxBytes}); refusing dummy/stub`,
    );
  }

  const hash = await sha256Hex(data);
  if (hash.toLowerCase() !== artifact.sha256.toLowerCase()) {
    throw new ShaMismatchError(
      `SHA256 mismatch for ${artifact.id}: got ${hash}, expected ${artifact.sha256}`,
    );
  }

  if (artifact.kind === 'config' && artifact.assert) {
    assertConfigPayload(data, artifact.assert);
  }

  await storage.put(artifact.id, data);
}

/**
 * Ensure all manifest artifacts are present with matching SHA256.
 *
 * - Matching local hashes → no-op (no fetch)
 * - SHA mismatch on download → throws ShaMismatchError
 * - After models_ready without force → refuses weight-host network fetches
 * - Production ONNX under minProductionOnnxBytes → throws ArtifactTooSmallError
 */
export async function ensureArtifacts(
  options: EnsureArtifactsOptions = {},
): Promise<SetupResult> {
  const manifest = options.manifest ?? DEFAULT_MANIFEST;
  const fetchFn: FetchLike =
    options.fetch ??
    ((input, init) => fetch(input, init));
  const resolveUrl = options.resolveUrl ?? defaultResolveUrl;
  const force = options.force === true;
  const minBytes =
    manifest.minProductionOnnxBytes ?? MIN_PRODUCTION_ONNX_BYTES;

  let storage: ArtifactStorage;
  try {
    storage = options.storage ?? (await createDefaultStorage());
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ready: false,
      noop: false,
      sha256: null,
      sha256Short: null,
      backend: 'unknown',
      fetched: [],
      skipped: [],
      error: detail,
    };
  }

  const marker = await readReadyMarker(storage);
  const modelsReady = marker !== null;
  // After Ready, only package-relative (non-http) URLs may be re-fetched
  // unless the user explicitly forces Retry.
  const allowNetwork = force || !modelsReady;

  const fetched: string[] = [];
  const skipped: string[] = [];

  try {
    for (const artifact of manifest.artifacts) {
      const status = await verifyStoredArtifact(storage, artifact, minBytes);
      if (status === 'match') {
        skipped.push(artifact.id);
        continue;
      }

      // Local present but wrong hash: delete then re-download.
      if (status === 'mismatch') {
        await storage.delete(artifact.id);
      }

      await downloadAndStore(
        artifact,
        storage,
        fetchFn,
        resolveUrl,
        minBytes,
        allowNetwork,
      );
      fetched.push(artifact.id);
    }

    const onnx = getProductionOnnx(manifest);
    const onnxBuf = await storage.get(onnx.id);
    if (!onnxBuf) {
      throw new Error('production ONNX missing after setup');
    }
    const onnxSha = await sha256Hex(onnxBuf);
    if (onnxSha.toLowerCase() !== onnx.sha256.toLowerCase()) {
      throw new ShaMismatchError(
        `production ONNX SHA mismatch after store: ${onnxSha}`,
      );
    }

    await writeReadyMarker(storage, manifest, onnxSha);

    const noop = fetched.length === 0;
    return {
      ready: true,
      noop,
      sha256: onnxSha,
      sha256Short: shortSha(onnxSha),
      backend: storage.backend,
      fetched,
      skipped,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ready: false,
      noop: false,
      sha256: null,
      sha256Short: null,
      backend: storage.backend,
      fetched,
      skipped,
      error: detail,
    };
  }
}

/**
 * Lightweight status for the popup (does not download).
 */
export async function getArtifactStatus(
  options: {
    storage?: ArtifactStorage;
    manifest?: Manifest;
  } = {},
): Promise<ArtifactStatus> {
  const manifest = options.manifest ?? DEFAULT_MANIFEST;
  let storage: ArtifactStorage;
  try {
    storage = options.storage ?? (await createDefaultStorage());
  } catch (err) {
    return {
      ready: false,
      sha256: null,
      sha256Short: null,
      backend: 'unknown',
      modelsReadyMarker: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const marker = await readReadyMarker(storage);
  const onnx = getProductionOnnx(manifest);
  const minBytes =
    manifest.minProductionOnnxBytes ?? MIN_PRODUCTION_ONNX_BYTES;

  // Ready only when marker + every artifact matches pinned SHA.
  for (const artifact of manifest.artifacts) {
    const status = await verifyStoredArtifact(storage, artifact, minBytes);
    if (status !== 'match') {
      return {
        ready: false,
        sha256: marker?.sha256 ?? null,
        sha256Short: marker ? shortSha(marker.sha256) : null,
        backend: storage.backend,
        modelsReadyMarker: marker !== null,
        error:
          status === 'missing'
            ? `missing artifact: ${artifact.id}`
            : `hash mismatch: ${artifact.id}`,
      };
    }
  }

  const sha = marker?.sha256 ?? onnx.sha256;
  return {
    ready: true,
    sha256: sha,
    sha256Short: shortSha(sha),
    backend: storage.backend,
    modelsReadyMarker: marker !== null,
  };
}

export async function isModelsReady(
  options: {
    storage?: ArtifactStorage;
    manifest?: Manifest;
  } = {},
): Promise<boolean> {
  const status = await getArtifactStatus(options);
  return status.ready;
}

/**
 * Read a stored artifact by id. Returns null if missing.
 * Does not network-fetch.
 */
export async function getArtifactBytes(
  id: string,
  storage?: ArtifactStorage,
): Promise<ArrayBuffer | null> {
  const store = storage ?? (await createDefaultStorage());
  return store.get(id);
}

/**
 * Load production ONNX bytes from the store (local only).
 * Throws if not ready / missing.
 */
export async function loadProductionOnnxBytes(
  options: {
    storage?: ArtifactStorage;
    manifest?: Manifest;
  } = {},
): Promise<ArrayBuffer> {
  const manifest = options.manifest ?? DEFAULT_MANIFEST;
  const storage = options.storage ?? (await createDefaultStorage());
  const ready = await isModelsReady({ storage, manifest });
  if (!ready) {
    throw new Error('MODEL_MISSING: artifacts not ready');
  }
  const onnx = getProductionOnnx(manifest);
  const buf = await storage.get(onnx.id);
  if (!buf) {
    throw new Error('MODEL_MISSING: production ONNX absent from store');
  }
  return buf;
}

/**
 * Delete all pinned artifacts + the models_ready marker from local storage.
 * Used by offline e2e (AC-MISS) and recovery paths. Does not touch the network.
 */
export async function clearAllArtifacts(
  options: {
    storage?: ArtifactStorage;
    manifest?: Manifest;
  } = {},
): Promise<{ cleared: string[]; backend: ArtifactStatus['backend'] }> {
  const manifest = options.manifest ?? DEFAULT_MANIFEST;
  const storage = options.storage ?? (await createDefaultStorage());
  const cleared: string[] = [];
  for (const artifact of manifest.artifacts) {
    await storage.delete(artifact.id);
    cleared.push(artifact.id);
  }
  await storage.delete(READY_MARKER_ID);
  cleared.push(READY_MARKER_ID);
  return { cleared, backend: storage.backend };
}

/**
 * Build an ORT `wasmPaths` prefix or map from stored wasm artifacts.
 * Creates blob: URLs that the offscreen document can load without network.
 *
 * Caller should revoke the blob URLs on teardown if desired.
 */
export async function buildWasmPathsFromStore(
  options: {
    storage?: ArtifactStorage;
    manifest?: Manifest;
  } = {},
): Promise<{ wasmPaths: Record<string, string>; blobUrls: string[] }> {
  const manifest = options.manifest ?? DEFAULT_MANIFEST;
  const storage = options.storage ?? (await createDefaultStorage());
  const wasmArts = listWasmArtifacts(manifest);
  const wasmPaths: Record<string, string> = {};
  const blobUrls: string[] = [];

  for (const art of wasmArts) {
    const buf = await storage.get(art.id);
    if (!buf) {
      throw new Error(`MODEL_MISSING: wasm artifact ${art.id} not in store`);
    }
    const name = art.id.split('/').pop()!;
    const blob = new Blob([buf], {
      type: name.endsWith('.mjs')
        ? 'text/javascript'
        : 'application/wasm',
    });
    const url = URL.createObjectURL(blob);
    blobUrls.push(url);
    wasmPaths[name] = url;
  }

  return { wasmPaths, blobUrls };
}
