import bcrypt from "bcrypt";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { audit } from "../lib/audit.js";
import { createCsrfToken, csrfCookieName } from "../lib/csrf.js";
import { decryptSecret } from "../lib/crypto.js";
import { prisma } from "../lib/prisma.js";
import { verify } from "otplib";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

const twoFactorLoginSchema = z.object({
  challengeToken: z.string().min(20),
  token: z.string().regex(/^\d{6}$/)
});

export const authRoutes: FastifyPluginAsync = async (app) => {
  function clearAuthCookies(reply: any) {
    reply.clearCookie("panel_session", { path: "/" });
    reply.clearCookie("account_session", { path: "/" });
    reply.clearCookie(csrfCookieName, { path: "/" });
  }

  function setCsrfCookie(reply: any) {
    const csrfToken = createCsrfToken();
    reply.setCookie(csrfCookieName, csrfToken, {
      httpOnly: false,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/"
    });
    return csrfToken;
  }

  app.get("/csrf", async (_request, reply) => ({ token: setCsrfCookie(reply) }));

  app.post("/login", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const usernameMatches = body.username === env.SUPERADMIN_USERNAME;
    const passwordMatches = await bcrypt.compare(body.password, env.SUPERADMIN_PASSWORD_HASH);

    if (!usernameMatches || !passwordMatches) {
      await audit(request, {
        action: "LOGIN",
        resource: "auth",
        description: "Failed superadmin login",
        metadata: { username: body.username, success: false }
      });
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    const security = await prisma.superadminSecurity.findUnique({ where: { id: "superadmin" } });
    if (security?.totpEnabled) {
      const challengeToken = app.jwt.sign(
        { sub: env.SUPERADMIN_USERNAME, role: "superadmin", mfa: "pending" },
        { expiresIn: 300 }
      );
      return { requiresTwoFactor: true, challengeToken };
    }

    const token = app.jwt.sign({ sub: env.SUPERADMIN_USERNAME, role: "superadmin" }, { expiresIn: env.JWT_EXPIRY });
    reply.clearCookie("account_session", { path: "/" });
    reply.setCookie("panel_session", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: env.JWT_EXPIRY
    });
    setCsrfCookie(reply);
    await audit(request, { action: "LOGIN", resource: "auth", description: "Superadmin logged in without 2FA" });

    return { ok: true };
  });

  app.post("/account/login", { config: { rateLimit: { max: 8, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const account = await prisma.account.findFirst({
      where: { OR: [{ username: body.username.toLowerCase() }, { email: body.username }] }
    });
    const passwordMatches = account ? await bcrypt.compare(body.password, account.passwordHash) : false;

    if (!account || !passwordMatches || account.status !== "ACTIVE") {
      await audit(request, {
        action: "LOGIN",
        resource: "account_auth",
        description: "Failed account login",
        metadata: { username: body.username, success: false }
      });
      return reply.code(401).send({ error: "Invalid account credentials" });
    }

    const token = app.jwt.sign({ sub: account.username, role: "account", accountId: account.id }, { expiresIn: env.JWT_EXPIRY });
    reply.clearCookie("panel_session", { path: "/" });
    reply.setCookie("account_session", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: env.JWT_EXPIRY
    });
    setCsrfCookie(reply);
    await audit(request, { action: "LOGIN", resource: "account_auth", resourceId: account.id, description: `Account ${account.username} logged in` });
    return { ok: true, role: "account" };
  });

  app.post("/login/2fa", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const body = twoFactorLoginSchema.parse(request.body);
    let challenge: any;
    try {
      challenge = app.jwt.verify(body.challengeToken);
    } catch {
      return reply.code(401).send({ error: "Invalid or expired challenge" });
    }

    if (challenge.sub !== env.SUPERADMIN_USERNAME || challenge.mfa !== "pending") {
      return reply.code(401).send({ error: "Invalid challenge" });
    }

    const security = await prisma.superadminSecurity.findUnique({ where: { id: "superadmin" } });
    if (!security?.totpEnabled || !security.totpSecretEncrypted) {
      return reply.code(409).send({ error: "Two-factor authentication is not enabled" });
    }

    const secret = decryptSecret(security.totpSecretEncrypted);
    const result = await verify({
      token: body.token,
      secret,
      algorithm: "sha1",
      digits: 6,
      period: 30,
      epochTolerance: 90
    });
    const valid = result.valid;
    if (!valid) {
      await audit(request, {
        action: "LOGIN",
        resource: "auth",
        description: "Failed superadmin 2FA login",
        metadata: { success: false, twoFactor: true }
      });
      return reply.code(401).send({ error: "Invalid authenticator code" });
    }

    await prisma.superadminSecurity.update({
      where: { id: "superadmin" },
      data: { lastTotpAt: new Date() }
    });

    const token = app.jwt.sign({ sub: env.SUPERADMIN_USERNAME, role: "superadmin", mfa: "verified" }, { expiresIn: env.JWT_EXPIRY });
    reply.clearCookie("account_session", { path: "/" });
    reply.setCookie("panel_session", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: env.JWT_EXPIRY
    });
    setCsrfCookie(reply);
    await audit(request, { action: "LOGIN", resource: "auth", description: "Superadmin completed 2FA login" });

    return { ok: true };
  });

  app.post("/logout", async (request, reply) => {
    clearAuthCookies(reply);
    await audit(request, { action: "LOGOUT", resource: "auth", description: "User logged out" });
    return { ok: true };
  });

  app.get("/logout", async (request, reply) => {
    clearAuthCookies(reply);
    const next = typeof (request.query as any)?.next === "string" ? (request.query as any).next : "/login";
    return reply.redirect(next.startsWith("/") ? next : "/login");
  });

  app.get("/me", async (request: any, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      const token = request.cookies.account_session;
      if (!token) return reply.code(401).send({ error: "Unauthorized" });
      try {
        request.user = app.jwt.verify(token);
      } catch {
        return reply.code(401).send({ error: "Unauthorized" });
      }
    }
    try {
      if (request.user?.role === "account") {
        const account = await prisma.account.findUnique({ where: { id: request.user.accountId } });
        return {
          username: account?.username ?? request.user.sub,
          role: "account",
          accountId: request.user.accountId,
          status: account?.status ?? "UNKNOWN"
        };
      }
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    return {
      username: env.SUPERADMIN_USERNAME,
      role: "superadmin"
    };
  });
};
