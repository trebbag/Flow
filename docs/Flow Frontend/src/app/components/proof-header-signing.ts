const textEncoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function signHmacHex(secret: string, message: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await globalThis.crypto.subtle.sign("HMAC", key, textEncoder.encode(message));
  return toHex(signature);
}

function normalizeBody(body: unknown): string {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    return JSON.stringify(
      Array.from(body.entries()).map(([key, value]) => [key, typeof value === "string" ? value : "[binary]"])
    );
  }
  try {
    return JSON.stringify(body);
  } catch {
    return "";
  }
}

export async function buildSignedProofHeaders(params: {
  userId: string;
  role: string;
  proofSecret: string;
  proofHmacSecret?: string;
  method?: string;
  path: string;
  body?: unknown;
  facilityId?: string;
}): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "x-proof-user-id": params.userId.trim(),
    "x-proof-role": params.role,
    "x-proof-secret": params.proofSecret.trim(),
  };

  if (params.facilityId) {
    headers["x-facility-id"] = params.facilityId;
  }

  const hmacSecret = params.proofHmacSecret?.trim();
  if (!hmacSecret) {
    return headers;
  }

  const timestamp = String(Math.floor(Date.now() / 1000));
  const method = String(params.method || "GET").toUpperCase();
  const normalizedPath = params.path.split("?")[0] || "/";
  const bodyHash = await signHmacHex(hmacSecret, normalizeBody(params.body));
  const canonical = [method, normalizedPath, timestamp, bodyHash].join("\n");

  headers["x-proof-timestamp"] = timestamp;
  headers["x-proof-signature"] = await signHmacHex(hmacSecret, canonical);
  return headers;
}
