import { createHash, createPublicKey, createVerify, randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";

export const webauthnChallengeTtlSeconds = 300;

type CborResult = { value: unknown; offset: number };

export function base64UrlEncode(input: Buffer | Uint8Array | string) {
  return Buffer.from(input).toString("base64url");
}

export function base64UrlDecode(input: string) {
  return Buffer.from(input, "base64url");
}

export function webauthnChallenge() {
  return base64UrlEncode(randomBytes(32));
}

export function webauthnRpId(request: FastifyRequest) {
  const host = String(request.headers["x-forwarded-host"] ?? request.headers.host ?? "")
    .split(",")[0]
    .trim()
    .replace(/:\d+$/, "");
  return host || "localhost";
}

export function webauthnOrigin(request: FastifyRequest) {
  const origin = request.headers.origin;
  if (typeof origin === "string" && /^https?:\/\//i.test(origin)) return origin.replace(/\/$/, "");
  const proto = String(request.headers["x-forwarded-proto"] ?? "")
    .split(",")[0]
    .trim()
    .toLowerCase() || (request.protocol === "https" || Boolean((request.raw.socket as any).encrypted) ? "https" : "http");
  return `${proto}://${webauthnRpId(request)}`;
}

function readLength(buffer: Buffer, offset: number, additional: number): { length: number; offset: number } {
  if (additional < 24) return { length: additional, offset };
  if (additional === 24) return { length: buffer.readUInt8(offset), offset: offset + 1 };
  if (additional === 25) return { length: buffer.readUInt16BE(offset), offset: offset + 2 };
  if (additional === 26) return { length: buffer.readUInt32BE(offset), offset: offset + 4 };
  throw new Error("Unsupported CBOR length");
}

function decodeCbor(buffer: Buffer, offset = 0): CborResult {
  const initial = buffer.readUInt8(offset++);
  const major = initial >> 5;
  const additional = initial & 0x1f;

  if (major === 0) {
    const result = readLength(buffer, offset, additional);
    return { value: result.length, offset: result.offset };
  }
  if (major === 1) {
    const result = readLength(buffer, offset, additional);
    return { value: -1 - result.length, offset: result.offset };
  }
  if (major === 2 || major === 3) {
    const result = readLength(buffer, offset, additional);
    const bytes = buffer.subarray(result.offset, result.offset + result.length);
    return { value: major === 2 ? bytes : bytes.toString("utf8"), offset: result.offset + result.length };
  }
  if (major === 4) {
    const result = readLength(buffer, offset, additional);
    const items: unknown[] = [];
    let cursor = result.offset;
    for (let index = 0; index < result.length; index += 1) {
      const item = decodeCbor(buffer, cursor);
      items.push(item.value);
      cursor = item.offset;
    }
    return { value: items, offset: cursor };
  }
  if (major === 5) {
    const result = readLength(buffer, offset, additional);
    const map = new Map<unknown, unknown>();
    let cursor = result.offset;
    for (let index = 0; index < result.length; index += 1) {
      const key = decodeCbor(buffer, cursor);
      const value = decodeCbor(buffer, key.offset);
      map.set(key.value, value.value);
      cursor = value.offset;
    }
    return { value: map, offset: cursor };
  }
  if (major === 7) {
    if (additional === 20) return { value: false, offset };
    if (additional === 21) return { value: true, offset };
    if (additional === 22) return { value: null, offset };
  }
  throw new Error("Unsupported CBOR value");
}

function encodeDerLength(length: number) {
  if (length < 128) return Buffer.from([length]);
  const bytes: number[] = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derSequence(...parts: Buffer[]) {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([0x30]), encodeDerLength(body.length), body]);
}

function derOid(bytes: number[]) {
  return Buffer.from([0x06, bytes.length, ...bytes]);
}

function derBitString(bytes: Buffer) {
  return Buffer.concat([Buffer.from([0x03]), encodeDerLength(bytes.length + 1), Buffer.from([0x00]), bytes]);
}

function coseEc2PublicKeyToPem(coseKey: Buffer) {
  const decoded = decodeCbor(coseKey).value;
  if (!(decoded instanceof Map)) throw new Error("Invalid credential public key");
  const kty = decoded.get(1);
  const alg = decoded.get(3);
  const crv = decoded.get(-1);
  const x = decoded.get(-2);
  const y = decoded.get(-3);
  if (kty !== 2 || alg !== -7 || crv !== 1 || !Buffer.isBuffer(x) || !Buffer.isBuffer(y)) {
    throw new Error("Only ES256 platform authenticators are supported");
  }

  const algorithm = derSequence(
    derOid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]),
    derOid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07])
  );
  const subjectPublicKeyInfo = derSequence(algorithm, derBitString(Buffer.concat([Buffer.from([0x04]), x, y])));
  const body = subjectPublicKeyInfo.toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`;
}

function parseClientData(clientDataJSON: string, expectedType: string, expectedChallenge: string, expectedOrigin: string) {
  const data = JSON.parse(base64UrlDecode(clientDataJSON).toString("utf8")) as { type?: string; challenge?: string; origin?: string };
  if (data.type !== expectedType) throw new Error("Unexpected WebAuthn response type");
  if (data.challenge !== expectedChallenge) throw new Error("WebAuthn challenge mismatch");
  if (data.origin !== expectedOrigin) throw new Error("WebAuthn origin mismatch");
  return data;
}

export function verifyRegistrationResponse(input: {
  attestationObject: string;
  clientDataJSON: string;
  challenge: string;
  origin: string;
  rpId: string;
}) {
  parseClientData(input.clientDataJSON, "webauthn.create", input.challenge, input.origin);
  const attestation = decodeCbor(base64UrlDecode(input.attestationObject)).value;
  if (!(attestation instanceof Map)) throw new Error("Invalid attestation object");
  const authData = attestation.get("authData");
  if (!Buffer.isBuffer(authData)) throw new Error("Invalid authenticator data");

  const expectedRpHash = createHash("sha256").update(input.rpId).digest();
  if (!authData.subarray(0, 32).equals(expectedRpHash)) throw new Error("Authenticator is not scoped to this panel domain");
  const flags = authData.readUInt8(32);
  if ((flags & 0x01) !== 0x01 || (flags & 0x04) !== 0x04 || (flags & 0x40) !== 0x40) {
    throw new Error("Biometric verification is required");
  }
  const signCount = authData.readUInt32BE(33);
  let cursor = 37 + 16;
  const credentialIdLength = authData.readUInt16BE(cursor);
  cursor += 2;
  const credentialId = authData.subarray(cursor, cursor + credentialIdLength);
  cursor += credentialIdLength;
  const coseKey = authData.subarray(cursor);

  return {
    credentialId: base64UrlEncode(credentialId),
    publicKey: coseEc2PublicKeyToPem(coseKey),
    signCount
  };
}

export function verifyAuthenticationResponse(input: {
  authenticatorData: string;
  clientDataJSON: string;
  credentialId: string;
  signature: string;
  publicKey: string;
  challenge: string;
  origin: string;
  rpId: string;
}) {
  parseClientData(input.clientDataJSON, "webauthn.get", input.challenge, input.origin);
  const authenticatorData = base64UrlDecode(input.authenticatorData);
  const expectedRpHash = createHash("sha256").update(input.rpId).digest();
  if (!authenticatorData.subarray(0, 32).equals(expectedRpHash)) throw new Error("Authenticator is not scoped to this panel domain");
  const flags = authenticatorData.readUInt8(32);
  if ((flags & 0x01) !== 0x01 || (flags & 0x04) !== 0x04) throw new Error("Biometric verification is required");

  const clientDataHash = createHash("sha256").update(base64UrlDecode(input.clientDataJSON)).digest();
  const signed = Buffer.concat([authenticatorData, clientDataHash]);
  const verifier = createVerify("SHA256");
  verifier.update(signed);
  verifier.end();
  const valid = verifier.verify(createPublicKey(input.publicKey), base64UrlDecode(input.signature));
  if (!valid) throw new Error("WebAuthn signature verification failed");

  return { signCount: authenticatorData.readUInt32BE(33) };
}
