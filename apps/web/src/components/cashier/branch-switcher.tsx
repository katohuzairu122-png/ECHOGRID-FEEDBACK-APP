'use client';

import { useCallback, useState, useTransition } from 'react';
import {
  cashierListBranchesAction,
  cashierSwitchBranchAction,
  type CashierBranchSwitchState,
} from '@/lib/cashier/actions';
import { Button, Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui';

export interface BranchSwitcherCopy {
  button: string; title: string; hint: string; current: string; groupLabel: string; confirm: string; switching: string;
  loading: string; loadFailed: string; retry: string; success: string; noChange: string; denied: string; conflict: string;
  unavailable: string; close: string;
}

type Branch = { id: string; name: string };
type Message = { kind: 'success' | 'error'; text: string } | null;

/**
 * CASHIER-AUTH-02C: the active-branch switcher for a multi-branch managed cashier. The list is fetched from the server every time the
 * dialog opens (only branches the account is CURRENTLY assigned), a different branch must be chosen explicitly, and the server
 * decides: this component never decides authority. `{branch}` in `success` and `noChange` is filled in here from the server's answer.
 * Success replaces the session cookies in the server action, the page re-renders for the new branch, and the screens below are keyed
 * by branch so nothing from the previous branch survives. A conflict or denial refreshes the list; an ended session is handled by the
 * action itself (it signs the cashier out).
 */
export function BranchSwitcher({
  currentBranchId, currentBranchName, copy,
}: { currentBranchId: string; currentBranchName: string | null; copy: BranchSwitcherCopy }) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selected, setSelected] = useState<string>('');
  const [message, setMessage] = useState<Message>(null);
  const [loading, startLoad] = useTransition();
  const [switching, startSwitch] = useTransition();

  const load = useCallback(() => {
    startLoad(async () => {
      setLoadFailed(false);
      const r = await cashierListBranchesAction();
      if (r.status === 'ready' && r.branches) { setBranches(r.branches); setSelected((s) => (r.branches!.some((b) => b.id === s) ? s : '')); }
      else { setBranches(null); setLoadFailed(true); }
    });
  }, []);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) { setMessage(null); setSelected(''); load(); }
  };

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return; // explicit selection is required
    const form = new FormData();
    form.set('branchId', selected);
    form.set('fromBranchId', currentBranchId);
    startSwitch(async () => {
      const result: CashierBranchSwitchState = await cashierSwitchBranchAction({}, form);
      const fill = (text: string) => text.replace('{branch}', result.branchName ?? '');
      if (result.status === 'switched') { setMessage({ kind: 'success', text: fill(copy.success) }); setSelected(''); return; }
      if (result.status === 'unchanged') { setMessage({ kind: 'success', text: fill(copy.noChange) }); return; }
      setMessage({ kind: 'error', text: result.status === 'denied' ? copy.denied : result.status === 'conflict' ? copy.conflict : copy.unavailable });
      if (result.status === 'denied' || result.status === 'conflict') load(); // show the true, current list
    });
  };

  return (
    <>
      <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={() => onOpenChange(true)}>
        {copy.button}
      </Button>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.hint}</DialogDescription>
          <form onSubmit={submit} className="mt-4 space-y-4">
            {loading && !branches && <p role="status" className="text-sm text-neutral-600">{copy.loading}</p>}
            {loadFailed && (
              <div className="space-y-2">
                <p role="alert" className="text-sm text-red-700">{copy.loadFailed}</p>
                <Button type="button" variant="outline" size="sm" onClick={load}>{copy.retry}</Button>
              </div>
            )}
            {branches && (
              <fieldset className="space-y-2">
                <legend className="sr-only">{copy.groupLabel}</legend>
                {branches.map((b) => {
                  const isCurrent = b.id === currentBranchId;
                  return (
                    <label key={b.id} className={`flex min-h-12 items-center gap-3 rounded-md border px-3 py-2 text-base ${isCurrent ? 'border-neutral-200 bg-neutral-50 text-neutral-500' : 'border-neutral-300'}`}>
                      <input
                        type="radio" name="branch" value={b.id} disabled={isCurrent || switching}
                        checked={selected === b.id} onChange={() => setSelected(b.id)}
                      />
                      <span className="flex-1">{b.name}</span>
                      {isCurrent && <span className="text-xs font-medium">{copy.current}</span>}
                    </label>
                  );
                })}
              </fieldset>
            )}
            <div role="status" aria-live="polite" className="min-h-5 text-sm">
              {message?.kind === 'success' && <p className="text-green-800">{message.text}</p>}
              {message?.kind === 'error' && <p role="alert" className="text-red-700">{message.text}</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" className="min-h-12 flex-1" disabled={!selected || switching}>
                {switching ? copy.switching : copy.confirm}
              </Button>
              <DialogClose render={<Button type="button" variant="outline" className="min-h-12" />}>{copy.close}</DialogClose>
            </div>
          </form>
          {/* The header reads "{currentBranchName}"; this keeps the name available to assistive tech inside the dialog too. */}
          <p className="sr-only">{currentBranchName ?? ''}</p>
        </DialogContent>
      </Dialog>
    </>
  );
}
