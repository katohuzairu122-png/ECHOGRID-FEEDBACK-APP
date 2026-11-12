import { describe, expect, it } from 'vitest';
import {
  HISTORICAL_STAFF_DEFAULT,
  LEGACY_STAFF_EXPOSURE,
  LOYALTY_ACCOUNTS_VIEW,
  LOYALTY_ADJUST,
  LOYALTY_SERVE,
  classifyRole,
  planAdditive,
  planReduce,
  type RoleSnapshot,
} from './loyalty-permissions';

const role = (name: string, keys: string[], isSystem = true, id = name): RoleSnapshot => ({
  roleId: id,
  businessId: 'b1',
  name,
  isSystem,
  keys: new Set(keys),
});
const OWNERISH = [
  'rewards:manage',
  'loyalty:view',
  'loyalty:manage',
  'team:view',
  'analytics:view',
  'feedback:view',
  'messages:view',
  'messages:send',
];
const apply = (r: RoleSnapshot, a: { grant: string[]; revoke: string[] }[]): RoleSnapshot => {
  const next = new Set(r.keys);
  for (const x of a) {
    x.grant.forEach((k) => next.add(k));
    x.revoke.forEach((k) => next.delete(k));
  }
  return { ...r, keys: next };
};

describe('classification (evidence-based, never by display name alone)', () => {
  it('an unmodified default Staff role (any subset of the historical default) is reducible', () => {
    expect(classifyRole(role('Staff', [...HISTORICAL_STAFF_DEFAULT]))).toBe('default_staff');
    expect(classifyRole(role('Staff', ['business:view', 'loyalty:manage']))).toBe('default_staff');
    expect(classifyRole(role('Staff', [...HISTORICAL_STAFF_DEFAULT, LOYALTY_SERVE]))).toBe(
      'default_staff',
    );
  });
  it('a Staff role with any extra grant, a renamed role or a non-system role is preserved', () => {
    expect(classifyRole(role('Staff', [...HISTORICAL_STAFF_DEFAULT, 'analytics:view']))).toBe(
      'preserved',
    );
    expect(classifyRole(role('Cashier', [...HISTORICAL_STAFF_DEFAULT]))).toBe('preserved');
    expect(classifyRole(role('Staff', [...HISTORICAL_STAFF_DEFAULT], false))).toBe('preserved');
  });
});

describe('phase A (additive)', () => {
  it('gives default Staff loyalty:serve only: never accounts:view or adjust', () => {
    const [a] = planAdditive([role('Staff', [...HISTORICAL_STAFF_DEFAULT])]);
    expect(a?.grant).toEqual([LOYALTY_SERVE]);
    expect(a?.revoke).toEqual([]);
  });
  it('gives Owner/Admin/Manager all three, preserving exactly who could adjust before', () => {
    const [a] = planAdditive([role('Manager', OWNERISH)]);
    expect(a?.grant).toEqual([LOYALTY_ACCOUNTS_VIEW, LOYALTY_ADJUST, LOYALTY_SERVE].sort());
  });
  it('a custom role with loyalty:manage but no rewards:manage keeps serve but never gains adjust', () => {
    const [a] = planAdditive([role('Shift lead', ['loyalty:manage', 'loyalty:view'], false)]);
    expect(a?.grant).toEqual([LOYALTY_ACCOUNTS_VIEW, LOYALTY_SERVE].sort());
  });
  it('a custom read-only role keeps account browsing through the new key and is reported as losing QR resolve', () => {
    const [a] = planAdditive([role('Analyst', ['loyalty:view'], false)]);
    expect(a?.grant).toEqual([LOYALTY_ACCOUNTS_VIEW]);
    expect(a?.needsOwnerDecision[0]).toMatch(/loses QR resolve/);
  });
  it('a role holding loyalty:manage is never reported as losing anything', () => {
    for (const a of planAdditive([
      role('Shift lead', ['loyalty:manage', 'loyalty:view'], false),
      role('Staff', [...HISTORICAL_STAFF_DEFAULT]),
    ])) {
      expect(a.needsOwnerDecision).toEqual([]);
    }
  });
  it('never removes anything and ignores roles with no loyalty authority', () => {
    expect(planAdditive([role('Support', ['feedback:view'], false)])).toEqual([]);
    for (const a of planAdditive([
      role('Staff', [...HISTORICAL_STAFF_DEFAULT]),
      role('Manager', OWNERISH),
    ]))
      expect(a.revoke).toEqual([]);
  });
  it('is idempotent: a second run plans nothing', () => {
    const roles = [
      role('Staff', [...HISTORICAL_STAFF_DEFAULT]),
      role('Manager', OWNERISH),
      role('Analyst', ['loyalty:view'], false),
    ];
    const once = roles.map((r) => apply(r, planAdditive([r])));
    expect(planAdditive(once).filter((a) => a.grant.length > 0 || a.revoke.length > 0)).toEqual([]);
  });
});

describe('phase B (reduce)', () => {
  it('removes exactly the five legacy keys from a default Staff role that already holds loyalty:serve', () => {
    const r = role('Staff', [...HISTORICAL_STAFF_DEFAULT, LOYALTY_SERVE]);
    const [a] = planReduce([r]);
    expect(a?.revoke).toEqual([...LEGACY_STAFF_EXPOSURE].sort());
    expect([...apply(r, [a!]).keys].sort()).toEqual([
      'branches:view',
      'business:view',
      LOYALTY_SERVE,
    ]);
  });
  it('does nothing to a default Staff role that has not received loyalty:serve (never strands a cashier)', () => {
    expect(planReduce([role('Staff', [...HISTORICAL_STAFF_DEFAULT])])).toEqual([]);
  });
  it('never reduces Owner, Admin, Manager or administrative custom roles', () => {
    expect(
      planReduce([
        role('Owner', [...OWNERISH, LOYALTY_SERVE]),
        role('Manager', [...OWNERISH, LOYALTY_SERVE]),
        role('Ops', [...OWNERISH], false),
      ]),
    ).toEqual([]);
  });
  it('reports, and never changes, a non-administrative custom role that still holds legacy exposure', () => {
    const [a] = planReduce([
      role('Front desk', ['loyalty:view', 'feedback:view', LOYALTY_SERVE], false),
    ]);
    expect(a?.revoke).toEqual([]);
    expect(a?.grant).toEqual([]);
    expect(a?.needsOwnerDecision.sort()).toEqual(['feedback:view', 'loyalty:view']);
  });
  it('reports a Staff role that was customised upward and leaves it alone', () => {
    const [a] = planReduce([
      role('Staff', [...HISTORICAL_STAFF_DEFAULT, LOYALTY_SERVE, 'notifications:view']),
    ]);
    expect(a?.revoke).toEqual([]);
    expect(a?.needsOwnerDecision.length).toBeGreaterThan(0);
  });
  it('is idempotent and reaches the exact least-privilege default', () => {
    const r = role('Staff', [...HISTORICAL_STAFF_DEFAULT]);
    const afterA = apply(r, planAdditive([r]));
    const afterB = apply(afterA, planReduce([afterA]));
    expect(planAdditive([afterB]).filter((a) => a.grant.length > 0 || a.revoke.length > 0)).toEqual(
      [],
    );
    expect(planReduce([afterB])).toEqual([]);
    expect([...afterB.keys].sort()).toEqual(['branches:view', 'business:view', LOYALTY_SERVE]);
  });
  it('phase order matters: reducing before the additive phase changes nothing', () => {
    expect(planReduce([role('Staff', [...HISTORICAL_STAFF_DEFAULT])])).toEqual([]);
  });
});
