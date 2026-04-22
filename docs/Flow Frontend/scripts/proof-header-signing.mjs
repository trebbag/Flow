const textEncoder = new TextEncoder();

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function signHmacHex(secret, message) {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await globalThis.crypto.subtle.sign("HMAC", key, textEncoder.encode(message));
  return toHex(signature);
}

function normalizeBody(body) {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    return JSON.stringify(
      Array.from(body.entries()).map(([key, value]) => [key, typeof value === "string" ? value : "[binary]"]),
    );
  }
  try {
    return JSON.stringify(body);
  } catch {
    return "";
  }
}

export async function buildSignedProofHeaders({
  userId,
  role,
  proofSecret,
  proofHmacSecret,
  method = "GET",
  path,
  body,
  facilityId,
}) {
  const headers = {
    "x-proof-user-id": userId.trim(),
    "x-proof-role": role,
    "x-proof-secret": proofSecret.trim(),
  };

  if (facilityId) {
    headers["x-facility-id"] = facilityId;
  }

  const hmacSecret = proofHmacSecret?.trim();
  if (!hmacSecret) {
    return headers;
  }

  const timestamp = String(Math.floor(Date.now() / 1000));
  const normalizedPath = String(path || "/").split("?")[0] || "/";
  const bodyHash = await signHmacHex(hmacSecret, normalizeBody(body));
  const canonical = [String(method || "GET").toUpperCase(), normalizedPath, timestamp, bodyHash].join("\n");

  headers["x-proof-timestamp"] = timestamp;
  headers["x-proof-signature"] = await signHmacHex(hmacSecret, canonical);
  return headers;
}
