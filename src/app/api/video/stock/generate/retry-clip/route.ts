import { getStockGenStatus, retryStockGenerationClip } from "@/lib/video-engine/services/stock-gen";
import {
  isResponse,
  parseOptionalChannelId,
  publicStockGenStatus,
  requireActiveStockContext,
  statusBelongsToContext,
  stockJson,
} from "../_shared";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: { channelId?: number | string | null; jobId?: string; index?: number; mode?: "image" | "video" };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return stockJson({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsedChannelId = parseOptionalChannelId(body.channelId);
  if (!parsedChannelId.ok) return parsedChannelId.response;
  const ctx = await requireActiveStockContext(parsedChannelId.value);
  if (isResponse(ctx)) return ctx;

  const jobId = body.jobId?.trim() || "";
  const index = Number(body.index);
  const mode = body.mode === "image" ? "image" : "video";
  if (!jobId || !Number.isFinite(index)) {
    return stockJson({ error: "jobId and index are required" }, { status: 400 });
  }

  const before = getStockGenStatus(jobId);
  if (before && !statusBelongsToContext(before, ctx)) {
    return stockJson({ error: "Generation job belongs to another channel." }, { status: 403 });
  }
  const status = retryStockGenerationClip(jobId, index, mode);
  return stockJson(status ? publicStockGenStatus(status) : { error: "Job or clip not found" }, { status: status ? 200 : 404 });
}
