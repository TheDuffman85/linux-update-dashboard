import { randomBytes } from "node:crypto";

type Ceremony = "login" | "register";
interface Challenge {
  value: string;
  ceremony: Ceremony;
  userId?: number;
  expiresAt: number;
}

const challenges = new Map<string, Challenge>();
const LIFETIME_MS = 300_000;
const MAX_CHALLENGES = 10_000;

export function issueWebAuthnChallenge(
  value: string,
  ceremony: Ceremony,
  userId?: number,
): string {
  const now = Date.now();
  for (const [token, challenge] of challenges) {
    if (challenge.expiresAt <= now) challenges.delete(token);
  }
  if (challenges.size >= MAX_CHALLENGES) {
    challenges.delete(challenges.keys().next().value!);
  }
  const token = randomBytes(32).toString("base64url");
  challenges.set(token, {
    value,
    ceremony,
    userId,
    expiresAt: now + LIFETIME_MS,
  });
  return token;
}

export function consumeWebAuthnChallenge(
  token: string | undefined,
  ceremony: Ceremony,
  userId?: number,
): string | null {
  if (!token) return null;
  const challenge = challenges.get(token);
  // Consume before asynchronous signature verification, including failed attempts.
  challenges.delete(token);
  if (
    !challenge ||
    challenge.expiresAt <= Date.now() ||
    challenge.ceremony !== ceremony ||
    challenge.userId !== userId
  )
    return null;
  return challenge.value;
}
