import type { CustomerActionAuthorization, Repositories } from '../repositories';
import type { CustomerActionType } from '../db/schema';
import { AppError } from '../lib/errors';

/** Sensitive actions get a short window, never a session: no authorization lives longer than this. */
export const MAX_ACTION_AUTHORIZATION_TTL_SECONDS = 15 * 60;

export interface IssueCustomerActionAuthorizationInput {
  customerId: string;
  businessId: string;
  actionType: CustomerActionType;
  correlationId: string;
  ttlSeconds: number;
  resourceType?: string;
  resourceId?: string;
  scope?: string;
  idempotencyKey?: string;
}

/**
 * `customer_action_authorizations.idempotency_key` is unique across ALL
 * customers, so a caller-supplied key is stored behind the customer's id: one
 * customer's key can then never collide with, or be answered with, another
 * customer's authorization.
 */
function scopedIdempotencyKey(customerId: string, idempotencyKey: string): string {
  return `${customerId.toLowerCase()}:${idempotencyKey}`;
}

/** Postgres returns uuids in lower case; a caller may have passed them in any case. */
const sameId = (stored: string | null, requested: string | undefined): boolean =>
  stored === (requested === undefined ? null : requested.toLowerCase());

/**
 * A replayed key resolves to the authorization it first created. That row is
 * handed back only while it still describes the same request and can still be
 * consumed; otherwise the caller has to ask again with a new key.
 */
function assertReplayMatches(
  authorization: CustomerActionAuthorization,
  input: IssueCustomerActionAuthorizationInput,
  now: Date,
): void {
  const sameRequest =
    sameId(authorization.customerId, input.customerId) &&
    sameId(authorization.businessId, input.businessId) &&
    authorization.actionType === input.actionType &&
    authorization.resourceType === (input.resourceType ?? null) &&
    sameId(authorization.resourceId, input.resourceId) &&
    authorization.scope === (input.scope ?? null);
  if (!sameRequest) {
    throw new AppError(
      'This idempotency key was already used for a different authorization request.',
      409,
      'ACTION_AUTHORIZATION_IDEMPOTENCY_CONFLICT',
    );
  }
  if (authorization.status !== 'active' || authorization.expiresAt <= now) {
    throw new AppError(
      'The authorization this idempotency key resolves to can no longer be used.',
      409,
      'ACTION_AUTHORIZATION_IDEMPOTENCY_CONFLICT',
    );
  }
}

/**
 * Short-lived, single-use authorization for a sensitive customer action,
 * issued on top of (never instead of) the customer's session.
 *
 * Issuing is idempotent per customer and key. The Split 07 settlement flows
 * write the same table through the repository directly, with keys of their own,
 * and re-check every replayed row themselves.
 */
export class CustomerActionAuthorizationService {
  constructor(private readonly repos: Pick<Repositories, 'customerActionAuthorizations'>) {}

  async issue(input: IssueCustomerActionAuthorizationInput): Promise<CustomerActionAuthorization> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000);
    // Written as one positive check so a NaN or sub-millisecond TTL is refused too.
    if (
      !(
        input.ttlSeconds > 0 &&
        input.ttlSeconds <= MAX_ACTION_AUTHORIZATION_TTL_SECONDS &&
        expiresAt > now
      )
    ) {
      throw new AppError(
        'Action authorization TTL is outside the allowed range.',
        422,
        'INVALID_AUTHORIZATION_TTL',
      );
    }

    const idempotencyKey =
      input.idempotencyKey === undefined
        ? undefined
        : scopedIdempotencyKey(input.customerId, input.idempotencyKey);
    const authorization = await this.repos.customerActionAuthorizations.create({
      customerId: input.customerId,
      businessId: input.businessId,
      actionType: input.actionType,
      correlationId: input.correlationId,
      expiresAt,
      ...(input.resourceType !== undefined ? { resourceType: input.resourceType } : {}),
      ...(input.resourceId !== undefined ? { resourceId: input.resourceId } : {}),
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    });
    if (idempotencyKey !== undefined) assertReplayMatches(authorization, input, now);
    return authorization;
  }

  async consume(id: string, customerId: string): Promise<CustomerActionAuthorization> {
    const consumed = await this.repos.customerActionAuthorizations.consume(id, customerId);
    if (!consumed) {
      throw new AppError(
        'This authorization is invalid, expired, or already used.',
        409,
        'ACTION_AUTHORIZATION_INVALID',
      );
    }
    return consumed;
  }
}
