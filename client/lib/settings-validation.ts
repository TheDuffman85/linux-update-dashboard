export const NUMERIC_SETTING_RULES = {
  activity_history_limit: { min: 5, max: 200, fallback: 20 },
  ssh_timeout_seconds: { min: 5, max: 120, fallback: 30 },
  cmd_timeout_seconds: { min: 10, max: 600, fallback: 120 },
  concurrent_connections: { min: 1, max: 50, fallback: 5 },
} as const;

export type NumericSettingKey = keyof typeof NUMERIC_SETTING_RULES;

function isNumericSettingKey(key: string): key is NumericSettingKey {
  return key in NUMERIC_SETTING_RULES;
}

function normalizeIntegerSetting(key: NumericSettingKey, value: string): string {
  const { min, max, fallback } = NUMERIC_SETTING_RULES[key];
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) {
    return String(fallback);
  }

  return String(Math.min(max, Math.max(min, parsed)));
}

export function normalizeSettingsUpdate(data: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(data)) {
    normalized[key] = isNumericSettingKey(key)
      ? normalizeIntegerSetting(key, value)
      : value;
  }

  return normalized;
}
