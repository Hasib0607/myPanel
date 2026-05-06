import bcrypt from "bcrypt";
import type { FastifyPluginAsync } from "fastify";
import { generateSecret, generateURI, verify } from "otplib";
import QRCode from "qrcode";
import { z } from "zod";
import { env } from "../config/env.js";
import { encryptSecret } from "../lib/crypto.js";
import { prisma } from "../lib/prisma.js";

const passwordSchema = z.object({
  password: z.string().min(1)
});

const verifySetupSchema = z.object({
  secret: z.string().min(16),
  token: z.string().regex(/^\d{6}$/)
});

export const twoFactorRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireAuth);

  app.get("/status", async () => {
    const security = await prisma.superadminSecurity.upsert({
      where: { id: "superadmin" },
      create: {},
      update: {}
    });

    return { enabled: security.totpEnabled };
  });

  app.post("/setup", async (request, reply) => {
    const body = passwordSchema.parse(request.body);
    const passwordMatches = await bcrypt.compare(body.password, env.SUPERADMIN_PASSWORD_HASH);
    if (!passwordMatches) {
      return reply.code(401).send({ error: "Invalid password" });
    }

    const secret = generateSecret();
    const uri = generateURI({
      issuer: env.TOTP_ISSUER,
      label: env.SUPERADMIN_USERNAME,
      secret,
      algorithm: "sha1",
      digits: 6,
      period: 30
    });
    const qrCodeDataUrl = await QRCode.toDataURL(uri);

    return { secret, uri, qrCodeDataUrl };
  });

  app.post("/enable", async (request, reply) => {
    const body = verifySetupSchema.parse(request.body);
    const result = await verify({
      token: body.token,
      secret: body.secret,
      algorithm: "sha1",
      digits: 6,
      period: 30,
      epochTolerance: 90
    });
    const valid = result.valid;
    if (!valid) {
      return reply.code(401).send({ error: "Invalid authenticator code" });
    }

    await prisma.superadminSecurity.upsert({
      where: { id: "superadmin" },
      create: {
        totpEnabled: true,
        totpSecretEncrypted: encryptSecret(body.secret),
        lastTotpAt: new Date()
      },
      update: {
        totpEnabled: true,
        totpSecretEncrypted: encryptSecret(body.secret),
        lastTotpAt: new Date()
      }
    });

    return { enabled: true };
  });

  app.post("/disable", async (request, reply) => {
    const body = passwordSchema.parse(request.body);
    const passwordMatches = await bcrypt.compare(body.password, env.SUPERADMIN_PASSWORD_HASH);
    if (!passwordMatches) {
      return reply.code(401).send({ error: "Invalid password" });
    }

    await prisma.superadminSecurity.upsert({
      where: { id: "superadmin" },
      create: {},
      update: {
        totpEnabled: false,
        totpSecretEncrypted: null,
        recoveryCodesHash: []
      }
    });

    return { enabled: false };
  });
};
