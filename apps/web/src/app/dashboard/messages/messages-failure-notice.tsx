import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  buttonVariants,
} from '@/components/ui';

/** Explicit, retryable state for a Messages read that failed; a denial offers no retry. */
export function MessagesFailureNotice({ kind }: { kind: 'forbidden' | 'unavailable' }) {
  const t = useTranslations('messaging.staff');
  return (
    <Card role="alert">
      <CardHeader>
        <CardTitle>{kind === 'forbidden' ? t('forbiddenTitle') : t('unavailableTitle')}</CardTitle>
        <CardDescription>
          {kind === 'forbidden' ? t('forbiddenDescription') : t('unavailableDescription')}
        </CardDescription>
      </CardHeader>
      {kind === 'unavailable' && (
        <CardContent>
          <Link href="/dashboard/messages" className={buttonVariants({ variant: 'primary' })}>
            {t('retry')}
          </Link>
        </CardContent>
      )}
    </Card>
  );
}
