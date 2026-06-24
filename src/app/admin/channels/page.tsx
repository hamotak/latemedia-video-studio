"use client";

import Link from "next/link";
import { Plus, Tv2, RefreshCw, Pencil, Trash2, Loader2 } from "lucide-react";
import { useState } from "react";
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
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [error, setError] = useState("");

  const deleteChannel = async (channelId: number) => {
    setDeletingId(channelId);
    setError("");
    try {
      const res = await fetch(`/api/studio/channels/${channelId}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not delete channel.");
      setConfirmDeleteId(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete channel.");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <PageContainer className="max-w-4xl space-y-5">
      <PageHeader
        title="Channels"
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

      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

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
                {confirmDeleteId === channel.id ? (
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirmDeleteId(null)}
                      disabled={deletingId === channel.id}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => void deleteChannel(channel.id)}
                      disabled={deletingId === channel.id}
                    >
                      {deletingId === channel.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                      Delete
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmDeleteId(channel.id)}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </PageContainer>
  );
}
