import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '@/test-utils';
import { BusinessSurveysView } from './surveys-view';

const data = {
  surveys: [
    { id: 's1', name: 'Service quality', status: 'published' as const, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z' },
    { id: 's2', name: 'New menu', status: 'draft' as const, createdAt: '2026-11-03T00:00:00Z', updatedAt: '2026-11-03T00:00:00Z' },
  ],
  campaigns: [
    { id: 'c1', surveyId: 's1', name: 'November campaign', status: 'active' as const, startsAt: null, endsAt: null, maxResponses: null },
  ],
};

describe('BusinessSurveysView (read-only)', () => {
  it('lists the business surveys and campaigns with their status', () => {
    renderWithIntl(<BusinessSurveysView result={{ status: 'ready', data }} />);
    expect(screen.getByText('Service quality')).toBeInTheDocument();
    expect(screen.getByText('New menu')).toBeInTheDocument();
    expect(screen.getByTestId('survey-status-s1')).toHaveTextContent('Published');
    expect(screen.getByTestId('survey-status-s2')).toHaveTextContent('Draft');
    expect(screen.getByText('November campaign')).toBeInTheDocument();
    expect(screen.getByTestId('campaign-status-c1')).toHaveTextContent('Active');
  });

  it('exposes no create, publish, activate, pause or close control', () => {
    renderWithIntl(<BusinessSurveysView result={{ status: 'ready', data }} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('an empty business shows explicit empty states, not an error', () => {
    renderWithIntl(<BusinessSurveysView result={{ status: 'ready', data: { surveys: [], campaigns: [] } }} />);
    expect(screen.getByTestId('surveys-empty')).toBeInTheDocument();
    expect(screen.getByTestId('campaigns-empty')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('a forbidden read is an explicit denial with no retry and no lists', () => {
    renderWithIntl(<BusinessSurveysView result={{ status: 'forbidden' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('survey access');
    expect(screen.queryByTestId('surveys-list')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('an outage is never shown as an empty list and offers a retry', () => {
    renderWithIntl(<BusinessSurveysView result={{ status: 'unavailable' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('could not be loaded');
    expect(screen.queryByTestId('surveys-empty')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Try again' })).toHaveAttribute('href', '/dashboard/surveys');
  });
});
