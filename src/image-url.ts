/**
 * Pick the best URL to GET for a displayed <img>.
 * Twitter/X thumbs often use name=small; the same asset at name=large
 * keeps generator artifacts that the 0.65 head can actually see.
 */

export interface ImageSrcLike {
  currentSrc?: string;
  src?: string;
  srcset?: string;
  getAttribute?(name: string): string | null;
}

const ATTRS = [
  'data-src',
  'data-orig-src',
  'data-url',
  'data-image-url',
  'data-full-url',
] as const;

/** Upgrade known CDN query/path variants to a larger still-image rendition. */
export function upgradeKnownCdnUrl(raw: string): string {
  if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) {
    return raw;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }

  const host = url.hostname.toLowerCase();
  if (host === 'pbs.twimg.com' || host.endsWith('.twimg.com')) {
    const name = url.searchParams.get('name');
    if (name && name !== 'large' && name !== 'orig' && name !== '4096x4096') {
      url.searchParams.set('name', 'large');
    }
    // profile_images/..._normal.jpg is a 48px face crop.
    url.pathname = url.pathname.replace(
      /_(?:normal|bigger|mini)(\.[a-z]+)$/i,
      '_400x400$1',
    );
    return url.href;
  }

  return raw;
}

function srcsetEntries(srcset: string): Array<{ url: string; width: number }> {
  const out: Array<{ url: string; width: number }> = [];
  for (const part of srcset.split(',')) {
    const bits = part.trim().split(/\s+/);
    const url = bits[0];
    if (!url) continue;
    let width = 0;
    const desc = bits[1] ?? '';
    if (desc.endsWith('w')) {
      width = Number.parseInt(desc, 10) || 0;
    } else if (desc.endsWith('x')) {
      width = Math.round((Number.parseFloat(desc) || 1) * 400);
    }
    out.push({ url, width });
  }
  return out;
}

function qualityHint(url: string, widthBonus = 0): number {
  let q = widthBonus;
  if (/name=4096x4096|name=orig/i.test(url)) q += 1_000_000;
  else if (/name=large/i.test(url)) q += 800_000;
  else if (/name=medium/i.test(url)) q += 200_000;
  else if (/name=small|name=thumb|name=120x120/i.test(url)) q += 1_000;
  const dim = url.match(/(\d{2,4})x(\d{2,4})/);
  if (dim) q += Number(dim[1]) * Number(dim[2]);
  if (url.startsWith('blob:') || url.startsWith('data:')) q -= 50_000;
  return q;
}

/**
 * Best GET URL for an <img>: largest srcset candidate, then currentSrc/src,
 * then common lazy-load attrs, then CDN upgrade (X name=small → name=large).
 */
export function preferredImageSrc(img: ImageSrcLike): string {
  const scored: Array<{ url: string; q: number }> = [];
  const add = (url: string | null | undefined, extra = 0): void => {
    if (!url) return;
    const trimmed = url.trim();
    if (!trimmed) return;
    scored.push({ url: trimmed, q: qualityHint(trimmed, extra) });
  };

  add(img.currentSrc, 10);
  add(img.src);
  if (img.srcset) {
    for (const entry of srcsetEntries(img.srcset)) {
      add(entry.url, entry.width);
    }
  }
  if (typeof img.getAttribute === 'function') {
    for (const attr of ATTRS) {
      add(img.getAttribute(attr));
    }
  }

  if (scored.length === 0) return '';
  scored.sort((a, b) => b.q - a.q);
  return upgradeKnownCdnUrl(scored[0]!.url);
}
