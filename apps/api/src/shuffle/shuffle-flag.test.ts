import { describe, expect, it } from 'vitest';
import { isTentashipShuffleEnabled } from './shuffle-flag';

describe('TENTASHIP_SHUFFLE_ENABLED (fail-closed, exact string only, independent)', () => {
  it.each([[undefined, false], ['true', true], ['false', false], ['TRUE', false], ['1', false], ['yes', false], [' true', false], ['true ', false], ['', false], ['enabled', false]])('%j -> %s', (v, expected) => {
    expect(isTentashipShuffleEnabled({ TENTASHIP_SHUFFLE_ENABLED: v as string | undefined })).toBe(expected);
  });
  it('is independent of Badges, Drops and every Community control', () => {
    const others = { TENTASHIP_BADGES_ENABLED: 'true', TENTASHIP_DROPS_ENABLED: 'true', NETWORK_FEED_ENABLED: 'true', NETWORK_BUSINESS_PUBLISHING_ENABLED: 'true' };
    expect(isTentashipShuffleEnabled(others as never)).toBe(false);
    expect(isTentashipShuffleEnabled({ TENTASHIP_SHUFFLE_ENABLED: 'true' })).toBe(true);
  });
});
