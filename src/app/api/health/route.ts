import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Public liveness endpoint for Railway / any uptime monitor.
 *
 * Intentionally trivial — no DB hit, no external API call. Just confirms
 * the Node process is up and the route layer is wired. Real failure
 * modes (DB corrupt, OAuth dead, etc.) surface in /logs and the relevant
 * UI cards instead of taking the whole service offline via healthcheck.
 *
 * The Basic Auth proxy explicitly excludes this path so Railway's probe
 * (which sends no auth headers) gets a 200 rather than a 401. Without
 * that exemption, healthchecks would fail forever in production.
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    ts: Math.floor(Date.now() / 1000),
  });
}
