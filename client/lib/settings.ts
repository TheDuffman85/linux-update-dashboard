import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import type { NumericSettingRules } from "./settings-validation";

export type SettingsResponse = {
  settings: Record<string, string>;
  /** Settings pinned by an environment variable, mapped to the variable name. */
  managedSettings?: Record<string, string>;
  /** Password login was requested off but stays on because no other sign-in method exists. */
  passwordLoginFallback?: boolean;
  numericSettingRules: NumericSettingRules;
  timeZone: string | null;
};

export type PublicBranding = {
  appName: string;
  logoUrl: string | null;
};

export type PublicSettingsResponse = {
  settings: {
    language: string;
  };
  branding: PublicBranding;
};

export function useSettingsResponse(enabled = true) {
  return useQuery({
    queryKey: ["settings"],
    queryFn: () => apiFetch<SettingsResponse>("/settings"),
    enabled,
  });
}

export function usePublicSettingsResponse(enabled = true) {
  return useQuery({
    queryKey: ["settings", "public"],
    queryFn: () => apiFetch<PublicSettingsResponse>("/settings/public"),
    enabled,
  });
}

export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: () => apiFetch<SettingsResponse>("/settings"),
    select: (r) => r.settings,
  });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, string>) =>
      apiFetch<{ status: string; oidcError?: string }>("/settings", { method: "PUT", body: JSON.stringify(data) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}
