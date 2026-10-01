'use client';

import { useActionState } from 'react';
import { acceptInvitationAction, type TeamActionState } from '@/lib/actions/team';
import { Button } from '@/components/ui';

const initialState: TeamActionState = {};

export function AcceptInvitationForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(
    acceptInvitationAction.bind(null, token),
    initialState,
  );

  return (
    <form action={action} className="flex flex-col gap-3">
      <Button className="w-full" type="submit" disabled={pending}>
        {pending ? 'Accepting…' : 'Accept invitation'}
      </Button>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}
