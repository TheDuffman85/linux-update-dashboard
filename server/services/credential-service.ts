import { asc, eq } from "drizzle-orm";
import { utils, type ParsedKey } from "ssh2";
import { getDb } from "../db";
import { credentials, systems } from "../db/schema";
import { getEncryptor } from "../security";

export const CREDENTIAL_KINDS = [
  "usernamePassword",
  "sshKey",
  "certificate",
] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

export interface CredentialReference {
  type: "system";
  id: number;
  name: string;
}

export interface CredentialSummary {
  id: number;
  name: string;
  kind: CredentialKind;
  summary: string;
  referenceCount: number;
  references: CredentialReference[];
}

export interface CredentialDetail extends CredentialSummary {
  payload: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

const SECRET_FIELDS: Record<CredentialKind, string[]> = {
  usernamePassword: ["password"],
  sshKey: ["privateKey", "passphrase"],
  certificate: ["certificatePem", "privateKeyPem", "privateKeyPassword"],
};

const ALLOWED_FIELDS: Record<CredentialKind, string[]> = {
  usernamePassword: ["username", "password"],
  sshKey: ["username", "privateKey", "passphrase"],
  certificate: ["username", "certificatePem", "privateKeyPem", "privateKeyPassword"],
};

export interface ResolvedSystemCredential {
  credentialId: number;
  kind: "usernamePassword" | "sshKey" | "certificate";
  username: string;
  authType: "password" | "key";
  encryptedPassword?: string;
  encryptedPrivateKey?: string;
  encryptedKeyPassphrase?: string;
  encryptedCertificatePem?: string;
}

export function parseCredentialPayload(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function getReferences(credentialId: number): CredentialReference[] {
  const db = getDb();
  return db
    .select({ id: systems.id, name: systems.name })
    .from(systems)
    .where(eq(systems.credentialId, credentialId))
    .all()
    .map((item) => ({ ...item, type: "system" as const }));
}

function maskPayload(
  kind: CredentialKind,
  payload: Record<string, string>
): Record<string, string> {
  const masked = { ...payload };
  for (const key of SECRET_FIELDS[kind]) {
    if (masked[key]) masked[key] = "(stored)";
  }
  return masked;
}

function ensureEncryptedSecret(value: string): string {
  if (!value) return value;
  const encryptor = getEncryptor();
  if (!/^[A-Za-z0-9+/=]+$/.test(value) || value.length < 44) {
    return encryptor.encrypt(value);
  }
  try {
    encryptor.decrypt(value);
    return value;
  } catch {
    return encryptor.encrypt(value);
  }
}

function sanitizeAllowedFields(
  kind: CredentialKind,
  payload: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(payload).filter(([key, value]) =>
      ALLOWED_FIELDS[kind].includes(key) && typeof value === "string"
    )
  );
}

function buildSummary(
  kind: CredentialKind,
  payload: Record<string, string>
): string {
  if (kind === "usernamePassword") {
    return payload.username ? `${payload.username} • username/password` : "Username/password";
  }
  if (kind === "sshKey") {
    return payload.username
      ? `${payload.username} • SSH key${payload.passphrase ? " + passphrase" : ""}`
      : `SSH key${payload.passphrase ? " + passphrase" : ""}`;
  }
  return payload.username
    ? `${payload.username} • SSH certificate${payload.privateKeyPassword ? " + password" : ""}`
    : `SSH certificate${payload.privateKeyPassword ? " + password" : ""}`;
}

function serializeSummary(row: typeof credentials.$inferSelect): CredentialSummary {
  const kind = row.kind as CredentialKind;
  const payload = parseCredentialPayload(row.payload);
  const refs = getReferences(row.id);

  return {
    id: row.id,
    name: row.name,
    kind,
    summary: buildSummary(kind, payload),
    referenceCount: refs.length,
    references: refs,
  };
}

function buildPersistedPayload(
  kind: CredentialKind,
  incomingPayload: Record<string, string>,
  existingPayload?: Record<string, string>
): Record<string, string> {
  const payload = sanitizeAllowedFields(kind, incomingPayload);
  const next: Record<string, string> = {};

  for (const key of ALLOWED_FIELDS[kind]) {
    const value = payload[key];
    const isSecret = SECRET_FIELDS[kind].includes(key);

    if (isSecret) {
      if (value === "(stored)" && existingPayload?.[key]) {
        next[key] = existingPayload[key];
        continue;
      }
      if (value) {
        next[key] = ensureEncryptedSecret(value);
      }
      continue;
    }

    if (value) next[key] = value;
  }

  return next;
}

export function validateCredentialInput(data: {
  name: string;
  kind: CredentialKind;
  payload: Record<string, string>;
}, existing?: Record<string, string>): string | null {
  if (!data.name || !data.name.trim() || data.name.trim().length > 100) {
    return "name is required and must be 1-100 characters";
  }

  if (!(CREDENTIAL_KINDS as readonly string[]).includes(data.kind)) {
    return "invalid credential kind";
  }

  const payload = sanitizeAllowedFields(data.kind, data.payload);

  if (data.kind === "usernamePassword") {
    if (!payload.username) return "payload.username is required";
    if (!payload.password && existing?.password === undefined) {
      return "payload.password is required";
    }
  }

  if (data.kind === "sshKey") {
    if (!payload.username) return "payload.username is required";
    if (!payload.privateKey && existing?.privateKey === undefined) {
      return "payload.privateKey is required";
    }
  }

  if (data.kind === "certificate") {
    if (!payload.username) return "payload.username is required";
    const hasCert = !!payload.certificatePem || existing?.certificatePem !== undefined;
    const hasKey = !!payload.privateKeyPem || existing?.privateKeyPem !== undefined;
    if (!hasCert) return "payload.certificatePem is required";
    if (!hasKey) return "payload.privateKeyPem is required";
  }

  return null;
}

export function listCredentials(filters?: {
  kind?: CredentialKind;
}): CredentialSummary[] {
  const db = getDb();
  const rows = db.select().from(credentials).orderBy(asc(credentials.name), asc(credentials.id)).all();

  return rows
    .filter((row): row is typeof row & { kind: CredentialKind } =>
      (CREDENTIAL_KINDS as readonly string[]).includes(row.kind) &&
      (!filters?.kind || row.kind === filters.kind)
    )
    .map(serializeSummary);
}

export function getCredentialRow(id: number) {
  const db = getDb();
  return db.select().from(credentials).where(eq(credentials.id, id)).get() || null;
}

export function getCredential(id: number): CredentialDetail | null {
  const row = getCredentialRow(id);
  if (!row) return null;
  if (!(CREDENTIAL_KINDS as readonly string[]).includes(row.kind)) return null;
  const summary = serializeSummary(row);
  return {
    ...summary,
    payload: maskPayload(summary.kind, parseCredentialPayload(row.payload)),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createCredential(data: {
  name: string;
  kind: CredentialKind;
  payload: Record<string, string>;
}): number {
  const persistedPayload = buildPersistedPayload(data.kind, data.payload);
  const result = getDb()
    .insert(credentials)
    .values({
      name: data.name.trim(),
      kind: data.kind,
      payload: JSON.stringify(persistedPayload),
    })
    .returning({ id: credentials.id })
    .get();
  return result.id;
}

export function updateCredential(
  id: number,
  data: {
    name: string;
    payload: Record<string, string>;
  }
): boolean {
  const existing = getCredentialRow(id);
  if (!existing) return false;
  if (!(CREDENTIAL_KINDS as readonly string[]).includes(existing.kind)) return false;
  const kind = existing.kind as CredentialKind;
  const existingPayload = parseCredentialPayload(existing.payload);
  const persistedPayload = buildPersistedPayload(kind, data.payload, existingPayload);

  getDb()
    .update(credentials)
    .set({
      name: data.name.trim(),
      payload: JSON.stringify(persistedPayload),
      updatedAt: new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, ""),
    })
    .where(eq(credentials.id, id))
    .run();
  return true;
}

export function deleteCredential(id: number): {
  ok: boolean;
  references?: CredentialReference[];
} {
  const refs = getReferences(id);
  if (refs.length > 0) {
    return { ok: false, references: refs };
  }

  const existing = getCredentialRow(id);
  if (!existing) return { ok: false };

  getDb().delete(credentials).where(eq(credentials.id, id)).run();
  return { ok: true };
}

export function isSystemCredentialKind(kind: CredentialKind): boolean {
  return kind === "usernamePassword" || kind === "sshKey" || kind === "certificate";
}

export function resolveSystemCredential(id: number): ResolvedSystemCredential | null {
  const row = getCredentialRow(id);
  if (!row) return null;
  if (!(CREDENTIAL_KINDS as readonly string[]).includes(row.kind)) return null;
  const kind = row.kind as CredentialKind;
  const payload = parseCredentialPayload(row.payload);

  if (kind === "usernamePassword" && payload.username && payload.password) {
    return {
      credentialId: row.id,
      kind,
      username: payload.username,
      authType: "password",
      encryptedPassword: payload.password,
    };
  }

  if (kind === "sshKey" && payload.username && payload.privateKey) {
    return {
      credentialId: row.id,
      kind,
      username: payload.username,
      authType: "key",
      encryptedPrivateKey: payload.privateKey,
      encryptedKeyPassphrase: payload.passphrase || undefined,
    };
  }

  if (kind === "certificate" && payload.username && payload.privateKeyPem && payload.certificatePem) {
    return {
      credentialId: row.id,
      kind,
      username: payload.username,
      authType: "key",
      encryptedPrivateKey: payload.privateKeyPem,
      encryptedKeyPassphrase: payload.privateKeyPassword || undefined,
      encryptedCertificatePem: payload.certificatePem,
    };
  }

  return null;
}
export function buildSshCertificateParsedKey(credential: ResolvedSystemCredential): ParsedKey | null {
  if (
    credential.kind !== "certificate" ||
    !credential.encryptedPrivateKey ||
    !credential.encryptedCertificatePem
  ) {
    return null;
  }

  const encryptor = getEncryptor();
  const privateKeyPem = encryptor.decrypt(credential.encryptedPrivateKey);
  const certificatePem = encryptor.decrypt(credential.encryptedCertificatePem);
  const privateKey = utils.parseKey(
    privateKeyPem,
    credential.encryptedKeyPassphrase
      ? encryptor.decrypt(credential.encryptedKeyPassphrase)
      : undefined
  );
  const certificateKey = utils.parseKey(certificatePem);

  if (privateKey instanceof Error || certificateKey instanceof Error) {
    return null;
  }

  if (!privateKey.isPrivateKey()) return null;

  const parsedKey: ParsedKey = {
    type: certificateKey.type as ParsedKey["type"],
    comment: certificateKey.comment,
    sign(data, algo) {
      return privateKey.sign(data, algo);
    },
    verify(data, signature, algo) {
      return certificateKey.verify(data, signature, algo);
    },
    isPrivateKey() {
      return true;
    },
    getPrivatePEM() {
      return privateKey.getPrivatePEM();
    },
    getPublicPEM() {
      return certificateKey.getPublicPEM();
    },
    getPublicSSH() {
      return certificateKey.getPublicSSH();
    },
    equals(key) {
      return certificateKey.equals(key);
    },
  };

  return parsedKey;
}
