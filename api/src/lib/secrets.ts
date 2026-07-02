import type { Prisma } from "@prisma/client";
import { encryptSecret, decryptSecret } from "./crypto.js";
import { prisma } from "./prisma.js";

export type SecretKind =
  | "GITHUB_TOKEN"
  | "DEPLOYMENT_ENV"
  | "DATABASE_PASSWORD"
  | "DATABASE_URL"
  | "MAIL_PASSWORD"
  | "WEBHOOK_SECRET"
  | "GENERIC";

export async function putSecret(input: {
  ref: string;
  value: string;
  kind: SecretKind;
  label?: string | null;
  metadata?: Prisma.InputJsonValue;
}) {
  return prisma.secret.upsert({
    where: { ref: input.ref },
    update: {
      encryptedValue: encryptSecret(input.value),
      kind: input.kind,
      label: input.label ?? undefined,
      metadata: input.metadata ?? undefined
    },
    create: {
      ref: input.ref,
      encryptedValue: encryptSecret(input.value),
      kind: input.kind,
      label: input.label ?? undefined,
      metadata: input.metadata ?? {}
    }
  });
}

export async function getSecret(ref: string) {
  const secret = await prisma.secret.findUnique({ where: { ref } });
  return secret ? decryptSecret(secret.encryptedValue) : null;
}

export async function getSecretRecord(ref: string) {
  const secret = await prisma.secret.findUnique({ where: { ref } });
  if (!secret) return null;
  return {
    ...secret,
    value: decryptSecret(secret.encryptedValue)
  };
}

export async function deleteSecret(ref: string) {
  await prisma.secret.delete({ where: { ref } }).catch(() => null);
}
