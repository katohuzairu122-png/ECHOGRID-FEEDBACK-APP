import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '@/test-utils';
import { SummaryGenerator } from './summary-generator';
import { generateSummaryAction } from '@/lib/actions/analytics';

vi.mock('@/lib/actions/analytics', () => ({
  generateSummaryAction: vi.fn(),
}));

describe('SummaryGenerator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defaults to "weekly" and calls generateSummaryAction with the selected period on submit', async () => {
    const user = userEvent.setup();
    vi.mocked(generateSummaryAction).mockResolvedValue(undefined);

    render(<SummaryGenerator />);
    await user.click(screen.getByRole('button', { name: 'Generate summary' }));

    await waitFor(() =>
      expect(generateSummaryAction).toHaveBeenCalledWith({ periodType: 'weekly', branchId: undefined }),
    );
  });

  it('passes the currently selected branchId through unchanged', async () => {
    const user = userEvent.setup();
    vi.mocked(generateSummaryAction).mockResolvedValue(undefined);

    render(<SummaryGenerator branchId="branch-1" />);
    await user.click(screen.getByRole('button', { name: 'Generate summary' }));

    await waitFor(() =>
      expect(generateSummaryAction).toHaveBeenCalledWith({
        periodType: 'weekly',
        branchId: 'branch-1',
      }),
    );
  });

  it('switches to monthly when selected before submitting', async () => {
    const user = userEvent.setup();
    vi.mocked(generateSummaryAction).mockResolvedValue(undefined);

    render(<SummaryGenerator />);
    await user.selectOptions(screen.getByLabelText('Summary period'), 'monthly');
    await user.click(screen.getByRole('button', { name: 'Generate summary' }));

    await waitFor(() =>
      expect(generateSummaryAction).toHaveBeenCalledWith({ periodType: 'monthly', branchId: undefined }),
    );
  });

  it('shows a "queued" confirmation on success, not a completed summary -- generation is async', async () => {
    const user = userEvent.setup();
    vi.mocked(generateSummaryAction).mockResolvedValue(undefined);

    render(<SummaryGenerator />);
    await user.click(screen.getByRole('button', { name: 'Generate summary' }));

    expect(await screen.findByText(/Queued/)).toBeInTheDocument();
  });

  it('surfaces a failure with an inline error, not a silent no-op', async () => {
    const user = userEvent.setup();
    vi.mocked(generateSummaryAction).mockRejectedValue(new Error('network error'));

    render(<SummaryGenerator />);
    await user.click(screen.getByRole('button', { name: 'Generate summary' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not queue/i);
  });

  it('requires no confirmation prompt -- generating a summary is non-destructive, unlike QrCodeDialog\'s regenerate', async () => {
    const user = userEvent.setup();
    vi.mocked(generateSummaryAction).mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, 'confirm');

    render(<SummaryGenerator />);
    await user.click(screen.getByRole('button', { name: 'Generate summary' }));

    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
