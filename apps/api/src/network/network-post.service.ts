import { and, asc, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import {
  networkPosts, networkPostRevisions, networkRevisionApprovals,
  NETWORK_DEFAULT_EXPIRY_DAYS, NETWORK_REQUIRED_APPROVALS,
  type NetworkReasonCode,
} from '../db/schema/network-posts';
import { AppError } from '../lib/errors';
import {
  computeContentDigest, isNetworkReasonCode, newNetworkHandle, normalizeNetworkContent,
  NetworkContentError, type NetworkContentInput,
} from './network-post';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type NetworkPostRow = typeof networkPosts.$inferSelect;
export type NetworkRevisionRow = typeof networkPostRevisions.$inferSelect;

export type ApprovalOutcome =
  | { status: 'recorded'; approvals: number; required: number }
  | { status: 'published'; approvals: number; post: NetworkPostRow };

const notFound = () => new AppError('Not found.', 404, 'NETWORK_NOT_FOUND');

function contentError(error: unknown): never {
  if (error instanceof NetworkContentError) throw new AppError(error.message, 422, 'NETWORK_CONTENT_INVALID', { rule: error.code });
  throw error;
}

/**
 * NETWORK-01 official-post lifecycle (platform authors and moderators only; business authorship waits for BDPN).
 * Every mutation is one transaction with row locks; every timestamp that decides publication or expiry comes from
 * the DATABASE clock. The same rules are enforced again by database triggers (migration 0077), so this service is
 * not the only barrier. The caller (a route) has already authorized the actor; this layer enforces the separation
 * of duties: a reviewer is never the author, and publication needs two DISTINCT approvers.
 */
export class NetworkPostService {
  constructor(private readonly db: Database, private readonly expiryDays = NETWORK_DEFAULT_EXPIRY_DAYS) {}

  async createDraft(authorId: string, input: NetworkContentInput) {
    const content = this.validate(input);
    const digest = await computeContentDigest(content);
    return this.db.transaction(async (tx) => {
      const [post] = await tx.insert(networkPosts).values({ handle: newNetworkHandle(), authorUserId: authorId }).returning();
      const [revision] = await tx.insert(networkPostRevisions).values({
        postId: post!.id, revisionNo: 1, ...content, contentDigest: digest, createdBy: authorId,
      }).returning();
      return { post: post!, revision: revision! };
    });
  }

  /** Edits the open draft in place, or opens revision n+1 (a new draft) when the latest revision is already submitted/decided. */
  async saveDraft(postId: string, actorId: string, input: NetworkContentInput) {
    const content = this.validate(input);
    const digest = await computeContentDigest(content);
    return this.db.transaction(async (tx) => {
      const post = await this.lockPost(tx, postId);
      if (post.authorUserId !== actorId) throw notFound();
      if (post.state === 'withdrawn') throw new AppError('A withdrawn post cannot be edited.', 409, 'NETWORK_STATE_CONFLICT');
      const [draft] = await tx.select().from(networkPostRevisions)
        .where(and(eq(networkPostRevisions.postId, postId), eq(networkPostRevisions.status, 'draft'))).for('update');
      if (draft) {
        const [row] = await tx.update(networkPostRevisions).set({ ...content, contentDigest: digest })
          .where(eq(networkPostRevisions.id, draft.id)).returning();
        return row!;
      }
      const [submitted] = await tx.select({ id: networkPostRevisions.id }).from(networkPostRevisions)
        .where(and(eq(networkPostRevisions.postId, postId), eq(networkPostRevisions.status, 'submitted')));
      if (submitted) throw new AppError('A revision is already awaiting approval.', 409, 'NETWORK_STATE_CONFLICT');
      const [latest] = await tx.select({ n: sql<number>`coalesce(max(${networkPostRevisions.revisionNo}), 0)` })
        .from(networkPostRevisions).where(eq(networkPostRevisions.postId, postId));
      const [row] = await tx.insert(networkPostRevisions).values({
        postId, revisionNo: (latest?.n ?? 0) + 1, ...content, contentDigest: digest, createdBy: actorId,
      }).returning();
      return row!;
    });
  }

  async submit(postId: string, actorId: string) {
    return this.db.transaction(async (tx) => {
      const post = await this.lockPost(tx, postId);
      if (post.authorUserId !== actorId) throw notFound();
      const [draft] = await tx.select().from(networkPostRevisions)
        .where(and(eq(networkPostRevisions.postId, postId), eq(networkPostRevisions.status, 'draft'))).for('update');
      if (!draft) throw new AppError('There is no draft to submit.', 409, 'NETWORK_STATE_CONFLICT');
      await this.assertDigest(draft);
      const [row] = await tx.update(networkPostRevisions)
        .set({ status: 'submitted', submittedAt: sql`now()` }).where(eq(networkPostRevisions.id, draft.id)).returning();
      return row!;
    });
  }

  /**
   * Records one approval. The second DISTINCT non-author approver publishes: the revision becomes approved, any
   * previously live revision is superseded, and the post goes live with an expiry from the database clock.
   */
  async approve(revisionId: string, approverId: string): Promise<ApprovalOutcome> {
    return this.db.transaction(async (tx) => {
      const { revision, post } = await this.lockRevisionAndPost(tx, revisionId);
      if (revision.status !== 'submitted') throw new AppError('Only a submitted revision can be approved.', 409, 'NETWORK_STATE_CONFLICT');
      if (approverId === revision.createdBy) throw new AppError('An author cannot approve their own post.', 403, 'NETWORK_SELF_APPROVAL');
      if (post.state === 'withdrawn') throw new AppError('The post was withdrawn.', 409, 'NETWORK_STATE_CONFLICT');
      await this.assertDigest(revision);
      const inserted = await tx.insert(networkRevisionApprovals)
        .values({ revisionId, approverUserId: approverId }).onConflictDoNothing().returning();
      if (inserted.length === 0) throw new AppError('You have already approved this revision.', 409, 'NETWORK_ALREADY_APPROVED');
      const [{ n }] = await tx.select({ n: sql<number>`count(distinct ${networkRevisionApprovals.approverUserId})::int` })
        .from(networkRevisionApprovals).where(eq(networkRevisionApprovals.revisionId, revisionId)) as [{ n: number }];
      // Official posts keep the two-person rule (N-09); a business post needs one platform approver who is not its author.
      const required = post.contentClass === 'business' ? 1 : NETWORK_REQUIRED_APPROVALS;
      if (n < required) return { status: 'recorded' as const, approvals: n, required };

      if (post.liveRevisionId) {
        await tx.update(networkPostRevisions).set({ status: 'superseded' }).where(eq(networkPostRevisions.id, post.liveRevisionId));
      }
      await tx.update(networkPostRevisions).set({ status: 'approved', decidedAt: sql`now()`, decidedBy: approverId })
        .where(eq(networkPostRevisions.id, revisionId));
      const [published] = await tx.update(networkPosts).set({
        state: 'published', liveRevisionId: revisionId, publishedAt: sql`now()`,
        expiresAt: sql`now() + make_interval(days => ${this.expiryDays})`, stateChangedAt: sql`now()`, pinned: false,
      }).where(eq(networkPosts.id, post.id)).returning();
      return { status: 'published' as const, approvals: n, post: published! };
    });
  }

  async reject(revisionId: string, reviewerId: string, reasonCode: string) {
    if (!isNetworkReasonCode(reasonCode)) throw new AppError('Choose a listed reason.', 422, 'NETWORK_REASON_INVALID');
    return this.db.transaction(async (tx) => {
      const { revision } = await this.lockRevisionAndPost(tx, revisionId);
      if (revision.status !== 'submitted') throw new AppError('Only a submitted revision can be rejected.', 409, 'NETWORK_STATE_CONFLICT');
      if (reviewerId === revision.createdBy) throw new AppError('An author cannot review their own post.', 403, 'NETWORK_SELF_APPROVAL');
      const [row] = await tx.update(networkPostRevisions).set({
        status: 'rejected', decidedAt: sql`now()`, decidedBy: reviewerId, reasonCode: reasonCode as NetworkReasonCode,
      }).where(eq(networkPostRevisions.id, revisionId)).returning();
      return row!;
    });
  }

  /** published -> suspended (moderator). The live revision stays; the post leaves the feed at once. */
  async suspend(postId: string, moderatorId: string, reasonCode: string) {
    if (!isNetworkReasonCode(reasonCode)) throw new AppError('Choose a listed reason.', 422, 'NETWORK_REASON_INVALID');
    void moderatorId;
    return this.transition(postId, ['published'], 'suspended');
  }

  async lift(postId: string) {
    return this.transition(postId, ['suspended'], 'published');
  }

  /** Author or moderator ends a post for good. */
  async withdraw(postId: string) {
    return this.transition(postId, ['unpublished', 'published', 'suspended'], 'withdrawn');
  }

  /** Pins a currently visible post; any previously pinned post is unpinned in the same transaction. */
  async pin(postId: string) {
    return this.db.transaction(async (tx) => {
      const post = await this.lockPost(tx, postId);
      if (post.state !== 'published' || !post.expiresAt) throw new AppError('Only a published post can be pinned.', 409, 'NETWORK_STATE_CONFLICT');
      const [live] = await tx.select({ ok: sql<boolean>`${networkPosts.expiresAt} > now()` }).from(networkPosts).where(eq(networkPosts.id, postId));
      if (!live?.ok) throw new AppError('An expired post cannot be pinned.', 409, 'NETWORK_STATE_CONFLICT');
      await tx.update(networkPosts).set({ pinned: false }).where(and(eq(networkPosts.contentClass, post.contentClass), eq(networkPosts.pinned, true)));
      const [row] = await tx.update(networkPosts).set({ pinned: true }).where(eq(networkPosts.id, postId)).returning();
      return row!;
    });
  }

  async unpin(postId: string) {
    return this.db.transaction(async (tx) => {
      await this.lockPost(tx, postId);
      const [row] = await tx.update(networkPosts).set({ pinned: false }).where(eq(networkPosts.id, postId)).returning();
      return row!;
    });
  }

  /** Moderation queue: submitted revisions oldest first, with the number of approvals so far. No customer data exists here. */
  async queue(limit = 50) {
    return this.db.select({
      revisionId: networkPostRevisions.id, postHandle: networkPosts.handle, revisionNo: networkPostRevisions.revisionNo,
      body: networkPostRevisions.body, linkUrl: networkPostRevisions.linkUrl, contentLocale: networkPostRevisions.contentLocale,
      authorUserId: networkPostRevisions.createdBy, submittedAt: networkPostRevisions.submittedAt,
      contentClass: networkPosts.contentClass,
      requiredApprovals: sql<number>`case when ${networkPosts.contentClass} = 'business' then 1 else ${NETWORK_REQUIRED_APPROVALS} end`,
      approvals: sql<number>`(select count(*)::int from ${networkRevisionApprovals} a where a.revision_id = ${networkPostRevisions.id})`,
    }).from(networkPostRevisions).innerJoin(networkPosts, eq(networkPosts.id, networkPostRevisions.postId))
      .where(eq(networkPostRevisions.status, 'submitted')).orderBy(asc(networkPostRevisions.submittedAt)).limit(Math.min(Math.max(limit, 1), 200));
  }

  async findByHandle(handle: string): Promise<NetworkPostRow | null> {
    const [row] = await this.db.select().from(networkPosts).where(eq(networkPosts.handle, handle));
    return row ?? null;
  }

  // ---- internals ----
  private validate(input: NetworkContentInput) {
    try {
      return normalizeNetworkContent(input);
    } catch (error) {
      return contentError(error);
    }
  }

  private async assertDigest(revision: NetworkRevisionRow) {
    const digest = await computeContentDigest({
      body: revision.body, linkUrl: revision.linkUrl, contentLocale: revision.contentLocale as 'en',
    });
    if (digest !== revision.contentDigest) throw new AppError('The content changed after it was prepared.', 409, 'NETWORK_DIGEST_MISMATCH');
  }

  private async lockPost(tx: Tx, postId: string): Promise<NetworkPostRow> {
    const [post] = await tx.select().from(networkPosts).where(eq(networkPosts.id, postId)).for('update');
    if (!post) throw notFound();
    return post;
  }

  private async lockRevisionAndPost(tx: Tx, revisionId: string) {
    const [revision] = await tx.select().from(networkPostRevisions).where(eq(networkPostRevisions.id, revisionId));
    if (!revision) throw notFound();
    const post = await this.lockPost(tx, revision.postId);
    const [locked] = await tx.select().from(networkPostRevisions).where(eq(networkPostRevisions.id, revisionId)).for('update');
    return { revision: locked!, post };
  }

  private async transition(postId: string, from: NetworkPostRow['state'][], to: NetworkPostRow['state']) {
    return this.db.transaction(async (tx) => {
      const post = await this.lockPost(tx, postId);
      if (!from.includes(post.state)) throw new AppError('That action is not available for this post.', 409, 'NETWORK_STATE_CONFLICT');
      const [row] = await tx.update(networkPosts)
        .set({ state: to, stateChangedAt: sql`now()`, ...(to !== 'published' ? { pinned: false } : {}) })
        .where(eq(networkPosts.id, postId)).returning();
      return row!;
    });
  }
}
