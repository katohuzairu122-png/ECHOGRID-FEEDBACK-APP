import { redirect } from 'next/navigation';
import { getActiveBusiness } from '@/lib/business';
import { apiFetch } from '@/lib/api-client';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { InviteForm } from './invite-form';
import { cancelInvitationAction, resendInvitationAction, revokeTeamAccessAction, updateTeamAccessAction } from '@/lib/actions/team';
import { TeamActionButton } from './team-action-button';

type TeamData = {
  members: Array<{ id: string; userId: string; userEmail: string; userFullName: string; roleId: string; roleName: string; branchId: string | null }>;
  invitations: Array<{ id: string; email: string; roleId: string; branchId: string | null; expiresAt: string; role: { name: string }; branch: { name: string } | null }>;
  roles: Array<{ id: string; name: string }>;
  branches: Array<{ id: string; name: string }>;
};

export default async function TeamSettingsPage() {
  const business = await getActiveBusiness(); if (!business) redirect('/dashboard');
  const data = await apiFetch<TeamData>('/team', { businessId: business.id });
  const branchName = (id: string | null) => id ? data.branches.find((b) => b.id === id)?.name ?? 'Selected branch' : 'All branches';
  return <div className="flex flex-col gap-6">
    <div><h1 className="text-2xl font-semibold text-neutral-900">Team management</h1><p className="text-sm text-neutral-500">Invite people and control their role and branch access for {business.name}.</p></div>
    <Card><CardHeader><CardTitle>Invite a team member</CardTitle><CardDescription>The invitation link expires after seven days. Pending invitations count toward your plan limit.</CardDescription></CardHeader><CardContent><InviteForm roles={data.roles} branches={data.branches} /></CardContent></Card>
    <Card><CardHeader><CardTitle>Team members</CardTitle><CardDescription>Each row is one access grant. A person can have more than one branch grant.</CardDescription></CardHeader><CardContent className="flex flex-col gap-4">{data.members.length === 0 ? <p className="text-sm text-neutral-500">No team members yet.</p> : data.members.map((member) => <div key={member.id} className="rounded-lg border border-neutral-200 p-4"><div className="mb-3"><p className="font-medium">{member.userFullName}</p><p className="text-sm text-neutral-500">{member.userEmail} · {member.roleName} · {branchName(member.branchId)}</p></div><div className="flex flex-wrap gap-2"><form action={updateTeamAccessAction.bind(null, member.id)} className="flex flex-wrap gap-2"><select name="roleId" defaultValue={member.roleId} className="h-9 rounded-md border border-neutral-300 bg-white px-2 text-sm">{data.roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select><select name="branchId" defaultValue={member.branchId ?? ''} className="h-9 rounded-md border border-neutral-300 bg-white px-2 text-sm"><option value="">All branches</option>{data.branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select><Button size="sm" variant="outline" type="submit">Save access</Button></form><TeamActionButton action={revokeTeamAccessAction.bind(null, member.id)} label="Revoke access" pendingLabel="Revoking…" /></div></div>)}</CardContent></Card>
    <Card><CardHeader><CardTitle>Pending invitations</CardTitle></CardHeader><CardContent className="flex flex-col gap-3">{data.invitations.length === 0 ? <p className="text-sm text-neutral-500">No pending invitations.</p> : data.invitations.map((invitation) => <div key={invitation.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 p-4"><div><p className="font-medium">{invitation.email}</p><p className="text-sm text-neutral-500">{invitation.role.name} · {invitation.branch?.name ?? 'All branches'} · expires {new Date(invitation.expiresAt).toLocaleDateString()}</p></div><div className="flex gap-2"><TeamActionButton action={resendInvitationAction.bind(null, invitation.id)} label="Resend" pendingLabel="Resending…" /><TeamActionButton action={cancelInvitationAction.bind(null, invitation.id)} label="Cancel" pendingLabel="Cancelling…" /></div></div>)}</CardContent></Card>
  </div>;
}
