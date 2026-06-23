import { listStockGenerationHistory } from "@/lib/video-engine/services/stock-gen";
import {
  isResponse,
  parseOptionalChannelId,
  publicStockGenStatus,
  requireActiveStockContext,
  stockJson,
} from "../_shared";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsedChannelId = parseOptionalChannelId(url.searchParams.get("channelId"));
  if (!parsedChannelId.ok) return parsedChannelId.response;
  const ctx = await requireActiveStockContext(parsedChannelId.value);
  if (isResponse(ctx)) return ctx;

  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 50));
  const jobs = listStockGenerationHistory({
    channelId: String(ctx.channelId),
    folder: ctx.stockFolder,
    limit,
  });
  return stockJson({ jobs: jobs.map(publicStockGenStatus), folder: ctx.stockFolder, channelId: ctx.channelId });
}
