import type { Repositories } from '../repositories';
import type { Bindings } from '../config/env';
import type { Pbkdf2Worker } from './pbkdf2-worker';
import { hashToken } from './token-hash';
import { constantTimeEqualHex } from './crypto-utils';
import { AuthError, DUMMY_PASSWORD_HASH } from './auth.service';
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
  };
}

export type CashierLoginResult =
  | ({ status: 'authenticated' } & CashierSession)
  | { status: 'selection_required'; ticket: string; choices: CashierChoice[] };

type CashierRepos = Pick<
  Repositories,
  'users' | 'refreshTokens' | 'userBusinessRoles' | 'permissions' | 'businesses' | 'branches'
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

    const choices = await this.eligibleChoices(user.id);
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
      const session = await this.openSession(
        user.id,
        only.businessId,
        branchId,
        input.deviceLabel,
        input,
      );
      return { status: 'authenticated', ...session, userId: user.id };
    }
    const ticket = await signCashierSelectionTicket(
      user.id,
      this.secrets.JWT_ACCESS_SECRET,
      input.deviceLabel,
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
    let ticket: { sub: string; deviceLabel?: string };
    try {
      ticket = await verifyCashierSelectionTicket(input.ticket, this.secrets.JWT_ACCESS_SECRET);
    } catch {
      throw new AuthError('This sign-in has expired. Sign in again.', 'CASHIER_SELECTION_INVALID');
    }
    const user = await this.repos.users.findById(ticket.sub);
    if (!user || user.status !== 'active')
      throw new AuthError('This account is not active.', 'ACCOUNT_INACTIVE');

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
    const session = await this.openSession(
      user.id,
      choice.businessId,
      branchId,
      input.deviceLabel ?? ticket.deviceLabel,
      input,
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
      // A replay means this cashier credential escaped. Contain it by ending THIS cashier session only; the same
      // person's web session and other devices are not implicated by a counter-device replay and stay signed in.
      await this.repos.refreshTokens.revokeSession(stored.userId, stored.sessionId);
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
      },
      userId: stored.userId,
    };
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

  private async openSession(
    userId: string,
    businessId: string,
    branchId: string | null,
    deviceLabel: string | undefined,
    meta: Meta,
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
