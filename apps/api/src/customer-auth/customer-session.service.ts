import type { Db } from '../db/client';
import { CustomerAuthEventRepository } from '../repositories/customer-auth-event.repository';
import { CustomerCredentialRepository } from '../repositories/customer-credential.repository';
import { CustomerRefreshTokenRepository } from '../repositories/customer-refresh-token.repository';
import { CustomerRepository } from '../repositories/customer.repository';
import {
  CustomerSessionRepository,
  type CustomerSession,
} from '../repositories/customer-session.repository';
import type { CustomerSessionAuthMethod } from '../db/schema';
import { verifyCustomerAccessToken } from './customer-jwt';
import {
  computeSessionExpiries,
  customerMayHaveSession,
  evaluateLegacyToken,
  evaluatePasswordEnrollment,
  evaluateRefresh,
  nextIdleExpiry,
  sessionLiveness,
} from './session-policy';
import {
  generateRefreshCredential,
  hashRefreshCredential,
  isWellFormedRefreshCredential,
  signCustomerSessionAccessToken,
  verifyCustomerSessionAccessToken,
} from './session-tokens';

/**
 * CUSTOMER-AUTH-01D-3: the revocable customer session service.
 *
 * NOT wired into any route or middleware. Nothing in the running API calls it,
 * and the legacy 90-day token path (customerAuthenticate) is unchanged. 01D-4
 * (routes) and 01D-6 (middleware, dual verification, kill switches) will call
 * it.
 *
 * Rules implemented here, from CUSTOMER_AUTH_01 reconciliation and 01A to 01C:
 *  - Refresh: exactly one exchange wins. A second attempt inside the grace
 *    window is a retryable CONFLICT that issues nothing and revokes nothing.
 *    Reuse outside the grace window is replay and revokes ONLY the compromised
 *    session and its token chain (01B I4), never the customer's other devices.
 *  - Password enrollment and change need a live session with a FRESH step-up.
 *    A legacy token can never set a password (01C section 6.2).
 *  - Every sensitive change, the session revocations it implies and the legacy
 *    cutoff advance happen in ONE transaction (01B I6, MG-02).
 *  - Failure results are deliberately coarse. The API layer must map
 *    `invalid` to one generic 401 so callers cannot tell a revoked session from
 *    an expired one.
 *
 * Lifetimes and windows are REQUIRED config with no defaults: CA-02 (idle and
 * refresh lifetimes) and the step-up window are owner decisions this code must
 * not invent.
 */

export type CustomerSessionServiceConfig = {
  /** Signs session access tokens. Distinct from the legacy CUSTOMER_JWT_SECRET. */
  sessionSigningSecret: string;
  /** Verifies the legacy 90-day token. Same value as CUSTOMER_JWT_SECRET. */
  legacySigningSecret: string;
  /** KS-2 (01C section 9): whether legacy tokens are accepted at all. */
  legacyAccepted: () => boolean;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  absoluteTtlSeconds: number;
  idleTtlSeconds: number;
  stepUpWindowSeconds: number;
  /** Concurrent-refresh grace. Defaults to the policy value when omitted. */
  refreshGraceMs?: number;
  now?: () => Date;
};

type Stores = {
  customers: CustomerRepository;
  sessions: CustomerSessionRepository;
  tokens: CustomerRefreshTokenRepository;
  credentials: CustomerCredentialRepository;
  events: CustomerAuthEventRepository;
};

function storesFor(db: Db): Stores {
  return {
    customers: new CustomerRepository(db),
    sessions: new CustomerSessionRepository(db),
    tokens: new CustomerRefreshTokenRepository(db),
    credentials: new CustomerCredentialRepository(db),
    events: new CustomerAuthEventRepository(db),
  };
}

export type IssuedSession = {
  customerId: string;
  sessionId: string;
  accessToken: string;
  accessExpiresAt: Date;
  /** The raw credential. Returned exactly once and never stored: only its hash is. */
  refreshCredential: string;
  refreshExpiresAt: Date;
  sessionAbsoluteExpiresAt: Date;
};

export type EstablishSessionResult =
  { ok: true; session: IssuedSession } | { ok: false; reason: 'customer_inactive' };

export type RefreshResult =
  | { ok: true; session: IssuedSession }
  /** Retryable. Another request already rotated this credential a moment ago. Issues nothing, revokes nothing. */
  | { ok: false; kind: 'conflict' }
  /** Everything else. Map to one generic 401. */
  | { ok: false; kind: 'invalid' };

export type AuthenticatedCustomer =
  | {
      assurance: 'session';
      customerId: string;
      sessionId: string;
      authMethod: CustomerSessionAuthMethod;
      stepUpVerifiedAt: Date | null;
    }
  | { assurance: 'legacy'; customerId: string };

export type SensitiveChangeResult =
  | { ok: true }
  | { ok: false; reason: 'not_authorized' | 'step_up_required' | 'already_set' | 'no_credential' };

export class CustomerSessionService {
  private readonly clock: () => Date;

  constructor(
    private readonly db: Db,
    private readonly config: CustomerSessionServiceConfig,
  ) {
    for (const [name, value] of [
      ['accessTtlSeconds', config.accessTtlSeconds],
      ['refreshTtlSeconds', config.refreshTtlSeconds],
      ['absoluteTtlSeconds', config.absoluteTtlSeconds],
      ['idleTtlSeconds', config.idleTtlSeconds],
      ['stepUpWindowSeconds', config.stepUpWindowSeconds],
    ] as const) {
      if (!Number.isInteger(value) || value <= 0)
        throw new Error(`${name} must be a positive integer.`);
    }
    if (!config.sessionSigningSecret || !config.legacySigningSecret) {
      throw new Error('Both signing secrets are required.');
    }
    if (config.sessionSigningSecret === config.legacySigningSecret) {
      throw new Error('The session and legacy signing secrets must differ.');
    }
    this.clock = config.now ?? (() => new Date());
  }

  private async inTransaction<T>(fn: (stores: Stores) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => fn(storesFor(tx)));
  }

  private async mintAccessToken(customerId: string, sessionId: string, now: Date) {
    const accessToken = await signCustomerSessionAccessToken(
      customerId,
      sessionId,
      this.config.sessionSigningSecret,
      {
        ttlSeconds: this.config.accessTtlSeconds,
        nowSeconds: Math.floor(now.getTime() / 1000),
      },
    );
    return {
      accessToken,
      accessExpiresAt: new Date(now.getTime() + this.config.accessTtlSeconds * 1000),
    };
  }

  /** A refresh credential never outlives the session that owns it. */
  private refreshExpiry(now: Date, sessionAbsoluteExpiresAt: Date): Date {
    const candidate = new Date(now.getTime() + this.config.refreshTtlSeconds * 1000);
    return candidate.getTime() > sessionAbsoluteExpiresAt.getTime()
      ? sessionAbsoluteExpiresAt
      : candidate;
  }

  /**
   * Creates a session after the CALLER has proven account ownership (a verified
   * OTP, a password check, or a completed recovery). This method proves
   * nothing itself: it only refuses an inactive customer. A fresh step-up is
   * recorded for `otp` and `recovery` sessions, which are fresh proofs by
   * definition, and not for `password` sessions.
   */
  async establishSession(input: {
    customerId: string;
    authMethod: CustomerSessionAuthMethod;
    deviceLabel?: string | null;
    sourceHint?: string | null;
  }): Promise<EstablishSessionResult> {
    const now = this.clock();
    return this.inTransaction(async (stores) => {
      const customer = await stores.customers.findById(input.customerId);
      if (!customer || !customerMayHaveSession({ status: customer.status, isDeleted: false })) {
        return { ok: false, reason: 'customer_inactive' } as const;
      }
      const { absoluteExpiresAt, idleExpiresAt } = computeSessionExpiries(now, {
        absoluteSeconds: this.config.absoluteTtlSeconds,
        idleSeconds: this.config.idleTtlSeconds,
      });
      const session = await stores.sessions.create({
        customerId: customer.id,
        authMethod: input.authMethod,
        now,
        absoluteExpiresAt,
        idleExpiresAt,
        stepUpVerifiedAt: input.authMethod === 'password' ? null : now,
        deviceLabel: input.deviceLabel ?? null,
        sourceHint: input.sourceHint ?? null,
      });
      const refreshCredential = generateRefreshCredential();
      const refreshExpiresAt = this.refreshExpiry(now, absoluteExpiresAt);
      await stores.tokens.issue({
        sessionId: session.id,
        tokenHash: await hashRefreshCredential(refreshCredential),
        expiresAt: refreshExpiresAt,
        now,
      });
      await stores.events.append({
        customerId: customer.id,
        sessionId: session.id,
        eventType: 'session_created',
        outcome: 'success',
        metadata: { auth_method: input.authMethod },
        now,
      });
      const access = await this.mintAccessToken(customer.id, session.id, now);
      return {
        ok: true,
        session: {
          customerId: customer.id,
          sessionId: session.id,
          ...access,
          refreshCredential,
          refreshExpiresAt,
          sessionAbsoluteExpiresAt: absoluteExpiresAt,
        },
      } as const;
    });
  }

  /**
   * Rotates a refresh credential. The decision comes from the pure policy
   * (`evaluateRefresh`), then the storage guard enforces it atomically: the
   * exchange locks the owning session row first, so a racing revocation or
   * a racing second exchange can never leave a usable successor behind.
   */
  async refresh(rawCredential: string): Promise<RefreshResult> {
    if (!isWellFormedRefreshCredential(rawCredential)) return { ok: false, kind: 'invalid' };
    const now = this.clock();
    const tokenHash = await hashRefreshCredential(rawCredential);
    const stores = storesFor(this.db);

    const token = await stores.tokens.findByHash(tokenHash);
    if (!token) return this.deny(stores, 'refresh_unknown', null, null, now);
    const sessionRow = await stores.sessions.findById(token.sessionId);
    if (!sessionRow) return this.deny(stores, 'refresh_unknown', null, null, now);
    const hit = await stores.sessions.findWithCustomer(sessionRow.id, sessionRow.customerId);
    if (!hit) return this.deny(stores, 'refresh_unknown', null, null, now);

    const decision = evaluateRefresh({
      token,
      session: hit.session,
      customer: hit.customer,
      now,
      ...(this.config.refreshGraceMs !== undefined ? { graceMs: this.config.refreshGraceMs } : {}),
    });

    if (decision.kind === 'concurrent_rotation') {
      await this.bestEffortEvent(
        stores,
        hit.session,
        'session_refreshed',
        'blocked',
        'concurrent_rotation',
        now,
      );
      return { ok: false, kind: 'conflict' };
    }

    if (decision.kind === 'replay') {
      // Replay is evidence this one credential escaped. Revoke the compromised
      // session and its chain only. Other devices are not touched.
      await this.inTransaction(async (tx) => {
        const revoked = await tx.sessions.revoke({
          sessionId: hit.session.id,
          customerId: hit.session.customerId,
          reason: 'replay_detected',
          now,
        });
        if (revoked) {
          await tx.events.append({
            customerId: hit.session.customerId,
            sessionId: hit.session.id,
            eventType: 'session_replay_detected',
            outcome: 'blocked',
            reasonCode: 'refresh_replay',
            now,
          });
        }
      });
      return { ok: false, kind: 'invalid' };
    }

    if (decision.kind === 'reject') {
      if (decision.reason === 'customer_inactive') {
        // Sessions of a suspended customer are ended lazily at the next refresh.
        await stores.sessions.revoke({
          sessionId: hit.session.id,
          customerId: hit.session.customerId,
          reason: 'suspended',
          now,
        });
      }
      return this.deny(
        stores,
        `refresh_${decision.reason}`,
        hit.session.customerId,
        hit.session.id,
        now,
      );
    }

    // decision.kind === 'rotate'
    const refreshCredential = generateRefreshCredential();
    const refreshExpiresAt = this.refreshExpiry(now, hit.session.absoluteExpiresAt);
    const exchange = await stores.tokens.exchange({
      oldTokenId: token.id,
      successor: {
        tokenHash: await hashRefreshCredential(refreshCredential),
        expiresAt: refreshExpiresAt,
      },
      now,
    });
    if (!exchange.rotated) {
      // Lost a race with another exchange or with a revocation. Retryable: the
      // next attempt re-reads the real state and answers accurately.
      return { ok: false, kind: 'conflict' };
    }

    await stores.sessions.touch({
      sessionId: hit.session.id,
      customerId: hit.session.customerId,
      now,
      idleExpiresAt: nextIdleExpiry(now, this.config.idleTtlSeconds, hit.session.absoluteExpiresAt),
    });
    await this.bestEffortEvent(stores, hit.session, 'session_refreshed', 'success', null, now);
    const access = await this.mintAccessToken(hit.session.customerId, hit.session.id, now);
    return {
      ok: true,
      session: {
        customerId: hit.session.customerId,
        sessionId: hit.session.id,
        ...access,
        refreshCredential,
        refreshExpiresAt,
        sessionAbsoluteExpiresAt: hit.session.absoluteExpiresAt,
      },
    };
  }

  /**
   * Per-request check for the new session token: signature, then the database
   * proves the SESSION is live and the CUSTOMER is active in one query. The
   * token's own expiry is not enough, because revocation must take effect now.
   * Returns null on any failure.
   */
  async authenticateSessionToken(token: string): Promise<AuthenticatedCustomer | null> {
    let payload;
    try {
      payload = await verifyCustomerSessionAccessToken(token, this.config.sessionSigningSecret);
    } catch {
      return null;
    }
    const hit = await new CustomerSessionRepository(this.db).findWithCustomer(
      payload.sid,
      payload.sub,
    );
    if (!hit) return null;
    if (!customerMayHaveSession(hit.customer)) return null;
    if (!sessionLiveness(hit.session, this.clock()).live) return null;
    return {
      assurance: 'session',
      customerId: hit.session.customerId,
      sessionId: hit.session.id,
      authMethod: hit.session.authMethod,
      stepUpVerifiedAt: hit.session.stepUpVerifiedAt,
    };
  }

  /**
   * Per-request check for a LEGACY 90-day token (01C section 7). Enforces, in
   * order: the global kill switch, signature and type, that the customer is
   * active, and the per-customer cutoff. A customer who HAS a credential but
   * whose cutoff is null is a configuration gap and is denied (fail closed).
   * The result is always low assurance: it can never enroll or change a
   * password.
   */
  async authenticateLegacyToken(token: string): Promise<AuthenticatedCustomer | null> {
    if (!this.config.legacyAccepted()) return null;
    let payload;
    try {
      payload = await verifyCustomerAccessToken(token, this.config.legacySigningSecret);
    } catch {
      return null;
    }
    const customer = await new CustomerRepository(this.db).findById(payload.sub);
    if (!customer || !customerMayHaveSession({ status: customer.status, isDeleted: false }))
      return null;

    const credential = await new CustomerCredentialRepository(this.db).findLegacyTokenCutoff(
      customer.id,
    );
    if (credential && credential.legacyTokensInvalidBefore === null) return null;
    const decision = evaluateLegacyToken({
      iatSeconds: payload.iat,
      legacyAccepted: true,
      invalidBefore: credential?.legacyTokensInvalidBefore ?? null,
    });
    return decision.accept ? { assurance: 'legacy', customerId: customer.id } : null;
  }

  /** Records that a legacy token was used. For the caller to invoke sampled, never per request. */
  async recordLegacyTokenUse(customerId: string): Promise<void> {
    await new CustomerAuthEventRepository(this.db).append({
      customerId,
      eventType: 'legacy_token_used',
      outcome: 'success',
      metadata: { legacy: true },
      now: this.clock(),
    });
  }

  /** Ends one session (this device). Idempotent. Returns whether it was live. */
  async revokeSession(input: { customerId: string; sessionId: string }): Promise<boolean> {
    const now = this.clock();
    return this.inTransaction(async (tx) => {
      const revoked = await tx.sessions.revoke({
        sessionId: input.sessionId,
        customerId: input.customerId,
        reason: 'logout',
        now,
      });
      if (revoked) {
        await tx.events.append({
          customerId: input.customerId,
          sessionId: input.sessionId,
          eventType: 'session_revoked',
          outcome: 'success',
          reasonCode: 'logout',
          now,
        });
      }
      return revoked;
    });
  }

  /**
   * "Log out everywhere". One transaction: revoke every live session (keeping
   * `exceptSessionId` if given) and advance the legacy cutoff so older 90-day
   * tokens stop working too. The cutoff advance does nothing for a customer
   * with no credential row (OTP-only), which still needs its own design.
   */
  async logoutAll(input: {
    customerId: string;
    exceptSessionId?: string;
  }): Promise<{ revoked: number }> {
    const now = this.clock();
    return this.inTransaction(async (tx) => {
      const revoked = await tx.sessions.revokeAllForCustomer({
        customerId: input.customerId,
        reason: 'logout_all',
        now,
        ...(input.exceptSessionId ? { exceptSessionId: input.exceptSessionId } : {}),
      });
      await tx.credentials.advanceLegacyTokenCutoff(input.customerId, now);
      await tx.events.append({
        customerId: input.customerId,
        eventType: 'session_revoked',
        outcome: 'success',
        reasonCode: 'logout_all',
        metadata: { session_count: revoked },
        now,
      });
      return { revoked };
    });
  }

  /**
   * First password. Needs a LIVE new-model session with a FRESH step-up. A
   * legacy token has no session and cannot call this. The credential insert
   * sets the legacy cutoff in the same statement (see the credential repository).
   * `passwordHash` is produced by the caller BEFORE this call so the expensive
   * hash never runs inside a database transaction.
   */
  async enrollPassword(input: {
    customerId: string;
    sessionId: string;
    passwordHash: string;
  }): Promise<SensitiveChangeResult> {
    const now = this.clock();
    return this.inTransaction(async (tx) => {
      const gate = await this.gateSensitiveChange(tx, input.customerId, input.sessionId, now);
      if (!gate.ok) return gate;
      const created = await tx.credentials.create({
        customerId: input.customerId,
        passwordHash: input.passwordHash,
        now,
      });
      if (!created) return { ok: false, reason: 'already_set' } as const;
      await tx.events.append({
        customerId: input.customerId,
        sessionId: input.sessionId,
        eventType: 'password_set',
        outcome: 'success',
        now,
      });
      return { ok: true } as const;
    });
  }

  /**
   * Password change. Same gate as enrollment. In ONE transaction: replace the
   * hash, advance the legacy cutoff (the credential repository does both in a
   * single update) and revoke every OTHER live session (01B I6).
   */
  async changePassword(input: {
    customerId: string;
    sessionId: string;
    passwordHash: string;
  }): Promise<SensitiveChangeResult> {
    const now = this.clock();
    return this.inTransaction(async (tx) => {
      const gate = await this.gateSensitiveChange(tx, input.customerId, input.sessionId, now);
      if (!gate.ok) return gate;
      const changed = await tx.credentials.change({
        customerId: input.customerId,
        passwordHash: input.passwordHash,
        now,
      });
      if (!changed) return { ok: false, reason: 'no_credential' } as const;
      const revoked = await tx.sessions.revokeAllForCustomer({
        customerId: input.customerId,
        reason: 'password_changed',
        now,
        exceptSessionId: input.sessionId,
      });
      await tx.events.append({
        customerId: input.customerId,
        sessionId: input.sessionId,
        eventType: 'password_changed',
        outcome: 'success',
        metadata: { session_count: revoked },
        now,
      });
      return { ok: true } as const;
    });
  }

  private async gateSensitiveChange(
    tx: Stores,
    customerId: string,
    sessionId: string,
    now: Date,
  ): Promise<{ ok: true } | { ok: false; reason: 'not_authorized' | 'step_up_required' }> {
    const hit = await tx.sessions.findWithCustomer(sessionId, customerId);
    if (!hit || !customerMayHaveSession(hit.customer))
      return { ok: false, reason: 'not_authorized' };
    const decision = evaluatePasswordEnrollment(
      { kind: 'session', session: hit.session },
      now,
      this.config.stepUpWindowSeconds,
    );
    if (decision.allow) return { ok: true };
    return {
      ok: false,
      reason: decision.reason === 'step_up_required' ? 'step_up_required' : 'not_authorized',
    };
  }

  /** Records a fresh re-verification (the caller has just checked an OTP or the password). */
  async recordStepUp(input: { customerId: string; sessionId: string }): Promise<boolean> {
    const now = this.clock();
    const stores = storesFor(this.db);
    const recorded = await stores.sessions.recordStepUp({ ...input, now });
    if (recorded) {
      await stores.events.append({
        customerId: input.customerId,
        sessionId: input.sessionId,
        eventType: 'step_up_passed',
        outcome: 'success',
        now,
      });
    }
    return recorded;
  }

  /**
   * Success events are written in the same flow as the change they describe,
   * but a failed AUDIT write must not turn a completed refresh into an error
   * the client would retry. Denials are recorded best effort for the same
   * reason: availability of the auth path outranks completeness of the log.
   */
  private async bestEffortEvent(
    stores: Stores,
    session: Pick<CustomerSession, 'id' | 'customerId'>,
    eventType: 'session_refreshed',
    outcome: 'success' | 'blocked',
    reasonCode: string | null,
    now: Date,
  ): Promise<void> {
    try {
      await stores.events.append({
        customerId: session.customerId,
        sessionId: session.id,
        eventType,
        outcome,
        reasonCode,
        now,
      });
    } catch {
      /* intentionally not fatal, see the method comment */
    }
  }

  private async deny(
    stores: Stores,
    reasonCode: string,
    customerId: string | null,
    sessionId: string | null,
    now: Date,
  ): Promise<RefreshResult> {
    // An unknown credential identifies nobody. Writing a row for it would let
    // any anonymous caller grow the audit table without bound, so only denials
    // that resolved to a real customer are recorded. Volume control for the
    // anonymous case belongs to the rate limiter (01D-5).
    if (customerId !== null) {
      try {
        await stores.events.append({
          customerId,
          sessionId,
          eventType: 'session_refreshed',
          outcome: 'failure',
          reasonCode: reasonCode.slice(0, 64),
          now,
        });
      } catch {
        /* best effort, see bestEffortEvent */
      }
    }
    return { ok: false, kind: 'invalid' };
  }
}
