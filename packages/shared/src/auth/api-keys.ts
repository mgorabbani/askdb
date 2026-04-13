import { randomBytes, createHash } from "crypto";

const PREFIX = "ask_sk_";

export function generateApiKey(): { fullKey: string; prefix: string; hash: string } {
  const random = randomBytes(32).toString("hex");
  const fullKey = `${PREFIX}${random}`;
  const prefix = fullKey.slice(0, 12) + "...";
  const hash = hashKey(fullKey);
  return { fullKey, prefix, hash };
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
