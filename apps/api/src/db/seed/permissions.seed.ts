import 'dotenv/config';
import { Client } from 'pg';
import { buildDb } from '../client';
import { PermissionRepository, type NewPermission } from '../../repositories/permission.repository';

/**
 * The platform-defined permission catalog (see schema comment on
 * permissions.ts for why this is global, not tenant-created). Add new
 * entries here as features ship, then re-run the seed -- ensure() is
 * idempotent, so this is safe to run on every deploy.
 */
const PERMISSIONS: NewPermission[] = [
  { key: 'business:view', description: 'View business profile and settings.', category: 'Business' },
  {
    key: 'business:manage_settings',
    description: 'Edit business profile and settings.',
    category: 'Business',
  },
  { key: 'business:delete', description: 'Permanently delete the business.', category: 'Business' },
  { key: 'branches:view', description: 'View branches.', category: 'Branches' },
  { key: 'branches:manage', description: 'Create, edit, and delete branches.', category: 'Branches' },
  { key: 'team:view', description: 'View team members and their roles.', category: 'Team' },
  { key: 'team:invite', description: 'Invite new team members and grant roles.', category: 'Team' },
  { key: 'team:remove', description: "Remove a team member's access.", category: 'Team' },
  { key: 'roles:view', description: 'View roles and their permissions.', category: 'Roles' },
  {
    key: 'roles:manage',
    description: 'Create, edit, and delete roles and their permission assignments.',
    category: 'Roles',
  },
  { key: 'audit:view', description: 'View the business audit log.', category: 'Audit' },
  {
    key: 'feedback:view',
    description: 'View customer feedback submissions.',
    category: 'Feedback',
  },
  {
    key: 'feedback:manage',
    description: 'Mark feedback as reviewed and remove inappropriate submissions.',
    category: 'Feedback',
  },
  {
    key: 'loyalty:view',
    description: 'View customer loyalty accounts, balances, and transaction history.',
    category: 'Loyalty',
  },
  {
    key: 'loyalty:manage',
    description: 'Record purchases/check-ins and confirm reward redemptions at the counter.',
    category: 'Loyalty',
  },
  {
    key: 'rewards:manage',
    description: 'Configure loyalty tiers and the reward catalog (program design).',
    category: 'Loyalty',
  },
  {
    key: 'analytics:view',
    description: 'View sentiment trends, searchable feedback, and AI-generated summaries.',
    category: 'Analytics',
  },
  {
    key: 'analytics:manage',
    description: 'Trigger on-demand AI summary generation (incurs real API cost per run).',
    category: 'Analytics',
  },
  {
    key: 'notifications:view',
    description: 'View business-wide notification settings and the notification send log.',
    category: 'Notifications',
  },
  {
    key: 'notifications:manage',
    description: 'Configure business-wide notification channel kill switches and the daily SMS cap.',
    category: 'Notifications',
  },
  {
    key: 'billing:view',
    description: 'View the current plan, trial/subscription status, and billing history.',
    category: 'Billing',
  },
  {
    key: 'billing:manage',
    description: 'Change plan, update payment method, and cancel the subscription.',
    category: 'Billing',
  },
  {
    key: 'messages:view',
    description: 'View customer message conversations and their contents.',
    category: 'Messages',
  },
  {
    key: 'messages:send',
    description: 'Send a message to a customer and reply within a conversation.',
    category: 'Messages',
  },
];

/**
 * Connects directly via DATABASE_URL, same as drizzle-kit -- not through
 * Hyperdrive, which only exists inside a deployed/dev Worker. Run with:
 *   pnpm --filter @echo-grid-feedback/api db:seed
 */
async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const repo = new PermissionRepository(buildDb(client));

  for (const permission of PERMISSIONS) {
    await repo.ensure(permission);
    console.log(`Ensured permission: ${permission.key}`);
  }

  await client.end();
}

main().catch((err) => {
  console.error('Permission seed failed:', err);
  process.exit(1);
});
