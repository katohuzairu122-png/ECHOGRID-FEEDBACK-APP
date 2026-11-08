import { describe, expect, it, vi } from 'vitest';
import { VelocityTracker, type VelocityKv } from './velocity-tracker';

const salt = 'test-only-salted-velocity';
const limits = { windowSeconds: 600, threshold: 2 };
const input = {
  eventType: 'feedback_submit',
  ip: '192.0.2.10',
  deviceSignal: 'device-a',
  deviceLimits: limits,
  ipLimits: limits,
};

function kvWith(raw: string | null) {
  const get = vi.fn(async (_key: string) => raw);
  const put = vi.fn(async (_key: string, _value: string, _opts: { expirationTtl: number }) => {});
  return { get, put, tracker: new VelocityTracker({ get, put } as VelocityKv, salt) };
}

describe('Group 20 velocity, observability and recovery integrity', () => {
  it.each([
    { deviceLimits: { ...limits, threshold: 0 } },
    { ipLimits: { ...limits, windowSeconds: Number.NaN } },
    { ipLimits: { ...limits, windowSeconds: 0 } },
    { deviceLimits: { ...limits, threshold: Infinity } },
    { eventType: 'feedback_submit:other' },
    { ip: '' },
    { ip: ' ' .repeat(2049) },
    { deviceSignal: '' },
  ])('DEV-104 rejects malformed counter configuration before touching KV %#', async (bad) => {
    const { tracker, get, put } = kvWith(null);
    await expect(tracker.checkVelocity({ ...input, ...bad })).rejects.toThrow('VELOCITY_STATE_UNAVAILABLE');
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it.each([
    'not-json', '{}', '[]', 'null', '0', 'true',
    '{"count":-1,"windowStart":100}',
    '{"count":0,"windowStart":100}',
    '{"count":1.5,"windowStart":100}',
    '{"count":1,"windowStart":-1}',
    '{"count":"2","windowStart":100}',
    '{"count":9007199254740991,"windowStart":100}',
    JSON.stringify({ count: 1, windowStart: Math.floor(Date.now() / 1000) + 86400 }),
  ])('DEV-105 refuses corrupted/replayed counter without overwriting it (%s)', async (raw) => {
    const { tracker, put } = kvWith(raw);
    await expect(tracker.checkVelocity(input)).rejects.toThrow('VELOCITY_STATE_UNAVAILABLE');
    expect(put).not.toHaveBeenCalled();
  });

  it('DEV-105 preserves the exact device and IP checks with healthy KV values', async () => {
    const store = new Map<string, string>();
    const kv: VelocityKv = {
      get: vi.fn(async key => store.get(key) ?? null),
      put: vi.fn(async (key, value) => { store.set(key, value); }),
    };
    const tracker = new VelocityTracker(kv, salt);
    expect(await tracker.checkVelocity(input)).toBeNull();
    expect(await tracker.checkVelocity(input)).toBeNull();
    expect(await tracker.checkVelocity(input)).toMatchObject({
      subjectType: 'device', count: 3, threshold: 2,
    });
    expect(store.size).toBe(2);
  });

  it.each([null, '', 'unexpected', '{}', '0'])('DEV-106 refuses invalid cooldown storage %#', async (raw) => {
    const { tracker, put } = kvWith(raw);
    if (raw === null) {
      expect((await tracker.checkAndStartCooldown({
        eventType: 'loyalty_checkin', subjectValue: 'customer-a:branch-a', windowSeconds: 14400,
      })).inCooldown).toBe(false);
      expect(put).toHaveBeenCalledOnce();
    } else {
      await expect(tracker.checkAndStartCooldown({
        eventType: 'loyalty_checkin', subjectValue: 'customer-a:branch-a', windowSeconds: 14400,
      })).rejects.toThrow('VELOCITY_STATE_UNAVAILABLE');
      expect(put).not.toHaveBeenCalled();
    }
  });

  it.each([0, -1, 1.5, Number.NaN, Infinity, 2_592_001])(
    'DEV-106 rejects malformed cooldown TTL before KV %#', async (windowSeconds) => {
      const { tracker, get, put } = kvWith(null);
      await expect(tracker.checkAndStartCooldown({
        eventType: 'loyalty_checkin', subjectValue: 'customer-a:branch-a', windowSeconds,
      })).rejects.toThrow('VELOCITY_STATE_UNAVAILABLE');
      expect(get).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
    },
  );

  it('DEV-106 maintains an existing cooldown without overwriting its TTL', async () => {
    const { tracker, put } = kvWith('1');
    const r = await tracker.checkAndStartCooldown({
      eventType: 'loyalty_checkin', subjectValue: 'customer-a:branch-a', windowSeconds: 14400,
    });
    expect(r.inCooldown).toBe(true);
    expect(put).not.toHaveBeenCalled();
  });

  it('never permits an empty salt to generate predictable counters', async () => {
    const { get, put } = kvWith(null);
    const tracker = new VelocityTracker({ get, put }, '');
    await expect(tracker.checkVelocity(input)).rejects.toThrow('VELOCITY_STATE_UNAVAILABLE');
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});
