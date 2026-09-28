import type { BranchDto, PublicFeedbackForm } from '@echo-grid-feedback/shared-types';
import { apiFetch } from '@/lib/api-client';
import { getActiveBusiness } from '@/lib/business';
import { redirect } from 'next/navigation';
import { FormBuilder } from './form-builder';
import { assignFeedbackFormAction } from '@/lib/actions/feedback-forms';
import { Button } from '@/components/ui';

export default async function FeedbackFormsPage() {
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');
  const [forms, branches] = await Promise.all([
    apiFetch<PublicFeedbackForm[]>('/feedback-forms', { businessId: business.id }),
    apiFetch<BranchDto[]>('/branches', { businessId: business.id }),
  ]);
  return <div className="space-y-6"><div><h1 className="text-2xl font-semibold">Feedback forms</h1><p className="text-sm text-neutral-500">Publish immutable question sets and assign them to branch QR codes.</p></div><FormBuilder />
    <div className="space-y-3">{forms.map((form) => <div key={form.versionId} className="rounded-lg border bg-white p-4"><h2 className="font-semibold">{form.name} · v{form.version}</h2><p className="text-sm text-neutral-500">{form.questions.length} questions</p><div className="mt-3 flex flex-wrap gap-2">{branches.map((branch) => <form key={branch.id} action={assignFeedbackFormAction.bind(null, branch.id, form.versionId)}><Button type="submit" variant="outline">Assign to {branch.name}</Button></form>)}</div><details className="mt-4"><summary className="cursor-pointer text-sm font-medium">Create a new version</summary><div className="mt-3"><FormBuilder formId={form.formId} initialName={form.name} initialQuestions={form.questions.map((q) => ({ key: q.key, label: q.label, type: q.type, required: q.required, ...(q.options ? { options: q.options } : {}) }))} /></div></details></div>)}</div>
  </div>;
}
