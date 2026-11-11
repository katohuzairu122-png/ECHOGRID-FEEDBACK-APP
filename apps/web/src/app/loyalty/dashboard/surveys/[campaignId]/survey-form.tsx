'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { SurveyQuestionDto } from '@echo-grid-feedback/shared-types';
import { Button, Input, Textarea } from '@/components/ui';
import { submitSurveyAction } from '@/lib/actions/surveys';
import type { SurveyAnswerValue, SurveySubmitState } from '@/lib/surveys-types';
import styles from '../surveys.module.css';

const INITIAL: SurveySubmitState = { status: 'idle' };

export function isAnswered(value: SurveyAnswerValue | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** Only answered questions are sent; unanswered optional questions are omitted. */
export function buildAnswers(
  questions: SurveyQuestionDto[],
  values: Record<string, SurveyAnswerValue | undefined>,
): { questionId: string; value: SurveyAnswerValue }[] {
  return questions.flatMap((question) => {
    const value = values[question.id];
    return isAnswered(value) ? [{ questionId: question.id, value: value as SurveyAnswerValue }] : [];
  });
}

export function SurveyForm({
  campaignId,
  questions,
  participationKey,
}: {
  campaignId: string;
  questions: SurveyQuestionDto[];
  participationKey: string;
}) {
  const t = useTranslations('loyalty.customer.surveys.take');
  const [state, action, pending] = useActionState(submitSurveyAction, INITIAL);
  const [values, setValues] = useState<Record<string, SurveyAnswerValue | undefined>>({});
  const [consent, setConsent] = useState(false);
  const set = (id: string, value: SurveyAnswerValue | undefined) =>
    setValues((previous) => ({ ...previous, [id]: value }));

  if (state.status === 'success') {
    return (
      <div className={styles.success} role="status">
        <h2>{t('successTitle')}</h2>
        <p>{t('successBody')}</p>
        <Link href="/loyalty/dashboard/surveys" className={styles.back}>
          {t('back')}
        </Link>
      </div>
    );
  }
  if (questions.length === 0) return <p className={styles.muted}>{t('noQuestions')}</p>;

  const missingRequired = questions.some((q) => q.required && !isAnswered(values[q.id]));
  const answers = buildAnswers(questions, values);

  return (
    <form action={action} className={styles.form}>
      <input type="hidden" name="campaignId" value={campaignId} />
      <input type="hidden" name="participationKey" value={participationKey} />
      <input type="hidden" name="answers" value={JSON.stringify(answers)} />
      {questions.map((question) => (
        <QuestionField
          key={question.id}
          question={question}
          value={values[question.id]}
          onChange={(value) => set(question.id, value)}
        />
      ))}
      <label className={styles.consent}>
        <input
          type="checkbox"
          name="consent"
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
        />
        <span>{t('consent')}</span>
      </label>
      {state.status === 'error' && (
        <p className={styles.error} role="alert">
          {t(`errors.${state.failure ?? 'unavailable'}`)}
        </p>
      )}
      <Button type="submit" disabled={pending || !consent || missingRequired}>
        {pending ? t('submitting') : t('submit')}
      </Button>
    </form>
  );
}

function QuestionField({
  question,
  value,
  onChange,
}: {
  question: SurveyQuestionDto;
  value: SurveyAnswerValue | undefined;
  onChange: (value: SurveyAnswerValue | undefined) => void;
}) {
  const t = useTranslations('loyalty.customer.surveys.take');
  const tag = (
    <span className={styles.tag}>{question.required ? t('required') : t('optional')}</span>
  );
  const id = `q-${question.id}`;
  const v = question.validation;

  if (question.type === 'text' || question.type === 'number') {
    const isNumber = question.type === 'number';
    return (
      <div className={styles.question}>
        <label htmlFor={id}>
          {question.label}
          {tag}
        </label>
        <Input
          id={id}
          type={isNumber ? 'number' : 'text'}
          inputMode={isNumber ? 'decimal' : undefined}
          {...(isNumber && v?.min !== undefined ? { min: v.min } : {})}
          {...(isNumber && v?.max !== undefined ? { max: v.max } : {})}
          {...(!isNumber && v?.maxLength !== undefined ? { maxLength: v.maxLength } : {})}
          value={typeof value === 'number' ? String(value) : ((value as string | undefined) ?? '')}
          onChange={(event) => {
            const raw = event.target.value;
            if (isNumber) onChange(raw === '' || Number.isNaN(Number(raw)) ? undefined : Number(raw));
            else onChange(raw);
          }}
        />
      </div>
    );
  }
  if (question.type === 'textarea') {
    return (
      <div className={styles.question}>
        <label htmlFor={id}>
          {question.label}
          {tag}
        </label>
        <Textarea
          id={id}
          rows={4}
          {...(v?.maxLength !== undefined ? { maxLength: v.maxLength } : {})}
          value={(value as string | undefined) ?? ''}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    );
  }
  if (question.type === 'multi_choice') {
    const selected = Array.isArray(value) ? value : [];
    return (
      <fieldset className={styles.question}>
        <legend>
          {question.label}
          {tag}
        </legend>
        <div className={styles.options}>
          {(question.options ?? []).map((option) => (
            <label key={option} className={styles.option}>
              <input
                type="checkbox"
                checked={selected.includes(option)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, option]
                      : selected.filter((item) => item !== option),
                  )
                }
              />
              {option}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }

  // single_choice, boolean, rating: one radio group.
  const choices: { label: string; value: SurveyAnswerValue }[] =
    question.type === 'boolean'
      ? [
          { label: t('yes'), value: true },
          { label: t('no'), value: false },
        ]
      : question.type === 'rating'
        ? Array.from({ length: (v?.max ?? 5) - (v?.min ?? 1) + 1 }, (_, i) => {
            const n = (v?.min ?? 1) + i;
            return { label: String(n), value: n };
          })
        : (question.options ?? []).map((option) => ({ label: option, value: option }));
  return (
    <fieldset className={styles.question}>
      <legend>
        {question.label}
        {tag}
      </legend>
      <div className={styles.options} role="radiogroup">
        {choices.map((choice) => (
          <label key={String(choice.value)} className={styles.option}>
            <input
              type="radio"
              name={id}
              checked={value === choice.value}
              onChange={() => onChange(choice.value)}
            />
            {choice.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
