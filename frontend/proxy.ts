import { NextRequest, NextResponse } from "next/server";

const protectedRoutes = [
  "/dashboard",
  "/accounts",
  "/domains",
  "/dns",
  "/mail",
  "/firewall",
  "/guardian",
  "/files",
  "/deployments",
  "/terminal",
  "/security"
];

const accountRoutes = ["/account"];
const webmailRoutes = ["/webmail"];

function requestPort(request: NextRequest) {
  const forwardedPort = request.headers.get("x-forwarded-port");
  if (forwardedPort) return forwardedPort;
  if (request.nextUrl.port) return request.nextUrl.port;
  const host = request.headers.get("host") ?? "";
  const match = host.match(/:(\d+)$/);
  if (match) return match[1];
  return request.nextUrl.protocol === "https:" ? "443" : "80";
}

function loginPortAllowed(request: NextRequest) {
  const loginPort = request.headers.get("x-panel-login-port") ?? process.env.PANEL_LOGIN_PORT ?? process.env.NEXT_PUBLIC_PANEL_LOGIN_PORT ?? "";
  const accountPort = process.env.CPANEL_LOGIN_PORT ?? process.env.NEXT_PUBLIC_CPANEL_LOGIN_PORT ?? "";
  const port = requestPort(request);
  return !loginPort || port === loginPort || (!!accountPort && port === accountPort);
}

function redirectToPanelPort(request: NextRequest, pathname: string, hasSession: boolean) {
  const loginPort = request.headers.get("x-panel-login-port") ?? process.env.PANEL_LOGIN_PORT ?? process.env.NEXT_PUBLIC_PANEL_LOGIN_PORT ?? "";
  if (!loginPort) return null;

  const port = requestPort(request);
  if (port !== "80" && port !== "443") return null;

  const target = new URL(hasSession && pathname !== "/login" ? "/dashboard" : "/login", request.url);
  target.port = loginPort;
  return NextResponse.redirect(target);
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isProtected = protectedRoutes.some((route) => pathname === route || pathname.startsWith(`${route}/`));
  const isAccountProtected = accountRoutes.some((route) => pathname === route || pathname.startsWith(`${route}/`));
  const isWebmailProtected = webmailRoutes.some((route) => pathname === route || pathname.startsWith(`${route}/`));
  const hasSession = request.cookies.has("panel_session");
  const hasAccountSession = request.cookies.has("account_session");
  const hasMailSession = request.cookies.has("mail_session");

  if (pathname === "/") {
    return redirectToPanelPort(request, pathname, hasSession) ?? NextResponse.redirect(new URL(hasSession ? "/dashboard" : "/login", request.url));
  }

  if ((pathname === "/login" || isProtected) && !loginPortAllowed(request)) {
    return redirectToPanelPort(request, pathname, hasSession) ?? new NextResponse("Not found", { status: 404 });
  }

  if (isProtected && !hasSession) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (isAccountProtected && !hasAccountSession) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (pathname === "/webmail/login" && hasMailSession) {
    return NextResponse.redirect(new URL("/webmail", request.url));
  }

  if (isWebmailProtected && pathname !== "/webmail/login" && !hasMailSession) {
    const loginUrl = new URL("/webmail/login", request.url);
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
    "/",
    "/dashboard/:path*",
    "/accounts/:path*",
    "/domains/:path*",
    "/dns/:path*",
    "/mail/:path*",
    "/firewall/:path*",
    "/guardian/:path*",
    "/files/:path*",
    "/deployments/:path*",
    "/terminal/:path*",
    "/security/:path*",
    "/account/:path*",
    "/webmail/:path*",
    "/login"
  ]
};
