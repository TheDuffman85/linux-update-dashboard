import { Hono } from "hono";
import type { SessionData } from "../auth/session";
import {
  getUserPreferences,
  isUserPreferenceKey,
  isValidUserPreference,
  setUserPreferences,
  type UserPreferenceKey,
} from "../services/user-service";

type AuthEnv = {
  Variables: {
    user: SessionData;
  };
};

// The signed-in user's own account; open to read-only users too.
const accountRouter = new Hono<AuthEnv>();

accountRouter.get("/preferences", (c) => {
  return c.json({ preferences: getUserPreferences(c.get("user").userId) });
});

// A null value removes the preference, so the instance default applies again.
accountRouter.put("/preferences", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const changes: Partial<Record<UserPreferenceKey, string | null>> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!isUserPreferenceKey(key)) {
      return c.json({ error: `Unknown preference: ${key}` }, 400);
    }
    if (value !== null && (typeof value !== "string" || !isValidUserPreference(key, value))) {
      return c.json({ error: `Invalid value for ${key}` }, 400);
    }
    changes[key] = value;
  }

  const userId = c.get("user").userId;
  setUserPreferences(userId, changes);
  return c.json({ status: "ok", preferences: getUserPreferences(userId) });
});

export default accountRouter;
