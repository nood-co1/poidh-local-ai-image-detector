/**
 * Minimal content script (section 2.3 pixel path; 3.1 expands overlay).
 *
 * Primary path (E2): already-displayed bitmaps via createImageBitmap / canvas
 * draw of the loaded <img> — never a new GET of the image URL while scanning.
 */

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

function imageIdFor(img: HTMLImageElement, index: number): string {
  const attr = img.getAttribute('data-image-id');
  if (attr) return attr;
  if (img.src) return img.src;
  if (img.currentSrc) return img.currentSrc;
  return `img-${index}`;
}

/**
 * Scan all complete <img> elements on the page using displayed pixels only.
 */
export async function scanLoadedImages(
  scanId: string,
): Promise<ScanPageResult> {
  const imgs = Array.from(document.images).filter(
    (img) => img.complete && img.naturalWidth > 0 && img.naturalHeight > 0,
  );

  const results: AnalyzeResultLike[] = [];

  for (let i = 0; i < imgs.length; i++) {
    const img = imgs[i]!;
    const imageId = imageIdFor(img, i);
    try {
      const rgb = await rgbFromLoadedImage(img);
      const response = (await chrome.runtime.sendMessage({
        type: 'ANALYZE_IMAGE',
        scanId,
        imageId,
        // Pixel path: raw RGB from the already-loaded element (no src re-fetch).
        image: {
          width: rgb.width,
          height: rgb.height,
          data: rgb.data,
        },
      })) as AnalyzeResultLike | undefined;

      if (response && typeof response === 'object' && response.type) {
        results.push(response);
      } else {
        results.push({
          type: 'ANALYZE_ERROR',
          scanId,
          imageId,
          code: 'INFER',
        });
      }
    } catch {
      results.push({
        type: 'ANALYZE_ERROR',
        scanId,
        imageId,
        code: 'DECODE',
      });
    }
  }

  return {
    type: 'SCAN_PAGE_RESULT',
    ok: true,
    scanId,
    results,
  };
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
        : `scan-${Date.now()}`;
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
    });
    return false;
  }

  return false;
});
