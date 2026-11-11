import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '@/test-utils';
import { LanguageSelector } from './language-selector';
import { setLanguageAction } from '@/lib/actions/language';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@/lib/actions/language', () => ({ setLanguageAction: vi.fn() }));

describe('LanguageSelector', () => {
  beforeEach(() => vi.clearAllMocks());

  it('offers every supported language by its own name, current locale selected', () => {
    render(<LanguageSelector />);
    const select = screen.getByLabelText('Language');
    expect(select).toHaveValue('en');
    for (const name of ['English', 'Español', 'Français', 'العربية']) {
      expect(screen.getByRole('option', { name })).toBeInTheDocument();
    }
  });

  it('saves the choice then refreshes the page', async () => {
    vi.mocked(setLanguageAction).mockResolvedValue({ ok: true });
    render(<LanguageSelector />);
    await userEvent.setup().selectOptions(screen.getByLabelText('Language'), 'fr');
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(setLanguageAction).toHaveBeenCalledWith('fr');
  });

  it('does not refresh when the save is rejected', async () => {
    vi.mocked(setLanguageAction).mockResolvedValue({ ok: false });
    render(<LanguageSelector />);
    await userEvent.setup().selectOptions(screen.getByLabelText('Language'), 'es');
    await waitFor(() => expect(setLanguageAction).toHaveBeenCalled());
    expect(refresh).not.toHaveBeenCalled();
  });
});
