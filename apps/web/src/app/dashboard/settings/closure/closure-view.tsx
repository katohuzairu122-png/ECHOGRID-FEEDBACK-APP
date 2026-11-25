'use client';

import { useActionState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import {
  closureReauthAction, fileClosureRequestAction, withdrawClosureRequestAction, type BusinessClosureActionState,
} from '@/lib/actions/business-closure';
import { CLOSURE_OBLIGATION_KEYS, type BusinessClosureStatusDto } from '@/lib/business-closure-types';
import { Button, Input, Label } from '@/components/ui';

const initial: BusinessClosureActionState = {};
const KNOWN_ERRORS = new Set(['CONFIRMATION_MISMATCH', 'INVALID_CREDENTIALS', 'VALIDATION_ERROR', 'PERMISSION_DENIED']);

function Outcome({ state, success }: { state: BusinessClosureActionState; success?: string }) {
  const t = useTranslations('dashboard.closure.errors');
  return (
    <div role="status" aria-live="polite" className="text-sm">
      {state.status === 'reauthRequired' && <p className="text-amber-800">{t('REAUTH_REQUIRED')}</p>}
      {state.status === 'failed' && <p className="text-red-700">{state.error && KNOWN_ERRORS.has(state.error) ? t(state.error) : t('generic')}</p>}
      {success && <p className="text-green-800">{success}</p>}
    </div>
  );
}

export function ClosureView({ businessName, status }: { businessName: string; status: BusinessClosureStatusDto }) {
  const t = useTranslations('dashboard.closure');
  const format = useFormatter();
  const [reauth, reauthAction, reauthPending] = useActionState(closureReauthAction, initial);
  const [filed, fileAction, filePending] = useActionState(fileClosureRequestAction, initial);
  const [withdrawn, withdrawAction, withdrawPending] = useActionState(withdrawClosureRequestAction, initial);
  const pending = status.request?.status === 'pending' ? status.request : null;
  const { blockers, obligations } = status.eligibility;

  return (
    <div className="flex flex-col gap-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-neutral-900">{t('title')}</h1>
        <p className="text-sm text-neutral-600">{t('intro')}</p>
      </header>

      <section aria-labelledby="closure-blocked" className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-4">
        <h2 id="closure-blocked" className="text-lg font-semibold">{t('blockedTitle')}</h2>
        <p className="text-sm">{t('blockedBody')}</p>
        <ul className="list-disc space-y-1 ps-5 text-sm">
          {blockers.map((code) => <li key={code}>{t(`blockers.${code}` as never)}</li>)}
        </ul>
      </section>

      <section aria-labelledby="closure-obligations" className="space-y-2">
        <h2 id="closure-obligations" className="text-lg font-semibold">{t('obligationsTitle')}</h2>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          {CLOSURE_OBLIGATION_KEYS.map((key) => (
            <div key={key} className="flex justify-between gap-4 border-b border-neutral-100 py-1">
              <dt className="text-neutral-600">{t(`obligations.${key}` as never)}</dt>
              <dd className="font-medium tabular-nums">{format.number(obligations[key])}</dd>
            </div>
          ))}
        </dl>
      </section>

      {pending ? (
        <section aria-labelledby="closure-pending" className="space-y-3 rounded-md border border-neutral-200 bg-white p-4">
          <h2 id="closure-pending" className="text-lg font-semibold">{t('pendingTitle')}</h2>
          <p className="text-sm">{t('pendingBody', { date: format.dateTime(new Date(pending.requestedAt), { dateStyle: 'medium' }) })}</p>
          <form action={withdrawAction} className="space-y-3">
            <p className="text-sm text-neutral-600">{t('withdrawHint')}</p>
            <Button type="submit" variant="outline" disabled={withdrawPending}>{t('withdraw')}</Button>
            <Outcome state={withdrawn} {...(withdrawn.status === 'withdrawn' ? { success: t('withdrawn') } : {})} />
          </form>
        </section>
      ) : null}

      <section aria-labelledby="closure-reauth" className="space-y-3 rounded-md border border-neutral-200 bg-white p-4">
        <h2 id="closure-reauth" className="text-lg font-semibold">{t('reauthTitle')}</h2>
        <form action={reauthAction} className="space-y-2">
          <Label htmlFor="closure-password">{t('passwordLabel')}</Label>
          <div className="flex max-w-sm gap-2">
            <Input id="closure-password" name="password" type="password" autoComplete="current-password" required maxLength={256} />
            <Button type="submit" variant="outline" disabled={reauthPending}>{t('reauthButton')}</Button>
          </div>
          <Outcome state={reauth} {...(reauth.status === 'reauthenticated' ? { success: t('reauthOk') } : {})} />
        </form>
      </section>

      {!pending ? (
        <section aria-labelledby="closure-file" className="space-y-3 rounded-md border border-neutral-200 bg-white p-4">
          <h2 id="closure-file" className="text-lg font-semibold">{t('fileTitle')}</h2>
          <p className="text-sm text-neutral-600">{t('fileHint')}</p>
          <form action={fileAction} className="space-y-2">
            <Label htmlFor="closure-confirm">{t('confirmLabel', { name: businessName })}</Label>
            <Input id="closure-confirm" name="confirmBusinessName" autoComplete="off" required maxLength={200} className="max-w-sm" />
            <div><Button type="submit" disabled={filePending}>{t('fileButton')}</Button></div>
            <Outcome state={filed} {...(filed.status === 'filed' ? { success: t('filed') } : {})} />
          </form>
        </section>
      ) : null}
    </div>
  );
}
