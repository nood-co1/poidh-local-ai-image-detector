/**
 * Shadow-DOM score badge (sections 3.1 + 3.2).
 * Primary UI for autoscan — no orphan badge without ANALYZE_RESULT / skip path.
 *
 * Success text: numeric score in [0,1] + ai|real from label.ts (A1 / THRESHOLD).
 * Skips and errors render as "unavailable", never coerced to "real" (R-SKIP-NOT-REAL).
 */

import {
  formatBadgeText,
  labelFromScore,
  type DecisionLabel,
} from '../src/label.js';

export const BADGE_TESTID = 'aidet-badge';

/** CSS px threshold: images smaller than this on both axes are skip_small. */
export const MIN_ELIGIBLE_CSS_PX = 64;

export type BadgeState =
  | { kind: 'loading' }
  | { kind: 'score'; score: number; label?: DecisionLabel | string }
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
      font: 800 12px/1.2 system-ui, -apple-system, sans-serif;
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
      background: #ff2d2d;
      color: #fff;
    }
    .badge[data-state="score"][data-label="real"] {
      background: #1f9d55;
      color: #fff;
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
        const hint =
          state.reason === 'MODEL_MISSING'
            ? 'Model not loaded — open the extension popup and click Start setup'
            : state.reason === 'skip_cross_origin'
              ? 'Could not read this image (cross-origin). Hover a same-origin photo or wait for setup.'
              : state.reason;
        badge.title = hint;
      }
      return;
    }
    badge.dataset['state'] = 'score';
    // Always decide via label.ts (AC-A1) — do not trust caller label alone.
    const n = Number.isFinite(state.score) ? state.score : 0;
    const decided: DecisionLabel = labelFromScore(n);
    badge.dataset['label'] = decided;
    // AC-NUM: numeric score + ai|real visible on the badge.
    badge.textContent = formatBadgeText(n, decided);
    badge.title = `${decided} ${n.toFixed(4)}`;
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
