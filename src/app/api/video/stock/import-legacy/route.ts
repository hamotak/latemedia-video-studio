import { defaultStockFolder } from "@/lib/video-engine/channel-stock";
import { getSetting } from "@/lib/video-engine/settings";
import { isJsonObject, tryParseJson } from "@/lib/video-engine/json-body";
import { migrateLegacyChannelStockClips } from "@/lib/video-engine/services/stock-library";
import {
  isResponse,
  parseOptionalChannelId,
  requireActiveStockContext,
  stockJson,
} from "../generate/_shared";

export const runtime = "nodejs";

function uniqueFolderNames(names: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const clean = name?.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function bodyFolderNames(value: unknown): string[] {
  if (!isJsonObject(value) || !Array.isArray(value.legacyFolders)) return [];
  return value.legacyFolders.filter((name): name is string => typeof name === "string");
}

function shouldDryRun(value: unknown): boolean {
  if (!isJsonObject(value)) return true;
  return value.dryRun !== false;
}

export async function POST(req: Request) {
  const text = await req.text();
  const parsed = text.trim() ? tryParseJson(text) : { ok: true as const, value: {} };
  if (!parsed.ok || !isJsonObject(parsed.value)) {
    return stockJson({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsedChannelId = parseOptionalChannelId(parsed.value.channelId);
  if (!parsedChannelId.ok) return parsedChannelId.response;
  const ctx = await requireActiveStockContext(parsedChannelId.value);
  if (isResponse(ctx)) return ctx;

  const legacyFolders = uniqueFolderNames([
    ctx.stockFolder,
    getSetting("STOCK_LIBRARY_FOLDER"),
    defaultStockFolder(ctx.channelName),
    ctx.channelName,
    ...bodyFolderNames(parsed.value),
  ]);

  try {
    const result = await migrateLegacyChannelStockClips(ctx.channelName, {
      dryRun: shouldDryRun(parsed.value),
      legacyFolders,
    });
    return stockJson(result);
  } catch (e) {
    return stockJson({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
