'use client';

import { useState, useTransition } from 'react';
import { createFeedbackFormAction, createFeedbackFormVersionAction } from '@/lib/actions/feedback-forms';
import { Button, Input, Label } from '@/components/ui';

type Question = { key: string; label: string; type: 'text'|'textarea'|'rating'|'single_choice'|'multi_choice'|'boolean'; required: boolean; options?: string[] };

export function FormBuilder({ formId, initialName = '', initialQuestions }: { formId?: string; initialName?: string; initialQuestions?: Question[] } = {}) {
  const [name, setName] = useState(initialName);
  const [questions, setQuestions] = useState<Question[]>(initialQuestions ?? [{ key: 'experience', label: '', type: 'textarea', required: true }]);
  const [pending, startTransition] = useTransition();
  const update = (i: number, patch: Partial<Question>) => setQuestions((all) => all.map((q, n) => n === i ? { ...q, ...patch } : q));
  return (
    <form className="space-y-4 rounded-lg border bg-white p-5" onSubmit={(e) => { e.preventDefault(); startTransition(async () => { const payload = { name, questions }; if (formId) await createFeedbackFormVersionAction(formId, payload); else await createFeedbackFormAction(payload); if (!formId) setName(''); }); }}>
      <div><Label htmlFor="form-name">Form name</Label><Input id="form-name" value={name} onChange={(e) => setName(e.target.value)} required /></div>
      {questions.map((q, i) => <div key={i} className="grid gap-3 rounded-md border p-3 sm:grid-cols-4">
        <div><Label>Key</Label><Input value={q.key} onChange={(e) => update(i, { key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} required /></div>
        <div><Label>Question</Label><Input value={q.label} onChange={(e) => update(i, { label: e.target.value })} required /></div>
        <div><Label>Type</Label><select className="h-10 w-full rounded-md border px-2" value={q.type} onChange={(e) => update(i, { type: e.target.value as Question['type'] })}>{['text','textarea','rating','single_choice','multi_choice','boolean'].map((v) => <option key={v}>{v}</option>)}</select></div>
        <label className="flex items-center gap-2 pt-6"><input type="checkbox" checked={q.required} onChange={(e) => update(i, { required: e.target.checked })} />Required</label>
        {(q.type === 'single_choice' || q.type === 'multi_choice') && <div className="sm:col-span-4"><Label>Options (comma separated)</Label><Input value={q.options?.join(', ') ?? ''} onChange={(e) => update(i, { options: e.target.value.split(',').map((v) => v.trim()).filter(Boolean) })} /></div>}
        {questions.length > 1 && <Button type="button" variant="outline" onClick={() => setQuestions((all) => all.filter((_, n) => n !== i))}>Remove</Button>}
      </div>)}
      <div className="flex gap-3"><Button type="button" variant="outline" onClick={() => setQuestions((all) => [...all, { key: `question_${all.length + 1}`, label: '', type: 'text', required: false }])}>Add question</Button><Button type="submit" disabled={pending}>{pending ? 'Publishing…' : formId ? 'Publish new version' : 'Publish form'}</Button></div>
    </form>
  );
}

