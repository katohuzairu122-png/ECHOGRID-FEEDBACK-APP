'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';

type Props = { kind: 'unavailable' } | { kind: 'rateLimited'; retryAt: number };

export function MessagesLoadFailure(props: Props) {
  const t = useTranslations('loyalty.customer.messages');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const retryAt = props.kind === 'rateLimited' ? props.retryAt : 0;
  const [readyAt, setReadyAt] = useState(0);
  const waiting = retryAt > readyAt;

  useEffect(() => {
    if (!retryAt) return;
    const timer = setTimeout(() => setReadyAt(retryAt), Math.max(0, retryAt - Date.now()));
    return () => clearTimeout(timer);
  }, [retryAt]);

  return (
    <Card>
      <CardHeader role="alert">
        <CardTitle>{t('loadErrorTitle')}</CardTitle>
        <CardDescription>
          {t(props.kind === 'rateLimited' ? 'loadRateLimited' : 'loadUnavailable')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          type="button"
          disabled={pending || waiting}
          onClick={() => startTransition(() => router.refresh())}
        >
          {t(pending ? 'retryPending' : 'retry')}
        </Button>
      </CardContent>
    </Card>
  );
}
