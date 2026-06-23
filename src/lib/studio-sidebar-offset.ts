export const STUDIO_SIDEBAR_TOGGLE_EVENT = "lat-media-ideation-sidebar-toggle";

export function getStudioSidebarOffset() {
  if (typeof window === "undefined") return 0;

  const viewportWidth = window.innerWidth;
  if (viewportWidth < 640) return 0;

  const rawPreference = window.localStorage.getItem("sidebar-collapsed");
  const viewportNarrow = viewportWidth < 1024;
  const collapsed =
    rawPreference === "true" || (rawPreference !== "false" && viewportNarrow);

  return collapsed ? 64 : 240;
}
