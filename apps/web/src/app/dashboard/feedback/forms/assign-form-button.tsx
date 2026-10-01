'use client';

import { useActionState } from 'react';
import {
  assignFeedbackFormAction,
  type AssignFeedbackFormState,
} from '@/lib/actions/feedback-forms';
import { Button } from '@/components/ui';

const initialState: AssignFeedbackFormState = {};

export function AssignFormButton({
  branchId,
  versionId,
  branchName,
}: {
  branchId: string;
  versionId: string;
  branchName: string;
}) {
  const [state, action, pending] = useActionState(
    assignFeedbackFormAction.bind(null, branchId, versionId),
    initialState,
  );

  return (
    <form action={action} className="flex flex-col items-start gap-1">
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? 'Assigning…' : `Assign to ${branchName}`}
      </Button>
      {state.success && (
        <p role="status" className="text-xs font-medium text-brand-700">
          {state.success}
        </p>
      )}
      {state.error && (
        <p role="alert" className="text-xs text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}
