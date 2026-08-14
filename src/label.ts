/**
 * A1 decision label helper (section 3.2 / soul 5).
 *
 * Single place for score → ai|real. Imports THRESHOLD — never hardcode 0.65
 * or invent 0.5. Badge text, popup rule line, and infer path share this module.
 */

import { THRESHOLD } from './threshold.js';

export { THRESHOLD };

/** Decision label for scored images (skip/error are not decisions). */
export type DecisionLabel = 'ai' | 'real';

/** chrome.storage.local key for pause-scanning flag (AC-PAUSE / G-REENTRY). */
export const PAUSE_STORAGE_KEY = 'scanningPaused';

/**
 * A1: AI iff score >= THRESHOLD, else real.
 * Boundary: score === THRESHOLD → ai (0.65 ai, 0.64 real).
 */
export function labelFromScore(score: number): DecisionLabel {
  return score >= THRESHOLD ? 'ai' : 'real';
}

/**
 * Popup rule line derived from THRESHOLD (do not hardcode "65%").
 * Example with THRESHOLD=0.65: "AI if >= 65%"
 */
export function thresholdRuleText(): string {
  const pct = Math.round(THRESHOLD * 100);
  return `AI if >= ${pct}%`;
}

/**
 * Visible badge text: numeric confidence in [0,1] plus ai|real label (AC-NUM).
 * Always recomputes label via labelFromScore unless an explicit DecisionLabel is given.
 */
export function formatBadgeText(
  score: number,
  label?: DecisionLabel,
): string {
  const n = Number.isFinite(score) ? score : 0;
  const clamped = Math.min(1, Math.max(0, n));
  const lab = label ?? labelFromScore(clamped);
  return `${clamped.toFixed(2)} ${lab === 'ai' ? 'AI' : 'Real'}`;
}
