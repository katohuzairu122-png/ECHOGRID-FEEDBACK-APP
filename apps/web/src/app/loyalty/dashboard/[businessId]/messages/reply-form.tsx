'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { sendReplyAction, type MessageFormState } from '@/lib/actions/messaging-customer';
import { Button, Textarea } from '@/components/ui';

const initialState: MessageFormState = {};

interface ReplyFormProps {
  businessId: string;
}

export function ReplyForm({ businessId }: ReplyFormProps) {
  const [state, formAction, pending] = useActionState(
    sendReplyAction.bind(null, businessId),
    initialState,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const t = useTranslations('loyalty.customer.messages');

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
