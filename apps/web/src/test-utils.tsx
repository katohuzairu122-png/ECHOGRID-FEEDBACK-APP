import type { ReactElement } from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en/common.json';
import enDashboard from '../messages/en/dashboard.json';
import enAuth from '../messages/en/auth.json';
import enBranches from '../messages/en/branches.json';
import enFeedback from '../messages/en/feedback.json';
import enLoyalty from '../messages/en/loyalty.json';
import enAnalytics from '../messages/en/analytics.json';
import enNotifications from '../messages/en/notifications.json';
import enPlatform from '../messages/en/platform.json';
import enMessaging from '../messages/en/messaging.json';

/**
 * Test-only message bundle (i18n & Multi-Currency Block 4) -- English
 * fixtures for every namespace that currently exists. Vitest/RTL only ever
 * exercises Client Components (see vitest.config.ts's comment: async
 * Server Components aren't renderable this way at all, that's
 * playwright's job), and every Client Component using next-intl's
 * useTranslations() throws without a NextIntlClientProvider ancestor --
 * this is that ancestor for tests. Add the new namespace's real en/*.json
 * here as Blocks 5-7 translate each module (an import error surfaces
 * immediately if a namespace is missing, so this is impossible to
 * silently forget).
 */
const messages = {
  common: en,
  dashboard: enDashboard,
  auth: enAuth,
  branches: enBranches,
  feedback: enFeedback,
  loyalty: enLoyalty,
  analytics: enAnalytics,
  notifications: enNotifications,
  platform: enPlatform,
  messaging: enMessaging,
};

/**
 * Drop-in replacement for @testing-library/react's render() -- wraps the
 * component under test in the same NextIntlClientProvider the real app
 * provides via app/layout.tsx, so useTranslations()/useFormatter() work
 * exactly as they do at runtime instead of throwing "no context found."
 * Existing tests that don't touch translated components can keep using
 * plain render() from @testing-library/react; only components that call a
 * next-intl hook (directly or via a child) need this.
 *
 * The returned `rerender` re-wraps whatever element it's given in the same
 * provider rather than returning RTL's raw one -- RTL's real rerender()
 * replaces the ENTIRE previous tree (provider included), so a test calling
 * `rerender(<SomeTranslatedComponent />)` with the unwrapped raw rerender
 * would drop the provider and throw on next render. This keeps callers
 * free to treat rerender exactly like RTL's normal one (pass the bare
 * component, nothing more).
 */
export function renderWithIntl(ui: ReactElement, options?: RenderOptions) {
  const wrap = (element: ReactElement) => (
    <NextIntlClientProvider locale="en" messages={messages}>
      {element}
    </NextIntlClientProvider>
  );

  const result = render(wrap(ui), options);

  return {
    ...result,
    rerender: (nextUi: ReactElement) => result.rerender(wrap(nextUi)),
  };
}

export * from '@testing-library/react';
