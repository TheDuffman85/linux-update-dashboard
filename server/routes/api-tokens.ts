import { Hono } from "hono";
import { eq, and, count } from "drizzle-orm";
import { getDb } from "../db";
import { apiTokens } from "../db/schema";
import { generateApiToken, hashToken } from "../auth/api-token";
import type { SessionData } from "../auth/session";
import {
  API_TOKEN_PERMISSIONS,
  isApiTokenPermission,
  parseApiTokenPermissions,
} from "../../shared/api-token-permissions";

type AuthEnv = {
  Variables: {
    user: SessionData;
  };
};

const MAX_TOKENS_PER_USER = 25;

const tokens = new Hono<AuthEnv>();

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  if (isNaN(id) || id <= 0) return null;
  return id;
}

// An SSO session on a linked account only reaches the tokens limited by the SSO role.
function ownedBy(user: SessionData) {
  return user.linkedSso
    ? and(eq(apiTokens.userId, user.userId), eq(apiTokens.roleSource, "oidc"))
    : eq(apiTokens.userId, user.userId);
}

// List tokens for the authenticated user
tokens.get("/", (c) => {
  const user = c.get("user");
  const db = getDb();
  const rows = db
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      permissions: apiTokens.permissions,
      roleSource: apiTokens.roleSource,
      expiresAt: apiTokens.expiresAt,
      lastUsedAt: apiTokens.lastUsedAt,
      createdAt: apiTokens.createdAt,
    })
    .from(apiTokens)
    .where(ownedBy(user))
    .all();

  return c.json({
    tokens: rows.map((row) => ({
      ...row,
      permissions: parseApiTokenPermissions(row.permissions),
    })),
  });
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

  const body = asObject(await c.req.json().catch(() => null));
  if (!body) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  // Validate name
  const name =
    typeof body.name === "string" && body.name.trim()
      ? body.name.trim().slice(0, 50)
      : null;

  // Validate expiry (default 30 days, 0 = never)
  const expiresInDays =
    typeof body.expiresInDays === "number" &&
    Number.isInteger(body.expiresInDays) &&
    body.expiresInDays >= 0
      ? body.expiresInDays
      : 30;

  let expiresAt: string | null = null;
  if (expiresInDays > 0) {
    const d = new Date();
    d.setDate(d.getDate() + expiresInDays);
    expiresAt = d.toISOString().replace("T", " ").slice(0, 19);
  }

  // Silently creating a read-only token for an old client would be worse than failing.
  if (body.readOnly !== undefined) {
    return c.json({ error: "readOnly was replaced by permissions" }, 400);
  }
  const requested = body.permissions ?? [];
  if (!Array.isArray(requested) || !requested.every(isApiTokenPermission)) {
    return c.json({ error: `permissions must be a list of: ${API_TOKEN_PERMISSIONS.join(", ")}` }, 400);
  }
  const permissions = API_TOKEN_PERMISSIONS.filter((permission) => requested.includes(permission));

  const plainToken = generateApiToken();
  const tokenHash = await hashToken(plainToken);

  const result = db
    .insert(apiTokens)
    .values({
      userId: user.userId,
      name,
      tokenHash,
      permissions: JSON.stringify(permissions),
      roleSource: user.linkedSso ? "oidc" : "local",
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

  const body = asObject(await c.req.json().catch(() => null));
  if (!body) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const name = body.name;
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
    .where(and(eq(apiTokens.id, id), ownedBy(user)))
    .get();

  if (!existing) return c.json({ error: "Not found" }, 404);

  db.update(apiTokens)
    .set({ name: name.trim() })
    .where(and(eq(apiTokens.id, id), ownedBy(user)))
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
    .where(and(eq(apiTokens.id, id), ownedBy(user)))
    .get();

  if (!existing) return c.json({ error: "Not found" }, 404);

  db.delete(apiTokens)
    .where(and(eq(apiTokens.id, id), ownedBy(user)))
    .run();

  return c.json({ status: "ok" });
});

export default tokens;
