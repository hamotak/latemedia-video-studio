"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronsUpDown, Check, Loader2, Tv2, Plus } from "lucide-react";
import { useActiveChannel } from "@/lib/active-channel-context";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

/**
 * Top-right channel switcher for the unified Studio's local channel list.
 */
export function StudioChannelSwitcher() {
  const { channels, activeChannel, activeChannelId, switchChannel, loading } = useActiveChannel();
  const [open, setOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [switchingId, setSwitchingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    createClient().auth.getClaims().then(({ data }) => {
      const claims = data?.claims as Record<string, any> | undefined;
      const role = claims?.app_metadata?.role;
      setIsAdmin(role === "admin");
    });
  }, []);

  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  // Still loading — don't flash anything.
  if (loading) return null;

  // No channels yet: give admins a way to create one; tell employees to wait.
  if (channels.length === 0) {
    return isAdmin ? (
      <Link
        href="/admin/channels/new"
        className="flex h-8 items-center gap-1.5 rounded-[5px] border border-dashed border-border px-2.5 text-xs font-semibold text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
      >
        <Plus className="h-3.5 w-3.5" />
        Add channel
      </Link>
    ) : (
      <span className="flex h-8 items-center gap-1.5 rounded-[5px] border border-border/60 px-2.5 text-xs font-semibold text-muted-foreground">
        <Tv2 className="h-3.5 w-3.5" />
        No channels
      </span>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-[5px] border px-2.5 text-xs font-semibold transition-colors",
          open ? "border-border bg-muted" : "border-border/60 hover:bg-muted/60"
        )}
        aria-label="Switch channel"
      >
        <ChannelAvatar channel={activeChannel} />
        <span className="max-w-[140px] truncate font-medium">
          {activeChannel?.name ?? (loading ? "Loading…" : "Select channel")}
        </span>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-[80] mt-2 w-80 overflow-hidden rounded-[7px] border border-border bg-card/95 shadow-lg backdrop-blur">
          <div className="border-b border-border px-2.5 py-2 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
            Channels
          </div>
          <ul className="max-h-[calc(100vh-9rem)] overflow-y-auto p-1.5">
            {channels.map((c) => {
              const active = c.id === activeChannelId;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    disabled={switchingId !== null}
                    onClick={async () => {
                      setSwitchingId(c.id);
                      setError(null);
                      try {
                        await switchChannel(c.id);
                        setOpen(false);
                      } catch (err) {
                        setError(err instanceof Error ? err.message : "Could not switch channel.");
                      } finally {
                        setSwitchingId(null);
                      }
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left text-xs font-semibold transition-colors",
                      active ? "bg-primary/10 text-primary" : "hover:bg-muted"
                    )}
                  >
                    <ChannelAvatar channel={c} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold">{c.name}</p>
                    </div>
                    {switchingId === c.id ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                    ) : active ? (
                      <Check className="h-4 w-4 shrink-0" />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
          {error && (
            <p className="mx-2 mb-2 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
              {error}
            </p>
          )}
          {isAdmin && (
            <div className="border-t border-border p-1.5">
              <Link
                href="/admin/channels/new"
                onClick={() => setOpen(false)}
              className="flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
                <Plus className="h-4 w-4 shrink-0" />
                Add new channel
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ChannelAvatar({ channel }: { channel: { name: string; avatar_url: string | null } | null }) {
  if (channel?.avatar_url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={channel.avatar_url}
        alt={channel.name}
        className="h-6 w-6 shrink-0 rounded-full object-cover"
      />
    );
  }
  if (channel) {
    return (
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">
        {(channel.name[0] ?? "?").toUpperCase()}
      </div>
    );
  }
  return (
    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
      <Tv2 className="h-3.5 w-3.5" />
    </div>
  );
}
