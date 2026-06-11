import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { settings } from "../db/schema";
import { getEncryptor } from "../security";
import {
  hasSSHManager,
  initSSHManager,
  reconfigureSSHManager,
  type SSHConnectionManager,
} from "../ssh/connection";

export type NumericSettingRule = Readonly<{ min: number; max: number; fallback: number }>;

export const NUMERIC_SETTING_RULES = {
  check_interval_minutes: { min: 5, max: 1440, fallback: 15 },
  cache_duration_hours: { min: 0, max: 168, fallback: 12 },
  activity_history_limit: { min: 5, max: 200, fallback: 20 },
  ssh_timeout_seconds: { min: 5, max: 120, fallback: 30 },
  cmd_timeout_seconds: { min: 10, max: 600, fallback: 120 },
  concurrent_connections: { min: 1, max: 50, fallback: 5 },
} as const;

export type NumericSettingKey = keyof typeof NUMERIC_SETTING_RULES;

export type NumericSettingRules = Readonly<Record<NumericSettingKey, NumericSettingRule>>;

export function isNumericSettingKey(key: string): key is NumericSettingKey {
  return key in NUMERIC_SETTING_RULES;
}

function parseMaximumEnv(name: string, fallback: number, min: number): number {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

function withEnvMaximum(
  rule: NumericSettingRule,
  envName: string,
): NumericSettingRule {
  const max = parseMaximumEnv(envName, rule.max, rule.min);
  return {
    ...rule,
    max,
    fallback: Math.min(max, Math.max(rule.min, rule.fallback)),
  };
}

export function getNumericSettingRules(): NumericSettingRules {
  return {
    ...NUMERIC_SETTING_RULES,
    ssh_timeout_seconds: withEnvMaximum(
      NUMERIC_SETTING_RULES.ssh_timeout_seconds,
      "LUDASH_MAX_SSH_TIMEOUT",
    ),
    cmd_timeout_seconds: withEnvMaximum(
      NUMERIC_SETTING_RULES.cmd_timeout_seconds,
      "LUDASH_MAX_CMD_TIMEOUT",
    ),
  };
}

function getNumericSettingRule(key: NumericSettingKey): NumericSettingRule {
  return getNumericSettingRules()[key];
}

export function normalizeNumericSetting(
  key: NumericSettingKey,
  value: unknown
): string {
  const { min, max, fallback } = getNumericSettingRule(key);
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed)) {
    return String(fallback);
  }

  return String(Math.min(max, Math.max(min, parsed)));
}

function getNumericSettingValue(key: NumericSettingKey): number {
  const row = getDb()
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .get();
  const { fallback } = getNumericSettingRule(key);

  return Number.parseInt(
    normalizeNumericSetting(key, row?.value ?? fallback),
    10
  );
}

export function getActivityHistoryLimit(): number {
  return getNumericSettingValue("activity_history_limit");
}

export function syncSSHManagerWithSettings(): SSHConnectionManager {
  const maxConcurrent = getNumericSettingValue("concurrent_connections");
  const defaultTimeout = getNumericSettingValue("ssh_timeout_seconds");
  const defaultCmdTimeout = getNumericSettingValue("cmd_timeout_seconds");

  if (hasSSHManager()) {
    return reconfigureSSHManager(
      maxConcurrent,
      defaultTimeout,
      defaultCmdTimeout
    );
  }

  return initSSHManager(
    maxConcurrent,
    defaultTimeout,
    defaultCmdTimeout,
    getEncryptor()
  );
}
