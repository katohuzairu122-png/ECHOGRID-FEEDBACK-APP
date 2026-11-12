import { desc, eq, lt } from 'drizzle-orm';
import {
  customerAuthEvents,
  type CustomerAuthEventOutcome,
  type CustomerAuthEventType,
} from '../db/schema';
import { BaseRepository } from './base.repository';

export type CustomerAuthEvent = typeof customerAuthEvents.$inferSelect;

/**
 * The only keys an event's `metadata` may carry (01B section 5.4). Closed on
 * purpose: a token, code, password, phone or user agent cannot be logged by
 * accident because there is no key for it. Add a key only with a reviewed
 * change.
 */
export const CUSTOMER_AUTH_EVENT_METADATA_KEYS = [
  'auth_method',
  'attempt',
  'session_count',
  'legacy',
  'state',
  'surface',
] as const;

const ALLOWED_KEYS: ReadonlySet<string> = new Set(CUSTOMER_AUTH_EVENT_METADATA_KEYS);
const MAX_VALUE_LENGTH = 64;

export type CustomerAuthEventMetadata = Partial<
  Record<(typeof CUSTOMER_AUTH_EVENT_METADATA_KEYS)[number], string | number | boolean | undefined>
>;

export type NewCustomerAuthEvent = {
  customerId?: string | null;
  sessionId?: string | null;
  eventType: CustomerAuthEventType;
  outcome: CustomerAuthEventOutcome;
  reasonCode?: string | null;
  subjectKey?: string | null;
  sourceHint?: string | null;
  metadata?: CustomerAuthEventMetadata;
  now?: Date;
};

/** Throws on any key outside the allow-list or any non-primitive or oversized value. */
export function sanitizeEventMetadata(
  metadata: CustomerAuthEventMetadata | undefined,
): Record<string, string | number | boolean> | null {
  if (!metadata) return null;
  const clean: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) continue;
    if (!ALLOWED_KEYS.has(key))
      throw new Error(`Customer auth event metadata key not allowed: ${key}`);
    if (typeof value === 'string') {
      if (value.length > MAX_VALUE_LENGTH)
        throw new Error(`Customer auth event metadata value too long: ${key}`);
    } else if (typeof value !== 'number' && typeof value !== 'boolean') {
      throw new Error(`Customer auth event metadata value must be a primitive: ${key}`);
    }
    clean[key] = value;
  }
  return Object.keys(clean).length > 0 ? clean : null;
}

/**
 * CUSTOMER-AUTH-01B section 5.4. Append-only (invariant I9): there is no update
 * and no delete-by-id here, only `append`, reads, and the retention purge.
 * Not wired to any route yet (01D-2).
 */
export class CustomerAuthEventRepository extends BaseRepository {
  async append(input: NewCustomerAuthEvent): Promise<void> {
    await this.db.insert(customerAuthEvents).values({
      customerId: input.customerId ?? null,
      sessionId: input.sessionId ?? null,
      eventType: input.eventType,
      outcome: input.outcome,
      reasonCode: input.reasonCode ?? null,
      subjectKey: input.subjectKey ?? null,
      sourceHint: input.sourceHint ?? null,
      metadata: sanitizeEventMetadata(input.metadata),
      ...(input.now ? { createdAt: input.now } : {}),
    });
  }

  async listForCustomer(customerId: string, limit = 50): Promise<CustomerAuthEvent[]> {
    return this.db
      .select()
      .from(customerAuthEvents)
      .where(eq(customerAuthEvents.customerId, customerId))
      .orderBy(desc(customerAuthEvents.createdAt))
      .limit(Math.min(Math.max(limit, 1), 200));
  }

  /** Retention purge (decision D-B2 sets the period). The only delete path. */
  async deleteCreatedBefore(cutoff: Date): Promise<number> {
    const rows = await this.db
      .delete(customerAuthEvents)
      .where(lt(customerAuthEvents.createdAt, cutoff))
      .returning({ id: customerAuthEvents.id });
    return rows.length;
  }
}
