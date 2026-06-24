"use client";

import { Menu } from "lucide-react";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { dispatchSidebarToggle } from "@/components/sidebar";
import { UserButton } from "@/components/user-button";
import { StudioChannelSwitcher } from "@/components/studio-channel-switcher";

function isStudioRoute(pathname: string) {
  const prefixes = [
    "/ideas",
    "/images",
    "/board",
    "/video",
    "/channel-info",
    "/admin/channels",
    "/admin/settings",
    "/admin/boards",
    "/admin/board",
    "/admin/create",
    // legacy paths (redirected, but keep the switcher during transition)
    "/ideate",
    "/image-studio",
    "/boards",
    "/studio/video",
  ];
  return prefixes.some((p) => pathname === p || pathname.startsWith(p + "/")) || pathname === "/admin/channels";
}

export function Topbar() {
  const pathname = usePathname();
  const showChannelSwitcher = isStudioRoute(pathname);

  return (
    <header className="relative z-50 flex h-12 items-center justify-between gap-2 border-b border-border bg-background/95 px-3 backdrop-blur sm:px-4">
      <div className="flex min-w-0 items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={dispatchSidebarToggle}
          aria-label="Open sidebar"
          className="sm:hidden"
        >
          <Menu className="h-4 w-4" />
        </Button>
        <div className="hidden sm:block" />
      </div>
      <div className="flex items-center gap-2">
        {showChannelSwitcher && <StudioChannelSwitcher />}
        <UserButton />
      </div>
    </header>
  );
}
