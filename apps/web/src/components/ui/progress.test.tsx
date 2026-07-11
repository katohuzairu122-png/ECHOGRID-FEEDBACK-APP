import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Progress } from './progress';

describe('Progress', () => {
  it('exposes value via ARIA progressbar attributes for assistive tech', () => {
    render(<Progress value={40} label="40 pts to Gold" />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '40');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
  });

  it('renders the optional label text', () => {
    render(<Progress value={40} label="40 pts to Gold" />);
    expect(screen.getByText('40 pts to Gold')).toBeInTheDocument();
  });

  it('clamps a value above 100 down to 100 -- a caller computing progress past the last tier must not render an overflowing bar', () => {
    render(<Progress value={150} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });

  it('clamps a negative value up to 0', () => {
    render(<Progress value={-20} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });
});
