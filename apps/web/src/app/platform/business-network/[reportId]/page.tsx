import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api-client';
import { reviewB2bReportAction } from '@/lib/actions/b2b';

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

type Detail = {
  report: Report;
  resource: null | {
    body?: string;
    reason?: string;
    title?: string;
    description?: string;
    status?: string;
    requesterBusinessId?: string;
    targetBusinessId?: string;
    senderBusinessId?: string;
  };
};

export default async function BusinessNetworkReportDetailPage({
  params,
}: {
  params: Promise<{ reportId: string }>;
}) {
  const { reportId } = await params;
  let detail: Detail;
  try {
    detail = await apiFetch<Detail>(`/platform/b2b/reports/${reportId}`);
  } catch {
    notFound();
  }
  const t = await getTranslations('b2b.moderation');
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5 p-4 md:p-8">
      <Link href="/platform/business-network" className="text-sm underline">
        ← {t('title')}
      </Link>
      <h1 className="text-2xl font-semibold">{t('details')}</h1>
      <section className="rounded-xl border p-5">
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-sm text-neutral-500">Reason</dt>
            <dd>{detail.report.reasonCode}</dd>
          </div>
          <div>
            <dt className="text-sm text-neutral-500">Status</dt>
            <dd>{detail.report.status}</dd>
          </div>
          <div>
            <dt className="text-sm text-neutral-500">Reporter business</dt>
            <dd>{detail.report.reporterBusinessId}</dd>
          </div>
          <div>
            <dt className="text-sm text-neutral-500">Target business</dt>
            <dd>{detail.report.targetBusinessId}</dd>
          </div>
        </dl>
        {detail.report.details && (
          <p className="mt-4 whitespace-pre-wrap">{detail.report.details}</p>
        )}
        {detail.resource && (
          <div className="mt-5 rounded bg-neutral-50 p-4">
            <h2 className="font-semibold">{t('reportedContent')}</h2>
            <p className="mt-2 whitespace-pre-wrap">
              {detail.resource.body ??
                detail.resource.description ??
                detail.resource.reason ??
                detail.resource.title ??
                detail.resource.status}
            </p>
          </div>
        )}
      </section>
      {detail.report.status !== 'resolved' && detail.report.status !== 'dismissed' && (
        <section className="rounded-xl border p-5">
          <form className="grid gap-3">
            <label htmlFor="reason">{t('reason')}</label>
            <textarea
              id="reason"
              name="reason"
              required
              minLength={1}
              maxLength={1000}
              className="min-h-24 rounded border p-3"
            />
            <div className="flex flex-wrap gap-2">
              <button
                formAction={reviewB2bReportAction.bind(null, reportId, 'reviewing')}
                className="rounded border px-3 py-2"
              >
                {t('reviewing')}
              </button>
              <button
                formAction={reviewB2bReportAction.bind(null, reportId, 'resolved')}
                className="rounded bg-slate-900 px-3 py-2 text-white"
              >
                {t('resolved')}
              </button>
              <button
                formAction={reviewB2bReportAction.bind(null, reportId, 'dismissed')}
                className="rounded border px-3 py-2"
              >
                {t('dismissed')}
              </button>
            </div>
          </form>
        </section>
      )}
    </main>
  );
}
