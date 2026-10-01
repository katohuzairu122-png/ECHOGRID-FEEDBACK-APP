/**
 * Starts a new document request instead of a Next.js client transition.
 *
 * Use this immediately after a Server Action has written an httpOnly cookie:
 * the completed action response is committed first, and the next request is
 * guaranteed to be made by the browser with the updated cookie jar.
 */
export function navigateWithCommittedCookies(path: string): void {
  window.location.assign(path);
}
