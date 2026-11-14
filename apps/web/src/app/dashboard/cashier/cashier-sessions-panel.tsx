'use client';

import { useActionState } from 'react';
import { useTranslations, useFormatter } from 'next-intl';
import {
  revokeAllCashierSessionsAction,
  revokeCashierSessionAction,
  type CashierSessionsActionState,
} from '@/lib/actions/cashier-sessions';
import { Button } from '@/components/ui';

export interface CashierSessionView {
  sessionId: string;
  user: { name: string; email: string };
  branch: { name: string | null } | null;
  deviceLabel: string | null;
  lastActiveAt: string;
  expiresAt: string;
}

const initial: CashierSessionsActionState = {};

function RevokeOne({ sessionId }: { sessionId: string }) {
  const t = useTranslations('cashier.dashboard.sessions');
  const [, action, pending] = useActionState(revokeCashierSessionAction, initial);
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(t('confirmOne'))) e.preventDefault();
      }}
    >
      <input type="hidden" name="sessionId" value={sessionId} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {t('revoke')}
      </Button>
    </form>
  );
}

/** The business's live cashier sessions, with per-session and sign-out-all controls. Server state only: nothing is cached on the client. */
export function CashierSessionsPanel({ sessions }: { sessions: CashierSessionView[] }) {
  const t = useTranslations('cashier.dashboard.sessions');
  const format = useFormatter();
  const [allState, allAction, allPending] = useActionState(
    async () => revokeAllCashierSessionsAction(),
    initial,
  );
  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <section aria-labelledby="cashier-sessions-title" className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="cashier-sessions-title" className="text-lg font-semibold">
            {t('title')}
          </h2>
          <p className="text-sm text-neutral-600">{t('subtitle')}</p>
        </div>
        {sessions.length > 0 && (
          <form
            action={allAction}
            onSubmit={(e) => {
              if (!window.confirm(t('confirmAll'))) e.preventDefault();
            }}
          >
            <Button type="submit" variant="danger" size="sm" disabled={allPending}>
              {t('revokeAll')}
            </Button>
          </form>
        )}
      </div>
      <div role="status" aria-live="polite" className="text-sm">
        {allState.status === 'revokedAll' && <p>{t('revokedAll')}</p>}
        {allState.status === 'failed' && <p className="text-red-700">{t('failed')}</p>}
      </div>
      {sessions.length === 0 ? (
        <p className="rounded-md border border-neutral-200 bg-white p-4 text-sm text-neutral-600">{t('empty')}</p>
      ) : (
        <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200 bg-white">
          {sessions.map((s) => (
            <li key={s.sessionId} className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
              <div className="space-y-0.5">
                <p className="font-medium">{s.user.name}</p>
                <p className="text-neutral-600">{s.user.email}</p>
                <p className="text-neutral-600">
                  {t('device')}: {s.deviceLabel ?? t('noDevice')} · {t('branch')}: {s.branch?.name ?? t('branchWide')}
                </p>
                <p className="text-neutral-500">
                  {t('lastActive')}: {when(s.lastActiveAt)} · {t('expires')}: {when(s.expiresAt)}
                </p>
              </div>
              <RevokeOne sessionId={s.sessionId} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
