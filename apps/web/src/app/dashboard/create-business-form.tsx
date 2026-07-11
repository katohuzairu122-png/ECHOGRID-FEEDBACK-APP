'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { createBusinessAction, type CreateBusinessState } from '@/lib/actions/business';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from '@/components/ui';

const initialState: CreateBusinessState = {};

export function CreateBusinessForm() {
  const [state, formAction, pending] = useActionState(createBusinessAction, initialState);
  // i18n & Multi-Currency Block 4.
  const t = useTranslations('dashboard.createBusiness');

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={formAction} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="name">{t('nameLabel')}</Label>
              <Input id="name" name="name" required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="slug">{t('slugLabel')}</Label>
              <Input id="slug" name="slug" pattern="[a-z0-9-]+" required />
              <p className="text-xs text-neutral-500">{t('slugHint')}</p>
            </div>
            {state.error && (
              <p role="alert" className="text-sm text-danger">
                {state.error}
              </p>
            )}
            <Button type="submit" disabled={pending} className="w-full">
              {pending ? t('submitPending') : t('submit')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
