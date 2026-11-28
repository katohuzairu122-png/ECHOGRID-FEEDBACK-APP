import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import {
  b2bAbuseReports,
  b2bMessages,
  b2bMessageReads,
  b2bModerationActions,
  b2bNotificationReads,
  b2bNotifications,
  b2bPartnerships,
  b2bPartnershipRequests,
  b2bProposalEvents,
  b2bProposals,
  b2bParticipations,
  businessPublicProfiles,
  businesses,
} from '../db/schema';
import { AppError } from '../lib/errors';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
const missing = () => new AppError('Business network item not found.', 404, 'B2B_NOT_FOUND');
const denied = () =>
  new AppError(
    'This action is not available for this business relationship.',
    403,
    'B2B_ACCESS_DENIED',
  );
const conflict = (code: string, message: string) => new AppError(message, 409, code);

function rejectCustomerContact(text: string): void {
  const email = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text);
  const phone = /(?:\+?\d[\d().\s-]{7,}\d)/.test(text);
  if (email || phone)
    throw new AppError(
      'Do not include customer or personal contact details in Business Network content.',
      422,
      'B2B_PERSONAL_CONTACT_RESTRICTED',
    );
}

async function activePartnership(tx: Tx, businessId: string, partnershipId: string) {
  const [row] = await tx
    .select()
    .from(b2bPartnerships)
    .where(
      and(
        eq(b2bPartnerships.id, partnershipId),
        eq(b2bPartnerships.status, 'active'),
        or(
          eq(b2bPartnerships.businessAId, businessId),
          eq(b2bPartnerships.businessBId, businessId),
        ),
      ),
    )
    .for('update')
    .limit(1);
  if (!row) throw missing();
  const eligible = await tx
    .select({ id: b2bParticipations.id })
    .from(b2bParticipations)
    .innerJoin(businesses, eq(businesses.id, b2bParticipations.businessId))
    .where(
      and(
        or(
          eq(b2bParticipations.businessId, row.businessAId),
          eq(b2bParticipations.businessId, row.businessBId),
        ),
        eq(b2bParticipations.status, 'active'),
        eq(businesses.status, 'active'),
        isNull(businesses.deletedAt),
      ),
    );
  if (eligible.length !== 2) throw denied();
  return row;
}

async function requireActiveBusiness(tx: Tx, businessId: string) {
  const [row] = await tx
    .select({ id: b2bParticipations.id })
    .from(b2bParticipations)
    .innerJoin(businesses, eq(businesses.id, b2bParticipations.businessId))
    .where(
      and(
        eq(b2bParticipations.businessId, businessId),
        eq(b2bParticipations.status, 'active'),
        eq(businesses.status, 'active'),
        isNull(businesses.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw denied();
}

async function notify(
  tx: Tx,
  input: {
    businessId: string;
    key: string;
    type: string;
    title: string;
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
      subject: input.title,
      body: input.body,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
    })
    .onConflictDoNothing({ target: b2bNotifications.eventKey });
}

export class B2bActivitiesService {
  constructor(private readonly db: Database) {}

  async sendMessage(input: {
    businessId: string;
    userId: string;
    partnershipId: string;
    body: string;
  }) {
    const body = input.body.trim();
    if (!body || [...body].length > 4000)
      throw new AppError('Message must be 1 to 4000 characters.', 422, 'B2B_MESSAGE_INVALID');
    rejectCustomerContact(body);
    return this.db.transaction(async (tx) => {
      const relationship = await activePartnership(tx, input.businessId, input.partnershipId);
      const [row] = await tx
        .insert(b2bMessages)
        .values({
          partnershipId: relationship.id,
          senderBusinessId: input.businessId,
          senderUserId: input.userId,
          body,
        })
        .returning();
      if (!row) throw conflict('B2B_MESSAGE_CREATE_FAILED', 'The message could not be sent.');
      const recipientBusinessId =
        relationship.businessAId === input.businessId
          ? relationship.businessBId
          : relationship.businessAId;
      await notify(tx, {
        businessId: recipientBusinessId,
        key: `message:${row.id}`,
        type: 'message_received',
        title: 'New partnership message',
        body: 'A partner business sent a message.',
        resourceType: 'message',
        resourceId: row.id,
      });
      return row;
    });
  }

  async listMessages(input: {
    businessId: string;
    userId: string;
    partnershipId: string;
    limit: number;
    before?: string;
  }) {
    return this.db.transaction(async (tx) => {
      await activePartnership(tx, input.businessId, input.partnershipId);
      const conditions = [eq(b2bMessages.partnershipId, input.partnershipId)];
      if (input.before)
        conditions.push(sql`${b2bMessages.createdAt} < ${input.before}::timestamptz` as never);
      const rows = await tx
        .select()
        .from(b2bMessages)
        .where(and(...conditions))
        .orderBy(desc(b2bMessages.createdAt), desc(b2bMessages.id))
        .limit(input.limit);
      if (rows.length)
        await tx
          .insert(b2bMessageReads)
          .values(
            rows.map((row) => ({
              messageId: row.id,
              partnershipId: row.partnershipId,
              businessId: input.businessId,
              userId: input.userId,
            })),
          )
          .onConflictDoNothing();
      return rows;
    });
  }

  async unreadMessageCounts(businessId: string, userId: string) {
    await this.db.transaction((tx) => requireActiveBusiness(tx, businessId));
    return this.db
      .select({ partnershipId: b2bMessages.partnershipId, count: sql<number>`count(*)::int` })
      .from(b2bMessages)
      .innerJoin(b2bPartnerships, eq(b2bPartnerships.id, b2bMessages.partnershipId))
      .leftJoin(
        b2bMessageReads,
        and(eq(b2bMessageReads.messageId, b2bMessages.id), eq(b2bMessageReads.userId, userId)),
      )
      .where(
        and(
          or(
            eq(b2bPartnerships.businessAId, businessId),
            eq(b2bPartnerships.businessBId, businessId),
          ),
          eq(b2bPartnerships.status, 'active'),
          isNull(b2bMessageReads.messageId),
          sql`${b2bMessages.senderBusinessId} <> ${businessId}`,
        ),
      )
      .groupBy(b2bMessages.partnershipId);
  }

  async createProposal(input: {
    businessId: string;
    userId: string;
    partnershipId: string;
    title: string;
    description: string;
  }) {
    const title = input.title.trim();
    const description = input.description.trim();
    if (!title || title.length > 120 || !description || description.length > 2000)
      throw new AppError('Proposal title or description is invalid.', 422, 'B2B_PROPOSAL_INVALID');
    rejectCustomerContact(`${title}\n${description}`);
    if (/(?:[$€£]|\b(?:USD|KWD|KD|EUR|GBP)\s*\d|\d\s*(?:USD|KWD|KD|EUR|GBP)\b)/i.test(description))
      throw new AppError(
        'Collaboration proposals cannot include prices or financial commitments.',
        422,
        'B2B_PROPOSAL_FINANCIAL_COMMITMENT_RESTRICTED',
      );
    return this.db.transaction(async (tx) => {
      const relationship = await activePartnership(tx, input.businessId, input.partnershipId);
      const [row] = await tx
        .insert(b2bProposals)
        .values({
          partnershipId: relationship.id,
          proposerBusinessId: input.businessId,
          createdByUserId: input.userId,
          title,
          description,
        })
        .returning();
      if (!row) throw conflict('B2B_PROPOSAL_CREATE_FAILED', 'The proposal could not be created.');
      await tx.insert(b2bProposalEvents).values({
        proposalId: row.id,
        eventType: 'created',
        actorBusinessId: input.businessId,
        actorUserId: input.userId,
      });
      const recipientBusinessId =
        relationship.businessAId === input.businessId
          ? relationship.businessBId
          : relationship.businessAId;
      await notify(tx, {
        businessId: recipientBusinessId,
        key: `proposal:${row.id}:created`,
        type: 'proposal_received',
        title: 'New collaboration proposal',
        body: 'A partner business shared a non-binding collaboration proposal.',
        resourceType: 'proposal',
        resourceId: row.id,
      });
      return row;
    });
  }

  async respondProposal(input: {
    businessId: string;
    userId: string;
    proposalId: string;
    outcome: 'accepted' | 'declined';
  }) {
    return this.db.transaction(async (tx) => {
      const [proposal] = await tx
        .select()
        .from(b2bProposals)
        .where(eq(b2bProposals.id, input.proposalId))
        .for('update')
        .limit(1);
      if (!proposal) throw missing();
      const relationship = await activePartnership(tx, input.businessId, proposal.partnershipId);
      if (proposal.proposerBusinessId === input.businessId) throw denied();
      if (proposal.status !== 'pending')
        throw conflict('B2B_PROPOSAL_STATE_CONFLICT', 'Only a pending proposal can be answered.');
      const [updated] = await tx
        .update(b2bProposals)
        .set({
          status: input.outcome,
          respondedByUserId: input.userId,
          respondedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(b2bProposals.id, proposal.id), eq(b2bProposals.status, 'pending')))
        .returning();
      if (!updated)
        throw conflict(
          'B2B_PROPOSAL_STATE_CONFLICT',
          'The proposal changed before the response was saved.',
        );
      await tx.insert(b2bProposalEvents).values({
        proposalId: proposal.id,
        eventType: input.outcome,
        actorBusinessId: input.businessId,
        actorUserId: input.userId,
      });
      await notify(tx, {
        businessId: proposal.proposerBusinessId,
        key: `proposal:${proposal.id}:${input.outcome}`,
        type: 'proposal_responded',
        title: 'Collaboration proposal updated',
        body: `A partner business ${input.outcome} a non-binding proposal.`,
        resourceType: 'proposal',
        resourceId: proposal.id,
      });
      void relationship;
      return updated;
    });
  }

  async withdrawProposal(input: { businessId: string; userId: string; proposalId: string }) {
    return this.db.transaction(async (tx) => {
      const [proposal] = await tx
        .select()
        .from(b2bProposals)
        .where(
          and(
            eq(b2bProposals.id, input.proposalId),
            eq(b2bProposals.proposerBusinessId, input.businessId),
          ),
        )
        .for('update')
        .limit(1);
      if (!proposal) throw missing();
      const relationship = await activePartnership(tx, input.businessId, proposal.partnershipId);
      if (proposal.status !== 'pending')
        throw conflict(
          'B2B_PROPOSAL_STATE_CONFLICT',
          'Only your own pending proposal can be withdrawn.',
        );
      const now = new Date();
      const [updated] = await tx
        .update(b2bProposals)
        .set({ status: 'withdrawn', withdrawnAt: now, updatedAt: now })
        .where(and(eq(b2bProposals.id, proposal.id), eq(b2bProposals.status, 'pending')))
        .returning();
      if (!updated)
        throw conflict('B2B_PROPOSAL_STATE_CONFLICT', 'The proposal changed before withdrawal.');
      await tx.insert(b2bProposalEvents).values({
        proposalId: proposal.id,
        eventType: 'withdrawn',
        actorBusinessId: input.businessId,
        actorUserId: input.userId,
      });
      const recipient =
        relationship.businessAId === input.businessId
          ? relationship.businessBId
          : relationship.businessAId;
      await notify(tx, {
        businessId: recipient,
        key: `proposal:${proposal.id}:withdrawn`,
        type: 'proposal_responded',
        title: 'Collaboration proposal withdrawn',
        body: 'A partner business withdrew a proposal.',
        resourceType: 'proposal',
        resourceId: proposal.id,
      });
      return updated;
    });
  }

  async listProposals(businessId: string, partnershipId: string) {
    return this.db.transaction(async (tx) => {
      await activePartnership(tx, businessId, partnershipId);
      return tx
        .select()
        .from(b2bProposals)
        .where(eq(b2bProposals.partnershipId, partnershipId))
        .orderBy(desc(b2bProposals.createdAt), desc(b2bProposals.id));
    });
  }

  async report(input: {
    businessId: string;
    userId: string;
    targetBusinessId: string;
    resourceType: string;
    resourceId: string;
    reasonCode: string;
    details?: string | null;
  }) {
    if (input.businessId === input.targetBusinessId) throw denied();
    await this.db.transaction(async (tx) => {
      await requireActiveBusiness(tx, input.businessId);
      let exists = false;
      if (input.resourceType === 'business') {
        const [row] = await tx
          .select({ id: businessPublicProfiles.businessId })
          .from(businessPublicProfiles)
          .where(
            and(
              eq(businessPublicProfiles.businessId, input.targetBusinessId),
              eq(businessPublicProfiles.publicationState, 'published'),
            ),
          )
          .limit(1);
        exists = !!row;
      } else if (input.resourceType === 'request') {
        const pair = or(
          and(
            eq(b2bPartnershipRequests.requesterBusinessId, input.businessId),
            eq(b2bPartnershipRequests.targetBusinessId, input.targetBusinessId),
          ),
          and(
            eq(b2bPartnershipRequests.requesterBusinessId, input.targetBusinessId),
            eq(b2bPartnershipRequests.targetBusinessId, input.businessId),
          ),
        );
        const [row] = await tx
          .select({ id: b2bPartnershipRequests.id })
          .from(b2bPartnershipRequests)
          .where(and(eq(b2bPartnershipRequests.id, input.resourceId), pair))
          .limit(1);
        exists = !!row;
      } else if (input.resourceType === 'partnership') {
        const pair = or(
          and(
            eq(b2bPartnerships.businessAId, input.businessId),
            eq(b2bPartnerships.businessBId, input.targetBusinessId),
          ),
          and(
            eq(b2bPartnerships.businessAId, input.targetBusinessId),
            eq(b2bPartnerships.businessBId, input.businessId),
          ),
        );
        const [row] = await tx
          .select({ id: b2bPartnerships.id })
          .from(b2bPartnerships)
          .where(and(eq(b2bPartnerships.id, input.resourceId), pair))
          .limit(1);
        exists = !!row;
      } else if (input.resourceType === 'message') {
        const pair = or(
          and(
            eq(b2bPartnerships.businessAId, input.businessId),
            eq(b2bPartnerships.businessBId, input.targetBusinessId),
          ),
          and(
            eq(b2bPartnerships.businessAId, input.targetBusinessId),
            eq(b2bPartnerships.businessBId, input.businessId),
          ),
        );
        const [row] = await tx
          .select({ id: b2bMessages.id })
          .from(b2bMessages)
          .innerJoin(b2bPartnerships, eq(b2bPartnerships.id, b2bMessages.partnershipId))
          .where(and(eq(b2bMessages.id, input.resourceId), pair))
          .limit(1);
        exists = !!row;
      } else if (input.resourceType === 'proposal') {
        const pair = or(
          and(
            eq(b2bPartnerships.businessAId, input.businessId),
            eq(b2bPartnerships.businessBId, input.targetBusinessId),
          ),
          and(
            eq(b2bPartnerships.businessAId, input.targetBusinessId),
            eq(b2bPartnerships.businessBId, input.businessId),
          ),
        );
        const [row] = await tx
          .select({ id: b2bProposals.id })
          .from(b2bProposals)
          .innerJoin(b2bPartnerships, eq(b2bPartnerships.id, b2bProposals.partnershipId))
          .where(and(eq(b2bProposals.id, input.resourceId), pair))
          .limit(1);
        exists = !!row;
      }
      if (!exists) throw missing();
    });
    const [report] = await this.db
      .insert(b2bAbuseReports)
      .values({
        reporterBusinessId: input.businessId,
        reporterUserId: input.userId,
        targetBusinessId: input.targetBusinessId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        reasonCode: input.reasonCode,
        details: input.details?.trim() || null,
      })
      .returning();
    if (!report) throw conflict('B2B_REPORT_CREATE_FAILED', 'The report could not be submitted.');
    return report;
  }

  async listNotifications(businessId: string, userId: string, limit: number) {
    return this.db
      .select({ notification: b2bNotifications, readAt: b2bNotificationReads.readAt })
      .from(b2bNotifications)
      .leftJoin(
        b2bNotificationReads,
        and(
          eq(b2bNotificationReads.notificationId, b2bNotifications.id),
          eq(b2bNotificationReads.userId, userId),
        ),
      )
      .where(eq(b2bNotifications.recipientBusinessId, businessId))
      .orderBy(desc(b2bNotifications.createdAt), desc(b2bNotifications.id))
      .limit(limit);
  }

  async markNotificationRead(input: {
    businessId: string;
    userId: string;
    notificationId: string;
  }) {
    const [notice] = await this.db
      .select({ id: b2bNotifications.id })
      .from(b2bNotifications)
      .where(
        and(
          eq(b2bNotifications.id, input.notificationId),
          eq(b2bNotifications.recipientBusinessId, input.businessId),
        ),
      )
      .limit(1);
    if (!notice) throw missing();
    await this.db
      .insert(b2bNotificationReads)
      .values({ notificationId: notice.id, businessId: input.businessId, userId: input.userId })
      .onConflictDoNothing();
    return { id: notice.id, read: true };
  }
}
