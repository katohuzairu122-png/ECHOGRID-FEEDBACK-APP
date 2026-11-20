import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderWithIntl } from '@/test-utils';
import { BusinessFinder, type BusinessFinderLabels } from './business-finder';

const labels: BusinessFinderLabels = {
  selectLabel: 'Registered businesses',
  selectPlaceholder: 'Choose a business…',
  empty: 'No businesses yet',
  loadError: 'Could not load the list',
  chosenTitleTemplate: 'Join {name}',
  chosenBodyTemplate: 'Scan the QR code at {name}',
  accountCta: 'Create or open my customer account',
  accountNote: 'You will verify your phone',
};

describe('BusinessFinder (LANDING-ROLE-01)', () => {
  it('lists the registered names; choosing one shows how to join it and links to the customer sign-in', async () => {
    renderWithIntl(<BusinessFinder names={['Blue Cafe', 'Zed Gym']} loadFailed={false} labels={labels} />);
    const select = screen.getByLabelText('Registered businesses');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Choose a business…', 'Blue Cafe', 'Zed Gym']);
    expect(screen.queryByText('Join Blue Cafe')).not.toBeInTheDocument();
    await userEvent.selectOptions(select, 'Blue Cafe');
    expect(screen.getByText('Join Blue Cafe')).toBeInTheDocument();
    expect(screen.getByText('Scan the QR code at Blue Cafe')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create or open my customer account' })).toHaveAttribute('href', '/loyalty/login');
    await userEvent.selectOptions(select, '');
    expect(screen.queryByText('Join Blue Cafe')).not.toBeInTheDocument();
  });

  it('renders a business name as text only, never as markup', async () => {
    renderWithIntl(<BusinessFinder names={['<img src=x onerror=alert(1)> Shop']} loadFailed={false} labels={labels} />);
    await userEvent.selectOptions(screen.getByLabelText('Registered businesses'), '<img src=x onerror=alert(1)> Shop');
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('Join <img src=x onerror=alert(1)> Shop')).toBeInTheDocument();
  });

  it('shows the empty and the load-failure states instead of an empty dropdown', () => {
    const { unmount } = renderWithIntl(<BusinessFinder names={[]} loadFailed={false} labels={labels} />);
    expect(screen.getByText('No businesses yet')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    unmount();
    renderWithIntl(<BusinessFinder names={['A']} loadFailed labels={labels} />);
    expect(screen.getByText('Could not load the list')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });
});
