"use client";

import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/sidebar";
import { Topbar } from "@/components/topbar";
import { ActiveChannelProvider } from "@/lib/active-channel-context";
import { cn } from "@/lib/utils";

export function ShellWrapper({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (pathname === "/admin" || pathname === "/admin/channels/new" || pathname.startsWith("/admin/settings")) {
    return (
      <ActiveChannelProvider>
        <div className="min-h-screen bg-background">
          {children}
        </div>
      </ActiveChannelProvider>
    );
  }

  // The Kanban board fills the whole work area (its own internal scroll), so it
  // renders full-bleed — no page padding, no top gap.
  const fullBleed =
    pathname.startsWith("/admin/boards/") || /^\/boards\/[^/]/.test(pathname);

  return (
    <ActiveChannelProvider>
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <Topbar />
          <main className={cn("flex-1", fullBleed ? "overflow-hidden" : "overflow-y-auto px-6 pb-6 pt-6")}>
            {children}
          </main>
        </div>
      </div>
    </ActiveChannelProvider>
  );
}
