'use client';

import { useActionState, useState } from 'react';
import { Badge, Button, Input, Label, Textarea } from '@/components/ui';
import { moderatePost } from './actions';
import { locales, reasons, type ModerationResult, type PendingRevision } from './moderation';

const selectStyle =
  'w-full rounded-md border border-neutral-300 bg-neutral-50 p-2 text-sm text-neutral-900';
const panelStyle = 'min-w-0 space-y-4 rounded-xl border border-neutral-200 bg-neutral-50 p-4';

function Target({ value }: { value: string }) {
  return <input type="hidden" name="target" value={value} />;
}

function Reason({ id }: { id: string }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>Moderation reason</Label>
      <select className={selectStyle} id={id} name="reason" required defaultValue="">
        <option value="">Choose a reason</option>
        {reasons.map((reason) => (
          <option key={reason} value={reason}>
            {reason.replaceAll('_', ' ')}
          </option>
        ))}
      </select>
    </div>
  );
}

function Result({ result }: { result: ModerationResult }) {
  return (
    <>
      {result.error && (
        <p role="alert" className="text-sm text-red-600">
          {result.error}
        </p>
      )}
      {result.notice && (
        <div role="status" className="space-y-1 break-words text-sm">
          <p>{result.notice}</p>
          {result.handle && (
            <p>
              Post handle <code>{result.handle}</code>
            </p>
          )}
          {result.post && (
            <>
              <p>
                <code>{result.post.handle}</code> · {result.post.state}
                {result.post.pinned && ' · pinned'}
              </p>
              {result.post.expiresAt && (
                <p>
                  {Date.parse(result.post.expiresAt) <= Date.now() ? 'Expired' : 'Expires'}{' '}
                  <time dateTime={result.post.expiresAt}>{result.post.expiresAt}</time>
                </p>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}

function Authoring() {
  const [draft, save, saving] = useActionState(moderatePost, {});
  const [submitted, submit, submitting] = useActionState(moderatePost, {});
  const [body, setBody] = useState('');
  const [link, setLink] = useState('');
  const [locale, setLocale] = useState('en');
  const [handle, setHandle] = useState('');
  return (
    <section aria-labelledby="author-heading" className={panelStyle}>
      <h2 id="author-heading" className="text-lg font-semibold">
        Official post authoring
      </h2>
      <p className="text-sm text-neutral-600">
        Leave the handle blank to create a draft. To edit a post, enter its handle and supply the
        full replacement text, language and optional link.
      </p>
      <form action={save} className="space-y-3" aria-busy={saving}>
        <fieldset disabled={saving || submitting} className="space-y-3">
          <div>
            <Label htmlFor="author-handle">Existing post handle</Label>
            <Input
              id="author-handle"
              name="target"
              value={handle}
              onChange={(event) => setHandle(event.target.value)}
            />
          </div>
          <input type="hidden" name="operation" value={handle.trim() ? 'save' : 'create'} />
          <div>
            <Label htmlFor="post-body">Post text</Label>
            <Textarea
              id="post-body"
              name="body"
              required
              maxLength={4000}
              rows={5}
              aria-describedby="post-body-help"
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
            <p id="post-body-help" className="text-sm text-neutral-600">
              Plain text, up to 2,000 characters. Keep personal information out of posts.
            </p>
          </div>
          <div>
            <Label htmlFor="post-locale">Content language</Label>
            <select
              className={selectStyle}
              id="post-locale"
              name="locale"
              value={locale}
              onChange={(event) => setLocale(event.target.value)}
            >
              {locales.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="post-link">HTTPS link (optional)</Label>
            <Input
              type="url"
              id="post-link"
              name="link"
              maxLength={2048}
              value={link}
              onChange={(event) => setLink(event.target.value)}
            />
          </div>
          <Button type="submit">
            {saving ? 'Saving…' : handle.trim() ? 'Save draft revision' : 'Create draft'}
          </Button>
        </fieldset>
      </form>
      <Result result={draft} />
      {draft.handle && !handle.trim() && (
        <Button type="button" variant="outline" onClick={() => setHandle(draft.handle ?? '')}>
          Continue editing saved draft
        </Button>
      )}
      <form action={submit} className="space-y-2" aria-busy={submitting}>
        <input type="hidden" name="operation" value="submit" />
        <Label htmlFor="submit-handle">Saved draft handle</Label>
        <Input
          key={draft.handle}
          id="submit-handle"
          name="target"
          defaultValue={draft.handle}
          required
        />
        <Button type="submit" variant="outline" disabled={saving || submitting}>
          {submitting ? 'Submitting…' : 'Submit for approval'}
        </Button>
      </form>
      <Result result={submitted} />
    </section>
  );
}

function ReviewCard({ revision }: { revision: PendingRevision }) {
  const [result, action, pending] = useActionState(moderatePost, {});
  const reasonId = `reason-${revision.revisionId}`;
  return (
    <article className={panelStyle} aria-labelledby={`revision-${revision.revisionId}`}>
      <header className="flex flex-wrap items-center gap-2">
        <h3 id={`revision-${revision.revisionId}`} className="break-all font-semibold">
          {revision.postHandle} · Revision {revision.revisionNo}
        </h3>
        <Badge variant="accent">{revision.approvals} of 2 approvals</Badge>
      </header>
      {revision.submittedAt && (
        <p className="text-sm">
          Submitted <time dateTime={revision.submittedAt}>{revision.submittedAt}</time>
        </p>
      )}
      <p dir="auto" className="whitespace-pre-wrap break-words" lang={revision.contentLocale}>
        {revision.body}
      </p>
      {revision.linkUrl && (
        <p className="break-all text-sm">
          Proposed link <code>{revision.linkUrl}</code>
        </p>
      )}
      <div className="flex flex-wrap items-end gap-4">
        <form action={action} aria-busy={pending}>
          <Target value={revision.revisionId} />
          <Button type="submit" name="operation" value="approve" disabled={pending}>
            Approve revision
          </Button>
        </form>
        <form action={action} aria-busy={pending} className="space-y-2">
          <Target value={revision.revisionId} />
          <Reason id={reasonId} />
          <Button
            type="submit"
            name="operation"
            value="reject"
            variant="outline"
            disabled={pending}
          >
            Reject revision
          </Button>
        </form>
      </div>
      <Result result={result} />
    </article>
  );
}

function ExistingPost() {
  const [result, action, pending] = useActionState(moderatePost, {});
  const [operation, setOperation] = useState('suspend');
  return (
    <section aria-labelledby="manage-heading" className={panelStyle}>
      <h2 id="manage-heading" className="text-lg font-semibold">
        Moderate by post handle
      </h2>
      <p className="text-sm text-neutral-600">
        Use the handle from the queue or the draft receipt. Withdrawal is permanent.
      </p>
      <form action={action} aria-busy={pending}>
        <fieldset disabled={pending} className="space-y-3">
          <div>
            <Label htmlFor="manage-handle">Post handle</Label>
            <Input
              id="manage-handle"
              name="target"
              required
              pattern="[A-Za-z0-9_\\-]{22}"
              onChange={(event) => {
                const confirm = event.target.form?.elements.namedItem('confirm');
                if (confirm instanceof HTMLInputElement) confirm.checked = false;
              }}
            />
          </div>
          <div>
            <Label htmlFor="manage-action">Action</Label>
            <select
              className={selectStyle}
              name="operation"
              id="manage-action"
              value={operation}
              onChange={(event) => setOperation(event.target.value)}
            >
              <option value="suspend">Suspend</option>
              <option value="lift">Lift suspension</option>
              <option value="withdraw">Withdraw</option>
              <option value="pin">Pin</option>
              <option value="unpin">Unpin</option>
            </select>
          </div>
          {operation === 'suspend' && <Reason id="suspension-reason" />}
          <label key={operation} className="flex items-center gap-2 text-sm">
            <input name="confirm" type="checkbox" required />
            Apply this action to the specified post
          </label>
          <Button type="submit" disabled={pending}>
            {pending ? 'Applying…' : 'Apply action'}
          </Button>
        </fieldset>
      </form>
      <Result result={result} />
    </section>
  );
}

export function ModerationWorkspace({ queue }: { queue: PendingRevision[] }) {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Community moderation</h1>
        <p className="text-sm text-neutral-600">
          Official posts require two distinct approvers. Authors cannot approve their own revisions.
        </p>
      </header>
      <section aria-labelledby="queue-heading" className="space-y-3">
        <h2 id="queue-heading" className="text-lg font-semibold">
          Pending approval
        </h2>
        {queue.length === 0 && <p className="text-sm">No revisions are awaiting review.</p>}
        {queue.map((revision) => (
          <ReviewCard key={revision.revisionId} revision={revision} />
        ))}
      </section>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Authoring />
        <ExistingPost />
      </div>
    </div>
  );
}
