import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { apiTokens, users } from "../db/schema";

export interface ApiTokenData {
  userId: number;
  username: string;
  readOnly: boolean;
}

/**
 * Generate a random API token with a recognisable prefix.
 * The plain-text token is returned exactly once — only the hash is stored.
 */
export function generateApiToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `ludash_${hex}`;
}

/** SHA-256 hex digest of a token string. */
export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Validate a bearer token.
 * Returns the associated user info + permission level, or null if
 * the token is unknown, expired, or the owning user no longer exists.
 * Updates `last_used_at` on success.
 */
export async function validateToken(
  token: string
): Promise<ApiTokenData | null> {
  const hash = await hashToken(token);
  const db = getDb();

  const row = db
    .select({
      id: apiTokens.id,
      userId: apiTokens.userId,
      readOnly: apiTokens.readOnly,
      expiresAt: apiTokens.expiresAt,
      username: users.username,
    })
    .from(apiTokens)
    .innerJoin(users, eq(apiTokens.userId, users.id))
    .where(eq(apiTokens.tokenHash, hash))
    .get();

  if (!row) return null;

  // Check expiry
  if (row.expiresAt) {
    const expires = new Date(row.expiresAt + "Z");
    if (expires <= new Date()) return null;
  }

  // Update last-used timestamp (fire-and-forget, non-blocking)
  db.update(apiTokens)
    .set({ lastUsedAt: new Date().toISOString().replace("T", " ").slice(0, 19) })
    .where(eq(apiTokens.id, row.id))
    .run();

  return {
    userId: row.userId,
    username: row.username,
    readOnly: row.readOnly === 1,
  };
}
