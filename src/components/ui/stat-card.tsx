import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface StatCardProps {
  icon?: LucideIcon;
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  className?: string;
}

/** boltstack stat card: tinted rounded icon chip + label + big value. */
export function StatCard({ icon: Icon, label, value, hint, className }: StatCardProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-card",
        className
      )}
    >
      <div className="flex items-center gap-2.5">
        {Icon ? (
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
            <Icon className="h-4 w-4" />
          </span>
        ) : null}
        <span className="text-sm font-medium text-muted-foreground">{label}</span>
      </div>
      <div className="min-w-0">
        <div className="truncate text-2xl font-semibold tracking-tight text-foreground">
          {value}
        </div>
        {hint ? <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div> : null}
      </div>
    </div>
  );
}
