import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { getDb } from "../db";
import { webauthnCredentials } from "../db/schema";
import type { SessionData } from "../auth/session";

type AuthEnv = {
  Variables: {
    user: SessionData;
  };
};

const passkeys = new Hono<AuthEnv>();

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  if (isNaN(id) || id <= 0) return null;
  return id;
}

// List passkeys for the authenticated user
passkeys.get("/", (c) => {
  const user = c.get("user");
  const db = getDb();
  const creds = db
    .select({
      id: webauthnCredentials.id,
      credentialId: webauthnCredentials.credentialId,
      name: webauthnCredentials.name,
      createdAt: webauthnCredentials.createdAt,
    })
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, user.userId))
    .all();

  return c.json({ passkeys: creds });
});

// Rename a passkey (only if owned by the authenticated user)
passkeys.patch("/:id", async (c) => {
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
    .select({ id: webauthnCredentials.id })
    .from(webauthnCredentials)
    .where(
      and(
        eq(webauthnCredentials.id, id),
        eq(webauthnCredentials.userId, user.userId)
      )
    )
    .get();

  if (!existing) {
    return c.json({ error: "Not found" }, 404);
  }

  db.update(webauthnCredentials)
    .set({ name: name.trim() })
    .where(
      and(
        eq(webauthnCredentials.id, id),
        eq(webauthnCredentials.userId, user.userId)
      )
    )
    .run();

  return c.json({ status: "ok" });
});

// Delete a passkey (only if owned by the authenticated user)
passkeys.delete("/:id", (c) => {
  const user = c.get("user");
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);

  const db = getDb();
  const existing = db
    .select({ id: webauthnCredentials.id })
    .from(webauthnCredentials)
    .where(
      and(
        eq(webauthnCredentials.id, id),
        eq(webauthnCredentials.userId, user.userId)
      )
    )
    .get();

  if (!existing) {
    return c.json({ error: "Not found" }, 404);
  }

  db.delete(webauthnCredentials)
    .where(
      and(
        eq(webauthnCredentials.id, id),
        eq(webauthnCredentials.userId, user.userId)
      )
    )
    .run();

  return c.json({ status: "ok" });
});

export default passkeys;
