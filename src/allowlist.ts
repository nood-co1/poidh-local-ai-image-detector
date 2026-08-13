/**
 * Privacy allowlist (section 3.3 / soul 6 / E2).
 *
 * Fail-closed policy for network activity after models_ready:
 *   - GET of a displayed image URL is allowed (online fallback only)
 *   - POST / PUT / PATCH / WebSocket carrying image bytes is forbidden
 *   - GET of model / wasm / tokenizer artifacts is forbidden (path-based,
 *     not host-based — Hugging Face may still serve fixture images)
 *
 * Used by the privacy HAR e2e (and unit tests). Runtime weight fetch is
 * also refused in artifact-store after models_ready; this module is the
 * single classifier for URL+method inspection.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Network request shape captured from Playwright / CDP / HAR. */
export interface NetworkRequest {
  /** Absolute or relative request URL. */
  url: string;
  /** HTTP method (GET, POST, …) or "WebSocket" for WS upgrades. */
  method: string;
  /**
   * Playwright resource type when known
   * (`image`, `fetch`, `xhr`, `websocket`, `script`, …).
   */
  resourceType?: string | null;
  /** Request body (POST data / first WS payload) when available. */
  postData?: string | null;
  /**
   * Headers as a map or list of name/value pairs.
   * Case-insensitive lookup is applied.
   */
  headers?:
    | Record<string, string>
    | ReadonlyArray<{ name: string; value: string }>
    | null;
  /**
   * True when the request was issued by an extension service worker
   * (Playwright `request.serviceWorker()`).
   */
  fromServiceWorker?: boolean;
}

export type AllowlistViolation =
  | 'post_image'
  | 'ws_image'
  | 'model_fetch'
  | 'other';

export type AllowlistVerdict =
  | { allowed: true; reason: string }
  | { allowed: false; reason: string; violation: AllowlistViolation };

export interface ClassifyOptions {
  /**
   * When true (default for post-setup inspection), path-based model/wasm/
   * tokenizer GETs over http(s) are forbidden. During first-run setup this
   * should be false so the one-time weight download is not flagged.
   */
  modelsReady?: boolean;
}

/** Narrowed verdict for a denied request. */
export type DeniedVerdict = Extract<AllowlistVerdict, { allowed: false }>;

export interface EvaluateHarResult {
  ok: boolean;
  /** Requests that failed the allowlist. */
  violations: Array<{ request: NetworkRequest; verdict: DeniedVerdict }>;
  /** Subset of input issued by a service worker (AC-HAR witness). */
  serviceWorkerRequests: NetworkRequest[];
  /** Displayed-image GETs that were permitted (AC-GET witness). */
  allowedImageGets: NetworkRequest[];
}

// ---------------------------------------------------------------------------
// Path-based model / wasm / tokenizer detection (NOT host-based)
// ---------------------------------------------------------------------------

/**
 * Path patterns for inference artifacts that must not be fetched after
 * models_ready. Host is intentionally ignored so a weight host can still
 * serve fixture images (e.g. PNG under huggingface.co) without failing.
 */
const MODEL_ARTIFACT_PATH_RE = new RegExp(
  [
    // Production / export weights
    String.raw`\.onnx(?:\?|#|$)`,
    String.raw`\.safetensors(?:\?|#|$)`,
    String.raw`(?:^|/)pytorch_model`,
    String.raw`(?:^|/)model\.bin(?:\?|#|$)`,
    // ORT / wasm runtimes
    String.raw`\.wasm(?:\?|#|$)`,
    String.raw`ort-wasm`,
    // Tokenizers / vocab (transformers-style)
    String.raw`(?:^|/)tokenizer(?:[-._/]|$)`,
    String.raw`(?:^|/)vocab\.(?:json|txt)(?:\?|#|$)`,
    String.raw`(?:^|/)merges\.txt(?:\?|#|$)`,
    String.raw`(?:^|/)special_tokens_map\.json(?:\?|#|$)`,
    String.raw`(?:^|/)tokenizer_config\.json(?:\?|#|$)`,
  ].join('|'),
  'i',
);

/** Common image extensions / image URL path shapes for displayed fixtures. */
const IMAGE_PATH_RE =
  /\.(?:png|jpe?g|gif|webp|bmp|svg|avif|ico)(?:\?|#|$)/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeMethod(method: string): string {
  return (method || 'GET').trim().toUpperCase();
}

function headerMap(
  headers: NetworkRequest['headers'],
): Record<string, string> {
  if (!headers) return {};
  if (Array.isArray(headers)) {
    const out: Record<string, string> = {};
    for (const h of headers) {
      if (h && typeof h.name === 'string') {
        out[h.name.toLowerCase()] = String(h.value ?? '');
      }
    }
    return out;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = String(v);
  }
  return out;
}

/**
 * Extract the path (+ query) used for path-based classification.
 * Falls back to the raw string when URL parsing fails.
 */
export function requestPath(url: string): string {
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
      const u = new URL(url);
      return `${u.pathname}${u.search}`;
    }
  } catch {
    /* fall through */
  }
  // Relative or opaque
  const q = url.indexOf('?');
  const h = url.indexOf('#');
  let end = url.length;
  if (q >= 0) end = Math.min(end, q);
  if (h >= 0) end = Math.min(end, h);
  // Prefer last path-looking segment for scheme-relative
  return url.slice(0, end) || url;
}

/** True for chrome-extension / blob / data / file — not network egress. */
export function isLocalOrExtensionUrl(url: string): boolean {
  return /^(chrome-extension|chrome|blob|data|file|about):/i.test(url);
}

/** True for http(s) network URLs. */
export function isNetworkUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * Path-based: URL looks like a model / wasm / tokenizer artifact.
 * Host is not consulted.
 */
export function isModelArtifactUrl(url: string): boolean {
  const path = requestPath(url);
  // Also test the full URL so query-less absolute paths match.
  return MODEL_ARTIFACT_PATH_RE.test(path) || MODEL_ARTIFACT_PATH_RE.test(url);
}

/**
 * Path or resourceType suggests a displayed image GET.
 */
export function isDisplayedImageUrl(
  url: string,
  resourceType?: string | null,
): boolean {
  if (resourceType && resourceType.toLowerCase() === 'image') return true;
  return IMAGE_PATH_RE.test(requestPath(url)) || IMAGE_PATH_RE.test(url);
}

/**
 * Detect image bytes on POST/PUT/PATCH/WebSocket bodies.
 * Heuristics: Content-Type, magic bytes, data-URL, large base64 image fields.
 */
export function carriesImageBytes(
  method: string,
  postData: string | null | undefined,
  headers?: NetworkRequest['headers'],
  resourceType?: string | null,
): boolean {
  const m = normalizeMethod(method);
  const isWs =
    m === 'WEBSOCKET' ||
    (resourceType != null && resourceType.toLowerCase() === 'websocket');
  const isBodyMethod =
    m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';

  if (!isWs && !isBodyMethod) return false;

  const hdrs = headerMap(headers);
  const ct = hdrs['content-type'] ?? '';

  if (/^image\//i.test(ct) || /\/octet-stream/i.test(ct) && looksLikeImageMagic(postData)) {
    return true;
  }
  if (
    /multipart\/form-data/i.test(ct) &&
    typeof postData === 'string' &&
    /filename\s*=\s*"[^"]+\.(?:png|jpe?g|gif|webp|bmp)"/i.test(postData)
  ) {
    return true;
  }

  if (typeof postData === 'string' && postData.length > 0) {
    if (looksLikeImageMagic(postData)) return true;
    if (/^data:image\//i.test(postData)) return true;
    // JSON / form field with a large base64 image payload
    if (
      /["']?(?:image|pixels|bitmap|png|jpeg|photo|file)["']?\s*[:=]\s*["']data:image\//i.test(
        postData,
      )
    ) {
      return true;
    }
    if (
      /["'](?:image|pixels|bitmap|photo)["']\s*:\s*["'][A-Za-z0-9+/=\s]{256,}["']/.test(
        postData,
      )
    ) {
      return true;
    }
  }

  return false;
}

function looksLikeImageMagic(data: string | null | undefined): boolean {
  if (typeof data !== 'string' || data.length < 4) return false;
  // PNG
  if (data.charCodeAt(0) === 0x89 && data.startsWith('\x89PNG')) return true;
  // JPEG
  if (
    data.charCodeAt(0) === 0xff &&
    data.charCodeAt(1) === 0xd8 &&
    data.charCodeAt(2) === 0xff
  ) {
    return true;
  }
  // GIF
  if (data.startsWith('GIF87a') || data.startsWith('GIF89a')) return true;
  // WebP (RIFF....WEBP)
  if (data.startsWith('RIFF') && data.length >= 12 && data.slice(8, 12) === 'WEBP') {
    return true;
  }
  // ASCII-escaped PNG from JSON dumps
  if (data.includes('\u0089PNG') || data.includes('\\x89PNG')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify a single request under the privacy allowlist.
 *
 * Fail-closed for known bad patterns; everything else is allowed (GET of
 * displayed images, extension package resources, ordinary page navigation).
 */
export function classifyRequest(
  req: NetworkRequest,
  options: ClassifyOptions = {},
): AllowlistVerdict {
  const modelsReady = options.modelsReady !== false;
  const method = normalizeMethod(req.method);
  const url = req.url ?? '';
  const resourceType = req.resourceType ?? null;
  const isWs =
    method === 'WEBSOCKET' ||
    (resourceType != null && resourceType.toLowerCase() === 'websocket');

  // --- Forbidden: POST/WS with image bytes (any phase) ---
  if (carriesImageBytes(method, req.postData, req.headers, resourceType)) {
    if (isWs) {
      return {
        allowed: false,
        reason: `WebSocket carries image bytes: ${url}`,
        violation: 'ws_image',
      };
    }
    return {
      allowed: false,
      reason: `${method} carries image bytes: ${url}`,
      violation: 'post_image',
    };
  }

  // --- Forbidden: post-setup network GET of model/wasm/tokenizer (path-based) ---
  if (modelsReady && isNetworkUrl(url) && isModelArtifactUrl(url)) {
    // Only network egress. chrome-extension:// wasm is local packaging.
    return {
      allowed: false,
      reason: `post-setup model/wasm/tokenizer fetch: ${method} ${url}`,
      violation: 'model_fetch',
    };
  }

  // --- Allowed: local / extension package ---
  if (isLocalOrExtensionUrl(url)) {
    return { allowed: true, reason: 'local or extension package URL' };
  }

  // --- Allowed: GET of displayed image URL (online fallback) ---
  if (
    (method === 'GET' || method === 'HEAD') &&
    isDisplayedImageUrl(url, resourceType)
  ) {
    return {
      allowed: true,
      reason: 'GET of displayed image URL (online fallback permitted)',
    };
  }

  // --- Allowed: ordinary navigation / XHR / non-artifact traffic ---
  // Fail-closed only for the named violations above; bare POSTs without
  // image bytes (e.g. analytics the product does not ship) are not the
  // privacy claim — image-byte POST and model GET are.
  return { allowed: true, reason: 'no privacy violation pattern matched' };
}

/**
 * Evaluate a HAR / network log under the allowlist (post-setup default).
 */
export function evaluateHar(
  requests: readonly NetworkRequest[],
  options: ClassifyOptions = {},
): EvaluateHarResult {
  const modelsReady = options.modelsReady !== false;
  const violations: EvaluateHarResult['violations'] = [];
  const serviceWorkerRequests: NetworkRequest[] = [];
  const allowedImageGets: NetworkRequest[] = [];

  for (const req of requests) {
    if (req.fromServiceWorker) {
      serviceWorkerRequests.push(req);
    }
    const verdict = classifyRequest(req, { modelsReady });
    if (!verdict.allowed) {
      violations.push({ request: req, verdict: verdict as DeniedVerdict });
      continue;
    }
    const method = normalizeMethod(req.method);
    if (
      (method === 'GET' || method === 'HEAD') &&
      isDisplayedImageUrl(req.url, req.resourceType) &&
      isNetworkUrl(req.url)
    ) {
      allowedImageGets.push(req);
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    serviceWorkerRequests,
    allowedImageGets,
  };
}
