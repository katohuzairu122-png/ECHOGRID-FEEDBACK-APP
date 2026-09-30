'use client';

import { useActionState } from 'react';
import { inviteTeamMemberAction, type TeamActionState } from '@/lib/actions/team';
import { Button, Input, Label } from '@/components/ui';

type Option = { id: string; name: string };
export function InviteForm({ roles, branches }: { roles: Option[]; branches: Option[] }) {
  const [state, action, pending] = useActionState<TeamActionState, FormData>(inviteTeamMemberAction, {});
  return <form action={action} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
    <div className="flex flex-col gap-1.5"><Label htmlFor="invite-email">Email</Label><Input id="invite-email" name="email" type="email" required /></div>
    <div className="flex flex-col gap-1.5"><Label htmlFor="invite-role">Role</Label><select id="invite-role" name="roleId" required className="h-10 rounded-md border border-neutral-300 bg-white px-3 text-sm">{roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></div>
    <div className="flex flex-col gap-1.5"><Label htmlFor="invite-branch">Access</Label><select id="invite-branch" name="branchId" className="h-10 rounded-md border border-neutral-300 bg-white px-3 text-sm"><option value="">All branches</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></div>
    <div className="flex items-end"><Button type="submit" disabled={pending}>{pending ? 'Sending…' : 'Invite user'}</Button></div>
    {state.error && <p role="alert" className="text-sm text-danger sm:col-span-2 lg:col-span-4">{state.error}</p>}
    {state.success && <p className="text-sm text-success sm:col-span-2 lg:col-span-4">{state.success}</p>}
  </form>;
}
