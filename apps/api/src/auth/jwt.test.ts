import { describe, it, expect } from 'vitest';
import { signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken } from './jwt';

const SECRET = 'test-secret-do-not-use-in-production';
const OTHER_SECRET = 'a-different-secret';

describe('access tokens', () => {
  it('round-trips: sign then verify returns the same userId', async () => {
    const token = await signAccessToken('user-123', SECRET);
    const payload = await verifyAccessToken(token, SECRET);
    expect(payload.sub).toBe('user-123');
    expect(payload.type).toBe('access');
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signAccessToken('user-123', SECRET);
    await expect(verifyAccessToken(token, OTHER_SECRET)).rejects.toThrow();
  });
});

describe('refresh tokens', () => {
  it('round-trips and embeds the given token id as jti', async () => {
    const { token } = await signRefreshToken('user-123', 'token-id-abc', SECRET);
    const payload = await verifyRefreshToken(token, SECRET);
    expect(payload.sub).toBe('user-123');
    expect(payload.jti).toBe('token-id-abc');
    expect(payload.type).toBe('refresh');
  });

  it('returns an expiresAt roughly 30 days out', async () => {
    const { expiresAt } = await signRefreshToken('user-123', 'token-id', SECRET);
    const daysOut = (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    expect(daysOut).toBeGreaterThan(29.9);
    expect(daysOut).toBeLessThan(30.1);
  });

  it('an access token cannot verify as a refresh token, even with the right secret', async () => {
    // In production the two secrets already prevent this; using the same
    // SECRET for both calls here isolates and proves the `type` field is
    // real defense in depth, not dead code.
    const accessToken = await signAccessToken('user-123', SECRET);
    await expect(verifyRefreshToken(accessToken, SECRET)).rejects.toThrow();
  });
});
