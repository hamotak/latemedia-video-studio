"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ExternalLink,
  HardDrive,
  ImageIcon,
  Loader2,
  Lock,
  Play,
  RefreshCw,
  Square,
  Trash2,
  Tv2,
  UploadCloud,
  Wrench,
} from "lucide-react";
import { useActiveChannel } from "@/lib/active-channel-context";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { VideoWorkspaceTabs } from "@/components/video-workspace-tabs";
import { VideoWorkspaceShell } from "@/components/video-workspace-shell";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/utils";

interface StockClip {
  driveFileId: string;
  name: string;
  source?: "drive" | "local";
  createdTime?: string | null;
  modifiedTime?: string | null;
  previewFileId?: string;
  displayName?: string;
  jobId?: string;
  index?: number;
  prompt?: string;
  reviewStatus?: "unreviewed" | "good" | "weak" | "needs_review";
  driveFileLink?: string | null;
}

interface StockListResponse {
  folder: string | null;
  cacheFolder?: string | null;
  count: number;
  clips: StockClip[];
  driveFolderLink?: string | null;
  message?: string | null;
  detail?: string | null;
  errorKind?: string | null;
  connectedEmail?: string | null;
}

interface StockGenClipStep {
  index: number;
  prompt: string;
  finalPrompt?: string;
  promptSource?: "exact" | "ai";
  status: "queued" | "image" | "video" | "upload" | "complete" | "failed" | "cancelled" | "deleted";
  imageStatus?: "queued" | "running" | "done" | "failed";
  videoStatus?: "queued" | "running" | "done" | "failed";
  uploadStatus?: "queued" | "running" | "done" | "failed";
  driveFileId?: string;
  driveName?: string;
  driveFileLink?: string | null;
  displayName?: string;
  imageUrl?: string;
  posterUrl?: string;
  videoUrl?: string;
  reviewStatus?: "unreviewed" | "good" | "weak" | "needs_review";
  retryCount?: number;
  error?: string;
}

interface StockGenJob {
  jobId?: string;
  running: boolean;
  phase?: string;
  total: number;
  requestedCount?: number;
  done: number;
  failed: number;
  folder: string;
  theme?: string;
  styleBrief?: string;
  fallbackStyle?: string;
  negativePrompt?: string;
  exactPrompts?: string[];
  aiPrompts?: string[];
  startedAt?: number;
  updatedAt?: number;
  finishedAt?: number;
  lastError?: string;
  driveFolderLink?: string;
  clips?: StockGenClipStep[];
}

interface LegacyImportResponse {
  dryRun?: boolean;
  moved?: number;
  skipped?: number;
  trashedFolders?: number;
  failed?: number;
  errors?: string[];
  error?: string;
  targetFolder?: string;
}

type Notice = { tone: "info" | "warning"; text: string };

type UnifiedClipCard =
  | { kind: "generated"; key: string; clip: StockGenClipStep; sortTime: number; index: number }
  | { kind: "broll"; key: string; clip: StockClip; sortTime: number; index: number };

const previewBoxStyle: CSSProperties = {
  width: "100%",
  borderRadius: 6,
  display: "block",
  aspectRatio: "16/9",
  objectFit: "cover",
};

const INITIAL_VISIBLE_CARD_LIMIT = 48;
const CARD_LOAD_INCREMENT = 48;
const DEFAULT_BROLL_COUNT = 10;
const MIN_BROLL_COUNT = 1;
const MAX_BROLL_COUNT = 300;

const emptyActiveBatch: ActiveBatchSnapshot = {
  jobId: null,
  clips: [],
};

interface ActiveBatchSnapshot {
  jobId: string | null;
  clips: StockGenClipStep[];
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 14000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

function displayClipName(index: number) {
  return `B-roll ${String(index + 1).padStart(2, "0")}`;
}

function cleanClipName(name: string) {
  return name
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function promptLines(value: string): string[] {
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_BROLL_COUNT);
}

function parseBrollPromptInput(value: string) {
  const lines = promptLines(value);
  if (lines.length === 1) {
    return { styleBrief: lines[0], negativePrompt: "", exactPrompts: [] as string[] };
  }
  if (lines.length === 2) {
    return { styleBrief: lines[0], negativePrompt: lines[1], exactPrompts: [] as string[] };
  }
  if (lines.length >= 3) {
    return { styleBrief: "", negativePrompt: "", exactPrompts: lines };
  }
  return { styleBrief: "", negativePrompt: "", exactPrompts: [] as string[] };
}

function promptLineClass(nonEmptyCount: number, nonEmptyIndex: number | null) {
  if (nonEmptyIndex == null) return "text-muted-foreground/50";
  if (nonEmptyCount === 1) return "text-emerald-400";
  if (nonEmptyCount === 2) return nonEmptyIndex === 0 ? "text-emerald-400" : "text-rose-400";
  return "text-foreground";
}

function clampBrollCount(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_BROLL_COUNT;
  return Math.min(MAX_BROLL_COUNT, Math.max(MIN_BROLL_COUNT, Math.round(value)));
}

function sanitizeBrollCountInput(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, String(MAX_BROLL_COUNT).length);
  if (!digits) return "";
  return String(clampBrollCount(Number.parseInt(digits, 10)));
}

function timeValue(value?: string | number | null) {
  if (!value) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function jobStatusLabel(job: StockGenJob | null) {
  if (!job) return "Idle";
  if (job.phase === "prompting") return "Prompting";
  if (job.phase === "generating") return "Generating";
  if (job.phase === "failed") return "Failed";
  if (job.phase === "cancelled") return "Cancelled";
  if (job.phase === "finished") return "Finished";
  return job.running ? "Generating" : "Finished";
}

function jobStatusTone(job: StockGenJob | null) {
  if (!job) return "border-border bg-muted/40 text-muted-foreground";
  if (job.running) return "border-sky-500/30 bg-sky-500/10 text-sky-500";
  if (job.phase === "failed" || (job.failed > 0 && job.done === 0)) {
    return "border-destructive/30 bg-destructive/10 text-destructive";
  }
  if (job.phase === "cancelled") return "border-amber-500/30 bg-amber-500/10 text-amber-500";
  return "border-emerald-500/30 bg-emerald-500/10 text-emerald-500";
}

function jobPercent(job: StockGenJob | null) {
  if (!job) return 0;
  const total = Math.max(job.total || 0, job.requestedCount || 0);
  if (total <= 0) return 0;
  const clips = job.clips ?? [];
  if (clips.length === 0) return Math.min(100, Math.round(((job.done + job.failed) / total) * 100));
  const score = clips.reduce((sum, clip) => {
    if (clip.status === "complete") return sum + 3;
    if (clip.status === "failed" || clip.status === "cancelled" || clip.status === "deleted") return sum + 3;
    if (clip.uploadStatus === "done") return sum + 3;
    if (clip.uploadStatus === "running" || clip.status === "upload") return sum + 2.65;
    if (clip.videoStatus === "done") return sum + 2;
    if (clip.videoStatus === "running" || clip.status === "video") return sum + 1.55;
    if (clip.imageStatus === "done") return sum + 1;
    if (clip.imageStatus === "running" || clip.status === "image") return sum + 0.4;
    return sum;
  }, 0);
  return Math.min(100, Math.round((score / Math.max(1, total * 3)) * 100));
}

function mergeStockGenJobAssets(previous: StockGenJob | null, next: StockGenJob | null) {
  if (!previous || !next) return next;
  if ((next.clips?.length ?? 0) === 0 && (previous.clips?.length ?? 0) > 0) {
    if (!previous.jobId || previous.jobId === next.jobId) {
      return { ...next, clips: previous.clips };
    }
  }
  if (previous.jobId !== next.jobId) return next;
  const previousClips = new Map((previous.clips ?? []).map((clip) => [clip.index, clip]));
  return {
    ...next,
    clips: next.clips?.map((clip) => {
      const cached = previousClips.get(clip.index);
      if (!cached) return clip;
      return {
        ...clip,
        driveFileId: clip.driveFileId || cached.driveFileId,
        driveFileLink: clip.driveFileLink || cached.driveFileLink,
        driveName: clip.driveName || cached.driveName,
        imageUrl: clip.imageUrl || cached.imageUrl,
        posterUrl: clip.posterUrl || cached.posterUrl,
        videoUrl: clip.videoUrl || cached.videoUrl,
      };
    }),
  };
}

function placeholderStockGenClips(count: number, exactPrompts: string[] = []): StockGenClipStep[] {
  return Array.from({ length: Math.min(Math.max(0, count), 24) }, (_, index) => {
    const exactPrompt = exactPrompts[index];
    return {
      index,
      prompt: exactPrompt || "Prompt pending",
      promptSource: exactPrompt ? "exact" : "ai",
      displayName: displayClipName(index),
      status: "queued",
      imageStatus: "queued",
      videoStatus: "queued",
      uploadStatus: "queued",
      reviewStatus: "unreviewed",
      retryCount: 0,
    };
  });
}

function createOptimisticStockGenJob(opts: {
  count: number;
  exactPrompts: string[];
  styleBrief: string;
  negativePrompt: string;
}): StockGenJob {
  const now = Date.now();
  return {
    running: true,
    phase: "prompting",
    total: opts.count,
    requestedCount: opts.count,
    done: 0,
    failed: 0,
    folder: "B-roll",
    styleBrief: opts.styleBrief.trim() || undefined,
    negativePrompt: opts.negativePrompt.trim() || undefined,
    exactPrompts: opts.exactPrompts,
    startedAt: now,
    updatedAt: now,
    clips: placeholderStockGenClips(opts.count, opts.exactPrompts),
  };
}

function jobPipelineText(job: StockGenJob | null) {
  if (!job) return "";
  const total = Math.max(job.total || 0, job.requestedCount || 0);
  const clips = job.clips ?? [];
  const imagesDone = clips.filter((clip) => clip.imageStatus === "done").length;
  const videosDone = clips.filter((clip) => clip.videoStatus === "done" || clip.status === "upload" || clip.status === "complete").length;
  const uploadsDone = clips.filter((clip) => clip.uploadStatus === "done" || clip.status === "complete").length;
  const activeImages = clips.filter((clip) => clip.imageStatus === "running").length;
  const activeVideos = clips.filter((clip) => clip.videoStatus === "running").length;
  const activeUploads = clips.filter((clip) => clip.uploadStatus === "running").length;
  const active = [
    activeImages ? `${activeImages} image${activeImages === 1 ? "" : "s"} rendering` : "",
    activeVideos ? `${activeVideos} video${activeVideos === 1 ? "" : "s"} animating` : "",
    activeUploads ? `${activeUploads} upload${activeUploads === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return `${imagesDone}/${total} images / ${videosDone}/${total} videos / ${uploadsDone}/${total} uploaded${job.failed > 0 ? ` / ${job.failed} failed` : ""}${active.length ? ` / ${active.join(", ")}` : ""}`;
}

export default function StudioVideoClipsPage() {
  const { activeChannel, features, permissions, loading } = useActiveChannel();

  if (loading) {
    return <BrollsLoadingShell />;
  }

  if (!activeChannel) {
    return (
      <Centered icon={<Tv2 className="h-8 w-8 text-muted-foreground/40" />} title="No channel selected">
        Pick a channel from the switcher to load its B-roll folder.
      </Centered>
    );
  }

  const canEditVideo = !!features.video && (permissions.video ?? "none") === "edit";
  if (!canEditVideo) {
    return (
      <Centered icon={<Lock className="h-8 w-8 text-muted-foreground/40" />} title="Video editing isn't enabled for you on this channel">
        Ask an admin to grant the <span className="font-medium">Video Editing</span> feature for {activeChannel.name}.
      </Centered>
    );
  }

  return <BrollsView key={activeChannel.id} channelId={activeChannel.id} channelName={activeChannel.name} />;
}

function Centered({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <PageContainer className="max-w-[1440px]">
      <div className="mx-auto max-w-md pt-16 text-center">
        <div className="mx-auto mb-3 flex justify-center">{icon}</div>
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{children}</p>
      </div>
    </PageContainer>
  );
}

function BrollsLoadingShell() {
  return (
    <PageContainer className="max-w-[1440px] space-y-5">
      <PageHeader
        title="Video"
        action={
          <div className="flex items-center gap-2">
            <div className="h-8 w-20 rounded-md bg-muted/45" />
            <div className="h-8 w-20 rounded-md bg-muted/45" />
          </div>
        }
      />
      <VideoWorkspaceTabs />
      <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
        <div className="h-24 rounded-md bg-muted/35" />
      </section>
      <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
        <div className="h-24 rounded-md bg-muted/35" />
      </section>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {Array.from({ length: 10 }).map((_, index) => (
          <div key={index} className="aspect-video rounded-md bg-muted/40" />
        ))}
      </div>
    </PageContainer>
  );
}

function ClipMediaPreview({
  posterSrc,
  videoSrc,
  eager,
  active,
}: {
  posterSrc: string;
  videoSrc: string;
  eager: boolean;
  active: boolean;
}) {
  const [posterFailed, setPosterFailed] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);

  useEffect(() => {
    setPosterFailed(false);
  }, [posterSrc]);

  useEffect(() => {
    if (!active) {
      setVideoReady(false);
      setVideoFailed(false);
    }
  }, [active, videoSrc]);

  return (
    <div className="relative overflow-hidden rounded-md bg-muted" style={previewBoxStyle}>
      {posterFailed && (
        <div className="absolute inset-0 grid place-items-center text-[10px] text-muted-foreground">
          Thumbnail unavailable
        </div>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {!posterFailed && (
        <img
          src={posterSrc}
          alt=""
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          onError={() => setPosterFailed(true)}
          style={previewBoxStyle}
        />
      )}
      {active && !videoFailed && (
        <video
          src={videoSrc}
          muted
          autoPlay
          loop
          playsInline
          preload="metadata"
          onCanPlay={() => setVideoReady(true)}
          onError={() => {
            setVideoFailed(true);
            setVideoReady(false);
          }}
          style={{
            ...previewBoxStyle,
            position: "absolute",
            inset: 0,
            opacity: videoReady ? 1 : 0,
          }}
        />
      )}
    </div>
  );
}

function GeneratedClipPreview({ clip, active }: { clip: StockGenClipStep; active: boolean }) {
  const posterSrc = clip.imageUrl || clip.posterUrl || "";
  const videoSrc = clip.videoUrl || "";
  const lastPosterSrc = useRef(posterSrc);
  const [stablePosterSrc, setStablePosterSrc] = useState(posterSrc);
  const [posterStatus, setPosterStatus] = useState<"idle" | "loading" | "loaded" | "failed">(
    posterSrc ? "loading" : "idle"
  );
  const [videoReady, setVideoReady] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);

  useEffect(() => {
    if (posterSrc && posterSrc !== lastPosterSrc.current) {
      lastPosterSrc.current = posterSrc;
      setStablePosterSrc(posterSrc);
      setPosterStatus("loading");
      return;
    }
    if (!posterSrc && !lastPosterSrc.current) {
      setStablePosterSrc("");
      setPosterStatus("idle");
    }
  }, [posterSrc]);

  useEffect(() => {
    if (!active) {
      setVideoReady(false);
      setVideoFailed(false);
    }
  }, [active, videoSrc]);

  return (
    <div className="relative overflow-hidden rounded-md bg-muted" style={previewBoxStyle}>
      {stablePosterSrc ? (
        <>
          {posterStatus === "loading" && (
            <div className="absolute inset-0 rounded-md bg-muted/60" aria-hidden="true" />
          )}
          {posterStatus === "failed" && (
            <div className="absolute inset-0 grid place-items-center text-[10px] text-muted-foreground">
              Preview unavailable
            </div>
          )}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={stablePosterSrc}
            alt=""
            loading="eager"
            decoding="async"
            onLoad={() => setPosterStatus("loaded")}
            onError={() => setPosterStatus("failed")}
            style={{
              ...previewBoxStyle,
              opacity: posterStatus === "failed" ? 0 : 1,
            }}
          />
        </>
      ) : (
        <div className="absolute inset-0 grid place-items-center bg-muted/40 text-muted-foreground">
          {clip.status === "queued" ? (
            <ImageIcon className="h-5 w-5 text-muted-foreground/40" />
          ) : (
            <Loader2 className="h-5 w-5 animate-spin text-primary/70" />
          )}
        </div>
      )}

      {active && videoSrc && !videoFailed && (
        <video
          src={videoSrc}
          muted
          autoPlay
          loop
          playsInline
          preload="metadata"
          onCanPlay={() => setVideoReady(true)}
          onError={() => {
            setVideoFailed(true);
            setVideoReady(false);
          }}
          style={{
            ...previewBoxStyle,
            position: "absolute",
            inset: 0,
            opacity: videoReady ? 1 : 0,
          }}
        />
      )}

      {clip.status !== "complete" && stablePosterSrc && (
        <span className="absolute left-2 top-2 grid h-6 w-6 place-items-center rounded-full bg-black/60 text-white backdrop-blur">
          {clip.status === "failed" ? (
            <AlertTriangle className="h-3.5 w-3.5" />
          ) : clip.status === "upload" ? (
            <UploadCloud className="h-3.5 w-3.5" />
          ) : (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          )}
        </span>
      )}
    </div>
  );
}

function BrollPromptBox({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const overlayRef = useRef<HTMLPreElement | null>(null);
  const rawLines = value.replace(/\r\n/g, "\n").split("\n");
  const nonEmptyCount = promptLines(value).length;
  let nonEmptyIndex = -1;

  return (
    <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
      Prompt
      <div className="relative min-h-36 overflow-hidden rounded-md border border-input bg-background focus-within:border-primary/60 focus-within:ring-1 focus-within:ring-primary/30">
        <pre
          ref={overlayRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-sans text-sm leading-6"
        >
          {value ? (
            rawLines.map((line, index) => {
              const hasContent = line.trim().length > 0;
              if (hasContent) nonEmptyIndex += 1;
              return (
                <span key={index} className={promptLineClass(nonEmptyCount, hasContent ? nonEmptyIndex : null)}>
                  {line || " "}
                  {index < rawLines.length - 1 ? "\n" : ""}
                </span>
              );
            })
          ) : (
            <span className="text-muted-foreground">Optional prompt notes</span>
          )}
        </pre>
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onScroll={(event) => {
            if (overlayRef.current) overlayRef.current.scrollTop = event.currentTarget.scrollTop;
          }}
          disabled={disabled}
          placeholder="Optional prompt notes"
          className="relative z-10 min-h-36 w-full resize-none bg-transparent px-3 py-2 font-sans text-sm leading-6 text-transparent caret-foreground outline-none placeholder:text-transparent disabled:cursor-not-allowed disabled:opacity-60"
          spellCheck={false}
        />
      </div>
    </label>
  );
}

function StockGenerationPanel({
  channelId,
  onClipsChanged,
  onActiveBatchChange,
  onNotice,
  onImportLegacy,
  importingLegacy,
}: {
  channelId: number;
  onClipsChanged: () => Promise<void>;
  onActiveBatchChange: (snapshot: ActiveBatchSnapshot) => void;
  onNotice: (notice: Notice) => void;
  onImportLegacy: () => Promise<void>;
  importingLegacy: boolean;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [countText, setCountText] = useState(String(DEFAULT_BROLL_COUNT));
  const [promptText, setPromptText] = useState("");
  const [job, setJob] = useState<StockGenJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const syncedJobKey = useRef<string | null>(null);
  const parsedPrompt = useMemo(() => parseBrollPromptInput(promptText), [promptText]);
  const exactPrompts = parsedPrompt.exactPrompts;
  const countValue = useMemo(
    () => clampBrollCount(Number.parseInt(countText, 10)),
    [countText]
  );
  const requestedCount = clampBrollCount(Math.max(countValue, exactPrompts.length));
  const visibleClips = useMemo(() => {
    if (!job?.running) return [];
    const clips = job.clips ?? [];
    if (clips.length > 0) return clips.slice(0, 24);
    return placeholderStockGenClips(Math.max(job.total || 0, job.requestedCount || 0, requestedCount), job.exactPrompts ?? []);
  }, [job?.clips, job?.exactPrompts, job?.requestedCount, job?.running, job?.total, requestedCount]);
  const isGenerationRunning = Boolean(job?.running);
  const statusJobId = job?.jobId ?? null;
  const percent = jobPercent(job);

  const loadGeneration = useCallback(async (jobIdOverride?: string | null) => {
    setError(null);
    try {
      const targetJobId = jobIdOverride !== undefined ? jobIdOverride : statusJobId;
      const params = new URLSearchParams({ channelId: String(channelId) });
      if (targetJobId) params.set("jobId", targetJobId);
      const statusRes = await fetchWithTimeout(`/api/video/stock/generate?${params.toString()}`, { cache: "no-store" }, 12000);
      const statusJson = (await statusRes.json()) as StockGenJob & { error?: string };
      if (!statusRes.ok) throw new Error(statusJson.error || "Could not load B-roll generation status");
      const keepCompletedForActiveJob = Boolean(targetJobId && (statusJson.done > 0 || statusJson.failed > 0));
      const nextJob = statusJson.running || keepCompletedForActiveJob ? statusJson : null;
      setJob((previous) => mergeStockGenJobAssets(previous, nextJob));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load B-roll generation status.");
    } finally {
      setLoading(false);
    }
  }, [channelId, statusJobId]);

  useEffect(() => {
    void loadGeneration();
  }, [loadGeneration]);

  useEffect(() => {
    if (!isGenerationRunning) return;
    const timer = window.setInterval(() => {
      void loadGeneration(statusJobId);
    }, 3500);
    return () => window.clearInterval(timer);
  }, [isGenerationRunning, loadGeneration, statusJobId]);

  const completedSyncKey =
    job?.jobId && !job.running && job.done > 0 ? `${job.jobId}:${job.done}:${job.failed}` : null;
  const completedJobId = job?.jobId ?? null;
  useEffect(() => {
    if (!completedSyncKey || syncedJobKey.current === completedSyncKey) return;
    syncedJobKey.current = completedSyncKey;
    void onClipsChanged().finally(() => {
      setJob((current) => current?.jobId === completedJobId && !current.running ? null : current);
    });
  }, [completedJobId, completedSyncKey, onClipsChanged]);

  useEffect(() => {
    onActiveBatchChange({
      jobId: job?.jobId ?? null,
      clips: visibleClips,
    });
  }, [job?.jobId, onActiveBatchChange, visibleClips]);

  async function startGeneration() {
    setStarting(true);
    setError(null);
    const previousJob = job;
    setJob(createOptimisticStockGenJob({
      count: requestedCount,
      exactPrompts,
      styleBrief: parsedPrompt.styleBrief,
      negativePrompt: parsedPrompt.negativePrompt,
    }));
    try {
      const res = await fetch("/api/video/stock/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          count: requestedCount,
          channelId,
          styleBrief: parsedPrompt.styleBrief || null,
          negativePrompt: parsedPrompt.negativePrompt || null,
          exactPrompts,
          promptMode: exactPrompts.length === 0 ? "brief" : exactPrompts.length >= requestedCount ? "exact" : "mixed",
        }),
      });
      const data = (await res.json()) as StockGenJob & { error?: string };
      if (!res.ok) throw new Error(data.error || "B-roll generation could not start.");
      setJob((previous) => mergeStockGenJobAssets(previous, data));
      await loadGeneration(data.jobId ?? null);
    } catch (e) {
      setJob(previousJob);
      setError(e instanceof Error ? e.message : "B-roll generation could not start.");
    } finally {
      setStarting(false);
    }
  }

  async function stopGeneration() {
    if (!statusJobId) return;
    setStopping(true);
    setError(null);
    try {
      const params = new URLSearchParams({ channelId: String(channelId), jobId: statusJobId });
      const res = await fetch(`/api/video/stock/generate?${params.toString()}`, {
        method: "DELETE",
      });
      const data = (await res.json()) as StockGenJob & { error?: string };
      if (!res.ok) throw new Error(data.error || "Could not stop generation.");
      setJob((previous) => mergeStockGenJobAssets(previous, data));
      onNotice({ tone: "info", text: "B-roll generation stop requested." });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not stop generation.");
    } finally {
      setStopping(false);
    }
  }

  function commitCountText() {
    setCountText(String(countValue));
  }

  return (
    <section className="rounded-lg border border-border bg-card shadow-sm">
      <button
        type="button"
        onClick={() => setDrawerOpen((value) => !value)}
        className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/25"
        aria-expanded={drawerOpen}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Play className="h-4 w-4" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold">Add B-rolls</span>
          </span>
        </span>
        <span className="flex items-center gap-2">
          <span className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${jobStatusTone(job)}`}>
            {loading ? "Loading" : jobStatusLabel(job)}
          </span>
          <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", drawerOpen && "rotate-180")} />
        </span>
      </button>

      {drawerOpen && (
      <div className="border-t border-border p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-3 flex items-center gap-2">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">Generate B-roll</h2>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="grid w-28 gap-1 text-xs font-medium text-muted-foreground">
              Count
              <Input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                aria-label="B-roll count"
                value={countText}
                onChange={(e) => setCountText(sanitizeBrollCountInput(e.target.value))}
                onBlur={commitCountText}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.currentTarget.blur();
                  }
                }}
                className="font-mono tabular-nums"
              />
            </label>
            <Button type="button" onClick={startGeneration} disabled={starting || isGenerationRunning}>
              {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Generate {requestedCount}
            </Button>
            <Button type="button" variant="outline" onClick={stopGeneration} disabled={!statusJobId || stopping}>
              {stopping ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
              Stop
            </Button>
            <Button type="button" variant="outline" onClick={onImportLegacy} disabled={loading || importingLegacy}>
              {importingLegacy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
              Import old
            </Button>
          </div>
        </div>
      </div>

      <div className="mt-4 border-t border-border pt-4">
        <BrollPromptBox value={promptText} onChange={setPromptText} disabled={starting || isGenerationRunning} />
      </div>

      {error && (
        <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </div>
      )}

      {job?.running && (
        <div className="mt-4 rounded-md border border-border bg-muted/20 p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold">Current batch</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{jobPipelineText(job)}</p>
            </div>
            <span className={`rounded-full border px-2 py-0.5 text-[10px] ${jobStatusTone(job)}`}>
              {jobStatusLabel(job)}
            </span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-background">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${percent}%` }} />
          </div>
          {job.lastError && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {job.lastError}
            </p>
          )}
        </div>
      )}
      </div>
      )}
    </section>
  );
}

function BrollsView({ channelId, channelName }: { channelId: number; channelName: string }) {
  const [folder, setFolder] = useState<string | null>(null);
  const [driveFolderLink, setDriveFolderLink] = useState<string | null>(null);
  const [clips, setClips] = useState<StockClip[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [deletingClipId, setDeletingClipId] = useState<string | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [importingLegacy, setImportingLegacy] = useState(false);
  const [hoveredClipId, setHoveredClipId] = useState<string | null>(null);
  const [visibleCardLimit, setVisibleCardLimit] = useState(INITIAL_VISIBLE_CARD_LIMIT);
  const [activeBatch, setActiveBatch] = useState<ActiveBatchSnapshot>(emptyActiveBatch);
  const [historyOpen, setHistoryOpen] = useState(false);
  const loadSeqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = loadSeqRef.current + 1;
    loadSeqRef.current = seq;
    const isCurrent = () => loadSeqRef.current === seq;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const params = new URLSearchParams({ channelId: String(channelId) });
      const r = await fetchWithTimeout(`/api/video/stock/list?${params.toString()}`, { cache: "no-store" }, 35000);
      const j = (await r.json()) as StockListResponse;
      if (!r.ok && !j.clips) {
        throw new Error(j.message || "Failed to load B-rolls");
      }
      if (!isCurrent()) return;
      setClips(Array.isArray(j.clips) ? j.clips : []);
      setFolder(j.folder ?? null);
      setDriveFolderLink(typeof j.driveFolderLink === "string" ? j.driveFolderLink : null);
      setSelected(new Set());
      if (j.message) {
        setNotice({ tone: j.errorKind === "drive_auth" ? "warning" : "info", text: j.message });
      }
    } catch (e) {
      if (!isCurrent()) return;
      setError(e instanceof Error ? e.message : "Could not load B-rolls. Check Drive or reconnect in settings.");
      setClips((prev) => prev ?? []);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    return () => {
      loadSeqRef.current += 1;
    };
  }, []);

  useEffect(() => {
    setVisibleCardLimit(INITIAL_VISIBLE_CARD_LIMIT);
    setSelected(new Set());
  }, [channelName]);

  const generatedDriveIds = useMemo(() => {
    return new Set(activeBatch.clips.map((clip) => clip.driveFileId).filter((id): id is string => Boolean(id)));
  }, [activeBatch.clips]);

  const unifiedCards = useMemo<UnifiedClipCard[]>(() => {
    const cards: UnifiedClipCard[] = [];
    activeBatch.clips.forEach((clip, index) => {
      cards.push({
        kind: "generated",
        key: `active:${activeBatch.jobId || "pending"}:${clip.index}`,
        clip,
        sortTime: Date.now(),
        index,
      });
    });
    (clips ?? []).forEach((clip, index) => {
      if (generatedDriveIds.has(clip.driveFileId)) return;
      cards.push({
        kind: "broll",
        key: `broll:${clip.driveFileId}`,
        clip,
        sortTime: timeValue(clip.createdTime || clip.modifiedTime) || index * -1,
        index,
      });
    });
    return cards.sort((a, b) => {
      if (a.kind === "generated" && b.kind !== "generated") return -1;
      if (b.kind === "generated" && a.kind !== "generated") return 1;
      return b.sortTime - a.sortTime || a.index - b.index;
    });
  }, [activeBatch.clips, activeBatch.jobId, clips, generatedDriveIds]);

  const visibleCards = useMemo(() => unifiedCards.slice(0, visibleCardLimit), [unifiedCards, visibleCardLimit]);
  const selectedCards = useMemo(() => unifiedCards.filter((card) => selected.has(cardDriveId(card) ?? "")), [selected, unifiedCards]);
  const selectableIds = useMemo(
    () => unifiedCards.map(cardDriveId).filter((id): id is string => Boolean(id)),
    [unifiedCards]
  );

  const fileUrl = (id: string) => `/api/video/stock/file?id=${encodeURIComponent(id)}`;
  const posterUrl = (clip: StockClip) => {
    const id = clip.previewFileId || clip.driveFileId;
    const params = new URLSearchParams({ id, folder: folder ?? "", name: clip.name });
    return `/api/video/stock/poster?${params.toString()}`;
  };

  function toggle(id: string | null | undefined) {
    if (!id) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function deleteIds(ids: string[]) {
    if (ids.length === 0) return;
    setDeleting(true);
    setError(null);
    try {
      const r = await fetch("/api/video/stock/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId, ids }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; failed?: number; deleted?: number };
      if (!r.ok || j.failed) {
        setNotice({ tone: "warning", text: String(j.error || "Could not delete selected B-rolls from Drive.") });
        return;
      }
      setSelected(new Set());
      setClips((prev) => (prev ? prev.filter((clip) => !ids.includes(clip.driveFileId)) : prev));
      setNotice({ tone: "info", text: `${j.deleted ?? ids.length} B-roll${ids.length === 1 ? "" : "s"} moved to Google Drive trash.` });
      await load();
    } finally {
      setDeleting(false);
      setDeletingClipId(null);
    }
  }

  async function deleteSelected() {
    const ids = selectedCards.map(cardDriveId).filter((id): id is string => Boolean(id));
    if (ids.length === 0) return;
    if (!window.confirm(`Move ${ids.length} B-roll${ids.length === 1 ? "" : "s"} to Google Drive trash?`)) return;
    await deleteIds(ids);
  }

  async function deleteSingle(id: string) {
    setDeletingClipId(id);
    await deleteIds([id]);
  }

  async function repairWorkspace() {
    setRepairing(true);
    setError(null);
    try {
      const params = new URLSearchParams({ channelId: String(channelId) });
      const r = await fetch(`/api/video/drive/workspace/repair?${params.toString()}`, { method: "POST" });
      const j = (await r.json().catch(() => ({}))) as {
        error?: string;
        repair?: {
          repairedFolders?: unknown[];
          skippedNonEmptyFolders?: unknown[];
          legacyFallbackFolders?: unknown[];
        };
      };
      if (!r.ok) {
        setNotice({ tone: "warning", text: j.error || "Drive repair failed." });
        return;
      }
      await load();
      const repaired = j.repair?.repairedFolders?.length ?? 0;
      const skipped = j.repair?.skippedNonEmptyFolders?.length ?? 0;
      const legacy = j.repair?.legacyFallbackFolders?.length ?? 0;
      setNotice({
        tone: "info",
        text: `Drive workspace checked. ${repaired} folder${repaired === 1 ? "" : "s"} repaired, ${skipped} non-empty skipped, ${legacy} legacy fallback${legacy === 1 ? "" : "s"} found.`,
      });
    } finally {
      setRepairing(false);
    }
  }

  async function importLegacyBrolls() {
    setImportingLegacy(true);
    setError(null);
    try {
      const dryRunRes = await fetch("/api/video/stock/import-legacy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId, dryRun: true }),
      });
      const dryRun = (await dryRunRes.json().catch(() => ({}))) as LegacyImportResponse;
      if (!dryRunRes.ok) throw new Error(dryRun.error || "Could not inspect old B-roll folders.");
      const moveCount = dryRun.moved ?? 0;
      if (moveCount <= 0) {
        setNotice({ tone: "info", text: "No old B-rolls need importing." });
        return;
      }
      if (!window.confirm(`Move ${moveCount} old B-roll${moveCount === 1 ? "" : "s"} into the current channel folder?`)) {
        setNotice({ tone: "info", text: "Old B-roll import cancelled." });
        return;
      }
      const importRes = await fetch("/api/video/stock/import-legacy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId, dryRun: false }),
      });
      const result = (await importRes.json().catch(() => ({}))) as LegacyImportResponse;
      if (!importRes.ok) throw new Error(result.error || "Could not import old B-rolls.");
      await load();
      setNotice({
        tone: result.failed ? "warning" : "info",
        text: `Old B-roll import finished. ${result.moved || 0} moved, ${result.skipped || 0} skipped, ${result.trashedFolders || 0} empty folder${result.trashedFolders === 1 ? "" : "s"} trashed${result.failed ? `, ${result.failed} failed` : ""}.`,
      });
    } catch (e) {
      setNotice({ tone: "warning", text: e instanceof Error ? e.message : "Could not import old B-rolls." });
    } finally {
      setImportingLegacy(false);
    }
  }

  const hasLoaded = clips !== null;
  const activeCount = selectableIds.length;

  return (
    <>
      <VideoWorkspaceShell
        onHistoryClick={() => setHistoryOpen(true)}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {driveFolderLink && (
              <a href={driveFolderLink} target="_blank" rel="noopener noreferrer">
                <Button variant="outline" size="sm">
                  <ExternalLink className="h-3.5 w-3.5" />
                  Drive
                </Button>
              </a>
            )}
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={repairWorkspace} disabled={loading || repairing}>
              {repairing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wrench className="h-3.5 w-3.5" />}
              Repair
            </Button>
          </div>
        }
      >

      <StockGenerationPanel
        channelId={channelId}
        onClipsChanged={load}
        onActiveBatchChange={setActiveBatch}
        onNotice={setNotice}
        onImportLegacy={importLegacyBrolls}
        importingLegacy={importingLegacy}
      />

      {notice && (
        <div
          className={
            notice.tone === "warning"
              ? "rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400"
              : "rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground"
          }
        >
          {notice.text}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          Could not load B-rolls. {error}
        </div>
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold">
              {activeCount} Drive B-roll{activeCount === 1 ? "" : "s"}
            </p>
            <p className="text-xs text-muted-foreground">{selected.size} selected</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setSelected(new Set(selectableIds))}
              disabled={selectableIds.length === 0}
            >
              Select all
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setSelected(new Set())}
              disabled={selected.size === 0}
            >
              Clear
            </Button>
            <Button
              type="button"
              variant={selected.size > 0 ? "destructive" : "outline"}
              size="sm"
              onClick={deleteSelected}
              disabled={selected.size === 0 || deleting}
            >
              {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              Delete selected
            </Button>
          </div>
        </div>

        {loading && !hasLoaded && (
          <div className="rounded-lg border border-dashed border-border bg-muted/15 p-8 text-center">
            <Loader2 className="mx-auto mb-3 h-6 w-6 animate-spin text-primary" />
            <p className="text-sm font-medium">Checking Drive B-rolls</p>
            <p className="mt-1 text-xs text-muted-foreground">This can take a few seconds when Drive is waking up.</p>
          </div>
        )}

        {loading && hasLoaded && (
          <div className="inline-flex w-fit items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Updating B-rolls
          </div>
        )}

        {hasLoaded && unifiedCards.length === 0 && !error && (
          <div className="rounded-lg border border-dashed border-border p-8 text-center">
            <HardDrive className="mx-auto mb-2 h-7 w-7 text-muted-foreground/40" />
            <p className="text-sm font-medium">No B-rolls yet</p>
            <p className="mt-1 text-xs text-muted-foreground">Generate a batch or import old clips to fill this channel library.</p>
          </div>
        )}

        {unifiedCards.length > 0 && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
            {visibleCards.map((card, index) => {
              const id = cardDriveId(card);
              const selectedCard = !!id && selected.has(id);
              const playing = hoveredClipId === card.key;
              const label = card.kind === "generated"
                ? card.clip.displayName || displayClipName(card.clip.index)
                : cleanClipName(card.clip.displayName || card.clip.name) || card.clip.name;
              const driveLink = card.clip.driveFileLink;
              const videoId = card.kind === "broll" ? card.clip.previewFileId || card.clip.driveFileId : card.clip.driveFileId;
              return (
                <article
                  key={card.key}
                  className={cn(
                    "group relative overflow-hidden rounded-lg border bg-card shadow-sm transition-shadow hover:shadow-md",
                    selectedCard ? "border-primary ring-1 ring-primary/40" : "border-border"
                  )}
                  onMouseEnter={() => setHoveredClipId(card.key)}
                  onMouseLeave={() => setHoveredClipId((current) => (current === card.key ? null : current))}
                >
                  <button
                    type="button"
                    className="block w-full"
                    aria-pressed={selectedCard}
                    aria-label={`${selectedCard ? "Deselect" : "Select"} ${label}`}
                    onClick={() => toggle(id)}
                    disabled={!id}
                  >
                    {card.kind === "generated" ? (
                      <GeneratedClipPreview clip={card.clip} active={playing} />
                    ) : (
                      <ClipMediaPreview
                        posterSrc={posterUrl(card.clip)}
                        videoSrc={fileUrl(videoId || card.clip.driveFileId)}
                        eager={index < 12}
                        active={playing}
                      />
                    )}
                  </button>
                  {id && (
                    <button
                      type="button"
                      aria-label={`${selectedCard ? "Deselect" : "Select"} ${label}`}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        toggle(id);
                      }}
                      className={cn(
                        "absolute left-2 top-2 grid h-5 w-5 place-items-center rounded border bg-background/85 text-[10px] shadow-sm backdrop-blur transition-colors",
                        selectedCard ? "border-primary bg-primary text-primary-foreground" : "border-border"
                      )}
                    >
                      {selectedCard ? <Check className="h-3 w-3" /> : null}
                    </button>
                  )}
                  <div className="pointer-events-none absolute inset-0 flex items-start justify-end gap-1 bg-gradient-to-b from-black/35 via-transparent to-transparent p-2 opacity-0 group-hover:opacity-100">
                    {driveLink && (
                      <a
                        href={driveLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="pointer-events-auto grid h-7 w-7 place-items-center rounded-md bg-black/60 text-white backdrop-blur transition-colors hover:bg-black/75"
                        title="Open in Drive"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                    {id && (
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        className="pointer-events-auto h-7 w-7 p-0"
                        title="Move to Google Drive trash"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          void deleteSingle(id);
                        }}
                        disabled={deletingClipId === id || deleting}
                      >
                        {deletingClipId === id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {unifiedCards.length > visibleCards.length && (
          <div className="flex justify-center">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setVisibleCardLimit((value) => value + CARD_LOAD_INCREMENT)}
            >
              Load {Math.min(CARD_LOAD_INCREMENT, unifiedCards.length - visibleCards.length)} more
            </Button>
          </div>
        )}
      </section>
      </VideoWorkspaceShell>

      <Modal open={historyOpen} onClose={() => setHistoryOpen(false)} title="History">
        <BrollHistoryList channelId={channelId} open={historyOpen} />
      </Modal>
    </>
  );
}

function BrollHistoryList({ channelId, open }: { channelId: number; open: boolean }) {
  const [jobs, setJobs] = useState<StockGenJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setJobs(null);
    setError(null);
    const params = new URLSearchParams({ channelId: String(channelId), limit: "50" });
    fetch(`/api/video/stock/generate/history?${params.toString()}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { jobs?: StockGenJob[]; error?: string }) => {
        if (cancelled) return;
        if (d.error) {
          setError(d.error);
          setJobs([]);
          return;
        }
        setJobs(Array.isArray(d.jobs) ? d.jobs : []);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Could not load history");
        setJobs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, open]);

  if (error) return <p className="px-5 py-4 text-xs text-destructive">{error}</p>;
  if (jobs === null) return <p className="px-5 py-4 text-xs text-muted-foreground">Loading...</p>;
  if (jobs.length === 0) {
    return <p className="px-5 py-4 text-xs text-muted-foreground">No generation history yet.</p>;
  }

  return (
    <ul className="divide-y divide-border">
      {jobs.map((job, index) => (
        <li key={job.jobId ?? index} className="px-5 py-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="line-clamp-1 text-sm text-foreground">
              {job.theme || job.styleBrief || "B-roll batch"}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {timeValue(job.finishedAt ?? job.startedAt)}
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{jobStatusLabel(job)}</span>
            <span>
              {job.done}/{job.total} clips
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function cardDriveId(card: UnifiedClipCard): string | null {
  if (card.kind === "generated") return card.clip.driveFileId ?? null;
  return card.clip.driveFileId;
}
