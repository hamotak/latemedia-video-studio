/**
 * OAuth redirect-URI derivation for Google Drive — kept dependency-free (no DB,
 * no googleapis) so it can be unit-tested in isolation and reused by both OAuth
 * route legs without import cycles.
 *
 * The whole point: the redirect_uri must match the host:port the browser
 * actually used (Next.js may bind 3001/3002 when 3000 is busy), which is also
 * the exact URL the Settings page tells the user to register in Google Cloud.
 */

/** Path of the OAuth callback, appended to whatever origin the app is served from. */
export const GDRIVE_CALLBACK_PATH = "/api/gdrive/oauth/callback";

/** Last-resort origin when neither headers nor req.url yield a host. */
const FALLBACK_ORIGIN = "http://localhost:3000";

/**
 * The exact redirect_uri to use for the OAuth dance. Derived from the live
 * request origin. An explicit override wins when set, for deployments behind a
 * fixed public URL: APP_ORIGIN or NEXT_PUBLIC_APP_ORIGIN
 * (e.g. "https://hum.example.com").
 */
export function oauthRedirectUri(req: Request): string {
  const configured = (process.env.APP_ORIGIN || process.env.NEXT_PUBLIC_APP_ORIGIN || "").trim();
  const origin = configured ? configured.replace(/\/+$/, "") : originFromRequest(req);
  return `${origin}${GDRIVE_CALLBACK_PATH}`;
}

/** Best-effort origin (scheme + host:port) the browser used to reach us. */
export function originFromRequest(req: Request): string {
  let proto = "http";
  let host = "";
  try {
    const u = new URL(req.url);
    proto = u.protocol.replace(":", "");
    host = u.host;
  } catch {
    /* req.url may be relative in some runtimes — fall back to headers below */
  }
  // Proxies (and Next's dev server) carry the real browser-facing host here.
  host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? host;
  proto = req.headers.get("x-forwarded-proto") ?? proto;
  return host ? `${proto}://${host}` : FALLBACK_ORIGIN;
}
