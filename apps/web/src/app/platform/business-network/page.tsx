import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api-client';

type Report = {
  id: string;
  reporterBusinessId: string;
  targetBusinessId: string;
  resourceType: string;
  resourceId: string;
  reasonCode: string;
  details: string | null;
  status: string;
  createdAt: string;
};

export default async function BusinessNetworkReportsPage() {
  const t = await getTranslations('b2b.moderation');
  const result = await apiFetch<{ data: Report[] }>('/platform/b2b/reports?status=open&limit=100');
  return (
    <main className="flex flex-col gap-5 p-4 md:p-8">
      <header>
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="mt-2 text-sm text-neutral-600">{t('description')}</p>
      </header>
      {!result.data.length ? (
        <p>{t('empty')}</p>
      ) : (
        <ul className="divide-y rounded-xl border">
          {result.data.map((report) => (
            <li key={report.id} className="flex flex-wrap items-center justify-between gap-4 p-4">
              <div>
                <p className="font-medium">
                  {report.reasonCode} · {report.resourceType}
                </p>
                <p className="text-sm text-neutral-600">
                  {report.details || report.targetBusinessId} ·{' '}
                  {new Date(report.createdAt).toLocaleString()}
                </p>
              </div>
              <Link
                href={`/platform/business-network/${report.id}`}
                className="rounded border px-3 py-2 text-sm"
              >
                {t('details')}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
