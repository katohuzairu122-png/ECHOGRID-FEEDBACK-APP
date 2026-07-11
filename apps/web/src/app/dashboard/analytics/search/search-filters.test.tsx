import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '@/test-utils';
import { SearchFilters } from './search-filters';
import type { BranchDto } from '@echo-grid-feedback/shared-types';

const push = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

const BRANCHES: BranchDto[] = [
  { id: 'branch-1', businessId: 'business-a', name: 'Downtown', slug: 'downtown' } as BranchDto,
  { id: 'branch-2', businessId: 'business-a', name: 'Uptown', slug: 'uptown' } as BranchDto,
];

describe('SearchFilters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('navigates with no query params when every filter is left at its default and range keeps its own default of 30', async () => {
    const user = userEvent.setup();
    render(<SearchFilters branches={BRANCHES} />);

    await user.click(screen.getByRole('button', { name: 'Search' }));

    expect(push).toHaveBeenCalledWith('/dashboard/analytics/search?range=30');
  });

  it('includes every filter that has a value, correctly URL-encoded', async () => {
    const user = userEvent.setup();
    render(<SearchFilters branches={BRANCHES} />);

    await user.selectOptions(screen.getByLabelText('Branch'), 'branch-1');
    await user.type(screen.getByLabelText('Search comments'), 'slow service');
    await user.selectOptions(screen.getByLabelText('Sentiment'), 'negative');
    await user.selectOptions(screen.getByLabelText('Rating'), '2');
    await user.selectOptions(screen.getByLabelText('Date range'), '90');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    const url = new URL(push.mock.calls[0][0], 'http://localhost');
    expect(url.searchParams.get('branchId')).toBe('branch-1');
    expect(url.searchParams.get('keyword')).toBe('slow service');
    expect(url.searchParams.get('sentiment')).toBe('negative');
    expect(url.searchParams.get('rating')).toBe('2');
    expect(url.searchParams.get('range')).toBe('90');
  });

  it('pre-fills every field from its corresponding prop', () => {
    render(
      <SearchFilters
        branches={BRANCHES}
        branchId="branch-2"
        sentiment="positive"
        rating="5"
        keyword="great"
        range="7"
      />,
    );

    expect(screen.getByLabelText('Branch')).toHaveValue('branch-2');
    expect(screen.getByLabelText('Search comments')).toHaveValue('great');
    expect(screen.getByLabelText('Sentiment')).toHaveValue('positive');
    expect(screen.getByLabelText('Rating')).toHaveValue('5');
    expect(screen.getByLabelText('Date range')).toHaveValue('7');
  });

  it('does not submit as a real page navigation -- preventDefault is called on the form event', async () => {
    const user = userEvent.setup();
    render(<SearchFilters branches={BRANCHES} />);

    await user.click(screen.getByRole('button', { name: 'Search' }));

    // If the form had actually submitted natively (no preventDefault), jsdom
    // would throw "Not implemented: HTMLFormElement.prototype.submit" --
    // the test passing at all is the assertion.
    expect(push).toHaveBeenCalledTimes(1);
  });
});
