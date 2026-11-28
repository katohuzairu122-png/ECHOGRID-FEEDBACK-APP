import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActiveBusiness } from '@/lib/business';
import { apiFetch } from '@/lib/api-client';
import { getMyAccess } from '@/lib/permissions';
import { managementGate } from '@/lib/workspace-guard';
import {
  createB2bRequestAction,
  b2bRequestAction,
  terminateB2bPartnershipAction,
  markB2bNotificationReadAction,
  reportB2bItemAction,
} from '@/lib/actions/b2b';

type Participation = { status: 'active' | 'suspended' | 'not_enrolled' };
type Page<T> = { data: T[]; page: { hasMore?: boolean } };
type Profile = {
  businessId: string;
  handle: string;
  category: string | null;
  displayName: string;
  summary: string | null;
  description: string | null;
  websiteUrl: string | null;
  available: boolean;
  locations: Array<{
    label: string;
    city: string | null;
    region: string | null;
    countryCode: string | null;
  }>;
};
type Directory = {
  data: Profile[];
  categories: Array<{ id: string; name: string; groupKey: string | null }>;
  page: { hasMore: boolean };
};
type Request = {
  id: string;
  requesterBusinessId: string;
  targetBusinessId: string;
  status: string;
  reason: string;
  expiresAt: string;
  createdAt: string;
};
type Partnership = {
  id: string;
  status: string;
  counterpartyBusinessId: string;
  createdAt: string;
};
type Notice = {
  notification: { id: string; eventType: string; subject: string; body: string; createdAt: string };
  readAt: string | null;
};
type Unread = { partnershipId: string; count: number };

async function maybe<T>(path: string, businessId: string): Promise<T | null> {
  try {
    return await apiFetch<T>(path, { businessId });
  } catch {
    return null;
  }
}

export default async function BusinessNetworkPage({
  searchParams,
}: {
  searchParams?: Promise<{
    q?: string;
    categoryId?: string;
    city?: string;
    countryCode?: string;
    error?: string;
  }>;
}) {
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');
  const blocked = await managementGate();
  if (blocked) return blocked;
  const access = await getMyAccess();
  if (!access.permissions.has('b2b:view'))
    return <p role="alert">Business Network access is not available for your role.</p>;
  const t = await getTranslations('b2b.dashboard');
  const filters = await searchParams;
  const [participation, directory, incoming, outgoing, partnerships, notifications, unread] =
    await Promise.all([
      maybe<Participation>('/b2b/participation', business.id),
      maybe<Directory>(
        `/b2b/directory?limit=20${filters?.q ? `&q=${encodeURIComponent(filters.q)}` : ''}${filters?.categoryId ? `&categoryId=${encodeURIComponent(filters.categoryId)}` : ''}${filters?.city ? `&city=${encodeURIComponent(filters.city)}` : ''}${filters?.countryCode ? `&countryCode=${encodeURIComponent(filters.countryCode)}` : ''}`,
        business.id,
      ),
      maybe<Page<Request>>('/b2b/partnership-requests/incoming?limit=20', business.id),
      maybe<Page<Request>>('/b2b/partnership-requests/outgoing?limit=20', business.id),
      maybe<Page<Partnership>>('/b2b/partnerships?limit=50', business.id),
      maybe<Page<Notice>>('/b2b/notifications?limit=20', business.id),
      maybe<{ data: Unread[] }>('/b2b/unread', business.id),
    ]);
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-8 p-4 md:p-8">
      <header>
        <h1 className="text-3xl font-semibold">{t('title')}</h1>
        <p className="mt-2 text-neutral-600">{t('description')}</p>
      </header>
      {filters?.error && (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 p-3">
          {t('error')}
        </p>
      )}
      {filters?.error === undefined && filters && (
        <p role="status" className="sr-only">
          {t('updated')}
        </p>
      )}
      <section aria-labelledby="participation-title" className="rounded-xl border p-5">
        <h2 id="participation-title" className="text-xl font-semibold">
          {t('participation')}
        </h2>
        {!participation || participation.status === 'not_enrolled' ? (
          <p className="mt-2 text-neutral-600">{t('notEnrolled')}</p>
        ) : (
          <p className="mt-2">{participation.status === 'active' ? t('active') : t('suspended')}</p>
        )}
      </section>
      <section aria-labelledby="directory-title" className="rounded-xl border p-5">
        <h2 id="directory-title" className="text-xl font-semibold">
          {t('directory')}
        </h2>
        <form method="get" className="my-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="grid gap-1 text-sm">
            {t('search')}
            <input
              name="q"
              defaultValue={filters?.q}
              maxLength={80}
              className="rounded border px-3 py-2"
            />
          </label>
          <label className="grid gap-1 text-sm">
            {t('category')}
            <select
              name="categoryId"
              defaultValue={filters?.categoryId ?? ''}
              className="rounded border px-3 py-2"
            >
              <option value="">—</option>
              {directory?.categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            {t('city')}
            <input
              name="city"
              defaultValue={filters?.city}
              maxLength={80}
              className="rounded border px-3 py-2"
            />
          </label>
          <label className="grid gap-1 text-sm">
            {t('country')}
            <input
              name="countryCode"
              defaultValue={filters?.countryCode}
              maxLength={2}
              className="rounded border px-3 py-2"
            />
          </label>
          <button className="rounded bg-slate-900 px-4 py-2 text-white sm:col-span-2 lg:col-span-4">
            {t('applyFilters')}
          </button>
        </form>
        {!directory ? (
          <p className="text-neutral-600">{t('notEnrolled')}</p>
        ) : directory.data.length === 0 ? (
          <p>{t('empty')}</p>
        ) : (
          <ul className="grid gap-4 md:grid-cols-2">
            {directory.data.map((profile) => (
              <li key={profile.businessId} className="rounded-lg bg-neutral-50 p-4">
                <h3 className="font-semibold">
                  <Link
                    href={`/dashboard/network/business/${profile.handle}`}
                    className="underline"
                  >
                    {profile.displayName}
                  </Link>
                </h3>
                {profile.category && <p className="text-sm text-neutral-600">{profile.category}</p>}
                {profile.summary && <p className="mt-2">{profile.summary}</p>}
                {profile.locations[0] && (
                  <p className="mt-2 text-sm text-neutral-600">
                    {[
                      profile.locations[0].city,
                      profile.locations[0].region,
                      profile.locations[0].countryCode,
                    ]
                      .filter(Boolean)
                      .join(', ')}
                  </p>
                )}
                <p className="mt-2 text-sm">
                  {profile.available ? t('available') : t('alreadyPartnered')}
                </p>
                {profile.available && (
                  <form
                    action={createB2bRequestAction.bind(null, profile.handle)}
                    className="mt-3 grid gap-2"
                  >
                    <label className="grid gap-1 text-sm">
                      {t('requestReason')}
                      <textarea
                        name="reason"
                        required
                        minLength={1}
                        maxLength={1000}
                        className="rounded border p-2"
                      />
                    </label>
                    <button className="justify-self-start rounded bg-slate-900 px-3 py-2 text-sm text-white">
                      {t('sendRequest')}
                    </button>
                  </form>
                )}
                <form
                  action={reportB2bItemAction.bind(
                    null,
                    profile.businessId,
                    'business',
                    profile.businessId,
                  )}
                  className="mt-3 flex flex-wrap items-center gap-2"
                >
                  <label htmlFor={`report-${profile.businessId}`} className="sr-only">
                    {t('reportReason')}
                  </label>
                  <select
                    id={`report-${profile.businessId}`}
                    name="reasonCode"
                    className="rounded border px-2 py-1 text-sm"
                    defaultValue="other"
                  >
                    <option value="spam">spam</option>
                    <option value="misrepresentation">misrepresentation</option>
                    <option value="unauthorized_content">unauthorized content</option>
                    <option value="harassment">harassment</option>
                    <option value="other">other</option>
                  </select>
                  <button className="text-sm underline">{t('report')}</button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>
      <div className="grid gap-6 md:grid-cols-2">
        <RequestList
          title={t('incoming')}
          requests={incoming?.data ?? []}
          direction="incoming"
          empty={t('empty')}
          actionLabels={t}
        />
        <RequestList
          title={t('outgoing')}
          requests={outgoing?.data ?? []}
          direction="outgoing"
          empty={t('empty')}
          actionLabels={t}
        />
      </div>
      <section className="rounded-xl border p-5">
        <h2 className="text-xl font-semibold">{t('partnerships')}</h2>
        {!partnerships?.data.length ? (
          <p className="mt-3">{t('empty')}</p>
        ) : (
          <ul className="mt-3 divide-y">
            {partnerships.data.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <span>
                  {p.counterpartyBusinessId.slice(0, 8)} · {p.status}
                  {(unread?.data.find((item) => item.partnershipId === p.id)?.count ?? 0) > 0
                    ? ` · ${unread?.data.find((item) => item.partnershipId === p.id)?.count} unread`
                    : ''}
                </span>
                <div className="flex gap-2">
                  <Link
                    className="rounded border px-3 py-2 text-sm"
                    href={`/dashboard/network/${p.id}`}
                  >
                    {t('openConversation')}
                  </Link>
                  <form action={terminateB2bPartnershipAction.bind(null, p.id)}>
                    <button className="rounded border border-red-300 px-3 py-2 text-sm">
                      {t('terminate')}
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="rounded-xl border p-5">
        <h2 className="text-xl font-semibold">{t('notifications')}</h2>
        {!notifications?.data.length ? (
          <p className="mt-3">{t('empty')}</p>
        ) : (
          <ul className="mt-3 divide-y">
            {notifications.data.map(({ notification, readAt }) => (
              <li key={notification.id} className="flex items-start justify-between gap-3 py-3">
                <div>
                  <h3 className="font-medium">{notification.subject}</h3>
                  <p className="text-sm text-neutral-600">{notification.body}</p>
                </div>
                {!readAt && (
                  <form action={markB2bNotificationReadAction.bind(null, notification.id)}>
                    <button className="text-sm underline">{t('markRead')}</button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function RequestList({
  title,
  requests,
  direction,
  empty,
  actionLabels,
}: {
  title: string;
  requests: Request[];
  direction: 'incoming' | 'outgoing';
  empty: string;
  actionLabels: (key: 'accept' | 'reject' | 'cancel' | 'empty') => string;
}) {
  return (
    <section className="rounded-xl border p-5">
      <h2 className="text-xl font-semibold">{title}</h2>
      {!requests.length ? (
        <p className="mt-3">{empty}</p>
      ) : (
        <ul className="mt-3 divide-y">
          {requests.map((request) => (
            <li key={request.id} className="py-3">
              <p className="font-medium">
                {request.status} · {request.id.slice(0, 8)}
              </p>
              <p className="mt-1 text-sm text-neutral-600">{request.reason}</p>
              {request.status === 'pending' && (
                <div className="mt-2 flex gap-2">
                  {(direction === 'incoming'
                    ? (['accept', 'reject'] as const)
                    : (['cancel'] as const)
                  ).map((action) => (
                    <form key={action} action={b2bRequestAction.bind(null, action, request.id)}>
                      <button className="rounded border px-3 py-2 text-sm">
                        {actionLabels(action)}
                      </button>
                    </form>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
