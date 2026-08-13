/**
 * debug.html companion (test only — not soul-3 evidence).
 * Single Infer button: decode the loaded <img> pixels, send ANALYZE_IMAGE.
 */

const img = document.getElementById('fixture');
const btn = document.getElementById('infer');
const out = document.getElementById('out');

/**
 * @param {HTMLImageElement} el
 * @returns {Promise<{width:number,height:number,data:number[]}>}
 */
async function rgbFromLoadedImage(el) {
  if (!el.complete || el.naturalWidth < 1) {
    throw new Error('image not loaded');
  }
  const bitmap = await createImageBitmap(el);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    ctx.drawImage(bitmap, 0, 0);
    const { data, width, height } = ctx.getImageData(
      0,
      0,
      bitmap.width,
      bitmap.height,
    );
    const rgb = new Array(width * height * 3);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      rgb[j] = data[i];
      rgb[j + 1] = data[i + 1];
      rgb[j + 2] = data[i + 2];
    }
    return { width, height, data: rgb };
  } finally {
    bitmap.close();
  }
}

function setOut(text) {
  if (out) out.textContent = text;
}

async function runInfer() {
  if (!img || !btn) return;
  btn.disabled = true;
  setOut('inferring…');
  try {
    const rgb = await rgbFromLoadedImage(/** @type {HTMLImageElement} */ (img));
    const result = await chrome.runtime.sendMessage({
      type: 'ANALYZE_IMAGE',
      scanId: `debug-${Date.now()}`,
      imageId: 'debug-fixture',
      image: {
        width: rgb.width,
        height: rgb.height,
        data: rgb.data,
      },
    });
    setOut(JSON.stringify(result, null, 2));
  } catch (err) {
    setOut(err instanceof Error ? err.message : String(err));
  } finally {
    btn.disabled = false;
  }
}

function arm() {
  if (!img || !btn) return;
  if (img.complete && img.naturalWidth > 0) {
    btn.disabled = false;
    setOut('ready — click Infer');
  } else {
    img.addEventListener(
      'load',
      () => {
        btn.disabled = false;
        setOut('ready — click Infer');
      },
      { once: true },
    );
    img.addEventListener(
      'error',
      () => {
        setOut('fixture image failed to load');
      },
      { once: true },
    );
  }
  btn.addEventListener('click', () => {
    void runInfer();
  });
}

arm();
