import { describe, expect, it } from 'vitest';
import { THRESHOLD } from './threshold.js';

describe('THRESHOLD', () => {
  it('is locked at 0.65', () => {
    expect(THRESHOLD).toBe(0.65);
  });
});
