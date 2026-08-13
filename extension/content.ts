/**
 * Content script autoscan overlay (sections 3.1–3.2; pixel path from 2.3).
 *
 * Primary path (E2): already-displayed bitmaps via createImageBitmap / canvas
 * of the loaded <img>. GET of the displayed URL is **online fallback only**
 * (sent as ANALYZE_IMAGE.src so offscreen fetches with host_permissions).
 *
 * skip_cross_origin only if both displayed-pixel and (when online) GET fail.
 * skip_small: no badge, never labeled real.
 * Overlay cache (URL+size+dHash): scroll restore only — never short-circuits
 * ANALYZE_IMAGE / SCAN_PAGE (AC-MISS must hit offscreen after CLEAR_ARTIFACTS).
 *
 * Labels use src/label.ts (THRESHOLD). Pause flag lives in chrome.storage.local
 * (AC-PAUSE / G-REENTRY) — when paused, no new badges are created.
 */

import {
  attachBadge,
  isEligibleImage,
  type BadgeHandle,
  BADGE_TESTID,
  MIN_ELIGIBLE_CSS_PX,
  cssSize,
} from './badge.js';
import {
  formatBadgeText,
  labelFromScore,
  PAUSE_STORAGE_KEY,
} from '../src/label.js';

export { BADGE_TESTID, MIN_ELIGIBLE_CSS_PX, isEligibleImage, cssSize };

interface RgbPayload {
  width: number;
  height: number;
  data: number[];
}

interface AnalyzeResultLike {
  type: string;
  scanId?: string;
  imageId?: string;
  score?: number;
  label?: string;
  skip_reason?: string | null;
  code?: string;
}

interface ScanPageResult {
  type: 'SCAN_PAGE_RESULT';
  ok: boolean;
  scanId: string;
  results: AnalyzeResultLike[];
  error?: string;
}

type CacheEntry =
  | {
      kind: 'score';
      score: number;
      label: string;
      skip_reason: string | null;
    }
  | {
      kind: 'unavailable';
      skip_reason: string;
    };

/**
 * Overlay-only result cache: URL+size+dHash → last scored/skip outcome.
 * Used to restore badge text on scroll (AC-CACHE). Never gates ANALYZE_IMAGE.
 */
const resultCache = new Map<string, CacheEntry>();

/** Weak map of img → badge handle. */
const badges = new WeakMap<HTMLImageElement, BadgeHandle>();

/** Images currently in-flight (avoid duplicate ANALYZE). */
const inFlight = new WeakSet<HTMLImageElement>();

/** Images already processed this session (or skip_small). */
const settled = new WeakSet<HTMLImageElement>();

/**
 * Pause scanning (section 3.2). When true, autoscan / SCAN_PAGE create no new
 * badges. Persisted via chrome.storage.local (G-REENTRY).
 */
let scanningPaused = false;

async function loadPauseFlag(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(PAUSE_STORAGE_KEY);
    scanningPaused = Boolean(stored[PAUSE_STORAGE_KEY]);
  } catch {
    scanningPaused = false;
  }
}

function watchPauseFlag(): void {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const ch = changes[PAUSE_STORAGE_KEY];
      if (!ch) return;
      scanningPaused = Boolean(ch.newValue);
    });
  } catch {
    // storage API unavailable in non-extension unit contexts
  }
}

/**
 * Serialize ANALYZE_IMAGE through the single offscreen ORT session.
 * Concurrent InferenceSession.run() races and yields intermittent INFER errors.
 */
let analyzeChain: Promise<void> = Promise.resolve();

function enqueueAnalyze<T>(fn: () => Promise<T>): Promise<T> {
  const run = analyzeChain.then(fn, fn);
  // Keep the chain alive even when a job rejects.
  analyzeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** One scanId for this page lifetime (E3 correlation). */
const pageScanId = `scan-${
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}`;

/**
 * Decode a fully loaded HTMLImageElement to interleaved RGB (0–255).
 * Uses createImageBitmap + canvas — no network.
 */
export async function rgbFromLoadedImage(
  img: HTMLImageElement,
): Promise<RgbPayload> {
  if (!img.complete || img.naturalWidth < 1 || img.naturalHeight < 1) {
    throw new Error('image not loaded');
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(img);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`createImageBitmap failed: ${detail}`, { cause: err });
  }

  try {
    const width = bitmap.width;
    const height = bitmap.height;
    const canvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(width, height)
        : (() => {
            const c = document.createElement('canvas');
            c.width = width;
            c.height = height;
            return c;
          })();
    const ctx = canvas.getContext('2d') as
      | OffscreenCanvasRenderingContext2D
      | CanvasRenderingContext2D
      | null;
    if (!ctx) {
      throw new Error('2d context unavailable');
    }
    ctx.drawImage(bitmap, 0, 0);
    // Cross-origin without CORS taints the canvas — getImageData throws.
    const imageData = ctx.getImageData(0, 0, width, height);
    const rgba = imageData.data;
    const rgb = new Array<number>(width * height * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      rgb[j] = rgba[i]!;
      rgb[j + 1] = rgba[i + 1]!;
      rgb[j + 2] = rgba[i + 2]!;
    }
    return { width, height, data: rgb };
  } finally {
    bitmap.close();
  }
}

/**
 * Difference hash (dHash) of already-decoded RGB for cache identity.
 * 8×8 comparisons → 64-bit hex string. Pure; no network.
 */
export function dHashFromRgb(rgb: RgbPayload): string {
  const { width, height, data } = rgb;
  if (width < 1 || height < 1 || data.length < width * height * 3) {
    return '0';
  }
  const gw = 9;
  const gh = 8;
  const gray = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const sx = Math.min(width - 1, Math.floor((x + 0.5) * (width / gw)));
      const sy = Math.min(height - 1, Math.floor((y + 0.5) * (height / gh)));
      const i = (sy * width + sx) * 3;
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      gray[y * gw + x] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
  }
  let bits = 0n;
  let bit = 0n;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < 8; x++) {
      const left = gray[y * gw + x] ?? 0;
      const right = gray[y * gw + x + 1] ?? 0;
      if (left > right) {
        bits |= 1n << bit;
      }
      bit += 1n;
    }
  }
  return bits.toString(16).padStart(16, '0');
}

function imageIdFor(img: HTMLImageElement, index: number): string {
  const attr = img.getAttribute('data-image-id');
  if (attr) return attr;
  if (img.currentSrc) return img.currentSrc;
  if (img.src) return img.src;
  return `img-${index}`;
}

function imageSrc(img: HTMLImageElement): string {
  return img.currentSrc || img.src || '';
}

function sizeKey(img: HTMLImageElement): string {
  const { width, height } = cssSize(img);
  return `${Math.round(width)}x${Math.round(height)}|${img.naturalWidth}x${img.naturalHeight}`;
}

function cacheKey(img: HTMLImageElement, dhash: string): string {
  return `${imageSrc(img)}|${sizeKey(img)}|${dhash}`;
}

function cacheKeyNoPixels(img: HTMLImageElement): string {
  return `${imageSrc(img)}|${sizeKey(img)}|nopx`;
}

function isOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
}

function ensureBadge(img: HTMLImageElement): BadgeHandle {
  let handle = badges.get(img);
  if (!handle || !handle.host.isConnected) {
    handle = attachBadge(img);
    badges.set(img, handle);
  }
  return handle;
}

function applyCacheEntry(img: HTMLImageElement, entry: CacheEntry): void {
  const badge = ensureBadge(img);
  if (entry.kind === 'score') {
    // Recompute label from score via label.ts (AC-A1).
    badge.setState({
      kind: 'score',
      score: entry.score,
      label: labelFromScore(entry.score),
    });
  } else {
    badge.setState({ kind: 'unavailable', reason: entry.skip_reason });
  }
}

/**
 * Analyze one image: displayed pixels first; online GET fallback via offscreen.
 * Does not treat skips as real.
 *
 * Always hits ANALYZE_IMAGE (no resultCache short-circuit). Cache is for
 * overlay reposition only (AC-CACHE); SCAN_PAGE/SCAN_TAB must reach offscreen
 * so CLEAR_ARTIFACTS → MODEL_MISSING and pre-setup rescans work.
 */
export async function analyzeOneImage(
  img: HTMLImageElement,
  scanId: string,
  index: number,
): Promise<AnalyzeResultLike> {
  const imageId = imageIdFor(img, index);

  // AC-PAUSE: while paused, do not create new badges or hit ANALYZE_IMAGE.
  if (scanningPaused) {
    return {
      type: 'ANALYZE_RESULT',
      scanId,
      imageId,
      score: 0,
      label: 'skip',
      skip_reason: 'paused',
    };
  }

  // skip_small: no badge, never label real (negative AC).
  if (!isEligibleImage(img)) {
    return {
      type: 'ANALYZE_RESULT',
      scanId,
      imageId,
      score: 0,
      label: 'skip',
      skip_reason: 'skip_small',
    };
  }

  const quickKey = cacheKeyNoPixels(img);
  const badge = ensureBadge(img);
  badge.setState({ kind: 'loading' });

  let rgb: RgbPayload | null = null;
  let pixelError: unknown = null;
  try {
    rgb = await rgbFromLoadedImage(img);
  } catch (err) {
    pixelError = err;
  }

  if (rgb) {
    const dhash = dHashFromRgb(rgb);
    const key = cacheKey(img, dhash);

    try {
      const response = await enqueueAnalyze(
        async () =>
          (await chrome.runtime.sendMessage({
            type: 'ANALYZE_IMAGE',
            scanId,
            imageId,
            // Pixel path: raw RGB from the already-loaded element (no src re-fetch).
            image: {
              width: rgb.width,
              height: rgb.height,
              data: rgb.data,
            },
          })) as AnalyzeResultLike | undefined,
      );

      return finalizeFromResponse(img, response, scanId, imageId, key, quickKey);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // Transient / transport failure — do not cache (allows rescan after recovery).
      badge.setState({ kind: 'unavailable', reason: detail });
      return {
        type: 'ANALYZE_ERROR',
        scanId,
        imageId,
        code: 'INFER',
      };
    }
  }

  // Pixel path failed — online GET fallback only (offscreen decodeImageSrc).
  const src = imageSrc(img);
  if (src && isOnline()) {
    try {
      const response = await enqueueAnalyze(
        async () =>
          (await chrome.runtime.sendMessage({
            type: 'ANALYZE_IMAGE',
            scanId,
            imageId,
            // Online fallback: GET of the displayed URL inside extension context.
            src,
          })) as AnalyzeResultLike | undefined,
      );

      return finalizeFromResponse(
        img,
        response,
        scanId,
        imageId,
        quickKey,
        quickKey,
      );
    } catch {
      // fall through to skip_cross_origin
    }
  }

  // Both displayed-pixel and (when online) GET failed → skip_cross_origin.
  // Never coerce to real. Cache for badge restore only (not ANALYZE short-circuit).
  void pixelError;
  const entry: CacheEntry = {
    kind: 'unavailable',
    skip_reason: 'skip_cross_origin',
  };
  resultCache.set(quickKey, entry);
  badge.setState({ kind: 'unavailable', reason: 'skip_cross_origin' });
  return {
    type: 'ANALYZE_RESULT',
    scanId,
    imageId,
    score: 0,
    label: 'skip',
    skip_reason: 'skip_cross_origin',
  };
}

/**
 * Apply offscreen response to badge + optional overlay cache.
 * MODEL_MISSING / empty errors are NOT written to resultCache so a later
 * successful setup can rescore (and SCAN always re-hits offscreen anyway).
 */
function finalizeFromResponse(
  img: HTMLImageElement,
  response: AnalyzeResultLike | undefined,
  scanId: string,
  imageId: string,
  key: string,
  quickKey: string,
): AnalyzeResultLike {
  const badge = ensureBadge(img);

  if (!response || typeof response !== 'object' || !response.type) {
    badge.setState({ kind: 'unavailable' });
    return {
      type: 'ANALYZE_ERROR',
      scanId,
      imageId,
      code: 'INFER',
    };
  }

  if (response.type === 'ANALYZE_RESULT') {
    const label = response.label ?? 'error';
    const score =
      typeof response.score === 'number' && Number.isFinite(response.score)
        ? response.score
        : 0;

    if (label === 'skip' || label === 'error') {
      const reason = response.skip_reason ?? label;
      const entry: CacheEntry = { kind: 'unavailable', skip_reason: reason };
      // Definitive skip (e.g. skip_cross_origin): cache for badge restore only.
      resultCache.set(key, entry);
      resultCache.set(quickKey, entry);
      // Skip is not real — show unavailable, never a fake real score.
      badge.setState({ kind: 'unavailable', reason });
      return {
        type: 'ANALYZE_RESULT',
        scanId,
        imageId,
        score: 0,
        label: 'skip',
        skip_reason: reason,
      };
    }

    // AC-A1: decide via src/label.ts THRESHOLD only (never trust a drifted label).
    const decided = labelFromScore(score);
    const entry: CacheEntry = {
      kind: 'score',
      score,
      label: decided,
      skip_reason: null,
    };
    // Overlay cache for scroll restore (AC-CACHE) — not used to skip ANALYZE_IMAGE.
    resultCache.set(key, entry);
    resultCache.set(quickKey, entry);
    badge.setState({ kind: 'score', score: entry.score, label: decided });
    return {
      type: 'ANALYZE_RESULT',
      scanId,
      imageId,
      score: entry.score,
      label: decided,
      skip_reason: null,
    };
  }

  // ANALYZE_ERROR → unavailable (fail closed). Do not cache MODEL_MISSING so
  // a later setup can rescore; explicit SCAN_PAGE always re-queries offscreen.
  badge.setState({ kind: 'unavailable', reason: response.code });
  if (response.code && response.code !== 'MODEL_MISSING') {
    const entry: CacheEntry = {
      kind: 'unavailable',
      skip_reason: response.code,
    };
    resultCache.set(key, entry);
    resultCache.set(quickKey, entry);
  } else {
    // Drop any prior score so scroll restore cannot show a stale real/ai badge
    // after artifacts were cleared mid-session.
    resultCache.delete(key);
    resultCache.delete(quickKey);
  }
  return {
    type: 'ANALYZE_ERROR',
    scanId,
    imageId,
    code: (response.code as AnalyzeResultLike['code']) ?? 'INFER',
  };
}

/**
 * Scan all complete <img> elements on the page (2.3 SCAN_PAGE + badge update).
 * Always re-runs analyzeOneImage → ANALYZE_IMAGE (never cache short-circuit).
 */
export async function scanLoadedImages(
  scanId: string,
): Promise<ScanPageResult> {
  // AC-PAUSE: explicit scan also creates no new badges while paused.
  if (scanningPaused) {
    return {
      type: 'SCAN_PAGE_RESULT',
      ok: true,
      scanId,
      results: [],
    };
  }

  const imgs = Array.from(document.images).filter(
    (img) => img.complete && img.naturalWidth > 0 && img.naturalHeight > 0,
  );

  const results: AnalyzeResultLike[] = [];

  for (let i = 0; i < imgs.length; i++) {
    const img = imgs[i]!;
    try {
      const result = await analyzeOneImage(img, scanId, i);
      results.push(result);
      markSettledFromResult(img, result);
    } catch {
      results.push({
        type: 'ANALYZE_ERROR',
        scanId,
        imageId: imageIdFor(img, i),
        code: 'DECODE',
      });
      if (isEligibleImage(img)) {
        ensureBadge(img).setState({ kind: 'unavailable', reason: 'DECODE' });
      }
      // Leave unsettled so a later scan/setup can retry.
    }
  }

  return {
    type: 'SCAN_PAGE_RESULT',
    ok: true,
    scanId,
    results,
  };
}

/**
 * Settle only on definitive outcomes. MODEL_MISSING leaves the image open for
 * rescore after setup; SCAN_PAGE always re-analyzes regardless.
 */
function markSettledFromResult(
  img: HTMLImageElement,
  result: AnalyzeResultLike,
): void {
  if (result.skip_reason === 'skip_small') {
    settled.add(img);
    return;
  }
  if (result.type === 'ANALYZE_ERROR') {
    // Fail-closed errors (esp. MODEL_MISSING): do not settle permanently.
    settled.delete(img);
    return;
  }
  if (result.type === 'ANALYZE_RESULT') {
    if (result.label === 'ai' || result.label === 'real') {
      settled.add(img);
      return;
    }
    if (result.skip_reason === 'skip_cross_origin') {
      settled.add(img);
      return;
    }
  }
}

/** MODEL_MISSING autoscan retry budget per image (setup may complete later). */
const modelMissRetries = new WeakMap<HTMLImageElement, number>();
const MODEL_MISS_RETRY_MAX = 12;
const MODEL_MISS_RETRY_MS = 2500;

async function processImage(img: HTMLImageElement, index: number): Promise<void> {
  if (inFlight.has(img)) {
    return;
  }

  if (settled.has(img)) {
    // AC-CACHE: restore badge text from overlay cache; do not re-ANALYZE.
    // Pause does not hide already-settled badges.
    const q = resultCache.get(cacheKeyNoPixels(img));
    if (q && isEligibleImage(img)) {
      applyCacheEntry(img, q);
    }
    badges.get(img)?.reposition();
    return;
  }

  // AC-PAUSE: no new badges while scanning is paused.
  if (scanningPaused) {
    return;
  }

  if (!img.complete || img.naturalWidth < 1) {
    img.addEventListener(
      'load',
      () => {
        void processImage(img, index);
      },
      { once: true },
    );
    return;
  }

  if (!isEligibleImage(img)) {
    // skip_small: deliberately no badge, not labeled real.
    settled.add(img);
    return;
  }

  inFlight.add(img);
  try {
    const result = await analyzeOneImage(img, pageScanId, index);
    markSettledFromResult(img, result);

    // If models were not ready, retry later so setup → auto-rescore works.
    if (
      result.type === 'ANALYZE_ERROR' &&
      result.code === 'MODEL_MISSING' &&
      !settled.has(img)
    ) {
      const n = modelMissRetries.get(img) ?? 0;
      if (n < MODEL_MISS_RETRY_MAX) {
        modelMissRetries.set(img, n + 1);
        setTimeout(() => {
          void processImage(img, index);
        }, MODEL_MISS_RETRY_MS);
      }
    } else if (result.type === 'ANALYZE_RESULT' && result.label !== 'skip') {
      modelMissRetries.delete(img);
    }
  } finally {
    inFlight.delete(img);
  }
}

function observeImages(): void {
  const io =
    typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const img = entry.target;
              if (img instanceof HTMLImageElement) {
                const idx = Array.from(document.images).indexOf(img);
                void processImage(img, idx < 0 ? 0 : idx);
              }
            }
          },
          { root: null, rootMargin: '100px', threshold: 0.01 },
        )
      : null;

  const watch = (img: HTMLImageElement): void => {
    if (io) {
      io.observe(img);
    } else {
      const idx = Array.from(document.images).indexOf(img);
      void processImage(img, idx < 0 ? 0 : idx);
    }
  };

  for (const img of Array.from(document.images)) {
    watch(img);
  }

  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of Array.from(m.addedNodes)) {
        if (node instanceof HTMLImageElement) {
          watch(node);
        } else if (node instanceof Element) {
          for (const img of Array.from(node.querySelectorAll('img'))) {
            watch(img);
          }
        }
      }
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  const repositionAll = (): void => {
    for (const img of Array.from(document.images)) {
      badges.get(img)?.reposition();
    }
  };
  window.addEventListener('scroll', repositionAll, { passive: true });
  window.addEventListener('resize', repositionAll, { passive: true });
}

// Boot autoscan (AC-AUTO: no click required). Load pause flag first (AC-PAUSE).
if (typeof document !== 'undefined') {
  const boot = (): void => {
    watchPauseFlag();
    void loadPauseFlag().then(() => observeImages());
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message === null || typeof message !== 'object') {
    return false;
  }
  const msg = message as { type?: string; scanId?: string };

  if (msg.type === 'SCAN_PAGE') {
    const scanId =
      typeof msg.scanId === 'string' && msg.scanId.length > 0
        ? msg.scanId
        : pageScanId;
    void scanLoadedImages(scanId)
      .then((result) => sendResponse(result))
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        sendResponse({
          type: 'SCAN_PAGE_RESULT',
          ok: false,
          scanId,
          results: [],
          error: detail,
        } satisfies ScanPageResult);
      });
    return true;
  }

  if (msg.type === 'CONTENT_PING') {
    sendResponse({
      type: 'CONTENT_PONG',
      imagesLoaded: Array.from(document.images).filter(
        (img) => img.complete && img.naturalWidth > 0,
      ).length,
      imagesTotal: document.images.length,
      scanId: pageScanId,
      scanningPaused,
    });
    return false;
  }

  /**
   * E2e/test: apply a known score to a page image so AC-A1 boundary (0.64/0.65)
   * can be asserted without depending on model logits. Still uses label.ts.
   */
  if (msg.type === 'SET_BADGE_SCORE') {
    const raw = message as {
      type?: string;
      score?: unknown;
      imageId?: unknown;
      index?: unknown;
    };
    const score =
      typeof raw.score === 'number' && Number.isFinite(raw.score)
        ? raw.score
        : NaN;
    if (!Number.isFinite(score)) {
      sendResponse({ ok: false, error: 'score (number) required' });
      return false;
    }
    const imgs = Array.from(document.images);
    let img: HTMLImageElement | undefined;
    if (typeof raw.imageId === 'string' && raw.imageId.length > 0) {
      img = imgs.find((el, i) => imageIdFor(el, i) === raw.imageId);
    }
    if (!img && typeof raw.index === 'number' && raw.index >= 0) {
      img = imgs[raw.index];
    }
    if (!img) {
      img = imgs.find((el) => isEligibleImage(el));
    }
    if (!img || !isEligibleImage(img)) {
      sendResponse({ ok: false, error: 'no eligible image' });
      return false;
    }
    const decided = labelFromScore(score);
    const badge = ensureBadge(img);
    badge.setState({ kind: 'score', score, label: decided });
    const entry: CacheEntry = {
      kind: 'score',
      score,
      label: decided,
      skip_reason: null,
    };
    resultCache.set(cacheKeyNoPixels(img), entry);
    // Settle so concurrent autoscan does not overwrite injected scores (e2e AC-A1).
    settled.add(img);
    inFlight.delete(img);
    sendResponse({
      ok: true,
      score,
      label: decided,
      text: formatBadgeText(score, decided),
      imageId: imageIdFor(img, imgs.indexOf(img)),
    });
    return false;
  }

  return false;
});
