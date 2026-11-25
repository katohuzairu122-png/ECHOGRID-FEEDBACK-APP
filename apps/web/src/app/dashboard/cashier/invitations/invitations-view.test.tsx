import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '@/test-utils';

const m = vi.hoisted(() => ({ create: vi.fn(), revoke: vi.fn() }));
vi.mock('@/lib/actions/customer-invitations', () => ({ createInvitationAction: m.create, revokeInvitationAction: m.revoke }));
vi.mock('react-qr-code', () => ({ default: (p: { value: string }) => <svg data-testid="qr" data-value={p.value} /> }));

import { InvitationsView } from './invitations-view';
import type { InvitationListDto } from '@/lib/customer-invitations-types';

const list = (over: Partial<InvitationListDto> = {}): InvitationListDto => ({
  invitations: [
    { id: 'i1', branchId: 'b1', branchName: 'Main', status: 'active', createdAt: '2026-11-25T10:00:00Z', expiresAt: '2026-11-26T10:00:00Z', revokedAt: null, acceptedAt: null },
    { id: 'i2', branchId: 'b1', branchName: 'Main', status: 'accepted', createdAt: '2026-11-24T10:00:00Z', expiresAt: '2026-11-25T10:00:00Z', revokedAt: null, acceptedAt: '2026-11-24T12:00:00Z' },
  ],
  counts: { active: 1, accepted: 1, revoked: 0, expired: 0 }, ...over,
});
const branches = [{ id: 'b1', name: 'Main' }, { id: 'b2', name: 'Harbour' }];
beforeEach(() => { m.create.mockReset(); m.revoke.mockReset(); });

describe('owner customer invitations view', () => {
  it('lists invitations with status and counts, revoke only on active ones, and shows no customer identity', () => {
    renderWithIntl(<InvitationsView list={list()} branches={branches} />);
    expect(screen.getByTestId('invitation-counts')).toHaveTextContent('Active: 1');
    expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(1);
    expect(screen.getByText(/does not enrol anyone/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/@|\+\d{6,}/);
  });
  it('creating shows the link and QR once, with copy, and the one-use note', async () => {
    m.create.mockResolvedValue({ status: 'created', inviteUrl: 'https://x.test/loyalty/invite/tok', expiresAt: '2026-11-26T10:00:00Z' });
    renderWithIntl(<InvitationsView list={list({ invitations: [], counts: { active: 0, accepted: 0, revoked: 0, expired: 0 } })} branches={branches} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
    await waitFor(() => expect(screen.getByTestId('invitation-created')).toBeInTheDocument());
    expect(screen.getByTestId('qr')).toHaveAttribute('data-value', 'https://x.test/loyalty/invite/tok');
    expect(screen.getByLabelText('Invitation link')).toHaveValue('https://x.test/loyalty/invite/tok');
    expect(screen.getByText(/shown once/)).toBeInTheDocument();
  });
  it('reports a refusal in plain language, never raw server text', async () => {
    m.create.mockResolvedValue({ status: 'failed', error: 'RATE_LIMITED' });
    renderWithIntl(<InvitationsView list={list()} branches={branches} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
    await waitFor(() => expect(screen.getByText('Too many invitations. Please wait a moment.')).toBeInTheDocument());
  });
  it('with no branch it asks for one first', () => {
    renderWithIntl(<InvitationsView list={list()} branches={[]} />);
    expect(screen.getByText(/Add a branch first/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create invitation' })).not.toBeInTheDocument();
  });
});
