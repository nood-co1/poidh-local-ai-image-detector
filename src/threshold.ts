/**
 * Decision threshold for AI vs Real (A1 / I16 source of truth).
 * AI iff score >= THRESHOLD, else real.
 * Import this constant everywhere — do not duplicate the number.
 */
export const THRESHOLD = 0.65;
