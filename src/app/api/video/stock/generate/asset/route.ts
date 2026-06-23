import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { DATA_DIR } from "@/lib/video-engine/run-paths";
import { getStockGenStatus } from "@/lib/video-engine/services/stock-gen";
import {
  isResponse,
  parseOptionalChannelId,
  requireActiveStockContext,
  statusBelongsToContext,
} from "../_shared";

export const runtime = "nodejs";

function mimeFor(filePath: string, kind: "image" | "video"): string {
  if (kind === "video") return "video/mp4";
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

function safeGeneratedPath(filePath: string): string {
  const root = path.resolve(DATA_DIR);
  const full = path.resolve(filePath);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error("Invalid generated asset path");
  }
  if (!fs.existsSync(full)) throw new Error("Generated asset is not available yet");
  return full;
}

function nodeToWeb(stream: Readable): ReadableStream<Uint8Array> {
  let closed = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on("data", (chunk) => {
        stream.pause();
        if (closed) return;
        try {
          controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
        } catch {
          closed = true;
          stream.destroy();
          return;
        }
        if ((controller.desiredSize ?? 1) > 0) stream.resume();
      });
      stream.once("end", () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // The browser can close a preview stream while scrubbing.
        }
      });
      stream.once("error", (err) => {
        if (closed) return;
        closed = true;
        try {
          controller.error(err);
        } catch {
          // Ignore late errors after a disconnected preview.
        }
      });
    },
    pull() {
      if (!closed) stream.resume();
    },
    cancel() {
      closed = true;
      stream.destroy();
    },
  });
}

function streamAsset(req: Request, filePath: string, mimeType: string): Response {
  const stat = fs.statSync(filePath);
  const range = req.headers.get("range");
  if (range && /^bytes=\d*-\d*$/.test(range)) {
    const [startRaw, endRaw] = range.replace("bytes=", "").split("-");
    const start = startRaw ? Number(startRaw) : 0;
    const end = endRaw ? Number(endRaw) : stat.size - 1;
    if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < stat.size) {
      const boundedEnd = Math.min(end, stat.size - 1);
      return new Response(nodeToWeb(fs.createReadStream(filePath, { start, end: boundedEnd })), {
        status: 206,
        headers: {
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
          "Content-Length": String(boundedEnd - start + 1),
          "Content-Range": `bytes ${start}-${boundedEnd}/${stat.size}`,
          "Content-Type": mimeType,
        },
      });
    }
  }

  return new Response(nodeToWeb(fs.createReadStream(filePath)), {
    headers: {
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "Content-Length": String(stat.size),
      "Content-Type": mimeType,
    },
  });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsedChannelId = parseOptionalChannelId(url.searchParams.get("channelId"));
  if (!parsedChannelId.ok) return parsedChannelId.response;
  const ctx = await requireActiveStockContext(parsedChannelId.value);
  if (isResponse(ctx)) return ctx;

  const jobId = url.searchParams.get("jobId")?.trim() || "";
  const index = Number(url.searchParams.get("index"));
  const kind = url.searchParams.get("kind") === "video" ? "video" : "image";
  if (!jobId || !Number.isFinite(index)) {
    return new Response("jobId and index are required", { status: 400 });
  }

  const status = getStockGenStatus(jobId);
  if (!status) return new Response("Generation job not found", { status: 404 });
  if (!statusBelongsToContext(status, ctx)) {
    return new Response("Generation job belongs to another channel", { status: 403 });
  }

  const clip = status.clips?.find((item) => item.index === index);
  const filePath = kind === "video" ? clip?.videoPath : clip?.imagePath;
  if (!clip || !filePath) {
    return new Response("Generated asset is not available yet", { status: 404 });
  }

  try {
    const safePath = safeGeneratedPath(filePath);
    return streamAsset(req, safePath, mimeFor(safePath, kind));
  } catch (e) {
    return new Response(e instanceof Error ? e.message : String(e), { status: 404 });
  }
}
