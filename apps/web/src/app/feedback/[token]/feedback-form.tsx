'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import {
  submitFeedbackAction,
  generateFollowUpQuestionAction,
  type FeedbackFormState,
  type FollowUpQuestionState,
} from '@/lib/actions/qr-feedback';
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
import { PoweredByFooter } from '@/components/brand';

const followUpInitial: FollowUpQuestionState = {};
const submitInitial: FeedbackFormState = {};

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
 *
 * Three steps: rate+comment -> an optional AI follow-up question -> thank
 * you. Two separate useActionState-bound forms, not one form with
 * conditional fields -- followUpState.ready gates which one renders, same
 * pattern as loyalty/login/otp-login-form.tsx, with step 1's fields carried
 * forward into step 2 as hidden inputs rather than re-entered.
 */
export function FeedbackForm({ token, branchName, businessName }: FeedbackFormProps) {
  const [followUpState, followUpFormAction, followUpPending] = useActionState(
    generateFollowUpQuestionAction.bind(null, token),
    followUpInitial,
  );
  const [submitState, submitFormAction, submitPending] = useActionState(
    submitFeedbackAction.bind(null, token),
    submitInitial,
  );
  // i18n & Multi-Currency Block 5.
  const t = useTranslations('feedback.submit');

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-neutral-50 p-4 sm:p-8">
      <Card className="w-full max-w-md">
        {submitState.success ? (
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
              {!followUpState.ready ? (
                <form action={followUpFormAction} className="flex flex-col gap-5">
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

                  <Button type="submit" disabled={followUpPending} size="lg" className="w-full">
                    {followUpPending ? t('continuing') : t('continue')}
                  </Button>
                </form>
              ) : (
                <form action={submitFormAction} className="flex flex-col gap-5">
                  <input type="hidden" name="rating" value={followUpState.rating} />
                  <input type="hidden" name="comment" value={followUpState.comment ?? ''} />
                  <input type="hidden" name="customerName" value={followUpState.customerName ?? ''} />
                  <input type="hidden" name="customerEmail" value={followUpState.customerEmail ?? ''} />
                  <input type="hidden" name="customerPhone" value={followUpState.customerPhone ?? ''} />

                  {followUpState.question ? (
                    <>
                      <input type="hidden" name="followUpQuestion" value={followUpState.question} />
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="followUpAnswer">{followUpState.question}</Label>
                        <Textarea id="followUpAnswer" name="followUpAnswer" rows={3} maxLength={2000} />
                      </div>
                      <div className="flex gap-3">
                        <Button
                          type="submit"
                          name="skipFollowUp"
                          value="1"
                          variant="outline"
                          disabled={submitPending}
                          className="flex-1"
                        >
                          {t('skip')}
                        </Button>
                        <Button type="submit" disabled={submitPending} className="flex-1">
                          {submitPending ? t('submitting') : t('submit')}
                        </Button>
                      </div>
                    </>
                  ) : (
                    <Button type="submit" disabled={submitPending} size="lg" className="w-full">
                      {submitPending ? t('submitting') : t('submit')}
                    </Button>
                  )}

                  {submitState.error && (
                    <p role="alert" className="text-sm text-danger">
                      {submitState.error}
                    </p>
                  )}
                </form>
              )}
            </CardContent>
          </>
        )}
      </Card>
      <PoweredByFooter />
    </main>
  );
}
