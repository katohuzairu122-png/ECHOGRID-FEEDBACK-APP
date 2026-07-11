import { redirect } from 'next/navigation';

/**
 * middleware.ts already guarantees anyone reaching this route has a
 * session (otherwise they'd have been redirected to /login before this
 * component ever ran) -- so this only has one job left.
 */
export default function RootPage() {
  redirect('/dashboard');
}
