import crypto from "node:crypto";

export const csrfCookieName = "panel_csrf";
export const csrfHeaderName = "x-csrf-token";

export function createCsrfToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function validCsrfPair(cookieToken: string | undefined, headerToken: string | string[] | undefined) {
  const header = Array.isArray(headerToken) ? headerToken[0] : headerToken;
  if (!cookieToken || !header) return false;
  const left = Buffer.from(cookieToken);
  const right = Buffer.from(header);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
