'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  cashierLoginAction, cashierManagedLoginAction, cashierSelectAction, type CashierLoginState,
} from '@/lib/cashier/actions';
import { Button, Input, Label } from '@/components/ui';

const initial: CashierLoginState = {};

/**
 * Cashier sign-in: the staff account's own email and password, then (only when the account can serve in more than one
 * place) a choice of business and branch. Tokens never reach this component: the server action keeps them in httpOnly
 * cookies scoped to the cashier app.
 */
export function CashierLoginForm() {
  const t = useTranslations('cashier.login');
  const [login, loginAction, loginPending] = useActionState(cashierLoginAction, initial);
  const [managed, managedAction, managedPending] = useActionState(cashierManagedLoginAction, initial);
  const [select, selectAction, selectPending] = useActionState(cashierSelectAction, initial);
  const [managedMode, setManagedMode] = useState(false);
  const choices = login.choices ?? managed.choices;
  const [businessId, setBusinessId] = useState<string>('');
  const chosen = choices?.find((c) => c.businessId === (businessId || choices[0]?.businessId));
  const error = select.error ?? (managedMode ? managed.error : login.error);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-4 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">{choices ? t('chooseTitle') : t('title')}</h1>
        <p className="text-sm text-neutral-600">{choices ? t('chooseHint') : t('subtitle')}</p>
      </header>

      {error && (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error === 'credentials' && managedMode ? t('errors.managedCredentials') : t(`errors.${error}`)}
        </p>
      )}

      {choices && chosen ? (
        <form action={selectAction} className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="businessId">{t('business')}</Label>
            <select
              id="businessId"
              name="businessId"
              value={chosen.businessId}
              onChange={(e) => setBusinessId(e.target.value)}
              className="h-12 w-full rounded-md border border-neutral-300 bg-white px-3"
            >
              {choices.map((c) => (
                <option key={c.businessId} value={c.businessId}>
                  {c.businessName}
                </option>
              ))}
            </select>
          </div>
          {(chosen.branches.length > 0 || !chosen.wideAccess) && (
            <div className="space-y-1">
              <Label htmlFor="branchId">{t('branch')}</Label>
              <select
                id="branchId"
                name="branchId"
                key={chosen.businessId}
                className="h-12 w-full rounded-md border border-neutral-300 bg-white px-3"
              >
                {chosen.wideAccess && <option value="">{t('branchWide')}</option>}
                {chosen.branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <Button type="submit" className="min-h-12 w-full" disabled={selectPending}>
            {t('continue')}
          </Button>
          <a href="/cashier/login" className="block text-center text-sm text-neutral-600 underline">
            {t('back')}
          </a>
        </form>
      ) : managedMode ? (
        <form action={managedAction} className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="businessCode">{t('managed.businessCode')}</Label>
            <Input id="businessCode" name="businessCode" autoCapitalize="characters" autoComplete="off" required maxLength={40} className="h-12 font-mono" />
            <p className="text-xs text-neutral-500">{t('managed.businessCodeHint')}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="username">{t('managed.username')}</Label>
            <Input id="username" name="username" autoCapitalize="none" autoComplete="username" required maxLength={64} className="h-12" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="managed-password">{t('password')}</Label>
            <Input id="managed-password" name="password" type="password" autoComplete="current-password" required className="h-12" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="managed-deviceLabel">{t('deviceLabel')}</Label>
            <Input id="managed-deviceLabel" name="deviceLabel" maxLength={80} className="h-12" />
            <p className="text-xs text-neutral-500">{t('deviceLabelHint')}</p>
          </div>
          <Button type="submit" className="min-h-12 w-full" disabled={managedPending}>
            {managedPending ? t('submitting') : t('submit')}
          </Button>
          <button type="button" onClick={() => setManagedMode(false)} className="block w-full text-center text-sm text-neutral-600 underline">
            {t('managed.useEmail')}
          </button>
        </form>
      ) : (
        <form action={loginAction} className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="email">{t('email')}</Label>
            <Input id="email" name="email" type="email" autoComplete="username" required className="h-12" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="password">{t('password')}</Label>
            <Input id="password" name="password" type="password" autoComplete="current-password" required className="h-12" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="deviceLabel">{t('deviceLabel')}</Label>
            <Input id="deviceLabel" name="deviceLabel" maxLength={80} className="h-12" />
            <p className="text-xs text-neutral-500">{t('deviceLabelHint')}</p>
          </div>
          <Button type="submit" className="min-h-12 w-full" disabled={loginPending}>
            {loginPending ? t('submitting') : t('submit')}
          </Button>
          <button type="button" onClick={() => setManagedMode(true)} className="block w-full text-center text-sm text-neutral-600 underline">
            {t('managed.useCode')}
          </button>
        </form>
      )}
    </main>
  );
}
