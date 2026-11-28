import { describe, expect, it } from 'vitest';
import { identityName, initialsOf } from './profile-identity';

describe('profile identity helpers', () => {
  it('takes up to two initials, in any script', () => {
    expect(initialsOf('Amina Kato')).toBe('AK');
    expect(initialsOf('amina')).toBe('A');
    expect(initialsOf('  José   María   Ortega ')).toBe('JO');
    expect(initialsOf('محمد علي')).toBe('مع');
  });
  it('shows a question mark when there is no name', () => {
    expect(initialsOf(null)).toBe('?');
    expect(initialsOf('   ')).toBe('?');
  });
  it('prefers the chosen display name over the account name', () => {
    expect(identityName({ displayName: 'Mina', fullName: 'Amina Kato' })).toBe('Mina');
    expect(identityName({ displayName: null, fullName: 'Amina Kato' })).toBe('Amina Kato');
    expect(identityName({ displayName: null, fullName: null })).toBeNull();
    expect(identityName(null)).toBeNull();
  });
});
