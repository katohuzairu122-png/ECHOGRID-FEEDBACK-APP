'use client';

import { useRef, useState, useTransition, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import {
  createFeedbackFormSchema,
  feedbackQuestionTypeSchema,
  type CreateFeedbackFormInput,
} from '@echo-grid-feedback/shared-types';
import {
  createFeedbackFormAction,
  createFeedbackFormVersionAction,
} from '@/lib/actions/feedback-forms';
import { Button, Input, Select } from '@/components/ui';

type Question = CreateFeedbackFormInput['questions'][number];
type DraftQuestion = Question & { rowId: number; optionsText?: string };

interface FormBuilderProps {
  formId?: string;
  initialName?: string;
  initialQuestions?: Question[];
}

export function FormBuilder({ formId, initialName = '', initialQuestions }: FormBuilderProps = {}) {
  const t = useTranslations('feedback.formBuilder');
  const [name, setName] = useState(initialName);
  const [questions, setQuestions] = useState<DraftQuestion[]>(() =>
    (initialQuestions ?? [{ key: 'experience', label: '', type: 'textarea', required: true }]).map(
      (question, rowId) => ({
        ...question,
        rowId,
        ...(question.options ? { optionsText: question.options.join(', ') } : {}),
      }),
    ),
  );
  const nextRowId = useRef(questions.length);
  const [pending, startTransition] = useTransition();
  const [invalid, setInvalid] = useState(false);

  function update(rowId: number, patch: Partial<DraftQuestion>) {
    setQuestions((all) =>
      all.map((question) => (question.rowId === rowId ? { ...question, ...patch } : question)),
    );
  }

  function addQuestion() {
    const rowId = nextRowId.current++;
    setQuestions((all) => {
      const keys = new Set(all.map((question) => question.key.trim()));
      let suffix = all.length + 1;
      while (keys.has(`question_${suffix}`)) suffix++;
      return [
        ...all,
        { rowId, key: `question_${suffix}`, label: '', type: 'text', required: false },
      ];
    });
  }

  function publish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const result = createFeedbackFormSchema.safeParse({
      name,
      questions: questions.map(({ rowId: _rowId, optionsText, ...question }) => ({
        ...question,
        ...(optionsText !== undefined
          ? {
              options: optionsText
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean),
            }
          : {}),
      })),
    });
    setInvalid(!result.success);
    if (!result.success) return;

    startTransition(async () => {
      if (formId) await createFeedbackFormVersionAction(formId, result.data);
      else {
        await createFeedbackFormAction(result.data);
        setName('');
      }
    });
  }

  return (
    <form className="space-y-4 rounded-lg border bg-white p-4 sm:p-5" onSubmit={publish}>
      <label className="grid gap-1.5">
        <span className="text-sm font-medium">{t('name')}</span>
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={200}
        />
      </label>

      {questions.map((question, index) => (
        <fieldset key={question.rowId} className="min-w-0 space-y-3 rounded-md border p-3">
          <legend className="px-1 text-sm font-medium">
            {t('questionNumber', { number: index + 1 })}
          </legend>
          <label className="grid gap-1.5">
            <span className="text-sm font-medium">{t('question')}</span>
            <Input
              value={question.label}
              onChange={(event) => update(question.rowId, { label: event.target.value })}
              required
              maxLength={500}
            />
          </label>

          <details className="space-y-3">
            <summary className="cursor-pointer text-sm font-medium">{t('settings')}</summary>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid min-w-0 gap-1.5">
                <span className="text-sm font-medium">{t('key')}</span>
                <Input
                  value={question.key}
                  maxLength={100}
                  onChange={(event) =>
                    update(question.rowId, {
                      key: event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
                    })
                  }
                />
              </label>
              <label className="grid min-w-0 gap-1.5">
                <span className="text-sm font-medium">{t('type')}</span>
                <Select
                  value={question.type}
                  onChange={(event) =>
                    update(question.rowId, { type: event.target.value as Question['type'] })
                  }
                >
                  {feedbackQuestionTypeSchema.options.map((type) => (
                    <option key={type} value={type}>
                      {t(`types.${type}`)}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={question.required}
                  onChange={(event) => update(question.rowId, { required: event.target.checked })}
                />
                {t('required')}
              </label>

              {(question.type === 'single_choice' || question.type === 'multi_choice') && (
                <label className="grid gap-1.5 sm:col-span-2">
                  <span className="text-sm font-medium">{t('options')}</span>
                  <Input
                    value={question.optionsText ?? ''}
                    onChange={(event) =>
                      update(question.rowId, { optionsText: event.target.value })
                    }
                  />
                </label>
              )}
            </div>
          </details>

          {questions.length > 1 && (
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                setQuestions((all) => all.filter((item) => item.rowId !== question.rowId))
              }
            >
              {t('remove', { number: index + 1 })}
            </Button>
          )}
        </fieldset>
      ))}

      {invalid && (
        <p role="alert" className="text-sm text-danger">
          {t('invalid')}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={addQuestion}
          disabled={questions.length >= 50}
        >
          {t('add')}
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? t('publishing') : formId ? t('publishVersion') : t('publish')}
        </Button>
      </div>
    </form>
  );
}
