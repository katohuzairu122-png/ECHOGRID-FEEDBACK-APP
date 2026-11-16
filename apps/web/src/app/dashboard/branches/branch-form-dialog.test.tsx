import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl } from '@/test-utils';
import type { BranchDto } from '@echo-grid-feedback/shared-types';
import { BranchFormDialog } from './branch-form-dialog';
import { createBranchAction, updateBranchAction } from '@/lib/actions/branches';
const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));


// Server Actions can't actually run against a server inside a jsdom unit
// test -- mocked at the module boundary so BranchFormDialog's OWN logic
// (create-vs-edit mode, pre-fill, error/success handling) is what's under
// test, not the network. Real end-to-end behavior (a genuine POST/PATCH
// through the BFF) is covered instead by e2e/branch-management.spec.ts.
vi.mock('@/lib/actions/branches', () => ({
  createBranchAction: vi.fn(),
  updateBranchAction: vi.fn(),
}));

const sampleBranch: BranchDto = {
  id: 'branch-1',
  businessId: 'business-1',
  name: 'Downtown',
  slug: 'downtown',
  addressLine1: '123 Main St',
  addressLine2: null,
  city: 'Austin',
  stateProvince: 'TX',
  postalCode: '78701',
  countryCode: 'US',
  timezone: 'America/Chicago',
  latitude: null,
  longitude: null,
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('BranchFormDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('create mode: opens with empty fields and calls createBranchAction, not updateBranchAction', async () => {
    const user = userEvent.setup();
    vi.mocked(createBranchAction).mockResolvedValue({ success: true });

    renderWithIntl(<BranchFormDialog trigger={<button>+ New branch</button>} />);
    await user.click(screen.getByRole('button', { name: '+ New branch' }));

    expect(screen.getByLabelText('Name')).toHaveValue('');
    await user.type(screen.getByLabelText('Name'), 'New Branch');
    // ONBOARDING-UX-01: nobody types a technical URL name; the server generates it.
    expect(screen.queryByLabelText('URL slug')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create branch' }));

    await waitFor(() => expect(createBranchAction).toHaveBeenCalled());
    const submitted = vi.mocked(createBranchAction).mock.calls[0]![1] as FormData;
    expect(submitted.get('name')).toBe('New Branch');
    expect(submitted.has('slug')).toBe(false);
    expect(updateBranchAction).not.toHaveBeenCalled();
  });

  it('edit mode: pre-fills every field from the branch prop', async () => {
    const user = userEvent.setup();

    renderWithIntl(<BranchFormDialog branch={sampleBranch} trigger={<button>Edit</button>} />);
    await user.click(screen.getByRole('button', { name: 'Edit' }));

    expect(screen.getByLabelText('Name')).toHaveValue('Downtown');
    // The established URL name is shown as fixed text, never as an editable field (it is never silently renamed).
    expect(screen.queryByLabelText('URL slug')).not.toBeInTheDocument();
    expect(screen.getByText('/downtown')).toBeInTheDocument();
    expect(screen.getByLabelText('City')).toHaveValue('Austin');
    expect(screen.getByLabelText('State/Province')).toHaveValue('TX');
    expect(screen.getByLabelText('Country code')).toHaveValue('US');
    expect(screen.getByLabelText('Timezone')).toHaveValue('America/Chicago');
  });

  it('edit mode: submitting calls updateBranchAction, not createBranchAction', async () => {
    const user = userEvent.setup();
    vi.mocked(updateBranchAction).mockResolvedValue({ success: true });

    renderWithIntl(<BranchFormDialog branch={sampleBranch} trigger={<button>Edit</button>} />);
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateBranchAction).toHaveBeenCalled());
    expect(createBranchAction).not.toHaveBeenCalled();
  });

  it('shows the error message returned by the action instead of closing', async () => {
    const user = userEvent.setup();
    vi.mocked(createBranchAction).mockResolvedValue({
      error: 'That web address is already used by another location. Please try a slightly different name.',
    });

    renderWithIntl(<BranchFormDialog trigger={<button>+ New branch</button>} />);
    await user.click(screen.getByRole('button', { name: '+ New branch' }));
    await user.type(screen.getByLabelText('Name'), 'New Branch');
    await user.click(screen.getByRole('button', { name: 'Create branch' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('already used by another location');
    // The form (and its typed values) must still be visible -- an error
    // should never silently close the dialog and lose the user's input.
    expect(screen.getByLabelText('Name')).toHaveValue('New Branch');
  });
});
