import { beforeEach, describe, expect, it } from 'vitest';
import { sign } from 'hono/jwt';
import { AuthError, AuthService } from './auth.service';
import { CashierAuthService } from './cashier-auth.service';
import { verifyAccessToken, verifyCashierAccessToken, signAccessToken } from './jwt';
import { createDirectPbkdf2Worker } from './pbkdf2-worker';
import { hashToken } from './token-hash';
import { DEFAULT_ROLES } from '../rbac/role-provisioning.service';

/**
 * CASHIER-PWA-01 C3. In-memory repositories, real token signing and verification, the real AuthService for the web
 * side. Covers sign-in and selection, owner and manager eligibility through their default roles, rotation, replay
 * handling, revocation and isolation between cashier and web sessions.
 */
const SECRETS = {
  JWT_ACCESS_SECRET: 'c3-access-secret-for-tests',
  JWT_REFRESH_SECRET: 'c3-refresh-secret-for-tests',
};
const hasher = createDirectPbkdf2Worker();

const BIZ_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BIZ_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BR_A1 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const BR_A2 = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2';
const BR_B1 = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';

type Row = {
  id: string;
  userId: string;
  tokenHash: string;
  sessionId: string | null;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedByTokenId: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  client: string;
  businessId: string | null;
  branchId: string | null;
  deviceLabel: string | null;
};

function world() {
  const users = new Map<
    string,
    { id: string; email: string; passwordHash: string; status: string; fullName: string }
  >();
  const tokens = new Map<string, Row>();
  const grants: {
    userId: string;
    businessId: string;
    branchId: string | null;
    role: keyof typeof DEFAULT_ROLES;
  }[] = [];
  const businesses = new Map<string, { id: string; name: string; status: string }>([
    [BIZ_A, { id: BIZ_A, name: 'Cafe A', status: 'active' }],
    [BIZ_B, { id: BIZ_B, name: 'Shop B', status: 'active' }],
  ]);
  const branches = new Map<string, { id: string; businessId: string; name: string }>([
    [BR_A1, { id: BR_A1, businessId: BIZ_A, name: 'A one' }],
    [BR_A2, { id: BR_A2, businessId: BIZ_A, name: 'A two' }],
    [BR_B1, { id: BR_B1, businessId: BIZ_B, name: 'B one' }],
  ]);
  const roleOverrides = new Map<string, Set<string>>(); // `${role}` -> custom permissions

  const repos = {
    users: {
      findByEmail: async (email: string) => [...users.values()].find((u) => u.email === email),
      findById: async (id: string) => users.get(id),
      touchLastLogin: async () => undefined,
    },
    refreshTokens: {
      create: async (
        input: Partial<Row> & { id: string; userId: string; tokenHash: string; expiresAt: Date },
      ) => {
        const row: Row = {
          id: input.id,
          userId: input.userId,
          tokenHash: input.tokenHash,
          sessionId: input.sessionId ?? null,
          issuedAt: new Date(),
          expiresAt: input.expiresAt,
          revokedAt: null,
          replacedByTokenId: null,
          userAgent: input.userAgent ?? null,
          ipAddress: input.ipAddress ?? null,
          client: input.client ?? 'web',
          businessId: input.businessId ?? null,
          branchId: input.branchId ?? null,
          deviceLabel: input.deviceLabel ?? null,
        };
        tokens.set(row.id, row);
        return row;
      },
      findById: async (id: string) => tokens.get(id),
      rotate: async (id: string, next: string) => {
        const row = tokens.get(id);
        if (!row || row.revokedAt) return false;
        row.revokedAt = new Date();
        row.replacedByTokenId = next;
        return true;
      },
      revoke: async (id: string) => {
        const r = tokens.get(id);
        if (r && !r.revokedAt) r.revokedAt = new Date();
      },
      revokeSession: async (userId: string, sid: string) => {
        let n = 0;
        for (const r of tokens.values())
          if (r.userId === userId && r.sessionId === sid && !r.revokedAt) {
            r.revokedAt = new Date();
            n++;
          }
        return n;
      },
      revokeAllForUser: async (userId: string) => {
        let n = 0;
        for (const r of tokens.values())
          if (r.userId === userId && !r.revokedAt) {
            r.revokedAt = new Date();
            n++;
          }
        return n;
      },
    },
    userBusinessRoles: {
      listForUser: async (userId: string) => grants.filter((g) => g.userId === userId),
      listForUserAtBusiness: async (userId: string, businessId: string) =>
        grants.filter((g) => g.userId === userId && g.businessId === businessId),
    },
    permissions: {
      findEffectiveKeys: async (userId: string, businessId: string, branchId?: string) => {
        const keys = new Set<string>();
        for (const g of grants) {
          if (g.userId !== userId || g.businessId !== businessId) continue;
          if (g.branchId !== null && g.branchId !== branchId) continue;
          for (const k of roleOverrides.get(g.role) ?? DEFAULT_ROLES[g.role]) keys.add(k);
        }
        return keys;
      },
    },
    businesses: { findById: async (id: string) => businesses.get(id) },
    branches: {
      findById: async (id: string, businessId: string) => {
        const b = branches.get(id);
        return b && b.businessId === businessId ? b : undefined;
      },
      listByBusiness: async (businessId: string) =>
        [...branches.values()].filter((b) => b.businessId === businessId),
    },
  };

  const addUser = async (name: string, password = 'correct-horse-battery', status = 'active') => {
    const id = crypto.randomUUID();
    users.set(id, {
      id,
      email: `${name}@example.test`,
      passwordHash: await hasher.hash(password, 1000),
      status,
      fullName: name,
    });
    return { id, email: `${name}@example.test`, password };
  };
  return { repos, users, tokens, grants, businesses, branches, roleOverrides, addUser };
}

const cashierService = (w: ReturnType<typeof world>) =>
  new CashierAuthService(w.repos as never, SECRETS, hasher);
const webService = (w: ReturnType<typeof world>) =>
  new AuthService(w.repos as never, SECRETS, hasher);

let w: ReturnType<typeof world>;
beforeEach(() => {
  w = world();
});

describe('eligibility through existing roles (no special case)', () => {
  it('the default Owner, Admin, Manager and Staff roles all hold the cashier permission', () => {
    for (const role of ['Owner', 'Manager', 'Staff'] as const)
      expect(DEFAULT_ROLES[role]).toContain('loyalty:serve');
  });

  it.each(['Owner', 'Manager', 'Staff'] as const)(
    'a %s with a business-wide grant is eligible',
    async (role) => {
      const u = await w.addUser(role.toLowerCase());
      w.grants.push({ userId: u.id, businessId: BIZ_A, branchId: null, role });
      const choices = await cashierService(w).eligibleChoices(u.id);
      expect(choices).toHaveLength(1);
      expect(choices[0]).toMatchObject({ businessId: BIZ_A, wideAccess: true });
      expect(choices[0]?.branches.map((b) => b.id).sort()).toEqual([BR_A1, BR_A2].sort());
    },
  );

  it('a user whose role lacks the permission, a suspended business, or no grant gets no choice', async () => {
    const u = await w.addUser('plain');
    w.grants.push({ userId: u.id, businessId: BIZ_A, branchId: null, role: 'Manager' });
    w.roleOverrides.set('Manager', new Set(['business:view']));
    expect(await cashierService(w).eligibleChoices(u.id)).toEqual([]);
    w.roleOverrides.clear();
    w.businesses.get(BIZ_A)!.status = 'suspended';
    expect(await cashierService(w).eligibleChoices(u.id)).toEqual([]);
    const nobody = await w.addUser('nobody');
    expect(await cashierService(w).eligibleChoices(nobody.id)).toEqual([]);
  });

  it('branch-scoped staff are limited to their own branch', async () => {
    const u = await w.addUser('counter');
    w.grants.push({ userId: u.id, businessId: BIZ_A, branchId: BR_A1, role: 'Staff' });
    const [c] = await cashierService(w).eligibleChoices(u.id);
    expect(c).toMatchObject({ wideAccess: false });
    expect(c?.branches.map((b) => b.id)).toEqual([BR_A1]);
  });
});

describe('sign-in', () => {
  it('signs a single-branch cashier straight in with a cashier-scoped access token and a cashier refresh row', async () => {
    const u = await w.addUser('counter');
    w.grants.push({ userId: u.id, businessId: BIZ_A, branchId: BR_A1, role: 'Staff' });
    const r = await cashierService(w).login({
      email: u.email,
      password: u.password,
      deviceLabel: 'Counter 1',
      userAgent: 'UA',
      ipAddress: '1.2.3.4',
    });
    expect(r.status).toBe('authenticated');
    if (r.status !== 'authenticated') throw new Error('unreachable');
    const claims = await verifyCashierAccessToken(r.accessToken, SECRETS.JWT_ACCESS_SECRET);
    expect(claims).toMatchObject({ sub: u.id, client: 'cashier', bid: BIZ_A, brid: BR_A1 });
    expect(claims.sid).toBeTruthy();
    const row = [...w.tokens.values()][0]!;
    expect(row).toMatchObject({
      client: 'cashier',
      businessId: BIZ_A,
      branchId: BR_A1,
      deviceLabel: 'Counter 1',
      sessionId: claims.sid,
      userAgent: 'UA',
    });
    expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(12 * 3600 * 1000 + 5000);
  });

  it('asks a business-wide user with branches to choose, and a ticket finishes the selection', async () => {
    const u = await w.addUser('owner');
    w.grants.push({ userId: u.id, businessId: BIZ_A, branchId: null, role: 'Owner' });
    const first = await cashierService(w).login({ email: u.email, password: u.password });
    expect(first.status).toBe('selection_required');
    expect(w.tokens.size).toBe(0);
    if (first.status !== 'selection_required') throw new Error('unreachable');
    const done = await cashierService(w).createSession({
      ticket: first.ticket,
      businessId: BIZ_A,
      branchId: BR_A2,
    });
    expect(done.session).toMatchObject({ businessId: BIZ_A, branchId: BR_A2 });
    // A business-wide owner may also choose no branch.
    const nobranch = await cashierService(w).createSession({
      ticket: first.ticket,
      businessId: BIZ_A,
    });
    expect(nobranch.session.branchId).toBeNull();
  });

  it('refuses a selection for a business or branch the user cannot serve, and a branch-scoped user choosing no branch', async () => {
    const u = await w.addUser('multi');
    w.grants.push(
      { userId: u.id, businessId: BIZ_A, branchId: BR_A1, role: 'Staff' },
      { userId: u.id, businessId: BIZ_A, branchId: BR_A2, role: 'Staff' },
    );
    const first = await cashierService(w).login({ email: u.email, password: u.password });
    if (first.status !== 'selection_required') throw new Error('expected selection');
    await expect(
      cashierService(w).createSession({ ticket: first.ticket, businessId: BIZ_B }),
    ).rejects.toMatchObject({ code: 'CASHIER_ACCESS_DENIED' });
    await expect(
      cashierService(w).createSession({ ticket: first.ticket, businessId: BIZ_A, branchId: BR_B1 }),
    ).rejects.toMatchObject({ code: 'CASHIER_ACCESS_DENIED' });
    await expect(
      cashierService(w).createSession({ ticket: first.ticket, businessId: BIZ_A }),
    ).rejects.toMatchObject({ code: 'CASHIER_SELECTION_INVALID' });
    expect(w.tokens.size).toBe(0);
  });

  it('uses the web error for a wrong password or unknown email, refuses inactive users and users with nothing to serve', async () => {
    const u = await w.addUser('counter');
    w.grants.push({ userId: u.id, businessId: BIZ_A, branchId: BR_A1, role: 'Staff' });
    await expect(
      cashierService(w).login({ email: u.email, password: 'wrong' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await expect(
      cashierService(w).login({ email: 'ghost@example.test', password: 'x' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    const off = await w.addUser('off', 'pw-pw-pw-pw', 'suspended');
    await expect(
      cashierService(w).login({ email: off.email, password: off.password }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_INACTIVE' });
    const none = await w.addUser('none');
    await expect(
      cashierService(w).login({ email: none.email, password: none.password }),
    ).rejects.toMatchObject({ code: 'CASHIER_ACCESS_DENIED' });
    expect(w.tokens.size).toBe(0);
  });

  it('refuses forged, expired, wrong-type or wrong-secret selection tickets (an access token is not a ticket)', async () => {
    const u = await w.addUser('owner');
    w.grants.push({ userId: u.id, businessId: BIZ_A, branchId: null, role: 'Owner' });
    const now = Math.floor(Date.now() / 1000);
    const bad = [
      await sign(
        { sub: u.id, type: 'cashier_select', iat: now - 900, exp: now - 600 },
        SECRETS.JWT_ACCESS_SECRET,
        'HS256',
      ),
      await sign(
        { sub: u.id, type: 'cashier_select', iat: now, exp: now + 300 },
        'another-secret',
        'HS256',
      ),
      await signAccessToken(u.id, SECRETS.JWT_ACCESS_SECRET),
      'garbage',
    ];
    for (const ticket of bad) {
      await expect(
        cashierService(w).createSession({ ticket, businessId: BIZ_A }),
      ).rejects.toMatchObject({ code: 'CASHIER_SELECTION_INVALID' });
    }
    expect(w.tokens.size).toBe(0);
  });

  it('a selection ticket cannot be used as an access token', async () => {
    const u = await w.addUser('owner');
    w.grants.push({ userId: u.id, businessId: BIZ_A, branchId: null, role: 'Owner' });
    const first = await cashierService(w).login({ email: u.email, password: u.password });
    if (first.status !== 'selection_required') throw new Error('expected selection');
    await expect(verifyAccessToken(first.ticket, SECRETS.JWT_ACCESS_SECRET)).rejects.toThrow();
  });
});

describe('rotation, replay and isolation', () => {
  async function signedIn(role: 'Staff' | 'Owner' = 'Staff', branch: string | null = BR_A1) {
    const u = await w.addUser(`u${w.users.size}`);
    w.grants.push({ userId: u.id, businessId: BIZ_A, branchId: branch, role });
    const r = await cashierService(w).login({ email: u.email, password: u.password });
    if (r.status !== 'authenticated') throw new Error('expected sign-in');
    return { u, r };
  }

  it('rotates inside the same session and keeps the binding and device label', async () => {
    const { u, r } = await signedIn();
    const sid = (await verifyCashierAccessToken(r.accessToken, SECRETS.JWT_ACCESS_SECRET)).sid;
    const next = await cashierService(w).refresh(r.refreshToken);
    expect(next.refreshToken).not.toBe(r.refreshToken);
    const claims = await verifyCashierAccessToken(next.accessToken, SECRETS.JWT_ACCESS_SECRET);
    expect(claims).toMatchObject({ sub: u.id, bid: BIZ_A, brid: BR_A1, sid });
    const rows = [...w.tokens.values()];
    expect(rows).toHaveLength(2);
    expect(
      rows.every((x) => x.sessionId === sid && x.client === 'cashier' && x.businessId === BIZ_A),
    ).toBe(true);
    expect(rows.filter((x) => !x.revokedAt)).toHaveLength(1);
  });

  it('answers a concurrent refresh inside the grace window with ROTATED and revokes nothing', async () => {
    const { r } = await signedIn();
    await cashierService(w).refresh(r.refreshToken);
    await expect(cashierService(w).refresh(r.refreshToken)).rejects.toMatchObject({
      code: 'REFRESH_TOKEN_ROTATED',
    });
    expect([...w.tokens.values()].filter((x) => !x.revokedAt)).toHaveLength(1);
  });

  it("a replay outside the grace window ends ONLY that cashier session, not the same person's web session", async () => {
    const { u, r } = await signedIn();
    // The same user also has a live web session.
    const web = await webService(w).login({ email: u.email, password: u.password });
    const first = await cashierService(w).refresh(r.refreshToken);
    for (const row of w.tokens.values())
      if (row.client === 'cashier' && row.revokedAt) row.revokedAt = new Date(Date.now() - 60_000);
    await expect(cashierService(w).refresh(r.refreshToken)).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
    });
    // The cashier session is gone (the successor is revoked too) ...
    await expect(cashierService(w).refresh(first.refreshToken)).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
    });
    // ... and the web session still refreshes.
    await expect(webService(w).refresh(web.refreshToken)).resolves.toBeTruthy();
  });

  it('keeps cashier and web refresh tokens apart in both directions', async () => {
    const { u, r } = await signedIn();
    const web = await webService(w).login({ email: u.email, password: u.password });
    // A cashier token on the web refresh: refused, nothing revoked, no ordinary token minted.
    await expect(webService(w).refresh(r.refreshToken)).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
    });
    expect([...w.tokens.values()].filter((x) => !x.revokedAt)).toHaveLength(2);
    // Even a REVOKED cashier token on the web refresh must not trigger the revoke-everything rule.
    await cashierService(w).refresh(r.refreshToken);
    for (const row of w.tokens.values())
      if (row.client === 'cashier' && row.revokedAt) row.revokedAt = new Date(Date.now() - 60_000);
    await expect(webService(w).refresh(r.refreshToken)).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
    });
    await expect(webService(w).refresh(web.refreshToken)).resolves.toBeTruthy();
    // A web token on the cashier refresh: refused, nothing revoked.
    const web2 = await webService(w).login({ email: u.email, password: u.password });
    await expect(cashierService(w).refresh(web2.refreshToken)).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
    });
    await expect(webService(w).refresh(web2.refreshToken)).resolves.toBeTruthy();
  });

  it('refuses a refresh token with a bad signature, a tampered row hash, or an expired row', async () => {
    const { r } = await signedIn();
    await expect(cashierService(w).refresh('garbage')).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
    });
    const row = [...w.tokens.values()][0]!;
    const saved = row.tokenHash;
    row.tokenHash = await hashToken('something else');
    await expect(cashierService(w).refresh(r.refreshToken)).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
    });
    row.tokenHash = saved;
    row.expiresAt = new Date(Date.now() - 1000);
    await expect(cashierService(w).refresh(r.refreshToken)).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
    });
  });
});

describe('revocation takes effect at the next refresh', () => {
  async function session(role: 'Staff' | 'Owner' = 'Staff', branch: string | null = BR_A1) {
    const u = await w.addUser(`r${w.users.size}`);
    w.grants.push({ userId: u.id, businessId: BIZ_A, branchId: branch, role });
    const r = await cashierService(w).login({
      email: u.email,
      password: u.password,
      ...(branch === null ? {} : {}),
    });
    if (r.status === 'selection_required') {
      const done = await cashierService(w).createSession({
        ticket: r.ticket,
        businessId: BIZ_A,
        branchId: BR_A1,
      });
      return { u, refreshToken: done.refreshToken };
    }
    return { u, refreshToken: r.refreshToken };
  }
  const live = () => [...w.tokens.values()].filter((x) => !x.revokedAt).length;

  it('staff removal (grant gone) ends the session', async () => {
    const { u, refreshToken } = await session();
    w.grants.splice(0, w.grants.length);
    await expect(cashierService(w).refresh(refreshToken)).rejects.toMatchObject({
      code: 'CASHIER_ACCESS_REVOKED',
    });
    expect(live()).toBe(0);
    expect(u.id).toBeTruthy();
  });

  it('a role that loses the cashier permission ends the session', async () => {
    const { refreshToken } = await session();
    w.roleOverrides.set('Staff', new Set(['business:view']));
    await expect(cashierService(w).refresh(refreshToken)).rejects.toMatchObject({
      code: 'CASHIER_ACCESS_REVOKED',
    });
    expect(live()).toBe(0);
  });

  it('a suspended business, a removed branch or a deactivated user ends the session', async () => {
    let s = await session();
    w.businesses.get(BIZ_A)!.status = 'suspended';
    await expect(cashierService(w).refresh(s.refreshToken)).rejects.toMatchObject({
      code: 'CASHIER_ACCESS_REVOKED',
    });
    w.businesses.get(BIZ_A)!.status = 'active';
    s = await session();
    w.branches.delete(BR_A1);
    await expect(cashierService(w).refresh(s.refreshToken)).rejects.toMatchObject({
      code: 'CASHIER_ACCESS_REVOKED',
    });
    w.branches.set(BR_A1, { id: BR_A1, businessId: BIZ_A, name: 'A one' });
    s = await session();
    w.users.get(s.u.id)!.status = 'suspended';
    await expect(cashierService(w).refresh(s.refreshToken)).rejects.toMatchObject({
      code: 'ACCOUNT_INACTIVE',
    });
    expect(live()).toBe(0);
  });

  it('a branch-scoped cashier cannot be moved to another branch or business by any input (the row is the binding)', async () => {
    const { refreshToken } = await session();
    const next = await cashierService(w).refresh(refreshToken);
    expect(next.session).toMatchObject({ businessId: BIZ_A, branchId: BR_A1 });
    // refresh() takes no business or branch input at all.
    expect(cashierService(w).refresh.length).toBe(1);
  });
});

describe('logout', () => {
  it('ends only the cashier session; a web token or garbage does nothing', async () => {
    const u = await w.addUser('counter');
    w.grants.push({ userId: u.id, businessId: BIZ_A, branchId: BR_A1, role: 'Staff' });
    const c = await cashierService(w).login({ email: u.email, password: u.password });
    if (c.status !== 'authenticated') throw new Error('expected sign-in');
    const web = await webService(w).login({ email: u.email, password: u.password });
    expect(await cashierService(w).logout(web.refreshToken)).toBeNull();
    expect(await cashierService(w).logout('garbage')).toBeNull();
    await expect(webService(w).refresh(web.refreshToken)).resolves.toBeTruthy();
    const ended = await cashierService(w).logout(c.refreshToken);
    expect(ended).toEqual({ userId: u.id, businessId: BIZ_A });
    await expect(cashierService(w).refresh(c.refreshToken)).rejects.toBeInstanceOf(AuthError);
  });

  it('a cashier token sent to the web logout ends nothing', async () => {
    const u = await w.addUser('counter');
    w.grants.push({ userId: u.id, businessId: BIZ_A, branchId: BR_A1, role: 'Staff' });
    const c = await cashierService(w).login({ email: u.email, password: u.password });
    if (c.status !== 'authenticated') throw new Error('expected sign-in');
    await webService(w).logout(c.refreshToken);
    await expect(cashierService(w).refresh(c.refreshToken)).resolves.toBeTruthy();
  });

  it('a password change style revoke-all also ends cashier sessions', async () => {
    const u = await w.addUser('counter');
    w.grants.push({ userId: u.id, businessId: BIZ_A, branchId: BR_A1, role: 'Staff' });
    const c = await cashierService(w).login({ email: u.email, password: u.password });
    if (c.status !== 'authenticated') throw new Error('expected sign-in');
    await w.repos.refreshTokens.revokeAllForUser(u.id);
    await expect(cashierService(w).refresh(c.refreshToken)).rejects.toBeInstanceOf(AuthError);
  });
});
