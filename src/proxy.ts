import { NextRequest, NextResponse } from "next/server";

export async function proxy(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  if (host === "127.0.0.1" || host.startsWith("127.0.0.1:")) {
    const url = req.nextUrl.clone();
    url.hostname = "localhost";
    return NextResponse.redirect(url);
  }

  // Standalone build: no auth gateway, no cloud database, one local admin.
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|api/health).*)",
  ],
};
