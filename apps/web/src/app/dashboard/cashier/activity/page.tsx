import Link from 'next/link';
import { getTranslations, getFormatter } from 'next-intl/server';
import type { BranchDto } from '@echo-grid-feedback/shared-types';
import { ApiError, apiFetch } from '@/lib/api-client';
import { getActiveBusiness } from '@/lib/business';
import { getMyAccess } from '@/lib/permissions';
import { RestrictedPanel } from '@/components/workspace/restricted-panel';
import { Button } from '@/components/ui';

const CATEGORIES = [
  'customer_lookup',
  'qr_verification',
  'points_issued',
  'redemption_attempt',
  'redemption_success',
  'redemption_failure',
  'session',
  'security',
] as const;

// next-intl message keys cannot contain '.', so stored action names (`loyalty.customer_lookup`) map to `loyalty_customer_lookup`.
const actionKey = (action: string) => action.replaceAll('.', '_');

interface ActivityItem {
  correlationId: string;
  timestamp: string;
  branchId: string | null;
  branchName: string | null;
  actor: { id: string | null; name: string | null };
  action: string;
  outcome: 'success' | 'failure';
  reference: string | null;
}
interface ActivityPage {
  items: ActivityItem[];
  nextCursor: string | null;
}

/**
 * CASHIER-PWA-01 C7: cashier activity history for the dashboard. Read-only over the API's business-scoped route; the
 * API decides who may read and which branches they see (Owner/Admin all, Manager their authorized branches), so this
 * page only presents. Customer details, QR payloads and session tokens are never part of the response.
 */
export default async function CashierActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; branchId?: string; cursor?: string }>;
}) {
  const t = await getTranslations('cashier.dashboard.activity');
  const format = await getFormatter();
  const access = await getMyAccess();
  if (!access.known) return <RestrictedPanel variant="unavailable" />;
  if (!access.permissions.has('audit:view') && !access.permissions.has('loyalty:accounts:view')) {
    return <p className="mx-auto max-w-3xl px-4 py-8 text-sm">{t('noAccess')}</p>;
  }

  const sp = await searchParams;
  const category = (CATEGORIES as readonly string[]).includes(sp.category ?? '') ? sp.category : undefined;
  const branchId = sp.branchId && /^[0-9a-f-]{36}$/i.test(sp.branchId) ? sp.branchId : undefined;
  const business = await getActiveBusiness();
  if (!business) return <RestrictedPanel variant="unavailable" />;

  const query = new URLSearchParams({ limit: '25' });
  if (category) query.set('category', category);
  if (branchId) query.set('branchId', branchId);
  if (sp.cursor) query.set('cursor', sp.cursor);

  const [branches, result] = await Promise.all([
    apiFetch<BranchDto[]>('/branches', { businessId: business.id }).catch(() => [] as BranchDto[]),
    apiFetch<ActivityPage>(`/cashier-activity?${query.toString()}`, {
      businessId: business.id,
      // A branch-scoped manager must name the branch they are acting for; business-wide roles may omit it.
      ...(branchId ? { branchId } : {}),
      cache: 'no-store',
    }).catch((err: unknown) => ({ error: err instanceof ApiError ? err.code : 'ERROR' })),
  ]);

  const older = (cursor: string) => {
    const p = new URLSearchParams();
    if (category) p.set('category', category);
    if (branchId) p.set('branchId', branchId);
    p.set('cursor', cursor);
    return `/dashboard/cashier/activity?${p.toString()}`;
  };

  return (
    <section className="mx-auto max-w-5xl space-y-6 px-4 py-8">
      <header className="space-y-1">
        <Link href="/dashboard/cashier" className="text-sm text-neutral-600 underline">
          {t('back')}
        </Link>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-neutral-600">{t('subtitle')}</p>
      </header>

      <form method="get" className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-sm">
          <span className="block font-medium">{t('filters.category')}</span>
          <select name="category" defaultValue={category ?? ''} className="h-10 rounded-md border border-neutral-300 bg-white px-2">
            <option value="">{t('filters.all')}</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`categories.${c}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="block font-medium">{t('filters.branch')}</span>
          <select name="branchId" defaultValue={branchId ?? ''} className="h-10 rounded-md border border-neutral-300 bg-white px-2">
            <option value="">{t('filters.allBranches')}</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="secondary">
          {t('filters.apply')}
        </Button>
      </form>

      {'error' in result ? (
        <p role="alert" className="text-sm text-red-700">
          {result.error === 'BRANCH_CONTEXT_REQUIRED' ? t('branchRequired') : result.error === 'PERMISSION_DENIED' ? t('noAccess') : t('loadFailed')}
        </p>
      ) : result.items.length === 0 ? (
        <p className="rounded-md border border-neutral-200 bg-white p-4 text-sm text-neutral-600">{t('empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-neutral-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-neutral-200 text-neutral-500">
              <tr>
                {(['when', 'what', 'who', 'branch', 'outcome', 'reference'] as const).map((k) => (
                  <th key={k} scope="col" className="px-3 py-2 font-medium">
                    {t(`columns.${k}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {result.items.map((i) => (
                <tr key={i.correlationId}>
                  <td className="whitespace-nowrap px-3 py-2">{format.dateTime(new Date(i.timestamp), { dateStyle: 'medium', timeStyle: 'short' })}</td>
                  <td className="px-3 py-2">{t.has(`actions.${actionKey(i.action)}`) ? t(`actions.${actionKey(i.action)}`) : i.action}</td>
                  <td className="px-3 py-2">{i.actor.name ?? '—'}</td>
                  <td className="px-3 py-2">{i.branchName ?? t('businessWide')}</td>
                  <td className="px-3 py-2">{t(`outcome.${i.outcome}`)}</td>
                  <td className="px-3 py-2 font-mono text-xs" title={t('correlation')}>
                    {(i.reference ?? i.correlationId).slice(0, 8)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!('error' in result) && result.nextCursor && (
        <Link href={older(result.nextCursor)} className="inline-block text-sm underline">
          {t('older')}
        </Link>
      )}
    </section>
  );
}
