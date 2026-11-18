/**
 * BDPN-01B part 1: search normalization of a display name (`BDPN_01B_VALIDATION_AND_MODERATION_DESIGN.md` section 4.2,
 * amendment A-1 of `BDPN_01C_DISCOVERY_API_DESIGN.md`). The stored value is frozen with the revision, so this function
 * is deterministic and idempotent: applying it twice gives the same value.
 *
 * Unicode NFKC, then case folding, then removal of combining marks, then collapse of whitespace runs to one space.
 * Accents are removed ("Café" and "cafe" match) and Arabic short-vowel marks are removed, but Arabic base letters
 * are NOT altered: a precomposed Arabic letter such as the hamza-on-alef is kept as is, so only Latin-style
 * decomposition is stripped.
 */
const ARABIC_SCRIPT = /\p{Script=Arabic}/u;
const MARK = /\p{M}/u;
const MARKS_GLOBAL = /\p{M}/gu;

function stripMarks(text: string): string {
  let out = '';
  for (const char of text) {
    if (ARABIC_SCRIPT.test(char) && !MARK.test(char)) {
      out += char;
    } else {
      out += char.normalize('NFD').replace(MARKS_GLOBAL, '');
    }
  }
  return out;
}

/** Full case folding for the cases NFKC and lower-casing leave behind. */
function foldCase(text: string): string {
  return text.toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ');
}

export function normalizeDisplayNameForSearch(displayName: string): string {
  return stripMarks(foldCase(displayName.normalize('NFKC'))).replace(/\s+/g, ' ').trim();
}
