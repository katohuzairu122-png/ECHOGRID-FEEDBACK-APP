import { and, eq, gt, gte, lte, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import {
  b2bPartnershipEvents,
  b2bPartnershipRequestEvents,
  b2bPartnershipRequests,
  b2bPartnerships,
  b2bParticipations,
  businesses,
  b2bNotifications,
} from '../db/schema';
import { AppError } from '../lib/errors';

export const B2B_REQUESTS_PER_LOCAL_DAY = 10;
export const B2B_REQUEST_EXPIRY_DAYS = 14;
export const B2B_REJECTION_COOLDOWN_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const REASON_MAX = 1000;
const RESPONSE_NOTE_MAX = 500;

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type RequestRow = typeof b2bPartnershipRequests.$inferSelect;
type PartnershipRow = typeof b2bPartnerships.$inferSelect;
type RequestDirection = 'incoming' | 'outgoing';
type RequestOutcome = 'accepted' | 'rejected';

const conflict = (code: string, message: string) => new AppError(message, 409, code);
const forbidden = (code: string, message: string) => new AppError(message, 403, code);
const notFound = () => new AppError('Business network item not found.', 404, 'B2B_NOT_FOUND');

function normalizePair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function zonedParts(now: Date, timezone: string) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return {
      year: Number(values.year),
      month: Number(values.month),
      day: Number(values.day),
      hour: Number(values.hour),
      minute: Number(values.minute),
      second: Number(values.second),
    };
  } catch {
    throw new AppError(
      'The business timezone is invalid; request limits are unavailable.',
      503,
      'B2B_TIMEZONE_INVALID',
    );
  }
}

function localDayKey(now: Date, timezone: string): string {
  const { year, month, day } = zonedParts(now, timezone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function localDayStart(now: Date, timezone: string): Date {
  const { year, month, day } = zonedParts(now, timezone);
  const localMidnightAsUtc = Date.UTC(year, month - 1, day);
  let candidate = localMidnightAsUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const local = zonedParts(new Date(candidate), timezone);
    const candidateAsLocalUtc = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
    );
    candidate = localMidnightAsUtc - (candidateAsLocalUtc - candidate);
  }
  return new Date(candidate);
}

function rejectPersonalContact(text: string): void {
  if (
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text) ||
    /(?:\+?\d[\d().\s-]{7,}\d)/.test(text)
  ) {
    throw new AppError(
      'Do not include customer or personal contact details in Business Network content.',
      422,
      'B2B_PERSONAL_CONTACT_RESTRICTED',
    );
  }
}

async function lock(tx: Tx, key: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

async function queueNotice(
  tx: Tx,
  input: {
    businessId: string;
    key: string;
    type: string;
    subject: string;
    body: string;
    resourceType: string;
    resourceId: string;
  },
) {
  await tx
    .insert(b2bNotifications)
    .values({
      recipientBusinessId: input.businessId,
      eventKey: input.key,
      eventType: input.type,
      subject: input.subject,
      body: input.body,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
    })
    .onConflictDoNothing({ target: b2bNotifications.eventKey });
}

async function requireActiveParticipant(tx: Tx, businessId: string): Promise<string> {
  const [row] = await tx
    .select({
      status: b2bParticipations.status,
      businessStatus: businesses.status,
      deletedAt: businesses.deletedAt,
      timezone: businesses.defaultTimezone,
    })
    .from(b2bParticipations)
    .innerJoin(businesses, eq(businesses.id, b2bParticipations.businessId))
    .where(eq(b2bParticipations.businessId, businessId))
    .limit(1);
  if (!row || row.status !== 'active' || row.businessStatus !== 'active' || row.deletedAt) {
    throw forbidden(
      'B2B_PARTICIPATION_REQUIRED',
      'This business is not eligible for the business network.',
    );
  }
  return row.timezone;
}

async function expireDue(tx: Tx, businessId: string, now: Date): Promise<void> {
  const expired = await tx
    .update(b2bPartnershipRequests)
    .set({ status: 'expired', updatedAt: now })
    .where(
      and(
        eq(b2bPartnershipRequests.status, 'pending'),
        lte(b2bPartnershipRequests.expiresAt, now),
        or(
          eq(b2bPartnershipRequests.requesterBusinessId, businessId),
          eq(b2bPartnershipRequests.targetBusinessId, businessId),
        ),
      ),
    )
    .returning({ id: b2bPartnershipRequests.id });
  if (expired.length) {
    await tx.insert(b2bPartnershipRequestEvents).values(
      expired.map(({ id }) => ({
        requestId: id,
        eventType: 'expired' as const,
        actorBusinessId: null,
        actorUserId: null,
        metadata: { source: 'lazy_expiry' },
      })),
    );
    for (const item of expired) {
      const [request] = await tx
        .select()
        .from(b2bPartnershipRequests)
        .where(eq(b2bPartnershipRequests.id, item.id))
        .limit(1);
      if (request) {
        await queueNotice(tx, {
          businessId: request.requesterBusinessId,
          key: `request:${request.id}:expired:requester`,
          type: 'request_expired',
          subject: 'Partnership request expired',
          body: 'Your partnership request expired without a response.',
          resourceType: 'request',
          resourceId: request.id,
        });
        await queueNotice(tx, {
          businessId: request.targetBusinessId,
          key: `request:${request.id}:expired:recipient`,
          type: 'request_expired',
          subject: 'Partnership request expired',
          body: 'A partnership request expired.',
          resourceType: 'request',
          resourceId: request.id,
        });
      }
    }
  }
}

async function lockPair(
  tx: Tx,
  firstBusinessId: string,
  secondBusinessId: string,
): Promise<[string, string]> {
  const [a, b] = normalizePair(firstBusinessId, secondBusinessId);
  await lock(tx, `b2b:pair:${a}:${b}`);
  return [a, b];
}

export class B2bNetworkService {
  constructor(private readonly db: Database) {}

  /** Create one request at a time for a pair; the sender's daily cap is serialized in the same transaction. */
  async createRequest(input: {
    requesterBusinessId: string;
    targetBusinessId: string;
    actorUserId: string;
    idempotencyKey: string;
    reason: string;
    now?: Date;
  }): Promise<RequestRow> {
    const now = input.now ?? new Date();
    const reason = input.reason.trim();
    if (reason.length < 1 || [...reason].length > REASON_MAX) {
      throw new AppError(
        'A request reason of 1 to 1000 characters is required.',
        422,
        'B2B_REQUEST_REASON_INVALID',
      );
    }
    rejectPersonalContact(reason);
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)) {
      throw new AppError(
        'A valid Idempotency-Key is required.',
        400,
        'B2B_IDEMPOTENCY_KEY_INVALID',
      );
    }
    if (input.requesterBusinessId === input.targetBusinessId) {
      throw new AppError(
        'A business cannot request a partnership with itself.',
        422,
        'B2B_SELF_PARTNERSHIP_DENIED',
      );
    }

    try {
      return await this.db.transaction(async (tx) => {
        const requesterTimezone = await requireActiveParticipant(tx, input.requesterBusinessId);
        await requireActiveParticipant(tx, input.targetBusinessId);
        const [existingKey] = await tx
          .select()
          .from(b2bPartnershipRequests)
          .where(
            and(
              eq(b2bPartnershipRequests.requesterBusinessId, input.requesterBusinessId),
              eq(b2bPartnershipRequests.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1);
        if (existingKey) {
          if (
            existingKey.targetBusinessId !== input.targetBusinessId ||
            existingKey.reason !== reason
          ) {
            throw conflict(
              'B2B_IDEMPOTENCY_CONFLICT',
              'This Idempotency-Key was used for a different request.',
            );
          }
          return existingKey;
        }

        const [a, b] = await lockPair(tx, input.requesterBusinessId, input.targetBusinessId);
        await lock(
          tx,
          `b2b:sender-day:${input.requesterBusinessId}:${localDayKey(now, requesterTimezone)}`,
        );
        const [afterLockKey] = await tx
          .select()
          .from(b2bPartnershipRequests)
          .where(
            and(
              eq(b2bPartnershipRequests.requesterBusinessId, input.requesterBusinessId),
              eq(b2bPartnershipRequests.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1);
        if (afterLockKey) {
          if (
            afterLockKey.targetBusinessId !== input.targetBusinessId ||
            afterLockKey.reason !== reason
          ) {
            throw conflict(
              'B2B_IDEMPOTENCY_CONFLICT',
              'This Idempotency-Key was used for a different request.',
            );
          }
          return afterLockKey;
        }
        await expireDue(tx, input.requesterBusinessId, now);

        const [relationship] = await tx
          .select({ id: b2bPartnerships.id })
          .from(b2bPartnerships)
          .where(
            and(
              eq(b2bPartnerships.businessAId, a),
              eq(b2bPartnerships.businessBId, b),
              or(eq(b2bPartnerships.status, 'active'), eq(b2bPartnerships.status, 'suspended')),
            ),
          )
          .limit(1);
        if (relationship)
          throw conflict(
            'B2B_PARTNERSHIP_ALREADY_EXISTS',
            'These businesses already have an active relationship.',
          );

        const [pending] = await tx
          .select({ id: b2bPartnershipRequests.id })
          .from(b2bPartnershipRequests)
          .where(
            and(
              eq(b2bPartnershipRequests.status, 'pending'),
              or(
                and(
                  eq(b2bPartnershipRequests.requesterBusinessId, a),
                  eq(b2bPartnershipRequests.targetBusinessId, b),
                ),
                and(
                  eq(b2bPartnershipRequests.requesterBusinessId, b),
                  eq(b2bPartnershipRequests.targetBusinessId, a),
                ),
              ),
            ),
          )
          .limit(1);
        if (pending)
          throw conflict(
            'B2B_REQUEST_ALREADY_PENDING',
            'A request between these businesses is already pending.',
          );

        const [recentlyRejected] = await tx
          .select({ id: b2bPartnershipRequests.id })
          .from(b2bPartnershipRequests)
          .where(
            and(
              eq(b2bPartnershipRequests.requesterBusinessId, input.requesterBusinessId),
              eq(b2bPartnershipRequests.targetBusinessId, input.targetBusinessId),
              eq(b2bPartnershipRequests.status, 'rejected'),
              gt(
                b2bPartnershipRequests.respondedAt,
                new Date(now.getTime() - B2B_REJECTION_COOLDOWN_DAYS * DAY_MS),
              ),
            ),
          )
          .limit(1);
        if (recentlyRejected)
          throw conflict(
            'B2B_REJECTION_COOLDOWN',
            'Wait 30 days after rejection before requesting this business again.',
          );

        const [count] = await tx
          .select({ value: sql<number>`count(*)::int` })
          .from(b2bPartnershipRequests)
          .where(
            and(
              eq(b2bPartnershipRequests.requesterBusinessId, input.requesterBusinessId),
              gte(b2bPartnershipRequests.createdAt, localDayStart(now, requesterTimezone)),
            ),
          );
        if ((count?.value ?? 0) >= B2B_REQUESTS_PER_LOCAL_DAY) {
          throw conflict(
            'B2B_DAILY_REQUEST_LIMIT',
            'This business has reached its 10-request daily limit.',
          );
        }

        const [row] = await tx
          .insert(b2bPartnershipRequests)
          .values({
            requesterBusinessId: input.requesterBusinessId,
            targetBusinessId: input.targetBusinessId,
            createdByUserId: input.actorUserId,
            reason,
            idempotencyKey: input.idempotencyKey,
            expiresAt: new Date(now.getTime() + B2B_REQUEST_EXPIRY_DAYS * DAY_MS),
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!row)
          throw conflict(
            'B2B_REQUEST_CREATE_FAILED',
            'The partnership request could not be created.',
          );
        await tx.insert(b2bPartnershipRequestEvents).values({
          requestId: row.id,
          eventType: 'created',
          actorBusinessId: input.requesterBusinessId,
          actorUserId: input.actorUserId,
          metadata: { expiresAt: row.expiresAt.toISOString() },
        });
        await queueNotice(tx, {
          businessId: input.targetBusinessId,
          key: `request:${row.id}:created`,
          type: 'request_received',
          subject: 'New partnership request',
          body: 'A business requested a partnership.',
          resourceType: 'request',
          resourceId: row.id,
        });
        return row;
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      const candidate = error as { code?: string; cause?: { code?: string } };
      const code = candidate.cause?.code ?? candidate.code;
      if (code === '23505')
        throw conflict(
          'B2B_REQUEST_ALREADY_EXISTS',
          'A matching request or relationship already exists.',
        );
      throw error;
    }
  }

  async listRequests(
    businessId: string,
    direction: RequestDirection,
    page: { limit: number; offset: number },
    now = new Date(),
  ) {
    return this.db.transaction(async (tx) => {
      await requireActiveParticipant(tx, businessId);
      await expireDue(tx, businessId, now);
      const directionColumn =
        direction === 'incoming'
          ? b2bPartnershipRequests.targetBusinessId
          : b2bPartnershipRequests.requesterBusinessId;
      return tx
        .select()
        .from(b2bPartnershipRequests)
        .where(eq(directionColumn, businessId))
        .orderBy(sql`${b2bPartnershipRequests.createdAt} DESC`, b2bPartnershipRequests.id)
        .limit(page.limit)
        .offset(page.offset);
    });
  }

  async respond(input: {
    businessId: string;
    actorUserId: string;
    requestId: string;
    outcome: RequestOutcome;
    note?: string | null;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const note = input.note?.trim() || null;
    if (note && [...note].length > RESPONSE_NOTE_MAX)
      throw new AppError(
        'Response note cannot exceed 500 characters.',
        422,
        'B2B_RESPONSE_NOTE_INVALID',
      );
    if (note) rejectPersonalContact(note);
    const result = await this.db.transaction(async (tx) => {
      await requireActiveParticipant(tx, input.businessId);
      const [located] = await tx
        .select()
        .from(b2bPartnershipRequests)
        .where(eq(b2bPartnershipRequests.id, input.requestId))
        .for('update')
        .limit(1);
      if (!located || located.targetBusinessId !== input.businessId) throw notFound();
      if (located.status !== 'pending')
        throw conflict(
          'B2B_REQUEST_STATE_CONFLICT',
          'Only a pending incoming request can be answered.',
        );
      if (located.expiresAt <= now) {
        await tx
          .update(b2bPartnershipRequests)
          .set({ status: 'expired', updatedAt: now })
          .where(eq(b2bPartnershipRequests.id, located.id));
        await tx.insert(b2bPartnershipRequestEvents).values({
          requestId: located.id,
          eventType: 'expired',
          metadata: { source: 'response_after_expiry' },
        });
        await queueNotice(tx, {
          businessId: located.requesterBusinessId,
          key: `request:${located.id}:expired:requester`,
          type: 'request_expired',
          subject: 'Partnership request expired',
          body: 'Your partnership request expired without a response.',
          resourceType: 'request',
          resourceId: located.id,
        });
        await queueNotice(tx, {
          businessId: located.targetBusinessId,
          key: `request:${located.id}:expired:recipient`,
          type: 'request_expired',
          subject: 'Partnership request expired',
          body: 'A partnership request expired.',
          resourceType: 'request',
          resourceId: located.id,
        });
        return { kind: 'expired' as const };
      }
      await requireActiveParticipant(tx, located.requesterBusinessId);
      const [a, b] = await lockPair(tx, located.requesterBusinessId, located.targetBusinessId);
      const [row] = await tx
        .update(b2bPartnershipRequests)
        .set({
          status: input.outcome,
          respondedAt: now,
          respondedByUserId: input.actorUserId,
          responseNote: note,
          updatedAt: now,
        })
        .where(
          and(
            eq(b2bPartnershipRequests.id, located.id),
            eq(b2bPartnershipRequests.status, 'pending'),
          ),
        )
        .returning();
      if (!row)
        throw conflict(
          'B2B_REQUEST_STATE_CONFLICT',
          'The request changed before the response was saved.',
        );
      await tx.insert(b2bPartnershipRequestEvents).values({
        requestId: row.id,
        eventType: input.outcome,
        actorBusinessId: input.businessId,
        actorUserId: input.actorUserId,
        metadata: note ? { note } : {},
      });
      await queueNotice(tx, {
        businessId: row.requesterBusinessId,
        key: `request:${row.id}:${input.outcome}`,
        type: input.outcome === 'accepted' ? 'request_accepted' : 'request_rejected',
        subject:
          input.outcome === 'accepted'
            ? 'Partnership request accepted'
            : 'Partnership request declined',
        body:
          input.outcome === 'accepted'
            ? 'Your partnership request was accepted.'
            : 'Your partnership request was declined.',
        resourceType: 'request',
        resourceId: row.id,
      });
      let partnership: PartnershipRow | null = null;
      if (input.outcome === 'accepted') {
        const [created] = await tx
          .insert(b2bPartnerships)
          .values({
            sourceRequestId: row.id,
            businessAId: a,
            businessBId: b,
            status: 'active',
            createdAt: now,
          })
          .returning();
        if (!created)
          throw conflict(
            'B2B_PARTNERSHIP_CREATE_FAILED',
            'The partnership could not be established.',
          );
        partnership = created;
        await tx.insert(b2bPartnershipEvents).values({
          partnershipId: created.id,
          eventType: 'established',
          actorBusinessId: input.businessId,
          actorUserId: input.actorUserId,
          metadata: { requestId: row.id },
        });
        await queueNotice(tx, {
          businessId: a,
          key: `partnership:${created.id}:established:${a}`,
          type: 'partnership_established',
          subject: 'Partnership established',
          body: 'A business partnership is now active.',
          resourceType: 'partnership',
          resourceId: created.id,
        });
        await queueNotice(tx, {
          businessId: b,
          key: `partnership:${created.id}:established:${b}`,
          type: 'partnership_established',
          subject: 'Partnership established',
          body: 'A business partnership is now active.',
          resourceType: 'partnership',
          resourceId: created.id,
        });
      }
      return { kind: 'ok' as const, request: row, partnership };
    });
    if (result.kind === 'expired')
      throw conflict('B2B_REQUEST_EXPIRED', 'The request expired before it could be answered.');
    return result;
  }

  async cancel(input: { businessId: string; actorUserId: string; requestId: string; now?: Date }) {
    const now = input.now ?? new Date();
    const result = await this.db.transaction(async (tx) => {
      await requireActiveParticipant(tx, input.businessId);
      const [located] = await tx
        .select()
        .from(b2bPartnershipRequests)
        .where(eq(b2bPartnershipRequests.id, input.requestId))
        .for('update')
        .limit(1);
      if (!located || located.requesterBusinessId !== input.businessId) throw notFound();
      if (located.status !== 'pending')
        throw conflict(
          'B2B_REQUEST_STATE_CONFLICT',
          'Only your own pending request can be cancelled.',
        );
      if (located.expiresAt <= now) {
        await tx
          .update(b2bPartnershipRequests)
          .set({ status: 'expired', updatedAt: now })
          .where(eq(b2bPartnershipRequests.id, located.id));
        await tx.insert(b2bPartnershipRequestEvents).values({
          requestId: located.id,
          eventType: 'expired',
          metadata: { source: 'cancel_after_expiry' },
        });
        await queueNotice(tx, {
          businessId: located.requesterBusinessId,
          key: `request:${located.id}:expired:requester`,
          type: 'request_expired',
          subject: 'Partnership request expired',
          body: 'Your partnership request expired without a response.',
          resourceType: 'request',
          resourceId: located.id,
        });
        await queueNotice(tx, {
          businessId: located.targetBusinessId,
          key: `request:${located.id}:expired:recipient`,
          type: 'request_expired',
          subject: 'Partnership request expired',
          body: 'A partnership request expired.',
          resourceType: 'request',
          resourceId: located.id,
        });
        return { kind: 'expired' as const };
      }
      const [row] = await tx
        .update(b2bPartnershipRequests)
        .set({
          status: 'cancelled',
          cancelledAt: now,
          cancelledByUserId: input.actorUserId,
          updatedAt: now,
        })
        .where(
          and(
            eq(b2bPartnershipRequests.id, located.id),
            eq(b2bPartnershipRequests.status, 'pending'),
          ),
        )
        .returning();
      if (!row)
        throw conflict('B2B_REQUEST_STATE_CONFLICT', 'The request changed before cancellation.');
      await tx.insert(b2bPartnershipRequestEvents).values({
        requestId: row.id,
        eventType: 'cancelled',
        actorBusinessId: input.businessId,
        actorUserId: input.actorUserId,
      });
      await queueNotice(tx, {
        businessId: row.targetBusinessId,
        key: `request:${row.id}:cancelled`,
        type: 'request_cancelled',
        subject: 'Partnership request cancelled',
        body: 'A business cancelled its pending partnership request.',
        resourceType: 'request',
        resourceId: row.id,
      });
      return { kind: 'ok' as const, request: row };
    });
    if (result.kind === 'expired')
      throw conflict(
        'B2B_REQUEST_EXPIRED',
        'The request had expired and is now recorded as expired.',
      );
    return result.request;
  }

  async listPartnerships(businessId: string, page: { limit: number; offset: number }) {
    return this.db.transaction(async (tx) => {
      await requireActiveParticipant(tx, businessId);
      const rows = await tx
        .select()
        .from(b2bPartnerships)
        .where(
          and(
            or(
              eq(b2bPartnerships.businessAId, businessId),
              eq(b2bPartnerships.businessBId, businessId),
            ),
            or(eq(b2bPartnerships.status, 'active'), eq(b2bPartnerships.status, 'suspended')),
            sql`EXISTS (SELECT 1 FROM b2b_participations p JOIN businesses b ON b.id=p.business_id WHERE p.business_id=${b2bPartnerships.businessAId} AND p.status='active' AND b.status='active' AND b.deleted_at IS NULL)`,
            sql`EXISTS (SELECT 1 FROM b2b_participations p JOIN businesses b ON b.id=p.business_id WHERE p.business_id=${b2bPartnerships.businessBId} AND p.status='active' AND b.status='active' AND b.deleted_at IS NULL)`,
          ),
        )
        .orderBy(sql`${b2bPartnerships.createdAt} DESC`, b2bPartnerships.id)
        .limit(page.limit)
        .offset(page.offset);
      return rows.map((row) => ({
        ...row,
        counterpartyBusinessId: row.businessAId === businessId ? row.businessBId : row.businessAId,
      }));
    });
  }

  async terminate(input: {
    businessId: string;
    actorUserId: string;
    partnershipId: string;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    return this.db.transaction(async (tx) => {
      await requireActiveParticipant(tx, input.businessId);
      const [located] = await tx
        .select()
        .from(b2bPartnerships)
        .where(eq(b2bPartnerships.id, input.partnershipId))
        .for('update')
        .limit(1);
      if (
        !located ||
        (located.businessAId !== input.businessId && located.businessBId !== input.businessId)
      )
        throw notFound();
      if (located.status === 'terminated')
        throw conflict('B2B_PARTNERSHIP_TERMINATED', 'The partnership has already ended.');
      const [row] = await tx
        .update(b2bPartnerships)
        .set({
          status: 'terminated',
          suspendedAt: null,
          suspendedByUserId: null,
          suspensionReason: null,
          terminatedAt: now,
          terminatedByBusinessId: input.businessId,
          terminatedByUserId: input.actorUserId,
        })
        .where(
          and(
            eq(b2bPartnerships.id, located.id),
            or(eq(b2bPartnerships.status, 'active'), eq(b2bPartnerships.status, 'suspended')),
          ),
        )
        .returning();
      if (!row)
        throw conflict(
          'B2B_PARTNERSHIP_STATE_CONFLICT',
          'The partnership changed before it could be terminated.',
        );
      await tx.insert(b2bPartnershipEvents).values({
        partnershipId: row.id,
        eventType: 'terminated',
        actorBusinessId: input.businessId,
        actorUserId: input.actorUserId,
        metadata: { terminatedAt: now.toISOString() },
      });
      const recipientBusinessId =
        row.businessAId === input.businessId ? row.businessBId : row.businessAId;
      await queueNotice(tx, {
        businessId: recipientBusinessId,
        key: `partnership:${row.id}:terminated`,
        type: 'partnership_terminated',
        subject: 'Partnership terminated',
        body: 'The business partnership has ended.',
        resourceType: 'partnership',
        resourceId: row.id,
      });
      return row;
    });
  }

  async requestHistory(businessId: string, requestId: string) {
    await this.db.transaction((tx) => requireActiveParticipant(tx, businessId));
    const [request] = await this.db
      .select({
        requesterBusinessId: b2bPartnershipRequests.requesterBusinessId,
        targetBusinessId: b2bPartnershipRequests.targetBusinessId,
      })
      .from(b2bPartnershipRequests)
      .where(eq(b2bPartnershipRequests.id, requestId))
      .limit(1);
    if (
      !request ||
      (request.requesterBusinessId !== businessId && request.targetBusinessId !== businessId)
    )
      throw notFound();
    return this.db
      .select()
      .from(b2bPartnershipRequestEvents)
      .where(eq(b2bPartnershipRequestEvents.requestId, requestId))
      .orderBy(b2bPartnershipRequestEvents.createdAt, b2bPartnershipRequestEvents.id);
  }

  async partnershipHistory(businessId: string, partnershipId: string) {
    await this.db.transaction((tx) => requireActiveParticipant(tx, businessId));
    const [partnership] = await this.db
      .select({
        businessAId: b2bPartnerships.businessAId,
        businessBId: b2bPartnerships.businessBId,
      })
      .from(b2bPartnerships)
      .where(eq(b2bPartnerships.id, partnershipId))
      .limit(1);
    if (
      !partnership ||
      (partnership.businessAId !== businessId && partnership.businessBId !== businessId)
    )
      throw notFound();
    return this.db
      .select()
      .from(b2bPartnershipEvents)
      .where(eq(b2bPartnershipEvents.partnershipId, partnershipId))
      .orderBy(b2bPartnershipEvents.createdAt, b2bPartnershipEvents.id);
  }
}
