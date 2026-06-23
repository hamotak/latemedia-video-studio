"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clapperboard,
  Clock3,
  ExternalLink,
  Film,
  FileText,
  FolderCheck,
  ImageIcon,
  Loader2,
  Lock,
  Music2,
  Settings,
  Tv2,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  UploadCloud,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useActiveChannel } from "@/lib/active-channel-context";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { Textarea } from "@/components/ui/textarea";
import { VideoWorkspaceTabs } from "@/components/video-workspace-tabs";
import { StudioCommandBar } from "@/components/studio-command-bar";
import { cn } from "@/lib/utils";
import { estimateScript } from "@/lib/video-engine/script-estimate";
import { getStudioSidebarOffset, STUDIO_SIDEBAR_TOGGLE_EVENT } from "@/lib/studio-sidebar-offset";

type Run = {
  id: string;
  title: string | null;
  folder_name: string | null;
  status: string;
  created_at: string;
  updated_at?: string | null;
  output_path: string | null;
  db_status?: string;
  preset_name?: string | null;
  worker_active?: boolean;
  needs_recovery?: boolean;
  needs_repair?: boolean;
  mode?: string | null;
};

const MODES = [
  { value: "hybrid", label: "Hybrid", description: "Fresh opening, Drive B-roll tail.", icon: FolderCheck },
  { value: "image", label: "Image cut", description: "Fresh intro, generated image-card tail.", icon: ImageIcon },
] as const satisfies readonly {
  value: "hybrid" | "image";
  label: string;
  description: string;
  icon: LucideIcon;
}[];

type Mode = (typeof MODES)[number]["value"];
const INTRO_MINUTE_OPTIONS = [1, 3, 5] as const;
type IntroMinutes = (typeof INTRO_MINUTE_OPTIONS)[number];

type ActiveProfile = {
  presetId: number;
  channelId: number;
  channelName: string | null;
  profileName: string | null;
  stylePresetId: string | null;
  videoStyle: string | null;
  videoModel: string | null;
  aspectRatio: string | null;
  voiceProvider: string | null;
  voiceId: string | null;
  stockFolder: string | null;
  hybridFreshMinutes: number | null;
};

function videoStudioRoute(runId?: string | null) {
  return runId ? `/studio/video?runId=${encodeURIComponent(runId)}` : "/studio/video";
}

function replaceVideoRoute(runId?: string | null) {
  if (typeof window === "undefined") return;
  window.history.replaceState(null, "", videoStudioRoute(runId));
}

const RUN_STATUS_COLOR: Record<string, string> = {
  running: "#0ea5e9",
  pending: "#64748b",
  paused: "#f59e0b",
  done: "#22c55e",
  completed: "#22c55e",
  error: "#f43f5e",
  failed: "#f43f5e",
};

export default function StudioVideoPage() {
  const { activeChannel, features, permissions, loading } = useActiveChannel();

  if (loading) {
    return <VideoWorkspaceLoadingShell />;
  }

  if (!activeChannel) {
    return (
      <Centered icon={<Tv2 className="h-8 w-8 text-muted-foreground/40" />} title="No channel selected">
        Pick a channel from the switcher to open Video.
      </Centered>
    );
  }

  const canEditVideo = !!features.video && (permissions.video ?? "none") === "edit";
  if (!canEditVideo) {
    return (
      <Centered icon={<Lock className="h-8 w-8 text-muted-foreground/40" />} title="Video editing isn’t enabled for you on this channel">
        Ask an admin to grant the <span className="font-medium">Video Editing</span> feature for {activeChannel.name}.
      </Centered>
    );
  }

  // Key by channel id so the studio fully resets when the channel switches.
  return <VideoStudio key={activeChannel.id} channelId={activeChannel.id} />;
}

function Centered({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-md pt-16 text-center">
      <div className="mx-auto mb-3 flex justify-center">{icon}</div>
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{children}</p>
    </div>
  );
}

function VideoWorkspaceLoadingShell() {
  return (
    <PageContainer className="max-w-[1440px] space-y-5">
      <PageHeader
        title="Video"
        action={
          <div className="flex items-center gap-2">
            <div className="h-8 w-20 animate-pulse rounded-md bg-muted/45" />
            <div className="h-8 w-24 animate-pulse rounded-md bg-muted/45" />
          </div>
        }
      />
      <VideoWorkspaceTabs />
      <section className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/10 px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Clapperboard className="h-4 w-4" />
            </span>
            <h2 className="text-base font-semibold tracking-tight">New video</h2>
          </div>
          <Button disabled className="shrink-0">
            <Loader2 className="h-4 w-4 animate-spin" />
            Start render
          </Button>
        </div>
        <div className="space-y-4 p-5">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="h-11 animate-pulse rounded-md bg-muted/40" />
            <div className="grid grid-cols-2 gap-1.5 rounded-lg border border-border bg-background/50 p-1.5">
              {Array.from({ length: 2 }).map((_, index) => (
                <div key={index} className="h-10 animate-pulse rounded-md bg-muted/35" />
              ))}
            </div>
          </div>
          <div className="h-[240px] animate-pulse rounded-md bg-muted/35" />
          <div className="h-24 animate-pulse rounded-lg border border-border bg-background/45" />
        </div>
      </section>
    </PageContainer>
  );
}

function VideoStudio({ channelId }: { channelId: number }) {
  const [profile, setProfile] = useState<ActiveProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [runs, setRuns] = useState<Run[]>([]);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [script, setScript] = useState("");
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<Mode>("hybrid");
  const [introMinutes, setIntroMinutes] = useState<IntroMinutes>(1);
  // Apply the channel profile's saved value exactly once so the selector starts
  // at 1m and never bounces (3→1→3) while the profile loads.
  const introApplied = useRef(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [historyOverlayMode, setHistoryOverlayMode] = useState(true);
  const [historyOverlayOpen, setHistoryOverlayOpen] = useState(false);
  const [historyOverlayLeft, setHistoryOverlayLeft] = useState(0);

  const selectRun = useCallback((id: string | null) => {
    setOpenRunId(id);
    setError("");
    replaceVideoRoute(id);
  }, []);

  const updateScript = useCallback((value: string) => {
    setScript(value);
    setError("");
  }, []);

  const updateTitle = useCallback((value: string) => {
    setTitle(value);
    setError("");
  }, []);

  const updateMode = useCallback((value: Mode) => {
    setMode(value);
    setError("");
  }, []);

  const loadProfile = useCallback(async () => {
    setProfileLoading(true);
    try {
      const params = new URLSearchParams({ channelId: String(channelId) });
      const res = await fetch(`/api/video/active-profile?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) { setProfile(null); return; }
      const data = await res.json().catch(() => null);
      setProfile(data?.profile ?? null);
    } catch {
      setProfile(null);
    } finally {
      setProfileLoading(false);
    }
  }, [channelId]);

  const loadRuns = useCallback(async (presetId: number | null | undefined) => {
    if (!presetId) {
      setRuns([]);
      return;
    }
    try {
      const params = new URLSearchParams({
        channelId: String(channelId),
        presetId: String(presetId),
      });
      const res = await fetch(`/api/video/runs?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json().catch(() => []);
      setRuns(Array.isArray(data) ? (data as Run[]) : []);
    } catch {
      // The dev server can briefly drop connections during rebuild/restart.
      // Keep the current run list instead of letting React show a runtime overlay.
    }
  }, [channelId]);

  useEffect(() => { void loadProfile(); }, [loadProfile]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const syncFromUrl = () => {
      const id = new URLSearchParams(window.location.search).get("runId");
      setOpenRunId(id && id.trim() ? id : null);
    };
    syncFromUrl();
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, []);

  useEffect(() => {
    if (profileLoading) return;
    void loadRuns(profile?.presetId ?? null);
  }, [profileLoading, profile?.presetId, loadRuns]);

  useEffect(() => {
    if (!profile || introApplied.current) return;
    introApplied.current = true;
    setIntroMinutes(coerceIntroMinutes(profile.hybridFreshMinutes));
  }, [profile?.presetId, profile?.hybridFreshMinutes]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 1279.98px)");
    const sync = () => {
      setHistoryOverlayMode(mq.matches);
      if (!mq.matches) setHistoryOverlayOpen(false);
      setHistoryOverlayLeft(getStudioSidebarOffset());
    };
    const onSidebarToggle = () => window.setTimeout(sync, 0);
    sync();
    mq.addEventListener("change", sync);
    window.addEventListener("resize", sync);
    window.addEventListener(STUDIO_SIDEBAR_TOGGLE_EVENT, onSidebarToggle);
    return () => {
      mq.removeEventListener("change", sync);
      window.removeEventListener("resize", sync);
      window.removeEventListener(STUDIO_SIDEBAR_TOGGLE_EVENT, onSidebarToggle);
    };
  }, []);

  useEffect(() => {
    const anyActive = runs.some((r) => r.status === "running" || r.status === "pending");
    if (!anyActive || !profile?.presetId) return;
    const presetId = profile.presetId;
    const t = setInterval(() => { void loadRuns(presetId); }, 4000);
    return () => clearInterval(t);
  }, [runs, profile?.presetId, loadRuns]);

  const startRun = async () => {
    setError("");
    const presetId = profile?.presetId ?? null;
    if (!script.trim()) { setError("Paste a script first."); return; }
    if (!presetId) { setError("This channel has no production profile yet."); return; }
    setStarting(true);
    try {
      const res = await fetch("/api/video/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          script: script.trim(),
          title: title.trim() || null,
          presetId,
          channelId,
          mode,
          hybridFreshMinutes: mode === "hybrid" || mode === "image" ? introMinutes : undefined,
          autoReuse: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Failed to start"); return; }
      setScript(""); setTitle("");
      await loadRuns(presetId);
      if (typeof data.id === "string") selectRun(data.id);
    } catch {
      setError("Could not reach the video backend. Check that the local app server is still running, then try again.");
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="-mx-6 -mb-6 -mt-20 flex h-[calc(100vh-3.5rem)]">
      {historyOverlayMode && historyOverlayOpen && (
        <button
          aria-label="Close history"
          type="button"
          onClick={() => setHistoryOverlayOpen(false)}
          className="fixed inset-y-0 right-0 z-30 bg-black/40"
          style={{ left: historyOverlayLeft }}
        />
      )}
      <VideoHistoryRail
        runs={runs}
        loading={profileLoading}
        selectedId={openRunId}
        overlayMode={historyOverlayMode}
        overlayOpen={historyOverlayOpen}
        overlayLeft={historyOverlayLeft}
        onSelect={(id) => {
          selectRun(id);
          if (historyOverlayMode) setHistoryOverlayOpen(false);
        }}
      />

      <main className="flex-1 overflow-y-auto">
        <PageContainer className="max-w-[1440px] space-y-5 pb-10 pt-20">
          <PageHeader title="Video" />
          <StudioCommandBar
            showHistory={historyOverlayMode}
            onHistoryClick={() => setHistoryOverlayOpen(true)}
            actions={
              <div className="flex max-w-[860px] flex-wrap items-center justify-end gap-2">
                {openRunId && (
                  <Button type="button" variant="outline" size="sm" onClick={() => selectRun(null)} className="h-8 gap-1.5">
                    <Clapperboard className="h-3.5 w-3.5" />
                    New video
                  </Button>
                )}
                <VideoHeaderActions
                  runs={runs}
                  onRefresh={() => void loadRuns(profile?.presetId ?? null)}
                  onOpen={selectRun}
                />
              </div>
            }
          />

          <VideoWorkspaceTabs />

          {openRunId ? (
            <VideoRunDetailPage
              runId={openRunId}
              onBackToNew={() => selectRun(null)}
              onRunChanged={() => void loadRuns(profile?.presetId ?? null)}
              onDeleted={() => { selectRun(null); void loadRuns(profile?.presetId ?? null); }}
            />
          ) : (
            <VideoComposer
              mode={mode}
              introMinutes={introMinutes}
              title={title}
              script={script}
              error={error}
              disabled={starting || profileLoading || !profile?.presetId}
              busy={starting || profileLoading}
              onModeChange={updateMode}
              onIntroMinutesChange={setIntroMinutes}
              onTitleChange={updateTitle}
              onScriptChange={updateScript}
              onStart={startRun}
            />
          )}
        </PageContainer>
      </main>
    </div>
  );
}

type LogEntry = { ts: string; level: string; stage?: string | null; message: string };
type RunFull = {
  id: string;
  title: string | null;
  folder_name: string | null;
  status: string;
  created_at?: string | null;
  updated_at?: string | null;
  output_path: string | null;
  finalVideoLink?: string | null;
  clipsFolderLink?: string | null;
  worker_active?: boolean;
  needs_recovery?: boolean;
  driveStatus?: {
    synced?: boolean;
    syncedAt?: string | null;
    finalVideoId?: string | null;
    clipsFolderId?: string | null;
  };
};
type SceneStage = "pending" | "audio" | "image" | "video" | "rendered";
type RunAssetFile = { name: string; size: number };
type SceneAsset = {
  index: number;
  text?: string;
  visual_prompt?: string;
  duration_hint_sec?: number;
  source_kind?: "fresh" | "stock" | "image_card";
  stage: SceneStage;
  audio?: RunAssetFile;
  image?: RunAssetFile;
  animation?: RunAssetFile;
  clip?: RunAssetFile;
};
type RunAssets = {
  scenes: SceneAsset[];
  freshScenes?: SceneAsset[];
  planReady?: boolean;
  tailKnown?: boolean;
  planSceneCount?: number;
  stockSceneCount?: number;
  imageTailSceneCount?: number;
  freshSceneCount?: number;
  finalExists?: boolean;
  finalSize?: number;
  finalOnDisk?: boolean;
  finalNeedsRepair?: boolean;
  mode?: string;
  runtimeStatus?: string;
  workerActive?: boolean;
  activeProviderJobs?: unknown[];
  progress?: {
    total: number;
    rendered: number;
    withVideo: number;
    withAudio: number;
  };
  hybridProgress?: {
    freshTotal: number;
    freshWithVideo: number;
    freshRendered: number;
    stockSceneCount: number;
  } | null;
  tail?: {
    voiceoverReady?: boolean;
    segmentReady?: boolean;
    renderedClipCount?: number;
    normalizedCacheReadyCount?: number;
    normalizedCacheMissCount?: number;
    normalizedCacheBadCount?: number;
    tailRenderedDurationSec?: number;
    tailTargetDurationSec?: number;
    tailPickedClipCount?: number;
    buildingTail?: boolean;
    joiningFinal?: boolean;
  };
  recovery?: {
    paused?: boolean;
    canResume?: boolean;
    finalReady?: boolean;
    nextAction?: string;
  };
};

function coerceIntroMinutes(value: number | null | undefined): IntroMinutes {
  const n = Number(value);
  if (!Number.isFinite(n)) return 3;
  if (n <= 1) return 1;
  if (n <= 3) return 3;
  return 5;
}

function isActionableIssueRun(run: Run): boolean {
  return run.status === "paused" || !!run.needs_recovery || !!run.needs_repair;
}

function VideoHeaderActions({
  runs,
  onRefresh,
  onOpen,
}: {
  runs: Run[];
  onRefresh: () => void;
  onOpen: (id: string) => void;
}) {
  const running = runs.find((run) => run.status === "running") ?? null;
  const pending = runs.filter((run) => run.status === "pending");
  const active = running ?? pending[0] ?? null;
  const actionableIssues = runs.filter(isActionableIssueRun);

  return (
    <div className="flex max-w-[760px] flex-wrap items-center justify-end gap-2">
      <button
        type="button"
        onClick={() => active && onOpen(active.id)}
        disabled={!active}
        className={cn(
          "inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs font-medium transition-colors",
          active
            ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300"
            : "cursor-default border-border bg-muted/30 text-muted-foreground"
        )}
      >
        <span
          className={cn(
            "h-2 w-2 rounded-full",
            active ? "bg-emerald-500 shadow-[0_0_0_3px_rgba(34,197,94,0.15)]" : "bg-muted-foreground/40"
          )}
        />
        {active ? (running ? "Active" : "Queued next") : "Idle"}
      </button>

      <span className="inline-flex h-8 items-center gap-2 rounded-md border border-border bg-background px-3 text-xs font-medium text-muted-foreground">
        <Clock3 className="h-3.5 w-3.5" />
        Queued {pending.length}
      </span>

      {actionableIssues.length > 0 && (
        <button
          type="button"
          onClick={() => onOpen(actionableIssues[0].id)}
          className="inline-flex h-8 items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-500/15 dark:text-amber-300"
        >
          <AlertTriangle className="h-3.5 w-3.5" />
          Review {actionableIssues.length}
        </button>
      )}

      <Button type="button" variant="outline" size="sm" onClick={onRefresh} className="h-8 gap-1.5">
        <RefreshCw className="h-3.5 w-3.5" />
        Refresh
      </Button>
      <Link href="/admin/settings/video" className={buttonVariants({ variant: "outline", size: "sm" })}>
        <Settings className="h-3.5 w-3.5" />
        Settings
      </Link>
    </div>
  );
}

function VideoHistoryRail({
  runs,
  loading,
  selectedId,
  overlayMode,
  overlayOpen,
  overlayLeft,
  onSelect,
}: {
  runs: Run[];
  loading: boolean;
  selectedId: string | null;
  overlayMode: boolean;
  overlayOpen: boolean;
  overlayLeft: number;
  onSelect: (id: string) => void;
}) {
  const overlayClosed = overlayMode && !overlayOpen;

  return (
    <aside
      className={cn(
        "flex w-60 shrink-0 flex-col overflow-y-auto border-r border-border bg-background/40",
        overlayMode ? "studio-history-rail fixed inset-y-0 z-40 bg-background" : "",
        overlayClosed && "pointer-events-none"
      )}
      data-open={overlayOpen ? "true" : "false"}
      data-sidebar-offset={overlayLeft}
      aria-hidden={overlayClosed}
      inert={overlayClosed ? true : undefined}
    >
      <div className="px-4 py-5">
        <h2 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">History</h2>
      </div>
      {loading ? (
        <p className="px-4 text-xs text-muted-foreground">Loading...</p>
      ) : runs.length === 0 ? (
        <p className="px-4 text-xs text-muted-foreground">No video history yet.</p>
      ) : (
        <>
          <div className="px-3 pb-2">
            <button
              type="button"
              onClick={() => onSelect(runs[0].id)}
              className="flex w-full items-center justify-between rounded-md border border-border bg-muted/25 px-3 py-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-accent/50"
            >
              <span>Latest run</span>
              <span className="text-muted-foreground">{relativeRunTime(runs[0].created_at)}</span>
            </button>
          </div>
          <ul>
            {runs.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  onClick={() => onSelect(run.id)}
                  className={cn(
                    "block w-full px-4 py-3 text-left text-sm transition-colors hover:bg-accent/40",
                    selectedId === run.id && "bg-accent/60"
                  )}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="line-clamp-1 text-foreground">{runTitle(run)}</span>
                    <RunStatusPill run={run} />
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>{formatModeLabel(run.mode)}</span>
                    <span>{relativeRunTime(run.created_at)}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}

function VideoComposer({
  mode,
  introMinutes,
  title,
  script,
  error,
  disabled,
  busy,
  onModeChange,
  onIntroMinutesChange,
  onTitleChange,
  onScriptChange,
  onStart,
}: {
  mode: Mode;
  introMinutes: IntroMinutes;
  title: string;
  script: string;
  error: string;
  disabled: boolean;
  busy: boolean;
  onModeChange: (mode: Mode) => void;
  onIntroMinutesChange: (minutes: IntroMinutes) => void;
  onTitleChange: (value: string) => void;
  onScriptChange: (value: string) => void;
  onStart: () => void;
}) {
  const words = countWords(script);
  const scriptEstimate = estimateScript(words);
  const showFreshIntro = mode === "hybrid" || mode === "image";

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/10 px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Clapperboard className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold tracking-tight">New video</h2>
          </div>
        </div>
        <Button onClick={onStart} disabled={disabled} className="shrink-0">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          Start render
        </Button>
      </div>

      <div className="space-y-5 p-5">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-1.5">
            <Label htmlFor="video-title" className="text-xs uppercase tracking-wide text-muted-foreground">
              Title
            </Label>
            <Input
              id="video-title"
              value={title}
              onChange={(e) => onTitleChange(e.target.value)}
              placeholder="Optional video title"
              className="h-11 text-base"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Mode</Label>
            <div className="grid grid-cols-2 gap-1.5 rounded-lg border border-border bg-background/50 p-1.5">
              {MODES.map((item) => {
                const Icon = item.icon;
                const active = item.value === mode;
                return (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => onModeChange(item.value)}
                    disabled={disabled}
                    className={cn(
                      "grid min-h-[66px] grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors",
                      active
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                      disabled && "cursor-not-allowed opacity-60"
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-7 w-7 items-center justify-center rounded-md",
                        active ? "bg-primary-foreground/15" : "bg-muted/70"
                      )}
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold">{item.label}</span>
                      <span className={cn("line-clamp-2 text-[11px] leading-snug", active ? "text-primary-foreground/75" : "text-muted-foreground")}>
                        {item.description}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {showFreshIntro && (
          <div className="max-w-sm space-y-1.5">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Fresh intro</Label>
            <div className="grid grid-cols-3 gap-1.5 rounded-lg border border-border bg-background/50 p-1.5">
              {INTRO_MINUTE_OPTIONS.map((minutes) => {
                const active = introMinutes === minutes;
                return (
                  <button
                    key={minutes}
                    type="button"
                    onClick={() => onIntroMinutesChange(minutes)}
                    disabled={disabled}
                    className={cn(
                      "min-h-10 rounded-md px-2 py-2 text-center text-sm font-medium transition-colors",
                      active
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                      disabled && "cursor-not-allowed opacity-60"
                    )}
                  >
                    {minutes}m
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label htmlFor="video-script" className="text-xs uppercase tracking-wide text-muted-foreground">
              Script
            </Label>
            <span className="text-xs text-muted-foreground">
              {words > 0 ? `${scriptEstimate.durationLabel} · ${words.toLocaleString()} words` : "0 words"}
            </span>
          </div>
          <Textarea
            id="video-script"
            value={script}
            onChange={(e) => onScriptChange(e.target.value)}
            placeholder="Paste the full narration script..."
            rows={10}
            className="min-h-[220px] resize-y text-sm leading-relaxed lg:min-h-[260px]"
          />
        </div>

        {error && (
          <div className="rounded-md border border-destructive/35 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

      </div>
    </section>
  );
}

function countWords(value: string): number {
  return value.trim().match(/\S+/g)?.length ?? 0;
}

function RunStatusPill({ run }: { run: Run }) {
  const attention = run.needs_repair || run.needs_recovery || run.status === "paused";
  const color = attention ? "#f59e0b" : RUN_STATUS_COLOR[run.status] ?? "#64748b";
  const label = run.needs_repair ? "repair" : run.needs_recovery ? "review" : run.status;
  return (
    <span className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ backgroundColor: `${color}20`, color }}>
      {label}
    </span>
  );
}

function runTitle(run: Run): string {
  return run.title || run.folder_name || run.id.slice(0, 8);
}

function parseRunTimestamp(value: string): Date {
  const clean = value.trim();
  const sqliteUtc = clean.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)?$/);
  return new Date(sqliteUtc ? `${sqliteUtc[1]}T${sqliteUtc[2]}Z` : clean);
}

function formatRunTime(value: string): string {
  const date = parseRunTimestamp(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function relativeRunTime(value: string): string {
  const date = parseRunTimestamp(value);
  const diffMs = Date.now() - date.getTime();
  if (!Number.isFinite(diffMs)) return formatRunTime(value);
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function formatModeLabel(value?: string | null): string {
  if (value === "full") return "Full";
  if (value === "hybrid") return "Hybrid";
  if (value === "stock") return "Stock";
  if (value === "image") return "Image cut";
  return "Mode n/a";
}

const LOG_COLOR: Record<string, string> = {
  error: "#f43f5e",
  warn: "#f59e0b",
  success: "#22c55e",
};

function VideoRunDetailPage({
  runId,
  onBackToNew,
  onRunChanged,
  onDeleted,
}: {
  runId: string;
  onBackToNew: () => void;
  onRunChanged: () => void;
  onDeleted: () => void;
}) {
  const [run, setRun] = useState<RunFull | null>(null);
  const [assets, setAssets] = useState<RunAssets | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailError, setDetailError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionBusy, setActionBusy] = useState<"sync" | "cancel" | "resume" | null>(null);

  async function parseMutationError(res: Response, fallback: string) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    return data?.error || fallback;
  }

  const load = useCallback(async () => {
    try {
      const [runRes, assetsRes] = await Promise.all([
        fetch(`/api/video/runs/${encodeURIComponent(runId)}`, { cache: "no-store" }),
        fetch(`/api/video/runs/${encodeURIComponent(runId)}/assets`, { cache: "no-store" }),
      ]);
      const runData = (await runRes.json().catch(() => null)) as { run?: RunFull | null; logs?: LogEntry[]; error?: string } | null;
      const assetsData = (await assetsRes.json().catch(() => null)) as (RunAssets & { error?: string }) | null;
      const nextErrors: string[] = [];
      if (!runRes.ok) {
        nextErrors.push(runData?.error || "Could not load run details.");
        setRun(null);
        setLogs([]);
      } else {
        setRun(runData?.run ?? null);
        setLogs(runData?.logs ?? []);
      }
      if (!assetsRes.ok) {
        nextErrors.push(assetsData?.error || "Could not load generated assets.");
        setAssets(null);
      } else {
        setAssets(assetsData);
      }
      setDetailError(nextErrors.join(" "));
    } catch {
      setDetailError("Could not reach the video backend. Check that the local app server is still running.");
      setRun(null);
      setLogs([]);
      setAssets(null);
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    setRun(null);
    setAssets(null);
    setLogs([]);
    setDetailError("");
    setLoading(true);
    setConfirmDelete(false);
    void load();
  }, [load]);

  useEffect(() => {
    const active =
      run?.status === "running" ||
      run?.status === "pending" ||
      assets?.runtimeStatus === "running" ||
      assets?.workerActive;
    if (!active) return;
    const t = setInterval(() => { void load(); }, 3000);
    return () => clearInterval(t);
  }, [assets?.runtimeStatus, assets?.workerActive, run?.status, load]);

  const del = async () => {
    setDeleting(true);
    setDetailError("");
    try {
      const res = await fetch(`/api/video/runs/${runId}`, { method: "DELETE" });
      if (!res.ok) {
        setDetailError(await parseMutationError(res, "Could not delete this render."));
        return;
      }
      onDeleted();
    } catch {
      setDetailError("Could not reach the video backend. Check that the local app server is still running.");
    } finally {
      setDeleting(false);
    }
  };

  const syncDrive = async () => {
    setActionBusy("sync");
    setDetailError("");
    try {
      const res = await fetch(`/api/video/runs/${runId}/drive`, { method: "POST" });
      if (!res.ok) {
        setDetailError(await parseMutationError(res, "Drive sync failed."));
        return;
      }
      await load();
      onRunChanged();
    } catch {
      setDetailError("Could not reach the video backend. Check that the local app server is still running.");
    } finally {
      setActionBusy(null);
    }
  };

  const cancelRun = async () => {
    setActionBusy("cancel");
    setDetailError("");
    try {
      const res = await fetch(`/api/video/runs/${runId}/cancel`, { method: "POST" });
      if (!res.ok) {
        setDetailError(await parseMutationError(res, "Could not stop this render."));
        return;
      }
      await load();
      onRunChanged();
    } catch {
      setDetailError("Could not reach the video backend. Check that the local app server is still running.");
    } finally {
      setActionBusy(null);
    }
  };

  const resumeRun = async () => {
    setActionBusy("resume");
    setDetailError("");
    try {
      const res = await fetch(`/api/video/runs/${runId}/reassemble`, { method: "POST" });
      if (!res.ok) {
        setDetailError(await parseMutationError(res, "Could not resume this render."));
        return;
      }
      await load();
      onRunChanged();
    } catch {
      setDetailError("Could not reach the video backend. Check that the local app server is still running.");
    } finally {
      setActionBusy(null);
    }
  };

  const color = RUN_STATUS_COLOR[run?.status ?? ""] ?? "#64748b";
  const mode = assets?.mode ?? "unknown";
  const executableMode = mode === "hybrid" || mode === "image";
  const title = run?.title || run?.folder_name || runId.slice(0, 8);
  const canStop = run?.status === "running" || run?.status === "pending" || run?.worker_active || assets?.workerActive;
  const canResume = executableMode && (!!assets?.recovery?.canResume || run?.needs_recovery || run?.status === "paused" || run?.status === "error");

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-border bg-card shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border bg-muted/10 px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Film className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h2 className="truncate text-base font-semibold tracking-tight">{title}</h2>
                {run && (
                  <span className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ backgroundColor: `${color}20`, color }}>
                    {run.status}
                  </span>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{formatModeLabel(mode)}</span>
                {run?.created_at && <span>{relativeRunTime(run.created_at)}</span>}
                {assets?.planSceneCount != null && <span>{assets.planSceneCount} scenes</span>}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={onBackToNew}>
              <Clapperboard className="h-3.5 w-3.5" />
              New video
            </Button>
            {canStop && (
              <Button variant="outline" size="sm" className="h-8 text-xs" onClick={cancelRun} disabled={actionBusy != null}>
                {actionBusy === "cancel" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
                Stop
              </Button>
            )}
            {canResume && (
              <Button variant="outline" size="sm" className="h-8 text-xs" onClick={resumeRun} disabled={actionBusy != null}>
                {actionBusy === "resume" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                Resume
              </Button>
            )}
            {run?.output_path && (
              <Button variant="outline" size="sm" className="h-8 text-xs" onClick={syncDrive} disabled={actionBusy != null}>
                {actionBusy === "sync" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UploadCloud className="h-3.5 w-3.5" />}
                Sync
              </Button>
            )}
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={load}>
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </Button>
          </div>
        </div>

        <div className="space-y-4 p-5">
          {detailError && (
            <div className="rounded-md border border-destructive/35 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {detailError}
            </div>
          )}

          {loading ? (
            <VideoRunLoadingState />
          ) : (
            <>
              <RunPreview runId={runId} run={run} assets={assets} />
              {assets && <RunAssetSections runId={runId} assets={assets} />}
              {run && (run.finalVideoLink || run.clipsFolderLink || run.driveStatus?.synced) && (
                <DriveLinks run={run} mode={assets?.mode} />
              )}
              <RunDiagnostics logs={logs} />
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-4">
          {confirmDelete ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">Delete this render?</span>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setConfirmDelete(false)}>Cancel</Button>
              <Button variant="destructive" size="sm" className="h-7 text-xs" onClick={del} disabled={deleting || canStop}>
                {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : "Delete"}
              </Button>
            </div>
          ) : (
            <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground hover:text-destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
          )}
          <span className="text-xs text-muted-foreground">
            {canStop ? "Stop this render before deleting it." : "Logs and generated files are removed when deleted."}
          </span>
        </div>
      </section>
    </div>
  );
}

function VideoRunLoadingState() {
  return (
    <div className="space-y-4">
      <div className="aspect-video animate-pulse rounded-lg bg-muted/35" />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, index) => (
          <div key={index} className="aspect-video animate-pulse rounded-md bg-muted/30" />
        ))}
      </div>
    </div>
  );
}

function RunPreview({ runId, run, assets }: { runId: string; run: RunFull | null; assets: RunAssets | null }) {
  const progress = assets?.progress;
  const status = assets?.runtimeStatus ?? run?.status ?? "loading";
  const finalReady = !!assets?.finalExists;

  return (
    <section className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_320px]">
      <div className="overflow-hidden rounded-lg border border-border bg-background">
        {finalReady ? (
          <video
            src={runFileUrl(runId, "final.mp4")}
            poster={runFileUrl(runId, "final-poster.jpg")}
            controls
            preload="metadata"
            className="aspect-video w-full bg-black object-contain"
          />
        ) : (
          <div className="flex aspect-video items-center justify-center bg-muted/20">
            <div className="text-center">
              {status === "running" ? (
                <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
              ) : (
                <Film className="mx-auto h-6 w-6 text-muted-foreground/50" />
              )}
              <p className="mt-2 text-sm font-medium">{status === "running" ? "Rendering" : "Final not ready"}</p>
              {progress && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {progress.rendered}/{progress.total} scenes rendered
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="grid content-start gap-3">
        <ProgressMetric
          icon={<CheckCircle2 className="h-4 w-4" />}
          label="Rendered"
          value={progress ? `${progress.rendered}/${progress.total}` : "0/0"}
        />
        <ProgressMetric
          icon={<Film className="h-4 w-4" />}
          label="Video"
          value={progress ? `${progress.withVideo}/${progress.total}` : "0/0"}
        />
        <ProgressMetric
          icon={<Music2 className="h-4 w-4" />}
          label="Audio"
          value={progress ? `${progress.withAudio}/${progress.total}` : "0/0"}
        />
        <ProgressMetric
          icon={<FolderCheck className="h-4 w-4" />}
          label="Final"
          value={finalReady ? formatBytes(assets?.finalSize ?? 0) : status}
        />
      </div>
    </section>
  );
}

function ProgressMetric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-border bg-background px-3 py-2.5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="truncate text-sm font-semibold">{value}</p>
      </div>
    </div>
  );
}

function RunAssetSections({ runId, assets }: { runId: string; assets: RunAssets }) {
  const mode = assets.mode;
  const scenes = assets.scenes ?? [];
  const freshScenes = assets.freshScenes?.length ? assets.freshScenes : scenes.filter((scene) => scene.index < (assets.freshSceneCount ?? scenes.length));

  if (mode === "hybrid") {
    return (
      <div className="space-y-5">
        <SceneGrid runId={runId} title="Fresh intro" scenes={freshScenes} emptyText={assets.planReady ? "No fresh intro scenes yet." : "Planning fresh intro scenes."} />
      </div>
    );
  }

  if (mode === "image") {
    const freshCount = assets.freshSceneCount ?? freshScenes.length;
    const tailScenes = scenes.filter((scene) => scene.index >= freshCount);
    return (
      <div className="space-y-5">
        <SceneGrid runId={runId} title="Fresh video intro" scenes={freshScenes} emptyText={assets.planReady ? "No fresh video scenes yet." : "Planning fresh video scenes."} />
        <SceneGrid runId={runId} title="Still-image tail" scenes={tailScenes} emptyText={assets.planReady ? "No tail images yet." : "Planning tail images."} />
      </div>
    );
  }

  if (mode === "stock") {
    return null;
  }

  return (
    <SceneGrid runId={runId} title="Generated scenes" scenes={scenes} emptyText={assets.planReady ? "No generated scenes yet." : "Planning generated scenes."} />
  );
}

function SceneGrid({ runId, title, scenes, emptyText }: { runId: string; title: string; scenes: SceneAsset[]; emptyText: string }) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="text-xs text-muted-foreground">{scenes.length} scenes</span>
      </div>
      {scenes.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-background/50 px-4 py-8 text-center text-sm text-muted-foreground">
          {emptyText}
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {scenes.map((scene) => (
            <SceneCard key={scene.index} runId={runId} scene={scene} />
          ))}
        </div>
      )}
    </section>
  );
}

function SceneCard({ runId, scene }: { runId: string; scene: SceneAsset }) {
  const media = sceneMedia(runId, scene);
  const poster = scene.image ? runFileUrl(runId, `images/${scene.image.name}`) : undefined;

  return (
    <article className="overflow-hidden rounded-md border border-border bg-background">
      <div className="relative aspect-video overflow-hidden bg-muted/25">
        {media?.type === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={media.url} alt={`Scene ${scene.index + 1}`} className="h-full w-full object-cover" loading="lazy" />
        ) : media?.type === "video" ? (
          <video
            src={media.url}
            poster={poster}
            muted
            playsInline
            preload="metadata"
            className="h-full w-full bg-black object-cover"
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <SceneStageIcon stage={scene.stage} />
          </div>
        )}
        <span className={cn("absolute left-2 top-2 rounded px-1.5 py-0.5 text-[10px] font-medium", sceneStageClass(scene.stage))}>
          {sceneStageLabel(scene.stage)}
        </span>
      </div>
      <div className="space-y-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold">Scene {scene.index + 1}</p>
          <div className="flex items-center gap-1 text-muted-foreground">
            {scene.audio && <Music2 className="h-3.5 w-3.5" />}
            {scene.image && <ImageIcon className="h-3.5 w-3.5" />}
            {(scene.animation || scene.clip) && <Film className="h-3.5 w-3.5" />}
          </div>
        </div>
        {(scene.text || scene.visual_prompt) && (
          <details className="group">
            <summary className="cursor-pointer list-none text-xs text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
              Details
            </summary>
            <div className="mt-2 space-y-2 text-xs leading-relaxed text-muted-foreground">
              {scene.text && <p className="line-clamp-6">{scene.text}</p>}
              {scene.visual_prompt && <p className="line-clamp-6 border-t border-border pt-2">{scene.visual_prompt}</p>}
            </div>
          </details>
        )}
      </div>
    </article>
  );
}

function SceneStageIcon({ stage }: { stage: SceneStage }) {
  if (stage === "audio") return <Music2 className="h-6 w-6 text-muted-foreground/50" />;
  if (stage === "image") return <ImageIcon className="h-6 w-6 text-muted-foreground/50" />;
  if (stage === "video" || stage === "rendered") return <Film className="h-6 w-6 text-muted-foreground/50" />;
  return <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/50" />;
}

function DriveLinks({ run, mode }: { run: RunFull; mode?: string }) {
  const clipsFolderLink = mode === "stock" ? null : run.clipsFolderLink ?? null;

  return (
    <div className="flex flex-wrap gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs">
      {run.finalVideoLink && (
        <a href={run.finalVideoLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
          <ExternalLink className="h-3.5 w-3.5" />
          Final
        </a>
      )}
      {clipsFolderLink && (
        <a href={clipsFolderLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
          <FolderCheck className="h-3.5 w-3.5" />
          Folder
        </a>
      )}
      {run.driveStatus?.syncedAt && (
        <span className="text-muted-foreground">Synced {formatRunTime(run.driveStatus.syncedAt)}</span>
      )}
    </div>
  );
}

function RunDiagnostics({ logs }: { logs: LogEntry[] }) {
  return (
    <details className="group rounded-md border border-border bg-background">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm font-medium outline-none [&::-webkit-details-marker]:hidden">
        <span className="inline-flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          Logs
        </span>
        <span className="text-xs text-muted-foreground">{logs.length}</span>
      </summary>
      <div className="max-h-[360px] overflow-y-auto border-t border-border p-3">
        {logs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No logs yet.</p>
        ) : (
          <div className="space-y-1 font-mono text-[11px] leading-relaxed">
            {logs.map((l, i) => (
              <div key={i} className="flex gap-2">
                <span className="shrink-0 text-muted-foreground/50">{new Date(l.ts).toLocaleTimeString()}</span>
                {l.stage && <span className="shrink-0 text-muted-foreground/70">[{l.stage}]</span>}
                <span style={{ color: LOG_COLOR[l.level] }}>{l.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

function runFileUrl(runId: string, rel: string): string {
  return `/api/video/runs/${encodeURIComponent(runId)}/file?p=${encodeURIComponent(rel)}`;
}

function sceneMedia(runId: string, scene: SceneAsset): { type: "image" | "video"; url: string } | null {
  if (scene.clip) return { type: "video", url: runFileUrl(runId, `clips/${scene.clip.name}`) };
  if (scene.animation) return { type: "video", url: runFileUrl(runId, `animations/${scene.animation.name}`) };
  if (scene.image) return { type: "image", url: runFileUrl(runId, `images/${scene.image.name}`) };
  return null;
}

function sceneStageLabel(stage: SceneStage): string {
  if (stage === "rendered") return "Rendered";
  if (stage === "video") return "Video";
  if (stage === "image") return "Image";
  if (stage === "audio") return "Audio";
  return "Pending";
}

function sceneStageClass(stage: SceneStage): string {
  if (stage === "rendered") return "bg-emerald-500/90 text-white";
  if (stage === "video") return "bg-sky-500/90 text-white";
  if (stage === "image") return "bg-violet-500/90 text-white";
  if (stage === "audio") return "bg-amber-500/90 text-white";
  return "bg-background/85 text-muted-foreground";
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "Ready";
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
