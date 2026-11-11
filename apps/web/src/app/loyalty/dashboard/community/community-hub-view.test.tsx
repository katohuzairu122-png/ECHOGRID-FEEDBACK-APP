import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithIntl } from '@/test-utils';
import type {
  CommunityHubData,
  CommunityMembershipDto,
  CommunityPointAccountDto,
  CommunityTransactionDto,
} from '@/lib/community-hub-types';
import { CommunityHubView } from './community-hub-view';

const membership = (over: Partial<CommunityMembershipDto> = {}): CommunityMembershipDto => ({
  id: 'm1',
  customerId: 'c1',
  status: 'active',
  policyVersion: 'v1',
  joinedAt: '2026-10-01T10:00:00.000Z',
  leftAt: null,
  suspendedAt: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  ...over,
});
const account = (over: Partial<CommunityPointAccountDto> = {}): CommunityPointAccountDto => ({
  id: 'a1',
  status: 'active',
  pointsBalance: 1240,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-02T10:00:00.000Z',
  ...over,
});
const tx = (over: Partial<CommunityTransactionDto> = {}): CommunityTransactionDto => ({
  id: 't1',
  type: 'earn',
  points: 50,
  sourceType: 'survey_completion',
  businessId: 'b1',
  branchId: null,
  reversalOf: null,
  createdAt: '2026-11-01T09:00:00.000Z',
  ...over,
});

function data(over: Partial<CommunityHubData> = {}): CommunityHubData {
  return {
    membership: { status: 'ready', data: { membership: membership(), account: account() } },
    points: { status: 'ready', data: { account: account() } },
    transactions: {
      status: 'ready',
      data: { items: [tx()], limit: 20, offset: 0, hasMore: false },
    },
    businessNames: { b1: 'The Daily Grind' },
    ...over,
  };
}

describe('CommunityHubView', () => {
  it('shows an active member with the real balance, real activity and the business name', () => {
    renderWithIntl(<CommunityHubView data={data()} />);
    expect(screen.getByTestId('membership-status')).toHaveTextContent('Active member');
    expect(screen.getByTestId('community-balance')).toHaveTextContent('1,240');
    expect(screen.getByText('Member since', { exact: false })).toBeInTheDocument();
    const row = screen.getByText('Survey completion').closest('li')!;
    expect(within(row).getByText('Earned')).toBeInTheDocument();
    expect(within(row).getByText('+50')).toBeInTheDocument();
    expect(within(row).getByText(/At The Daily Grind/)).toBeInTheDocument();
    expect(row.querySelector('time')).toHaveAttribute('datetime', '2026-11-01T09:00:00.000Z');
  });

  it('shows a legitimate zero balance as 0, not as missing or unavailable', () => {
    renderWithIntl(
      <CommunityHubView
        data={data({
          points: { status: 'ready', data: { account: account({ pointsBalance: 0 }) } },
          transactions: {
            status: 'ready',
            data: { items: [], limit: 20, offset: 0, hasMore: false },
          },
        })}
      />,
    );
    expect(screen.getByTestId('community-balance')).toHaveTextContent('0');
    expect(screen.getByText('No Community Points activity yet.')).toBeInTheDocument();
    expect(screen.queryByText(/could not be loaded/i)).not.toBeInTheDocument();
  });

  it('never presents an absent membership as an active member with zero points', () => {
    renderWithIntl(
      <CommunityHubView
        data={data({
          membership: { status: 'ready', data: { membership: null, account: null } },
          points: { status: 'ready', data: { account: null } },
          transactions: {
            status: 'ready',
            data: { items: [], limit: 20, offset: 0, hasMore: false },
          },
        })}
      />,
    );
    expect(screen.getByTestId('membership-status')).toHaveTextContent('Not a member');
    expect(screen.queryByText('Active member')).not.toBeInTheDocument();
    expect(screen.queryByTestId('community-balance')).not.toBeInTheDocument();
    expect(screen.getByText(/No Community Points account has been recorded/)).toBeInTheDocument();
    expect(screen.getByText(/Joining and leaving are not available/)).toBeInTheDocument();
  });

  it('shows the left state with its recorded date', () => {
    renderWithIntl(
      <CommunityHubView
        data={data({
          membership: {
            status: 'ready',
            data: {
              membership: membership({ status: 'left', leftAt: '2026-10-20T10:00:00.000Z' }),
              account: account(),
            },
          },
        })}
      />,
    );
    expect(screen.getByTestId('membership-status')).toHaveTextContent('Left the Community');
    expect(screen.getByText(/Left on/)).toBeInTheDocument();
  });

  it('shows suspended membership and a suspended points account without hiding the recorded balance', () => {
    renderWithIntl(
      <CommunityHubView
        data={data({
          membership: {
            status: 'ready',
            data: {
              membership: membership({
                status: 'suspended',
                suspendedAt: '2026-10-25T10:00:00.000Z',
              }),
              account: account({ status: 'suspended' }),
            },
          },
          points: { status: 'ready', data: { account: account({ status: 'suspended' }) } },
        })}
      />,
    );
    expect(screen.getByTestId('membership-status')).toHaveTextContent('Membership suspended');
    expect(screen.getByText(/Suspended on/)).toBeInTheDocument();
    expect(screen.getByText('Points account: Suspended')).toBeInTheDocument();
    expect(screen.getByTestId('community-balance')).toHaveTextContent('1,240');
  });

  it('reports unavailable and forbidden sections explicitly instead of zero or empty values', () => {
    renderWithIntl(
      <CommunityHubView
        data={data({
          membership: { status: 'forbidden' },
          points: { status: 'unavailable' },
          transactions: { status: 'unavailable' },
        })}
      />,
    );
    expect(
      screen.getByText('Your membership status is not available with your current access.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Your balance could not be loaded right now.')).toBeInTheDocument();
    expect(screen.getByText('Your activity could not be loaded right now.')).toBeInTheDocument();
    expect(screen.queryByTestId('community-balance')).not.toBeInTheDocument();
    expect(screen.queryByText('No Community Points activity yet.')).not.toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Try again' })[0]).toHaveAttribute(
      'href',
      '/loyalty/dashboard/community',
    );
  });

  it('pages the ledger with the API offset and omits the business line when a name did not resolve', () => {
    renderWithIntl(
      <CommunityHubView
        data={data({
          transactions: {
            status: 'ready',
            data: {
              items: [
                tx({
                  businessId: 'unknown',
                  type: 'reverse',
                  points: -50,
                  reversalOf: 't0',
                  sourceType: 'reversal',
                }),
              ],
              limit: 20,
              offset: 40,
              hasMore: true,
            },
          },
        })}
      />,
    );
    expect(screen.getByRole('link', { name: /Newer/ })).toHaveAttribute(
      'href',
      '/loyalty/dashboard/community?offset=20',
    );
    expect(screen.getByRole('link', { name: /Older/ })).toHaveAttribute(
      'href',
      '/loyalty/dashboard/community?offset=60',
    );
    expect(screen.queryByText(/At /)).not.toBeInTheDocument();
    expect(screen.getByText('Reverses an earlier entry', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('-50')).toBeInTheDocument();
  });

  it('is read-only: no join, leave, redeem or adjust controls and no surveys destination', () => {
    renderWithIntl(<CommunityHubView data={data()} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /join|leave|redeem|adjust|survey/i }),
    ).not.toBeInTheDocument();
  });
});
