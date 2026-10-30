import { Hono, type Context } from "hono";
import type { SessionData } from "../auth/session";
import type { UserRole } from "../auth/oidc";
import { hashPassword, isOidcOnlyAccount, validatePassword } from "../auth/password";
import { wouldLockOutAdministrators } from "../auth/auth-config";
import { closeEndedSessionSockets } from "../services/session-sockets";
import { logger } from "../logger";
import {
  countActiveAdmins,
  createLocalUser,
  deleteUser,
  getUserById,
  listUsers,
  resetUserPassword,
  resetUserSecondFactors,
  summarizeUser,
  updateUserAccess,
  type ManagedUser,
} from "../services/user-service";

type AuthEnv = {
  Variables: {
    user: SessionData;
  };
};

// Only administrators get here: the auth middleware keeps read-only users and API tokens out.
const usersRouter = new Hono<AuthEnv>();

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseRole(value: unknown): UserRole | null {
  return value === "admin" || value === "read-only" ? value : null;
}

type ManagedUserResult = { user: ManagedUser } | { error: string; status: 400 | 404 };

/** Looks up the account an administrator acts on and applies the rules every change shares. */
function getManagedUser(
  c: Context<AuthEnv>,
  { localOnly, selfError = "You cannot change your own account here" }: {
    localOnly: boolean;
    selfError?: string;
  },
): ManagedUserResult {
  const id = Number(c.req.param("id"));
  const user = Number.isInteger(id) && id > 0 ? getUserById(id) : undefined;
  if (!user) return { error: "User not found", status: 404 };
  if (user.id === c.get("user").userId) return { error: selfError, status: 400 };
  if (localOnly && isOidcOnlyAccount(user)) {
    return { error: "OIDC users are managed by the identity provider", status: 400 };
  }
  return { user };
}

function isActiveAdmin(user: ManagedUser): boolean {
  return user.role === "admin" && user.disabled === 0;
}

function logUserChange(c: Context<AuthEnv>, action: string, user: ManagedUser, fields = {}) {
  logger.info(`User management: ${action}`, {
    actor: c.get("user").username,
    target: user.username,
    ...fields,
  });
}

usersRouter.get("/", (c) => {
  return c.json({ users: listUsers(c.get("user").userId) });
});

usersRouter.post("/", async (c) => {
  const body = asObject(await c.req.json().catch(() => null));
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const role = parseRole(body?.role);
  if (!username || !password) {
    return c.json({ error: "Username and password required" }, 400);
  }
  if (username.length > 128 || password.length > 1024) {
    return c.json({ error: "Username or password is too long" }, 400);
  }
  if (!role) return c.json({ error: "Invalid role" }, 400);
  const pwError = validatePassword(password);
  if (pwError) return c.json({ error: pwError }, 400);

  const user = createLocalUser({
    username,
    passwordHash: await hashPassword(password),
    role,
    passwordChangeRequired: body?.requirePasswordChange !== false,
  });
  if (!user) {
    return c.json({ error: "A user with this username already exists" }, 409);
  }
  logUserChange(c, "created user", user, { role });
  return c.json({ status: "ok", user: summarizeUser(user, c.get("user").userId) }, 201);
});

usersRouter.patch("/:id", async (c) => {
  const body = asObject(await c.req.json().catch(() => null));
  if (!body) return c.json({ error: "Invalid request body" }, 400);
  const role = "role" in body ? parseRole(body.role) : undefined;
  if (role === null) return c.json({ error: "Invalid role" }, 400);
  if ("disabled" in body && typeof body.disabled !== "boolean") {
    return c.json({ error: "Invalid disabled value" }, 400);
  }
  const disabled = typeof body.disabled === "boolean" ? body.disabled : undefined;

  const managed = getManagedUser(c, { localOnly: true });
  if ("error" in managed) return c.json({ error: managed.error }, managed.status);
  const { user } = managed;

  const losesAdmin =
    isActiveAdmin(user) && (role === "read-only" || disabled === true);
  if (losesAdmin && countActiveAdmins(user.id) === 0) {
    return c.json({ error: "At least one active administrator is required" }, 400);
  }
  if (losesAdmin && wouldLockOutAdministrators({ userId: user.id })) {
    return c.json(
      {
        error:
          "Enable password login or configure OIDC before removing the last administrator with a passkey",
      },
      400,
    );
  }

  updateUserAccess(user.id, { role, disabled });
  await closeEndedSessionSockets();
  logUserChange(c, "updated user", user, { role, disabled });
  return c.json({
    status: "ok",
    user: summarizeUser(getUserById(user.id)!, c.get("user").userId),
  });
});

usersRouter.post("/:id/password", async (c) => {
  const body = asObject(await c.req.json().catch(() => null));
  const password = typeof body?.password === "string" ? body.password : "";
  if (!password) return c.json({ error: "Password required" }, 400);
  if (password.length > 1024) return c.json({ error: "Password is too long" }, 400);
  const pwError = validatePassword(password);
  if (pwError) return c.json({ error: pwError }, 400);
  const changeRequired = body?.requirePasswordChange !== false;

  const managed = getManagedUser(c, { localOnly: true });
  if ("error" in managed) return c.json({ error: managed.error }, managed.status);
  const { user } = managed;

  resetUserPassword(user.id, await hashPassword(password), changeRequired);
  await closeEndedSessionSockets();
  logUserChange(c, "reset password", user, { passwordChangeRequired: changeRequired });
  return c.json({
    status: "ok",
    user: summarizeUser(getUserById(user.id)!, c.get("user").userId),
  });
});

usersRouter.post("/:id/reset-mfa", async (c) => {
  const managed = getManagedUser(c, { localOnly: true });
  if ("error" in managed) return c.json({ error: managed.error }, managed.status);
  const { user } = managed;
  if (isActiveAdmin(user) && wouldLockOutAdministrators({ userId: user.id })) {
    return c.json(
      {
        error:
          "Enable password login or configure OIDC before removing the passkeys of the last administrator with one",
      },
      400,
    );
  }

  resetUserSecondFactors(user.id);
  await closeEndedSessionSockets();
  logUserChange(c, "reset TOTP and passkeys", user);
  return c.json({
    status: "ok",
    user: summarizeUser(getUserById(user.id)!, c.get("user").userId),
  });
});

usersRouter.delete("/:id", async (c) => {
  const managed = getManagedUser(c, {
    localOnly: false,
    selfError: "You cannot delete your own account",
  });
  if ("error" in managed) return c.json({ error: managed.error }, managed.status);
  const { user } = managed;
  if (isActiveAdmin(user) && countActiveAdmins(user.id) === 0) {
    return c.json({ error: "At least one active administrator is required" }, 400);
  }
  if (isActiveAdmin(user) && wouldLockOutAdministrators({ userId: user.id })) {
    return c.json(
      {
        error:
          "Enable password login or configure OIDC before deleting the last administrator with a passkey",
      },
      400,
    );
  }

  deleteUser(user.id);
  await closeEndedSessionSockets();
  logUserChange(c, "deleted user", user, {
    source: isOidcOnlyAccount(user) ? "oidc" : "local",
  });
  return c.json({ status: "ok" });
});

export default usersRouter;
