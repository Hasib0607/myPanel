import { NextRequest, NextResponse } from "next/server";

const protectedRoutes = [
  "/dashboard",
  "/domains",
  "/dns",
  "/mail",
  "/firewall",
  "/files",
  "/deployments",
  "/security"
];

const loginPort = process.env.PANEL_LOGIN_PORT ?? process.env.NEXT_PUBLIC_PANEL_LOGIN_PORT ?? "";

function requestPort(request: NextRequest) {
  if (request.nextUrl.port) return request.nextUrl.port;
  const host = request.headers.get("host") ?? "";
  const match = host.match(/:(\d+)$/);
  if (match) return match[1];
  return request.nextUrl.protocol === "https:" ? "443" : "80";
}

function loginPortAllowed(request: NextRequest) {
  return !loginPort || requestPort(request) === loginPort;
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isProtected = protectedRoutes.some((route) => pathname === route || pathname.startsWith(`${route}/`));
  const hasSession = request.cookies.has("panel_session");

  if ((pathname === "/login" || isProtected) && !loginPortAllowed(request)) {
    return new NextResponse("Not found", { status: 404 });
  }

  if (isProtected && !hasSession) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (pathname === "/login" && hasSession) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/domains/:path*",
    "/dns/:path*",
    "/mail/:path*",
    "/firewall/:path*",
    "/files/:path*",
    "/deployments/:path*",
    "/security/:path*",
    "/login"
  ]
};
