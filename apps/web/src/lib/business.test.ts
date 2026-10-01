import { describe, expect, it } from 'vitest';
import type { BusinessDto } from '@echo-grid-feedback/shared-types';
import { selectActiveBusiness } from './business-selection';

const businesses = [
  { id: 'first', name: 'First' },
  { id: 'second', name: 'Second' },
] as BusinessDto[];

describe('selectActiveBusiness', () => {
  it('uses the selected membership', () => expect(selectActiveBusiness(businesses, 'second')?.id).toBe('second'));
  it('falls back safely when a stale or forged id is stored', () => expect(selectActiveBusiness(businesses, 'unknown')?.id).toBe('first'));
  it('returns null without memberships', () => expect(selectActiveBusiness([], 'unknown')).toBeNull());
});

