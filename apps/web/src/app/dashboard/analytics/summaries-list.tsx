import { getFormatter, getTranslations } from 'next-intl/server';
import type { FeedbackSummaryDto } from '@echo-grid-feedback/shared-types';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';

/** Derived directly from getFormatter's own return type rather than a
 * hand-written structural guess -- always exactly right regardless of
 * which next-intl version's exact exported type name this maps to. */
type Formatter = Awaited<ReturnType<typeof getFormatter>>;
/** Same reasoning, for getTranslations (i18n & Multi-Currency Block 7). */
type Translator = Awaited<ReturnType<typeof getTranslations>>;

/**
 * `format` is resolved once by the async SummariesList below and threaded
 * through, rather than each row calling getFormatter() itself (i18n &
 * Multi-Currency Block 3) -- getFormatter() is async, and there's no reason
 * to re-resolve the same request-scoped formatter once per summary card.
 * `t` (Block 7) follows the same threading reasoning.
 */
function formatPeriod(summary: FeedbackSummaryDto, format: Formatter, t: Translator): string {
  const start = format.dateTime(new Date(summary.periodStart), 'short');
  const end = format.dateTime(new Date(summary.periodEnd), 'short');
  const label = summary.periodType === 'weekly' ? t('weekly') : t('monthly');
  return `${label}: ${start} – ${end}`;
}

interface SummariesListProps {
  summaries: FeedbackSummaryDto[];
}

/**
 * `recommendations` is stored as plain text, one item per line, not jsonb
 * (see feedback-summaries.ts's schema comment: forcing strict-JSON out of
 * an LLM is a real reliability risk this schema deliberately avoided) -- so
 * splitting it into list items is a display concern, done here rather than
 * expecting the API to have already structured it. Leading markers the LLM
 * may have already included ("1. ", "- ") are stripped so they don't
 * double up with this component's own <ul> bullet.
 */
export async function SummariesList({ summaries }: SummariesListProps) {
  // i18n & Multi-Currency Block 7.
  const t = await getTranslations('analytics.summariesList');

  if (summaries.length === 0) {
    return <p className="py-4 text-sm text-neutral-500">{t('empty')}</p>;
  }

  // i18n & Multi-Currency Block 3 -- see dashboard/feedback/page.tsx's
  // identical comment.
  const format = await getFormatter();

  return (
    <div className="flex flex-col gap-3">
      {summaries.map((summary) => {
        const recommendations = summary.recommendations
          .split('\n')
          .map((line) => line.replace(/^[-*\d.\s]+/, '').trim())
          .filter(Boolean);

        return (
          <Card key={summary.id}>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-base">{formatPeriod(summary, format, t)}</CardTitle>
                <div className="flex gap-1.5">
                  <Badge variant="success">{t('positive', { count: summary.positiveCount })}</Badge>
                  <Badge variant="neutral">{t('neutral', { count: summary.neutralCount })}</Badge>
                  <Badge variant="danger">{t('negative', { count: summary.negativeCount })}</Badge>
                </div>
              </div>
              <CardDescription>{t('feedbackCount', { count: summary.feedbackCount })}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-sm text-neutral-800">{summary.summary}</p>
              {recommendations.length > 0 && (
                <ul className="list-disc pl-5 text-sm text-neutral-700">
                  {recommendations.map((rec, i) => (
                    <li key={i}>{rec}</li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
