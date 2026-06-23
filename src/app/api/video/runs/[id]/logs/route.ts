import { getLogs, subscribe } from "@/lib/video-engine/logger";
import { ensureInit } from "@/lib/video-engine/init";
import { requireVideoRunAccess } from "@/lib/video-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;
  const access = await requireVideoRunAccess(id);
  if (!access.ok) {
    return Response.json(
      { error: access.status === 404 ? "run not found" : "Forbidden" },
      { status: access.status }
    );
  }

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`event: ${event}\n`));
          controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      for (const log of getLogs(id)) send("log", log);
      send("ready", { runId: id });

      const unsub = subscribe(id, (e) => send("log", e));
      const ping = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`: ping\n\n`));
        } catch {
          closed = true;
        }
      }, 15000);

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        unsub();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener("abort", close, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
