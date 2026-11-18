import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';

/**
 * BDPN-F1 (profile storage foundation) against REAL Postgres, as a direct SQL session with NO application code:
 * every constraint, the composite tenant keys, the publication state machine, revision immutability, the
 * database-enforced separation of duties, TRUNCATE denial and the non-effect on every existing ledger. The rows are
 * append-only by design, so per-run businesses stay (their slugs carry a run tag).
 */
describe.skipIf(!process.env.DATABASE_URL)('business public profile storage (integration)', () => {
  const RUN = Date.now().toString(36);
  const DIGEST = '0123456789abcdef'.repeat(4);
  const SUBMITTER = randomUUID();
  const REVIEWER = randomUUID();
  const ADMIN = randomUUID();
  let client: Client;
  let seq = 0;

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await client.query(sql, params)).rows as T[];
  const handle = () => randomBytes(16).toString('base64url');

  /** Awaits a statement that MUST be refused, optionally pinning the SQLSTATE and a message fragment. */
  async function denied(statement: Promise<unknown>, message?: RegExp | string, code?: string) {
    let error: { message: string; code?: string } | null = null;
    try {
      await statement;
    } catch (e) {
      error = e as { message: string; code?: string };
    }
    if (!error) throw new Error('expected the statement to be refused, but it succeeded');
    if (message) expect(error.message).toMatch(message);
    if (code) expect(error.code).toBe(code);
  }

  async function business(locale = 'en') {
    seq += 1;
    const [row] = await q<{ id: string }>(
      'INSERT INTO businesses (name, slug, default_locale) VALUES ($1,$2,$3) RETURNING id',
      [`BDPN-F1 ${RUN}-${seq}`, `bdpn-f1-${RUN}-${seq}`, locale],
    );
    return row!.id;
  }
  async function draft(businessId: string) {
    const [row] = await q<{ id: string }>(
      `INSERT INTO business_profile_revisions (business_id, revision_no)
       VALUES ($1, (SELECT COALESCE(MAX(revision_no),0)+1 FROM business_profile_revisions WHERE business_id=$1)) RETURNING id`,
      [businessId],
    );
    return row!.id;
  }
  const translation = (rev: string, biz: string, locale: string, name = 'Cafe Aroma', summary: string | null = 'Coffee', description: string | null = 'Fresh coffee daily.') =>
    q('INSERT INTO business_profile_revision_translations (revision_id, business_id, locale, display_name, summary, description) VALUES ($1,$2,$3,$4,$5,$6)', [rev, biz, locale, name, summary, description]);
  const place = (rev: string, biz: string, position = 0) =>
    q(`INSERT INTO business_profile_revision_locations (revision_id, business_id, position, kind, label, country_code, city) VALUES ($1,$2,$3,'place','Main shop','GB','London')`, [rev, biz, position]);
  const submit = (rev: string, by = SUBMITTER) =>
    q(`UPDATE business_profile_revisions SET status='submitted', content_digest=$2, submitted_by=$3, submitted_at=now() WHERE id=$1`, [rev, DIGEST, by]);
  const approve = (rev: string, by = REVIEWER) =>
    q(`UPDATE business_profile_revisions SET status='approved', reviewed_by=$2, reviewed_at=now() WHERE id=$1`, [rev, by]);
  async function readyDraft(biz: string, locale = 'en') {
    const rev = await draft(biz);
    await translation(rev, biz, locale);
    await place(rev, biz);
    return rev;
  }
  async function approvedRevision(biz: string, locale = 'en') {
    const rev = await readyDraft(biz, locale);
    await submit(rev);
    await approve(rev);
    return rev;
  }
  const startProfile = (biz: string) => q('INSERT INTO business_public_profiles (business_id, profile_handle) VALUES ($1,$2)', [biz, handle()]);
  const publish = (biz: string, rev: string) =>
    q(`UPDATE business_public_profiles SET publication_state='published', published_revision_id=$2, published_at=now(), version=version+1 WHERE business_id=$1`, [biz, rev]);
  const stateOf = async (biz: string) => (await q<{ publication_state: string; version: number }>('SELECT publication_state, version FROM business_public_profiles WHERE business_id=$1', [biz]))[0]!;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });

  describe('constraints', () => {
    it('refuses a malformed handle, an invalid state and a non-https website', async () => {
      const biz = await business();
      await denied(q('INSERT INTO business_public_profiles (business_id, profile_handle) VALUES ($1,$2)', [biz, 'short']), /handle_format/, '23514');
      await startProfile(biz);
      // The state-machine trigger refuses first (triggers run before CHECK constraints); either way it is refused.
      await denied(q(`UPDATE business_public_profiles SET publication_state='bogus' WHERE business_id=$1`, [biz]), /state_valid|illegal/);
      const rev = await draft(biz);
      await denied(q(`UPDATE business_profile_revisions SET website_url='http://x.example' WHERE id=$1`, [rev]), /website_https/, '23514');
      await q(`UPDATE business_profile_revisions SET website_url='https://x.example/menu' WHERE id=$1`, [rev]);
    });

    it('enforces translation and location length, kind and field rules', async () => {
      const biz = await business();
      const rev = await draft(biz);
      await denied(translation(rev, biz, 'en', 'A'), /name_length/, '23514');
      await denied(translation(rev, biz, 'en', 'Ok name', 'x'.repeat(161)), /summary_length/, '23514');
      await denied(translation(rev, biz, 'en', 'Ok name', 'ok', 'x'.repeat(1001)), /description_length/, '23514');
      await denied(translation(rev, biz, 'de'), /translations_locale/, '23514');
      await translation(rev, biz, 'en');
      await denied(translation(rev, biz, 'en'), undefined, '23505');
      await denied(q(`INSERT INTO business_profile_revision_locations (revision_id, business_id, position, kind, label) VALUES ($1,$2,0,'place','No city')`, [rev, biz]), /place_fields/, '23514');
      await denied(q(`INSERT INTO business_profile_revision_locations (revision_id, business_id, position, kind, label, street_address) VALUES ($1,$2,0,'service_area','Area','1 Road')`, [rev, biz]), /area_no_street/, '23514');
      await denied(q(`INSERT INTO business_profile_revision_locations (revision_id, business_id, position, kind, label, country_code, city) VALUES ($1,$2,0,'place','Shop','gb','London')`, [rev, biz]), /country_format/, '23514');
      await denied(q(`INSERT INTO business_profile_revision_locations (revision_id, business_id, position, kind, label, country_code, city) VALUES ($1,$2,-1,'place','Shop','GB','London')`, [rev, biz]), /position_nonneg/, '23514');
      await place(rev, biz, 0);
      await denied(place(rev, biz, 0), undefined, '23505');
      await q(`INSERT INTO business_profile_revision_locations (revision_id, business_id, position, kind, label) VALUES ($1,$2,1,'service_area','Greater London')`, [rev, biz]);
    });

    it('allows at most one open draft and one revision awaiting review per business, with unique numbering', async () => {
      const biz = await business();
      const first = await readyDraft(biz);
      await denied(draft(biz), undefined, '23505');
      await submit(first);
      const second = await readyDraft(biz);
      await denied(submit(second), undefined, '23505');
      await approve(first);
      await submit(second);
      await denied(q('INSERT INTO business_profile_revisions (business_id, revision_no) VALUES ($1,1)', [biz]), undefined, '23505');
    });

    it('stores category translations for the closed locale set only', async () => {
      const [cat] = await q<{ id: string }>(`INSERT INTO business_categories (name, key) VALUES ($1,$2) RETURNING id`, [`F1 ${RUN}`, `f1-${RUN}`]);
      if (!cat) throw new Error('category fixture was not created');
      await q(`INSERT INTO business_category_translations (category_id, locale, name) VALUES ($1,'fr','Cafe')`, [cat.id]);
      await denied(q(`INSERT INTO business_category_translations (category_id, locale, name) VALUES ($1,'fr','Dup')`, [cat.id]), undefined, '23505');
      await denied(q(`INSERT INTO business_category_translations (category_id, locale, name) VALUES ($1,'de','Kaffee')`, [cat.id]), /locale/, '23514');
      await denied(q(`INSERT INTO business_category_translations (category_id, locale, name) VALUES ($1,'es','')`, [cat.id]), /name_length/, '23514');
      await denied(q(`INSERT INTO business_category_translations (category_id, locale, name) VALUES ($1,'es','Cafe')`, [randomUUID()]), undefined, '23503');
    });
  });

  describe('composite tenant keys', () => {
    it('refuses a child row or a live pointer that names another business revision', async () => {
      const a = await business();
      const b = await business();
      // A DRAFT of business A passes the draft-only guard, so the composite foreign key itself is what refuses business B.
      const draftA = await draft(a);
      await denied(translation(draftA, b, 'en'), /revision_business_fk/, '23503');
      await denied(place(draftA, b), /revision_business_fk/, '23503');
      // A live pointer at another business revision is refused (the state-machine guard first, the composite key behind it).
      const revA = await approvedRevision(await business());
      await startProfile(b);
      await denied(publish(b, revA), /approved revision of this business|pointer_business_fk/);
    });
  });

  describe('submission readiness (D-04)', () => {
    it('needs a default-locale display name, summary and description, and at least one location', async () => {
      const biz = await business('fr');
      const rev = await draft(biz);
      await denied(submit(rev), /default-locale/);
      await translation(rev, biz, 'en');
      await denied(submit(rev), /default-locale/);
      await translation(rev, biz, 'fr', 'Cafe Aroma', null, null);
      await denied(submit(rev), /default-locale/);
      await q(`UPDATE business_profile_revision_translations SET summary='Cafe', description='Du cafe frais.' WHERE revision_id=$1 AND locale='fr'`, [rev]);
      await denied(submit(rev), /location/);
      await place(rev, biz);
      await submit(rev);
      expect((await q<{ status: string }>('SELECT status FROM business_profile_revisions WHERE id=$1', [rev]))[0]!.status).toBe('submitted');
    });

    it('refuses a submission with no digest or no submitter', async () => {
      const biz = await business();
      const rev = await readyDraft(biz);
      await denied(q(`UPDATE business_profile_revisions SET status='submitted', submitted_by=$2, submitted_at=now() WHERE id=$1`, [rev, SUBMITTER]), /digest_required/, '23514');
      await denied(q(`UPDATE business_profile_revisions SET status='submitted', content_digest=$2 WHERE id=$1`, [rev, DIGEST]), /submission_evidence/, '23514');
    });
  });

  describe('immutability once submitted', () => {
    it('freezes the revision, its translations and its locations', async () => {
      const biz = await business();
      const rev = await readyDraft(biz);
      await submit(rev);
      await denied(q(`UPDATE business_profile_revisions SET website_url='https://other.example' WHERE id=$1`, [rev]), /immutable/, '23000');
      await denied(q(`UPDATE business_profile_revisions SET content_digest=$2 WHERE id=$1`, [rev, 'f'.repeat(64)]), /immutable/, '23000');
      await denied(q(`UPDATE business_profile_revisions SET submitted_by=$2 WHERE id=$1`, [rev, REVIEWER]), /immutable/, '23000');
      await denied(translation(rev, biz, 'es'), /frozen/, '23000');
      await denied(q(`UPDATE business_profile_revision_translations SET display_name='Changed' WHERE revision_id=$1`, [rev]), /frozen/, '23000');
      await denied(q('DELETE FROM business_profile_revision_translations WHERE revision_id=$1', [rev]), /frozen/, '23000');
      await denied(place(rev, biz, 5), /frozen/, '23000');
      await denied(q('DELETE FROM business_profile_revision_locations WHERE revision_id=$1', [rev]), /frozen/, '23000');
      await denied(q('DELETE FROM business_profile_revisions WHERE id=$1', [rev]), /never deleted/, '23000');
    });

    it('lets a draft be edited freely and never inserted in a later status', async () => {
      const biz = await business();
      const rev = await readyDraft(biz);
      await q(`UPDATE business_profile_revision_translations SET display_name='Edited name' WHERE revision_id=$1`, [rev]);
      await q('DELETE FROM business_profile_revision_locations WHERE revision_id=$1', [rev]);
      await place(rev, biz);
      await denied(q(`INSERT INTO business_profile_revisions (business_id, revision_no, status) VALUES ($1,99,'approved')`, [biz]), /starts as a draft/, '23000');
    });

    it('allows only the legal status transitions and makes decided evidence final', async () => {
      const biz = await business();
      const rev = await readyDraft(biz);
      await denied(q(`UPDATE business_profile_revisions SET status='approved', reviewed_by=$2, reviewed_at=now(), content_digest=$3 WHERE id=$1`, [rev, REVIEWER, DIGEST]), /draft revision can only be submitted/, '23000');
      await submit(rev);
      await denied(q(`UPDATE business_profile_revisions SET status='draft' WHERE id=$1`, [rev]), /illegal/, '23000');
      await approve(rev);
      await denied(q(`UPDATE business_profile_revisions SET status='rejected', review_reason_code='MISLEADING_CLAIM' WHERE id=$1`, [rev]), /illegal/, '23000');
      await denied(q(`UPDATE business_profile_revisions SET reviewed_by=$2 WHERE id=$1`, [rev, randomUUID()]), /review evidence/, '23000');
      await q(`UPDATE business_profile_revisions SET status='superseded' WHERE id=$1`, [rev]);
      await denied(q(`UPDATE business_profile_revisions SET review_note_internal='late note' WHERE id=$1`, [rev]), /final/, '23000');
    });

    it('records a rejection only with a reason code, and never a reason on an approval', async () => {
      const biz = await business();
      const rev = await readyDraft(biz);
      await submit(rev);
      await denied(q(`UPDATE business_profile_revisions SET status='rejected', reviewed_by=$2, reviewed_at=now() WHERE id=$1`, [rev, REVIEWER]), /reason_scope/, '23514');
      await denied(q(`UPDATE business_profile_revisions SET status='approved', reviewed_by=$2, reviewed_at=now(), review_reason_code='SPAM' WHERE id=$1`, [rev, REVIEWER]), /reason_scope/, '23514');
      await q(`UPDATE business_profile_revisions SET status='rejected', reviewed_by=$2, reviewed_at=now(), review_reason_code='MISLEADING_CLAIM' WHERE id=$1`, [rev, REVIEWER]);
    });
  });

  describe('separation of duties', () => {
    it('refuses an approval by the submitter, in the database itself', async () => {
      const biz = await business();
      const rev = await readyDraft(biz);
      await submit(rev, SUBMITTER);
      await denied(approve(rev, SUBMITTER), /separation_of_duties/, '23514');
      await approve(rev, REVIEWER);
    });
  });

  describe('publication state machine', () => {
    it('starts unpublished, with no pointer, at version 1, and is never deleted', async () => {
      const biz = await business();
      const rev = await approvedRevision(biz);
      await denied(q(`INSERT INTO business_public_profiles (business_id, profile_handle, publication_state, published_revision_id, published_at) VALUES ($1,$2,'published',$3,now())`, [biz, handle(), rev]), /starts unpublished/, '23000');
      await startProfile(biz);
      expect(await stateOf(biz)).toEqual({ publication_state: 'unpublished', version: 1 });
      await denied(q('DELETE FROM business_public_profiles WHERE business_id=$1', [biz]), /never deleted/, '23000');
    });

    it('goes live only for an approved revision of the same business, and moves the version each time', async () => {
      const biz = await business();
      const draftRev = await readyDraft(biz);
      await startProfile(biz);
      await denied(publish(biz, draftRev), /approved revision/, '23000');
      await submit(draftRev);
      await denied(publish(biz, draftRev), /approved revision/, '23000');
      await approve(draftRev);
      await denied(q(`UPDATE business_public_profiles SET publication_state='published', published_revision_id=$2, published_at=now() WHERE business_id=$1`, [biz, draftRev]), /increments the version/, '23000');
      await publish(biz, draftRev);
      expect(await stateOf(biz)).toEqual({ publication_state: 'published', version: 2 });
    });

    it('withdraws and re-publishes with the pointer kept (D-13), and refuses illegal transitions', async () => {
      const biz = await business();
      const rev = await approvedRevision(biz);
      await startProfile(biz);
      await publish(biz, rev);
      await denied(q(`UPDATE business_public_profiles SET publication_state='withdrawn', published_revision_id=NULL, withdrawn_at=now(), version=version+1 WHERE business_id=$1`, [biz]), /keeps the live revision/, '23000');
      await q(`UPDATE business_public_profiles SET publication_state='withdrawn', withdrawn_at=now(), version=version+1 WHERE business_id=$1`, [biz]);
      expect((await q<{ published_revision_id: string }>('SELECT published_revision_id FROM business_public_profiles WHERE business_id=$1', [biz]))[0]!.published_revision_id).toBe(rev);
      await publish(biz, rev);
      expect((await stateOf(biz)).publication_state).toBe('published');
      await denied(q(`UPDATE business_public_profiles SET publication_state='unpublished', version=version+1 WHERE business_id=$1`, [biz]), /illegal/, '23000');
    });

    it('suspends with evidence, only lifts to unpublished with the evidence cleared, and never jumps back to live', async () => {
      const biz = await business();
      const rev = await approvedRevision(biz);
      await startProfile(biz);
      await publish(biz, rev);
      await denied(q(`UPDATE business_public_profiles SET publication_state='suspended', version=version+1 WHERE business_id=$1`, [biz]), /suspended_fields/, '23514');
      await q(`UPDATE business_public_profiles SET publication_state='suspended', suspended_at=now(), suspended_by=$2, suspension_reason_code='POLICY_BREACH', version=version+1 WHERE business_id=$1`, [biz, ADMIN]);
      await denied(publish(biz, rev), /illegal/, '23000');
      await denied(q(`UPDATE business_public_profiles SET publication_state='unpublished', version=version+1 WHERE business_id=$1`, [biz]), /suspended_fields/, '23514');
      await q(`UPDATE business_public_profiles SET publication_state='unpublished', suspended_at=NULL, suspended_by=NULL, suspension_reason_code=NULL, version=version+1 WHERE business_id=$1`, [biz]);
      expect((await stateOf(biz)).publication_state).toBe('unpublished');
    });

    it('moves the live pointer only forward to a newer approved revision', async () => {
      const biz = await business();
      const first = await approvedRevision(biz);
      await startProfile(biz);
      await publish(biz, first);
      const second = await readyDraft(biz);
      await submit(second);
      await denied(q('UPDATE business_public_profiles SET published_revision_id=$2, version=version+1 WHERE business_id=$1', [biz, second]), /newer approved/, '23000');
      await approve(second);
      await q('UPDATE business_public_profiles SET published_revision_id=$2, version=version+1 WHERE business_id=$1', [biz, second]);
      await denied(q('UPDATE business_public_profiles SET published_revision_id=$2, version=version+1 WHERE business_id=$1', [biz, first]), /newer approved/, '23000');
    });

    it('never changes a handle or an owner', async () => {
      const biz = await business();
      await startProfile(biz);
      await denied(q('UPDATE business_public_profiles SET profile_handle=$2 WHERE business_id=$1', [biz, handle()]), /immutable/, '23000');
      await denied(q('UPDATE business_public_profiles SET business_id=$2 WHERE business_id=$1', [biz, randomUUID()]), undefined);
    });
  });

  describe('guards hold even when someone tries to skip them', () => {
    it('denies TRUNCATE on every guarded table', async () => {
      for (const table of ['business_public_profiles', 'business_profile_revisions', 'business_profile_revision_translations', 'business_profile_revision_locations']) {
        await denied(client.query(`TRUNCATE ${table} CASCADE`), /BUSINESS_PROFILE_TRUNCATE_DENIED/, '23000');
      }
    });

    it('cannot be bypassed with session_replication_role = replica (guards are ENABLE ALWAYS)', async () => {
      const biz = await business();
      const rev = await readyDraft(biz);
      await submit(rev);
      await client.query("SET session_replication_role = 'replica'");
      try {
        await denied(q(`UPDATE business_profile_revisions SET website_url='https://sneaky.example' WHERE id=$1`, [rev]), /immutable/, '23000');
        await denied(q('DELETE FROM business_profile_revisions WHERE id=$1', [rev]), /never deleted/, '23000');
      } finally {
        await client.query("SET session_replication_role = 'origin'");
      }
    });

    it('has every guard trigger enabled for ALWAYS', async () => {
      const rows = await q<{ tgname: string; tgenabled: string }>(
        `SELECT tgname, tgenabled FROM pg_trigger WHERE NOT tgisinternal AND (tgname LIKE 'business_profile_%' OR tgname LIKE 'business_public_profile%')`);
      expect(rows.length).toBeGreaterThanOrEqual(8);
      for (const row of rows) expect(row.tgenabled).toBe('A');
    });
  });

  describe('non-effect and lazy creation', () => {
    it('creates no profile at business registration and adds nothing to existing tables', async () => {
      const ledgers = `SELECT (SELECT count(*) FROM loyalty_accounts) la, (SELECT count(*) FROM loyalty_transactions) lt,
        (SELECT count(*) FROM community_memberships) cm, (SELECT count(*) FROM community_point_accounts) cpa,
        (SELECT count(*) FROM community_point_transactions) cpt, (SELECT count(*) FROM customers) c,
        (SELECT count(*) FROM consent_grants) cg, (SELECT count(*) FROM notifications) n`;
      const before = (await q(ledgers))[0];
      const biz = await business();
      expect(await q('SELECT 1 FROM business_public_profiles WHERE business_id=$1', [biz])).toHaveLength(0);
      expect(await q('SELECT 1 FROM business_profile_revisions WHERE business_id=$1', [biz])).toHaveLength(0);
      const rev = await approvedRevision(biz);
      await startProfile(biz);
      await publish(biz, rev);
      expect((await q(ledgers))[0]).toEqual(before);
      const leaked = await q(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name IN ('businesses','branches','customers','business_categories')
            AND (column_name LIKE '%profile%' OR column_name LIKE '%handle%' OR column_name LIKE '%publication%')`);
      expect(leaked).toEqual([]);
    });
  });
});
