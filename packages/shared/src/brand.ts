/**
 * Product name (spec 22 D1). The one place server and SPA code spell it: the
 * server reads BRAND_NAME through parseBrandName at boot, and the SPA learns
 * the resolved value from GET /api/runtime-config (DEFAULT_BRAND_NAME until
 * that fetch resolves).
 */

export const DEFAULT_BRAND_NAME = "Wagon Payroll";

/** Upper bound on the display name, in characters. */
export const BRAND_NAME_MAX_LENGTH = 60;

/** C0 controls and DEL. CR/LF in an email Subject: header would be header injection. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * Resolve the BRAND_NAME env value: trimmed; unset or blank → the default.
 * Throws on a value over 60 characters or one containing a control
 * character, so boot fails the same way it does for a missing secret.
 */
export function parseBrandName(raw: string | undefined): string {
  const name = (raw ?? "").trim();
  if (name === "") return DEFAULT_BRAND_NAME;
  if ([...name].length > BRAND_NAME_MAX_LENGTH) {
    throw new Error(`BRAND_NAME must be at most ${BRAND_NAME_MAX_LENGTH} characters`);
  }
  if (CONTROL_CHARACTER.test(name)) {
    throw new Error("BRAND_NAME must not contain control characters");
  }
  return name;
}
