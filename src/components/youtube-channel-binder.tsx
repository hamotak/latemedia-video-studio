"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Loader2,
  RefreshCw,
  Link2,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Check,
  Plus,
  Trash2,
  Tv,
  Settings,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/lib/i18n/provider";
import { fetchJson } from "@/lib/client-fetch";

type Channel = {
  id: string;
  title: string;
  handle: string | null;
  subscribers: number | null;
  views: number | null;
  videoCount: number | null;
  thumbnail: string | null;
};

type Progress =
  | { type: "status"; step: string; message?: string; total?: number }
  | { type: "channel"; channel: Channel }
  | { type: "progress"; phase: string; count: number; total?: number }
  | { type: "done"; saved: number; total: number }
  | { type: "error"; message: string; status?: number };

function fmt(n: number | null): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return n.toLocaleString();
}

type BoundChannel = {
  id: number; // Studio channel numeric ID
  youtube_channel_id: string | null;
  title: string | null;
  handle: string | null;
  subscriber_count: number | null;
  video_count: number | null;
  // User-managed metadata (set via the Edit panel below).
  editor_name?: string | null;
  cms_name?: string | null;
  cms_cut_percent?: number | null;
  adsense_name?: string | null;
  monetization_status?: "monetized" | "pending" | "not_eligible" | null;
  notes?: string | null;
  // Tags (from channel_tags m:n) — folded in by the API layer.
  tags?: { id: number; name: string; cut_percent: number | null }[];
};

export function YouTubeChannelBinder({
  hasKey,
  onChannelsChanged,
  onChannelSynced,
  onSwitchChannel,
  mode = "full",
}: {
  hasKey: boolean;
  onChannelsChanged?: () => void;
  /** Fired after a successful sync with the resolved channel, so callers can
   *  mirror it into the Studio (Supabase) channel store. */
  onChannelSynced?: (ch: { id: string; title: string | null; handle: string | null; avatar_url: string | null }) => void | Promise<void>;
  /** If provided, called instead of window.location.reload() after switching
   *  the active channel — lets the parent refresh in-place. */
  onSwitchChannel?: (studioId: number) => Promise<void>;
  /** "add-only" hides the connected-channel management list for dashboard import flows. */
  mode?: "full" | "add-only";
}) {
  const { t } = useI18n();
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ phase: string; count: number; total?: number } | null>(null);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [savedCount, setSavedCount] = useState<number | null>(null);
  const [boundChannels, setBoundChannels] = useState<BoundChannel[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [pendingChannelId, setPendingChannelId] = useState<number | null>(null);
  // Filter input for the connected-channels list. With 20+ channels the
  // list becomes scroll-heavy; a simple substring search saves a lot of
  // scrolling for users who actually know the channel name.
  const [filter, setFilter] = useState("");
  // Which channel row currently has its meta-edit panel expanded.
  // null = all rows collapsed. Single-select — opening one closes the
  // previous so the page doesn't sprawl.
  const [editingChannelId, setEditingChannelId] = useState<number | null>(null);
  // Connected channels expanded by default so users see their channels
  // first when they land on Channel Info. They can still collapse the
  // list via the header if the 20+ row list gets noisy.
  const [channelsListExpanded, setChannelsListExpanded] = useState(true);
  const addOnly = mode === "add-only";
  const title = addOnly ? "Import channel from YouTube" : t.youtube.bindTitle;
  const inputLabel = addOnly ? "YouTube channel" : "Add another channel";
  const missingKeyTitle = addOnly ? "YouTube API key required" : t.youtube.needKey;

  const loadBound = useCallback(async () => {
    try {
      const data = await fetchJson<{
        channels: BoundChannel[];
        activeId: number | null;
      }>("/api/channels", { cache: "no-store" });
      setBoundChannels(data.channels);
      setActiveId(data.activeId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load channels.");
    }
  }, []);

  useEffect(() => {
    loadBound();
  }, [loadBound]);

  // Keep the "Active" badge in sync when the channel is switched from the
  // top-bar StudioChannelSwitcher (which fires this event after switching).
  useEffect(() => {
    const onChange = () => { void loadBound(); };
    window.addEventListener("studio-channel-changed", onChange);
    return () => window.removeEventListener("studio-channel-changed", onChange);
  }, [loadBound]);

  const switchTo = async (id: number) => {
    setPendingChannelId(id);
    setError("");
    try {
      await fetchJson("/api/channels/active", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (onSwitchChannel) {
        await onSwitchChannel(id);
        await loadBound(); // refresh Active badge without reloading
      } else {
        // Hard refresh — every page renders against the active channel.
        window.location.reload();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not switch channel.");
    } finally {
      setPendingChannelId(null);
    }
  };

  const removeChannel = async (id: number, title: string | null) => {
    if (
      !confirm(
        `Remove channel "${title ?? id}" and all its data (videos, comments)?\nThis cannot be undone.`
      )
    ) {
      return;
    }
    setPendingChannelId(id);
    setError("");
    try {
      await fetchJson(`/api/channels/${id}`, { method: "DELETE" });
      await loadBound();
      onChannelsChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove channel.");
    } finally {
      setPendingChannelId(null);
    }
  };

  const runSync = useCallback(
    async (target?: string) => {
      const payload = target ?? input;
      if (!payload.trim() || !hasKey) return;
      setBusy(true);
      setError("");
      setStatus("");
      setProgress(null);
      setChannel(null);
      setSavedCount(null);

      try {
        const res = await fetch("/api/youtube/sync", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: payload, max: 1000 }),
        });

        if (!res.ok || !res.body) {
          const err = await res.json().catch(() => ({}));
          setError(err.error ?? `HTTP ${res.status}`);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let syncedChannel: Channel | null = null;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const raw = line.slice(6).trim();
            if (!raw) continue;
            let ev: Progress;
            try {
              ev = JSON.parse(raw) as Progress;
            } catch {
              continue;
            }
            if (ev.type === "status") setStatus(ev.message ?? ev.step);
            else if (ev.type === "channel") { setChannel(ev.channel); syncedChannel = ev.channel; }
            else if (ev.type === "progress")
              setProgress({ phase: ev.phase, count: ev.count, total: ev.total });
            else if (ev.type === "done") {
              setSavedCount(ev.saved);
              setStatus(t.youtube.done.replace("{n}", String(ev.saved)));
              setInput(""); // clear input so it's ready for the next channel
              await loadBound(); // refresh the bound-channels list
              setChannelsListExpanded(true); // reveal the new channel without a page refresh
              onChannelsChanged?.();
              // Mirror the synced channel into the Studio (Supabase) store.
              if (syncedChannel) {
                await onChannelSynced?.({
                  id: syncedChannel.id,
                  title: syncedChannel.title ?? null,
                  handle: syncedChannel.handle ?? null,
                  avatar_url: syncedChannel.thumbnail ?? null,
                });
              }
            } else if (ev.type === "error") setError(ev.message);
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "network error");
      } finally {
        setBusy(false);
      }
    },
    [input, hasKey, t.youtube.done]
  );

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Link2 className="h-4 w-4 text-muted-foreground" />
        {title}
      </div>

      {/* List of currently bound channels — multi-channel mode. Each row
          shows status (Active / inactive), basic stats, and Switch /
          Re-sync / Remove actions. Hidden until at least one channel
          exists. */}
      {mode !== "add-only" && boundChannels.length > 0 && (
        <div className="space-y-1.5">
          <button
            type="button"
            onClick={() => setChannelsListExpanded((v) => !v)}
            className="flex w-full items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs font-medium hover:bg-accent"
            aria-expanded={channelsListExpanded}
          >
            <span>
              Connected channels ({boundChannels.length})
            </span>
            <span className="text-muted-foreground">
              {channelsListExpanded ? "▴" : "▾"}
            </span>
          </button>
          {channelsListExpanded && (
            <>
          {boundChannels.length > 5 && (
            <Input
              type="text"
              placeholder="Filter channels…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="h-7 w-full text-xs"
            />
          )}
          <ul className="space-y-1.5">
            {boundChannels
              .filter((c) => {
                const q = filter.trim().toLowerCase();
                if (!q) return true;
                return (
                  (c.title ?? "").toLowerCase().includes(q) ||
                  (c.handle ?? "").toLowerCase().includes(q) ||
                  (c.youtube_channel_id ?? "").toLowerCase().includes(q)
                );
              })
              .map((c) => {
              const isActive = c.id === activeId;
              const pending = pendingChannelId === c.id;
              const isEditing = editingChannelId === c.id;
              return (
                <li
                  key={c.id}
                  className={`rounded-md border ${
                    isActive
                      ? "border-primary/40 bg-primary/5"
                      : "border-border bg-muted/20"
                  }`}
                >
                <div className="flex items-center gap-3 p-2.5">
                  <Tv className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {c.title ?? c.id}
                      </span>
                      {isActive && (
                        <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                          <Check className="h-2.5 w-2.5" /> Active
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {c.handle ?? "—"}
                      {c.subscriber_count !== null && (
                        <> · {fmt(c.subscriber_count)} subs</>
                      )}
                      {c.video_count !== null && (
                        <> · {fmt(c.video_count)} videos</>
                      )}
                    </div>
                    {/* Channel meta badges. Status / editor / tags
                        are rendered as small chips inline. Only show
                        when something's actually set. */}
                    {(c.editor_name ||
                      c.monetization_status ||
                      (c.tags && c.tags.length > 0)) && (
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px]">
                        {c.monetization_status === "monetized" && (
                          <span className="inline-flex items-center gap-0.5 rounded bg-emerald-500/15 px-1.5 py-0.5 font-medium text-emerald-700 dark:text-emerald-400">
                            $ monetized
                          </span>
                        )}
                        {c.monetization_status === "pending" && (
                          <span className="inline-flex items-center gap-0.5 rounded bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-700 dark:text-amber-400">
                            ⏳ pending
                          </span>
                        )}
                        {c.monetization_status === "not_eligible" && (
                          <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 font-medium text-muted-foreground">
                            not eligible
                          </span>
                        )}
                        {c.editor_name && (
                          <span className="inline-flex items-center gap-0.5 rounded bg-rose-500/15 px-1.5 py-0.5 font-medium text-rose-700 dark:text-rose-400">
                            Editor: {c.editor_name}
                          </span>
                        )}
                        {(c.tags ?? []).map((t) => (
                          <span
                            key={t.id}
                            className="inline-flex items-center gap-0.5 rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary"
                          >
                            {t.name}
                            {typeof t.cut_percent === "number" &&
                              t.cut_percent > 0 &&
                              ` −${t.cut_percent}%`}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {!isActive && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => switchTo(c.id)}
                        disabled={pending || busy}
                        className="h-7 px-2 text-[11px]"
                      >
                        {pending ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          "Switch"
                        )}
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setEditingChannelId(isEditing ? null : c.id)
                      }
                      className="h-7 w-7 p-0"
                      title="Edit channel metadata (editor, CMS, monetization, notes)"
                      aria-label="Edit channel metadata"
                    >
                      <Settings className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => removeChannel(c.id, c.title)}
                      disabled={pending || busy}
                      className="h-7 w-7 p-0 text-destructive"
                      aria-label="Remove channel"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                {isEditing && (
                  <ChannelMetaEditor
                    channel={c}
                    onClose={() => setEditingChannelId(null)}
                    onSaved={() => loadBound()}
                  />
                )}
                </li>
              );
            })}
          </ul>
            </>
          )}
        </div>
      )}

      <div className="space-y-2 border-t border-border pt-3">
        <div>
          <Label
            htmlFor="yt-channel"
            className="flex items-center gap-1.5 text-sm font-medium"
          >
            <Plus className="h-3.5 w-3.5 text-muted-foreground" />
            {inputLabel}
          </Label>
        </div>
        <div className="flex gap-2">
          <Input
            id="yt-channel"
            placeholder="@handle, channel URL, or channel ID"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy || !hasKey}
          />
          <Button
            onClick={() => runSync()}
            disabled={busy || !hasKey || !input.trim()}
            variant={input.trim() && hasKey ? "default" : "outline"}
            className="gap-2"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {t.youtube.sync}
          </Button>
        </div>
        {!hasKey && (
          <div className="flex items-start gap-2.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="space-y-0.5 text-xs">
              <p className="font-semibold text-amber-700 dark:text-amber-300">
                {missingKeyTitle}
              </p>
            </div>
          </div>
        )}
      </div>

      {channel && busy && (
        <div className="flex items-start gap-3 rounded-md border border-border bg-muted/30 p-3">
          {channel.thumbnail && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={channel.thumbnail}
              alt=""
              className="h-12 w-12 rounded-full"
              referrerPolicy="no-referrer"
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{channel.title}</div>
            <div className="text-xs text-muted-foreground">
              {channel.handle ?? ""}{" "}
              {channel.handle && (channel.subscribers !== null || channel.videoCount !== null)
                ? "·"
                : ""}{" "}
              {channel.subscribers !== null && (
                <>{fmt(channel.subscribers)} {t.youtube.subscribers}</>
              )}
              {channel.videoCount !== null && (
                <>
                  {" · "}
                  {fmt(channel.videoCount)} {t.youtube.videos}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {(status || progress) && !error && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : savedCount !== null ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
          ) : null}
          <span>
            {status}
            {progress && (
              <>
                {" — "}
                {progress.count}
                {progress.total ? ` / ${progress.total}` : ""}
              </>
            )}
          </span>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      </CardContent>
    </Card>
  );
}

/**
 * Inline editor for the user-managed channel metadata: editor name,
 * CMS / network, CMS revenue cut %, AdSense account label,
 * monetization status, free-form notes. Renders below a channel row
 * when the user clicks the gear icon. Saves via PATCH on /api/channels/:id.
 */
function ChannelMetaEditor({
  channel,
  onClose,
  onSaved,
}: {
  channel: BoundChannel;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [status, setStatus] = useState<
    "" | "monetized" | "pending" | "not_eligible"
  >(channel.monetization_status ?? "");
  const [notes, setNotes] = useState(channel.notes ?? "");
  const [channelDescription, setChannelDescription] = useState("");
  const [thumbnailDesignRules, setThumbnailDesignRules] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/channel-info")
      .then((r) => r.json())
      .then((data: { channels: { id: number; channelDescription: string; thumbnailDesignRules: string }[] }) => {
        const ch = data.channels?.find((c) => c.id === channel.id);
        if (ch) {
          setChannelDescription(ch.channelDescription ?? "");
          setThumbnailDesignRules(ch.thumbnailDesignRules ?? "");
        }
      })
      .catch(() => {});
  }, [channel.id]);

  const save = async () => {
    setSaving(true);
    setErr("");
    try {
      const metaRes = await fetch(`/api/channels/${encodeURIComponent(channel.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          monetization_status: status === "" ? null : status,
          notes,
        }),
      });
      if (!metaRes.ok) {
        const j = (await metaRes.json().catch(() => ({}))) as { error?: string };
        setErr(j.error ?? `HTTP ${metaRes.status}`);
        setSaving(false);
        return;
      }

      await Promise.all(
        (
          [
            ["channelDescription", channelDescription],
            ["thumbnailDesignRules", thumbnailDesignRules],
          ] as [string, string][]
        ).map(([field, value]) =>
          fetchJson("/api/channel-info", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ channelId: channel.id, field, value }),
          })
        )
      );

      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 border-t border-border bg-background/50 p-3 text-xs">
      {/* Tags multi-select — saves on each click, no need to bundle
          with the [Save] button below. */}
      <ChannelTagsEditor channelId={channel.id} onChange={onSaved} />

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1 sm:col-span-2">
          <Label className="text-[10px] uppercase text-muted-foreground">
            Monetization status
          </Label>
          <select
            value={status}
            onChange={(e) =>
              setStatus(
                e.target.value as "" | "monetized" | "pending" | "not_eligible"
              )
            }
            className="h-7 w-full rounded-md border bg-background px-2 text-xs"
          >
            <option value="">—</option>
            <option value="monetized">Monetized</option>
            <option value="pending">YPP pending</option>
            <option value="not_eligible">Not eligible</option>
          </select>
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label className="text-[10px] uppercase text-muted-foreground">
            Channel description
          </Label>
          <textarea
            value={channelDescription}
            onChange={(e) => setChannelDescription(e.target.value)}
            placeholder="What this channel is about — niche, audience, tone"
            rows={3}
            maxLength={1500}
            className="w-full resize-y rounded-md border bg-background px-2 py-1 text-xs"
          />
          <div className="text-right text-[10px] text-muted-foreground">
            {channelDescription.length}/1500
          </div>
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label className="text-[10px] uppercase text-muted-foreground">
            Channel thumbnail design rules
          </Label>
          <textarea
            value={thumbnailDesignRules}
            onChange={(e) => setThumbnailDesignRules(e.target.value)}
            placeholder="Channel-specific thumbnail rules for the AI designer (e.g. always use white text, avoid red backgrounds)"
            rows={3}
            maxLength={1200}
            className="w-full resize-y rounded-md border bg-background px-2 py-1 text-xs"
          />
          <div className="text-right text-[10px] text-muted-foreground">
            {thumbnailDesignRules.length}/1200
          </div>
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label className="text-[10px] uppercase text-muted-foreground">
            Notes
          </Label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Anything else to remember about this channel"
            rows={2}
            className="w-full resize-y rounded-md border bg-background px-2 py-1 text-xs"
          />
        </div>
      </div>
      {err && (
        <div className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          {err}
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onClose}
          disabled={saving}
          className="h-7 text-xs"
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={save}
          disabled={saving}
          className="h-7 text-xs"
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
        </Button>
      </div>
    </div>
  );
}

/* ---------- Tags multi-select for one channel ---------- */

type Tag = {
  id: number;
  name: string;
  cut_percent: number | null;
  color: string | null;
};

/**
 * Multi-select tag editor for a single channel. Loads:
 *   - the channel's currently-attached tags
 *   - every existing tag in the system (so the combobox can suggest)
 * On every change (attach / detach / new tag) it re-fetches both lists
 * and notifies the parent via `onChange` so the parent can refresh
 * its own row payload (chip preview etc.).
 */
function ChannelTagsEditor({
  channelId,
  onChange,
}: {
  channelId: number;
  onChange?: () => void;
}) {
  const [attached, setAttached] = useState<Tag[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [name, setName] = useState("");
  const [cutInput, setCutInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const [chData, allData] = await Promise.all([
        fetchJson<{ tags: Tag[] }>(`/api/channels/${encodeURIComponent(channelId)}/tags`, {
          cache: "no-store",
        }),
        fetchJson<{ tags: Tag[] }>(`/api/tags`, { cache: "no-store" }),
      ]);
      setAttached(chData.tags ?? []);
      setAllTags(allData.tags ?? []);
      setErr("");
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Could not load tags.");
    }
  }, [channelId]);

  useEffect(() => {
    load();
  }, [load]);

  const attachByName = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setErr("");
    try {
      const cutNum = cutInput.trim() === "" ? null : Number(cutInput);
      if (
        cutInput.trim() !== "" &&
        (!Number.isFinite(cutNum) || cutNum! < 0 || cutNum! > 100)
      ) {
        setErr("cut % must be 0-100");
        setBusy(false);
        return;
      }
      await fetchJson(
        `/api/channels/${encodeURIComponent(channelId)}/tags`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: trimmed, cut_percent: cutNum }),
        }
      );
      setName("");
      setCutInput("");
      await load();
      onChange?.();
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Could not attach tag.");
    } finally {
      setBusy(false);
    }
  };

  const attachExisting = async (tagId: number) => {
    setBusy(true);
    setErr("");
    try {
      await fetchJson(`/api/channels/${encodeURIComponent(channelId)}/tags`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tagId }),
      });
      await load();
      onChange?.();
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Could not attach tag.");
    } finally {
      setBusy(false);
    }
  };

  const detach = async (tagId: number) => {
    setBusy(true);
    setErr("");
    try {
      await fetchJson(
        `/api/channels/${encodeURIComponent(channelId)}/tags/${tagId}`,
        { method: "DELETE" }
      );
      await load();
      onChange?.();
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Could not remove tag.");
    } finally {
      setBusy(false);
    }
  };

  // Suggestions = allTags minus already-attached, optionally filtered
  // by the typed name.
  const suggestions = allTags.filter((t) => {
    if (attached.some((a) => a.id === t.id)) return false;
    if (!name.trim()) return true;
    return t.name.toLowerCase().includes(name.trim().toLowerCase());
  });

  return (
    <div className="space-y-2 rounded-md border border-border bg-card p-2.5">
      <div className="flex items-center justify-between">
        <Label className="text-[10px] uppercase text-muted-foreground">
          Tags
        </Label>
        <span className="text-[10px] text-muted-foreground">
          {attached.length} attached
        </span>
      </div>

      {/* Existing tag chips */}
      {attached.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {attached.map((t) => (
            <span
              key={t.id}
              className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
            >
              <span>{t.name}</span>
              {typeof t.cut_percent === "number" && t.cut_percent > 0 && (
                <span className="text-[10px] opacity-75">
                  −{t.cut_percent}%
                </span>
              )}
              <button
                type="button"
                onClick={() => detach(t.id)}
                disabled={busy}
                className="ml-0.5 text-primary/70 hover:text-primary"
                aria-label={`Remove tag ${t.name}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : (
        <div className="text-[11px] italic text-muted-foreground">
          No tags yet
        </div>
      )}

      {/* Add-tag input */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Type tag name (e.g. Freedom CMS)"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              attachByName();
            }
          }}
          className="h-7 flex-1 min-w-[160px] text-xs"
          disabled={busy}
        />
        <Input
          value={cutInput}
          onChange={(e) => setCutInput(e.target.value)}
          placeholder="cut %"
          type="number"
          min={0}
          max={100}
          className="h-7 w-20 text-xs"
          disabled={busy}
          title="Optional revenue cut % the tag deducts (0-100)"
        />
        <Button
          type="button"
          size="sm"
          onClick={attachByName}
          disabled={busy || !name.trim()}
          className="h-7 text-xs"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : "Add"}
        </Button>
      </div>

      {/* Suggestions from existing tags (only when typing or panel
          is empty enough to encourage reuse). */}
      {suggestions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] text-muted-foreground">
            Existing:
          </span>
          {suggestions.slice(0, 12).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => attachExisting(t.id)}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] hover:bg-accent"
            >
              <span>{t.name}</span>
              {typeof t.cut_percent === "number" && t.cut_percent > 0 && (
                <span className="text-[10px] opacity-75">−{t.cut_percent}%</span>
              )}
            </button>
          ))}
        </div>
      )}

      {err && (
        <div className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          {err}
        </div>
      )}
    </div>
  );
}
