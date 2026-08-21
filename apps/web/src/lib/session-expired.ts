/**
 * PAY-6: single registration point for "session expired" handling.
 *
 * Both API clients (the typed wrapper in lib/api.ts and the Better Auth
 * client in lib/auth-client.ts) call notifySessionExpired() on an
 * unexpected 401. main.ts registers the handler — it clears the stale
 * session and redirects straight to /login, so an expired session never
 * surfaces as a pile of error toasts.
 */

let handler: (() => void) | null = null;

export function setSessionExpiredHandler(h: () => void): void {
  handler = h;
}

export function notifySessionExpired(): void {
  handler?.();
}
