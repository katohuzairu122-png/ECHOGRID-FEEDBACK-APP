import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActiveBusiness } from '@/lib/business';
import { apiFetch } from '@/lib/api-client';
import { getMyAccess } from '@/lib/permissions';
import { managementGate } from '@/lib/workspace-guard';
import {
  b2bProposalAction,
  createB2bProposalAction,
  sendB2bMessageAction,
} from '@/lib/actions/b2b';

type Message = { id: string; senderBusinessId: string; body: string; createdAt: string };
type Proposal = {
  id: string;
  proposerBusinessId: string;
  title: string;
  description: string;
  status: string;
  createdAt: string;
};

export default async function PartnershipWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ partnershipId: string }>;
  searchParams?: Promise<{ error?: string }>;
}) {
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');
  const blocked = await managementGate();
  if (blocked) return blocked;
  if (!(await getMyAccess()).permissions.has('b2b:view'))
    return <p role="alert">Business Network access is not available for your role.</p>;
  const { partnershipId } = await params;
  const t = await getTranslations('b2b.conversation');
  const filter = await searchParams;
  let messages: Message[] = [];
  let proposals: Proposal[] = [];
  let unavailable = false;
  try {
    const [messageResult, proposalResult] = await Promise.all([
      apiFetch<{ data: Message[] }>(`/b2b/partnerships/${partnershipId}/messages?limit=100`, {
        businessId: business.id,
      }),
      apiFetch<{ data: Proposal[] }>(`/b2b/partnerships/${partnershipId}/proposals`, {
        businessId: business.id,
      }),
    ]);
    messages = messageResult.data;
    proposals = proposalResult.data;
  } catch {
    unavailable = true;
  }
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 p-4 md:p-8">
      <Link href="/dashboard/network" className="text-sm underline">
        ← Business Network
      </Link>
      <header>
        <h1 className="text-3xl font-semibold">{t('title')}</h1>
      </header>
      {filter?.error && (
        <p role="alert" className="rounded border border-red-300 bg-red-50 p-3">
          {t('error')}
        </p>
      )}
      {unavailable ? (
        <p role="status">
          Partnership messaging is unavailable. It requires an active partnership and messaging
          permission.
        </p>
      ) : (
        <>
          <section className="rounded-xl border p-5">
            <h2 className="text-xl font-semibold">{t('messages')}</h2>
            {!messages.length && <p className="mt-3">{t('empty')}</p>}
            <ol className="mt-3 flex flex-col gap-3">
              {messages.map((message) => (
                <li key={message.id} className="rounded bg-neutral-50 p-3">
                  <p className="text-xs text-neutral-500">
                    {message.senderBusinessId === business.id ? 'You' : 'Partner'} ·{' '}
                    {new Date(message.createdAt).toLocaleString()}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap">{message.body}</p>
                </li>
              ))}
            </ol>
            <form
              action={sendB2bMessageAction.bind(null, partnershipId)}
              className="mt-4 grid gap-2"
            >
              <label htmlFor="message-body">{t('message')}</label>
              <textarea
                id="message-body"
                name="body"
                required
                maxLength={4000}
                className="min-h-24 rounded border p-3"
              />
              <button className="justify-self-start rounded bg-slate-900 px-4 py-2 text-white">
                {t('send')}
              </button>
            </form>
          </section>
          <section className="rounded-xl border p-5">
            <h2 className="text-xl font-semibold">{t('proposals')}</h2>
            {!proposals.length && <p className="mt-3">{t('empty')}</p>}
            <ul className="mt-3 flex flex-col gap-3">
              {proposals.map((proposal) => (
                <li key={proposal.id} className="rounded bg-neutral-50 p-4">
                  <h3 className="font-semibold">{proposal.title}</h3>
                  <p className="mt-2 whitespace-pre-wrap">{proposal.description}</p>
                  <p className="mt-2 text-sm text-neutral-600">
                    {proposal.status === 'accepted'
                      ? t('accepted')
                      : proposal.status === 'declined'
                        ? t('declined')
                        : t('pending')}
                  </p>
                  {proposal.status === 'pending' && (
                    <div className="mt-3 flex gap-2">
                      {proposal.proposerBusinessId === business.id ? (
                        <form
                          action={b2bProposalAction.bind(
                            null,
                            'withdraw',
                            proposal.id,
                            partnershipId,
                          )}
                        >
                          <button className="rounded border px-3 py-2">{t('withdraw')}</button>
                        </form>
                      ) : (
                        <>
                          <form
                            action={b2bProposalAction.bind(
                              null,
                              'accept',
                              proposal.id,
                              partnershipId,
                            )}
                          >
                            <button className="rounded border px-3 py-2">
                              {t('respond')} · {t('accepted')}
                            </button>
                          </form>
                          <form
                            action={b2bProposalAction.bind(
                              null,
                              'decline',
                              proposal.id,
                              partnershipId,
                            )}
                          >
                            <button className="rounded border px-3 py-2">
                              {t('respond')} · {t('declined')}
                            </button>
                          </form>
                        </>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <form
              action={createB2bProposalAction.bind(null, partnershipId)}
              className="mt-5 grid gap-2"
            >
              <label htmlFor="proposal-title">{t('proposalTitle')}</label>
              <input
                id="proposal-title"
                name="title"
                required
                maxLength={120}
                className="rounded border p-3"
              />
              <label htmlFor="proposal-description">{t('proposalDescription')}</label>
              <textarea
                id="proposal-description"
                name="description"
                required
                maxLength={2000}
                className="min-h-28 rounded border p-3"
              />
              <button className="justify-self-start rounded bg-slate-900 px-4 py-2 text-white">
                {t('createProposal')}
              </button>
            </form>
          </section>
        </>
      )}
    </main>
  );
}
