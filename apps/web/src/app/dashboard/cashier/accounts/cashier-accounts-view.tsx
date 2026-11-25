'use client';

import { useActionState, useState, type FormEvent } from 'react';
import { useTranslations, useFormatter } from 'next-intl';
import {
  cashierAccountStatusAction, cashierReauthAction, createCashierAccountAction, resetCashierCredentialAction,
  setCashierBranchesAction, type CashierAccountsActionState,
} from '@/lib/actions/cashier-accounts';
import {
  assignmentProblem, type CashierAccessMode, type CashierAccountDto, type CashierBranchOption, type CashierBusinessCodeDto,
} from '@/lib/cashier-accounts-types';
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogTitle, Input, Label } from '@/components/ui';
import { suggestCashierUsername } from '@/lib/cashier-username';

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

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;
/** A password box the owner types into, with a Show/Hide control so a typing slip can be seen. The text is never trimmed: spaces are legal characters. */
function PasswordChoice({ id, label, hint, value, onChange, autoFocus }: {
  id: string; label: string; hint?: string; value: string; onChange: (v: string) => void; autoFocus?: boolean;
}) {
  const t = useTranslations('cashier.dashboard.accounts.create');
  const [shown, setShown] = useState(false);
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex max-w-sm gap-2">
        <Input id={id} type={shown ? 'text' : 'password'} autoComplete="new-password" autoCapitalize="none" spellCheck={false} maxLength={MAX_PASSWORD}
          value={value} onChange={(e) => onChange(e.target.value)} {...(autoFocus ? { autoFocus: true } : {})} />
        <Button type="button" variant="outline" size="sm" aria-pressed={shown} onClick={() => setShown((v) => !v)}>{shown ? t('passwordHide') : t('passwordShow')}</Button>
      </div>
      {hint && <p className="text-xs text-neutral-500">{hint}</p>}
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
  // "Several branches" needs at least two branches to choose from. An existing multi-branch account keeps the choice so it can still be edited.
  const offerMultiple = branches.length >= 2 || initialMode === 'multiple';
  const [mode, setMode] = useState<CashierAccessMode>(offerMultiple ? initialMode : 'single');
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
      {offerMultiple ? (
        <div className="flex flex-wrap gap-4 text-sm">
          {(['single', 'multiple'] as const).map((m) => (
            <label key={m} className="flex items-center gap-2">
              <input type="radio" name="accessMode" value={m} checked={mode === m} onChange={() => pick(m)} />
              {t(m)}
            </label>
          ))}
        </div>
      ) : (
        // Fewer than two branches: "Several branches" can never be satisfied, so it is not offered; the form still submits single access.
        <input type="hidden" name="accessMode" value="single" />
      )}
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
  const [copied, setCopied] = useState(false);
  const details = [
    credential.cashierCode ? `${t('code')}: ${credential.cashierCode}` : '',
    credential.username ? `${t('username')}: ${credential.username}` : '',
  ].filter(Boolean).join('\n');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(details);
      setCopied(true);
    } catch {
      setCopied(false); // the details stay on screen; copying is only a convenience
    }
  };
  // A modal that only the button closes (not Escape or an outside click), so the sign-in details are not lost by accident.
  return (
    <Dialog open onOpenChange={() => undefined}>
      <DialogContent role="alertdialog">
        <DialogTitle>{t('title')}</DialogTitle>
        <DialogDescription>{t('warning')}</DialogDescription>
        <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          {credential.cashierCode && (<><dt className="text-neutral-600">{t('code')}</dt><dd className="font-mono">{credential.cashierCode}</dd></>)}
          {credential.username && (<><dt className="text-neutral-600">{t('username')}</dt><dd className="font-mono">{credential.username}</dd></>)}
          <dt className="text-neutral-600">{t('password')}</dt><dd>{t('setByYou')}</dd>
        </dl>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={copy}>{copied ? t('copied') : t('copy')}</Button>
          <Button type="button" onClick={onDismiss}>{t('dismiss')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CreateForm({ branches, onCredential }: { branches: CashierBranchOption[]; onCredential: (c: NonNullable<CashierAccountsActionState['credential']>) => void }) {
  const t = useTranslations('cashier.dashboard.accounts.create');
  const errors = useTranslations('cashier.dashboard.accounts.errors');
  const [name, setName] = useState('');
  // Every branch starts ticked: with one branch there is nothing to choose, with several the owner only unticks what does not apply.
  const [ids, setIds] = useState<string[]>(branches.map((b) => b.id));
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<'name' | 'branches' | 'password' | null>(null);
  const [cashierPassword, setCashierPassword] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [created, setCreated] = useState(false);

  const askForPassword = (e: FormEvent) => {
    e.preventDefault();
    setCreated(false);
    if (name.trim().length < 2) return setProblem('name');
    if (cashierPassword.length < MIN_PASSWORD) return setProblem('password');
    if (ids.length === 0) return setProblem('branches');
    setProblem(null);
    setDialogError(null);
    setPassword('');
    setOpen(true);
  };

  const confirmAndCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setDialogError(null);
    try {
      const reauthForm = new FormData();
      reauthForm.set('password', password);
      const reauth = await cashierReauthAction({}, reauthForm);
      if (reauth.status !== 'reauthenticated') {
        setDialogError(reauth.status === 'failed' ? t('confirmWrong') : errors('generic'));
        return;
      }
      // The sign-in name is made from the name; if it is taken, a few digits are added and it is tried again.
      let result: CashierAccountsActionState = {};
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const suffix = attempt === 0 ? '' : String(Math.floor(10 + Math.random() * 90));
        const form = new FormData();
        form.set('username', suggestCashierUsername(name, suffix));
        form.set('displayName', name.trim());
        form.set('cashierPassword', cashierPassword);
        form.set('accessMode', ids.length === 1 ? 'single' : 'multiple');
        for (const id of ids) form.append('branchId', id);
        result = await createCashierAccountAction({}, form);
        if (!(result.status === 'failed' && result.error === 'CASHIER_USERNAME_TAKEN')) break;
      }
      if (result.status === 'created' && result.credential) {
        onCredential(result.credential);
        setOpen(false);
        setName('');
        setCashierPassword('');
        setPassword('');
        setCreated(true);
        return;
      }
      setDialogError(
        result.status === 'reauthRequired' ? errors('generic')
          : result.status === 'failed' && result.error && KNOWN_ERRORS.has(result.error) ? errors(result.error) : errors('generic'),
      );
    } finally {
      setPending(false);
    }
  };

  const toggle = (id: string) => setIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  return (
    <section aria-labelledby="create-title" className="space-y-3">
      <h2 id="create-title" className="text-lg font-semibold">{t('title')}</h2>
      <form onSubmit={askForPassword} className="space-y-4 rounded-md border border-neutral-200 bg-white p-4">
        <div className="space-y-1">
          <Label htmlFor="create-name">{t('name')}</Label>
          <Input id="create-name" name="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="off" className="max-w-sm" />
          <p className="text-xs text-neutral-500">{t('nameHint')}</p>
          {problem === 'name' && <p className="text-xs text-amber-800">{t('nameNeeds')}</p>}
        </div>
        <div className="space-y-1">
          <PasswordChoice id="create-cashier-password" label={t('password')} hint={t('passwordHint')} value={cashierPassword} onChange={setCashierPassword} />
          {problem === 'password' && <p className="text-xs text-amber-800">{t('passwordNeeds')}</p>}
        </div>
        {branches.length === 0 ? (
          <p className="text-sm text-amber-800">{t('noBranches')}</p>
        ) : branches.length === 1 ? (
          <p className="text-sm">{t('worksAt', { branch: branches[0]!.name })}</p>
        ) : (
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">{t('branchesTitle')}</legend>
            <p className="text-xs text-neutral-500">{t('branchesHint')}</p>
            {branches.map((b) => (
              <label key={b.id} htmlFor={`create-branch-${b.id}`} className="flex items-center gap-2 text-sm">
                <input id={`create-branch-${b.id}`} type="checkbox" checked={ids.includes(b.id)} onChange={() => toggle(b.id)} />
                {b.name}
              </label>
            ))}
            {problem === 'branches' && <p className="text-xs text-amber-800">{t('branchNeeds')}</p>}
          </fieldset>
        )}
        <Button type="submit" disabled={branches.length === 0}>{t('submit')}</Button>
        {created && <p role="status" className="text-sm text-green-800">{t('created')}</p>}
      </form>

      <Dialog open={open} onOpenChange={(next) => { if (!pending) setOpen(next); }}>
        <DialogContent>
          <DialogTitle>{t('confirmTitle')}</DialogTitle>
          <DialogDescription>{t('confirmHint')}</DialogDescription>
          <form onSubmit={confirmAndCreate} className="mt-4 space-y-3">
            <div className="space-y-1">
              <Label htmlFor="create-confirm-password">{t('confirmPassword')}</Label>
              <Input id="create-confirm-password" type="password" autoComplete="current-password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {dialogError && <p role="alert" className="text-sm text-red-700">{dialogError}</p>}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={pending || password.length === 0}>{pending ? t('creating') : t('confirmSubmit')}</Button>
              <Button type="button" variant="outline" disabled={pending} onClick={() => setOpen(false)}>{t('cancel')}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
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

/** Owner types the cashier's new password and confirms with their own, in one dialog. The cashier is signed out of every device. */
function ChangePasswordDialog({ account, onDone, onClose }: { account: CashierAccountDto; onDone: () => void; onClose: () => void }) {
  const t = useTranslations('cashier.dashboard.accounts');
  const create = useTranslations('cashier.dashboard.accounts.create');
  const errors = useTranslations('cashier.dashboard.accounts.errors');
  const [newPassword, setNewPassword] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    if (newPassword.length < MIN_PASSWORD) return setError(create('passwordNeeds'));
    setPending(true);
    setError(null);
    try {
      const reauthForm = new FormData();
      reauthForm.set('password', ownerPassword);
      const reauth = await cashierReauthAction({}, reauthForm);
      if (reauth.status !== 'reauthenticated') return setError(reauth.status === 'failed' ? create('confirmWrong') : errors('generic'));
      const form = new FormData();
      form.set('accountId', account.id);
      form.set('newPassword', newPassword);
      const result = await resetCashierCredentialAction({}, form);
      if (result.status === 'credentialReset') { setNewPassword(''); setOwnerPassword(''); onDone(); return; }
      setError(result.status === 'failed' && result.error && KNOWN_ERRORS.has(result.error) ? errors(result.error) : errors('generic'));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next && !pending) onClose(); }}>
      <DialogContent>
        <DialogTitle>{t('actions.changePasswordTitle', { name: account.displayName })}</DialogTitle>
        <DialogDescription>{t('actions.changePasswordHint')}</DialogDescription>
        <form onSubmit={submit} className="mt-4 space-y-3">
          <PasswordChoice id={`change-password-${account.id}`} label={t('actions.newPassword')} value={newPassword} onChange={setNewPassword} autoFocus />
          <div className="space-y-1">
            <Label htmlFor={`change-owner-password-${account.id}`}>{create('confirmPassword')}</Label>
            <Input id={`change-owner-password-${account.id}`} type="password" autoComplete="current-password" required value={ownerPassword} onChange={(e) => setOwnerPassword(e.target.value)} className="max-w-sm" />
          </div>
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending || newPassword.length === 0 || ownerPassword.length === 0}>{t('actions.changePasswordSubmit')}</Button>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>{create('cancel')}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AccountRow({ account, branches }: {
  account: CashierAccountDto; branches: CashierBranchOption[];
}) {
  const t = useTranslations('cashier.dashboard.accounts');
  const format = useFormatter();
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<CashierAccountsActionState>({});
  const revoked = account.status === 'revoked';
  const [changing, setChanging] = useState(false);
  const [changed, setChanged] = useState(false);
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
            <Button type="button" variant="outline" size="sm" onClick={() => { setChanged(false); setChanging(true); }}>{t('actions.resetCredential')}</Button>
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
      {changing && <ChangePasswordDialog account={account} onClose={() => setChanging(false)} onDone={() => { setChanging(false); setChanged(true); }} />}
      <Outcome state={saveState.status ? saveState : message} {...(changed ? { success: t('actions.changePasswordDone', { name: account.displayName }) } : {})} />
    </li>
  );
}

export function CashierAccountsView({ accounts, code, branches }: {
  accounts: CashierAccountDto[]; code: CashierBusinessCodeDto; branches: CashierBranchOption[];
}) {
  const t = useTranslations('cashier.dashboard.accounts');
  const [credential, setCredential] = useState<NonNullable<CashierAccountsActionState['credential']> | null>(null);

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
      </section>

      <CreateForm branches={branches} onCredential={setCredential} />

      <section aria-labelledby="list-title" className="space-y-3">
        <h2 id="list-title" className="text-lg font-semibold">{t('list.title')}</h2>
        {accounts.length === 0 ? (
          <p className="rounded-md border border-neutral-200 bg-white p-4 text-sm text-neutral-600">{t('list.empty')}</p>
        ) : (
          <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200 bg-white">
            {accounts.map((a) => <AccountRow key={a.id} account={a} branches={branches} />)}
          </ul>
        )}
      </section>
    </section>
  );
}
