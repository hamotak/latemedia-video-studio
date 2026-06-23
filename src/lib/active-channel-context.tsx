"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

export type StudioChannel = {
  id: number;
  display_order: number;
  name: string;
  handle: string | null;
  youtube_channel_id: string | null;
  avatar_url: string | null;
  description: string | null;
  subscriber_count: number | null;
  video_count: number | null;
};

export type ChannelFeatures = Record<string, boolean>;
export type RolePermissions = Record<string, "none" | "view" | "edit">;

type ActiveChannelCtx = {
  channels: StudioChannel[];
  activeChannel: StudioChannel | null;
  activeChannelId: number | null;
  features: ChannelFeatures;
  permissions: RolePermissions;
  /** True only during the very first fetch — never goes back to true after that. */
  loading: boolean;
  switchChannel: (id: number) => Promise<void>;
  refresh: () => Promise<void>;
};

const Ctx = createContext<ActiveChannelCtx | null>(null);

export function ActiveChannelProvider({ children }: { children: React.ReactNode }) {
  const [channels, setChannels] = useState<StudioChannel[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<number | null>(null);
  const [features, setFeatures] = useState<ChannelFeatures>({});
  const [permissions, setPermissions] = useState<RolePermissions>({});
  // Starts true, becomes false after the first successful fetch and stays false.
  const [loading, setLoading] = useState(true);

  // Full refresh — fetches channel list + active state in parallel.
  // Never sets loading back to true; the switcher stays visible during refreshes.
  const refresh = useCallback(async () => {
    try {
      const [cRes, aRes] = await Promise.all([
        fetch("/api/studio/channels", { cache: "no-store" }),
        fetch("/api/studio/active-channel", { cache: "no-store" }),
      ]);
      const cData = cRes.ok ? await cRes.json() : { channels: [] };
      const aData = aRes.ok ? await aRes.json() : { activeChannelId: null, features: {}, permissions: {} };
      setChannels(cData.channels ?? []);
      setActiveChannelId(aData.activeChannelId ?? null);
      setFeatures(aData.features ?? {});
      setPermissions(aData.permissions ?? {});
    } catch {
      // Keep existing data on network error
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const onChannelsReordered = () => { void refresh(); };
    window.addEventListener("studio-channels-reordered", onChannelsReordered);
    return () => window.removeEventListener("studio-channels-reordered", onChannelsReordered);
  }, [refresh]);

  // Switch active channel. Keep the client view aligned with server-persisted
  // active-channel state so channel-scoped API reads never race against an
  // optimistic local channel id.
  const switchChannel = useCallback(async (id: number) => {
    try {
      const res = await fetch("/api/studio/active-channel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId: id }),
      });
      if (res.ok) {
        const data = await res.json() as {
          activeChannelId?: number | null;
          features?: ChannelFeatures;
          permissions?: RolePermissions;
        };
        setActiveChannelId(data.activeChannelId ?? id);
        if (data.features) setFeatures(data.features);
        if (data.permissions) setPermissions(data.permissions);
        window.dispatchEvent(new CustomEvent("studio-channel-changed", { detail: { channelId: data.activeChannelId ?? id } }));
      } else {
        const data = await res.json().catch(() => ({}));
        void refresh();
        throw new Error(
          data && typeof data === "object" && "error" in data && typeof data.error === "string"
            ? data.error
            : `Could not switch channel (${res.status})`
        );
      }
    } catch (error) {
      void refresh();
      throw error instanceof Error ? error : new Error("Could not switch channel.");
    }
  }, [refresh]);

  const activeChannel = channels.find((c) => c.id === activeChannelId) ?? null;

  return (
    <Ctx.Provider value={{ channels, activeChannel, activeChannelId, features, permissions, loading, switchChannel, refresh }}>
      {children}
    </Ctx.Provider>
  );
}

export function useActiveChannel(): ActiveChannelCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useActiveChannel must be used within ActiveChannelProvider");
  return ctx;
}
