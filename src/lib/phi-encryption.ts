import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "./env.js";

const CIPHER_ALGO = "aes-256-gcm";
const CIPHER_VERSION = "v1";
const IV_LENGTH_BYTES = 12;

type CipherEnvelope = {
  version: string;
  keyId: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

let cachedKey: Buffer | null = null;
let cachedKeyMissingWarned = false;

function decodeKey(): Buffer | null {
  if (cachedKey) return cachedKey;
  const raw = env.PHI_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error(
      `PHI_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${buf.length}). Generate with: openssl rand -base64 32`,
    );
  }
  cachedKey = buf;
  return cachedKey;
}

export function isPhiEncryptionEnabled(): boolean {
  return decodeKey() !== null;
}

export function resetPhiEncryptionCacheForTest(): void {
  cachedKey = null;
  cachedKeyMissingWarned = false;
}

export function encryptPhi(plaintext: string): string | null {
  const key = decodeKey();
  if (!key) {
    if (!cachedKeyMissingWarned) {
      cachedKeyMissingWarned = true;
    }
    return null;
  }
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(CIPHER_ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope: CipherEnvelope = {
    version: CIPHER_VERSION,
    keyId: env.PHI_ENCRYPTION_KEY_ID,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: enc.toString("base64"),
  };
  return [envelope.version, envelope.keyId, envelope.iv, envelope.tag, envelope.ciphertext].join(":");
}

export function decryptPhi(envelope: string | null | undefined): string | null {
  if (!envelope) return null;
  const key = decodeKey();
  if (!key) return null;
  const parts = envelope.split(":");
  if (parts.length !== 5) return null;
  const [version, keyId, ivB64, tagB64, ctB64] = parts;
  if (version !== CIPHER_VERSION) return null;
  if (keyId !== env.PHI_ENCRYPTION_KEY_ID) {
    // Different key id — a future dual-key window will branch by id; for now we can only decrypt the active key.
    return null;
  }
  try {
    const decipher = createDecipheriv(CIPHER_ALGO, key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const dec = Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]);
    return dec.toString("utf8");
  } catch {
    return null;
  }
}

export function encryptPhiDate(date: Date | null | undefined): string | null {
  if (!date) return null;
  return encryptPhi(date.toISOString());
}

export function decryptPhiDate(envelope: string | null | undefined): Date | null {
  const decoded = decryptPhi(envelope);
  if (!decoded) return null;
  const parsed = new Date(decoded);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
