import { sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { AppError } from '../lib/errors';
import type { RawInsights } from '../community/community-insights-aggregate';

type Executor = Pick<Database, 'execute'>;
const HANDLE = /^[A-Za-z0-9_-]{22}$/;

/** The Feed's business-post visibility predicate, repeated for engagement so an event can never be recorded for a post the customer could not see. */
const VISIBLE_BUSINESS_POST = sql`
  p.content_class = 'business' and p.state = 'published' and p.expires_at > now() and r.id = p.live_revision_id and r.status = 'approved'
  and pr.publication_state = 'published' and b.status = 'active'`;

/**
 * BCOMM-05 engagement events and verified insights. Events are written only here, only for a signed-in customer and only for a business post the
 * customer's Feed could show; the database makes each impression/engagement unique per customer, post and UTC day (retries and refreshes are
 * harmless) and append-only. Reads are tenant-scoped aggregates; this class never returns a row, a customer id or an identifier of a customer.
 */
export class NetworkEngagementService {
  constructor(private readonly db: Executor) {}

  /** Best-effort, idempotent. Ignores handles that are not currently visible business posts. Returns the number of NEW impressions. */
  async recordImpressions(customerId: string, handles: string[]): Promise<number> {
    const valid = [...new Set(handles.filter((h) => HANDLE.test(h)))].slice(0, 50);
    if (valid.length === 0) return 0;
    const result = await this.db.execute(sql`
      insert into network_engagement_events (customer_id, business_id, subject_id, event_type)
      select ${customerId}::uuid, p.business_id, p.id, 'impression'
        from network_posts p
        join network_post_revisions r on r.post_id = p.id
        join business_public_profiles pr on pr.business_id = p.business_id
        join businesses b on b.id = p.business_id
       where p.handle in (${sql.join(valid.map((h) => sql`${h}`), sql`, `)}) and ${VISIBLE_BUSINESS_POST}
      on conflict (customer_id, event_type, subject_id, event_day) where event_type in ('impression','engagement') do nothing
      returning 1`);
    return result.rows.length;
  }

  /** An explicit customer action (opening the post's link). Generic not-found unless the post is a currently visible business post. */
  async recordEngagement(customerId: string, handle: string): Promise<{ recorded: true }> {
    if (!HANDLE.test(handle)) throw new AppError('Not found.', 404, 'NETWORK_NOT_FOUND');
    const result = await this.db.execute(sql`
      insert into network_engagement_events (customer_id, business_id, subject_id, event_type)
      select ${customerId}::uuid, p.business_id, p.id, 'engagement'
        from network_posts p
        join network_post_revisions r on r.post_id = p.id
        join business_public_profiles pr on pr.business_id = p.business_id
        join businesses b on b.id = p.business_id
       where p.handle = ${handle} and ${VISIBLE_BUSINESS_POST}
      on conflict (customer_id, event_type, subject_id, event_day) where event_type in ('impression','engagement') do nothing
      returning 1`);
    if (result.rows.length === 0) {
      // Either not visible (404) or already counted today (fine): distinguish without leaking by re-checking visibility.
      const visible = await this.db.execute(sql`
        select 1 from network_posts p join network_post_revisions r on r.post_id = p.id
          join business_public_profiles pr on pr.business_id = p.business_id join businesses b on b.id = p.business_id
         where p.handle = ${handle} and ${VISIBLE_BUSINESS_POST}`);
      if (visible.rows.length === 0) throw new AppError('Not found.', 404, 'NETWORK_NOT_FOUND');
    }
    return { recorded: true };
  }

  /** Follow / unfollow facts, recorded inside the same transaction as the follow row itself. */
  static async recordFollowEvent(tx: Executor, customerId: string, businessId: string, type: 'follow' | 'unfollow'): Promise<void> {
    await tx.execute(sql`insert into network_engagement_events (customer_id, business_id, subject_id, event_type)
      values (${customerId}::uuid, ${businessId}::uuid, ${businessId}::uuid, ${type})`);
  }

  /** Raw (UNSUPPRESSED) counts for ONE business; the pure aggregate module decides what may be shown. Tenant: `businessId` only. */
  async rawInsights(businessId: string, rangeDays: 7 | 30 | 90): Promise<RawInsights> {
    const total = async (type: string) => {
      const r = await this.db.execute(sql`
        select count(*)::int as total, count(distinct customer_id)::int as distinct
          from network_engagement_events
         where business_id = ${businessId}::uuid and event_type = ${type}
           and event_day >= to_char(((now() at time zone 'UTC')::date - (${rangeDays}::int - 1)), 'YYYY-MM-DD')`);
      const row = r.rows[0] as { total: number; distinct: number } | undefined;
      return { total: Number(row?.total ?? 0), distinct: Number(row?.distinct ?? 0) };
    };
    const [impressions, engagements, newFollowers] = await Promise.all([total('impression'), total('engagement'), total('follow')]);
    const followers = await this.db.execute(sql`select count(*)::int as n from network_follows where business_id = ${businessId}::uuid`);
    const range = await this.db.execute(sql`
      select to_char(((now() at time zone 'UTC')::date - (${rangeDays}::int - 1)), 'YYYY-MM-DD') as from_day,
             to_char((now() at time zone 'UTC')::date, 'YYYY-MM-DD') as to_day`);
    const posts = await this.db.execute(sql`
      select p.handle,
             left(r.body, 120) as excerpt,
             count(*) filter (where e.event_type = 'impression')::int as imp_total,
             count(distinct e.customer_id) filter (where e.event_type = 'impression')::int as imp_distinct,
             count(*) filter (where e.event_type = 'engagement')::int as eng_total,
             count(distinct e.customer_id) filter (where e.event_type = 'engagement')::int as eng_distinct
        from network_posts p
        join network_post_revisions r on r.id = p.live_revision_id
        left join network_engagement_events e on e.subject_id = p.id and e.business_id = p.business_id and e.event_type in ('impression','engagement')
             and e.event_day >= to_char(((now() at time zone 'UTC')::date - (${rangeDays}::int - 1)), 'YYYY-MM-DD')
       where p.business_id = ${businessId}::uuid and p.content_class = 'business' and p.live_revision_id is not null
       group by p.id, p.handle, r.body, p.published_at
       order by p.published_at desc nulls last, p.id desc
       limit 10`);
    const rangeRow = range.rows[0] as { from_day: string; to_day: string };
    return {
      rangeDays, from: rangeRow.from_day, to: rangeRow.to_day, impressions, engagements, newFollowers,
      currentFollowers: Number((followers.rows[0] as { n: number }).n),
      posts: (posts.rows as Record<string, unknown>[]).map((row) => ({
        handle: String(row.handle), excerpt: String(row.excerpt),
        impressions: { total: Number(row.imp_total), distinct: Number(row.imp_distinct) },
        engagements: { total: Number(row.eng_total), distinct: Number(row.eng_distinct) },
      })),
    };
  }
}
