"use client";

import * as React from "react";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { StudioCommandBar } from "@/components/studio-command-bar";
import { VideoWorkspaceTabs } from "@/components/video-workspace-tabs";

interface VideoWorkspaceShellProps {
  /** Opens the page's History pop-up. The History button is always shown. */
  onHistoryClick: () => void;
  status?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Shared chrome for both Video workspace tabs (New Video + B-Rolls) so they
 * stay visually identical — only `children` (the body) changes when switching
 * tabs. Full-bleed single column; the History button replaces the old
 * left history rail and shows at every breakpoint.
 */
export function VideoWorkspaceShell({
  onHistoryClick,
  status,
  actions,
  children,
}: VideoWorkspaceShellProps) {
  return (
    <div className="-mx-6 -mb-6 -mt-20 flex h-[calc(100vh-3.5rem)]">
      <main className="flex-1 overflow-y-auto">
        <PageContainer className="max-w-[1440px] space-y-5 pb-10 pt-20">
          <PageHeader title="Video" />
          <StudioCommandBar
            showHistory
            onHistoryClick={onHistoryClick}
            status={status}
            actions={actions}
          />
          <VideoWorkspaceTabs />
          {children}
        </PageContainer>
      </main>
    </div>
  );
}
