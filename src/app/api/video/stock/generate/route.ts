import { NextResponse } from "next/server";
import { getSetting } from "@/lib/video-engine/settings";
import { channelStockTheme } from "@/lib/video-engine/channel-stock";
import { getConnectionStatus } from "@/lib/video-engine/services/gdrive";
import {
  cancelStockGeneration,
  getStockGenStatus,
  startStockGeneration,
  updateStockClipReview,
  type StockGenClipStep,
} from "@/lib/video-engine/services/stock-gen";
import {
  isResponse,
  parseOptionalChannelId,
  publicStockGenStatus,
  requireActiveStockContext,
  statusBelongsToContext,
  stockJson,
} from "./_shared";

export const runtime = "nodejs";

interface StartBody {
  channelId?: number | string | null;
  theme?: string;
  count?: number;
  videoStyle?: string | null;
  styleBrief?: string | null;
  negativePrompt?: string | null;
  exactPrompts?: unknown;
  promptMode?: "brief" | "exact" | "mixed";
}

interface ReviewBody {
  channelId?: number | string | null;
  jobId?: string;
  index?: number;
  reviewStatus?: StockGenClipStep["reviewStatus"];
}

function normalizeExactPrompts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const prompts: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const prompt = raw.trim();
    if (!prompt || seen.has(prompt)) continue;
    seen.add(prompt);
    prompts.push(prompt);
  }
  return prompts.slice(0, 300);
}

function missingStatus(jobId: string | null, folder: string) {
  return {
    running: false,
    phase: jobId ? "missing" : "finished",
    total: 0,
    requestedCount: 0,
    done: 0,
    failed: 0,
    folder,
    jobId: jobId || undefined,
    lastError: jobId ? "Generation job was not found. It may have been cleared before persistence was available." : undefined,
  };
}

function inferPromptMode(
  promptMode: StartBody["promptMode"],
  exactPromptCount: number,
  requestedCount: number
): "brief" | "exact" | "mixed" {
  if (promptMode) return promptMode;
  if (exactPromptCount === 0) return "brief";
  return exactPromptCount >= requestedCount ? "exact" : "mixed";
}

async function preflightStockGeneration(opts: {
  exactPromptCount: number;
  requestedCount: number;
}): Promise<NextResponse | null> {
  const drive = await getConnectionStatus();
  if (!drive.connected) {
    return stockJson(
      {
        error: drive.error || "Connect Google Drive before generating B-roll.",
        errorKind: "drive_required",
        connectedEmail: drive.email ?? null,
      },
      { status: 400 }
    );
  }

  if (process.env.STOCK_GEN_MOCK === "1") return null;

  const labsKey = getSetting("LABS69_API_KEY").trim();
  if (!labsKey) {
    return stockJson(
      {
        error: "69labs API key is missing. Add LABS69_API_KEY in Settings before starting paid B-roll generation.",
        errorKind: "provider_required",
      },
      { status: 400 }
    );
  }

  const aiPromptsNeeded = opts.requestedCount > opts.exactPromptCount;
  if (aiPromptsNeeded && !getSetting("GOOGLE_API_KEY").trim()) {
    return stockJson(
      {
        error: "GOOGLE_API_KEY is missing. Add it in Settings or provide enough exact prompts for the requested clip count.",
        errorKind: "google_required",
      },
      { status: 400 }
    );
  }

  if ((getSetting("IMAGE_PROVIDER") || "69labs").toLowerCase() === "off") {
    return stockJson(
      { error: "IMAGE_PROVIDER cannot be off for B-roll generation.", errorKind: "provider_required" },
      { status: 400 }
    );
  }
  if ((getSetting("ANIMATION_PROVIDER") || "69labs").toLowerCase() === "off") {
    return stockJson(
      { error: "ANIMATION_PROVIDER cannot be off for B-roll generation.", errorKind: "provider_required" },
      { status: 400 }
    );
  }

  return null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsedChannelId = parseOptionalChannelId(url.searchParams.get("channelId"));
  if (!parsedChannelId.ok) return parsedChannelId.response;
  const ctx = await requireActiveStockContext(parsedChannelId.value);
  if (isResponse(ctx)) return ctx;

  const jobId = url.searchParams.get("jobId")?.trim() || null;
  const status = getStockGenStatus(jobId || ctx.stockFolder);
  if (status && !statusBelongsToContext(status, ctx)) {
    return stockJson({ error: "Generation job belongs to another channel." }, { status: 403 });
  }
  return stockJson(status ? publicStockGenStatus(status) : missingStatus(jobId, ctx.stockFolder));
}

export async function POST(req: Request) {
  let body: StartBody;
  try {
    body = (await req.json()) as StartBody;
  } catch {
    return stockJson({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsedChannelId = parseOptionalChannelId(body.channelId);
  if (!parsedChannelId.ok) return parsedChannelId.response;
  const ctx = await requireActiveStockContext(parsedChannelId.value);
  if (isResponse(ctx)) return ctx;

  const exactPrompts = normalizeExactPrompts(body.exactPrompts);
  const requestedCount = Math.max(1, Math.min(300, Math.max(Math.floor(Number(body.count) || 10), exactPrompts.length)));
  const preflight = await preflightStockGeneration({
    exactPromptCount: exactPrompts.length,
    requestedCount,
  });
  if (preflight) return preflight;

  const styleBrief = body.styleBrief?.trim() || null;
  const videoStyle = body.videoStyle?.trim() || ctx.channelVideoStyle || null;
  const theme = body.theme?.trim() || channelStockTheme({
    name: ctx.channelName,
    videoStyle,
  });

  const status = startStockGeneration({
    folder: ctx.stockFolder,
    theme,
    count: requestedCount,
    videoStyle,
    styleBrief,
    negativePrompt: body.negativePrompt ?? null,
    exactPrompts,
    channelId: ctx.channelId,
    channelName: ctx.channelName,
    promptMode: inferPromptMode(body.promptMode, exactPrompts.length, requestedCount),
  });
  return stockJson(publicStockGenStatus(status));
}

export async function PATCH(req: Request) {
  let body: ReviewBody;
  try {
    body = (await req.json()) as ReviewBody;
  } catch {
    return stockJson({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsedChannelId = parseOptionalChannelId(body.channelId);
  if (!parsedChannelId.ok) return parsedChannelId.response;
  const ctx = await requireActiveStockContext(parsedChannelId.value);
  if (isResponse(ctx)) return ctx;

  const jobId = body.jobId?.trim() || "";
  const index = Number(body.index);
  const reviewStatus = body.reviewStatus;
  if (!jobId || !Number.isFinite(index) || !reviewStatus) {
    return stockJson({ error: "jobId, index, and reviewStatus are required" }, { status: 400 });
  }

  const before = getStockGenStatus(jobId);
  if (before && !statusBelongsToContext(before, ctx)) {
    return stockJson({ error: "Generation job belongs to another channel." }, { status: 403 });
  }
  const status = updateStockClipReview(jobId, index, reviewStatus);
  return stockJson(status ? publicStockGenStatus(status) : { error: "Job not found" }, { status: status ? 200 : 404 });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const parsedChannelId = parseOptionalChannelId(url.searchParams.get("channelId"));
  if (!parsedChannelId.ok) return parsedChannelId.response;
  const ctx = await requireActiveStockContext(parsedChannelId.value);
  if (isResponse(ctx)) return ctx;

  const jobId = url.searchParams.get("jobId")?.trim() || null;
  const before = getStockGenStatus(jobId || ctx.stockFolder);
  if (before && !statusBelongsToContext(before, ctx)) {
    return stockJson({ error: "Generation job belongs to another channel." }, { status: 403 });
  }
  const status = cancelStockGeneration(jobId || ctx.stockFolder);
  return stockJson(status ? publicStockGenStatus(status) : missingStatus(jobId, ctx.stockFolder));
}
