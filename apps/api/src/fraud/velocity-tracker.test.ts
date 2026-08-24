import { describe, it, expect, afterEach, vi } from 'vitest';
import { VelocityTracker, type VelocityKv } from './velocity-tracker';

/** In-memory stand-in for the real CACHE binding -- simulates
 * expirationTtl (unlike a plain Map) since several tests below depend on
 * entries actually expiring under vi.setSystemTime(), the same fake-timer
 * pattern qr-code.service.test.ts uses to prove JWT exp is enforced, not
 * just present. */
function createFakeKv(): VelocityKv {
  const store = new Map<string, { value: string; expiresAt: number }>();
  return {
    async get(key: string) {
      const entry = store.get(key);
      if (!entry) return null;
      if (Date.now() / 1000 >= entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async put(key: string, value: string, options: { expirationTtl: number }) {
      store.set(key, { value, expiresAt: Date.now() / 1000 + options.expirationTtl });
    },
  };
}

const SALT = 'velocity-test-salt-do-not-use-in-production';

describe('VelocityTracker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('hashSubject', () => {
    it('is deterministic for the same value and salt', async () => {
      const tracker = new VelocityTracker(createFakeKv(), SALT);
      expect(await tracker.hashSubject('1.2.3.4')).toBe(await tracker.hashSubject('1.2.3.4'));
    });

    it('differs for different subject values -- not collapsing every IP to one bucket', async () => {
      const tracker = new VelocityTracker(createFakeKv(), SALT);
      expect(await tracker.hashSubject('1.2.3.4')).not.toBe(await tracker.hashSubject('5.6.7.8'));
    });

    it('differs across salts for the same value -- proves the salt actually participates, not just appended and ignored', async () => {
      const a = new VelocityTracker(createFakeKv(), 'salt-one');
      const b = new VelocityTracker(createFakeKv(), 'salt-two');
      expect(await a.hashSubject('1.2.3.4')).not.toBe(await b.hashSubject('1.2.3.4'));
    });
  });

  describe('checkVelocity', () => {
    const LIMITS = { windowSeconds: 600, threshold: 3 };

    it('returns null while both device and IP stay under threshold', async () => {
      const tracker = new VelocityTracker(createFakeKv(), SALT);
      for (let i = 0; i < 3; i++) {
        const breach = await tracker.checkVelocity({
          eventType: 'feedback_submit',
          ip: '1.2.3.4',
          deviceSignal: 'device-a',
          deviceLimits: LIMITS,
          ipLimits: LIMITS,
        });
        expect(breach).toBeNull();
      }
    });

    it('flags a device breach once its count exceeds threshold, before the IP threshold is anywhere close', async () => {
      const tracker = new VelocityTracker(createFakeKv(), SALT);
      let breach = null;
      for (let i = 0; i < 4; i++) {
        breach = await tracker.checkVelocity({
          eventType: 'feedback_submit',
          ip: '1.2.3.4',
          deviceSignal: 'device-a',
          deviceLimits: LIMITS,
          ipLimits: { windowSeconds: 600, threshold: 1000 },
        });
      }
      expect(breach).toMatchObject({ subjectType: 'device', count: 4, threshold: 3 });
    });

    it('flags an IP breach when many different devices share one IP -- and still increments every distinct device counter independently', async () => {
      const tracker = new VelocityTracker(createFakeKv(), SALT);
      let breach = null;
      for (let i = 0; i < 4; i++) {
        breach = await tracker.checkVelocity({
          eventType: 'feedback_submit',
          ip: '1.2.3.4',
          deviceSignal: `device-${i}`, // a different device every time
          deviceLimits: LIMITS,
          ipLimits: LIMITS,
        });
      }
      expect(breach).toMatchObject({ subjectType: 'ip', count: 4, threshold: 3 });
    });

    it('checks IP velocity even with no deviceSignal supplied -- an older client that never sends one still gets IP-level protection', async () => {
      const tracker = new VelocityTracker(createFakeKv(), SALT);
      let breach = null;
      for (let i = 0; i < 4; i++) {
        breach = await tracker.checkVelocity({
          eventType: 'feedback_submit',
          ip: '1.2.3.4',
          deviceLimits: LIMITS,
          ipLimits: LIMITS,
        });
      }
      expect(breach).toMatchObject({ subjectType: 'ip' });
    });

    it('keeps different event types in separate counters -- hammering feedback_submit must not trip loyalty_checkin\'s counter', async () => {
      const tracker = new VelocityTracker(createFakeKv(), SALT);
      for (let i = 0; i < 4; i++) {
        await tracker.checkVelocity({
          eventType: 'feedback_submit',
          ip: '1.2.3.4',
          deviceSignal: 'device-a',
          deviceLimits: LIMITS,
          ipLimits: LIMITS,
        });
      }
      const checkinBreach = await tracker.checkVelocity({
        eventType: 'loyalty_checkin',
        ip: '1.2.3.4',
        deviceSignal: 'device-a',
        deviceLimits: LIMITS,
        ipLimits: LIMITS,
      });
      expect(checkinBreach).toBeNull();
    });

    it('resets the window once windowSeconds has elapsed -- a breach does not follow a device forever', async () => {
      vi.useFakeTimers();
      const tracker = new VelocityTracker(createFakeKv(), SALT);
      for (let i = 0; i < 4; i++) {
        await tracker.checkVelocity({
          eventType: 'feedback_submit',
          ip: '1.2.3.4',
          deviceSignal: 'device-a',
          deviceLimits: LIMITS,
          ipLimits: LIMITS,
        });
      }

      vi.setSystemTime(Date.now() + 601_000); // just past the 600s window
      const breach = await tracker.checkVelocity({
        eventType: 'feedback_submit',
        ip: '1.2.3.4',
        deviceSignal: 'device-a',
        deviceLimits: LIMITS,
        ipLimits: LIMITS,
      });
      expect(breach).toBeNull();
    });
  });

  describe('checkAndStartCooldown', () => {
    it('reports not-in-cooldown on the first call and starts the clock', async () => {
      const tracker = new VelocityTracker(createFakeKv(), SALT);
      const result = await tracker.checkAndStartCooldown({
        eventType: 'loyalty_checkin',
        subjectValue: 'customer-1:business-a',
        windowSeconds: 3600,
      });
      expect(result.inCooldown).toBe(false);
    });

    it('reports in-cooldown on a second call within the window', async () => {
      const tracker = new VelocityTracker(createFakeKv(), SALT);
      const subject = { eventType: 'loyalty_checkin', subjectValue: 'customer-1:business-a', windowSeconds: 3600 };
      await tracker.checkAndStartCooldown(subject);
      const second = await tracker.checkAndStartCooldown(subject);
      expect(second.inCooldown).toBe(true);
    });

    it('clears once windowSeconds has elapsed', async () => {
      vi.useFakeTimers();
      const tracker = new VelocityTracker(createFakeKv(), SALT);
      const subject = { eventType: 'loyalty_checkin', subjectValue: 'customer-1:business-a', windowSeconds: 3600 };
      await tracker.checkAndStartCooldown(subject);

      vi.setSystemTime(Date.now() + 3_601_000);
      const result = await tracker.checkAndStartCooldown(subject);
      expect(result.inCooldown).toBe(false);
    });

    it('does not extend an already-active cooldown -- a repeat attempt mid-window does not push the expiry further out', async () => {
      vi.useFakeTimers();
      const tracker = new VelocityTracker(createFakeKv(), SALT);
      const subject = { eventType: 'loyalty_checkin', subjectValue: 'customer-1:business-a', windowSeconds: 3600 };
      await tracker.checkAndStartCooldown(subject); // starts the clock at t=0

      vi.setSystemTime(Date.now() + 3_000_000); // t=3000s, still within the original window
      const midWindow = await tracker.checkAndStartCooldown(subject);
      expect(midWindow.inCooldown).toBe(true); // confirms this call did NOT reset the clock

      vi.setSystemTime(Date.now() + 700_000); // now past the ORIGINAL 3600s mark (3000+700=3700)
      const afterOriginalWindow = await tracker.checkAndStartCooldown(subject);
      expect(afterOriginalWindow.inCooldown).toBe(false);
    });

    it('keeps different customers, and different subjects generally, in separate cooldowns', async () => {
      const tracker = new VelocityTracker(createFakeKv(), SALT);
      await tracker.checkAndStartCooldown({
        eventType: 'loyalty_checkin',
        subjectValue: 'customer-1:business-a',
        windowSeconds: 3600,
      });
      const otherCustomer = await tracker.checkAndStartCooldown({
        eventType: 'loyalty_checkin',
        subjectValue: 'customer-2:business-a',
        windowSeconds: 3600,
      });
      expect(otherCustomer.inCooldown).toBe(false);
    });
  });
});
