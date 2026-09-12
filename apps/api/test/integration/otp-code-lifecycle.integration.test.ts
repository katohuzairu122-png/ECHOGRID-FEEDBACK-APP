import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { otpExpiresAt } from '../../src/customer-auth/otp';

/**
 * The otp_codes table against real Postgres, covering three things a
 * fake-repository unit test structurally cannot reach.
 *
 *  1. That the index exists. otp_codes had NO index at all, so both
 *     customer-login lookups were sequential scans on a table that grew one
 *     row per OTP request forever (audit P1-4). A fake has no indexes, so
 *     only the database can say whether the migration landed -- same
 *     reasoning as ai-usage-stale-pending's "proves migration 0018 is
 *     applied" assertion.
 *
 *  2. That markConsumed's guard is atomic. The guard is `WHERE id = $1 AND
 *     consumed_at IS NULL`, and what makes it safe is Postgres evaluating
 *     that against the committed row rather than a value read earlier. A
 *     fake re-encodes the intent in JavaScript and proves nothing about it.
 *
 *  3. That the prune actually deletes. This is the codebase's only hard
 *     DELETE, and every other suite here soft-deletes -- so this file is
 *     also the only place that verifies a real row removal behaves.
 *
 * Unlike the other suites here, this one creates no business or branch:
 * otp_codes has no tenant scoping and no foreign keys (a phone's first OTP
 * request happens before any customer row exists -- see the schema). Rows
 * are keyed on a unique per-run phone number instead, so a concurrent run
 * against the same database cannot interfere.
 */
describe.skipIf(!process.env.DATABASE_URL)('otp_codes lifecycle (integration)', () => {
  let client: Client;
  let repos: ReturnType<typeof createRepositories>;

  /** Unique per run: this suite owns every row for this number, so its
   * assertions never depend on what else is in the table. */
  const PHONE = `+1555${Date.now().toString().slice(-7)}`;
  const OTHER_PHONE = `${PHONE}9`;
  const DAY_MS = 24 * 60 * 60 * 1000;

  function newCode(overrides: { phone?: string; createdAt?: Date } = {}) {
    return repos.otpCodes.create({
      phone: overrides.phone ?? PHONE,
      codeHash: 'pbkdf2$10000$c2FsdA==$aGFzaA==',
      expiresAt: otpExpiresAt(),
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    });
  }

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    repos = createRepositories(buildDb(client));
  });

  afterAll(async () => {
    // A real DELETE, not a soft delete -- this table has no soft-delete
    // columns, which is the same reason deleteCreatedBefore exists at all.
    await client.query('DELETE FROM otp_codes WHERE phone LIKE $1', [`${PHONE}%`]);
    await client.end();
  });

  it('has the phone/created_at index -- proves the migration is applied', async () => {
    const result = await client.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'otp_codes' AND indexname = $1`,
      ['otp_codes_phone_created_idx'],
    );

    expect(result.rows).toHaveLength(1);
    const [row] = result.rows as Array<{ indexdef: string }>;
    // Column ORDER is what makes it usable for `WHERE phone = $1 ORDER BY
    // created_at`: phone must lead. An index on (created_at, phone) would
    // exist under the same name and serve neither login query.
    expect(row!.indexdef).toMatch(/\(phone, created_at\)/);
  });

  it('markConsumed succeeds once and reports false on every later attempt', async () => {
    const code = await newCode();

    await expect(repos.otpCodes.markConsumed(code.id)).resolves.toBe(true);
    await expect(repos.otpCodes.markConsumed(code.id)).resolves.toBe(false);
    await expect(repos.otpCodes.markConsumed(code.id)).resolves.toBe(false);
  });

  it('two concurrent consumes of one code produce exactly one winner', async () => {
    const code = await newCode();

    const results = await Promise.all([
      repos.otpCodes.markConsumed(code.id),
      repos.otpCodes.markConsumed(code.id),
    ]);

    // Exactly one, not "at least one": two winners is the bug -- one SMS
    // code issuing two customer sessions.
    expect(results.filter(Boolean)).toHaveLength(1);

    // Honest about what this proves. A single pg Client serialises its
    // queries, so these two statements do not overlap in wall-clock time.
    // What it verifies is the property that makes overlap safe: the guarded
    // UPDATE matches against the committed row, so the second statement
    // finds nothing to update no matter when it arrives. That is the whole
    // mechanism -- an unguarded `SET consumed_at = now() WHERE id = $1`
    // would return true both times here, and did before this change.
    const after = await client.query('SELECT consumed_at FROM otp_codes WHERE id = $1', [code.id]);
    expect((after.rows[0] as { consumed_at: Date | null }).consumed_at).not.toBeNull();
  });

  it('markConsumed reports false for an id that does not exist, rather than throwing', async () => {
    await expect(repos.otpCodes.markConsumed(crypto.randomUUID())).resolves.toBe(false);
  });

  it('a consumed code stops being findable as active', async () => {
    const code = await newCode();
    await repos.otpCodes.markConsumed(code.id);

    const active = await repos.otpCodes.findActiveForPhone(PHONE);
    expect(active?.id).not.toBe(code.id);
  });

  it('deleteCreatedBefore removes rows past the cutoff and keeps newer ones', async () => {
    const old = await newCode({ createdAt: new Date(Date.now() - 30 * DAY_MS) });
    const recent = await newCode({ createdAt: new Date(Date.now() - 1 * DAY_MS) });

    const deleted = await repos.otpCodes.deleteCreatedBefore(new Date(Date.now() - 7 * DAY_MS));
    expect(deleted).toBeGreaterThanOrEqual(1);

    const remaining = await client.query('SELECT id FROM otp_codes WHERE id = ANY($1)', [
      [old.id, recent.id],
    ]);
    const ids = (remaining.rows as Array<{ id: string }>).map((r) => r.id);
    expect(ids).not.toContain(old.id);
    expect(ids).toContain(recent.id);
  });

  it('deletes a CONSUMED row and an UNCONSUMED one alike once past the cutoff', async () => {
    // The predicate is created_at alone. Correct because a row older than
    // the retention window cannot still be verifiable (codes expire in 10
    // minutes), so there is no such thing as an old row worth keeping --
    // and a condition on one column is easier to be sure of than three.
    const consumed = await newCode({ createdAt: new Date(Date.now() - 30 * DAY_MS) });
    await repos.otpCodes.markConsumed(consumed.id);
    const unconsumed = await newCode({ createdAt: new Date(Date.now() - 30 * DAY_MS) });

    await repos.otpCodes.deleteCreatedBefore(new Date(Date.now() - 7 * DAY_MS));

    const remaining = await client.query('SELECT id FROM otp_codes WHERE id = ANY($1)', [
      [consumed.id, unconsumed.id],
    ]);
    expect(remaining.rows).toHaveLength(0);
  });

  it('returns 0 rather than throwing when there is nothing old enough to prune', async () => {
    await newCode();
    const deleted = await repos.otpCodes.deleteCreatedBefore(new Date('2000-01-01T00:00:00.000Z'));
    expect(deleted).toBe(0);
  });

  it('never deletes another phone\'s rows it was not asked about', async () => {
    // The prune is deliberately global -- it takes no phone -- so this
    // guards the one thing that could go wrong with that: the cutoff, not
    // the phone, must be what decides.
    const otherRecent = await newCode({ phone: OTHER_PHONE });

    await repos.otpCodes.deleteCreatedBefore(new Date(Date.now() - 7 * DAY_MS));

    const survived = await client.query('SELECT id FROM otp_codes WHERE id = $1', [otherRecent.id]);
    expect(survived.rows).toHaveLength(1);
  });
});
