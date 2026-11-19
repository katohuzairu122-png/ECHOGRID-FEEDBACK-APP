import type { Repositories } from '../repositories';
import type { Bindings } from '../config/env';
import type { Pbkdf2Worker } from './pbkdf2-worker';
import { hashToken } from './token-hash';
import type { RefreshToken } from '../repositories/refresh-token.repository';
import { constantTimeEqualHex } from './crypto-utils';
import { AuthError, DUMMY_PASSWORD_HASH } from './auth.service';
import {
  LOCKOUT_DURATION_MS, LOCKOUT_MAX_FAILURES, LOCKOUT_WINDOW_MS, normalizeBusinessCode, normalizeUsername,
} from '../cashier-accounts/credentials';

/** Short, non-reversible fingerprint of the stored password hash: changes whenever the password does. */
const passwordVersion = async (passwordHash: string) => (await hashToken(passwordHash)).slice(0, 16);
import {
  CASHIER_REFRESH_TOKEN_TTL_SECONDS,
  signCashierAccessToken,
  signCashierSelectionTicket,
  signRefreshToken,
  verifyCashierSelectionTicket,
  verifyRefreshToken,
} from './jwt';

/**
 * CASHIER-PWA-01 C3: independent cashier sign-in, refresh and sign-out.
 *
 * Same staff identities, credentials, memberships and permissions as the web app; a different SESSION. A cashier
 * session is bound to one business and optionally one branch, has its own refresh-token family (`client = cashier`),
 * and its access token is the scope-limited token from C2. Nothing here grants anything: eligibility is exactly the
 * existing permission `loyalty:serve` at the chosen business and branch, which the default Owner, Manager and Staff
 * roles all hold, so owners and managers are eligible through their roles and no special case exists.
 */
const SERVE = 'loyalty:serve';

export interface CashierChoice {
  businessId: string;
  businessName: string;
  /** True when the user holds the permission business-wide, so a session may also be bound to no branch. */
  wideAccess: boolean;
  /** Branches this user may serve at (all of the business's branches for a business-wide role). */
  branches: { id: string; name: string }[];
}

export interface CashierSession {
  accessToken: string;
  refreshToken: string;
  session: {
    businessId: string;
    branchId: string | null;
    deviceLabel: string | null;
    /** Display names for the cashier app header (it may not call any route beyond its allow-list to learn them). */
    businessName: string | null;
    branchName: string | null;
    /** CASHIER-AUTH-02C: true only for a managed identity currently assigned two or more branches. Display only; the server decides every switch. */
    canSwitchBranch: boolean;
  };
}

/** The verified identity of a presented session credential, reported before any authorization decision so a refusal is attributable. */
export interface SwitchIdentity { userId: string; businessId: string; branchId: string | null }

export type SwitchOutcome =
  | ({ status: 'switched'; fromBranchId: string | null; toBranchId: string; previousSessionId: string; sessionId: string; userId: string } & CashierSession)
  /** Asking for the branch the session is already on: nothing is rotated, revoked or audited (documented, deterministic no-op). */
  | { status: 'unchanged'; userId: string; session: CashierSession['session'] }
  /** A refusal that also needed state changes (a revocation) to be committed first; the caller throws `error` after commit. */
  | { status: 'denied'; error: AuthError };

export type CashierLoginResult =
  | ({ status: 'authenticated' } & CashierSession)
  | { status: 'selection_required'; ticket: string; choices: CashierChoice[] };

type CashierRepos = Pick<
  Repositories,
  'users' | 'refreshTokens' | 'userBusinessRoles' | 'permissions' | 'businesses' | 'branches' | 'auditLog'
>;

interface Meta {
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}

const MAX_BRANCHES_LISTED = 200;
const GRACE_MS = 10_000;

export class CashierAuthService {
  constructor(
    private readonly repos: CashierRepos,
    private readonly secrets: Pick<Bindings, 'JWT_ACCESS_SECRET' | 'JWT_REFRESH_SECRET'>,
    private readonly hasher: Pbkdf2Worker,
    /**
     * SEC-CASHIER-02C-R1: how to run a unit of work in ONE database transaction, given by the route for the paths that are not already
     * transactional (sign-in). Absent when the caller is already inside a transaction (the branch switch) or has none (unit tests).
     */
    private readonly transact?: <T>(work: (repos: CashierRepos) => Promise<T>) => Promise<T>,
  ) {}

  /** Step 1: the same credential check as the web login (constant cost, one error for unknown user or wrong password). */
  async login(
    input: { email: string; password: string; deviceLabel?: string | undefined } & Meta,
  ): Promise<CashierLoginResult & { userId: string }> {
    const user = await this.repos.users.findByEmail(input.email);
    const valid = await this.hasher.verify(
      input.password,
      user?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );
    if (!user || !valid) throw new AuthError('Invalid email or password.', 'INVALID_CREDENTIALS');
    if (user.status !== 'active')
      throw new AuthError('This account is not active.', 'ACCOUNT_INACTIVE');

    return this.proceedAfterCredentials(user, input.deviceLabel, input);
  }

  /**
   * CASHIER-AUTH-02A (D-3, D-5): sign-in for a business-managed cashier identity (no email). The business is resolved from its
   * public cashier code FIRST, then the username is looked up inside that business only. Every failure (bad format, unknown
   * code, unknown username, wrong password, locked, disabled, revoked, no branch grant) is the same generic error after the
   * same PBKDF2 work, so neither existence nor lock state can be probed. A correct password never unlocks a locked identity.
   */
  async managedLogin(
    input: { businessCode: string; username: string; password: string; deviceLabel?: string | undefined } & Meta,
  ): Promise<CashierLoginResult & { userId: string }> {
    const fail = () => new AuthError('Invalid sign-in details.', 'INVALID_CREDENTIALS');
    const code = normalizeBusinessCode(input.businessCode);
    const username = normalizeUsername(input.username);
    const business = code ? await this.repos.businesses.findByCashierCode(code) : undefined;
    const user = business && username ? await this.repos.users.findManagedByUsername(business.id, username) : undefined;
    const valid = await this.hasher.verify(input.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!business || !user || business.status !== 'active') throw fail();
    const lockedNow = user.lockedUntil !== null && user.lockedUntil > new Date();
    if (!valid) {
      await this.repos.users.recordFailedManagedLogin(user.id, LOCKOUT_MAX_FAILURES, LOCKOUT_WINDOW_MS, LOCKOUT_DURATION_MS);
      throw fail();
    }
    if (lockedNow || user.status !== 'active') throw fail();
    await this.repos.users.clearManagedLoginFailures(user.id);
    // Only this business: a managed identity can never be offered another one (the database also forbids such a grant).
    try {
      return await this.proceedAfterCredentials(user, input.deviceLabel, input, business.id);
    } catch (error) {
      // No branch grant: the same generic failure, never a distinguishable "account exists but has no access".
      if (error instanceof AuthError && error.code === 'CASHIER_ACCESS_DENIED') throw fail();
      throw error;
    }
  }

  /** The part of sign-in that follows a verified credential: eligibility, then a session or a selection ticket. */
  private async proceedAfterCredentials(
    user: { id: string; passwordHash: string; managedBusinessId?: string | null },
    deviceLabel: string | undefined,
    meta: Meta,
    onlyBusinessId?: string,
  ): Promise<CashierLoginResult & { userId: string }> {
    const all = await this.eligibleChoices(user.id);
    const choices = onlyBusinessId ? all.filter((c) => c.businessId === onlyBusinessId) : all;
    if (choices.length === 0) {
      throw new AuthError('This account cannot use the cashier app.', 'CASHIER_ACCESS_DENIED');
    }
    await this.repos.users.touchLastLogin(user.id);

    // Exactly one place to serve: sign straight in (a business-wide user with branches still chooses a branch).
    const only = choices[0];
    if (
      choices.length === 1 &&
      only &&
      !(only.wideAccess && only.branches.length > 0) &&
      only.branches.length <= 1
    ) {
      const branchId = only.branches[0]?.id ?? null;
      // Exactly one branch (or none): there is nothing to switch to.
      const session = await this.openGuardedSession(user.id, only.businessId, branchId, deviceLabel, meta, false);
      return { status: 'authenticated', ...session, userId: user.id };
    }
    const ticket = await signCashierSelectionTicket(
      user.id,
      this.secrets.JWT_ACCESS_SECRET,
      deviceLabel,
      await passwordVersion(user.passwordHash),
    );
    return { status: 'selection_required', ticket, choices, userId: user.id };
  }

  /** Step 2: finish a selection with the ticket. Eligibility is re-checked now, not trusted from step 1. */
  async createSession(
    input: {
      ticket: string;
      businessId: string;
      branchId?: string | undefined;
      deviceLabel?: string | undefined;
    } & Meta,
  ): Promise<CashierSession & { userId: string }> {
    let ticket: Awaited<ReturnType<typeof verifyCashierSelectionTicket>>;
    try {
      ticket = await verifyCashierSelectionTicket(input.ticket, this.secrets.JWT_ACCESS_SECRET);
    } catch {
      throw new AuthError('This sign-in has expired. Sign in again.', 'CASHIER_SELECTION_INVALID');
    }
    const user = await this.repos.users.findById(ticket.sub);
    if (!user || user.status !== 'active')
      throw new AuthError('This account is not active.', 'ACCOUNT_INACTIVE');

    // SEC-CASHIER-R2 F7: a password changed since sign-in voids the ticket.
    if (ticket.pwv !== null && ticket.pwv !== (await passwordVersion(user.passwordHash))) {
      throw new AuthError('This sign-in has expired. Sign in again.', 'CASHIER_SELECTION_INVALID');
    }

    const choice = (await this.eligibleChoices(user.id)).find(
      (c) => c.businessId === input.businessId,
    );
    if (!choice)
      throw new AuthError('This account cannot use the cashier app here.', 'CASHIER_ACCESS_DENIED');
    let branchId: string | null = null;
    if (input.branchId !== undefined) {
      if (!choice.branches.some((b) => b.id === input.branchId)) {
        throw new AuthError(
          'This account cannot use the cashier app at that branch.',
          'CASHIER_ACCESS_DENIED',
        );
      }
      branchId = input.branchId;
    } else if (!choice.wideAccess) {
      throw new AuthError('Choose a branch.', 'CASHIER_SELECTION_INVALID');
    }
    // SEC-CASHIER-R2 F7: single use. Spent only after every check passes, atomically, so a replay or a concurrent twin loses.
    const spent = await this.repos.refreshTokens.consumeCashierTicket({
      jti: ticket.jti,
      userId: user.id,
      expiresAt: ticket.expiresAt,
    });
    if (!spent) throw new AuthError('This sign-in has already been used. Sign in again.', 'CASHIER_SELECTION_INVALID');
    const session = await this.openGuardedSession(
      user.id,
      choice.businessId,
      branchId,
      input.deviceLabel ?? ticket.deviceLabel,
      input,
      user.managedBusinessId !== null && choice.branches.length >= 2,
    );
    return { ...session, userId: user.id };
  }

  /** Rotation inside the same session; the binding is read from the stored row, never from the request. */
  async refresh(rawRefreshToken: string): Promise<CashierSession & { userId: string }> {
    const payload = await this.verifyRefresh(rawRefreshToken);
    const stored = await this.repos.refreshTokens.findById(payload.jti);
    const invalid = () =>
      new AuthError('Refresh token is invalid or expired.', 'INVALID_REFRESH_TOKEN');
    if (!stored || stored.expiresAt < new Date()) throw invalid();
    if (!constantTimeEqualHex(await hashToken(rawRefreshToken), stored.tokenHash)) throw invalid();
    // Only cashier sessions: a web refresh token is refused here and nothing is revoked.
    if (stored.client !== 'cashier' || !stored.businessId || !stored.sessionId) throw invalid();

    if (stored.revokedAt) {
      const justRotated =
        stored.replacedByTokenId != null && Date.now() - stored.revokedAt.getTime() <= GRACE_MS;
      if (justRotated) {
        throw new AuthError(
          'Refresh token was already rotated by a concurrent request.',
          'REFRESH_TOKEN_ROTATED',
        );
      }
      // A replay means this cashier credential escaped. Contain it by ending THIS cashier session AND every session that
      // descends from it (a branch switch starts a new session; see containReplay). The same person's web session and
      // other devices are not implicated by a counter-device replay and stay signed in.
      await this.containReplay(stored);
      throw invalid();
    }

    const user = await this.repos.users.findById(stored.userId);
    if (!user || user.status !== 'active') {
      await this.repos.refreshTokens.revokeSession(stored.userId, stored.sessionId);
      throw new AuthError('This account is not active.', 'ACCOUNT_INACTIVE');
    }
    // Role removal, staff removal, a suspended business or a removed branch end the session at the next refresh
    // (and per request, through the C2 tenant checks, before that).
    if (!(await this.stillEligible(stored.userId, stored.businessId, stored.branchId))) {
      await this.repos.refreshTokens.revokeSession(stored.userId, stored.sessionId);
      throw new AuthError('Cashier access is no longer available.', 'CASHIER_ACCESS_REVOKED');
    }

    const canSwitchBranch = await this.canSwitch(user, stored.businessId);
    const next = await this.issue(
      stored.userId,
      stored.sessionId,
      stored.businessId,
      stored.branchId,
      stored.deviceLabel,
      {
        userAgent: stored.userAgent ?? undefined,
        ipAddress: stored.ipAddress ?? undefined,
      },
    );
    const rotated = await this.repos.refreshTokens.rotate(stored.id, next.refreshTokenId);
    if (rotated === false) {
      await this.repos.refreshTokens.revoke(next.refreshTokenId);
      throw new AuthError(
        'Refresh token was already rotated by a concurrent request.',
        'REFRESH_TOKEN_ROTATED',
      );
    }
    return {
      accessToken: next.accessToken,
      refreshToken: next.refreshToken,
      session: {
        businessId: stored.businessId,
        branchId: stored.branchId,
        deviceLabel: stored.deviceLabel,
        ...(await this.names(stored.businessId, stored.branchId)),
        canSwitchBranch,
      },
      userId: stored.userId,
    };
  }

  /**
   * CASHIER-AUTH-02C (D-1 to D-7): moves a live managed-cashier session to another branch it is assigned to, without a password.
   *
   * MUST run inside a database transaction (the route supplies it): everything below commits or rolls back as one unit, so a
   * failure at any point (including the audit write) leaves the old session exactly as it was. The credential is the session's
   * own refresh token. Steps, all server-side and none trusting the client's branch id:
   *  1. verify the token and identify the session (the identity is reported to `onIdentified` so even a refusal is attributable);
   *  2. take the EXCLUSIVE session lock (serialises with refresh, other switches and in-flight mutations, which hold the shared lock);
   *  3. re-read under the lock, then check account active, managed identity, not locked, business active, current binding still
   *     authorised, and the target is a currently assigned, live branch of the SAME business;
   *  4. replace the session: a NEW session id, new access and refresh tokens bound to the target, the presented token marked as
   *     superseded and every row of the old session revoked, so the old branch's access token stops working on its next request;
   *  5. write the audit row in the same transaction.
   * Only managed identities may switch; staff-email cashier sessions keep signing in again (documented decision).
   */
  async switchBranch(
    input: { refreshToken: string; targetBranchId: string; fromBranchId?: string | undefined } & Meta,
    onIdentified?: (identity: SwitchIdentity) => void,
  ): Promise<SwitchOutcome> {
    const invalid = () => new AuthError('Refresh token is invalid or expired.', 'INVALID_REFRESH_TOKEN');
    const payload = await this.verifyRefresh(input.refreshToken);
    const first = await this.repos.refreshTokens.findById(payload.jti);
    if (!first || first.expiresAt < new Date()) throw invalid();
    if (!constantTimeEqualHex(await hashToken(input.refreshToken), first.tokenHash)) throw invalid();
    // Only a cashier session: a web refresh token is refused here and nothing is revoked.
    if (first.client !== 'cashier' || !first.businessId || !first.sessionId) throw invalid();
    onIdentified?.({ userId: first.userId, businessId: first.businessId, branchId: first.branchId });

    const previousSessionId = first.sessionId;
    // SEC-CASHIER-02C-R1: the user row FIRST, then the session rows. Taking it before the eligibility read below is what makes a
    // concurrent branch removal, disable or credential reset strictly ordered against this switch (see lockForSessionIssue). The order
    // (user row, then session rows) is the same on every path, and administrators take the user row before touching session rows.
    await this.repos.users.lockForSessionIssue(first.userId);
    await this.repos.refreshTokens.lockSessionForUpdate(first.userId, previousSessionId);
    const stored = await this.repos.refreshTokens.findById(first.id); // re-read UNDER the lock
    if (!stored || !stored.businessId) throw invalid();
    if (stored.revokedAt) {
      // Already spent: a concurrent switch or refresh won, or this is a replay. Same rule as refresh().
      const justRotated = stored.replacedByTokenId != null && Date.now() - stored.revokedAt.getTime() <= GRACE_MS;
      if (justRotated) {
        throw new AuthError('Refresh token was already rotated by a concurrent request.', 'REFRESH_TOKEN_ROTATED');
      }
      await this.containReplay(stored);
      return { status: 'denied', error: invalid() };
    }

    const user = await this.repos.users.findById(stored.userId);
    if (!user || user.status !== 'active') {
      await this.repos.refreshTokens.revokeSession(stored.userId, previousSessionId);
      return { status: 'denied', error: new AuthError('This account is not active.', 'ACCOUNT_INACTIVE') };
    }
    if (user.managedBusinessId === null || user.managedBusinessId !== stored.businessId) {
      throw new AuthError('Branch switching is not available for this account.', 'CASHIER_SWITCH_NOT_AVAILABLE');
    }
    // A locked identity cannot switch (fail closed). Existing sessions keep serving until an administrator acts.
    if (user.lockedUntil !== null && user.lockedUntil > new Date()) {
      throw new AuthError('This account cannot use the cashier app right now.', 'CASHIER_ACCESS_DENIED');
    }
    if (!(await this.stillEligible(stored.userId, stored.businessId, stored.branchId))) {
      await this.repos.refreshTokens.revokeSession(stored.userId, previousSessionId);
      return { status: 'denied', error: new AuthError('Cashier access is no longer available.', 'CASHIER_ACCESS_REVOKED') };
    }
    const choice = (await this.eligibleChoices(user.id)).find((c) => c.businessId === stored.businessId);
    if (!choice) {
      await this.repos.refreshTokens.revokeSession(stored.userId, previousSessionId);
      return { status: 'denied', error: new AuthError('Cashier access is no longer available.', 'CASHIER_ACCESS_REVOKED') };
    }
    // The client's branch id is only a request: it must be one of the branches the server currently lists for this identity.
    const target = choice.branches.find((b) => b.id === input.targetBranchId);
    if (!target) {
      throw new AuthError('This account cannot use the cashier app at that branch.', 'CASHIER_ACCESS_DENIED');
    }
    const canSwitchBranch = choice.branches.length >= 2;
    if (target.id === stored.branchId) {
      return {
        status: 'unchanged',
        userId: user.id,
        session: {
          businessId: stored.businessId, branchId: stored.branchId, deviceLabel: stored.deviceLabel,
          ...(await this.names(stored.businessId, stored.branchId)), canSwitchBranch,
        },
      };
    }
    if (input.fromBranchId !== undefined && input.fromBranchId !== stored.branchId) {
      throw new AuthError('The active branch changed. Reload and try again.', 'CASHIER_SWITCH_CONFLICT');
    }

    const sessionId = crypto.randomUUID();
    const next = await this.issue(user.id, sessionId, stored.businessId, target.id, stored.deviceLabel, input);
    if (!(await this.repos.refreshTokens.rotate(stored.id, next.refreshTokenId))) {
      throw new AuthError('Refresh token was already rotated by a concurrent request.', 'REFRESH_TOKEN_ROTATED');
    }
    await this.repos.refreshTokens.revokeSession(stored.userId, previousSessionId); // any sibling row of the old session
    await this.repos.auditLog.record({
      businessId: stored.businessId,
      actorUserId: user.id,
      action: 'auth.cashier_branch_switched',
      entityType: 'session',
      entityId: sessionId,
      metadata: {
        client: 'cashier', outcome: 'success', method: 'branch_switch',
        fromBranchId: stored.branchId, toBranchId: target.id, previousSessionId, sessionId,
      },
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });
    return {
      status: 'switched',
      userId: user.id,
      fromBranchId: stored.branchId,
      toBranchId: target.id,
      previousSessionId,
      sessionId,
      accessToken: next.accessToken,
      refreshToken: next.refreshToken,
      session: {
        businessId: stored.businessId, branchId: target.id, deviceLabel: stored.deviceLabel,
        ...(await this.names(stored.businessId, target.id)), canSwitchBranch,
      },
    };
  }

  /**
   * CASHIER-AUTH-02C: the branches the session may switch to, for the switch dialog. Read-only (no rotation, no lock): the
   * answer is advisory, because every switch re-checks everything. Returns the current binding and the full current list.
   */
  async listBranches(rawRefreshToken: string): Promise<{
    businessId: string; current: { id: string; name: string } | null; branches: { id: string; name: string }[]; canSwitchBranch: boolean;
  }> {
    const invalid = () => new AuthError('Refresh token is invalid or expired.', 'INVALID_REFRESH_TOKEN');
    const payload = await this.verifyRefresh(rawRefreshToken);
    const stored = await this.repos.refreshTokens.findById(payload.jti);
    if (!stored || stored.expiresAt < new Date() || stored.revokedAt) throw invalid();
    if (!constantTimeEqualHex(await hashToken(rawRefreshToken), stored.tokenHash)) throw invalid();
    if (stored.client !== 'cashier' || !stored.businessId || !stored.sessionId) throw invalid();
    const user = await this.repos.users.findById(stored.userId);
    if (!user || user.status !== 'active') throw new AuthError('This account is not active.', 'ACCOUNT_INACTIVE');
    if (user.managedBusinessId === null || user.managedBusinessId !== stored.businessId) {
      throw new AuthError('Branch switching is not available for this account.', 'CASHIER_SWITCH_NOT_AVAILABLE');
    }
    if (!(await this.stillEligible(stored.userId, stored.businessId, stored.branchId))) {
      throw new AuthError('Cashier access is no longer available.', 'CASHIER_ACCESS_REVOKED');
    }
    const choice = (await this.eligibleChoices(user.id)).find((c) => c.businessId === stored.businessId);
    if (!choice) throw new AuthError('Cashier access is no longer available.', 'CASHIER_ACCESS_REVOKED');
    const current = choice.branches.find((b) => b.id === stored.branchId) ?? null;
    return { businessId: stored.businessId, current, branches: choice.branches, canSwitchBranch: choice.branches.length >= 2 };
  }

  /**
   * Ends a replayed credential's session AND every session that descends from it. A branch switch replaces the session, linking
   * the superseded refresh token to its successor, so a stolen pre-switch token cannot be replayed without also ending the
   * session the real cashier moved to. Follows the replacement chain (bounded, cycle-safe).
   */
  private async containReplay(stored: RefreshToken): Promise<void> {
    const seen = new Set<string>();
    let current: RefreshToken | undefined = stored;
    for (let hop = 0; current && hop < 25; hop++) {
      if (current.sessionId && !seen.has(current.sessionId)) {
        seen.add(current.sessionId);
        await this.repos.refreshTokens.revokeSession(current.userId, current.sessionId);
      }
      current = current.replacedByTokenId ? await this.repos.refreshTokens.findById(current.replacedByTokenId) : undefined;
    }
  }

  /** Display flag only: a managed identity with two or more currently eligible branches in this business. */
  private async canSwitch(user: { id: string; managedBusinessId: string | null }, businessId: string): Promise<boolean> {
    if (user.managedBusinessId === null || user.managedBusinessId !== businessId) return false;
    const choice = (await this.eligibleChoices(user.id)).find((c) => c.businessId === businessId);
    return (choice?.branches.length ?? 0) >= 2;
  }

  /** Ends only the cashier session the token belongs to. A web token, or anything unrecognised, does nothing. */
  async logout(
    rawRefreshToken: string,
  ): Promise<{ userId: string; businessId: string; branchId: string | null } | null> {
    const payload = await this.verifyRefresh(rawRefreshToken).catch(() => null);
    if (!payload) return null;
    const stored = await this.repos.refreshTokens.findById(payload.jti);
    if (!stored || stored.client !== 'cashier' || !stored.sessionId || !stored.businessId)
      return null;
    await this.repos.refreshTokens.revoke(stored.id);
    await this.repos.refreshTokens.revokeSession(stored.userId, stored.sessionId);
    return { userId: stored.userId, businessId: stored.businessId, branchId: stored.branchId };
  }

  /** Every business and branch where this user currently holds the cashier permission. */
  async eligibleChoices(userId: string): Promise<CashierChoice[]> {
    const grants = await this.repos.userBusinessRoles.listForUser(userId);
    const businessIds = [...new Set(grants.map((g) => g.businessId))];
    const choices: CashierChoice[] = [];
    for (const businessId of businessIds) {
      const business = await this.repos.businesses.findById(businessId);
      if (!business || business.status !== 'active') continue;
      const mine = grants.filter((g) => g.businessId === businessId);
      const wideGrant = mine.some((g) => g.branchId === null);
      let wideAccess = false;
      const branches: { id: string; name: string }[] = [];
      if (
        wideGrant &&
        (await this.repos.permissions.findEffectiveKeys(userId, businessId)).has(SERVE)
      ) {
        wideAccess = true;
        const all = await this.repos.branches.listByBusiness(businessId, {
          limit: MAX_BRANCHES_LISTED,
        });
        for (const b of all) branches.push({ id: b.id, name: b.name });
      } else {
        for (const branchId of new Set(
          mine.map((g) => g.branchId).filter((x): x is string => x !== null),
        )) {
          const branch = await this.repos.branches.findById(branchId, businessId);
          if (
            branch &&
            (await this.repos.permissions.findEffectiveKeys(userId, businessId, branchId)).has(
              SERVE,
            )
          ) {
            branches.push({ id: branch.id, name: branch.name });
          }
        }
        if (branches.length === 0) continue;
      }
      choices.push({ businessId, businessName: business.name, wideAccess, branches });
    }
    return choices;
  }

  private async stillEligible(
    userId: string,
    businessId: string,
    branchId: string | null,
  ): Promise<boolean> {
    const business = await this.repos.businesses.findById(businessId);
    if (!business || business.status !== 'active') return false;
    const mine = await this.repos.userBusinessRoles.listForUserAtBusiness(userId, businessId);
    if (mine.length === 0) return false;
    if (branchId !== null) {
      if (!mine.some((g) => g.branchId === null || g.branchId === branchId)) return false;
      if (!(await this.repos.branches.findById(branchId, businessId))) return false;
    } else if (!mine.some((g) => g.branchId === null)) {
      return false;
    }
    return (
      await this.repos.permissions.findEffectiveKeys(userId, businessId, branchId ?? undefined)
    ).has(SERVE);
  }

  /**
   * SEC-CASHIER-02C-R1: runs `work` under the SHARE lock on the user row, inside one transaction when the route supplied one.
   * The account must be active under the lock, so a disable or revoke that committed first refuses the issuance.
   */
  private async underUserLock<T>(userId: string, work: (service: CashierAuthService) => Promise<T>): Promise<T> {
    const run = async (service: CashierAuthService) => {
      const user = await service.repos.users.lockForSessionIssue(userId);
      if (!user || user.status !== 'active') throw new AuthError('This account is not active.', 'ACCOUNT_INACTIVE');
      return work(service);
    };
    if (!this.transact) return run(this);
    return this.transact((repos) => run(new CashierAuthService(repos, this.secrets, this.hasher)));
  }

  /**
   * Opens a NEW branch-bound session (sign-in) with authority re-checked AFTER the user-row lock and BEFORE the insert, in the same
   * transaction. The eligibility computed earlier in the request may be stale by the time we get here (a branch removal can commit
   * in between); this is the check that counts. The lock is held until the new session row commits, so a removal that starts later
   * waits, then revokes the row this call created.
   */
  private async openGuardedSession(
    userId: string,
    businessId: string,
    branchId: string | null,
    deviceLabel: string | undefined,
    meta: Meta,
    canSwitchBranch = false,
  ): Promise<CashierSession> {
    return this.underUserLock(userId, async (service) => {
      if (!(await service.stillEligible(userId, businessId, branchId))) {
        throw new AuthError('This account cannot use the cashier app at that branch.', 'CASHIER_ACCESS_DENIED');
      }
      return service.openSession(userId, businessId, branchId, deviceLabel, meta, canSwitchBranch);
    });
  }

  private async openSession(
    userId: string,
    businessId: string,
    branchId: string | null,
    deviceLabel: string | undefined,
    meta: Meta,
    canSwitchBranch = false,
  ): Promise<CashierSession> {
    const t = await this.issue(
      userId,
      crypto.randomUUID(),
      businessId,
      branchId,
      deviceLabel ?? null,
      meta,
    );
    return {
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
      session: {
        businessId,
        branchId,
        deviceLabel: deviceLabel ?? null,
        ...(await this.names(businessId, branchId)),
        canSwitchBranch,
      },
    };
  }

  private async names(businessId: string, branchId: string | null) {
    const business = await this.repos.businesses.findById(businessId);
    const branch = branchId ? await this.repos.branches.findById(branchId, businessId) : undefined;
    return { businessName: business?.name ?? null, branchName: branch?.name ?? null };
  }

  private async issue(
    userId: string,
    sessionId: string,
    businessId: string,
    branchId: string | null,
    deviceLabel: string | null,
    meta: Meta,
  ) {
    const accessToken = await signCashierAccessToken(userId, this.secrets.JWT_ACCESS_SECRET, {
      sessionId,
      businessId,
      branchId,
    });
    const tokenId = crypto.randomUUID();
    const { token: refreshToken, expiresAt } = await signRefreshToken(
      userId,
      tokenId,
      this.secrets.JWT_REFRESH_SECRET,
      CASHIER_REFRESH_TOKEN_TTL_SECONDS,
    );
    await this.repos.refreshTokens.create({
      id: tokenId,
      userId,
      tokenHash: await hashToken(refreshToken),
      sessionId,
      expiresAt,
      userAgent: meta.userAgent,
      ipAddress: meta.ipAddress,
      client: 'cashier',
      businessId,
      branchId,
      deviceLabel: deviceLabel ?? null,
    });
    return { accessToken, refreshToken, refreshTokenId: tokenId };
  }

  private async verifyRefresh(raw: string) {
    try {
      return await verifyRefreshToken(raw, this.secrets.JWT_REFRESH_SECRET);
    } catch {
      throw new AuthError('Refresh token is invalid or expired.', 'INVALID_REFRESH_TOKEN');
    }
  }
}
