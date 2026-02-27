import { Hono } from "hono";
import { eq, and, count } from "drizzle-orm";
import { getDb } from "../db";
import { apiTokens } from "../db/schema";
import { generateApiToken, hashToken } from "../auth/api-token";
import type { SessionData } from "../auth/session";

type AuthEnv = {
  Variables: {
    user: SessionData;
  };
};

const MAX_TOKENS_PER_USER = 25;

const tokens = new Hono<AuthEnv>();

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  if (isNaN(id) || id <= 0) return null;
  return id;
}

// List tokens for the authenticated user
tokens.get("/", (c) => {
  const user = c.get("user");
  const db = getDb();
  const rows = db
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      readOnly: apiTokens.readOnly,
      expiresAt: apiTokens.expiresAt,
      lastUsedAt: apiTokens.lastUsedAt,
      createdAt: apiTokens.createdAt,
    })
    .from(apiTokens)
    .where(eq(apiTokens.userId, user.userId))
    .all();

  return c.json({ tokens: rows });
});

// Create a new token
tokens.post("/", async (c) => {
  const user = c.get("user");

  // Enforce per-user token limit
  const db = getDb();
  const existing = db
    .select({ count: count() })
    .from(apiTokens)
    .where(eq(apiTokens.userId, user.userId))
    .get();
  if ((existing?.count ?? 0) >= MAX_TOKENS_PER_USER) {
    return c.json({ error: `Maximum of ${MAX_TOKENS_PER_USER} tokens allowed` }, 400);
  }

  const body = await c.req.json<{
    name?: string;
    expiresInDays?: number;
    readOnly?: boolean;
  }>();

  // Validate name
  const name =
    typeof body.name === "string" && body.name.trim()
      ? body.name.trim().slice(0, 50)
      : null;

  // Validate expiry (default 30 days, 0 = never)
  const expiresInDays =
    typeof body.expiresInDays === "number" && body.expiresInDays >= 0
      ? body.expiresInDays
      : 30;

  let expiresAt: string | null = null;
  if (expiresInDays > 0) {
    const d = new Date();
    d.setDate(d.getDate() + expiresInDays);
    expiresAt = d.toISOString().replace("T", " ").slice(0, 19);
  }

  const readOnly = body.readOnly !== false ? 1 : 0;

  const plainToken = generateApiToken();
  const tokenHash = await hashToken(plainToken);

  const result = db
    .insert(apiTokens)
    .values({
      userId: user.userId,
      name,
      tokenHash,
      readOnly,
      expiresAt,
    })
    .returning({ id: apiTokens.id })
    .get();

  return c.json({ token: plainToken, id: result.id });
});

// Rename a token
tokens.patch("/:id", async (c) => {
  const user = c.get("user");
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);

  const { name } = await c.req.json<{ name: string }>();
  if (typeof name !== "string" || name.trim().length === 0) {
    return c.json({ error: "Name is required" }, 400);
  }
  if (name.trim().length > 50) {
    return c.json({ error: "Name must be 50 characters or less" }, 400);
  }

  const db = getDb();
  const existing = db
    .select({ id: apiTokens.id })
    .from(apiTokens)
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, user.userId)))
    .get();

  if (!existing) return c.json({ error: "Not found" }, 404);

  db.update(apiTokens)
    .set({ name: name.trim() })
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, user.userId)))
    .run();

  return c.json({ status: "ok" });
});

// Delete / revoke a token
tokens.delete("/:id", (c) => {
  const user = c.get("user");
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);

  const db = getDb();
  const existing = db
    .select({ id: apiTokens.id })
    .from(apiTokens)
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, user.userId)))
    .get();

  if (!existing) return c.json({ error: "Not found" }, 404);

  db.delete(apiTokens)
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, user.userId)))
    .run();

  return c.json({ status: "ok" });
});

export default tokens;
