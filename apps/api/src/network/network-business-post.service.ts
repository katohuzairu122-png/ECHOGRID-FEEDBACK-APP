import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { networkPosts, networkPostRevisions } from '../db/schema/network-posts';
import { businessPublicProfiles } from '../db/schema/business-profiles';
import { businesses } from '../db/schema/businesses';
import { AppError } from '../lib/errors';
import {
  computeContentDigest, newNetworkHandle, normalizeNetworkContent, NetworkContentError, type NetworkContentInput,
} from './network-post';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** C-2 (NETWORK-00 section 11): a low daily cap, set after a pilot. A constant here so the Owner can change it without a schema change. */
export const NETWORK_BUSINESS_DAILY_POST_CAP = 5;

/** Optional configuration override (whole number 1..100); anything else falls back to the default. Never client-controlled. */
export function resolveDailyPostCap(raw: unknown): number {
  if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw)) return NETWORK_BUSINESS_DAILY_POST_CAP;
  const n = Number.parseInt(raw, 10);
  return n >= 1 && n <= 100 ? n : NETWORK_BUSINESS_DAILY_POST_CAP;
}

/** Business post categories (BCOMM-03 section 4.3). Display grouping only; moderation applies to every category the same way. */
export const BUSINESS_POST_CATEGORIES = ['update', 'announcement', 'event', 'education', 'loyalty', 'offer', 'story', 'engagement'] as const;

export type BusinessPostView = {
  handle: string;
  state: 'unpublished' | 'published' | 'suspended' | 'withdrawn';
  /** The customer-visible lifecycle in one word: draft, awaiting_review, changes_rejected, live, suspended or archived. */
  stage: 'draft' | 'awaiting_review' | 'rejected' | 'live' | 'suspended' | 'archived';
  latestRevisionNo: number;
  latestStatus: 'draft' | 'submitted' | 'approved' | 'rejected' | 'superseded';
  /** The reason a moderator gave when rejecting (a code from the shared list), only for a rejected revision. */
  reasonCode: string | null;
  body: string;
  linkUrl: string | null;
  contentLocale: string;
  publishedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
};

const notFound = () => new AppError('Not found.', 404, 'NETWORK_NOT_FOUND');
const conflict = (message: string, code = 'NETWORK_STATE_CONFLICT') => new AppError(message, 409, code);

function contentError(error: unknown): never {
  if (error instanceof NetworkContentError) throw new AppError(error.message, 422, 'NETWORK_CONTENT_INVALID', { rule: error.code });
  throw error;
}

/**
 * BCOMM-03: business-authored posts, on the SAME network_* tables and state machines as official posts (no second lifecycle).
 * Every method takes the resolved business id and refuses anything that is not that business's own post with the same generic
 * not-found. The caller has already authorized the actor (business-wide `network:post`, not impersonating). Moderation is NOT here:
 * approval, rejection, suspension and lifting stay in the platform moderation service, which can never be reached with a business role.
 * Database triggers repeat the rules that matter (author != approver, one approver, published profile and active business to go live).
 */
export class NetworkBusinessPostService {
  constructor(private readonly db: Database, private readonly dailyCap: number = NETWORK_BUSINESS_DAILY_POST_CAP) {}

  async list(businessId: string, limit = 50): Promise<BusinessPostView[]> {
    const rows = await this.db.execute(sql`
      SELECT p.handle, p.state, p.published_at, p.expires_at, p.created_at,
             r.revision_no, r.status, r.reason_code, r.body, r.link_url, r.content_locale
        FROM network_posts p
        JOIN LATERAL (SELECT * FROM network_post_revisions WHERE post_id = p.id ORDER BY revision_no DESC LIMIT 1) r ON true
       WHERE p.business_id = ${businessId} AND p.content_class = 'business'
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT ${Math.min(Math.max(limit, 1), 100)}`);
    return (rows.rows as Record<string, unknown>[]).map((row) => toView(row));
  }

  async get(businessId: string, handle: string): Promise<BusinessPostView> {
    const rows = await this.db.execute(sql`
      SELECT p.handle, p.state, p.published_at, p.expires_at, p.created_at,
             r.revision_no, r.status, r.reason_code, r.body, r.link_url, r.content_locale
        FROM network_posts p
        JOIN LATERAL (SELECT * FROM network_post_revisions WHERE post_id = p.id ORDER BY revision_no DESC LIMIT 1) r ON true
       WHERE p.handle = ${handle} AND p.business_id = ${businessId} AND p.content_class = 'business'`);
    const row = (rows.rows as Record<string, unknown>[])[0];
    if (!row) throw notFound();
    return toView(row);
  }

  /**
   * NETWORK-00 C-3 (author's view, applied as the safer default until the Owner rules otherwise): a business post may link only to the website
   * on its PUBLISHED profile (the same host or one of its subdomains), which limits phishing. A business with no published website cannot link.
   */
  private async assertLinkAllowed(businessId: string, linkUrl: string | null): Promise<void> {
    if (!linkUrl) return;
    const rows = await this.db.execute(sql`
      select r.website_url from business_public_profiles p join business_profile_revisions r on r.id = p.published_revision_id
       where p.business_id = ${businessId}::uuid and p.publication_state = 'published'`);
    const website = (rows.rows as { website_url: string | null }[])[0]?.website_url;
    const allowed = (() => {
      try {
        if (!website) return false;
        const site = new URL(website).hostname.toLowerCase().replace(/^www\./, '');
        const host = new URL(linkUrl).hostname.toLowerCase();
        return host === site || host === `www.${site}` || host.endsWith(`.${site}`);
      } catch {
        return false;
      }
    })();
    if (!allowed) throw new AppError('A post link must point to your business website.', 422, 'NETWORK_LINK_DOMAIN');
  }

  async createDraft(businessId: string, authorId: string, input: NetworkContentInput): Promise<BusinessPostView> {
    const content = this.validate(input);
    await this.assertLinkAllowed(businessId, content.linkUrl);
    const digest = await computeContentDigest(content);
    const handle = await this.db.transaction(async (tx) => {
      const [profile] = await tx.select({ id: businessPublicProfiles.businessId }).from(businessPublicProfiles)
        .where(eq(businessPublicProfiles.businessId, businessId));
      if (!profile) throw conflict('Create and publish your business profile before posting.', 'NETWORK_PROFILE_REQUIRED');
      // Serialise the daily cap per business so two concurrent drafts cannot both pass it.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'network-business-cap:' + businessId}, 0))`);
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(networkPosts)
        .where(and(eq(networkPosts.businessId, businessId), sql`${networkPosts.createdAt} > now() - interval '24 hours'`)) as [{ n: number }];
      if (n >= this.dailyCap) {
        throw new AppError('The daily post limit for your business has been reached. Try again tomorrow.', 429, 'NETWORK_DAILY_CAP');
      }
      const [post] = await tx.insert(networkPosts).values({
        handle: newNetworkHandle(), contentClass: 'business', businessId, authorUserId: authorId,
      }).returning();
      await tx.insert(networkPostRevisions).values({
        postId: post!.id, revisionNo: 1, ...content, contentDigest: digest, createdBy: authorId,
      });
      return post!.handle;
    });
    return this.get(businessId, handle);
  }

  /** Edits the open draft in place, or opens revision n+1 when the latest revision is decided (so a published post can be re-edited without leaving the feed). */
  async saveDraft(businessId: string, handle: string, actorId: string, input: NetworkContentInput): Promise<BusinessPostView> {
    const content = this.validate(input);
    await this.assertLinkAllowed(businessId, content.linkUrl);
    const digest = await computeContentDigest(content);
    await this.db.transaction(async (tx) => {
      const post = await this.lockOwn(tx, businessId, handle);
      if (post.state === 'withdrawn') throw conflict('An archived post cannot be edited.');
      const [draft] = await tx.select().from(networkPostRevisions)
        .where(and(eq(networkPostRevisions.postId, post.id), eq(networkPostRevisions.status, 'draft'))).for('update');
      if (draft) {
        await tx.update(networkPostRevisions).set({ ...content, contentDigest: digest }).where(eq(networkPostRevisions.id, draft.id));
        return;
      }
      const [submitted] = await tx.select({ id: networkPostRevisions.id }).from(networkPostRevisions)
        .where(and(eq(networkPostRevisions.postId, post.id), eq(networkPostRevisions.status, 'submitted')));
      if (submitted) throw conflict('This post is awaiting review. You can edit it again once it has been decided.');
      const [latest] = await tx.select({ n: sql<number>`coalesce(max(${networkPostRevisions.revisionNo}), 0)` })
        .from(networkPostRevisions).where(eq(networkPostRevisions.postId, post.id));
      await tx.insert(networkPostRevisions).values({
        postId: post.id, revisionNo: (latest?.n ?? 0) + 1, ...content, contentDigest: digest, createdBy: actorId,
      });
    });
    return this.get(businessId, handle);
  }

  /** Submit for platform review. The business must have a PUBLISHED profile and be active at this moment (and again, in the database, when it goes live). */
  async submit(businessId: string, handle: string): Promise<BusinessPostView> {
    await this.db.transaction(async (tx) => {
      const post = await this.lockOwn(tx, businessId, handle);
      if (post.state === 'withdrawn') throw conflict('An archived post cannot be submitted.');
      const [eligible] = await tx.select({ ok: sql<boolean>`true` }).from(businessPublicProfiles)
        .innerJoin(businesses, eq(businesses.id, businessPublicProfiles.businessId))
        .where(and(eq(businessPublicProfiles.businessId, businessId), eq(businessPublicProfiles.publicationState, 'published'), eq(businesses.status, 'active')));
      if (!eligible) throw conflict('Your business profile must be published and your business active before posts can be submitted.', 'NETWORK_PROFILE_NOT_PUBLISHED');
      const [draft] = await tx.select().from(networkPostRevisions)
        .where(and(eq(networkPostRevisions.postId, post.id), eq(networkPostRevisions.status, 'draft'))).for('update');
      if (!draft) throw conflict('There is no draft to submit.');
      const digest = await computeContentDigest({ body: draft.body, linkUrl: draft.linkUrl, contentLocale: draft.contentLocale as 'en' });
      if (digest !== draft.contentDigest) throw new AppError('The content changed after it was prepared.', 409, 'NETWORK_DIGEST_MISMATCH');
      await tx.update(networkPostRevisions).set({ status: 'submitted', submittedAt: sql`now()` }).where(eq(networkPostRevisions.id, draft.id));
    });
    return this.get(businessId, handle);
  }

  /** Archive (terminal): ends the post for good. It leaves the feed at once; every revision and audit record stays. */
  async archive(businessId: string, handle: string): Promise<BusinessPostView> {
    await this.db.transaction(async (tx) => {
      const post = await this.lockOwn(tx, businessId, handle);
      if (post.state === 'withdrawn') return;
      await tx.update(networkPosts).set({ state: 'withdrawn', pinned: false, stateChangedAt: sql`now()` }).where(eq(networkPosts.id, post.id));
    });
    return this.get(businessId, handle);
  }

  /** The internal id, used ONLY for the audit row (never returned to a client). Refuses another business's post with the same generic not-found. */
  async idOf(businessId: string, handle: string): Promise<string> {
    const [row] = await this.db.select({ id: networkPosts.id }).from(networkPosts)
      .where(and(eq(networkPosts.handle, handle), eq(networkPosts.businessId, businessId), eq(networkPosts.contentClass, 'business')));
    if (!row) throw notFound();
    return row.id;
  }

  private validate(input: NetworkContentInput) {
    try {
      return normalizeNetworkContent(input);
    } catch (error) {
      return contentError(error);
    }
  }

  private async lockOwn(tx: Tx, businessId: string, handle: string) {
    const [post] = await tx.select().from(networkPosts)
      .where(and(eq(networkPosts.handle, handle), eq(networkPosts.businessId, businessId), eq(networkPosts.contentClass, 'business')))
      .orderBy(desc(networkPosts.createdAt)).for('update');
    if (!post) throw notFound();
    return post;
  }
}

function toView(row: Record<string, unknown>): BusinessPostView {
  const state = row.state as BusinessPostView['state'];
  const latestStatus = row.status as BusinessPostView['latestStatus'];
  const stage: BusinessPostView['stage'] =
    state === 'withdrawn' ? 'archived'
    : state === 'suspended' ? 'suspended'
    : state === 'published' && latestStatus !== 'submitted' && latestStatus !== 'draft' ? 'live'
    : latestStatus === 'submitted' ? 'awaiting_review'
    : latestStatus === 'rejected' ? 'rejected'
    : state === 'published' ? 'live'
    : 'draft';
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? new Date(v).toISOString() : null);
  return {
    handle: String(row.handle), state, stage, latestRevisionNo: Number(row.revision_no), latestStatus,
    reasonCode: latestStatus === 'rejected' ? (row.reason_code as string | null) : null,
    body: String(row.body), linkUrl: (row.link_url as string | null) ?? null, contentLocale: String(row.content_locale),
    publishedAt: iso(row.published_at), expiresAt: iso(row.expires_at), createdAt: iso(row.created_at)!,
  };
}
