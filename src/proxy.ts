import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";

export async function proxy(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  if (host === "127.0.0.1" || host.startsWith("127.0.0.1:")) {
    const url = req.nextUrl.clone();
    url.hostname = "localhost";
    return NextResponse.redirect(url);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // No Supabase configured — pass through (local dev without auth)
  if (!supabaseUrl || !supabaseKey) return NextResponse.next();

  const { pathname } = req.nextUrl;

  // Auth API routes are always public
  if (pathname.startsWith("/api/auth/")) return NextResponse.next();

  let res = NextResponse.next({ request: req });

  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (cookiesToSet) =>
        cookiesToSet.forEach(({ name, value, options }) =>
          res.cookies.set(name, value, options)
        ),
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (pathname === "/login") {
    // Already authenticated — bounce to home
    if (user) return NextResponse.redirect(new URL("/", req.url));
    return NextResponse.next();
  }

  if (!user) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  // Admin-only routes — non-admins get bounced to home
  if (pathname.startsWith("/admin")) {
    const role = user.app_metadata?.role;
    if (role !== "admin") {
      return NextResponse.redirect(new URL("/", req.url));
    }
  }

  return res;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|api/health).*)",
  ],
};
