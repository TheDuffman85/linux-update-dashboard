import bcrypt from "bcryptjs";

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function validatePassword(password: string): string | null {
  if (password.length < 8) return "Password must be at least 8 characters";
  if (!/[a-z]/.test(password))
    return "Password must contain a lowercase letter";
  if (!/[A-Z]/.test(password))
    return "Password must contain an uppercase letter";
  if (!/\d/.test(password)) return "Password must contain a digit";
  return null;
}

/** Accounts that only sign in through the identity provider, which also decides their role. */
export function isOidcOnlyAccount(
  user: { authProvider: string; passwordHash: string | null } | null,
): boolean {
  return Boolean(user && user.authProvider === "oidc" && !user.passwordHash);
}
