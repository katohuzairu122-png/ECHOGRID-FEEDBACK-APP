# UI Phase 2A — Authenticated Business Overview sentiment cards

Status: development-only; owner review required. No automatic merge or deployment.

## Purpose

Close the Business Overview visual gap between the approved Echo Grid reference mockups and the merged Phase 1 work: show a distinct, three-card **Negative / Neutral / Positive** sentiment breakdown **below** the existing chart. Preserve the landing page's navy/emerald/cyan/violet design identity and the existing charts and real API metrics.

## Implementation boundary

- The existing `getBusinessOverview` trend read remains the only data source; cards receive `trendTotals(data.trend.data)`.
- Each category displays its classified count and percentage of classified responses for the same current period and authorized branch filter as the chart.
- No metric is shown if no classified responses are available, and denied/unavailable results continue to render explicit existing statuses rather than fabricated zeros.
- The original translated full summary is retained for screen readers.
- The presentation uses only workspace-scoped semantic theme tokens, with distinct negative, neutral and positive color indications plus readable text.
- No changes to business-selection, authorization, APIs, database, migrations, financial operations, login, landing page, or other workspaces.

## Checks

- New focused unit tests cover order, populated counts/percentages, empty-data suppression and zero-valued sentiment categories.
- Hosted exact-head CI, build, and responsive screenshot comparison remain **pending** until GitHub runs finish. Do not claim a visual PASS based on these source changes alone.
- Review against the supplied dark Business Overview reference image and actual narrow/mobile render at 390, tablet 820 and desktop 1440 pixels. Evaluate text wrapping and keyboard/screen-reader navigation.

## Exclusions

No financial activation, PR merge, release workflow dispatch or production deployment.
