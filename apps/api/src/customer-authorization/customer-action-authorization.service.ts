import type { Repositories } from '../repositories';
import type { CustomerActionType } from '../db/schema';
import { AppError } from '../lib/errors';

export class CustomerActionAuthorizationService {
  constructor(private readonly repos: Pick<Repositories, 'customerActionAuthorizations'>) {}

  async issue(input: {
    customerId: string;
    businessId: string;
    actionType: CustomerActionType;
    correlationId: string;
    ttlSeconds: number;
    resourceType?: string;
    resourceId?: string;
    scope?: string;
    idempotencyKey?: string;
  }) {
    if (input.ttlSeconds <= 0 || input.ttlSeconds > 15 * 60) {
      throw new AppError('Action authorization TTL is outside the allowed range.', 422, 'INVALID_AUTHORIZATION_TTL');
    }
    return this.repos.customerActionAuthorizations.create({
      customerId: input.customerId,
      businessId: input.businessId,
      actionType: input.actionType,
      correlationId: input.correlationId,
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000),
      ...(input.resourceType !== undefined ? { resourceType: input.resourceType } : {}),
      ...(input.resourceId !== undefined ? { resourceId: input.resourceId } : {}),
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    });
  }

  async consume(id: string, customerId: string) {
    const consumed = await this.repos.customerActionAuthorizations.consume(id, customerId);
    if (!consumed) {
      throw new AppError('This authorization is invalid, expired, or already used.', 409, 'ACTION_AUTHORIZATION_INVALID');
    }
    return consumed;
  }
}
