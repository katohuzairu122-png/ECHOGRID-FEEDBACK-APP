/**
 * Pages that ask for the camera (the staff QR scanner). A document's Permissions-Policy is fixed when it loads, and
 * next.config.ts allows `camera=(self)` only on these routes, so a client-side (Next Link) transition INTO one of them
 * from any other page keeps that page's `camera=()` policy and the scanner reports "The camera could not be opened".
 * Every entry link from outside these routes must therefore be a full page load. Keep in step with next.config.ts
 * (pinned by next-config-headers.test.ts and camera-routes.test.ts).
 */
const CAMERA_EXACT = ['/dashboard/loyalty/scan'];
const CAMERA_PREFIX = '/cashier';

function pathOf(href: string): string {
  const end = href.search(/[?#]/);
  return end === -1 ? href : href.slice(0, end);
}

export function isCameraPath(href: string): boolean {
  const path = pathOf(href);
  return CAMERA_EXACT.includes(path) || path === CAMERA_PREFIX || path.startsWith(`${CAMERA_PREFIX}/`);
}
