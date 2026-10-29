import { and, eq, gt, lte, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  oidcLogoutVersions,
  oidcProcessedLogouts,
  oidcRevokedSessions,
  users,
} from "../db/schema";

/** Sessions without a recorded logout version belong to this one. */
export const INITIAL_OIDC_LOGOUT_VERSION = 1;

export interface OidcLogout {
  issuer: string;
  subject?: string;
  sessionId?: string;
  tokenId: string;
  /** Unix seconds until which a repeated token must still be recognized. */
  tokenExpiresAt: number;
  /** Unix seconds until which sessions bound to sessionId could still be valid. */
  sessionExpiresAt: number;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Atomically records a logout token and ends its sessions, so retries of the
 * same notification cannot revoke later sign-ins. Returns false for duplicates.
 */
export function applyOidcLogout(logout: OidcLogout): boolean {
  if (!logout.sessionId && !logout.subject) {
    throw new Error("OIDC logout requires a subject or session ID");
  }

  return getDb().transaction((tx) => {
    const now = nowSeconds();
    tx.delete(oidcProcessedLogouts)
      .where(lte(oidcProcessedLogouts.expiresAt, now))
      .run();
    const inserted = tx
      .insert(oidcProcessedLogouts)
      .values({
        issuer: logout.issuer,
        tokenId: logout.tokenId,
        expiresAt: logout.tokenExpiresAt,
      })
      .onConflictDoNothing()
      .run();
    if (!inserted.changes) return false;

    // sid narrows the logout even when the provider also supplies sub. Sessions
    // that carry no sid cannot be matched to the provider session, so those of
    // the named user end too.
    if (logout.sessionId) {
      tx.delete(oidcRevokedSessions)
        .where(lte(oidcRevokedSessions.expiresAt, now))
        .run();
      tx.insert(oidcRevokedSessions)
        .values({
          issuer: logout.issuer,
          sessionId: logout.sessionId,
          expiresAt: logout.sessionExpiresAt,
        })
        .onConflictDoUpdate({
          target: [oidcRevokedSessions.issuer, oidcRevokedSessions.sessionId],
          set: { expiresAt: logout.sessionExpiresAt },
        })
        .run();
      if (logout.subject) {
        const user = tx
          .select({ id: users.id })
          .from(users)
          .where(
            and(
              eq(users.oidcIssuer, logout.issuer),
              eq(users.oidcSubject, logout.subject),
            ),
          )
          .get();
        if (user) {
          tx.insert(oidcLogoutVersions)
            .values({
              issuer: logout.issuer,
              subject: logout.subject,
              version: INITIAL_OIDC_LOGOUT_VERSION + 1,
            })
            .onConflictDoUpdate({
              target: [oidcLogoutVersions.issuer, oidcLogoutVersions.subject],
              set: { version: sql`${oidcLogoutVersions.version} + 1` },
            })
            .run();
        }
      }
    } else {
      tx.update(users)
        .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
        .where(
          and(
            eq(users.oidcIssuer, logout.issuer),
            eq(users.oidcSubject, logout.subject!),
          ),
        )
        .run();
    }
    return true;
  });
}

export function isOidcSessionRevoked(issuer: string, sessionId: string): boolean {
  return !!getDb()
    .select({ issuer: oidcRevokedSessions.issuer })
    .from(oidcRevokedSessions)
    .where(
      and(
        eq(oidcRevokedSessions.issuer, issuer),
        eq(oidcRevokedSessions.sessionId, sessionId),
        gt(oidcRevokedSessions.expiresAt, nowSeconds()),
      ),
    )
    .get();
}

/** Version that new sessions without a provider session ID are bound to. */
export function getOidcLogoutVersion(issuer: string, subject: string): number {
  const row = getDb()
    .select({ version: oidcLogoutVersions.version })
    .from(oidcLogoutVersions)
    .where(
      and(
        eq(oidcLogoutVersions.issuer, issuer),
        eq(oidcLogoutVersions.subject, subject),
      ),
    )
    .get();
  return row?.version ?? INITIAL_OIDC_LOGOUT_VERSION;
}
