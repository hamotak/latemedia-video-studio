const KEY = "bilal-demo-settings-return-to:v1";

function safePath(path: string | null | undefined) {
  const value = path?.trim();
  if (!value?.startsWith("/")) return "/admin";
  if (value.startsWith("/login") || value.startsWith("/admin/settings")) return "/admin";
  return value;
}

export function rememberSettingsReturn(path: string | null | undefined) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, safePath(path));
}

export function getSettingsReturn() {
  if (typeof window === "undefined") return "/admin";
  return safePath(window.localStorage.getItem(KEY));
}

export function currentSettingsReturnPath() {
  if (typeof window === "undefined") return "/admin";
  return safePath(`${window.location.pathname}${window.location.search}`);
}
