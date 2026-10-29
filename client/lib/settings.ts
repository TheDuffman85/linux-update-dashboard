import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import type { NumericSettingRules } from "./settings-validation";
import type { BrandingTheme } from "../../shared/branding-theme";

export type UserPreferenceKey = "language" | "time_format";
export type UserPreferences = Partial<Record<UserPreferenceKey, string>>;

export type SettingsResponse = {
  settings: Record<string, string>;
  /** The signed-in user's own choices; missing ones fall back to the instance settings. */
  preferences?: UserPreferences;
  /** Settings pinned by an environment variable, mapped to the variable name. */
  managedSettings?: Record<string, string>;
  /** Password login was requested off but stays on because no other sign-in method exists. */
  passwordLoginFallback?: boolean;
  /** OIDC auto-login is enabled and SSO is the only sign-in method. */
  oidcAutoLoginActive?: boolean;
  numericSettingRules: NumericSettingRules;
  timeZone: string | null;
};

export type PublicBranding = {
  appName: string;
  logoUrl: string | null;
  logoDarkUrl: string | null;
  theme: BrandingTheme;
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

export function useUpdatePreferences() {
  const qc = useQueryClient();
  return useMutation({
    // A null value removes the preference, so the instance default applies again.
    mutationFn: (data: Partial<Record<UserPreferenceKey, string | null>>) =>
      apiFetch<{ status: string; preferences: UserPreferences }>("/account/preferences", {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
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
