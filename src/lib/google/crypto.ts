/*
  ====================================================================
  TOKEN ENCRYPTION — for Google OAuth refresh tokens at rest.

  Passwords and API tokens are one-way hashed (see ../session.ts), but a
  refresh token has to be USED later, so it must be reversibly encrypted,
  not hashed. AES-256-GCM (authenticated) with a key derived from
  GOOGLE_TOKEN_ENC_KEY. Same self-contained, Node-`crypto` spirit — no
  external secrets service.

  Wire format:  v1.<ivB64url>.<tagB64url>.<cipherB64url>
  ====================================================================
*/

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/** 32-byte key derived from the configured secret (SHA-256 of it). */
function key(): Buffer {
  const s = process.env.GOOGLE_TOKEN_ENC_KEY || process.env.SESSION_SECRET;
  if (!s) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "GOOGLE_TOKEN_ENC_KEY is not set. Generate one: openssl rand -hex 32",
      );
    }
    // Dev-only fallback so localhost stays frictionless.
    return createHash("sha256").update("dev-only-insecure-google-enc-key").digest();
  }
  return createHash("sha256").update(s).digest();
}

const b64 = (b: Buffer) => b.toString("base64url");

/** Encrypt a plaintext secret (e.g. a refresh token) for storage. */
export function encryptToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${b64(iv)}.${b64(tag)}.${b64(enc)}`;
}

/** Decrypt a value produced by encryptToken. Throws if tampered/mangled. */
export function decryptToken(payload: string): string {
  const [v, ivB, tagB, dataB] = payload.split(".");
  if (v !== "v1" || !ivB || !tagB || !dataB) {
    throw new Error("Unrecognized encrypted-token format");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(ivB, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagB, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
