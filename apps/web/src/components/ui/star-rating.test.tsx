import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StarRating } from './star-rating';

describe('StarRating', () => {
  it('renders 5 radio options with "N star(s)" accessible names', () => {
    render(<StarRating name="rating" />);
    expect(screen.getByRole('radio', { name: '1 star' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '5 stars' })).toBeInTheDocument();
  });

  it('selects a star on click', async () => {
    const user = userEvent.setup();
    render(<StarRating name="rating" />);

    await user.click(screen.getByRole('radio', { name: '3 stars' }));

    expect(screen.getByRole('radio', { name: '3 stars' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '5 stars' })).not.toBeChecked();
  });

  it('marks only the first radio required -- the browser enforces the whole group off one attribute', () => {
    render(<StarRating name="rating" required />);

    expect(screen.getByRole('radio', { name: '1 star' })).toBeRequired();
    expect(screen.getByRole('radio', { name: '2 stars' })).not.toBeRequired();
  });

  it('submits the selected value under the given field name via native FormData', async () => {
    const user = userEvent.setup();
    render(
      <form data-testid="form">
        <StarRating name="rating" />
      </form>,
    );

    await user.click(screen.getByRole('radio', { name: '4 stars' }));

    const form = screen.getByTestId('form') as HTMLFormElement;
    expect(new FormData(form).get('rating')).toBe('4');
  });
});
