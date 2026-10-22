import { createHash, randomBytes } from "node:crypto";

export type GeneratedKey = { secret: string; prefix: string; hash: string };

/**
 * Keys carry 192 bits of randomness, so a fast unsalted SHA-256 is sufficient:
 * there is nothing to brute-force, unlike human-chosen passwords.
 */
export function generateApiKey(): GeneratedKey {
  const secret = `sk_live_${randomBytes(24).toString("base64url")}`;
  return { secret, prefix: secret.slice(0, 12), hash: hashApiKey(secret) };
}

export function hashApiKey(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}
