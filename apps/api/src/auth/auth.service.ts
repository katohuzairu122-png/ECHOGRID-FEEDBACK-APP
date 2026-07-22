import type { Repositories } from '../repositories';
import type { Bindings } from '../config/env';
import { AppError } from '../lib/errors';
import { hashPassword, verifyPassword } from './password';
import { hashToken } from './token-hash';
import { constantTimeEqualHex } from './crypto-utils';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  REFRESH_TOKEN_TTL_SECONDS,
} from './jwt';

const AUTH_ERROR_STATUS = {
  EMAIL_TAKEN: 409,
  INVALID_CREDENTIALS: 401,
  INVALID_REFRESH_TOKEN: 401,
  ACCOUNT_INACTIVE: 401,
} as const;

type AuthErrorCode = keyof typeof AUTH_ERROR_STATUS;

/** Extends the shared AppError (Block 7) so auth failures flow through the
 * same global error handler as every other feature module, instead of
 * auth.routes.ts hand-mapping codes to statuses itself. Call sites are
 * unchanged from Block 5: `new AuthError(message, code)`. */
export class AuthError extends AppError {
  constructor(message: string, code: AuthErrorCode) {
    super(message, AUTH_ERROR_STATUS[code], code);
  }
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface SignupInput {
  email: string;
  password: string;
  fullName: string;
}

export interface LoginInput {
  email: string;
  password: string;
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}

/**
 * Auth business logic: signup, login, refresh, logout. Constructor-injected
 * with the repository set + the two JWT secrets, so it stays framework-
 * agnostic and unit-testable without spinning up a Hono request (Block 9).
 * Route handlers (auth.routes.ts) translate HTTP <-> these methods; they do
 * not contain business rules themselves.
 *
 * Known gaps, deferred on purpose to their owning blocks -- do not deploy
 * this publicly before they land:
 *  - No login rate limiting / brute-force protection (Block 7).
 *  - No CORS configuration, so a browser on a different origin cannot call
 *    these endpoints yet (Block 7).
 */
export class AuthService {
  constructor(
    private readonly repos: Pick<Repositories, 'users' | 'refreshTokens'>,
    private readonly secrets: Pick<Bindings, 'JWT_ACCESS_SECRET' | 'JWT_REFRESH_SECRET'>,
  ) {}

  async signup(input: SignupInput): Promise<AuthTokens> {
    const existing = await this.repos.users.findByEmail(input.email);
    if (existing) {
      throw new AuthError('An account with this email already exists.', 'EMAIL_TAKEN');
    }

    const passwordHash = await hashPassword(input.password);
    const user = await this.repos.users.create({
      email: input.email,
      passwordHash,
      fullName: input.fullName,
      status: 'active',
    });

    return this.issueTokens(user.id);
  }

  async login(input: LoginInput): Promise<AuthTokens> {
    const user = await this.repos.users.findByEmail(input.email);
    // Same error for "no such user" and "wrong password" -- distinguishing
    // them would let an attacker enumerate valid emails.
    if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
      throw new AuthError('Invalid email or password.', 'INVALID_CREDENTIALS');
    }
    // Unlike the above, an inactive account gets its own message: for a
    // dashboard product the support-cost of a confusing generic error
    // outweighs the small information-disclosure risk of confirming the
    // credentials were correct.
    if (user.status !== 'active') {
      throw new AuthError('This account is not active.', 'ACCOUNT_INACTIVE');
    }

    await this.repos.users.touchLastLogin(user.id);
    return this.issueTokens(user.id, input.userAgent, input.ipAddress);
  }

  /**
   * Verifies + rotates a refresh token: the old DB row is marked revoked
   * (chained via replacedByTokenId) and a new pair is issued. Rejects if the
   * token is unknown, expired, or already revoked -- the last case is what
   * catches a stolen-and-replayed refresh token.
   */
  async refresh(rawRefreshToken: string): Promise<AuthTokens> {
    const payload = await this.verifyRefreshTokenOrThrow(rawRefreshToken);
    const stored = await this.repos.refreshTokens.findById(payload.jti);

    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new AuthError('Refresh token is invalid or expired.', 'INVALID_REFRESH_TOKEN');
    }
    const incomingHash = await hashToken(rawRefreshToken);
    if (!constantTimeEqualHex(incomingHash, stored.tokenHash)) {
      throw new AuthError('Refresh token is invalid or expired.', 'INVALID_REFRESH_TOKEN');
    }

    // Re-check account status on every rotation (mirrors requirePlatformRole's
    // fresh per-request status check) -- without this, deactivating a user
    // only blocks new logins; a session already in hand keeps renewing itself
    // for the full 30-day refresh-token lifetime instead of stopping at the
    // next access-token expiry (<=15 min).
    const user = await this.repos.users.findById(stored.userId);
    if (!user || user.status !== 'active') {
      throw new AuthError('This account is not active.', 'ACCOUNT_INACTIVE');
    }

    const next = await this.issueTokens(
      stored.userId,
      stored.userAgent ?? undefined,
      stored.ipAddress ?? undefined,
    );
    await this.repos.refreshTokens.rotate(stored.id, next.refreshTokenId);
    return next;
  }

  /** Idempotent: an already-invalid token is treated as "already logged out"
   * rather than an error. */
  async logout(rawRefreshToken: string): Promise<void> {
    const payload = await this.verifyRefreshTokenOrThrow(rawRefreshToken).catch(() => null);
    if (!payload) return;
    await this.repos.refreshTokens.revoke(payload.jti);
  }

  private async verifyRefreshTokenOrThrow(rawRefreshToken: string) {
    try {
      return await verifyRefreshToken(rawRefreshToken, this.secrets.JWT_REFRESH_SECRET);
    } catch {
      throw new AuthError('Refresh token is invalid or expired.', 'INVALID_REFRESH_TOKEN');
    }
  }

  private async issueTokens(
    userId: string,
    userAgent?: string,
    ipAddress?: string,
  ): Promise<AuthTokens & { refreshTokenId: string }> {
    const accessToken = await signAccessToken(userId, this.secrets.JWT_ACCESS_SECRET);

    // Pre-generate the row id so it can be embedded as the refresh token's
    // jti claim before the row exists, avoiding a create-then-update dance.
    const tokenId = crypto.randomUUID();
    const { token: refreshToken, expiresAt } = await signRefreshToken(
      userId,
      tokenId,
      this.secrets.JWT_REFRESH_SECRET,
    );

    await this.repos.refreshTokens.create({
      id: tokenId,
      userId,
      tokenHash: await hashToken(refreshToken),
      expiresAt,
      userAgent,
      ipAddress,
    });

    return { accessToken, refreshToken, refreshTokenId: tokenId };
  }
}

// Re-exported so callers don't need a second import just for the TTL.
export { REFRESH_TOKEN_TTL_SECONDS };
