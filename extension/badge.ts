/**
 * Shadow-DOM score badge (section 3.1).
 * Primary UI for autoscan — no orphan badge without ANALYZE_RESULT / skip path.
 *
 * Skips and errors render as "unavailable", never coerced to "real" (E2 / R-SKIP-NOT-REAL).
 */

export const BADGE_TESTID = 'aidet-badge';

/** CSS px threshold: images smaller than this on both axes are skip_small. */
export const MIN_ELIGIBLE_CSS_PX = 64;

export type BadgeState =
  | { kind: 'loading' }
  | { kind: 'score'; score: number; label: string }
  | { kind: 'unavailable'; reason?: string };

export interface BadgeHandle {
  /** Update visible badge text/state. */
  setState(state: BadgeState): void;
  /** Host element (light DOM) that owns the open shadow root. */
  host: HTMLElement;
  /** Remove host from the document. */
  remove(): void;
  /** Reposition over the target image (scroll/resize). */
  reposition(): void;
}

const HOST_ATTR = 'data-aidet-badge-host';

/**
 * Create (or reuse) a positioned shadow-DOM badge over `img`.
 * The visible node carries `data-testid=aidet-badge`.
 */
export function attachBadge(img: HTMLImageElement): BadgeHandle {
  const existing = findHostFor(img);
  if (existing) {
    return wrapExisting(existing, img);
  }

  const host = document.createElement('div');
  host.setAttribute(HOST_ATTR, '1');
  host.style.cssText = [
    'position:absolute',
    'z-index:2147483646',
    'pointer-events:none',
    'margin:0',
    'padding:0',
    'border:0',
    'line-height:1',
  ].join(';');

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .badge {
      display: inline-block;
      font: 600 11px/1.2 system-ui, -apple-system, sans-serif;
      color: #0b0b0b;
      background: #f5e642;
      border: 1px solid #1a1a1a;
      border-radius: 4px;
      padding: 2px 6px;
      box-shadow: 0 1px 2px rgba(0,0,0,.35);
      white-space: nowrap;
      max-width: 12rem;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .badge[data-state="loading"] {
      background: #ccc;
      color: #333;
    }
    .badge[data-state="unavailable"] {
      background: #555;
      color: #f2f2f2;
    }
    .badge[data-state="score"][data-label="ai"] {
      background: #ff6b4a;
      color: #111;
    }
    .badge[data-state="score"][data-label="real"] {
      background: #7ddea2;
      color: #111;
    }
  `;
  const badge = document.createElement('div');
  badge.setAttribute('data-testid', BADGE_TESTID);
  badge.className = 'badge';
  badge.dataset['state'] = 'loading';
  badge.textContent = '…';
  shadow.append(style, badge);

  ensurePositioningContext(img);
  placeNear(img, host);
  document.documentElement.appendChild(host);

  return makeHandle(host, badge, img);
}

function findHostFor(img: HTMLImageElement): HTMLElement | null {
  const all = Array.from(
    document.querySelectorAll<HTMLElement>(`[${HOST_ATTR}]`),
  );
  for (const h of all) {
    if ((h as HTMLElement & { __aidetImg?: HTMLImageElement }).__aidetImg === img) {
      return h;
    }
  }
  return null;
}

function wrapExisting(host: HTMLElement, img: HTMLImageElement): BadgeHandle {
  const badge = host.shadowRoot?.querySelector<HTMLElement>(
    `[data-testid="${BADGE_TESTID}"]`,
  );
  if (!badge) {
    host.remove();
    return attachBadge(img);
  }
  return makeHandle(host, badge, img);
}

function makeHandle(
  host: HTMLElement,
  badge: HTMLElement,
  img: HTMLImageElement,
): BadgeHandle {
  (host as HTMLElement & { __aidetImg?: HTMLImageElement }).__aidetImg = img;

  const setState = (state: BadgeState): void => {
    if (state.kind === 'loading') {
      badge.dataset['state'] = 'loading';
      delete badge.dataset['label'];
      badge.textContent = '…';
      return;
    }
    if (state.kind === 'unavailable') {
      badge.dataset['state'] = 'unavailable';
      delete badge.dataset['label'];
      // Never show "real" for skips/errors (R-SKIP-NOT-REAL).
      badge.textContent = 'unavailable';
      if (state.reason) {
        badge.title = state.reason;
      }
      return;
    }
    badge.dataset['state'] = 'score';
    badge.dataset['label'] = state.label;
    // Numeric score is the primary visible success signal (AC-TESTID / AC-NUM).
    const n = Number.isFinite(state.score) ? state.score : 0;
    badge.textContent = `${n.toFixed(2)}`;
    badge.title = `${state.label} ${n.toFixed(4)}`;
  };

  const reposition = (): void => {
    if (!img.isConnected) {
      host.remove();
      return;
    }
    placeNear(img, host);
  };

  return {
    setState,
    host,
    remove: () => {
      host.remove();
    },
    reposition,
  };
}

function ensurePositioningContext(img: HTMLImageElement): void {
  // Prefer absolute over the image; body-relative coords from getBoundingClientRect + scroll.
  void img;
}

function placeNear(img: HTMLImageElement, host: HTMLElement): void {
  const rect = img.getBoundingClientRect();
  const top = rect.top + window.scrollY + 4;
  const left = rect.left + window.scrollX + 4;
  host.style.top = `${Math.max(0, top)}px`;
  host.style.left = `${Math.max(0, left)}px`;
}

/**
 * CSS box size for eligibility (>= MIN_ELIGIBLE_CSS_PX on at least one axis).
 * Uses getBoundingClientRect so transforms / max-width are respected.
 */
export function cssSize(img: HTMLImageElement): { width: number; height: number } {
  const rect = img.getBoundingClientRect();
  // Fall back to attributes / natural when not laid out yet.
  const width =
    rect.width > 0
      ? rect.width
      : img.clientWidth || Number(img.getAttribute('width')) || img.naturalWidth;
  const height =
    rect.height > 0
      ? rect.height
      : img.clientHeight ||
        Number(img.getAttribute('height')) ||
        img.naturalHeight;
  return { width, height };
}

/** Eligible for autoscan badge when at least one CSS axis is >= 64px. */
export function isEligibleImage(img: HTMLImageElement): boolean {
  const { width, height } = cssSize(img);
  return width >= MIN_ELIGIBLE_CSS_PX || height >= MIN_ELIGIBLE_CSS_PX;
}
