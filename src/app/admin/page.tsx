"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowRight,
  Clapperboard,
  GripVertical,
  Loader2,
  Plus,
  RefreshCw,
  Settings,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button";
import { AdminPageShell } from "@/components/admin-page-shell";
import { ErrorAlert } from "@/components/ui/error-alert";
import { useActiveChannel } from "@/lib/active-channel-context";
import { rememberSettingsReturn } from "@/lib/settings-return";
import { cn } from "@/lib/utils";

type ChannelSummary = {
  id: number;
  name: string;
  handle: string | null;
  avatar_url: string | null;
  subscriber_count: number | null;
  video_count: number | null;
};

type DashboardData = {
  users: { total: number; admins: number; employees: number };
  totals: {
    channels: number;
    boards: number;
    cards: number;
    ready: number;
    blocked: number;
    pendingThumbnails: number;
  };
  channels: ChannelSummary[];
};

export default function AdminPage() {
  const router = useRouter();
  const { switchChannel, refresh: refreshActiveChannels } = useActiveChannel();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [openingChannel, setOpeningChannel] = useState<number | null>(null);
  const [reordering, setReordering] = useState(false);
  const [error, setError] = useState("");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 3 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/admin/dashboard", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load dashboard.");
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load dashboard.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openChannelBoard = async (channelId: number) => {
    setOpeningChannel(channelId);
    setError("");
    try {
      await switchChannel(channelId);
      router.push("/studio/video");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open this channel board.");
    } finally {
      setOpeningChannel(null);
    }
  };

  const handleChannelDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || !data || active.id === over.id) return;

    const oldIndex = data.channels.findIndex((channel) => channel.id === active.id);
    const newIndex = data.channels.findIndex((channel) => channel.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    const previous = data;
    const nextChannels = arrayMove(data.channels, oldIndex, newIndex);
    setData({ ...data, channels: nextChannels });
    setReordering(true);
    try {
      const res = await fetch("/api/admin/channels/order", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderedChannelIds: nextChannels.map((channel) => channel.id) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to save channel order.");
      if (Array.isArray(json.channels)) {
        setData((current) => current ? { ...current, channels: json.channels } : current);
      }
      window.dispatchEvent(new Event("studio-channels-reordered"));
      void refreshActiveChannels();
    } catch (e) {
      setData(previous);
      setError(e instanceof Error ? e.message : "Failed to save channel order.");
    } finally {
      setReordering(false);
    }
  };

  return (
    <AdminPageShell
      title="Dashboard"
      action={
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          Refresh
        </Button>
      }
    >
      <div className="flex flex-col gap-5">

        <section className="grid gap-3 md:grid-cols-2">
          <Link
            href="/studio/video"
            className="group flex min-h-36 items-center justify-between rounded-xl border border-border bg-card p-6 transition hover:border-primary/50 hover:bg-muted/30"
          >
            <div>
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/15 text-primary">
                <Clapperboard className="h-5 w-5" />
              </div>
              <h2 className="mt-4 text-xl font-semibold">Studio</h2>
            </div>
            <ArrowRight className="h-5 w-5 text-muted-foreground transition group-hover:translate-x-1 group-hover:text-primary" />
          </Link>

          <Link
            href="/admin/settings/video"
            onClick={() => rememberSettingsReturn("/admin")}
            className="group flex min-h-36 items-center justify-between rounded-xl border border-border bg-card p-6 transition hover:border-primary/50 hover:bg-muted/30"
          >
            <div>
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <Settings className="h-5 w-5" />
              </div>
              <h2 className="mt-4 text-xl font-semibold">Settings</h2>
            </div>
            <ArrowRight className="h-5 w-5 text-muted-foreground transition group-hover:translate-x-1 group-hover:text-primary" />
          </Link>
        </section>

        {error && <ErrorAlert message={error} onRetry={load} />}

        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Channels</h2>
            </div>
            <Link href="/admin/channels/new" className={buttonVariants()}>
                <Plus className="h-4 w-4" />
                Add channel
            </Link>
          </div>

          {loading ? (
            <div className="flex h-44 items-center justify-center rounded-xl border border-border bg-card">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : data && data.channels.length > 0 ? (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis, restrictToParentElement]}
              onDragEnd={(event) => void handleChannelDragEnd(event)}
            >
              <SortableContext
                items={data.channels.map((channel) => channel.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className={cn("overflow-hidden rounded-xl border border-border bg-card", reordering && "cursor-wait")}>
                  {data.channels.map((channel) => (
                    <SortableChannelRow
                      key={channel.id}
                      channel={channel}
                      disabled={openingChannel === channel.id || reordering}
                      opening={openingChannel === channel.id}
                      onOpen={() => void openChannelBoard(channel.id)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          ) : (
            <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center">
              <Users className="mx-auto h-8 w-8 text-muted-foreground/50" />
              <p className="mt-3 text-sm font-medium">No channels yet</p>
            </div>
          )}
        </section>
      </div>
    </AdminPageShell>
  );
}

function SortableChannelRow({
  channel,
  disabled,
  opening,
  onOpen,
}: {
  channel: ChannelSummary;
  disabled: boolean;
  opening: boolean;
  onOpen: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
      transition,
      isDragging,
  } = useSortable({
    id: channel.id,
    disabled,
    transition: {
      duration: 90,
      easing: "cubic-bezier(0.2, 0, 0, 1)",
    },
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? undefined : transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group flex w-full items-center gap-2 border-b border-border bg-card px-3 py-3 text-left transition last:border-b-0 hover:bg-muted/30",
        isDragging && "relative z-10 shadow-lg ring-1 ring-primary/35"
      )}
    >
      <button
        type="button"
        className="flex h-8 w-8 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground active:cursor-grabbing"
        style={{ touchAction: "none" }}
        aria-label={`Drag ${channel.name}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onOpen}
        disabled={disabled && !isDragging}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left disabled:opacity-70"
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
        {opening ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <ArrowRight className="h-4 w-4 text-muted-foreground/50 transition group-hover:translate-x-0.5 group-hover:text-primary" />
        )}
      </button>
    </div>
  );
}
