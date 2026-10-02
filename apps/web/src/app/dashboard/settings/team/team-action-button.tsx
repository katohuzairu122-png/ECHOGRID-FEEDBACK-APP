'use client';

import { useActionState } from 'react';
import type { TeamActionState } from '@/lib/actions/team';
import { Button } from '@/components/ui';

const initialState: TeamActionState = {};

export function TeamActionButton({
  action,
  label,
  pendingLabel,
}: {
  action: (state: TeamActionState) => Promise<TeamActionState>;
  label: string;
  pendingLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="flex flex-col items-start gap-1">
      <Button size="sm" variant="outline" type="submit" disabled={pending}>
        {pending ? pendingLabel : label}
      </Button>
      {state.success && <p role="status" className="text-xs font-medium text-brand-700">{state.success}</p>}
      {state.error && <p role="alert" className="max-w-xs text-xs text-danger">{state.error}</p>}
    </form>
  );
}
