'use client';

import { useActionState, useState } from 'react';
import { useTranslations, useFormatter } from 'next-intl';
import {
  cashierAccountStatusAction, cashierReauthAction, createCashierAccountAction, resetCashierCredentialAction,
  rotateCashierCodeAction, setCashierBranchesAction, type CashierAccountsActionState,
} from '@/lib/actions/cashier-accounts';
import {
  assignmentProblem, type CashierAccessMode, type CashierAccountDto, type CashierBranchOption, type CashierBusinessCodeDto,
} from '@/lib/cashier-accounts-types';
import { Badge, Button, Input, Label } from '@/components/ui';

const initial: CashierAccountsActionState = {};
const KNOWN_ERRORS = new Set([
  'CASHIER_USERNAME_TAKEN', 'CASHIER_USERNAME_INVALID', 'CASHIER_PASSWORD_INVALID', 'CASHIER_BRANCH_ASSIGNMENT_INVALID',
  'CASHIER_BRANCH_NOT_FOUND', 'CASHIER_ACCOUNT_STATE_CONFLICT', 'CASHIER_ACCOUNT_REVOKED', 'CASHIER_ROLE_NAME_CONFLICT',
  'CASHIER_ROLE_ALTERED', 'CASHIER_CATALOG_NOT_SEEDED', 'CASHIER_ACCOUNT_NOT_FOUND', 'PERMISSION_DENIED',
]);

/** Plain-language result of an action: a known API code gets its own message, anything else a generic one. Never raw server text. */
function Outcome({ state, success }: { state: CashierAccountsActionState; success?: string }) {
  const t = useTranslations('cashier.dashboard.accounts.errors');
  return (
    <div role="status" aria-live="polite" className="text-sm">
      {state.status === 'reauthRequired' && <p className="text-amber-800">{t('REAUTH_REQUIRED')}</p>}
      {state.status === 'failed' && (
        <p className="text-red-700">{state.error && KNOWN_ERRORS.has(state.error) ? t(state.error) : t('generic')}</p>
      )}
      {success && <p className="text-green-800">{success}</p>}
    </div>
  );
}

/** Mode and branch choice shared by create and edit. A branch is only ever assigned when it is ticked. */
function BranchPicker({
  branches, initialMode, initialIds, idPrefix, onChange,
}: {
  branches: CashierBranchOption[]; initialMode: CashierAccessMode; initialIds: string[]; idPrefix: string;
  onChange?: (mode: CashierAccessMode, count: number) => void;
}) {
  const t = useTranslations('cashier.dashboard.accounts.assign');
  const [mode, setMode] = useState<CashierAccessMode>(initialMode);
  const [ids, setIds] = useState<string[]>(initialIds);
  const problem = assignmentProblem(mode, ids.length);
  const toggle = (id: string) => {
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    setIds(next);
    onChange?.(mode, next.length);
  };
  const pick = (m: CashierAccessMode) => {
    setMode(m);
    // Switching to single keeps at most one selected branch, so the form can never submit two for single access.
    const next = m === 'single' ? ids.slice(0, 1) : ids;
    setIds(next);
    onChange?.(m, next.length);
  };
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">{t('mode')}</legend>
      <div className="flex flex-wrap gap-4 text-sm">
        {(['single', 'multiple'] as const).map((m) => (
          <label key={m} className="flex items-center gap-2">
            <input type="radio" name="accessMode" value={m} checked={mode === m} onChange={() => pick(m)} />
            {t(m)}
          </label>
        ))}
      </div>
      <p className="text-xs text-neutral-600">{t(`${mode}Hint`)}</p>
      <div className="space-y-1" role="group" aria-label={t('branches')}>
        {branches.map((b) => (
          <label key={b.id} htmlFor={`${idPrefix}-${b.id}`} className="flex items-center gap-2 text-sm">
            <input id={`${idPrefix}-${b.id}`} type="checkbox" name="branchId" value={b.id} checked={ids.includes(b.id)} onChange={() => toggle(b.id)} />
            {b.name}
          </label>
        ))}
      </div>
      {problem && <p className="text-xs text-amber-800">{t(`${problem}Needs`)}</p>}
    </fieldset>
  );
}

function ReauthCard() {
  const t = useTranslations('cashier.dashboard.accounts.reauth');
  const [state, action, pending] = useActionState(cashierReauthAction, initial);
  return (
    <section aria-labelledby="reauth-title" className="space-y-2 rounded-md border border-neutral-200 bg-white p-4">
      <h2 id="reauth-title" className="text-base font-semibold">{t('title')}</h2>
      <p className="text-sm text-neutral-600">{t('hint')}</p>
      <form action={action} className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="reauth-password">{t('password')}</Label>
          <Input id="reauth-password" name="password" type="password" autoComplete="current-password" required className="w-64" />
        </div>
        <Button type="submit" disabled={pending}>{t('confirm')}</Button>
      </form>
      <div role="status" aria-live="polite" className="text-sm">
        {state.status === 'reauthenticated' && <p className="text-green-800">{t('confirmed')}</p>}
        {state.status === 'failed' && <p className="text-red-700">{t('wrong')}</p>}
      </div>
    </section>
  );
}

function CredentialNotice({ credential, onDismiss }: { credential: NonNullable<CashierAccountsActionState['credential']>; onDismiss: () => void }) {
  const t = useTranslations('cashier.dashboard.accounts.credential');
  return (
    <section role="alert" className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm">
      <h2 className="text-base font-semibold">{t('title')}</h2>
      <p>{t('warning')}</p>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        {credential.cashierCode && (<><dt className="text-neutral-600">{t('code')}</dt><dd className="font-mono">{credential.cashierCode}</dd></>)}
        {credential.username && (<><dt className="text-neutral-600">{t('username')}</dt><dd className="font-mono">{credential.username}</dd></>)}
        {credential.password
          ? (<><dt className="text-neutral-600">{t('password')}</dt><dd className="select-all font-mono">{credential.password}</dd></>)
          : (<><dt className="text-neutral-600">{t('password')}</dt><dd>{t('setByYou')}</dd></>)}
      </dl>
      <Button type="button" variant="outline" size="sm" onClick={onDismiss}>{t('dismiss')}</Button>
    </section>
  );
}

function CreateForm({ branches, onCredential }: { branches: CashierBranchOption[]; onCredential: (c: NonNullable<CashierAccountsActionState['credential']>) => void }) {
  const t = useTranslations('cashier.dashboard.accounts.create');
  const [state, action, pending] = useActionState(async (prev: CashierAccountsActionState, form: FormData) => {
    const next = await createCashierAccountAction(prev, form);
    const { credential, ...rest } = next;
    if (next.status === 'created' && credential) onCredential(credential);
    return rest; // the one-time credential is handed to the notice and not kept in this form's state
  }, initial);
  return (
    <section aria-labelledby="create-title" className="space-y-3">
      <h2 id="create-title" className="text-lg font-semibold">{t('title')}</h2>
      <form action={action} className="space-y-4 rounded-md border border-neutral-200 bg-white p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="create-username">{t('username')}</Label>
            <Input id="create-username" name="username" required minLength={3} maxLength={32} autoCapitalize="none" autoComplete="off" />
            <p className="text-xs text-neutral-500">{t('usernameHint')}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="create-displayName">{t('displayName')}</Label>
            <Input id="create-displayName" name="displayName" required maxLength={120} autoComplete="off" />
          </div>
        </div>
        <BranchPicker branches={branches} initialMode="single" initialIds={[]} idPrefix="create-branch" />
        <div className="space-y-1">
          <Label htmlFor="create-password">{t('password')}</Label>
          <Input id="create-password" name="password" type="password" minLength={8} maxLength={128} autoComplete="new-password" className="max-w-sm" />
          <p className="text-xs text-neutral-500">{t('passwordHint')}</p>
        </div>
        <Button type="submit" disabled={pending}>{t('submit')}</Button>
        <Outcome state={state} {...(state.status === 'created' ? { success: t('created') } : {})} />
      </form>
    </section>
  );
}

const STATUS_VARIANT = { active: 'success', disabled: 'neutral', revoked: 'danger' } as const;

function ActionButton({ account, action, label, confirm, variant = 'outline', onResult }: {
  account: CashierAccountDto; action: string; label: string; confirm: string; variant?: 'outline' | 'danger';
  onResult: (s: CashierAccountsActionState) => void;
}) {
  const [, formAction, pending] = useActionState(async (prev: CashierAccountsActionState, form: FormData) => {
    const next = await cashierAccountStatusAction(prev, form);
    onResult(next);
    return next;
  }, initial);
  return (
    <form action={formAction} onSubmit={(e) => { if (!window.confirm(confirm)) e.preventDefault(); }}>
      <input type="hidden" name="accountId" value={account.id} />
      <input type="hidden" name="action" value={action} />
      <Button type="submit" variant={variant} size="sm" disabled={pending}>{label}</Button>
    </form>
  );
}

function AccountRow({ account, branches, onCredential }: {
  account: CashierAccountDto; branches: CashierBranchOption[]; onCredential: (c: NonNullable<CashierAccountsActionState['credential']>) => void;
}) {
  const t = useTranslations('cashier.dashboard.accounts');
  const format = useFormatter();
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<CashierAccountsActionState>({});
  const revoked = account.status === 'revoked';
  const [resetState, resetAction, resetPending] = useActionState(async (prev: CashierAccountsActionState, form: FormData) => {
    const next = await resetCashierCredentialAction(prev, form);
    const { credential, ...rest } = next;
    if (next.status === 'credentialReset' && credential) onCredential(credential);
    return rest;
  }, initial);
  const [saveState, saveAction, savePending] = useActionState(async (prev: CashierAccountsActionState, form: FormData) => {
    const next = await setCashierBranchesAction(prev, form);
    if (next.status === 'updated') setEditing(false);
    return next;
  }, initial);
  const mode = account.accessMode === 'none' ? 'single' : account.accessMode;

  return (
    <li className="space-y-3 p-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-0.5">
          <p className="font-medium">{account.displayName} <span className="font-mono text-neutral-600">({account.username})</span></p>
          <p className="flex flex-wrap items-center gap-2">
            <Badge variant={STATUS_VARIANT[account.status]}>{t(`list.status.${account.status}`)}</Badge>
            {account.locked && <Badge variant="danger">{t('list.locked')}</Badge>}
            {account.accessMode !== 'none' && <span className="text-neutral-600">{t(`list.mode.${account.accessMode}`)}</span>}
          </p>
          <p className="text-neutral-600">{t('list.branches')}: {account.branches.map((b) => b.name).join(', ') || t('list.noBranches')}</p>
          <p className="text-neutral-500">
            {t('list.lastLogin')}: {account.lastLoginAt ? format.dateTime(new Date(account.lastLoginAt), { dateStyle: 'medium', timeStyle: 'short' }) : t('list.never')}
          </p>
        </div>
        {!revoked && (
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setEditing((v) => !v)}>{t('actions.editBranches')}</Button>
            <form action={resetAction} onSubmit={(e) => { if (!window.confirm(t('actions.confirmReset'))) e.preventDefault(); }}>
              <input type="hidden" name="accountId" value={account.id} />
              <input type="hidden" name="username" value={account.username} />
              <Button type="submit" variant="outline" size="sm" disabled={resetPending}>{t('actions.resetCredential')}</Button>
            </form>
            {account.status === 'active'
              ? <ActionButton account={account} action="disable" label={t('actions.disable')} confirm={t('actions.confirmDisable')} onResult={setMessage} />
              : <ActionButton account={account} action="enable" label={t('actions.enable')} confirm={t('actions.confirmEnable')} onResult={setMessage} />}
            <ActionButton account={account} action="revoke-sessions" label={t('actions.signOut')} confirm={t('actions.confirmSignOut')} onResult={setMessage} />
            <ActionButton account={account} action="revoke" label={t('actions.revoke')} confirm={t('actions.confirmRevoke')} variant="danger" onResult={setMessage} />
          </div>
        )}
      </div>
      {editing && !revoked && (
        <form action={saveAction} className="space-y-3 rounded-md border border-neutral-200 bg-neutral-50 p-3">
          <input type="hidden" name="accountId" value={account.id} />
          <BranchPicker branches={branches} initialMode={mode} initialIds={account.branches.map((b) => b.id)} idPrefix={`edit-${account.id}`} />
          <p className="text-xs text-neutral-600">{t('assign.removeNote')}</p>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={savePending}>{t('actions.saveBranches')}</Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setEditing(false)}>{t('actions.cancel')}</Button>
          </div>
        </form>
      )}
      <Outcome state={saveState.status ? saveState : resetState.status ? resetState : message} />
    </li>
  );
}

export function CashierAccountsView({ accounts, code, branches }: {
  accounts: CashierAccountDto[]; code: CashierBusinessCodeDto; branches: CashierBranchOption[];
}) {
  const t = useTranslations('cashier.dashboard.accounts');
  const [credential, setCredential] = useState<NonNullable<CashierAccountsActionState['credential']> | null>(null);
  const [rotate, rotateAction, rotating] = useActionState(async () => rotateCashierCodeAction(), initial);

  return (
    <section className="mx-auto max-w-3xl space-y-8 px-4 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-neutral-600">{t('subtitle')}</p>
      </header>

      {credential && <CredentialNotice credential={credential} onDismiss={() => setCredential(null)} />}
      <ReauthCard />

      <section aria-labelledby="code-title" className="space-y-2">
        <h2 id="code-title" className="text-lg font-semibold">{t('code.title')}</h2>
        <p className="text-sm text-neutral-600">{t('code.hint')}</p>
        <p className="font-mono text-lg" data-testid="business-code">{code.cashierCode ?? t('code.none')}</p>
        {code.cashierCode && (
          <form action={rotateAction} onSubmit={(e) => { if (!window.confirm(t('code.confirmRotate'))) e.preventDefault(); }}>
            <Button type="submit" variant="outline" size="sm" disabled={rotating}>{t('code.rotate')}</Button>
          </form>
        )}
        <Outcome state={rotate} {...(rotate.status === 'codeRotated' ? { success: t('code.rotated') } : {})} />
      </section>

      <CreateForm branches={branches} onCredential={setCredential} />

      <section aria-labelledby="list-title" className="space-y-3">
        <h2 id="list-title" className="text-lg font-semibold">{t('list.title')}</h2>
        {accounts.length === 0 ? (
          <p className="rounded-md border border-neutral-200 bg-white p-4 text-sm text-neutral-600">{t('list.empty')}</p>
        ) : (
          <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200 bg-white">
            {accounts.map((a) => <AccountRow key={a.id} account={a} branches={branches} onCredential={setCredential} />)}
          </ul>
        )}
      </section>
    </section>
  );
}
