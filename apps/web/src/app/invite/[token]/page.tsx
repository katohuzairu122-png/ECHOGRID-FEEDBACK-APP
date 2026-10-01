import Link from 'next/link';
import { hasSession } from '@/lib/session';
import { buttonVariants, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { Logo } from '@/components/brand';
import { AcceptInvitationForm } from './accept-invitation-form';

export default async function InvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params; const signedIn = await hasSession();
  return <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-neutral-50 p-8"><Logo variant="full" iconSize={40} /><Card className="w-full max-w-md"><CardHeader><CardTitle>Join this Echo Grid team</CardTitle><CardDescription>Accept the invitation using the account with the same email address that received it.</CardDescription></CardHeader><CardContent>{signedIn ? <AcceptInvitationForm token={token} /> : <div className="flex flex-col gap-3"><Link className={buttonVariants()} href="/login">Log in to accept</Link><Link className={buttonVariants({ variant: 'outline' })} href="/signup">Create an account</Link></div>}</CardContent></Card></main>;
}
