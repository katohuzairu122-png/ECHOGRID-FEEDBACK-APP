'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { sendMessageAction, type MessageFormState } from '@/lib/actions/messaging';
import { Button, Textarea } from '@/components/ui';

const initialState: MessageFormState = {};

interface ReplyFormProps {
  conversationId: string;
}

/** Inline composer at the bottom of the thread -- no dialog wrapper needed,
 * unlike account-dialog.tsx's form (which opens on demand), since this is
 * always visible on the thread page. Clears on a successful send via a
 * plain ref-reset in an effect, same "success -> side effect via useEffect,
 * not during render" pattern as AccountDialog's auto-close. */
export function ReplyForm({ conversationId }: ReplyFormProps) {
  const [state, formAction, pending] = useActionState(
    sendMessageAction.bind(null, conversationId),
    initialState,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const t = useTranslations('messaging.staff.thread');

  useEffect(() => {
    if (state.success) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-2">
      <Textarea name="body" rows={3} maxLength={5000} placeholder={t('replyPlaceholder')} required />
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      <Button type="submit" disabled={pending} className="self-end">
        {pending ? t('sending') : t('send')}
      </Button>
    </form>
  );
}
