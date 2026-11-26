import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { buildDb } from '../../../src/db/client';
import { createRepositories } from '../../../src/repositories';
import { ShuffleCampaignService } from '../../../src/shuffle/shuffle-campaign.service';
import { ShuffleParticipationService } from '../../../src/shuffle/shuffle-participation.service';
import { DropSponsorshipService } from '../../../src/drops/drop-sponsorship.service';
import { GovernanceDecisionPolicyService } from '../../../src/governance/governance-policy.service';
import { hashSpec, parseQualificationSpec } from '../../../src/qualification/qualification-spec';
import { signAccessToken } from '../../../src/auth/jwt';

/**
 * Synthetic-only fixtures for the Tentaship acceptance tests: they drive the REAL services against a disposable PostgreSQL. The approved qualification rule
 * exists ONLY inside the disposable test database. Nothing here talks to a shared environment.
 */
export const SECRET = 'tentaship-fixture-access-secret';
export const run = randomUUID();
export const tag = run.replace(/[0-9-]/g, (d) => 'abcdefghijk'[d.charCodeAt(0) % 11] as string);
export const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

export function makeFixtures(client: Client) {
  const db = buildDb(client);
  const repos = createRepositories(db);
  let seq = 0;
  const q = async (text: string, values: unknown[] = []) => (await client.query(text, values)).rows;
  const ctx = (actorUserId: string) => ({ actorUserId });
  const key = (p: string) => `${p}_${tag}_${++seq}`.toLowerCase().slice(0, 60);

  async function user(label: string, admin = true) {
    const id = (await repos.users.create({ email: `${label}-${run}@example.test`, fullName: label, passwordHash: 'x', status: 'active' })).id;
    if (admin) await q(`UPDATE users SET platform_role='admin' WHERE id=$1`, [id]);
    return { id, token: await signAccessToken(id, SECRET) };
  }
  let granter: string | null = null;
  /** Synthetic approved decision policies (structural rules only) exist for every kind and family so decisions and overrides can be exercised; production has none until the Owner approves them. */
  async function ensurePolicies() {
    const have = new Set((await q(`SELECT kind || ':' || subject_family AS k FROM governance_decision_policies WHERE approval_state = 'approved'`)).map((r) => r.k as string));
    const author = await user(`pol-author`, false); const approver = await user(`pol-approver`, false);
    const svc = new GovernanceDecisionPolicyService(db);
    for (const family of ['shuffle', 'drops'] as const) for (const kind of ['fraud', 'dispute', 'override'] as const) {
      if (have.has(`${kind}:${family}`)) continue;
      const params = kind === 'override' ? { allowedScopes: ['cancel_entry_before_selection', 'release_reserved_hold'] } : { allowedDecisions: ['upheld', 'overturned', 'no_action'], minEvidenceItems: 0 };
      const d = await svc.createDraft({ policyKey: `syn_${kind}_${family}_${tag}`.slice(0, 60), kind, subjectFamily: family, parameters: params }, ctx(author.id));
      await svc.approve(d.id, ctx(approver.id));
    }
  }
  async function operator(userId: string, role: 'fraud_investigator' | 'dispute_resolver', o: { scope?: 'shuffle' | 'drops' | 'both'; expiresAt?: Date | null } = {}) {
    if (!granter) { granter = (await user('op-granter', false)).id; await ensurePolicies(); }
    await q(`UPDATE governance_operators SET active=false, revoked_at=now(), revoked_by_user_id=$2, revocation_reason='synthetic fixture reset' WHERE user_id=$1 AND role=$3 AND revoked_at IS NULL`, [userId, granter, role]);
    return (await q(`INSERT INTO governance_operators (user_id, role, scope, expires_at, assigned_by_user_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [userId, role, o.scope ?? 'both', o.expiresAt ?? null, granter]))[0].id as string;
  }
  async function rule(approverId: string, approved = true) {
    const spec = parseQualificationSpec({ combinator: 'ALL', pathways: [{ metric: 'recorded_purchases', threshold: 1 }] });
    const id = (await q(`INSERT INTO qualification_rule_versions (rule_key, version, participant_type, spec, spec_hash, created_by_user_id) VALUES ($1,1,'customer',$2,$3,$4) RETURNING id`, [key('rule'), JSON.stringify(spec), hashSpec(spec), approverId]))[0].id as string;
    if (approved) await q(`UPDATE qualification_rule_versions SET approval_state='approved', approved_at=now(), approved_by_user_id=$2 WHERE id=$1`, [id, approverId]);
    return id;
  }
  async function business(label: string) { return (await repos.businesses.create({ name: `${label} ${tag}`, slug: `${label}-${run}`.slice(0, 60) })).id; }
  async function customer(opts: { businessId?: string; purchase?: boolean } = {}) {
    const id = (await repos.customers.create({ phone: `+1556${String(Date.now()).slice(-5)}${String(++seq).padStart(2, '0')}` })).id;
    if (opts.purchase && opts.businessId) {
      const m = (await q(`INSERT INTO business_customer_memberships (customer_id, business_id, status) VALUES ($1,$2,'active') RETURNING id`, [id, opts.businessId]))[0].id;
      const a = (await q(`INSERT INTO loyalty_accounts (customer_id, business_id, membership_id) VALUES ($1,$2,$3) RETURNING id`, [id, opts.businessId, m]))[0].id;
      await q(`INSERT INTO loyalty_purchase_events (business_id, customer_id, membership_id, loyalty_account_id, idempotency_key, qualifying_amount) VALUES ($1,$2,$3,$4,$5,20)`, [opts.businessId, id, m, a, randomUUID()]);
    }
    return id;
  }
  const shuffle = new ShuffleCampaignService(db);
  const part = new ShuffleParticipationService(db);
  const drops = new DropSponsorshipService(db);

  /** A synthetic Shuffle campaign with `entries` admitted entries created by `creatorId`. */
  async function shuffleScenario(o: { creatorId: string; businessId: string; ruleId: string; entries: number; mode?: 'limited' | 'guaranteed'; min?: number; max?: number }) {
    const created = await shuffle.createCampaign({
      key: key('sh'), mode: o.mode ?? 'limited', qualificationRuleVersionId: o.ruleId, minParticipants: o.min ?? 1, maxCapacity: o.max ?? 50,
      qualificationWindowStart: new Date(Date.now() - 3_600_000), qualificationWindowEnd: new Date(Date.now() + 86_400_000), entryAcceptanceDeadline: new Date(Date.now() + 172_800_000),
      disclosure: { en: 'Synthetic disclosure: the outcome is determined by the server after the entry deadline.' }, termsVersion: 'draft-1', closureConditions: 'Closes at the deadline.', cancellationConditions: 'May be cancelled before selection.',
    }, ctx(o.creatorId));
    const versionId = created.version.id; const entryIds: string[] = []; const customers: string[] = [];
    for (let i = 0; i < o.entries; i++) {
      const cid = await customer({ businessId: o.businessId, purchase: true });
      await shuffle.takeEligibilitySnapshot(versionId, cid, ctx(o.creatorId));
      const inv = await part.issueInvitation(versionId, cid, new Date(Date.now() + 3_600_000), ctx(o.creatorId));
      const acc = await part.accept(inv.invitation.id, { termsVersion: created.version.termsVersion, disclosureHash: created.version.disclosureHash }, ctx(o.creatorId));
      entryIds.push(acc.entry.id); customers.push(cid);
    }
    return { campaignId: created.campaign.id, versionId, version: created.version, entryIds, customers };
  }

  /** A synthetic available sponsorship (creator and reviewer must differ) with optional reservations/allocations for eligible customers. */
  async function dropScenario(o: { creatorId: string; reviewerId: string; businessId: string; ruleId: string; quantity: number; reserve?: number; allocate?: number; collectionWindowEndMs?: number }) {
    const c = await drops.create({
      key: key('dp'), businessId: o.businessId, productName: 'Synthetic item', description: 'A synthetic, non-commercial test unit.', quantityTotal: o.quantity, collectionMethod: 'In person', collectionLocation: 'Synthetic counter',
      collectionWindowStart: new Date(Date.now() - 3_600_000), collectionWindowEnd: new Date(Date.now() + (o.collectionWindowEndMs ?? 86_400_000)), offerExpiresAt: new Date(Date.now() + 86_400_000), qualificationRuleVersionId: o.ruleId,
    }, ctx(o.creatorId));
    const id = c.sponsorship.id;
    await drops.move(id, 'submitted', ctx(o.creatorId)); await drops.move(id, 'under_review', ctx(o.creatorId));
    await drops.move(id, 'approved', ctx(o.reviewerId)); await drops.move(id, 'scheduled', ctx(o.reviewerId)); await drops.move(id, 'available', ctx(o.reviewerId));
    const reservationIds: string[] = []; const customers: string[] = [];
    for (let i = 0; i < (o.reserve ?? 0); i++) {
      const cid = await customer({ businessId: o.businessId, purchase: true });
      const r = await drops.reserve(id, cid, new Date(Date.now() + 3_600_000), ctx(o.reviewerId)); reservationIds.push(r.reservation.id); customers.push(cid);
      if (i < (o.allocate ?? 0)) await drops.allocate(r.reservation.id, ctx(o.reviewerId));
    }
    return { sponsorshipId: id, reservationIds, customers };
  }
  return { db, repos, q, ctx, user, operator, ensurePolicies, rule, business, customer, shuffle, part, drops, shuffleScenario, dropScenario, key };
}
