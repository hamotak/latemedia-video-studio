"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, Moon, Sun, Shield, UserRound, Settings } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useTheme } from "@/lib/theme-provider";
import { rememberSettingsReturn } from "@/lib/settings-return";
import { cn } from "@/lib/utils";
import type { User } from "@supabase/supabase-js";

function initials(nickname: string | null, email: string) {
  const src = nickname?.trim() || email.split("@")[0];
  const parts = src.split(/[\s._-]/);
  return parts
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export function UserButton() {
  const pathname = usePathname();
  const [user, setUser] = useState<User | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { theme, toggle } = useTheme();

  useEffect(() => {
    createClient().auth.getClaims().then(({ data }) =>
      setUser(
        data?.claims
          ? ({
              id: data.claims.sub,
              email: data.claims.email,
              app_metadata: data.claims.app_metadata,
              user_metadata: data.claims.user_metadata,
            } as unknown as User)
          : null
      )
    );
  }, []);

  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  if (!user) return null;

  const nickname = user.user_metadata?.nickname ?? null;
  const displayName = nickname?.trim() || user.email?.split("@")[0] || "User";
  // Show the username (not the synthetic email).
  const username = (user.user_metadata?.username as string)?.trim() || user.email?.split("@")[0] || "";
  const role: string = user.app_metadata?.role ?? user.user_metadata?.role ?? "employee";
  const isAdmin = role === "admin";
  const showSettings = isAdmin && !pathname.startsWith("/admin/settings");
  const initStr = initials(nickname, user.email ?? "");

  return (
    <div className="relative" ref={ref}>
      {/* Trigger — avatar pill + chevron */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-full border border-border bg-card py-1 pl-1 pr-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label="Open user menu"
      >
        <span
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold tracking-wide",
            isAdmin ? "bg-primary/20 text-primary" : "bg-muted text-foreground"
          )}
        >
          {initStr}
        </span>
        <ChevronDown className="h-4 w-4" />
      </button>

      {/* Dropdown panel */}
      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-64 overflow-hidden rounded-2xl border border-border bg-card shadow-xl">

          {/* Profile header */}
          <div className="flex items-center gap-3 bg-muted/30 px-4 py-4">
            <div
              className={cn(
                "flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-sm font-bold tracking-wide",
                isAdmin
                  ? "bg-primary/20 text-primary"
                  : "bg-muted text-muted-foreground"
              )}
            >
              {initStr}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold leading-tight">{displayName}</p>
              {username && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">@{username}</p>}
              <div className="mt-1.5 flex items-center gap-1">
                {isAdmin ? (
                  <Shield className="h-3 w-3 text-primary" />
                ) : (
                  <UserRound className="h-3 w-3 text-muted-foreground" />
                )}
                <span
                  className={cn(
                    "text-[10px] font-semibold uppercase tracking-wider",
                    isAdmin ? "text-primary" : "text-muted-foreground"
                  )}
                >
                  {role}
                </span>
              </div>
            </div>
          </div>

          {/* Menu items */}
          <div className="p-2">
            {/* Appearance row */}
            <button
              type="button"
              onClick={toggle}
              className="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors hover:bg-muted"
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-muted text-muted-foreground group-hover:bg-background">
                {theme === "light" ? (
                  <Moon className="h-3.5 w-3.5" />
                ) : (
                  <Sun className="h-3.5 w-3.5" />
                )}
              </span>
              <span className="font-medium">
                {theme === "light" ? "Dark mode" : "Light mode"}
              </span>
            </button>

            {/* Global settings — admin only */}
            {showSettings && (
              <>
                <Link
                  href="/admin/settings/video"
                  onClick={() => {
                    rememberSettingsReturn(pathname);
                    setOpen(false);
                  }}
                  className="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors hover:bg-muted"
                >
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-muted text-muted-foreground group-hover:bg-background">
                    <Settings className="h-3.5 w-3.5" />
                  </span>
                  <span className="font-medium">Settings</span>
                </Link>
              </>
            )}
          </div>

        </div>
      )}
    </div>
  );
}
