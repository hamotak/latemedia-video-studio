import { ensureInit } from "@/lib/video-engine/init";
import { getFileStream } from "@/lib/video-engine/services/gdrive";
import {
  isLocalStockClipId,
  resolveLocalStockClipPath,
} from "@/lib/video-engine/services/stock-library";
import { requireVideoEditUser } from "@/lib/video-access";
import fs from "node:fs";
import { Readable } from "node:stream";

export const runtime = "nodejs";

function streamNode(node: Readable): ReadableStream<Uint8Array> {
  let closed = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      node.on("data", (chunk) => {
        node.pause();
        if (closed) return;
        try {
          controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
        } catch {
          closed = true;
          node.destroy();
          return;
        }
        if ((controller.desiredSize ?? 1) > 0) node.resume();
      });
      node.once("end", () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Client closed the preview before the stream ended.
        }
      });
      node.once("error", (err) => {
        if (closed) return;
        closed = true;
        try {
          controller.error(err);
        } catch {
          // Ignore late stream errors after a client disconnect.
        }
      });
    },
    pull() {
      if (!closed) node.resume();
    },
    cancel() {
      closed = true;
      node.destroy();
    },
  });
}

/** GET /api/video/stock/file?id=<driveFileId> — stream a stock clip for in-app preview. */
export async function GET(req: Request) {
  if (!(await requireVideoEditUser())) {
    return new Response("Forbidden", { status: 403 });
  }
  ensureInit();
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return new Response("Missing id", { status: 400 });
  try {
    if (isLocalStockClipId(id)) {
      const localPath = resolveLocalStockClipPath(id);
      const stream = fs.createReadStream(localPath);
      return new Response(streamNode(stream), {
        headers: { "Content-Type": "video/mp4", "Cache-Control": "no-store" },
      });
    }
    const nodeStream = await getFileStream(id);
    return new Response(streamNode(nodeStream as Readable), {
      headers: { "Content-Type": "video/mp4", "Cache-Control": "no-store" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(`Preview failed: ${msg}`, { status: 400 });
  }
}
