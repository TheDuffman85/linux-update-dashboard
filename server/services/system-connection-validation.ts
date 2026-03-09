import { createHash, randomUUID } from "crypto";

export interface ApprovedHostKeyInput {
  systemId?: number;
  role: "jump" | "target";
  host: string;
  port: number;
  algorithm: string;
  fingerprintSha256: string;
  rawKey: string;
}

export interface SystemConnectionConfig {
  systemId?: number;
  hostname: string;
  port: number;
  credentialId: number;
  proxyJumpSystemId?: number | null;
  hostKeyVerificationEnabled: boolean;
}

interface StoredValidationRecord {
  configHash: string;
  subject: string | null;
  expiresAt: number;
  approvedTargetHostKey?: ApprovedHostKeyInput;
}

interface StoredTrustChallengeRecord extends StoredValidationRecord {
  challenges: ApprovedHostKeyInput[];
}

const VALIDATION_TTL_MS = 5 * 60 * 1000;
const trustChallenges = new Map<string, StoredTrustChallengeRecord>();
const validatedConfigs = new Map<string, StoredValidationRecord>();

setInterval(() => {
  const now = Date.now();
  for (const [token, record] of trustChallenges) {
    if (record.expiresAt <= now) trustChallenges.delete(token);
  }
  for (const [token, record] of validatedConfigs) {
    if (record.expiresAt <= now) validatedConfigs.delete(token);
  }
}, 60_000);

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }
  if (!value || typeof value !== "object") {
    return JSON.stringify(value);
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
    .join(",")}}`;
}

function hashConfig(config: SystemConnectionConfig): string {
  return createHash("sha256")
    .update(stableSerialize(config))
    .digest("hex");
}

function createSubjectKey(subject: string | null | undefined): string | null {
  return subject || null;
}

export function issueTrustChallengeToken(
  config: SystemConnectionConfig,
  challenges: ApprovedHostKeyInput[],
  subject?: string | null
): string {
  const token = randomUUID();
  trustChallenges.set(token, {
    configHash: hashConfig(config),
    subject: createSubjectKey(subject),
    expiresAt: Date.now() + VALIDATION_TTL_MS,
    challenges,
  });
  return token;
}

export function getTrustChallenge(
  token: string,
  config: SystemConnectionConfig,
  subject?: string | null
): ApprovedHostKeyInput[] | null {
  const record = trustChallenges.get(token);
  if (!record) return null;
  if (record.expiresAt <= Date.now()) {
    trustChallenges.delete(token);
    return null;
  }
  if (record.configHash !== hashConfig(config)) return null;
  if (record.subject !== createSubjectKey(subject)) return null;
  return record.challenges;
}

export function clearTrustChallenge(token: string): void {
  trustChallenges.delete(token);
}

export function issueValidatedConfigToken(
  config: SystemConnectionConfig,
  subject?: string | null,
  approvedTargetHostKey?: ApprovedHostKeyInput
): string {
  const token = randomUUID();
  validatedConfigs.set(token, {
    configHash: hashConfig(config),
    subject: createSubjectKey(subject),
    expiresAt: Date.now() + VALIDATION_TTL_MS,
    approvedTargetHostKey,
  });
  return token;
}

export function getValidatedConfig(
  token: string,
  config: SystemConnectionConfig,
  subject?: string | null
): StoredValidationRecord | null {
  const record = validatedConfigs.get(token);
  if (!record) return null;
  if (record.expiresAt <= Date.now()) {
    validatedConfigs.delete(token);
    return null;
  }
  if (record.configHash !== hashConfig(config)) return null;
  if (record.subject !== createSubjectKey(subject)) return null;
  return record;
}
