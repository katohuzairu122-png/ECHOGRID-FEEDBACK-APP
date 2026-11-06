import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { activatePolicy, evaluateActivationPreconditions, isOwnerActivationAuthority } from './policy-activation';
import type { PolicyChange, PolicyStatus } from './policy-administration';

/** S08-D1D3-DEV-13: the sealed activation contract has no activation path. These tests pin both halves: what a future owner authority would have to satisfy, and that nothing today can act. */
const NOW = 1_800_000_000_000;
const change = (over: Partial<PolicyChange> = {}): PolicyChange => ({ changeId: 'c', seq: 1, expectedPolicyVersion: 1, targetState: true, storedState: 'APPROVED', state: 'APPROVED', version: 2, justification: 'j', proposedBy: 'a1', decidedBy: 'a2', decisionRef: 'REF-1', expiresAtMs: NOW + 1000, decidedAtMs: NOW - 1, ...over });
const policy = (over: Partial<PolicyStatus> = {}): PolicyStatus => ({ approvalEnabled: false, version: 1, state: 'DISABLED', ...over });

describe('activation preconditions (pure; they write nothing)', () => {
  it('an approved, unexpired, current-version, distinct-administrator request to enable a disabled policy satisfies the preconditions', () => {
    expect(evaluateActivationPreconditions(change(), policy(), NOW)).toEqual({ ok: true });
  });
  it('every other situation is refused with its reason: unapproved, expired, stale, wrong target, already enabled, same administrator, missing decision, unreadable policy', () => {
    const reasons = (c: PolicyChange | null, p: PolicyStatus | null, now = NOW) => { const r = evaluateActivationPreconditions(c, p, now); return r.ok ? [] : [...r.reasons]; };
    expect(reasons(change({ storedState: 'PENDING' }), policy())).toEqual(['CHANGE_NOT_APPROVED']);
    for (const s of ['REJECTED', 'CANCELLED', 'EXPIRED'] as const) expect(reasons(change({ storedState: s }), policy()), s).toContain('CHANGE_NOT_APPROVED');
    expect(reasons(change(), policy(), NOW + 1000)).toEqual(['CHANGE_EXPIRED']);
    expect(reasons(change(), policy({ version: 2 }))).toEqual(['VERSION_STALE']);
    expect(reasons(change({ targetState: false }), policy())).toEqual(['TARGET_NOT_ENABLE']);
    expect(reasons(change(), policy({ approvalEnabled: true, state: 'ENABLED' }))).toEqual(['ALREADY_ENABLED']);
    expect(reasons(change({ decidedBy: 'a1' }), policy())).toEqual(['SAME_ADMINISTRATOR']);
    expect(reasons(change({ decidedBy: null, decisionRef: null }), policy())).toEqual(['DECISION_MISSING']);
    expect(reasons(change(), policy({ state: 'UNKNOWN', version: null }))).toEqual(['POLICY_UNREADABLE']);
    expect(reasons(change(), null)).toEqual(['POLICY_UNREADABLE']);
    expect(reasons(null, policy())).toEqual(['CHANGE_NOT_APPROVED']);
    expect(reasons(undefined as never, policy())).toEqual(['CHANGE_NOT_APPROVED']);
    expect(reasons(change(), policy(), NaN)).toContain('CHANGE_EXPIRED');
  });
});

describe('activation itself does not exist', () => {
  it('activatePolicy refuses every caller: no designated owner authority exists, and no object, clone, id or flag becomes one', async () => {
    for (const authority of [undefined, null, {}, { owner: true }, 'owner', 1, { __proto__: null }, Object.freeze({}), structuredClone({ designated: true }), new (class { readonly designated = true })()]) {
      expect(await activatePolicy(authority, change(), NOW), String(JSON.stringify(authority))).toEqual({ ok: false, reason: 'AUTHORITY_NOT_DESIGNATED' });
      expect(isOwnerActivationAuthority(authority)).toBe(false);
    }
  });
  it('no environment variable, approved request or process setting changes that: the module reads none and writes no policy statement', () => {
    process.env.APPROVAL_ENABLED = 'true'; process.env.STRIPE_READ_APPROVAL_ENABLED = 'true'; process.env.OWNER_ACTIVATION = 'true';
    try { return activatePolicy({}, change(), NOW).then(r => expect(r.reason).toBe('AUTHORITY_NOT_DESIGNATED')); } finally { delete process.env.APPROVAL_ENABLED; delete process.env.STRIPE_READ_APPROVAL_ENABLED; delete process.env.OWNER_ACTIVATION; }
  });
  it('static: no module in the Stripe-read tree writes approval_enabled, and none constructs an owner activation authority', () => {
    const dir = resolve(__dirname);
    for (const f of readdirSync(dir).filter(x => x.endsWith('.ts') && !x.endsWith('.test.ts') && x !== 'pipeline-fixtures.ts')) {
      const text = readFileSync(resolve(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(/set\s+approval_enabled|update\s+(public\.)?stripe_read_authorization_policy|insert\s+into\s+(public\.)?stripe_read_authorization_policy/i.test(text), `${f} writes the policy`).toBe(false);
      expect(/process\.env|import\.meta\.env/.test(text), `${f} reads the environment`).toBe(false);
    }
    const act = readFileSync(resolve(dir, 'policy-activation.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(/designated\.add\(/.test(act)).toBe(false); // the registry of valid authorities is never populated
    expect(/from 'drizzle-orm'|execute\(|transaction\(/.test(act)).toBe(false);
  });
});
