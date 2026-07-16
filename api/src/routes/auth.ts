import bcrypt from "bcrypt";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
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
  function requestUsesHttps(request: FastifyRequest) {
    const forwardedProto = String(request.headers["x-forwarded-proto"] ?? "")
      .split(",")[0]
      .trim()
      .toLowerCase();
    if (forwardedProto) return forwardedProto === "https";
    return request.protocol === "https" || Boolean((request.raw.socket as any).encrypted);
  }

  function authCookieOptions(request: FastifyRequest, maxAge?: number) {
    return {
      httpOnly: true,
      secure: requestUsesHttps(request),
      sameSite: "strict" as const,
      path: "/",
      ...(maxAge ? { maxAge } : {})
    };
  }

  function clearAuthCookies(reply: FastifyReply) {
    reply.clearCookie("panel_session", { path: "/" });
    reply.clearCookie("account_session", { path: "/" });
    reply.clearCookie("mail_session", { path: "/" });
    reply.clearCookie(csrfCookieName, { path: "/" });
  }

  function setCsrfCookie(request: FastifyRequest, reply: FastifyReply) {
    const csrfToken = createCsrfToken();
    reply.setCookie(csrfCookieName, csrfToken, {
      httpOnly: false,
      secure: requestUsesHttps(request),
      sameSite: "strict",
      path: "/"
    });
    return csrfToken;
  }

  app.get("/csrf", async (request, reply) => ({ token: setCsrfCookie(request, reply) }));

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
    reply.setCookie("panel_session", token, authCookieOptions(request, env.JWT_EXPIRY));
    setCsrfCookie(request, reply);
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
    reply.setCookie("account_session", token, authCookieOptions(request, env.JWT_EXPIRY));
    setCsrfCookie(request, reply);
    await audit(request, { action: "LOGIN", resource: "account_auth", resourceId: account.id, description: `Account ${account.username} logged in` });
    return { ok: true, role: "account" };
  });

  app.post("/mail/login", { config: { rateLimit: { max: 8, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const [username, domainName] = body.username.trim().toLowerCase().split("@");
    if (!username || !domainName) {
      return reply.code(401).send({ error: "Invalid mailbox credentials" });
    }

    const mailbox = await prisma.mailAccount.findFirst({
      where: {
        username,
        domain: { name: domainName }
      },
      include: {
        domain: { select: { name: true } },
        account: { select: { status: true } }
      }
    });
    const passwordMatches = mailbox ? await bcrypt.compare(body.password, mailbox.passwordHash) : false;

    if (!mailbox || !passwordMatches || !mailbox.enabled || mailbox.account?.status === "SUSPENDED") {
      await audit(request, {
        action: "LOGIN",
        resource: "mail_auth",
        description: "Failed mailbox login",
        metadata: { username: body.username, success: false }
      });
      return reply.code(401).send({ error: "Invalid mailbox credentials" });
    }

    const email = `${mailbox.username}@${mailbox.domain.name}`;
    const token = app.jwt.sign({ sub: email, role: "mail", mailAccountId: mailbox.id }, { expiresIn: env.JWT_EXPIRY });
    reply.clearCookie("panel_session", { path: "/" });
    reply.clearCookie("account_session", { path: "/" });
    reply.setCookie("mail_session", token, authCookieOptions(request, env.JWT_EXPIRY));
    setCsrfCookie(request, reply);
    await audit(request, { action: "LOGIN", resource: "mail_auth", resourceId: mailbox.id, description: `Mailbox ${email} logged in` });
    return { ok: true, role: "mail", email, redirectTo: "/webmail" };
  });

  app.post("/account/:accountId/impersonate", { preHandler: app.requireAuth }, async (request, reply) => {
    const { accountId } = z.object({ accountId: z.string().min(1) }).parse(request.params);
    const account = await prisma.account.findFirst({
      where: { OR: [{ id: accountId }, { username: accountId.toLowerCase() }] }
    });

    if (!account) {
      return reply.code(404).send({ error: "Account not found" });
    }
    if (account.status !== "ACTIVE") {
      return reply.code(403).send({ error: "Account is suspended or unavailable" });
    }

    const token = app.jwt.sign({ sub: account.username, role: "account", accountId: account.id }, { expiresIn: env.JWT_EXPIRY });
    reply.setCookie("account_session", token, authCookieOptions(request, env.JWT_EXPIRY));
    setCsrfCookie(request, reply);
    await audit(request, {
      action: "LOGIN",
      resource: "account_auth",
      resourceId: account.id,
      description: `Superadmin logged in as account ${account.username}`,
      metadata: { impersonatedBy: env.SUPERADMIN_USERNAME }
    });

    return { ok: true, role: "account", accountId: account.id, username: account.username, redirectTo: "/account" };
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
    reply.setCookie("panel_session", token, authCookieOptions(request, env.JWT_EXPIRY));
    setCsrfCookie(request, reply);
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
      const token = request.cookies.account_session ?? request.cookies.mail_session;
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
      if (request.user?.role === "mail") {
        const mailbox = await prisma.mailAccount.findUnique({
          where: { id: request.user.mailAccountId },
          include: { domain: { select: { name: true } } }
        });
        if (!mailbox) return reply.code(401).send({ error: "Unauthorized" });
        return {
          username: `${mailbox.username}@${mailbox.domain.name}`,
          role: "mail",
          mailAccountId: mailbox.id,
          status: mailbox.enabled ? "ACTIVE" : "DISABLED"
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
