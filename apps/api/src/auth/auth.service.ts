import type { Repositories } from '../repositories';
import type { Bindings } from '../config/env';
import { AppError } from '../lib/errors';
import { PASSWORD_ITERATIONS } from './password';
import type { Pbkdf2Worker } from './pbkdf2-worker';
import { hashToken } from './token-hash';
import { constantTimeEqualHex } from './crypto-utils';
import type { EmailService } from '../notifications/email.service';
import { renderPasswordResetEmail, renderPasswordChangedEmail } from './auth-emails';
import { generateResetToken, resetTokenExpiresAt, buildResetLink } from './password-reset';
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
  /** 400, not 401: the caller is not failing to authenticate, they are
   * presenting a token that is expired, already used, or unknown. A 401
   * would invite clients to retry with credentials, which is not the fix. */
  INVALID_RESET_TOKEN: 400,
  USER_NOT_FOUND: 404,
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

export interface RequestPasswordResetInput {
  email: string;
  ipAddress?: string | undefined;
}

export interface ResetPasswordInput {
  token: string;
  newPassword: string;
}

export interface ChangePasswordInput {
  userId: string;
  currentPassword: string;
  newPassword: string;
}

/**
 * Collaborators the password-reset flow needs that the original four auth
 * methods did not. Grouped into one optional constructor argument rather
 * than appended as three positional parameters, so existing AuthService
 * construction sites (auth.service.test.ts's fakes, notably) keep compiling
 * unchanged, and so a service built without them fails loudly at the one
 * call that needs them instead of silently no-opping.
 */
export interface PasswordResetDeps {
  email: EmailService;
  /** Public origin of apps/web, e.g. "https://echo-grid.uk" -- used to build
   * the link in the reset email. See password-reset.ts's buildResetLink. */
  webBaseUrl: string;
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
    private readonly repos: Pick<
      Repositories,
      'users' | 'refreshTokens' | 'passwordResetTokens'
    >,
    private readonly secrets: Pick<Bindings, 'JWT_ACCESS_SECRET' | 'JWT_REFRESH_SECRET'>,
    private readonly hasher: Pbkdf2Worker,
    private readonly passwordReset?: PasswordResetDeps,
  ) {}

  async signup(input: SignupInput): Promise<AuthTokens> {
    const existing = await this.repos.users.findByEmail(input.email);
    if (existing) {
      throw new AuthError('An account with this email already exists.', 'EMAIL_TAKEN');
    }

    const passwordHash = await this.hasher.hash(input.password, PASSWORD_ITERATIONS);
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
    if (!user || !(await this.hasher.verify(input.password, user.passwordHash))) {
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

  /**
   * Step 1 of recovery: issue a reset token and email it.
   *
   * Returns void and NEVER signals whether the email matched an account.
   * `/auth/password-reset/request` is unauthenticated and public, so a
   * distinguishable response (or even a reliably different latency) turns it
   * into an account-enumeration oracle -- the exact leak `login()` above
   * already guards against by returning one error for both "no such user"
   * and "wrong password". The route layer therefore always answers 202.
   *
   * Deactivated accounts are treated the same as missing ones: silently no
   * email. Letting a suspended user restore access via the recovery flow
   * would route around the deactivation entirely.
   *
   * Any outstanding token for the user is invalidated first, so requesting a
   * second link immediately kills the first -- a user who requests twice
   * (common when the first email is slow) should not leave two live account-
   * takeover credentials sitting in an inbox.
   */
  async requestPasswordReset(input: RequestPasswordResetInput): Promise<void> {
    const deps = this.requirePasswordResetDeps();
    const user = await this.repos.users.findByEmail(input.email);

    // Silent no-op, deliberately -- see the enumeration note above. This is
    // the one place in this service where "not found" is not an error.
    if (!user || user.status !== 'active') return;

    await this.repos.passwordResetTokens.invalidateAllForUser(user.id);

    const rawToken = generateResetToken();
    await this.repos.passwordResetTokens.create({
      userId: user.id,
      // SHA-256, not PBKDF2 -- the token is 256 bits of entropy, so there is
      // no offline dictionary attack to slow down. Same reasoning as
      // refresh-token storage; see token-hash.ts.
      tokenHash: await hashToken(rawToken),
      expiresAt: resetTokenExpiresAt(),
      requestedIp: input.ipAddress ?? null,
    });

    const { subject, html } = renderPasswordResetEmail(
      user.fullName,
      buildResetLink(deps.webBaseUrl, rawToken),
    );
    // Awaited, not fire-and-forget: a delivery failure must surface as a 5xx
    // so the user retries, rather than a cheerful 202 followed by an email
    // that never arrives and a support ticket nobody can diagnose. The token
    // row is left in place on failure -- it simply expires unused.
    await deps.email.send({ to: user.email, subject, html });
  }

  /**
   * Step 2 of recovery: redeem a token and set a new password.
   *
   * Every failure mode returns the same INVALID_RESET_TOKEN error on
   * purpose. Distinguishing "expired" from "already used" from "never
   * existed" would tell an attacker holding a stolen link whether it is
   * worth pursuing, and the user's next action is identical in all three
   * cases: request a new link.
   */
  async resetPassword(input: ResetPasswordInput): Promise<void> {
    const deps = this.requirePasswordResetDeps();
    const tokenHash = await hashToken(input.token);
    const stored = await this.repos.passwordResetTokens.findByTokenHash(tokenHash);

    if (
      !stored ||
      stored.consumedAt ||
      stored.invalidatedAt ||
      stored.expiresAt < new Date()
    ) {
      throw new AuthError('This reset link is invalid or has expired.', 'INVALID_RESET_TOKEN');
    }

    // Re-check the account at redemption time, not just at request time: an
    // account deactivated during the token's 60-minute life must not be
    // recoverable with a link issued while it was still active.
    const user = await this.repos.users.findById(stored.userId);
    if (!user || user.status !== 'active') {
      throw new AuthError('This account is not active.', 'ACCOUNT_INACTIVE');
    }

    // Consume BEFORE writing the new password, and honour the guarded
    // update's result. Two concurrent redemptions of one link both pass the
    // reads above; only the one that wins this atomic
    // `WHERE consumed_at IS NULL` proceeds. Doing this after the password
    // write would let both set a password, and the loser's value would win
    // by arriving second.
    if (!(await this.repos.passwordResetTokens.consume(stored.id))) {
      throw new AuthError('This reset link is invalid or has expired.', 'INVALID_RESET_TOKEN');
    }

    await this.applyNewPassword(user.id, input.newPassword);
    await this.afterPasswordChanged(user.id, user.fullName, user.email, deps.email);
  }

  /**
   * Authenticated password change. Requires the current password even though
   * the caller already holds a valid access token: a token in an unlocked,
   * unattended browser should not be enough to lock the real owner out of
   * their own account.
   */
  async changePassword(input: ChangePasswordInput): Promise<void> {
    const deps = this.requirePasswordResetDeps();
    const user = await this.repos.users.findById(input.userId);
    if (!user) {
      throw new AuthError('User not found.', 'USER_NOT_FOUND');
    }
    if (!(await this.hasher.verify(input.currentPassword, user.passwordHash))) {
      // Same code as a failed login -- from the caller's perspective this is
      // exactly that: a password check that did not pass.
      throw new AuthError('Current password is incorrect.', 'INVALID_CREDENTIALS');
    }
    if (user.status !== 'active') {
      throw new AuthError('This account is not active.', 'ACCOUNT_INACTIVE');
    }

    await this.applyNewPassword(user.id, input.newPassword);
    await this.afterPasswordChanged(user.id, user.fullName, user.email, deps.email);
  }

  private async applyNewPassword(userId: string, newPassword: string): Promise<void> {
    const passwordHash = await this.hasher.hash(newPassword, PASSWORD_ITERATIONS);
    // updatedBy is the user themselves in both flows -- a reset is
    // self-service, not an administrative action on someone else's account.
    await this.repos.users.update(userId, { passwordHash }, userId);
  }

  /**
   * Shared aftermath of any successful password change, via either route.
   *
   * Revoking every session is the point: without it, an attacker who already
   * has a refresh token keeps renewing access for up to 30 days after the
   * victim "fixed" their account, and the reset accomplishes nothing.
   *
   * The confirmation email is best-effort -- a Resend outage must not undo a
   * password the user has already successfully changed, which is why this
   * swallows a send failure while the reset email in
   * requestPasswordReset() deliberately does not. Different failure
   * semantics for different stakes: there, no email means no recovery; here,
   * the recovery already succeeded.
   */
  private async afterPasswordChanged(
    userId: string,
    fullName: string,
    email: string,
    emailService: EmailService,
  ): Promise<void> {
    await this.repos.passwordResetTokens.invalidateAllForUser(userId);
    await this.repos.refreshTokens.revokeAllForUser(userId);

    const { subject, html } = renderPasswordChangedEmail(fullName);
    try {
      await emailService.send({ to: email, subject, html });
    } catch {
      // Intentionally swallowed -- see above. Not logged with the address,
      // matching ResendEmailService's own caution about echoing recipients.
      console.error('Password-changed confirmation email failed to send.');
    }
  }

  /** Fails loudly when the reset collaborators were not supplied, rather
   * than letting a misconfigured service silently skip sending mail. */
  private requirePasswordResetDeps(): PasswordResetDeps {
    if (!this.passwordReset) {
      throw new Error('AuthService was constructed without password-reset dependencies.');
    }
    return this.passwordReset;
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
