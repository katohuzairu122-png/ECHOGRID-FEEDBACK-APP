import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '@/test-utils';
import { PartnerTermsView } from './partner-terms-view';

const data = {
  policyVersion: 'PC-ECON/1',
  terms: 'Echo Grid Partner Program PC-ECON/1: Partner Credits are noncash.',
  termsDigest: 'a'.repeat(64),
};

describe('PartnerTermsView (read-only)', () => {
  it('shows the version, the terms text and the digest exactly as served', () => {
    renderWithIntl(<PartnerTermsView result={{ status: 'ready', data }} />);
    expect(screen.getByTestId('policy-version')).toHaveTextContent('PC-ECON/1');
    expect(screen.getByTestId('terms-text')).toHaveTextContent(data.terms);
    expect(screen.getByTestId('terms-digest')).toHaveTextContent(data.termsDigest);
  });

  it('exposes no accept or enroll control, and says enrollment status is not shown', () => {
    renderWithIntl(<PartnerTermsView result={{ status: 'ready', data }} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByText(/Enrollment status is not shown here yet/)).toBeInTheDocument();
  });

  it('a forbidden read is an explicit denial with no retry and no terms', () => {
    renderWithIntl(<PartnerTermsView result={{ status: 'forbidden' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('business-wide billing management access');
    expect(screen.queryByTestId('terms-text')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('an outage is never shown as empty terms and offers a retry', () => {
    renderWithIntl(<PartnerTermsView result={{ status: 'unavailable' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('could not be loaded');
    expect(screen.queryByTestId('terms-text')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Try again' })).toHaveAttribute('href', '/dashboard/billing/partner-terms');
  });
});
