import bcrypt from "bcrypt";
import { createHash } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { audit } from "../lib/audit.js";
import { createCsrfToken, csrfCookieName } from "../lib/csrf.js";
import { decryptSecret } from "../lib/crypto.js";
import { deviceFingerprintMatches, enforceDeviceFingerprint, requestDeviceFingerprintDigest, requestDeviceFingerprintStableDigest } from "../lib/deviceFingerprint.js";
import { prisma } from "../lib/prisma.js";
import { verifyAuthenticationResponse, webauthnChallenge, webauthnChallengeTtlSeconds, webauthnOrigin, webauthnRpId } from "../lib/webauthn.js";
import { verify } from "otplib";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  deviceFingerprint: z.string().min(8).max(512).optional()
});

const twoFactorLoginSchema = z.object({
  challengeToken: z.string().min(20),
  token: z.string().regex(/^\d{6}$/),
  deviceFingerprint: z.string().min(8).max(512).optional()
});

const trustedDeviceLoginSchema = z.object({
  username: z.string().min(1),
  deviceSecret: z.string().min(32).max(256)
});

const webauthnLoginOptionsSchema = z.object({
  username: z.string().min(1)
});

const webauthnLoginVerifySchema = z.object({
  username: z.string().min(1),
  challengeToken: z.string().min(20),
  credential: z.object({
    id: z.string().min(1),
    rawId: z.string().min(1),
    response: z.object({
      authenticatorData: z.string().min(1),
      clientDataJSON: z.string().min(1),
      signature: z.string().min(1),
      userHandle: z.string().nullable().optional()
    }),
    type: z.literal("public-key")
  })
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

  function sessionPayload(request: FastifyRequest, payload: Record<string, unknown>, explicitFingerprint?: unknown) {
    const dfp = requestDeviceFingerprintDigest(request, explicitFingerprint);
    return dfp ? { ...payload, dfp } : payload;
  }

  function hashDeviceSecret(secret: string) {
    return createHash("sha256").update(secret).digest("hex");
  }

  function trustedDeviceCookieMatches(request: FastifyRequest, deviceId: string, fingerprintHash: string) {
    const token = request.cookies.panel_trusted_device;
    if (!token) return false;
    try {
      const payload = app.jwt.verify(token) as {
        trustedDeviceId?: string;
        fingerprintHash?: string;
        role?: string;
      };
      return payload.role === "superadmin" && payload.trustedDeviceId === deviceId && payload.fingerprintHash === fingerprintHash;
    } catch {
      return false;
    }
  }

  function parseChallengeToken(token: string) {
    try {
      return app.jwt.verify(token) as {
        purpose?: string;
        role?: string;
        username?: string;
        challenge?: string;
        rpId?: string;
        origin?: string;
        fingerprintHash?: string;
      };
    } catch {
      return null;
    }
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
      const payload = sessionPayload(request, { sub: env.SUPERADMIN_USERNAME, role: "superadmin", mfa: "pending" }, body.deviceFingerprint);
      const challengeToken = app.jwt.sign(
        payload,
        { expiresIn: 300 }
      );
      return { requiresTwoFactor: true, challengeToken };
    }

    const token = app.jwt.sign(sessionPayload(request, { sub: env.SUPERADMIN_USERNAME, role: "superadmin" }, body.deviceFingerprint), { expiresIn: env.JWT_EXPIRY });
    reply.clearCookie("account_session", { path: "/" });
    reply.setCookie("panel_session", token, authCookieOptions(request, env.JWT_EXPIRY));
    setCsrfCookie(request, reply);
    await audit(request, { action: "LOGIN", resource: "auth", description: "Superadmin logged in without 2FA" });

    return { ok: true };
  });

  app.post("/login/device", { config: { rateLimit: { max: 12, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const body = trustedDeviceLoginSchema.parse(request.body);
    if (body.username !== env.SUPERADMIN_USERNAME) {
      await audit(request, {
        action: "LOGIN",
        resource: "auth",
        description: "Failed trusted device login",
        metadata: { username: body.username, success: false, reason: "username" }
      });
      return reply.code(401).send({ error: "This device is not registered for passwordless login." });
    }

    const fingerprintHash = requestDeviceFingerprintStableDigest(request);
    if (!fingerprintHash) return reply.code(401).send({ error: "This browser is not registered for passwordless login." });

    const device = await prisma.trustedLoginDevice.findUnique({
      where: {
        role_username_fingerprintHash: {
          role: "superadmin",
          username: env.SUPERADMIN_USERNAME,
          fingerprintHash
        }
      }
    });

    const secretMatches = Boolean(device && !device.revokedAt && device.secretHash === hashDeviceSecret(body.deviceSecret));
    const cookieMatches = Boolean(device && !device.revokedAt && trustedDeviceCookieMatches(request, device.id, fingerprintHash));
    if (!device || device.revokedAt || (!secretMatches && !cookieMatches)) {
      await audit(request, {
        action: "LOGIN",
        resource: "auth",
        description: "Failed trusted device login",
        metadata: { username: body.username, success: false, reason: "device" }
      });
      return reply.code(401).send({ error: "This device is not registered for passwordless login." });
    }

    await prisma.trustedLoginDevice.update({
      where: { id: device.id },
      data: { lastUsedAt: new Date() }
    });

    const security = await prisma.superadminSecurity.findUnique({ where: { id: "superadmin" } });
    if (security?.totpEnabled) {
      const payload = sessionPayload(request, { sub: env.SUPERADMIN_USERNAME, role: "superadmin", mfa: "pending", deviceLogin: true });
      const challengeToken = app.jwt.sign(payload, { expiresIn: 300 });
      return { requiresTwoFactor: true, challengeToken };
    }

    const token = app.jwt.sign(sessionPayload(request, { sub: env.SUPERADMIN_USERNAME, role: "superadmin", deviceLogin: true }), { expiresIn: env.JWT_EXPIRY });
    reply.clearCookie("account_session", { path: "/" });
    reply.setCookie("panel_session", token, authCookieOptions(request, env.JWT_EXPIRY));
    setCsrfCookie(request, reply);
    await audit(request, {
      action: "LOGIN",
      resource: "auth",
      description: "Superadmin logged in with trusted device",
      metadata: { trustedDeviceId: device.id }
    });

    return { ok: true };
  });

  app.post("/login/webauthn/options", { config: { rateLimit: { max: 12, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const body = webauthnLoginOptionsSchema.parse(request.body);
    if (body.username !== env.SUPERADMIN_USERNAME) {
      await audit(request, {
        action: "LOGIN",
        resource: "auth",
        description: "Failed biometric login options",
        metadata: { username: body.username, success: false, reason: "username" }
      });
      return reply.code(401).send({ error: "This device is not registered for biometric login." });
    }

    const fingerprintHash = requestDeviceFingerprintStableDigest(request);
    if (!fingerprintHash) return reply.code(401).send({ error: "This browser is not registered for biometric login." });

    const device = await prisma.trustedLoginDevice.findUnique({
      where: {
        role_username_fingerprintHash: {
          role: "superadmin",
          username: env.SUPERADMIN_USERNAME,
          fingerprintHash
        }
      }
    });

    if (!device || device.revokedAt || !device.webauthnCredentialId || !device.webauthnPublicKey) {
      return reply.code(401).send({ error: "This device is not registered for biometric login. Register or update it from Settings first." });
    }

    const rpId = webauthnRpId(request);
    const origin = webauthnOrigin(request);
    const challenge = webauthnChallenge();
    const challengeToken = app.jwt.sign(
      {
        purpose: "trusted-device-login",
        role: "superadmin",
        username: env.SUPERADMIN_USERNAME,
        fingerprintHash,
        challenge,
        rpId,
        origin
      },
      { expiresIn: webauthnChallengeTtlSeconds }
    );

    return {
      challengeToken,
      publicKey: {
        challenge,
        timeout: 60000,
        rpId,
        userVerification: "required",
        allowCredentials: [{ id: device.webauthnCredentialId, type: "public-key" }]
      }
    };
  });

  app.post("/login/webauthn/verify", { config: { rateLimit: { max: 12, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const body = webauthnLoginVerifySchema.parse(request.body);
    const payload = parseChallengeToken(body.challengeToken);
    if (
      body.username !== env.SUPERADMIN_USERNAME ||
      !payload ||
      payload.purpose !== "trusted-device-login" ||
      payload.role !== "superadmin" ||
      payload.username !== env.SUPERADMIN_USERNAME ||
      !payload.challenge ||
      !payload.rpId ||
      !payload.origin ||
      !payload.fingerprintHash
    ) {
      return reply.code(401).send({ error: "Biometric login expired. Please try again." });
    }

    const fingerprintHash = requestDeviceFingerprintStableDigest(request);
    if (!fingerprintHash || fingerprintHash !== payload.fingerprintHash) {
      return reply.code(401).send({ error: "Device verification failed. Please try again from the same browser." });
    }

    const device = await prisma.trustedLoginDevice.findUnique({
      where: {
        role_username_fingerprintHash: {
          role: "superadmin",
          username: env.SUPERADMIN_USERNAME,
          fingerprintHash
        }
      }
    });
    if (!device || device.revokedAt || !device.webauthnCredentialId || !device.webauthnPublicKey || body.credential.rawId !== device.webauthnCredentialId) {
      return reply.code(401).send({ error: "This device is not registered for biometric login." });
    }

    let result;
    try {
      result = verifyAuthenticationResponse({
        authenticatorData: body.credential.response.authenticatorData,
        clientDataJSON: body.credential.response.clientDataJSON,
        credentialId: body.credential.rawId,
        signature: body.credential.response.signature,
        publicKey: device.webauthnPublicKey,
        challenge: payload.challenge,
        origin: payload.origin,
        rpId: payload.rpId
      });
    } catch (error) {
      await audit(request, {
        action: "LOGIN",
        resource: "auth",
        description: "Failed biometric trusted device login",
        metadata: { username: body.username, success: false, reason: error instanceof Error ? error.message : "verification" }
      });
      return reply.code(401).send({ error: error instanceof Error ? error.message : "Biometric login failed" });
    }

    await prisma.trustedLoginDevice.update({
      where: { id: device.id },
      data: {
        lastUsedAt: new Date(),
        webauthnSignCount: result.signCount
      }
    });

    const token = app.jwt.sign(sessionPayload(request, { sub: env.SUPERADMIN_USERNAME, role: "superadmin", deviceLogin: true, mfa: "biometric" }), { expiresIn: env.JWT_EXPIRY });
    reply.clearCookie("account_session", { path: "/" });
    reply.setCookie("panel_session", token, authCookieOptions(request, env.JWT_EXPIRY));
    setCsrfCookie(request, reply);
    await audit(request, {
      action: "LOGIN",
      resource: "auth",
      description: "Superadmin logged in with biometric trusted device",
      metadata: { trustedDeviceId: device.id }
    });

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

    const token = app.jwt.sign(sessionPayload(request, { sub: account.username, role: "account", accountId: account.id }, body.deviceFingerprint), { expiresIn: env.JWT_EXPIRY });
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
    const token = app.jwt.sign(sessionPayload(request, { sub: email, role: "mail", mailAccountId: mailbox.id }, body.deviceFingerprint), { expiresIn: env.JWT_EXPIRY });
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

    const token = app.jwt.sign(sessionPayload(request, { sub: account.username, role: "account", accountId: account.id }), { expiresIn: env.JWT_EXPIRY });
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
    const requestFingerprint = requestDeviceFingerprintDigest(request, body.deviceFingerprint);
    if (challenge.dfp && !deviceFingerprintMatches(challenge.dfp, requestFingerprint)) {
      return reply.code(401).send({ error: "Device verification failed. Please log in again from this browser." });
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

    const token = app.jwt.sign(
      {
        sub: env.SUPERADMIN_USERNAME,
        role: "superadmin",
        mfa: "verified",
        ...(challenge.dfp ? { dfp: challenge.dfp } : requestFingerprint ? { dfp: requestFingerprint } : {})
      },
      { expiresIn: env.JWT_EXPIRY }
    );
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
      if (enforceDeviceFingerprint(request, reply)) return;
    } catch {
      const token = request.cookies.account_session ?? request.cookies.mail_session;
      if (!token) return reply.code(401).send({ error: "Unauthorized" });
      try {
        request.user = app.jwt.verify(token);
        if (enforceDeviceFingerprint(request, reply)) return;
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
