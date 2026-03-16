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

export const NUMERIC_SETTING_RULES = {
  check_interval_minutes: { min: 5, max: 1440, fallback: 15 },
  cache_duration_hours: { min: 0, max: 168, fallback: 12 },
  ssh_timeout_seconds: { min: 5, max: 120, fallback: 30 },
  cmd_timeout_seconds: { min: 10, max: 600, fallback: 120 },
  concurrent_connections: { min: 1, max: 50, fallback: 5 },
} as const;

export type NumericSettingKey = keyof typeof NUMERIC_SETTING_RULES;

export function isNumericSettingKey(key: string): key is NumericSettingKey {
  return key in NUMERIC_SETTING_RULES;
}

export function normalizeNumericSetting(
  key: NumericSettingKey,
  value: unknown
): string {
  const { min, max, fallback } = NUMERIC_SETTING_RULES[key];
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

  return Number.parseInt(
    normalizeNumericSetting(key, row?.value ?? NUMERIC_SETTING_RULES[key].fallback),
    10
  );
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
