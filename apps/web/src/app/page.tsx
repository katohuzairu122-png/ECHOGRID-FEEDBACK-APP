import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { hasSession } from '@/lib/session';
import { Logo, FeedbackIcon, InsightsIcon, ActionIcon, LoyaltyIcon } from '@/components/brand';
import { buttonVariants } from '@/components/ui';

const FEATURES = [
  { key: 'feedback', Icon: FeedbackIcon },
  { key: 'insights', Icon: InsightsIcon },
  { key: 'action', Icon: ActionIcon },
  { key: 'loyalty', Icon: LoyaltyIcon },
] as const;

const LEGAL_LINKS = [
  ['Support', '/support'],
  ['Privacy', '/privacy'],
  ['Terms', '/terms'],
  ['Refunds', '/refunds'],
  ['Cookies', '/cookies'],
] as const;

export default async function RootPage() {
  if (await hasSession()) redirect('/dashboard');
  const t = await getTranslations('landing');
  return (
    <main className="min-h-screen bg-white text-slate-950">
      <header className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-5">
        <Link href="/" aria-label="Echo Grid home"><Logo variant="full" iconSize={38} /></Link>
        <nav aria-label="Main navigation" className="flex flex-wrap items-center gap-5 text-sm font-medium">
          <a href="#features" className="hover:text-brand-600">Features</a>
          <a href="#how-it-works" className="hover:text-brand-600">How it works</a>
          <a href="#businesses" className="hover:text-brand-600">For businesses</a>
          <Link href="/loyalty/login" className="hover:text-brand-600">For customers</Link>
          <Link href="/login">{t('loginLink')}</Link>
          <Link href="/signup" className={buttonVariants({ size:'sm' })}>{t('signupCta')}</Link>
        </nav>
      </header>
      <section className="bg-slate-950 text-white">
        <div className="mx-auto grid max-w-7xl items-center gap-12 px-6 py-20 lg:grid-cols-2 lg:py-28">
          <div>
            <p className="mb-4 text-sm font-semibold uppercase tracking-widest text-emerald-300">Engagement · Feedback · Loyalty</p>
            <h1 className="text-4xl font-bold leading-tight tracking-tight md:text-6xl">
              Turn every visit into <span className="text-emerald-400">lasting value.</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg text-slate-300">Connect customers with feedback, business-specific loyalty and rewards through a single branch QR experience.</p>
            <div className="mt-8 flex flex-wrap gap-4">
              <Link href="/signup" className={buttonVariants({ size:'lg' })}>{t('signupCta')}</Link>
              <a href="#how-it-works" className="rounded-md border border-slate-400 px-6 py-3 font-medium">How it works</a>
            </div>
          </div>
          <div aria-label="Echo Grid platform overview" className="rounded-3xl border border-emerald-800 bg-slate-900 p-8 shadow-2xl">
            <div className="mb-7 flex items-center justify-between"><Logo variant="full" iconSize={30} /><span className="text-xs text-emerald-300">One connected experience</span></div>
            <div className="grid gap-4 sm:grid-cols-2">
              {FEATURES.map(({key,Icon})=><div key={key} className="rounded-xl bg-slate-800 p-5"><Icon className="mb-3 h-8 w-8 text-emerald-400"/><p className="font-semibold">{t(`features.${key}.title`)}</p><p className="mt-2 text-sm text-slate-300">{t(`features.${key}.description`)}</p></div>)}
            </div>
          </div>
        </div>
      </section>
      <section id="features" className="mx-auto max-w-7xl px-6 py-20">
        <h2 className="text-center text-3xl font-bold">Everything you need in one platform</h2>
        <div className="mt-10 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map(({key,Icon})=><div key={key} className="rounded-2xl border border-slate-200 p-6"><Icon className="mb-4 h-9 w-9 text-brand-600"/><h3 className="font-semibold">{t(`features.${key}.title`)}</h3><p className="mt-3 text-sm text-slate-600">{t(`features.${key}.description`)}</p></div>)}
        </div>
      </section>
      <section id="how-it-works" className="bg-slate-50 px-6 py-20">
        <div className="mx-auto max-w-7xl"><h2 className="text-center text-3xl font-bold">How Echo Grid works</h2><div className="mt-10 grid gap-5 md:grid-cols-3">
          {[['1','Set up your business','Create your business, branches and engagement settings.'],['2','Share your branch QR','Let customers choose feedback or eligible loyalty actions.'],['3','Learn and grow','Review feedback and engagement insights in your dashboard.']].map(([n,title,detail])=><div key={n} className="rounded-xl bg-white p-6 shadow-sm"><span className="text-lg font-bold text-brand-600">{n}</span><h3 className="mt-4 font-semibold">{title}</h3><p className="mt-2 text-sm text-slate-600">{detail}</p></div>)}
        </div></div>
      </section>
      <section id="businesses" className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-6 px-6 py-20"><div><h2 className="text-3xl font-bold">Build stronger customer relationships</h2><p className="mt-3 text-slate-600">Manage engagement across your business and branches.</p></div><Link href="/signup" className={buttonVariants({size:'lg'})}>{t('signupCta')}</Link></section>
      <footer className="border-t px-6 py-8"><nav aria-label="Support and legal" className="mx-auto flex max-w-7xl flex-wrap gap-5 text-sm text-slate-600">{LEGAL_LINKS.map(([label,href])=><Link key={href} href={href}>{label}</Link>)}</nav></footer>
    </main>
  );
}
