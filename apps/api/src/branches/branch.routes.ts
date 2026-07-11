import { Hono } from 'hono';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { createRepositories } from '../repositories';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { resolveTenantContext, type TenantVariables } from '../middleware/tenant-context';
import { requirePermission } from '../middleware/require-permission';
import type { AuditVariables } from '../middleware/audit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { createBranchSchema, updateBranchSchema } from '@echo-grid-feedback/shared-types';
import { BranchService } from './branch.service';
import { QrCodeService } from '../qr/qr-code.service';

type Env = {
  Bindings: Bindings;
  Variables: AuthVariables & TenantVariables & AuditVariables;
};

export const branchRoutes = new Hono<Env>();

/**
 * Every branch route needs tenant context -- unlike POST /businesses,
 * there is no "bootstrapping" branch action; a branch always belongs to an
 * existing business. All five routes below need the same
 * authenticate -> resolveTenantContext chain, so it's mounted once here
 * rather than repeated per route (business.routes.ts repeats it per-route
 * instead, because its POST / deliberately skips resolveTenantContext --
 * that exception doesn't apply to any branch route).
 */
branchRoutes.use('*', authenticate, resolveTenantContext);

branchRoutes.get('/', requirePermission('branches:view'), async (c) => {
  const url = new URL(c.req.url);
  const limit = Number(url.searchParams.get('limit')) || undefined;
  const offset = Number(url.searchParams.get('offset')) || undefined;

  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const service = new BranchService(createRepositories(db));
    const branches = await service.listBranches(c.get('businessId'), { limit, offset });
    return ok(c, branches);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

branchRoutes.post('/', requirePermission('branches:manage'), async (c) => {
  const body = await parseJsonBody(c.req.raw, createBranchSchema);
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const service = new BranchService(createRepositories(db));
    const branch = await service.createBranch(c.get('businessId'), body, c.get('userId'));

    c.set('auditMetadata', {
      action: 'branch.created',
      entityType: 'branch',
      entityId: branch.id,
      details: { name: branch.name, slug: branch.slug },
    });

    return ok(c, branch, 201);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

branchRoutes.get('/:id', requirePermission('branches:view'), async (c) => {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const service = new BranchService(createRepositories(db));
    const branch = await service.getBranch(c.req.param('id'), c.get('businessId'));
    return ok(c, branch);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

branchRoutes.patch('/:id', requirePermission('branches:manage'), async (c) => {
  const body = await parseJsonBody(c.req.raw, updateBranchSchema);
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const service = new BranchService(createRepositories(db));
    const branch = await service.updateBranch(
      c.req.param('id'),
      c.get('businessId'),
      body,
      c.get('userId'),
    );

    c.set('auditMetadata', {
      action: 'branch.updated',
      entityType: 'branch',
      entityId: branch.id,
      details: { fields: Object.keys(body) },
    });

    return ok(c, branch);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

branchRoutes.delete('/:id', requirePermission('branches:manage'), async (c) => {
  const id = c.req.param('id');
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const service = new BranchService(createRepositories(db));
    await service.deleteBranch(id, c.get('businessId'), c.get('userId'));

    c.set('auditMetadata', {
      action: 'branch.deleted',
      entityType: 'branch',
      entityId: id,
    });

    return c.body(null, 204);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/**
 * QR management is nested here (rather than in qr/qr.routes.ts, which owns
 * only the public /qr/:token surface) because these two routes are
 * URL-namespaced under /branches/:id -- route ownership follows URL
 * structure. Response is deliberately {id, token, status} only, no full
 * scannable URL: the web app knows its own base URL already, so building
 * "https://{domain}/feedback/{token}" is a frontend concern, keeping the
 * API from having to know its own frontend's deployed domain.
 */
branchRoutes.get('/:id/qr-code', requirePermission('branches:view'), async (c) => {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const repos = createRepositories(db);
    await new BranchService(repos).getBranch(c.req.param('id'), c.get('businessId'));

    const qrCode = await new QrCodeService(repos).getOrCreateActiveForBranch(
      c.req.param('id'),
      c.get('businessId'),
      c.get('userId'),
    );
    return ok(c, { id: qrCode.id, token: qrCode.token, status: qrCode.status });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

branchRoutes.post('/:id/qr-code/regenerate', requirePermission('branches:manage'), async (c) => {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const repos = createRepositories(db);
    await new BranchService(repos).getBranch(c.req.param('id'), c.get('businessId'));

    const qrCode = await new QrCodeService(repos).regenerate(
      c.req.param('id'),
      c.get('businessId'),
      c.get('userId'),
    );

    c.set('auditMetadata', {
      action: 'qr_code.regenerated',
      entityType: 'qr_code',
      entityId: qrCode.id,
      details: { branchId: c.req.param('id') },
    });

    return ok(c, { id: qrCode.id, token: qrCode.token, status: qrCode.status });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});
