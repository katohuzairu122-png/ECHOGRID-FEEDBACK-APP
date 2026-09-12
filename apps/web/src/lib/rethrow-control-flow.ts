/**
 * Re-throws Next.js's control-flow "errors" so a broad `catch` cannot
 * swallow them.
 *
 * `redirect()` and `notFound()` do not return -- they throw a sentinel the
 * framework recognises higher up the stack. That works until a catch block
 * treats every non-recognised error as a failure to report, which is exactly
 * the shape this codebase uses in its Server Actions:
 *
 *   } catch (err) {
 *     if (err instanceof ApiError) return { error: err.message };
 *     return { error: 'Something went wrong. Please try again.' };
 *   }
 *
 * A NEXT_REDIRECT sentinel is not an ApiError, so it fell to the second
 * line: the navigation was cancelled and the user got a generic error
 * message instead. Harmless while nothing inside those try blocks
 * redirected -- and a live bug the moment customerApiFetch started
 * redirecting on 401 (audit P1-2). Two actions needed this guard;
 * redeemRewardAction and sendCustomerMessageAction both call
 * customerApiFetch inside a try with that exact catch.
 *
 * WHY THE DIGEST PREFIX AND NOT A FRAMEWORK IMPORT
 * Next's own `isRedirectError` lives under next/dist/client/components/, an
 * internal path with no stability guarantee, and `unstable_rethrow` is
 * named for its own instability. The digest string, by contrast, is
 * observable framework behaviour that has carried the same prefixes across
 * versions. If a future Next release changes them, the failure mode is the
 * one that already exists today -- a swallowed redirect -- not a crash, and
 * the test below is what would catch it on upgrade.
 *
 * Deliberately returns void rather than a boolean: a caller that has to
 * remember to act on the return value is the same trap one level up. This
 * either throws or does nothing, so `rethrowControlFlow(err);` as the first
 * line of a catch is the whole usage.
 */

const CONTROL_FLOW_DIGESTS = ['NEXT_REDIRECT', 'NEXT_NOT_FOUND', 'NEXT_HTTP_ERROR_FALLBACK'];

export function rethrowControlFlow(err: unknown): void {
  const digest = (err as { digest?: unknown } | null | undefined)?.digest;
  if (typeof digest !== 'string') return;

  // `startsWith`, not equality: a redirect's digest carries its target and
  // status appended after the prefix (e.g. NEXT_REDIRECT;replace;/x;307).
  if (CONTROL_FLOW_DIGESTS.some((prefix) => digest.startsWith(prefix))) {
    throw err;
  }
}
