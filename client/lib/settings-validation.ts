export const NUMERIC_SETTING_RULES = {
  activity_history_limit: { min: 5, max: 200, fallback: 20 },
  ssh_timeout_seconds: { min: 5, max: 120, fallback: 30 },
  cmd_timeout_seconds: { min: 10, max: 600, fallback: 120 },
  concurrent_connections: { min: 1, max: 50, fallback: 5 },
} as const;

export type NumericSettingKey = keyof typeof NUMERIC_SETTING_RULES;
export type NumericSettingRule = Readonly<{ min: number; max: number; fallback: number }>;
export type NumericSettingRules = Readonly<Record<NumericSettingKey, NumericSettingRule>>;

function isNumericSettingKey(key: string): key is NumericSettingKey {
  return key in NUMERIC_SETTING_RULES;
}

function getNumericSettingRule(
  key: NumericSettingKey,
  rules: Partial<NumericSettingRules> = {},
): NumericSettingRule {
  return rules[key] ?? NUMERIC_SETTING_RULES[key];
}

export function normalizeIntegerSetting(
  key: NumericSettingKey,
  value: string,
  rules: Partial<NumericSettingRules> = {},
): string {
  const { min, max, fallback } = getNumericSettingRule(key, rules);
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) {
    return String(fallback);
  }

  return String(Math.min(max, Math.max(min, parsed)));
}

export function normalizeSettingsUpdate(
  data: Record<string, string>,
  rules: Partial<NumericSettingRules> = {},
): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(data)) {
    normalized[key] = isNumericSettingKey(key)
      ? normalizeIntegerSetting(key, value, rules)
      : value;
  }

  return normalized;
}
