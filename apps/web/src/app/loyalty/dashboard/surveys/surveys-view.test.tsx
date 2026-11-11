import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '@/test-utils';
import type { SurveyParticipationRow, SurveysHubData } from '@/lib/surveys-types';
import { SurveysView } from './surveys-view';

const row = (over: Partial<SurveyParticipationRow> = {}): SurveyParticipationRow => ({
  id: 'p1',
  surveyId: 's1',
  surveyVersionId: 'v1',
  campaignId: 'c1',
  businessId: 'b1',
  branchId: null,
  status: 'completed',
  source: 'business_qr',
  startedAt: '2026-10-01T10:00:00.000Z',
  submittedAt: '2026-10-01T10:05:00.000Z',
  completedAt: '2026-10-01T10:06:00.000Z',
  invalidatedAt: null,
  businessName: 'Buddy Cafe',
  ...over,
});
const ready = (items: SurveyParticipationRow[], offset = 0, hasMore = false): SurveysHubData => ({
  participations: { status: 'ready', data: { items, offset, hasMore } },
});

describe('SurveysView', () => {
  it('lists history with business and status; only in-progress rows offer Continue', () => {
    renderWithIntl(
      <SurveysView data={ready([row(), row({ id: 'p2', campaignId: 'c2', status: 'started', completedAt: null, submittedAt: null })])} />,
    );
    expect(screen.getAllByText(/at Buddy Cafe/)).toHaveLength(2);
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('In progress')).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: 'Continue' });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/loyalty/dashboard/surveys/c2');
  });

  it('shows an honest empty state with how to find surveys', () => {
    renderWithIntl(<SurveysView data={ready([])} />);
    expect(screen.getByText('No surveys yet')).toBeInTheDocument();
    expect(screen.getByText(/Scan a business QR code/)).toBeInTheDocument();
  });

  it('a failure is never shown as an empty list; forbidden has no retry', () => {
    const { unmount } = renderWithIntl(<SurveysView data={{ participations: { status: 'unavailable' } }} />);
    expect(screen.getByRole('status')).toHaveTextContent('could not be loaded');
    expect(screen.queryByText('No surveys yet')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Try again' })).toHaveAttribute('href', '/loyalty/dashboard/surveys');
    unmount();
    renderWithIntl(<SurveysView data={{ participations: { status: 'forbidden' } }} />);
    expect(screen.getByRole('status')).toHaveTextContent('not available with your current access');
    expect(screen.queryByRole('link', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('pages with Older/Newer links', () => {
    renderWithIntl(<SurveysView data={ready([row()], 20, true)} />);
    expect(screen.getByRole('link', { name: 'Older' })).toHaveAttribute('href', '/loyalty/dashboard/surveys?offset=40');
    expect(screen.getByRole('link', { name: 'Newer' })).toHaveAttribute('href', '/loyalty/dashboard/surveys');
  });
});
