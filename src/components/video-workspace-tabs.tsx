"use client";

import Link from "next/link";
import { Clapperboard, Film } from "lucide-react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/studio/video", label: "New Video", icon: Clapperboard, exact: true },
  { href: "/studio/video/clips", label: "B-Rolls", icon: Film, exact: false },
] as const;

export function VideoWorkspaceTabs() {
  const pathname = usePathname();

  return (
    <nav aria-label="Video workspace" className="border-b border-border">
      <div className="flex gap-4 overflow-x-auto">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const active = tab.exact
            ? pathname === tab.href
            : pathname === tab.href || pathname.startsWith(`${tab.href}/`);

          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "-mb-px inline-flex h-8 shrink-0 items-center gap-1.5 border-b-2 text-xs font-semibold transition-colors",
                active
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
