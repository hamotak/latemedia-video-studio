/**
 * Username-based auth. Supabase Auth needs an email internally, so we map a
 * username to a deterministic internal email. Users log in (and admins create
 * accounts) with a username — no real email required.
 */

export const USERNAME_EMAIL_DOMAIN = "lat-media.local";

export function usernameToEmail(username: string): string {
  return `${username.trim().toLowerCase()}@${USERNAME_EMAIL_DOMAIN}`;
}

export function isSyntheticEmail(email: string | null | undefined): boolean {
  return !!email && email.toLowerCase().endsWith(`@${USERNAME_EMAIL_DOMAIN}`);
}

/** 2–32 chars: letters, numbers, dot, underscore, hyphen. */
export function isValidUsername(username: string): boolean {
  return /^[a-zA-Z0-9._-]{2,32}$/.test(username.trim());
}
