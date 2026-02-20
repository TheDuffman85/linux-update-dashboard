import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { settings } from "../db/schema";

const settingsRouter = new Hono();

// Get all settings
settingsRouter.get("/", (c) => {
  const db = getDb();
  const allSettings = db.select().from(settings).orderBy(settings.key).all();
  const settingsMap: Record<string, string> = {};
  for (const s of allSettings) {
    settingsMap[s.key] = s.value;
  }
  return c.json({ settings: settingsMap });
});

// Update settings
settingsRouter.put("/", async (c) => {
  const body = await c.req.json();
  const db = getDb();

  for (const [key, value] of Object.entries(body)) {
    db.update(settings)
      .set({
        value: String(value),
        updatedAt: new Date().toISOString().replace("T", " ").slice(0, 19),
      })
      .where(eq(settings.key, key))
      .run();
  }

  return c.json({ status: "ok" });
});

export default settingsRouter;
