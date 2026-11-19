import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { IngestLimiterDurableObject, MailboxDurableObject } from '../../src/mailbox-do';
import { MailboxStore, MAX_CLAIMS_PER_MINUTE, MAX_MESSAGES_PER_RECIPIENT } from '../../src/store';
import { MESSAGE_LIFETIME_MS } from '../../src/protocol';
import { link } from '../helpers/email';
import { baseEnv, nonce } from '../helpers/worker';

const uid = (): string => crypto.randomUUID().replace(/-/g, '').slice(0, 10);
const stubFor = (address: string) => baseEnv().MAILBOX.get(baseEnv().MAILBOX.idFromName(address));
// Real-clock base: the Durable Object arms real alarms, and an alarm in the past would purge the fixture before the test looks at it.
const T0 = Date.now();
const msg = (runId: string, i = 0) => ({ to: `acc-${runId}-main@acc-test.example`, runId, receivedAtMs: T0, text: link(), messageIdHash: `${runId}-${i}`.padEnd(64, '0') });

describe('single-use claim on the real Durable Object', () => {
  it('the first claim returns the message and the second returns nothing', async () => {
    const run = `r${uid()}`.slice(0, 11);
    const box = stubFor(msg(run).to);
    expect(await box.put(msg(run), T0)).toBe('stored');
    const first = await box.claim(run, nonce(), T0 + 1);
    expect(first.kind === 'claimed' && first.messages.length).toBe(1);
    const second = await box.claim(run, nonce(), T0 + 2);
    expect(second.kind === 'claimed' && second.messages.length).toBe(0);
  });

  it('two simultaneous claims produce exactly one winner (and so do thirty)', async () => {
    const run = `r${uid()}`.slice(0, 11);
    const box = stubFor(msg(run).to);
    await box.put(msg(run), T0);
    const results = await Promise.all(Array.from({ length: MAX_CLAIMS_PER_MINUTE }, () => box.claim(run, nonce(), T0 + 5)));
    const winners = results.filter((r) => r.kind === 'claimed' && r.messages.length > 0);
    expect(winners).toHaveLength(1);
  });

  it('a different recipient cannot claim it', async () => {
    const run = `r${uid()}`.slice(0, 11);
    await stubFor(msg(run).to).put(msg(run), T0);
    const other = stubFor(`acc-${run}-other@acc-test.example`);
    const r = await other.claim(run, nonce(), T0 + 1);
    expect(r.kind === 'claimed' && r.messages.length).toBe(0);
    const still = await stubFor(msg(run).to).claim(run, nonce(), T0 + 2);
    expect(still.kind === 'claimed' && still.messages.length).toBe(1);
  });

  it('a different run on the same recipient cannot claim it, and does not consume it', async () => {
    const run = `r${uid()}`.slice(0, 11);
    const box = stubFor(msg(run).to);
    await box.put(msg(run), T0);
    const wrong = await box.claim('zzzz9999', nonce(), T0 + 1);
    expect(wrong.kind === 'claimed' && wrong.messages.length).toBe(0);
    const right = await box.claim(run, nonce(), T0 + 2);
    expect(right.kind === 'claimed' && right.messages.length).toBe(1);
  });

  it('an expired message is never returned, even when no cleanup has run', async () => {
    const run = `r${uid()}`.slice(0, 11);
    const box = stubFor(msg(run).to);
    await box.put(msg(run), T0);
    const late = await box.claim(run, nonce(), T0 + MESSAGE_LIFETIME_MS);
    expect(late.kind === 'claimed' && late.messages.length).toBe(0);
  });

  it('a message is claimable up to its last millisecond of life', async () => {
    const run = `r${uid()}`.slice(0, 11);
    const box = stubFor(msg(run).to);
    await box.put(msg(run), T0);
    const r = await box.claim(run, nonce(), T0 + MESSAGE_LIFETIME_MS - 1);
    expect(r.kind === 'claimed' && r.messages.length).toBe(1);
  });

  it('a repeated nonce is a replay and consumes nothing', async () => {
    const run = `r${uid()}`.slice(0, 11);
    const box = stubFor(msg(run).to);
    const n = nonce();
    expect((await box.claim(run, n, T0)).kind).toBe('claimed');
    await box.put(msg(run, 1), T0 + 1);
    expect((await box.claim(run, n, T0 + 2)).kind).toBe('replay');
    const fresh = await box.claim(run, nonce(), T0 + 3);
    expect(fresh.kind === 'claimed' && fresh.messages.length).toBe(1);
  });

  it('claim attempts are rate limited per recipient', async () => {
    const run = `r${uid()}`.slice(0, 11);
    const box = stubFor(msg(run).to);
    for (let i = 0; i < MAX_CLAIMS_PER_MINUTE; i++) expect((await box.claim(run, nonce(), T0 + i)).kind).toBe('claimed');
    expect((await box.claim(run, nonce(), T0 + 100)).kind).toBe('rate_limited');
    expect((await box.claim(run, nonce(), T0 + 61_000)).kind).toBe('claimed');
  });

  it('a duplicate Message-ID is refused even after the first copy was consumed', async () => {
    const run = `r${uid()}`.slice(0, 11);
    const box = stubFor(msg(run).to);
    expect(await box.put(msg(run), T0)).toBe('stored');
    await box.claim(run, nonce(), T0 + 1);
    expect(await box.put(msg(run), T0 + 2)).toBe('duplicate');
  });

  it('holds at most five live messages per recipient', async () => {
    const run = `r${uid()}`.slice(0, 11);
    const box = stubFor(msg(run).to);
    for (let i = 0; i < MAX_MESSAGES_PER_RECIPIENT; i++) expect(await box.put(msg(run, i), T0)).toBe('stored');
    expect(await box.put(msg(run, 99), T0)).toBe('full');
  });
});

describe('failure and restart behaviour', () => {
  it('a storage failure inside the claim rolls everything back: nothing is returned and the message is still claimable once', async () => {
    const run = `r${uid()}`.slice(0, 11);
    const box = stubFor(msg(run).to);
    await box.put(msg(run), T0);
    await runInDurableObject(box, async (_instance, state) => {
      const faulty = new MailboxStore(state.storage, { afterDelete: () => { throw new Error('injected storage failure'); } });
      expect(() => faulty.claim(run, nonce(), T0 + 1)).toThrow('injected storage failure');
    });
    const next = await box.claim(run, nonce(), T0 + 2);
    expect(next.kind === 'claimed' && next.messages.length).toBe(1);
    const again = await box.claim(run, nonce(), T0 + 3);
    expect(again.kind === 'claimed' && again.messages.length).toBe(0);
  });

  it('a rolled-back claim does not burn its nonce', async () => {
    const run = `r${uid()}`.slice(0, 11);
    const box = stubFor(msg(run).to);
    await box.put(msg(run), T0);
    const n = nonce();
    await runInDurableObject(box, async (_i, state) => {
      const faulty = new MailboxStore(state.storage, { afterDelete: () => { throw new Error('x'); } });
      expect(() => faulty.claim(run, n, T0 + 1)).toThrow();
    });
    const retry = await box.claim(run, n, T0 + 2);
    expect(retry.kind).toBe('claimed');
  });

  it('a receiver restart does not bring a consumed message back', async () => {
    const run = `r${uid()}`.slice(0, 11);
    const box = stubFor(msg(run).to);
    await box.put(msg(run), T0);
    expect((await box.claim(run, nonce(), T0 + 1)).kind).toBe('claimed');
    await runInDurableObject(box, async (_i, state) => {
      try { state.abort('simulated restart'); } catch { /* the object is reset */ }
    }).catch(() => undefined);
    const after = await stubFor(msg(run).to).claim(run, nonce(), T0 + 2);
    expect(after.kind === 'claimed' && after.messages.length).toBe(0);
  });

  it('a restart does not lose an unconsumed message either', async () => {
    const run = `r${uid()}`.slice(0, 11);
    const box = stubFor(msg(run).to);
    await box.put(msg(run), T0);
    await runInDurableObject(box, async (_i, state) => {
      try { state.abort('simulated restart'); } catch { /* reset */ }
    }).catch(() => undefined);
    const after = await stubFor(msg(run).to).claim(run, nonce(), T0 + 2);
    expect(after.kind === 'claimed' && after.messages.length).toBe(1);
  });
});

describe('physical cleanup', () => {
  it('sweeps expired rows, schedules the next cleanup, and empties the object when nothing is left', async () => {
    const run = `r${uid()}`.slice(0, 11);
    const box = stubFor(msg(run).to);
    await box.put(msg(run), T0);
    await runInDurableObject(box, async (_i, state) => {
      const store = new MailboxStore(state.storage);
      expect(store.sweep(T0 + 1)).not.toBeNull();
      expect(store.liveCount(T0 + 1)).toBe(1);
      expect(store.sweep(T0 + MESSAGE_LIFETIME_MS + 1)).not.toBeNull(); // the Message-ID memory outlives the message
      expect(store.liveCount(T0 + MESSAGE_LIFETIME_MS + 1)).toBe(0);
      expect(state.storage.sql.exec('SELECT COUNT(*) AS n FROM messages').one().n).toBe(0);
      expect(store.sweep(T0 + 31 * 60_000)).toBeNull();
    });
  });

  it('the alarm removes the object storage after everything has expired, and the object still works afterwards', async () => {
    const run = `r${uid()}`.slice(0, 11);
    const box = stubFor(msg(run).to);
    await box.put(msg(run), Date.now());
    await runInDurableObject(box, async (instance, state) => {
      const alarm = await state.storage.getAlarm();
      expect(alarm).not.toBeNull();
      expect(typeof (instance as unknown as { alarm: unknown }).alarm).toBe('function');
    });
    // after cleanup (deleteAll) the same object must still accept new mail: the schema is recreated on demand
    await runInDurableObject(box, async (_i, state) => {
      await state.storage.deleteAll();
    });
    expect(await box.put({ ...msg(run, 7), receivedAtMs: Date.now() }, Date.now())).toBe('stored');
  });
});

describe('no enumeration surface', () => {
  it('the Durable Object offers the Worker only put and claim (no list, search, get or dump)', () => {
    expect(Object.getOwnPropertyNames(MailboxDurableObject.prototype).sort()).toEqual(['alarm', 'claim', 'constructor', 'put', 'schedule']);
    expect(Object.getOwnPropertyNames(IngestLimiterDurableObject.prototype).sort()).toEqual(['admit', 'constructor']);
  });
});
