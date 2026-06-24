"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Sparkles,
  Image,
  LayoutDashboard,
  KanbanSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Shield,
  Tv2,
  Clapperboard,
  Film,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { useActiveChannel, type ChannelFeatures } from "@/lib/active-channel-context";
import { STUDIO_SIDEBAR_TOGGLE_EVENT } from "@/lib/studio-sidebar-offset";
import { currentSettingsReturnPath, rememberSettingsReturn } from "@/lib/settings-return";

const SIDEBAR_PREF_KEY = "sidebar-collapsed";

type NavItem = {
  href: string;
  label: string;
  icon: typeof Shield;
  badge?: number;
  exact?: boolean;
};

type NavSection = {
  label?: string;
  separatorAbove?: boolean;
  items: NavItem[];
};

/* ─── Admin navigation (shown only to admins, replacing everything else) ───
 * Channel Info is admin-only; Competitors live inside it. hrefs stay on the
 * current routes until the IA rename flips them (with redirects). */
const ADMIN_SECTIONS: NavSection[] = [
  {
    items: [
      { href: "/studio/video", label: "Video", icon: Clapperboard },
      { href: "/admin/channels",       label: "Channels", icon: Tv2      },
      { href: "/admin/settings/video", label: "Settings", icon: Settings },
    ],
  },
];

/* ─── Regular user (employee) navigation ─── */
function buildUserSections(features: ChannelFeatures): NavSection[] {
  // Per-employee access is controlled entirely by the channel feature grant
  // (Channel Info → Access). A granted feature ⇒ the tool is visible and usable.
  const allow = (key: string) => !!features[key];

  const createItems: NavItem[] = [
    ...(allow("ideate") ? [{ href: "/ideate", label: "Ideas", icon: Sparkles }] : []),
    ...(allow("image") ? [{ href: "/image-studio", label: "Images", icon: Image }] : []),
  ];
  const produceItems: NavItem[] = [
    ...(allow("board") ? [{ href: "/boards", label: "Board", icon: KanbanSquare }] : []),
    ...(allow("video")
      ? [
          { href: "/studio/video", label: "Video", icon: Clapperboard, exact: true },
          { href: "/studio/video/clips", label: "B-Rolls", icon: Film },
        ]
      : []),
  ];

  const sections: NavSection[] = [];
  if (createItems.length) sections.push({ label: "CREATE", items: createItems });
  if (produceItems.length) {
    sections.push({ label: "PRODUCE", separatorAbove: sections.length > 0, items: produceItems });
  }
  return sections;
}

type SidebarUser = { name: string; sub: string; isAdmin: boolean } | null;

function userInitials(name: string) {
  const parts = name.split(/[\s._-]+/).filter(Boolean);
  return parts.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("") || "?";
}

export function Sidebar() {
  const pathname = usePathname();

  const [hydrated,     setHydrated]     = useState(false);
  const [userPref,     setUserPref]     = useState<boolean | null>(null);
  const [viewportNarrow, setViewportNarrow] = useState(false);
  const [overlayMode,  setOverlayMode]  = useState(false);
  const [overlayOpen,  setOverlayOpen]  = useState(false);
  const [isAdmin,      setIsAdmin]      = useState(false);
  const [user,         setUser]         = useState<SidebarUser>(null);
  const { features } = useActiveChannel();

  useEffect(() => {
    const raw = window.localStorage.getItem(SIDEBAR_PREF_KEY);
    if (raw === "true") setUserPref(true);
    else if (raw === "false") setUserPref(false);
    setHydrated(true);
  }, []);

  useEffect(() => {
    createClient().auth.getClaims().then(({ data }) => {
      const claims = data?.claims as Record<string, any> | undefined;
      const role = claims?.app_metadata?.role ?? claims?.user_metadata?.role;
      const admin = role === "admin";
      setIsAdmin(admin);
      if (claims) {
        const nickname = claims.user_metadata?.nickname as string | undefined;
        const username = claims.user_metadata?.username as string | undefined;
        const email = claims.email as string | undefined;
        const name = nickname?.trim() || username?.trim() || email?.split("@")[0] || "User";
        setUser({ name, sub: role ? String(role) : "employee", isAdmin: admin });
      }
    });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mqNarrow = window.matchMedia("(max-width: 1023.98px)");
    const mqTiny   = window.matchMedia("(max-width: 639.98px)");
    const sync = () => {
      setViewportNarrow(mqNarrow.matches);
      const tiny = mqTiny.matches;
      setOverlayMode(tiny);
      if (!tiny) setOverlayOpen(false);
    };
    sync();
    mqNarrow.addEventListener("change", sync);
    mqTiny.addEventListener("change", sync);
    return () => { mqNarrow.removeEventListener("change", sync); mqTiny.removeEventListener("change", sync); };
  }, []);

  const collapsed   = userPref ?? viewportNarrow;
  const showLabels  = overlayMode || !collapsed;

  const toggleCollapse = useCallback(() => {
    if (overlayMode) { setOverlayOpen((v) => !v); return; }
    const next = !collapsed;
    setUserPref(next);
    window.localStorage.setItem(SIDEBAR_PREF_KEY, String(next));
  }, [collapsed, overlayMode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.key || e.key.toLowerCase() !== "b") return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.shiftKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      toggleCollapse();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [toggleCollapse]);

  useEffect(() => {
    const onEvent = () => toggleCollapse();
    window.addEventListener(STUDIO_SIDEBAR_TOGGLE_EVENT, onEvent);
    return () => window.removeEventListener(STUDIO_SIDEBAR_TOGGLE_EVENT, onEvent);
  }, [toggleCollapse]);

  useEffect(() => { setOverlayOpen(false); }, [pathname]);

  const effectiveOverlayMode = hydrated && overlayMode;
  const effectiveCollapsed   = hydrated && collapsed && !overlayMode;
  const sidebarWidth   = effectiveOverlayMode ? 240 : effectiveCollapsed ? 64 : 240;
  const overlayClosed  = effectiveOverlayMode && !overlayOpen;
  const layoutClass    = effectiveOverlayMode ? "fixed inset-y-0 left-0 z-50" : "shrink-0";
  const transformClass = effectiveOverlayMode ? (overlayOpen ? "translate-x-0" : "-translate-x-full") : "translate-x-0";

  const sections = isAdmin ? ADMIN_SECTIONS : buildUserSections(features);
  const dashHref = isAdmin ? "/admin" : "/";

  return (
    <>
      {effectiveOverlayMode && overlayOpen && (
        <button
          aria-label="Dismiss sidebar"
          type="button"
          onClick={() => setOverlayOpen(false)}
          className="fixed inset-y-0 left-60 right-0 z-40 bg-black/50"
        />
      )}

      <aside
        className={cn(
          "flex h-screen flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground",
          "transition-[width,transform] duration-200 ease-in-out",
          layoutClass, transformClass,
          overlayClosed && "pointer-events-none"
        )}
        style={{
          width: sidebarWidth,
          minWidth: sidebarWidth,
          maxWidth: sidebarWidth,
          flexBasis: sidebarWidth,
        }}
        aria-hidden={overlayClosed}
        inert={overlayClosed ? true : undefined}
      >
        {/* ── Header: back to dashboard + collapse ── */}
        <div className="flex h-[60px] shrink-0 items-center gap-2 px-3">
          {showLabels ? (
            <>
              <Link
                href={dashHref}
                title="Back to dashboard"
                className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-2 text-sm text-sidebar-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
              >
                <LayoutDashboard className="h-[18px] w-[18px] shrink-0" />
                <span className="truncate font-medium">Back to dashboard</span>
              </Link>
              <button
                type="button"
                onClick={toggleCollapse}
                aria-label="Collapse sidebar"
                title="Collapse (Cmd+B)"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <PanelLeftClose className="h-4 w-4" />
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={toggleCollapse}
              aria-label="Expand sidebar"
              title="Expand (Cmd+B)"
              className="mx-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* ── Nav ── */}
        <nav className="flex-1 overflow-x-hidden overflow-y-auto px-2 py-2">
          {sections.map((section, sIdx) => (
            <Fragment key={section.label ?? `s-${sIdx}`}>
              {section.separatorAbove && (
                <div
                  role="separator"
                  className={cn("my-2 border-t border-sidebar-border/60", showLabels ? "mx-1" : "-mx-1")}
                />
              )}

              {section.label && showLabels && (
                <div className="mb-1 mt-4 px-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                  {section.label}
                </div>
              )}

              <ul className="space-y-0.5">
                {section.items.map((item) => {
                  const itemPath = item.href.split("?")[0];
                  const active =
                    itemPath === "/"
                      ? pathname === "/"
                      : item.exact
                      ? pathname === itemPath
                      : pathname === itemPath || pathname.startsWith(itemPath + "/");
                  const Icon  = item.icon;
                  const badge = item.badge ?? 0;

                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={() => {
                          if (item.href === "/admin/settings/video") rememberSettingsReturn(currentSettingsReturnPath());
                        }}
                        title={!showLabels ? item.label : undefined}
                        className={cn(
                          // Same padding in both states so the icon never shifts
                          // horizontally when the rail collapses/expands.
                          "group flex items-center gap-3 rounded-xl px-2.5 py-2 text-sm transition-colors duration-150",
                          active
                            ? "bg-primary/12 font-semibold text-primary"
                            : "text-sidebar-foreground/70 hover:bg-accent hover:text-foreground"
                        )}
                      >
                        <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
                          <Icon className={cn("h-[18px] w-[18px] transition-transform duration-150", active ? "" : "group-hover:scale-110")} />
                          {!showLabels && badge > 0 && (
                            <span className="absolute -right-1.5 -top-1.5 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-warning px-1 text-[9px] font-semibold text-warning-foreground">
                              {badge}
                            </span>
                          )}
                        </span>

                        {showLabels && (
                          <>
                            <span className="flex-1 truncate">{item.label}</span>
                            {badge > 0 && (
                              <span className="rounded-full bg-warning/20 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                                {badge}
                              </span>
                            )}
                          </>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </Fragment>
          ))}
        </nav>

        {/* ── Footer: user profile pill (bottom-left) ── */}
        {user && (
          <div className={cn("shrink-0 border-t border-sidebar-border/60", showLabels ? "p-3" : "p-2")}>
            {showLabels ? (
              <div className="flex items-center gap-2.5 rounded-xl border border-sidebar-border/60 bg-card/40 px-2.5 py-2">
                <span
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold tracking-wide",
                    user.isAdmin ? "bg-primary/20 text-primary" : "bg-muted text-foreground"
                  )}
                >
                  {userInitials(user.name)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold leading-tight">{user.name}</div>
                  <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {user.isAdmin && <Shield className="h-2.5 w-2.5 text-primary" />}
                    {user.sub}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex justify-center">
                <span
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded-full text-[11px] font-bold tracking-wide",
                    user.isAdmin ? "bg-primary/20 text-primary" : "bg-muted text-foreground"
                  )}
                  title={user.name}
                >
                  {userInitials(user.name)}
                </span>
              </div>
            )}
          </div>
        )}
      </aside>
    </>
  );
}

export function dispatchSidebarToggle(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(STUDIO_SIDEBAR_TOGGLE_EVENT));
}
