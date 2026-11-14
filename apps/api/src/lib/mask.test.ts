import { describe, it, expect } from 'vitest';
import { maskPhone } from './mask';

describe('maskPhone', () => {
  it('keeps the country prefix and last two digits', () => {
    expect(maskPhone('+96555551234')).toBe('+965******34');
  });
  it('fully masks short or malformed values', () => {
    expect(maskPhone('123')).toBe('****');
    expect(maskPhone('')).toBe('****');
  });
  it('never returns the original', () => {
    expect(maskPhone('+15551234567')).not.toContain('5551234');
  });
});
