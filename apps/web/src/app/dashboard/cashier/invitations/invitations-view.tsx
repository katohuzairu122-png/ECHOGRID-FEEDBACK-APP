'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import QRCode from 'react-qr-code';
import { useFormatter, useTranslations } from 'next-intl';
import { createInvitationAction, revokeInvitationAction, type InvitationActionState } from '@/lib/actions/customer-invitations';
import { INVITATION_STATUSES, type InvitationListDto } from '@/lib/customer-invitations-types';
import { Button, Input, Label } from '@/components/ui';

const initial: InvitationActionState = {};
const KNOWN_ERRORS = new Set(['RATE_LIMITED', 'INVITATION_BRANCH_INVALID', 'VALIDATION_ERROR', 'INVITATION_ALREADY_USED', 'INVITATION_NOT_FOUND']);

function Outcome({ state }: { state: InvitationActionState }) {
  const t = useTranslations('cashier.dashboard.invitations.errors');
  return (
    <div role="status" aria-live="polite" className="text-sm">
      {state.status === 'failed' && <p className="text-red-700">{state.error && KNOWN_ERRORS.has(state.error) ? t(state.error) : t('generic')}</p>}
    </div>
  );
}

/**
 * OWNER-INVITE-01: create, share and revoke customer invitations. The link and QR are shown once, right after creation. An invitation only
 * invites: the customer signs in as themselves and gives their own consent. This screen never shows a customer's identity.
 */
export function InvitationsView({ list, branches }: { list: InvitationListDto; branches: { id: string; name: string }[] }) {
  const t = useTranslations('cashier.dashboard.invitations');
  const format = useFormatter();
  const [created, createAction, creating] = useActionState(createInvitationAction, initial);
  const [revoked, revokeAction, revoking] = useActionState(revokeInvitationAction, initial);
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async (url: string) => {
    try { await navigator.clipboard.writeText(url); setCopied('copied'); } catch { setCopied('failed'); }
  };
  return (
    <section className="mx-auto max-w-3xl space-y-8 px-4 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-neutral-600">{t('intro')}</p>
        <p className="text-sm"><Link href="/dashboard/cashier" className="underline">{t('back')}</Link></p>
      </header>

      <form action={createAction} className="space-y-3 rounded-md border border-neutral-200 bg-white p-4">
        <h2 className="text-lg font-semibold">{t('createTitle')}</h2>
        {branches.length === 0 ? <p className="text-sm text-neutral-600">{t('noBranches')}</p> : (
          <>
            <div className="space-y-1">
              <Label htmlFor="inv-branch">{t('branchLabel')}</Label>
              <select id="inv-branch" name="branchId" required className="block h-10 w-full max-w-sm rounded-md border border-neutral-300 bg-white px-3 text-sm">
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="inv-hours">{t('hoursLabel')}</Label>
              <Input id="inv-hours" name="expiresInHours" type="number" min={1} max={168} defaultValue={24} className="max-w-[8rem]" />
              <p className="text-xs text-neutral-500">{t('hoursHint')}</p>
            </div>
            <Button type="submit" disabled={creating}>{t('create')}</Button>
          </>
        )}
        <Outcome state={created} />
        {created.status === 'created' && created.inviteUrl && (
          <div className="space-y-3 rounded-md border border-green-200 bg-green-50 p-3" data-testid="invitation-created">
            <p className="text-sm font-medium text-green-900">{t('createdNote', { time: format.dateTime(new Date(created.expiresAt ?? Date.now()), { dateStyle: 'medium', timeStyle: 'short' }) })}</p>
            <div className="inline-block rounded bg-white p-3"><QRCode value={created.inviteUrl} size={176} aria-label={t('qrLabel')} /></div>
            <div className="flex max-w-xl gap-2">
              <Input readOnly value={created.inviteUrl} aria-label={t('linkLabel')} onFocus={(e) => e.currentTarget.select()} />
              <Button type="button" variant="outline" onClick={() => copy(created.inviteUrl!)}>{t('copy')}</Button>
            </div>
            <p role="status" aria-live="polite" className="text-sm">{copied === 'copied' ? t('copied') : copied === 'failed' ? t('copyFailed') : ''}</p>
            <p className="text-xs text-neutral-600">{t('oneUse')}</p>
          </div>
        )}
      </form>

      <section aria-labelledby="inv-list" className="space-y-3">
        <h2 id="inv-list" className="text-lg font-semibold">{t('listTitle')}</h2>
        <ul className="flex flex-wrap gap-3 text-sm" data-testid="invitation-counts">
          {INVITATION_STATUSES.map((s) => <li key={s}>{t(`status.${s}`)}: <strong>{format.number(list.counts[s])}</strong></li>)}
        </ul>
        {list.invitations.length === 0 ? <p className="text-sm text-neutral-500">{t('empty')}</p> : (
          <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200 bg-white">
            {list.invitations.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                <div className="space-y-0.5">
                  <p className="font-medium">{i.branchName} <span className="ms-2 rounded bg-neutral-100 px-2 py-0.5 text-xs">{t(`status.${i.status}`)}</span></p>
                  <p className="text-xs text-neutral-500">{t('createdOn', { date: format.dateTime(new Date(i.createdAt), { dateStyle: 'medium', timeStyle: 'short' }) })} · {t('expiresOn', { date: format.dateTime(new Date(i.expiresAt), { dateStyle: 'medium', timeStyle: 'short' }) })}</p>
                </div>
                {i.status === 'active' && (
                  <form action={revokeAction}>
                    <input type="hidden" name="invitationId" value={i.id} />
                    <Button type="submit" variant="outline" size="sm" disabled={revoking}>{t('revoke')}</Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
        <Outcome state={revoked} />
      </section>
    </section>
  );
}
