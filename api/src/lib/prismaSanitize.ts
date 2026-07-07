import { Prisma } from "@prisma/client";

const POSTGRES_TEXT_UNSUPPORTED_PATTERN = /\u0000/g;

export function sanitizePrismaText(value: string) {
  return value.replace(POSTGRES_TEXT_UNSUPPORTED_PATTERN, "");
}

export function sanitizePrismaJson(value: Prisma.InputJsonValue): Prisma.InputJsonValue;
export function sanitizePrismaJson(value: null | undefined): null | undefined;
export function sanitizePrismaJson(value: Prisma.InputJsonValue | null | undefined): Prisma.InputJsonValue | null | undefined {
  if (typeof value === "string") return sanitizePrismaText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizePrismaJson(item as Prisma.InputJsonValue));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sanitizePrismaJson(item as Prisma.InputJsonValue)])
  );
}
