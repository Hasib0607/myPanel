import type { FastifyRequest } from "fastify";
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";

export type AuditAction =
  | "CREATE"
  | "UPDATE"
  | "DELETE"
  | "DEPLOY"
  | "START"
  | "STOP"
  | "RESTART"
  | "ROLLBACK"
  | "APPLY"
  | "LOGIN"
  | "LOGOUT";

export async function audit(request: FastifyRequest | null, input: {
  action: AuditAction;
  resource: string;
  resourceId?: string | null;
  description?: string | null;
  metadata?: Prisma.InputJsonValue;
}) {
  await prisma.auditLog.create({
    data: {
      actor: "superadmin",
      action: input.action,
      resource: input.resource,
      resourceId: input.resourceId ?? null,
      description: input.description ?? null,
      metadata: input.metadata ?? {},
      ipAddress: request?.ip,
      userAgent: typeof request?.headers["user-agent"] === "string" ? request.headers["user-agent"] : null
    }
  }).catch((error) => {
    request?.log.warn({ error }, "audit log write failed");
  });
}
