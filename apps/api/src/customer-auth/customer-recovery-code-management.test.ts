import { describe, expect, it, vi } from 'vitest';
import { createRecoveryCodeManagementLimiter } from './customer-recovery-code-management';

const secret = 'synthetic-recovery-code-budget-secret-32-bytes';
const input = { sourceKey: 'signed-source', customerId: '11111111-1111-4111-8111-111111111111' };
describe('recovery code management budget composition', () => {
  it('uses opaque, stable, dimension-separated keys and the approved ceilings', async () => {
    const calls: Array<{ key: string; limit: number; windowSeconds: number }> = [];
    const allow = createRecoveryCodeManagementLimiter(secret, async value => { calls.push(value); return true; });
    expect(await allow(input)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.key).not.toBe(calls[1]!.key);
    for (const call of calls) {
      expect(call.key).toMatch(/:[a-f0-9]{64}$/);
      expect(call.limit).toBe(5); expect(call.windowSeconds).toBe(900);
      expect(call.key).not.toContain(input.customerId); expect(call.key).not.toContain(input.sourceKey);
    }
    await allow(input);
    expect(calls[2]).toEqual(calls[0]); expect(calls[3]).toEqual(calls[1]);
    await allow({ ...input, customerId: '22222222-2222-4222-8222-222222222222' });
    expect(calls[4]).toEqual(calls[0]); expect(calls[5]!.key).not.toBe(calls[1]!.key);
  });
  it.each([0, 1])('refuses an exhausted dimension %s', async denied => {
    let i = 0;
    const allow = createRecoveryCodeManagementLimiter(secret, async () => i++ !== denied);
    expect(await allow(input)).toBe(false);
  });
  it('does not turn missing keys, invalid identities or limiter failure into allowance', async () => {
    const limit = vi.fn(async () => true);
    await expect(createRecoveryCodeManagementLimiter('short', limit)(input)).rejects.toThrow();
    await expect(createRecoveryCodeManagementLimiter(secret, limit)({ ...input, customerId: 'invalid' })).rejects.toThrow();
    expect(limit).not.toHaveBeenCalled();
    await expect(createRecoveryCodeManagementLimiter(secret, async () => { throw new Error('unavailable'); })(input)).rejects.toThrow();
  });
});
