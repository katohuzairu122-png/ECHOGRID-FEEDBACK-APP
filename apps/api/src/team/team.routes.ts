import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { createRepositories } from '../repositories';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { resolveTenantContext, type TenantVariables } from '../middleware/tenant-context';
import { requirePermission } from '../middleware/require-permission';
import { requireBusinessWideAccess } from '../middleware/require-business-wide-access';
import type { AuditVariables } from '../middleware/audit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';
import { hashToken } from '../auth/token-hash';
import { createEmailService } from '../notifications/email.service';

type Env = { Bindings: Bindings; Variables: AuthVariables & TenantVariables & AuditVariables };
export const teamRoutes = new Hono<Env>();

const inviteSchema = z.object({ email: z.email(), roleId: z.uuid(), branchId: z.uuid().nullable().optional() });
const updateGrantSchema = z.object({ roleId: z.uuid(), branchId: z.uuid().nullable().optional() });
const invitationLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const normalizeEmail = (email: string) => email.trim().toLowerCase();
const newToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

async function validateScope(repos: ReturnType<typeof createRepositories>, businessId: string, roleId: string, branchId?: string | null) {
  const role = await repos.roles.findById(roleId, businessId);
  if (!role) throw new AppError('Role not found.', 404, 'ROLE_NOT_FOUND');
  if (branchId && !(await repos.branches.findById(branchId, businessId))) {
    throw new AppError('Branch not found.', 404, 'BRANCH_NOT_FOUND');
  }
  return role;
}

async function assertSeatAvailable(repos: ReturnType<typeof createRepositories>, businessId: string, email: string) {
  const existingUser = await repos.users.findByEmail(email);
  if (existingUser && (await repos.userBusinessRoles.listForUserAtBusiness(existingUser.id, businessId)).length) return;
  const subscription = await repos.businessSubscriptions.findByBusinessWithPlan(businessId);
  const maxUsers = subscription?.plan.maxUsers;
  if (maxUsers == null) return;
  const used = await repos.userBusinessRoles.countDistinctUsers(businessId) + await repos.teamInvitations.countPendingDistinctEmails(businessId);
  if (used >= maxUsers) throw new AppError(`Your plan allows ${maxUsers} team members.`, 409, 'TEAM_LIMIT_REACHED');
}

async function sendInvite(c: Context<Env>, invitation: { email: string; id: string }, rawToken: string) {
  const link = `${c.env.WEB_BASE_URL.replace(/\/$/, '')}/invite/${rawToken}`;
  await createEmailService(c.env.ENVIRONMENT, { apiKey: c.env.RESEND_API_KEY, fromAddress: c.env.RESEND_FROM_ADDRESS }).send({
    to: invitation.email,
    subject: 'You have been invited to Echo Grid',
    html: `<p>You have been invited to join an Echo Grid team.</p><p><a href="${link}">Accept invitation</a></p><p>This link expires in 7 days.</p>`,
  });
}

teamRoutes.get('/', authenticate, resolveTenantContext, requireBusinessWideAccess, requirePermission('team:view'), async (c) => {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const repos = createRepositories(db);
    const [members, invitations, roles, branches] = await Promise.all([
      repos.userBusinessRoles.listForBusinessWithDetails(c.get('businessId')),
      repos.teamInvitations.listPending(c.get('businessId')),
      repos.roles.listByBusiness(c.get('businessId')),
      repos.branches.listByBusiness(c.get('businessId')),
    ]);
    return ok(c, { members, invitations: invitations.map(({ tokenHash: _token, ...i }) => i), roles, branches });
  } finally { c.executionCtx.waitUntil(close()); }
});

teamRoutes.post('/invitations', authenticate, resolveTenantContext, requireBusinessWideAccess, requirePermission('team:invite'), async (c) => {
  const body = await parseJsonBody(c.req.raw, inviteSchema);
  const email = normalizeEmail(body.email);
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const repos = createRepositories(db);
    await validateScope(repos, c.get('businessId'), body.roleId, body.branchId);
    await assertSeatAvailable(repos, c.get('businessId'), email);
    const rawToken = newToken();
    const invitation = await repos.teamInvitations.create({ businessId: c.get('businessId'), email, roleId: body.roleId, branchId: body.branchId ?? null, tokenHash: await hashToken(rawToken), expiresAt: new Date(Date.now() + invitationLifetimeMs), invitedBy: c.get('userId') });
    await sendInvite(c, invitation, rawToken);
    c.set('auditMetadata', { action: 'team.invited', entityType: 'team_invitation', entityId: invitation.id, details: { email, roleId: body.roleId, branchId: body.branchId ?? null } });
    const { tokenHash: _token, ...safe } = invitation;
    return ok(c, safe, 201);
  } finally { c.executionCtx.waitUntil(close()); }
});

teamRoutes.post('/invitations/:id/resend', authenticate, resolveTenantContext, requireBusinessWideAccess, requirePermission('team:invite'), async (c) => {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const repos = createRepositories(db); const rawToken = newToken();
    const invitation = await repos.teamInvitations.rotate(c.req.param('id'), c.get('businessId'), await hashToken(rawToken), new Date(Date.now() + invitationLifetimeMs));
    if (!invitation) throw new AppError('Invitation not found.', 404, 'INVITATION_NOT_FOUND');
    await sendInvite(c, invitation, rawToken);
    c.set('auditMetadata', { action: 'team.invitation_resent', entityType: 'team_invitation', entityId: invitation.id });
    return ok(c, { id: invitation.id, expiresAt: invitation.expiresAt });
  } finally { c.executionCtx.waitUntil(close()); }
});

teamRoutes.delete('/invitations/:id', authenticate, resolveTenantContext, requireBusinessWideAccess, requirePermission('team:invite'), async (c) => {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try { const changed = await createRepositories(db).teamInvitations.cancel(c.req.param('id'), c.get('businessId')); if (!changed) throw new AppError('Invitation not found.', 404, 'INVITATION_NOT_FOUND'); c.set('auditMetadata', { action: 'team.invitation_cancelled', entityType: 'team_invitation', entityId: c.req.param('id') }); return ok(c, { cancelled: true }); }
  finally { c.executionCtx.waitUntil(close()); }
});

teamRoutes.post('/invitations/accept', authenticate, async (c) => {
  const { token } = await parseJsonBody(c.req.raw, z.object({ token: z.string().min(32) }));
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const tokenHash = await hashToken(token);
    const userId = c.get('userId');
    const businessId = await db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const now = new Date();
      const invitation = await repos.teamInvitations.findUsableByHash(tokenHash, now);
      if (!invitation) {
        throw new AppError('Invitation is invalid or expired.', 404, 'INVITATION_INVALID');
      }

      const user = await repos.users.findById(userId);
      if (!user || normalizeEmail(user.email) !== invitation.email) {
        throw new AppError(
          'Sign in with the invited email address.',
          403,
          'INVITATION_EMAIL_MISMATCH',
        );
      }

      await validateScope(repos, invitation.businessId, invitation.roleId, invitation.branchId);
      if (!(await repos.teamInvitations.accept(invitation.id, now))) {
        throw new AppError(
          'Invitation is invalid or expired.',
          409,
          'INVITATION_ALREADY_USED',
        );
      }

      // These writes must commit together. Previously the invitation was
      // consumed first; a later grant/update failure left a permanently
      // unusable link and the browser showed only its generic Retry page.
      await repos.userBusinessRoles.grant({
        userId: user.id,
        businessId: invitation.businessId,
        roleId: invitation.roleId,
        branchId: invitation.branchId,
        createdBy: invitation.invitedBy,
      });
      if (!user.emailVerifiedAt) {
        await repos.users.update(
          user.id,
          { emailVerifiedAt: now, status: 'active' },
          user.id,
        );
      }
      return invitation.businessId;
    });

    return ok(c, { businessId });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

teamRoutes.patch('/members/:grantId', authenticate, resolveTenantContext, requireBusinessWideAccess, requirePermission('roles:manage'), async (c) => {
  const body = await parseJsonBody(c.req.raw, updateGrantSchema); const businessId = c.get('businessId');
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const repos = createRepositories(db); const current = await repos.userBusinessRoles.findActive(c.req.param('grantId'), businessId);
    if (!current) throw new AppError('Team member grant not found.', 404, 'TEAM_GRANT_NOT_FOUND');
    const nextRole = await validateScope(repos, businessId, body.roleId, body.branchId);
    const currentRole = await repos.roles.findById(current.roleId, businessId);
    const members = await repos.userBusinessRoles.listForBusinessWithDetails(businessId);
    if (currentRole?.name === 'Owner' && current.branchId === null && (nextRole.name !== 'Owner' || body.branchId) && members.filter((m) => m.roleName === 'Owner' && m.branchId === null).length <= 1) throw new AppError('A business must keep at least one owner.', 409, 'LAST_OWNER');
    await repos.userBusinessRoles.revoke(current.id, c.get('userId'));
    const grant = await repos.userBusinessRoles.grant({ userId: current.userId, businessId, roleId: body.roleId, branchId: body.branchId ?? null, createdBy: c.get('userId') });
    return ok(c, grant);
  } finally { c.executionCtx.waitUntil(close()); }
});

teamRoutes.delete('/members/:grantId', authenticate, resolveTenantContext, requireBusinessWideAccess, requirePermission('team:remove'), async (c) => {
  const businessId = c.get('businessId'); const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const repos = createRepositories(db); const grant = await repos.userBusinessRoles.findActive(c.req.param('grantId'), businessId);
    if (!grant) throw new AppError('Team member grant not found.', 404, 'TEAM_GRANT_NOT_FOUND');
    const role = await repos.roles.findById(grant.roleId, businessId); const members = await repos.userBusinessRoles.listForBusinessWithDetails(businessId);
    if (role?.name === 'Owner' && grant.branchId === null && members.filter((m) => m.roleName === 'Owner' && m.branchId === null).length <= 1) throw new AppError('A business must keep at least one owner.', 409, 'LAST_OWNER');
    await repos.userBusinessRoles.revoke(grant.id, c.get('userId'));
    c.set('auditMetadata', { action: 'team.access_revoked', entityType: 'user_business_role', entityId: grant.id, details: { userId: grant.userId } });
    return ok(c, { revoked: true });
  } finally { c.executionCtx.waitUntil(close()); }
});
