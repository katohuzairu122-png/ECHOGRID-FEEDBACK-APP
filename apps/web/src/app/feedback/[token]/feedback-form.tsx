'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { submitFeedbackAction, type FeedbackFormState } from '@/lib/actions/qr-feedback';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  StarRating,
  Textarea,
} from '@/components/ui';

const initialState: FeedbackFormState = {};

interface FeedbackFormProps {
  token: string;
  branchName: string;
  businessName: string;
}

/**
 * The interactive half of the landing page (page.tsx does the server-side
 * token resolve and hands down branchName/businessName as plain props).
 * Contact fields sit inside a native <details> disclosure, collapsed by
 * default -- a contact-info wall in front of a star rating would defeat
 * the point of a frictionless QR flow (same reasoning already documented
 * on submitFeedbackSchema in shared-types), and <details> needs no extra
 * client state to stay collapsed/expanded, unlike a custom toggle would.
 */
export function FeedbackForm({ token, branchName, businessName }: FeedbackFormProps) {
  const action = submitFeedbackAction.bind(null, token);
  const [state, formAction, pending] = useActionState(action, initialState);
  // i18n & Multi-Currency Block 5.
  const t = useTranslations('feedback.submit');

  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 p-4 sm:p-8">
      <Card className="w-full max-w-md">
        {state.success ? (
          <CardContent className="flex flex-col items-center gap-2 py-14 text-center">
            <CardTitle>{t('thankYouTitle')}</CardTitle>
            <CardDescription>{t('thankYouDescription', { branchName })}</CardDescription>
          </CardContent>
        ) : (
          <>
            <CardHeader>
              <CardTitle>{t('heading')}</CardTitle>
              <CardDescription>
                {branchName} · {businessName}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form action={formAction} className="flex flex-col gap-5">
                <div className="flex flex-col items-center gap-2 py-2">
                  <StarRating name="rating" required />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="comment">{t('commentLabel')}</Label>
                  <Textarea
                    id="comment"
                    name="comment"
                    rows={4}
                    maxLength={2000}
                    placeholder={t('commentPlaceholder')}
                  />
                </div>

                <details className="rounded-md border border-neutral-200 p-3">
                  <summary className="cursor-pointer text-sm font-medium text-neutral-700">
                    {t('contactDisclosure')}
                  </summary>
                  <div className="mt-3 flex flex-col gap-3">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="customerName">{t('nameLabel')}</Label>
                      <Input id="customerName" name="customerName" autoComplete="name" />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="customerEmail">{t('emailLabel')}</Label>
                      <Input
                        id="customerEmail"
                        name="customerEmail"
                        type="email"
                        autoComplete="email"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="customerPhone">{t('phoneLabel')}</Label>
                      <Input id="customerPhone" name="customerPhone" type="tel" autoComplete="tel" />
                    </div>
                  </div>
                </details>

                {state.error && (
                  <p role="alert" className="text-sm text-danger">
                    {state.error}
                  </p>
                )}

                <Button type="submit" disabled={pending} size="lg" className="w-full">
                  {pending ? t('submitting') : t('submit')}
                </Button>
              </form>
            </CardContent>
          </>
        )}
      </Card>
    </main>
  );
}
