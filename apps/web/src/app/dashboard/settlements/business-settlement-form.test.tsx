import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BusinessSettlementForm } from './business-settlement-form';

vi.mock('@/lib/actions/settlements', () => ({ businessSettlementAction: vi.fn() }));

describe('BusinessSettlementForm layout', () => {
  it('keeps every field and operation, with each label stacked above its own control', () => {
    render(<BusinessSettlementForm contexts={[{ branchId: null, branchName: null }]} />);
    for (const name of [
      'Customer-provided settlement reference',
      'Customer-provided access authorization reference',
    ]) {
      const input = screen.getByLabelText(name);
      // The label and its control share one stacked group; the list button is not in that group.
      expect(input.parentElement?.querySelector('button')).toBeNull();
    }
    expect(
      screen.getByRole('button', { name: 'Load authorized settlement queue' }),
    ).toHaveAttribute('value', 'list');
    expect(
      screen.getByRole('button', { name: 'Inspect consented reward information' }),
    ).toHaveAttribute('value', 'inspect');
    expect(screen.getByLabelText('Authorized business or branch')).toHaveAttribute(
      'name',
      'branchId',
    );
  });
});
