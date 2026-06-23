"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge, type BadgeProps } from "@/components/ui/badge";

export interface ContextChip {
  label: string;
  variant?: BadgeProps["variant"];
}

interface ContextStripProps {
  icon?: LucideIcon;
  title: string;
  subtitle?: string;
  /** Compact summary chips shown in the collapsed row. */
  chips?: ContextChip[];
  /** Optional right-aligned control (a link/button); clicking it does NOT toggle. */
  action?: React.ReactNode;
  defaultOpen?: boolean;
  /** Controlled open state (optional). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
}

/**
 * Slim collapsible "context strip": a one-line summary (icon · title · chips) that
 * expands inline to reveal the full editor/detail. Folds heavy config (channel memory,
 * settings-style fields) down to a single row by default — nothing is removed, just
 * tucked away until needed.
 */
export function ContextStrip({
  icon: Icon,
  title,
  subtitle,
  chips,
  action,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  children,
  className,
}: ContextStripProps) {
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
  const open = openProp ?? internalOpen;
  const setOpen = (next: boolean) => {
    onOpenChange?.(next);
    if (openProp === undefined) setInternalOpen(next);
  };

  return (
    <section
      className={cn(
        "overflow-hidden rounded-xl border border-border bg-card shadow-sm",
        className
      )}
    >
      <div className="flex items-center gap-2 px-2.5 py-2">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-accent/60"
        >
          {Icon ? (
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Icon className="h-3.5 w-3.5" />
            </span>
          ) : null}
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold leading-tight">{title}</span>
            {subtitle ? (
              <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>
            ) : null}
          </span>
          {chips && chips.length > 0 ? (
            <span className="ml-1 hidden shrink-0 items-center gap-1.5 sm:flex">
              {chips.map((chip, i) => (
                <Badge key={`${chip.label}-${i}`} variant={chip.variant ?? "secondary"}>
                  {chip.label}
                </Badge>
              ))}
            </span>
          ) : null}
          <ChevronDown
            className={cn(
              "ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180"
            )}
          />
        </button>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {open ? <div className="border-t border-border px-3 py-3">{children}</div> : null}
    </section>
  );
}
