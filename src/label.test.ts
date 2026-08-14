import { describe, expect, it } from 'vitest';
import {
  THRESHOLD,
  formatBadgeText,
  labelFromScore,
  thresholdRuleText,
} from './label.js';

describe('labelFromScore (A1 / AC-A1)', () => {
  it('0.64 is real (strictly below THRESHOLD)', () => {
    expect(0.64).toBeLessThan(THRESHOLD);
    expect(labelFromScore(0.64)).toBe('real');
  });

  it('0.65 is ai (at THRESHOLD)', () => {
    expect(THRESHOLD).toBe(0.65);
    expect(labelFromScore(0.65)).toBe('ai');
  });

  it('uses THRESHOLD only — boundary and extremes', () => {
    expect(labelFromScore(THRESHOLD - 1e-9)).toBe('real');
    expect(labelFromScore(THRESHOLD)).toBe('ai');
    expect(labelFromScore(0)).toBe('real');
    expect(labelFromScore(1)).toBe('ai');
  });
});

describe('thresholdRuleText', () => {
  it('derives percent from THRESHOLD (no hardcoded 65)', () => {
    expect(thresholdRuleText()).toBe(
      `AI if >= ${Math.round(THRESHOLD * 100)}%`,
    );
    expect(thresholdRuleText()).toBe('AI if >= 65%');
  });
});

describe('formatBadgeText (AC-NUM)', () => {
  it('includes numeric score and label', () => {
    expect(formatBadgeText(0.64)).toBe('0.64 Real');
    expect(formatBadgeText(0.65)).toBe('0.65 AI');
    expect(formatBadgeText(0.5, 'real')).toBe('0.50 Real');
  });
});
