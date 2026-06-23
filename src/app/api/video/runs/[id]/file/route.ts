import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import db from "@/lib/video-engine/db";
import { ensureInit } from "@/lib/video-engine/init";
import { getRunDir } from "@/lib/video-engine/run-paths";
import { ensureVideoPoster } from "@/lib/video-engine/services/video-poster";
import { readRunExportState } from "@/lib/video-engine/run-export-state";
import { requireVideoRunAccess } from "@/lib/video-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function streamFile(target: string, start?: number, end?: number): ReadableStream<Uint8Array> {
  let node: fs.ReadStream | null = null;
  let closed = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      node = fs.createReadStream(target, start !== undefined && end !== undefined ? { start, end } : {});
      node.on("data", (chunk) => {
        node?.pause();
        if (closed) return;
        try {
          controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
        } catch {
          closed = true;
          node?.destroy();
          return;
        }
        if ((controller.desiredSize ?? 1) > 0) node?.resume();
      });
      node.once("end", () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* client may have closed after the final chunk */
        }
      });
      node.once("error", (err) => {
        if (closed) return;
        closed = true;
        try {
          controller.error(err);
        } catch {
          /* ignore late stream errors after disconnect */
        }
      });
    },
    pull() {
      if (!closed) node?.resume();
    },
    cancel() {
      closed = true;
      node?.destroy();
    },
  });
}

const getRun = db.prepare("SELECT id, status, config_json FROM runs WHERE id = ?");

function runMode(configJson: string | null): string {
  if (!configJson) return "hybrid";
  try {
    const cfg = JSON.parse(configJson) as { mode?: string };
    return typeof cfg.mode === "string" ? cfg.mode : "hybrid";
  } catch {
    return "hybrid";
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;
  const access = await requireVideoRunAccess(id);
  if (!access.ok) {
    return NextResponse.json(
      { error: access.status === 404 ? "run not found" : "Forbidden" },
      { status: access.status }
    );
  }
  const run = getRun.get(id) as { id: string; status: string; config_json: string | null } | undefined;
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });

  const url = new URL(req.url);
  const rel = normalizeRequestedPath(url.searchParams.get("p") ?? "final.mp4");
  if (!rel) return NextResponse.json({ error: "path escape blocked" }, { status: 400 });
  const download = url.searchParams.get("download") === "1";

  const runDir = path.resolve(getRunDir(id));
  let target = path.resolve(runDir, rel);
  if (!target.startsWith(runDir + path.sep) && target !== runDir) {
    return NextResponse.json({ error: "path escape blocked" }, { status: 400 });
  }
  if (rel === "final.mp4" || rel === "final-poster.jpg") {
    const exportState = readRunExportState(id, run.status, { mode: runMode(run.config_json) });
    if (!exportState.finalReady) {
      return NextResponse.json(
        {
          error: exportState.finalNeedsRepair
            ? "Final video needs chunk repair before export."
            : "Final video is not export-ready yet.",
        },
        { status: 409 }
      );
    }
  }
  if (rel === "final-poster.jpg") {
    const finalPath = path.join(runDir, "final.mp4");
    if (!fs.existsSync(finalPath) || !fs.statSync(finalPath).isFile()) {
      return NextResponse.json({ error: "final video not found" }, { status: 404 });
    }
    target = await ensureVideoPoster(finalPath, target);
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return NextResponse.json({ error: "file not found" }, { status: 404 });
  }

  const stat = fs.statSync(target);
  const size = stat.size;
  const ext = path.extname(target).toLowerCase();
  const mime =
    ext === ".mp4" ? "video/mp4" :
    ext === ".mp3" ? "audio/mpeg" :
    ext === ".png" ? "image/png" :
    ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
    "application/octet-stream";

  const baseHeaders: Record<string, string> = {
    "Content-Type": mime,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=0",
  };
  if (download) {
    baseHeaders["Content-Disposition"] = `attachment; filename="${path.basename(target)}"`;
  }

  const rangeHeader = req.headers.get("range");
  if (rangeHeader) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        return new Response("Range Not Satisfiable", {
          status: 416,
          headers: { "Content-Range": `bytes */${size}` },
        });
      }
      const chunkSize = end - start + 1;
      return new Response(streamFile(target, start, end), {
        status: 206,
        headers: {
          ...baseHeaders,
          "Content-Length": String(chunkSize),
          "Content-Range": `bytes ${start}-${end}/${size}`,
        },
      });
    }
  }

  return new Response(streamFile(target), {
    headers: {
      ...baseHeaders,
      "Content-Length": String(size),
    },
  });
}

function normalizeRequestedPath(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    if (path.isAbsolute(decoded)) return null;

    const normalized = path.normalize(decoded).replaceAll("\\", "/");
    const safeParts = normalized.split("/").filter((segment) => segment.length > 0);
    if (safeParts.includes("..")) return null;
    if (safeParts.length === 0) return "final.mp4";
    return safeParts.join(path.sep);
  } catch {
    return null;
  }
}
