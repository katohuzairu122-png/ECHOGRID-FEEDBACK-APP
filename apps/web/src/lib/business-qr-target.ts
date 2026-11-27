/**
 * In-app business QR scanning (customer account). A printed business QR is a link ending in `/feedback/<token>` (or
 * `/loyalty/<token>`), where `<token>` is a signed three-part token. The scanner reports whatever text the code holds; this
 * module turns it into the SAME-SITE path the printed code would have opened, or null when the text is not a business QR.
 *
 * Only the token is taken from the scanned text: the destination is always rebuilt as a relative path on this site, so a
 * scanned code can never send the customer to another site. The token is verified by the API when the page opens; this
 * check only shapes the text and bounds its length.
 */
const TOKEN = /^[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,2048}$/;
const PATH = /^\/(?:feedback|loyalty)\/([^/?#]+)\/?$/;

export function businessQrTarget(scanned: string): string | null {
  const text = scanned.trim();
  if (!text || text.length > 6000) return null;
  let candidate = text;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) || text.startsWith('/')) {
    let pathname: string;
    try {
      pathname = new URL(text, 'https://placeholder.invalid').pathname;
    } catch {
      return null;
    }
    const match = PATH.exec(pathname);
    if (!match?.[1]) return null;
    try {
      candidate = decodeURIComponent(match[1]);
    } catch {
      return null;
    }
  }
  return TOKEN.test(candidate) ? `/feedback/${encodeURIComponent(candidate)}` : null;
}
