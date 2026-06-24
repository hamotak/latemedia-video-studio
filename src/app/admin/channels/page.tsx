"use client";

import Link from "next/link";
import { Plus, Tv2, Clapperboard, RefreshCw, Pencil } from "lucide-react";
import { useActiveChannel } from "@/lib/active-channel-context";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Channels list for the standalone Video Studio. Each channel carries the
 * production profile (voice + visual style) the Video tool renders against.
 * Picking "Use" makes it the active channel for the Video studio + B-Rolls.
 */
export default function AdminChannelsPage() {
  const { channels, activeChannelId, switchChannel, refresh, loading } = useActiveChannel();

  return (
    <PageContainer className="max-w-4xl space-y-5">
      <PageHeader
        title="Channels"
        description="Each channel keeps its own voice and visual style for video generation."
        action={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </Button>
            <Link href="/admin/channels/new" className={buttonVariants({ size: "sm" })}>
              <Plus className="h-4 w-4" />
              Add channel
            </Link>
          </div>
        }
      />

      {loading ? (
        <div className="h-40 animate-pulse rounded-xl bg-muted/40" />
      ) : channels.length === 0 ? (
        <Card>
          <CardContent className="space-y-4 py-12 text-center">
            <Tv2 className="mx-auto h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm font-medium">No channels yet</p>
            <Link href="/admin/channels/new" className={buttonVariants()}>
              <Plus className="h-4 w-4" />
              Create your first channel
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {channels.map((channel) => {
            const active = channel.id === activeChannelId;
            return (
              <div
                key={channel.id}
                className={cn(
                  "flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0",
                  active && "bg-muted/40"
                )}
              >
                {channel.avatar_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={channel.avatar_url}
                    alt=""
                    referrerPolicy="no-referrer"
                    className="h-10 w-10 shrink-0 rounded-full object-cover"
                  />
                ) : (
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
                    {(channel.name[0] ?? "?").toUpperCase()}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{channel.name}</p>
                  {channel.handle && (
                    <p className="truncate text-xs text-muted-foreground">{channel.handle}</p>
                  )}
                </div>
                {active ? (
                  <span className="rounded-full bg-primary/15 px-2.5 py-1 text-xs font-medium text-primary">
                    Active
                  </span>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => void switchChannel(channel.id)}>
                    Use
                  </Button>
                )}
                <Link
                  href={`/admin/channels/${channel.id}`}
                  className={buttonVariants({ variant: "ghost", size: "sm" })}
                >
                  <Pencil className="h-4 w-4" />
                  Edit
                </Link>
                <Link
                  href="/studio/video"
                  className={buttonVariants({ variant: "ghost", size: "sm" })}
                >
                  <Clapperboard className="h-4 w-4" />
                  Video
                </Link>
              </div>
            );
          })}
        </div>
      )}
    </PageContainer>
  );
}
