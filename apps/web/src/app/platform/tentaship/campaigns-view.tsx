import type { CampaignRow } from './campaigns';

/**
 * TSH-06 (platform administration foundation): a READ-ONLY view of Shuffle campaign configuration and lifecycle. It deliberately has no release, publish,
 * invite, select, allocate or "go live" control: every version is `not_released` in the database and release needs legal approvals (L-1..L-6) that are not
 * recorded. Suspension, cancellation, cases and analytics are API operations for authorized operators; this page only shows recorded state.
 */
export function CampaignsView({ campaigns }: { campaigns: CampaignRow[] | null }) {
  return (
    <section aria-labelledby="tentaship-title" className="space-y-4">
      <h1 id="tentaship-title" className="text-2xl font-semibold">Tentaship Shuffle campaigns</h1>
      <p className="text-sm text-neutral-600" data-testid="no-release">
        Read-only. Campaigns cannot be released or opened to participants from here: every version is not released, and release requires approvals that are not yet recorded.
      </p>
      {campaigns === null ? (
        <p role="alert">Campaigns could not be loaded.</p>
      ) : campaigns.length === 0 ? (
        <p className="text-sm text-neutral-500">No campaigns have been configured.</p>
      ) : (
        <ul className="space-y-3">
          {campaigns.map((c) => (
            <li key={c.id} className="rounded-md border border-neutral-200 p-3">
              <p className="font-medium">{c.key} <span className="text-sm font-normal text-neutral-500">({c.mode === 'guaranteed' ? 'Mode A: every admitted participant' : 'Mode B: limited'})</span></p>
              <p className="text-sm">Status: <span data-testid={`status-${c.key}`}>{c.status}</span>{c.statusReason ? ` — ${c.statusReason}` : ''}</p>
              <ul className="mt-1 text-sm text-neutral-600">
                {c.versions.map((v) => (
                  <li key={v.version}>v{v.version}: minimum {v.minParticipants}, capacity {v.maxCapacity}, terms {v.termsVersion}, {v.releaseState.replace('_', ' ')}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
