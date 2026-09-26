/**
 * Product name (spec 22 D1). The one place server and SPA code spell it: the
 * server reads BRAND_NAME through parseBrandName at boot, and the SPA learns
 * the resolved value from GET /api/runtime-config (DEFAULT_BRAND_NAME until
 * that fetch resolves).
 */

export const DEFAULT_BRAND_NAME = "Wagon Payroll";

/** Upper bound on the display name, in characters. */
export const BRAND_NAME_MAX_LENGTH = 60;

/**
 * Characters a display name may not contain (spec 22 D1): C0 controls, DEL,
 * C1 controls (CR/LF in an email Subject: header would be header
 * injection), zero-width and directional marks U+200B–U+200F, line and
 * paragraph separators U+2028/U+2029, bidi embeddings and overrides
 * U+202A–U+202E, and bidi isolates U+2066–U+2069 (these can make a name
 * render as different text than it is).
 */
const FORBIDDEN_CHARACTER =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/;

/**
 * Validate an operator-set display name (BRAND_NAME, TOTP_ISSUER): trimmed;
 * unset or blank → undefined. Throws, naming `setting`, on a value over 60
 * characters or one containing a forbidden character, so boot fails the
 * same way it does for a missing secret.
 */
export function parseDisplayName(raw: string | undefined, setting: string): string | undefined {
  const name = (raw ?? "").trim();
  if (name === "") return undefined;
  if ([...name].length > BRAND_NAME_MAX_LENGTH) {
    throw new Error(`${setting} must be at most ${BRAND_NAME_MAX_LENGTH} characters`);
  }
  if (FORBIDDEN_CHARACTER.test(name)) {
    throw new Error(`${setting} must not contain control, zero-width, or bidi characters`);
  }
  return name;
}

/** Resolve the BRAND_NAME env value: parseDisplayName, unset or blank → the default. */
export function parseBrandName(raw: string | undefined): string {
  return parseDisplayName(raw, "BRAND_NAME") ?? DEFAULT_BRAND_NAME;
}
