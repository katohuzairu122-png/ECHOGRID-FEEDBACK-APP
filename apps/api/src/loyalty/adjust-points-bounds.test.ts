import { describe, it, expect } from 'vitest';
import { adjustPointsSchema, MAX_POINTS_ADJUSTMENT } from '@echo-grid-feedback/shared-types';

/**
 * Bounds on the manual points adjustment contract.
 *
 * Lives in apps/api rather than beside the schema because
 * packages/shared-types has no test runner (typecheck only), and apps/api is
 * the package that enforces this contract -- loyalty.routes.ts parses every
 * POST /loyalty/accounts/:id/adjust body through it.
 *
 * Every rejecting case below was ACCEPTED before the cap existed. The route
 * requires only `loyalty:manage`, which role-provisioning grants to Staff,
 * so the lowest-privilege staff role could mint an arbitrary redeemable
 * balance in one request.
 */
describe('adjustPointsSchema bounds', () => {
  const parse = (points: number) => adjustPointsSchema.safeParse({ points });

  it('accepts the ordinary corrections this route exists for', () => {
    // Scaled to the earning defaults: 10 per check-in, 50 referral,
    // 100 birthday (loyalty-settings schema).
    for (const points of [1, -1, 10, -10, 50, 100, -100, 2_500]) {
      expect(parse(points).success, `${points} should be accepted`).toBe(true);
    }
  });

  it('accepts the boundary in both directions', () => {
    expect(parse(MAX_POINTS_ADJUSTMENT).success).toBe(true);
    expect(parse(-MAX_POINTS_ADJUSTMENT).success).toBe(true);
  });

  it('rejects one past the boundary in both directions', () => {
    expect(parse(MAX_POINTS_ADJUSTMENT + 1).success).toBe(false);
    expect(parse(-MAX_POINTS_ADJUSTMENT - 1).success).toBe(false);
  });

  it('rejects the unbounded mint this cap exists to stop', () => {
    // All four were accepted before. The last two are additionally beyond
    // Postgres `integer`, which loyalty_accounts.points is -- so they used
    // to fail as an out-of-range database error the caller could not
    // interpret, rather than as a validation failure.
    for (const points of [1_000_000, -1_000_000, 2_147_483_647, Number.MAX_SAFE_INTEGER]) {
      expect(parse(points).success, `${points} should be rejected`).toBe(false);
    }
  });

  it('still rejects zero -- the pre-existing rule, unchanged by the cap', () => {
    expect(parse(0).success).toBe(false);
  });

  it('still rejects non-integers, so a fractional balance can never be written', () => {
    expect(parse(10.5).success).toBe(false);
    expect(parse(Number.NaN).success).toBe(false);
    expect(parse(Number.POSITIVE_INFINITY).success).toBe(false);
  });

  it('keeps notes optional and length-capped', () => {
    expect(adjustPointsSchema.safeParse({ points: 10 }).success).toBe(true);
    expect(adjustPointsSchema.safeParse({ points: 10, notes: 'goodwill' }).success).toBe(true);
    expect(adjustPointsSchema.safeParse({ points: 10, notes: 'x'.repeat(501) }).success).toBe(false);
  });

  it('exposes a cap far above any plausible correction and far below a meaningful distortion', () => {
    // Asserted so a future change to the constant is a deliberate decision
    // with a failing test in front of it, not a silent widening.
    expect(MAX_POINTS_ADJUSTMENT).toBe(100_000);
  });
});
