"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { UserButton } from "@/components/user-button";
import { cn } from "@/lib/utils";

interface AdminPageShellProps {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  maxWidth?: string;
  backLabel?: string;
  backHref?: string;
  onBack?: () => void;
  className?: string;
}

export function AdminPageShell({
  title,
  description,
  action,
  children,
  maxWidth = "max-w-6xl",
  backLabel,
  backHref,
  onBack,
  className,
}: AdminPageShellProps) {
  const backControl = onBack ? (
    <Button type="button" variant="ghost" size="sm" onClick={onBack}>
      <ArrowLeft className="h-4 w-4" />
      {backLabel ?? "Back"}
    </Button>
  ) : backHref ? (
    <Link
      href={backHref}
      className="inline-flex h-7 items-center gap-1.5 rounded-[5px] px-2 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" />
      {backLabel ?? "Back"}
    </Link>
  ) : (
    <Link
      href="/admin"
      className="inline-flex h-7 items-center rounded-[5px] px-2 text-xs font-semibold text-foreground transition-colors hover:bg-muted"
    >
      Late Media
    </Link>
  );

  return (
    <main className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-12 w-full max-w-6xl items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
          <div className="min-w-0">{backControl}</div>
          <UserButton />
        </div>
      </header>
      <div className={cn("mx-auto w-full px-4 py-5 sm:px-6 lg:px-8", maxWidth, className)}>
        <PageHeader title={title} description={description} action={action} />
        <div className="mt-4">{children}</div>
      </div>
    </main>
  );
}
