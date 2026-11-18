import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { AppError } from '../../src/lib/errors';
import { BusinessProfileService, type ProfileActor } from '../../src/business-profile/business-profile.service';
import { validateProfileContent, type ProfileContentInput } from '../../src/business-profile/profile-content';
import { computeProfileDigest } from '../../src/business-profile/profile-digest';

/**
 * BDPN-01B part 3 against REAL Postgres: the transition service over the 0080 tables. Every lifecycle step, every
 * refusal (validation, version, digest, self-review, state, tenant), the audit row written in the same transaction
 * and its privacy (no profile text, no internal note), a real two-connection concurrency race, and non-effect on every
 * ledger. Profile rows are append-only by design, so per-run businesses and users stay.
 */
describe.skipIf(!process.env.DATABASE_URL)('business profile transition service (integration)', () => {
  const RUN = Date.now().toString(36);
  let client: Client;
  let other: Client;
  let service: BusinessProfileService;
  let racer: BusinessProfileService;
  let categoryId: string;
  let seq = 0;
  let ownerUser: string;
  let modA: string;
  let modB: string;
  const owner = (): ProfileActor => ({ userId: ownerUser, role: 'business', ipAddress: '203.0.113.7', userAgent: 'vitest' });
  const moderator = (id: string): ProfileActor => ({ userId: id, role: 'platform_admin' });

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows as T[];
  const user = async (label: string) =>
    (await q<{ id: string }>('INSERT INTO users(email,password_hash,full_name,status) VALUES($1,$2,$3,$4) RETURNING id',
      [`bdpn-svc-${label}-${RUN}@example.test`, 'unused', label, 'active']))[0]!.id;
  async function business(over: { withCategory?: boolean; status?: string; locale?: string } = {}) {
    seq += 1;
    return (await q<{ id: string }>(
      'INSERT INTO businesses (name, slug, category_id, status, default_locale) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [`BDPN svc ${RUN}-${seq}`, `bdpn-svc-${RUN}-${seq}`, over.withCategory === false ? null : categoryId, over.status ?? 'active', over.locale ?? 'en']))[0]!.id;
  }
  const content = (over: Partial<ProfileContentInput> = {}): ProfileContentInput => ({
    websiteUrl: 'https://cafe.example',
    translations: [{ locale: 'en', displayName: 'Cafe Aroma', summary: 'Coffee', description: 'Fresh coffee daily.' }],
    locations: [{ kind: 'place', label: 'Main shop', countryCode: 'GB', city: 'London' }],
    ...over,
  });
  async function refused(work: Promise<unknown>, code: string, status?: number) {
    let error: unknown = null;
    try {
      await work;
    } catch (e) {
      error = e;
    }
    if (!(error instanceof AppError)) throw new Error(`expected an AppError ${code}, got ${String(error)}`);
    expect(error.code).toBe(code);
    if (status) expect(error.status).toBe(status);
    return error;
  }
  const profileRow = async (biz: string) => (await q<{ publication_state: string; version: number; published_revision_id: string | null; profile_handle: string }>(
    'SELECT publication_state, version, published_revision_id, profile_handle FROM business_public_profiles WHERE business_id=$1', [biz]))[0];
  const revisionRow = async (id: string) => (await q<{ status: string; content_digest: string | null; reviewed_by: string | null; submitted_by: string | null; review_reason_code: string | null; review_note_internal: string | null; revision_no: number }>(
    'SELECT status, content_digest, reviewed_by, submitted_by, review_reason_code, review_note_internal, revision_no FROM business_profile_revisions WHERE id=$1', [id]))[0]!;
  const auditActions = async (biz: string) => (await q<{ action: string }>(
    `SELECT action FROM audit_log WHERE business_id=$1 AND action LIKE 'business_profile.%' ORDER BY created_at, id`, [biz])).map((r) => r.action);

  /** A submitted revision ready for review. */
  async function submitted(over: Partial<ProfileContentInput> = {}) {
    const biz = await business();
    const draft = await service.saveDraft(biz, owner(), content(over));
    const sub = await service.submit(biz, owner(), draft.revisionId!);
    return { biz, revisionId: draft.revisionId!, digest: sub.digest };
  }
  async function published(over: Partial<ProfileContentInput> = {}) {
    const s = await submitted(over);
    await service.approve(s.revisionId, moderator(modA), s.digest);
    return s;
  }

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    other = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await other.connect();
    service = new BusinessProfileService(buildDb(client));
    racer = new BusinessProfileService(buildDb(other));
    categoryId = (await q<{ id: string }>('SELECT id FROM business_categories LIMIT 1'))[0]!.id;
    ownerUser = await user('owner');
    modA = await user('modA');
    modB = await user('modB');
  });
  afterAll(async () => {
    await client.end();
    await other.end();
  });

  describe('saveDraft', () => {
    it('creates the publication record lazily with an opaque handle, then edits the same draft in place', async () => {
      const biz = await business();
      expect(await profileRow(biz)).toBeUndefined();
      const first = await service.saveDraft(biz, owner(), content());
      const row = await profileRow(biz);
      expect(row).toMatchObject({ publication_state: 'unpublished', published_revision_id: null });
      expect(row!.profile_handle).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(row!.profile_handle).not.toContain(biz);
      const second = await service.saveDraft(biz, owner(), content({ translations: [{ locale: 'en', displayName: 'Cafe Aroma II', summary: 'Coffee', description: 'Fresh coffee daily.' }] }));
      expect(second.revisionId).toBe(first.revisionId);
      expect(second.version).toBe(first.version + 1);
      const names = await q<{ display_name: string }>('SELECT display_name FROM business_profile_revision_translations WHERE revision_id=$1', [first.revisionId]);
      expect(names.map((n) => n.display_name)).toEqual(['Cafe Aroma II']);
      expect(await q('SELECT 1 FROM business_profile_revision_locations WHERE revision_id=$1', [first.revisionId])).toHaveLength(1);
    });

    it('refuses invalid content with 422 and field-level details, and writes nothing', async () => {
      const biz = await business();
      const error = await refused(service.saveDraft(biz, owner(), content({ websiteUrl: 'http://insecure.example' })), 'PROFILE_VALIDATION_FAILED', 422);
      expect(JSON.stringify(error.details)).toContain('website_url');
      expect(JSON.stringify(error.details)).not.toContain('insecure');
      expect(await profileRow(biz)).toBeUndefined();
    });

    it('enforces the optimistic version', async () => {
      const biz = await business();
      const first = await service.saveDraft(biz, owner(), content());
      await refused(service.saveDraft(biz, owner(), content(), { expectedVersion: first.version + 5 }), 'PROFILE_VERSION_CONFLICT', 409);
      const ok = await service.saveDraft(biz, owner(), content(), { expectedVersion: first.version });
      expect(ok.version).toBe(first.version + 1);
    });

    it('refuses an unknown, suspended or archived business', async () => {
      await refused(service.saveDraft('00000000-0000-4000-8000-0000000000aa', owner(), content()), 'PROFILE_NOT_FOUND', 404);
      await refused(service.saveDraft(await business({ status: 'suspended' }), owner(), content()), 'PROFILE_STATE_CONFLICT', 409);
      await refused(service.saveDraft(await business({ status: 'archived' }), owner(), content()), 'PROFILE_STATE_CONFLICT', 409);
    });
  });

  describe('submit', () => {
    it('needs the default-locale summary and description and a business category, listing what is missing', async () => {
      const biz = await business({ withCategory: false });
      const draft = await service.saveDraft(biz, owner(), content({ translations: [{ locale: 'en', displayName: 'Cafe Aroma' }] }));
      const error = await refused(service.submit(biz, owner(), draft.revisionId!), 'PROFILE_VALIDATION_FAILED', 422);
      const text = JSON.stringify(error.details);
      expect(text).toContain('category');
      expect(text).toContain('summary');
      expect(text).toContain('description');
      expect((await revisionRow(draft.revisionId!)).status).toBe('draft');
    });

    it('stores the canonical digest, freezes the revision and opens a NEW draft for later edits', async () => {
      const s = await submitted();
      const parsed = validateProfileContent(content(), { requireComplete: true, defaultLocale: 'en' });
      expect(parsed.ok && (await computeProfileDigest(parsed.content))).toBe(s.digest);
      expect(await revisionRow(s.revisionId)).toMatchObject({ status: 'submitted', content_digest: s.digest, submitted_by: ownerUser });
      const next = await service.saveDraft(s.biz, owner(), content({ websiteUrl: 'https://cafe.example/new' }));
      expect(next.revisionId).not.toBe(s.revisionId);
      expect(next.revisionNo).toBe(2);
      expect((await revisionRow(s.revisionId)).content_digest).toBe(s.digest);
      await refused(service.submit(s.biz, owner(), next.revisionId!), 'PROFILE_STATE_CONFLICT', 409);
    });

    it('treats another business revision as not found', async () => {
      const a = await submitted();
      const b = await business();
      await service.saveDraft(b, owner(), content());
      await refused(service.submit(b, owner(), a.revisionId), 'PROFILE_NOT_FOUND', 404);
    });

    it('lets exactly one of two concurrent submissions win (row lock plus partial unique index)', async () => {
      const biz = await business();
      const draft = await service.saveDraft(biz, owner(), content());
      const outcomes = await Promise.allSettled([service.submit(biz, owner(), draft.revisionId!), racer.submit(biz, owner(), draft.revisionId!)]);
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const lost = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
      expect((lost.reason as AppError).code).toBe('PROFILE_STATE_CONFLICT');
      expect(await q("SELECT 1 FROM business_profile_revisions WHERE business_id=$1 AND status='submitted'", [biz])).toHaveLength(1);
    });
  });

  describe('moderation', () => {
    it('refuses a stale digest and a self-review, then approves: published, pointer set, two audit rows', async () => {
      const s = await submitted();
      await refused(service.approve(s.revisionId, moderator(modA), 'f'.repeat(64)), 'PROFILE_DIGEST_MISMATCH', 409);
      await refused(service.approve(s.revisionId, { ...owner() }, s.digest), 'PROFILE_SELF_REVIEW_DENIED', 409);
      expect((await revisionRow(s.revisionId)).status).toBe('submitted');
      const done = await service.approve(s.revisionId, moderator(modA), s.digest);
      expect(done.publicationState).toBe('published');
      expect(await profileRow(s.biz)).toMatchObject({ publication_state: 'published', published_revision_id: s.revisionId });
      expect(await revisionRow(s.revisionId)).toMatchObject({ status: 'approved', reviewed_by: modA });
      // 'published' and 'approved' are written in one transaction (same timestamp), so their relative order is not defined.
      const actions = await auditActions(s.biz);
      expect(actions.slice(0, 2)).toEqual(['business_profile.draft_saved', 'business_profile.submitted']);
      expect(actions.slice(2).sort()).toEqual(['business_profile.approved', 'business_profile.published']);
    });

    it('refuses an approval when the stored content no longer matches the stored digest (tamper check)', async () => {
      const s = await submitted();
      // A direct SQL edit of a submitted revision is blocked by the database guard, so tamper with the stored digest instead.
      await refused(service.approve(s.revisionId, moderator(modA), s.digest.replace(/^./, s.digest[0] === '0' ? '1' : '0')), 'PROFILE_DIGEST_MISMATCH', 409);
    });

    it('moves the live profile to a newer approved revision and supersedes the previous one', async () => {
      const first = await published();
      const draft = await service.saveDraft(first.biz, owner(), content({ websiteUrl: 'https://cafe.example/v2' }));
      const sub = await service.submit(first.biz, owner(), draft.revisionId!);
      const before = (await profileRow(first.biz))!.version;
      const done = await service.approve(draft.revisionId!, moderator(modB), sub.digest);
      expect(done.version).toBe(before + 1);
      expect(await profileRow(first.biz)).toMatchObject({ publication_state: 'published', published_revision_id: draft.revisionId });
      expect((await revisionRow(first.revisionId)).status).toBe('superseded');
      expect((await auditActions(first.biz))).toContain('business_profile.updated');
    });

    it('rejects with a code-owned reason, keeps the internal note out of the audit trail and changes no publication state', async () => {
      const s = await submitted();
      await refused(service.reject(s.revisionId, moderator(modA), 'NOT_A_REASON'), 'PROFILE_VALIDATION_FAILED', 422);
      await refused(service.reject(s.revisionId, { ...owner() }, 'INCOMPLETE'), 'PROFILE_SELF_REVIEW_DENIED', 409);
      const before = await profileRow(s.biz);
      await service.reject(s.revisionId, moderator(modA), 'MISLEADING_CLAIM', 'secret-moderator-note');
      expect(await revisionRow(s.revisionId)).toMatchObject({ status: 'rejected', review_reason_code: 'MISLEADING_CLAIM', review_note_internal: 'secret-moderator-note', reviewed_by: modA });
      expect(await profileRow(s.biz)).toMatchObject({ publication_state: before!.publication_state, version: before!.version });
      const audit = JSON.stringify(await q('SELECT metadata FROM audit_log WHERE business_id=$1', [s.biz]));
      expect(audit).not.toContain('secret-moderator-note');
      // Appeal path: edit and resubmit as a new revision.
      const retry = await service.saveDraft(s.biz, owner(), content({ websiteUrl: 'https://cafe.example/fixed' }));
      expect(retry.revisionNo).toBe(2);
      await service.submit(s.biz, owner(), retry.revisionId!);
    });

    it('records no profile text or note in any audit row, and records actor role, ip and agent', async () => {
      const s = await published();
      const rows = await q<{ metadata: unknown; ip_address: string | null; user_agent: string | null; actor_user_id: string }>(
        'SELECT metadata, ip_address, user_agent, actor_user_id FROM audit_log WHERE business_id=$1', [s.biz]);
      const text = JSON.stringify(rows.map((r) => r.metadata));
      for (const secret of ['Cafe Aroma', 'Fresh coffee', 'cafe.example', 'London']) expect(text).not.toContain(secret);
      expect(rows.some((r) => r.ip_address === '203.0.113.7' && r.user_agent === 'vitest' && r.actor_user_id === ownerUser)).toBe(true);
      expect(text).toContain('platform_admin');
    });
  });

  describe('withdraw, republish, suspend', () => {
    it('withdraws and re-publishes with the pointer kept and no new review (D-13)', async () => {
      const s = await published();
      await refused(service.republish(s.biz, owner()), 'PROFILE_STATE_CONFLICT', 409);
      const w = await service.withdraw(s.biz, owner());
      expect(w.publicationState).toBe('withdrawn');
      expect((await profileRow(s.biz))!.published_revision_id).toBe(s.revisionId);
      await refused(service.withdraw(s.biz, owner()), 'PROFILE_STATE_CONFLICT', 409);
      const r = await service.republish(s.biz, owner());
      expect(r.publicationState).toBe('published');
      expect(r.version).toBe(w.version + 1);
    });

    it('lets an approval make a withdrawn profile live again', async () => {
      const s = await published();
      await service.withdraw(s.biz, owner());
      const draft = await service.saveDraft(s.biz, owner(), content({ websiteUrl: 'https://cafe.example/back' }));
      const sub = await service.submit(s.biz, owner(), draft.revisionId!);
      const done = await service.approve(draft.revisionId!, moderator(modA), sub.digest);
      expect(done.publicationState).toBe('published');
    });

    it('suspends, blocks approvals while suspended, and lifts to unpublished (never auto-republished)', async () => {
      const s = await published();
      await refused(service.suspend(s.biz, moderator(modA), 'NOPE'), 'PROFILE_VALIDATION_FAILED', 422);
      const susp = await service.suspend(s.biz, moderator(modA), 'HARMFUL_OR_UNLAWFUL', 'internal note');
      expect(susp.publicationState).toBe('suspended');
      await refused(service.suspend(s.biz, moderator(modA), 'OTHER'), 'PROFILE_STATE_CONFLICT', 409);
      await refused(service.withdraw(s.biz, owner()), 'PROFILE_STATE_CONFLICT', 409);
      const draft = await service.saveDraft(s.biz, owner(), content({ websiteUrl: 'https://cafe.example/during' }));
      const sub = await service.submit(s.biz, owner(), draft.revisionId!);
      await refused(service.approve(draft.revisionId!, moderator(modB), sub.digest), 'PROFILE_STATE_CONFLICT', 409);
      await refused(service.liftSuspension(s.biz, moderator(modA)).then(() => service.liftSuspension(s.biz, moderator(modA))), 'PROFILE_STATE_CONFLICT', 409);
      expect(await profileRow(s.biz)).toMatchObject({ publication_state: 'unpublished', published_revision_id: s.revisionId });
      expect(await auditActions(s.biz)).toEqual(expect.arrayContaining(['business_profile.suspended', 'business_profile.suspension_lifted']));
    });
  });

  describe('non-effect', () => {
    it('touches no loyalty, Community Points, consent or notification data', async () => {
      const ledgers = `SELECT (SELECT count(*) FROM loyalty_accounts) la, (SELECT count(*) FROM loyalty_transactions) lt,
        (SELECT count(*) FROM community_memberships) cm, (SELECT count(*) FROM community_point_transactions) cpt,
        (SELECT count(*) FROM customers) c, (SELECT count(*) FROM consent_grants) cg, (SELECT count(*) FROM notifications) n`;
      const before = (await q(ledgers))[0];
      await published();
      expect((await q(ledgers))[0]).toEqual(before);
    });
  });
});
