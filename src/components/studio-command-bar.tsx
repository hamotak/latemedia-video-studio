"use client";

import * as React from "react";
import { Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface StudioCommandBarProps {
  showHistory?: boolean;
  onHistoryClick?: () => void;
  status?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}

export function StudioCommandBar({
  showHistory,
  onHistoryClick,
  status,
  actions,
  children,
  className,
}: StudioCommandBarProps) {
  const hasLeft = (showHistory && onHistoryClick) || children;
  if (!hasLeft && !status && !actions) return null;

  return (
    <div
      aria-label="Studio page actions"
      className={cn(
        "flex flex-wrap items-center justify-between gap-2 rounded-[7px] border border-border bg-card/80 px-2.5 py-2 shadow-none backdrop-blur",
        className
      )}
    >
      {hasLeft ? (
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {showHistory && onHistoryClick ? (
          <Button type="button" variant="outline" size="sm" onClick={onHistoryClick} className="bg-background/80">
            <Clock className="h-4 w-4" />
            History
          </Button>
        ) : null}
        {children}
      </div>
      ) : null}
      {status ? <div className="flex min-w-0 flex-1 justify-start sm:justify-center">{status}</div> : null}
      {actions ? <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">{actions}</div> : null}
    </div>
  );
}
