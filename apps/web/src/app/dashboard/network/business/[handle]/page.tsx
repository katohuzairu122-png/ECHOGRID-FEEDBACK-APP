import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActiveBusiness } from '@/lib/business';
import { apiFetch } from '@/lib/api-client';
import { getMyAccess } from '@/lib/permissions';
import { managementGate } from '@/lib/workspace-guard';
import { createB2bRequestAction, reportB2bItemAction } from '@/lib/actions/b2b';

type Profile = {
  businessId: string;
  handle: string;
  category: string | null;
  displayName: string;
  summary: string | null;
  description: string | null;
  websiteUrl: string | null;
  locations: Array<{
    label: string;
    city: string | null;
    region: string | null;
    countryCode: string | null;
  }>;
};

export default async function BusinessNetworkProfilePage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');
  const blocked = await managementGate();
  if (blocked) return blocked;
  if (!(await getMyAccess()).permissions.has('b2b:view'))
    return <p role="alert">Business Network access is not available for your role.</p>;
  const { handle } = await params;
  let profile: Profile;
  try {
    profile = await apiFetch<Profile>(`/b2b/directory/${encodeURIComponent(handle)}`, {
      businessId: business.id,
    });
  } catch {
    notFound();
  }
  const t = await getTranslations('b2b.dashboard');
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5 p-4 md:p-8">
      <Link href="/dashboard/network" className="text-sm underline">
        ← {t('title')}
      </Link>
      <article className="rounded-xl border p-6">
        <h1 className="text-3xl font-semibold">{profile.displayName}</h1>
        {profile.category && <p className="mt-2 text-neutral-600">{profile.category}</p>}
        {profile.summary && <p className="mt-4 text-lg">{profile.summary}</p>}
        {profile.description && <p className="mt-4 whitespace-pre-wrap">{profile.description}</p>}
        {profile.locations.length > 0 && (
          <section className="mt-5">
            <h2 className="font-semibold">Locations</h2>
            <ul className="mt-2 list-inside list-disc">
              {profile.locations.map((location, index) => (
                <li key={`${location.label}-${index}`}>
                  {location.label} ·{' '}
                  {[location.city, location.region, location.countryCode]
                    .filter(Boolean)
                    .join(', ')}
                </li>
              ))}
            </ul>
          </section>
        )}
        {profile.websiteUrl && (
          <p className="mt-4">
            <a
              href={profile.websiteUrl}
              rel="noopener noreferrer"
              target="_blank"
              className="underline"
            >
              {profile.websiteUrl}
            </a>
          </p>
        )}
        <form
          action={createB2bRequestAction.bind(null, profile.handle)}
          className="mt-6 grid gap-2"
        >
          <label htmlFor="reason">{t('requestReason')}</label>
          <textarea
            id="reason"
            name="reason"
            required
            maxLength={1000}
            className="min-h-24 rounded border p-3"
          />
          <button className="justify-self-start rounded bg-slate-900 px-4 py-2 text-white">
            {t('sendRequest')}
          </button>
        </form>
        <form
          action={reportB2bItemAction.bind(
            null,
            profile.businessId,
            'business',
            profile.businessId,
          )}
          className="mt-4 flex gap-2"
        >
          <label htmlFor="report-reason" className="sr-only">
            {t('reportReason')}
          </label>
          <select
            id="report-reason"
            name="reasonCode"
            defaultValue="other"
            className="rounded border p-2"
          >
            <option value="spam">spam</option>
            <option value="harassment">harassment</option>
            <option value="misrepresentation">misrepresentation</option>
            <option value="unauthorized_content">unauthorized content</option>
            <option value="other">other</option>
          </select>
          <button className="rounded border px-4 py-2">{t('report')}</button>
        </form>
      </article>
    </main>
  );
}
