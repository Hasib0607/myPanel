import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { ZodError } from "zod";
import { env } from "./config/env.js";
import { csrfCookieName, csrfHeaderName, validCsrfPair } from "./lib/csrf.js";
import { authRoutes } from "./routes/auth.js";
import { auditRoutes } from "./routes/audit.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { databaseRoutes } from "./routes/databases.js";
import { deploymentRoutes } from "./routes/deployments.js";
import { deploymentWebhookRoutes } from "./routes/deploymentWebhooks.js";
import { terminalRoutes } from "./routes/terminal.js";
import { dnsRoutes } from "./routes/dns.js";
import { domainRoutes } from "./routes/domains.js";
import { fileRoutes } from "./routes/files.js";
import { firewallRoutes } from "./routes/firewall.js";
import { guardianRoutes } from "./routes/guardian.js";
import { mailRoutes } from "./routes/mail.js";
import { sslRoutes } from "./routes/ssl.js";
import { twoFactorRoutes } from "./routes/twoFactor.js";

export function buildApp() {
  const app = Fastify({ logger: true });

  app.register(cors, {
    origin: env.FRONTEND_URL,
    credentials: true
  });
  app.register(cookie);
  app.register(jwt, {
    secret: env.JWT_SECRET,
    cookie: {
      cookieName: "panel_session",
      signed: false
    }
  });
  app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute"
  });
  app.register(sensible);
  app.register(websocket);

  app.addHook("onRequest", async (_request, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "geolocation=(), microphone=(), camera=()");
    reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  });

  app.addHook("preHandler", async (request, reply) => {
    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    if (!unsafe || request.url.startsWith("/api/v1/auth/login") || request.url.startsWith("/api/v1/webhooks/")) return;

    if (!validCsrfPair(request.cookies[csrfCookieName], request.headers[csrfHeaderName])) {
      return reply.code(403).send({ error: "Invalid CSRF token" });
    }
  });

  app.decorate("requireAuth", async (request: any, reply: any) => {
    try {
      await request.jwtVerify();
    } catch {
      reply.code(401).send({ error: "Unauthorized" });
    }
  });

  app.get("/health", async () => ({ ok: true }));

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      request.log.warn({ issues: error.issues }, "validation failed");
      return reply.code(400).send({
        error: "Validation failed",
        issues: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      });
    }

    request.log.error(error);
    const statusCode = typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
    const message = error instanceof Error ? error.message : "Internal server error";
    return reply.code(statusCode).send({
      error: message
    });
  });

  app.register(authRoutes, { prefix: "/api/v1/auth" });
  app.register(auditRoutes, { prefix: "/api/v1/audit" });
  app.register(twoFactorRoutes, { prefix: "/api/v1/auth/2fa" });
  app.register(dashboardRoutes, { prefix: "/api/v1/dashboard" });
  app.register(databaseRoutes, { prefix: "/api/v1/databases" });
  app.register(domainRoutes, { prefix: "/api/v1/domains" });
  app.register(dnsRoutes, { prefix: "/api/v1/dns" });
  app.register(mailRoutes, { prefix: "/api/v1/mail" });
  app.register(sslRoutes, { prefix: "/api/v1/ssl" });
  app.register(firewallRoutes, { prefix: "/api/v1/firewall" });
  app.register(guardianRoutes, { prefix: "/api/v1/guardian" });
  app.register(fileRoutes, { prefix: "/api/v1/files" });
  app.register(deploymentRoutes, { prefix: "/api/v1/deployments" });
  app.register(deploymentWebhookRoutes, { prefix: "/api/v1/webhooks" });
  app.register(terminalRoutes, { prefix: "/api/v1/terminal" });

  return app;
}
