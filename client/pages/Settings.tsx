import { useState, useEffect, useRef } from "react";
import { useSearchParams } from "react-router";
import QRCode from "qrcode";
import { Layout } from "../components/Layout";
import { TabPanel, Tabs, type TabItem } from "../components/Tabs";
import {
  useSettingsResponse,
  useUpdatePreferences,
  useUpdateSettings,
} from "../lib/settings";
import { validatePassword, validateRequiredText } from "../lib/form-validation";
import {
  NUMERIC_SETTING_RULES,
  mergeLoadedDraft,
  normalizeIntegerSetting,
  normalizeSettingsUpdate,
  type NumericSettingKey,
  type NumericSettingRules,
} from "../lib/settings-validation";
import {
  usePasskeys,
  useDeletePasskey,
  useRegisterPasskey,
  useRenamePasskey,
} from "../lib/passkeys";
import {
  useApiTokens,
  useCreateApiToken,
  useRenameApiToken,
  useDeleteApiToken,
} from "../lib/api-tokens";
import {
  ACCEPTED_APP_LOGO_TYPES,
  APP_NAME_SETTING_KEY,
  DEFAULT_APP_NAME,
  MAX_APP_LOGO_BYTES,
  MAX_APP_NAME_LENGTH,
  useBranding,
  useResetAppDarkLogo,
  useResetAppLogo,
  useUploadAppDarkLogo,
  useUpdateAppTheme,
  useUploadAppLogo,
  type AppLogoVariant,
} from "../lib/branding";
import {
  isSameBrandingTheme,
  type BrandingTheme,
} from "../../shared/branding-theme";
import { AppLogo } from "../components/AppLogo";
import { BrandingColorsSettings } from "../components/BrandingColorsSettings";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { UsersSettings } from "../components/UsersSettings";
import { Modal } from "../components/Modal";
import { useToast } from "../context/ToastContext";
import { useAuth } from "../context/AuthContext";
import { apiFetch } from "../lib/client";
import {
  BROWSER_LANGUAGE_SETTING,
  LANGUAGE_SETTING_KEY,
  SUPPORTED_LANGUAGES,
  getLanguageLabel,
  normalizeLanguagePreference,
  resolveLanguagePreference,
  translateForLanguage,
  type TranslationValues,
  useI18n,
} from "../lib/i18n";
import {
  BROWSER_TIME_FORMAT_SETTING,
  TIME_FORMAT_SETTING_KEY,
  useDateTime,
} from "../lib/date-time";

function SettingSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl border border-border p-4 md:p-6 mb-4">
      <h2 className={`text-sm font-semibold ${description ? "mb-1" : "mb-4"}`}>
        {title}
      </h2>
      {description && (
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
          {description}
        </p>
      )}
      {children}
    </div>
  );
}

function ManagedSettingHint({ envVar }: { envVar?: string }) {
  const { t } = useI18n();
  if (!envVar) return null;
  return (
    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
      {t("pages.settings.managedByEnv", { name: envVar })}
    </p>
  );
}

const DEFAULT_OIDC_SCOPE = "openid profile email";
const OIDC_SETTING_KEYS = [
  "oidc_issuer",
  "oidc_client_id",
  "oidc_client_secret",
  "oidc_scope",
  "oidc_groups_claim",
  "oidc_admin_groups",
  "oidc_read_only_groups",
  "oidc_unmatched_role",
  "oidc_end_session",
  "oidc_backchannel_logout",
  "oidc_auto_login",
];

const GENERAL_SETTING_KEYS = [
  "activity_history_limit",
  "distro_eol_warning_days",
  LANGUAGE_SETTING_KEY,
  TIME_FORMAT_SETTING_KEY,
  "ssh_timeout_seconds",
  "cmd_timeout_seconds",
  "concurrent_connections",
  "enable_root_user_check",
];
// Saved in one request, so the server validates disabling password login against the
// OIDC settings being saved.
const AUTHENTICATION_SETTING_KEYS = ["disable_password_login", ...OIDC_SETTING_KEYS];
// Loaded as "(stored)" and shown as an empty field while a value is stored.
const SECRET_SETTING_KEYS = ["oidc_client_secret"];

const SETTINGS_TABS = [
  "account",
  "general",
  "authentication",
  "users",
  "api-tokens",
  "branding",
] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number];
// Read-only users only manage their own account.
const READ_ONLY_SETTINGS_TABS: readonly SettingsTab[] = ["account"];
const SETTINGS_TAB_PARAM = "tab";

function parseSettingsTab(
  value: string | null,
  available: readonly SettingsTab[],
): SettingsTab {
  return available.find((tab) => tab === value) ?? available[0];
}

type OidcListField = "oidc_scope" | "oidc_admin_groups" | "oidc_read_only_groups";

function parseOidcList(field: OidcListField, value: string | undefined): string[] {
  const items =
    field === "oidc_scope"
      ? (value ?? "").trim().split(/\s+/)
      : (value ?? "").split(",");
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)));
}

function serializeOidcList(field: OidcListField, items: string[]): string {
  return items.join(field === "oidc_scope" ? " " : ",");
}

function ListEditor({
  id,
  label,
  items,
  draft,
  onDraftChange,
  onAdd,
  onRemove,
  placeholder,
  addLabel,
  emptyLabel,
  removeLabel,
  canRemove = () => true,
  labelClass,
  disabled = false,
  hint,
}: {
  id: string;
  label: string;
  items: string[];
  draft: string;
  onDraftChange: (value: string) => void;
  onAdd: () => void;
  onRemove: (item: string) => void;
  placeholder: string;
  addLabel: string;
  emptyLabel: string;
  removeLabel: (item: string) => string;
  canRemove?: (item: string) => boolean;
  labelClass: string;
  disabled?: boolean;
  hint?: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <form
        className={`flex min-h-11 overflow-hidden rounded-lg border border-border bg-white dark:bg-slate-900 focus-within:ring-2 focus-within:ring-blue-500 ${disabled ? "opacity-60" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          onAdd();
        }}
        autoComplete="off"
        data-1p-ignore="true"
        data-bwignore="true"
        data-form-type="other"
        data-lpignore="true"
      >
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 px-2 py-1.5">
          {items.map((item) => (
            <span
              key={item}
              className="inline-flex max-w-full items-center gap-1 rounded-md bg-blue-50 px-2 py-1 text-sm font-medium text-blue-800 dark:bg-blue-900/40 dark:text-blue-100"
            >
              <span className="truncate">{item}</span>
              {!disabled && canRemove(item) && (
                <button
                  type="button"
                  onClick={() => onRemove(item)}
                  className="rounded p-0.5 text-blue-700 hover:bg-blue-100 dark:text-blue-200 dark:hover:bg-blue-800"
                  aria-label={removeLabel(item)}
                  title={removeLabel(item)}
                >
                  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </span>
          ))}
          {items.length === 0 && !draft.trim() && (
            <span className="px-1 py-1 text-sm text-slate-500 dark:text-slate-400">
              {emptyLabel}
            </span>
          )}
          <input
            id={id}
            name="list-token"
            type="text"
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            placeholder={items.length === 0 && !disabled ? placeholder : ""}
            disabled={disabled}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            data-1p-ignore="true"
            data-bwignore="true"
            data-form-type="other"
            data-lpignore="true"
            className="min-w-32 flex-1 border-0 bg-transparent px-1 py-1 text-sm outline-none placeholder:text-slate-400 dark:placeholder:text-slate-500"
          />
        </div>
        <button
          type="submit"
          disabled={disabled || !draft.trim()}
          className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 border-l border-border bg-slate-50 px-3 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          <span>{addLabel}</span>
        </button>
      </form>
      {hint}
    </div>
  );
}

export default function Settings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    hasPassword,
    isReadOnly,
    passkeysAvailable,
    totpEnabled,
    refresh: refreshAuth,
  } = useAuth();
  const isAdmin = !isReadOnly;
  const availableTabs = isAdmin ? SETTINGS_TABS : READ_ONLY_SETTINGS_TABS;
  const activeTab = parseSettingsTab(
    searchParams.get(SETTINGS_TAB_PARAM),
    availableTabs,
  );
  const { data: settingsResponse, isLoading } = useSettingsResponse();
  const updateSettings = useUpdateSettings();
  const updatePreferences = useUpdatePreferences();
  const { addToast } = useToast();
  const { browserLanguage, t } = useI18n();
  const { browserTimeFormat, formatDate } = useDateTime();
  const { logoUrl, logoDarkUrl, theme: brandingTheme } = useBranding();
  const uploadAppLogo = useUploadAppLogo();
  const resetAppLogo = useResetAppLogo();
  const uploadAppDarkLogo = useUploadAppDarkLogo();
  const resetAppDarkLogo = useResetAppDarkLogo();
  const updateAppTheme = useUpdateAppTheme();
  const [themeDraft, setThemeDraft] = useState<BrandingTheme | null>(null);
  const draftTheme = themeDraft ?? brandingTheme;
  const logoInputRef = useRef<HTMLInputElement | null>(null);
  const darkLogoInputRef = useRef<HTMLInputElement | null>(null);
  const logoBusy =
    uploadAppLogo.isPending ||
    resetAppLogo.isPending ||
    uploadAppDarkLogo.isPending ||
    resetAppDarkLogo.isPending;
  const maxLogoSize = `${MAX_APP_LOGO_BYTES / 1024} KB`;

  const { data: passkeys, isLoading: passkeysLoading } = usePasskeys();
  const deletePasskey = useDeletePasskey();
  const registerPasskey = useRegisterPasskey();
  const renamePasskey = useRenamePasskey();
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState("");
  const [newPasskeyName, setNewPasskeyName] = useState("");
  const [showNamePrompt, setShowNamePrompt] = useState(false);

  const { data: apiTokens, isLoading: tokensLoading } = useApiTokens(isAdmin);
  const createApiToken = useCreateApiToken();
  const renameApiToken = useRenameApiToken();
  const deleteApiToken = useDeleteApiToken();
  const [tokenDeleteTarget, setTokenDeleteTarget] = useState<number | null>(
    null,
  );
  const [tokenEditingId, setTokenEditingId] = useState<number | null>(null);
  const [tokenEditingName, setTokenEditingName] = useState("");
  const [showTokenForm, setShowTokenForm] = useState(false);
  const [newTokenName, setNewTokenName] = useState("");
  const [newTokenExpiry, setNewTokenExpiry] = useState("30");
  const [newTokenReadOnly, setNewTokenReadOnly] = useState(true);
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwError, setPwError] = useState("");
  const [pwLoading, setPwLoading] = useState(false);
  const [totpModalOpen, setTotpModalOpen] = useState(false);
  const [totpLoading, setTotpLoading] = useState(false);
  const [totpSaving, setTotpSaving] = useState(false);
  const [totpSecret, setTotpSecret] = useState("");
  const [totpOtpAuthUrl, setTotpOtpAuthUrl] = useState("");
  const [totpQrDataUrl, setTotpQrDataUrl] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [totpDisablePassword, setTotpDisablePassword] = useState("");

  const [form, setForm] = useState<Record<string, string>>({});
  // An empty value follows the instance default from General.
  const [preferenceForm, setPreferenceForm] = useState({
    language: "",
    time_format: "",
  });
  // The last loaded or saved values tell edited fields apart when the settings reload.
  const loadedFormRef = useRef<Record<string, string>>({});
  const loadedPreferencesRef = useRef(preferenceForm);
  const instanceLanguage = normalizeLanguagePreference(
    settingsResponse?.settings[LANGUAGE_SETTING_KEY],
  );
  const instanceTimeFormat =
    settingsResponse?.settings[TIME_FORMAT_SETTING_KEY] || BROWSER_TIME_FORMAT_SETTING;
  const [oidcListDrafts, setOidcListDrafts] = useState<
    Record<OidcListField, string>
  >({ oidc_scope: "", oidc_admin_groups: "", oidc_read_only_groups: "" });
  const [storedSecrets, setStoredSecrets] = useState<Record<string, boolean>>(
    {},
  );
  const managedSettings = settingsResponse?.managedSettings ?? {};
  const allAuthSettingsManaged = AUTHENTICATION_SETTING_KEYS.every(
    (key) => key in managedSettings,
  );
  const saving = updateSettings.isPending || updateAppTheme.isPending;

  // Icons are Lucide's CircleUser, SlidersHorizontal, KeyRound, Users, CodeXml and Palette.
  const allSettingsTabs: TabItem<SettingsTab>[] = [
    {
      id: "account",
      label: t("pages.settings.profile"),
      icon: "M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0M9 10a3 3 0 1 0 6 0a3 3 0 1 0-6 0M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662",
    },
    {
      id: "general",
      label: t("pages.settings.general"),
      icon: "M10 5H3M12 19H3M14 3v4M16 17v4M21 12h-9M21 19h-5M21 5h-7M8 10v4M8 12H3",
    },
    {
      id: "authentication",
      label: t("pages.settings.authentication"),
      icon: "M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4zM16 7.5a.5.5 0 1 0 1 0a.5.5 0 1 0-1 0",
    },
    {
      id: "users",
      label: t("pages.settings.users"),
      icon: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M5 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
    },
    {
      id: "api-tokens",
      label: t("pages.settings.apiTokens"),
      icon: "m18 16 4-4-4-4m-12 0-4 4 4 4m8.5-12-5 16",
    },
    {
      id: "branding",
      label: t("pages.settings.branding"),
      icon: "M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8zM13 6.5a.5.5 0 1 0 1 0a.5.5 0 1 0-1 0M17 10.5a.5.5 0 1 0 1 0a.5.5 0 1 0-1 0M6 12.5a.5.5 0 1 0 1 0a.5.5 0 1 0-1 0M8 7.5a.5.5 0 1 0 1 0a.5.5 0 1 0-1 0",
    },
  ];
  const settingsTabs = allSettingsTabs.filter((tab) =>
    availableTabs.includes(tab.id),
  );

  // Edits live in page state, so they survive switching tabs.
  const selectTab = (tab: SettingsTab) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (tab === availableTabs[0]) {
          next.delete(SETTINGS_TAB_PARAM);
        } else {
          next.set(SETTINGS_TAB_PARAM, tab);
        }
        return next;
      },
      { replace: true },
    );
  };
  const numericSettingRules: NumericSettingRules = {
    ...NUMERIC_SETTING_RULES,
    ...(settingsResponse?.numericSettingRules ?? {}),
  };

  useEffect(() => {
    if (settingsResponse?.settings) {
      const cleanedForm = { ...settingsResponse.settings };
      const secrets: Record<string, boolean> = {};
      for (const key of SECRET_SETTING_KEYS) {
        if (cleanedForm[key] === "(stored)") {
          secrets[key] = true;
          cleanedForm[key] = "";
        }
      }
      const loadedPreferences = {
        language: settingsResponse.preferences?.language ?? "",
        time_format: settingsResponse.preferences?.time_format ?? "",
      };
      const previousForm = loadedFormRef.current;
      const previousPreferences = loadedPreferencesRef.current;
      loadedFormRef.current = cleanedForm;
      loadedPreferencesRef.current = loadedPreferences;
      setStoredSecrets(secrets);
      setForm((prev) => mergeLoadedDraft(prev, previousForm, cleanedForm));
      setPreferenceForm((prev) =>
        mergeLoadedDraft(prev, previousPreferences, loadedPreferences),
      );
    }
  }, [settingsResponse]);

  useEffect(() => {
    let cancelled = false;
    if (!totpOtpAuthUrl) {
      setTotpQrDataUrl("");
      return () => {
        cancelled = true;
      };
    }

    void QRCode.toDataURL(totpOtpAuthUrl, {
      width: 256,
      margin: 1,
      color: {
        dark: "#0f172a",
        light: "#ffffff",
      },
    })
      .then((dataUrl) => {
        if (!cancelled) setTotpQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setTotpQrDataUrl("");
      });

    return () => {
      cancelled = true;
    };
  }, [totpOtpAuthUrl]);

  const setNumericField = (key: NumericSettingKey, value: string) => {
    setForm((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  const normalizeNumericField = (key: NumericSettingKey) => {
    setForm((prev) => ({
      ...prev,
      [key]: normalizeIntegerSetting(key, prev[key] ?? "", numericSettingRules),
    }));
  };

  /**
   * Saves the given settings in one request. `saveExtra` runs first, for settings
   * stored through another endpoint. Resolves to whether everything was saved.
   */
  const handleSave = async (
    keys: string[],
    saveExtra?: () => Promise<unknown>,
  ): Promise<boolean> => {
    // Environment-managed settings are read-only and rejected by the server.
    const editableKeys = keys.filter((k) => !(k in managedSettings));
    if (editableKeys.length === 0 && !saveExtra) return false;
    const data: Record<string, string> = {};
    for (const k of editableKeys) {
      if (storedSecrets[k] && !form[k]) {
        data[k] = "(stored)";
      } else {
        data[k] = form[k] ?? "";
      }
    }
    const normalizedData = normalizeSettingsUpdate(data, numericSettingRules);
    setForm((prev) => ({ ...prev, ...normalizedData }));
    const toastT =
      LANGUAGE_SETTING_KEY in normalizedData
        ? (key: string, values?: TranslationValues) =>
            translateForLanguage(
              resolveLanguagePreference(
                normalizeLanguagePreference(
                  normalizedData[LANGUAGE_SETTING_KEY],
                ),
              ),
              key,
              values,
            )
        : t;

    try {
      await saveExtra?.();
      const res =
        editableKeys.length > 0
          ? await updateSettings.mutateAsync(normalizedData)
          : undefined;
      // Saved values count as loaded, so they no longer read as edits even
      // when the reloaded settings come back unchanged.
      const saved = { ...normalizedData };
      for (const k of SECRET_SETTING_KEYS) {
        if (!(k in saved)) continue;
        const sent = saved[k];
        saved[k] = "";
        setStoredSecrets((prev) => ({ ...prev, [k]: sent !== "" }));
        setForm((prev) => (prev[k] === sent ? { ...prev, [k]: "" } : prev));
      }
      loadedFormRef.current = { ...loadedFormRef.current, ...saved };
      if (res?.oidcError) {
        addToast(
          toastT("pages.settings.settingsSavedButOidcConfigurationFailedError", {
            error: res.oidcError,
          }),
          "danger",
        );
      } else {
        addToast(toastT("pages.settings.settingsSaved"), "success");
      }
      return true;
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), "danger");
      return false;
    }
  };

  const handleSaveGeneral = () => {
    void handleSave(GENERAL_SETTING_KEYS);
  };

  const handleSavePreferences = () => {
    const language = normalizeLanguagePreference(
      preferenceForm.language || instanceLanguage,
    );
    const toastT = (key: string, values?: TranslationValues) =>
      translateForLanguage(resolveLanguagePreference(language), key, values);
    const saved = { ...preferenceForm };
    updatePreferences.mutate(
      {
        [LANGUAGE_SETTING_KEY]: saved.language || null,
        [TIME_FORMAT_SETTING_KEY]: saved.time_format || null,
      },
      {
        onSuccess: () => {
          loadedPreferencesRef.current = saved;
          addToast(toastT("pages.settings.settingsSaved"), "success");
        },
        onError: (err) => addToast(err.message, "danger"),
      },
    );
  };

  const handleSaveAuthentication = () => {
    void handleSave(AUTHENTICATION_SETTING_KEYS).then((saved) => {
      if (saved) refreshAuth();
    });
  };

  const handleSaveBranding = () => {
    const themeChanged =
      themeDraft !== null && !isSameBrandingTheme(themeDraft, brandingTheme);
    void handleSave(
      [APP_NAME_SETTING_KEY],
      themeChanged
        ? async () => {
            await updateAppTheme.mutateAsync(themeDraft);
            setThemeDraft(null);
          }
        : undefined,
    );
  };

  const addOidcListItem = (field: OidcListField) => {
    const draft = oidcListDrafts[field].trim();
    if (!draft) return;
    const additions =
      field === "oidc_scope" ? draft.split(/\s+/) : [draft];
    setForm((prev) => {
      const current = parseOidcList(field, prev[field]);
      const next = [
        ...current,
        ...additions.filter((item) => !current.includes(item)),
      ];
      return { ...prev, [field]: serializeOidcList(field, next) };
    });
    setOidcListDrafts((prev) => ({ ...prev, [field]: "" }));
  };

  const removeOidcListItem = (field: OidcListField, item: string) => {
    setForm((prev) => ({
      ...prev,
      [field]: serializeOidcList(
        field,
        parseOidcList(field, prev[field]).filter((entry) => entry !== item),
      ),
    }));
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwError("");
    if (newPassword !== confirmPassword) {
      setPwError(t("pages.settings.passwordsDoNotMatch"));
      return;
    }
    const passwordError = validatePassword(newPassword);
    if (passwordError) {
      setPwError(passwordError);
      return;
    }
    setPwLoading(true);
    try {
      await apiFetch("/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      addToast(t("pages.settings.passwordChangedSuccessfully"), "success");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err: unknown) {
      setPwError(
        (err as Error).message || t("pages.settings.failedToChangePassword"),
      );
    } finally {
      setPwLoading(false);
    }
  };

  const openTotpModal = async () => {
    setTotpModalOpen(true);
    setTotpCode("");
    setTotpDisablePassword("");
    setTotpSecret("");
    setTotpOtpAuthUrl("");
    setTotpQrDataUrl("");

    if (!totpEnabled) {
      await startTotpSetup();
    }
  };

  const startTotpSetup = async () => {
    setTotpLoading(true);
    try {
      const payload = await apiFetch<{ secret: string; otpauthUrl: string }>(
        "/auth/totp/setup",
        { method: "POST" },
      );
      setTotpSecret(payload.secret);
      setTotpOtpAuthUrl(payload.otpauthUrl);
    } catch (err: unknown) {
      setTotpModalOpen(false);
      addToast(
        (err as Error).message || t("pages.settings.failedToStartTotpSetup"),
        "danger",
      );
    } finally {
      setTotpLoading(false);
    }
  };

  const closeTotpModal = () => {
    if (totpSaving) return;
    setTotpModalOpen(false);
  };

  const enableTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!totpSecret) {
      return;
    }
    setTotpSaving(true);
    try {
      await apiFetch("/auth/totp/enable", {
        method: "POST",
        body: JSON.stringify({ code: totpCode }),
      });
      addToast(t("pages.settings.totpEnabled"), "success");
      setTotpModalOpen(false);
      await refreshAuth();
    } catch (err: unknown) {
      addToast(
        (err as Error).message || t("pages.settings.failedToEnableTotp"),
        "danger",
      );
    } finally {
      setTotpSaving(false);
    }
  };

  const disableTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    setTotpSaving(true);
    try {
      await apiFetch("/auth/totp", {
        method: "DELETE",
        body: JSON.stringify({ currentPassword: totpDisablePassword }),
      });
      addToast(t("pages.settings.totpDisabled"), "success");
      setTotpModalOpen(false);
      await refreshAuth();
    } catch (err: unknown) {
      addToast(
        (err as Error).message || t("pages.settings.failedToDisableTotp"),
        "danger",
      );
    } finally {
      setTotpSaving(false);
    }
  };

  const handleLogoSelected = (
    e: React.ChangeEvent<HTMLInputElement>,
    variant: AppLogoVariant,
  ) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.type && !ACCEPTED_APP_LOGO_TYPES.includes(file.type)) {
      addToast(t("pages.settings.logoUnsupportedType"), "danger");
      return;
    }
    if (file.size > MAX_APP_LOGO_BYTES) {
      addToast(t("pages.settings.logoTooLarge", { size: maxLogoSize }), "danger");
      return;
    }
    const upload = variant === "dark" ? uploadAppDarkLogo : uploadAppLogo;
    upload.mutate(file, {
      onSuccess: () =>
        addToast(
          t(variant === "dark" ? "pages.settings.darkLogoUpdated" : "pages.settings.logoUpdated"),
          "success",
        ),
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  const handleResetLogo = (variant: AppLogoVariant) => {
    const reset = variant === "dark" ? resetAppDarkLogo : resetAppLogo;
    reset.mutate(undefined, {
      onSuccess: () =>
        addToast(
          t(variant === "dark" ? "pages.settings.darkLogoRemoved" : "pages.settings.logoReset"),
          "success",
        ),
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  const copyTotpSecret = async () => {
    if (!navigator.clipboard || !totpSecret) return;
    await navigator.clipboard.writeText(totpSecret);
    addToast(t("pages.settings.copied"), "success");
  };

  const logoButtonClass =
    "px-3 py-1.5 text-sm rounded-lg border border-border hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors disabled:opacity-50";

  const renderLogoField = (variant: AppLogoVariant) => {
    const dark = variant === "dark";
    const inputRef = dark ? darkLogoInputRef : logoInputRef;
    const customUrl = dark ? logoDarkUrl : logoUrl;
    const uploading = dark ? uploadAppDarkLogo.isPending : uploadAppLogo.isPending;
    return (
      <div data-testid={`settings-logo-${variant}`}>
        <label className={labelClass}>
          {t(dark ? "pages.settings.darkLogo" : "pages.settings.logo")}
        </label>
        <div className="flex items-center gap-4">
          {/* Fixed light and dark tiles show each logo on the background it is used on. */}
          <div
            className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border ${dark ? "border-slate-700 bg-slate-900" : "border-slate-200 bg-slate-50"}`}
          >
            <AppLogo size={48} variant={variant} />
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPTED_APP_LOGO_TYPES.join(",")}
              onChange={(e) => handleLogoSelected(e, variant)}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={logoBusy}
              className={logoButtonClass}
            >
              {uploading ? (
                <span className="spinner spinner-sm" />
              ) : (
                t("pages.settings.uploadLogo")
              )}
            </button>
            {customUrl && (
              <button
                type="button"
                onClick={() => handleResetLogo(variant)}
                disabled={logoBusy}
                className={logoButtonClass}
              >
                {t(dark ? "pages.settings.removeLogo" : "pages.settings.resetLogo")}
              </button>
            )}
          </div>
        </div>
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          {dark
            ? t("pages.settings.darkLogoHelp")
            : t("pages.settings.logoHelp", { size: maxLogoSize })}
        </p>
      </div>
    );
  };

  const inputClass =
    "w-full px-3 py-2 rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm disabled:cursor-not-allowed disabled:opacity-60";
  const labelClass =
    "block text-xs font-medium uppercase tracking-wide text-slate-500 mb-1";

  if (isLoading) {
    return (
      <Layout title={t("pages.settings.settings")}>
        <div className="flex justify-center py-16">
          <span className="spinner !w-6 !h-6 text-blue-500" />
        </div>
      </Layout>
    );
  }

  return (
    <Layout title={t("pages.settings.settings")}>
      <Tabs
        idPrefix="settings"
        label={t("pages.settings.settings")}
        tabs={settingsTabs}
        value={activeTab}
        onChange={selectTab}
      />

      {activeTab === "general" && (
        <TabPanel idPrefix="settings" id="general">
          <SettingSection title={t("pages.settings.general")}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-2xl">
              <div>
                <label className={labelClass}>
                  {t("pages.settings.activityHistory")}
                </label>
                <input
                  type="number"
                  min={numericSettingRules.activity_history_limit.min}
                  max={numericSettingRules.activity_history_limit.max}
                  value={form.activity_history_limit || "20"}
                  onChange={(e) =>
                    setNumericField("activity_history_limit", e.target.value)
                  }
                  onBlur={() => normalizeNumericField("activity_history_limit")}
                  className={inputClass}
                />
                <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                  {t("pages.settings.keepsOnlyThisManyRecentActivityEntriesPer")}
                </p>
              </div>
              <div>
                <label className={labelClass}>
                  {t("pages.settings.eolWarningWindowDays")}
                </label>
                <input
                  type="number"
                  min={numericSettingRules.distro_eol_warning_days.min}
                  max={numericSettingRules.distro_eol_warning_days.max}
                  value={form.distro_eol_warning_days || "180"}
                  onChange={(e) =>
                    setNumericField("distro_eol_warning_days", e.target.value)
                  }
                  onBlur={() => normalizeNumericField("distro_eol_warning_days")}
                  className={inputClass}
                />
                <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                  {t("pages.settings.showsDashboardAndSystemWarningsThisManyDays")}
                </p>
              </div>
              <div>
                <label className={labelClass}>{t("pages.settings.defaultLanguage")}</label>
                <select
                  value={form[LANGUAGE_SETTING_KEY] || BROWSER_LANGUAGE_SETTING}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      [LANGUAGE_SETTING_KEY]: e.target.value,
                    })
                  }
                  className={inputClass}
                >
                  <option value={BROWSER_LANGUAGE_SETTING}>
                    {t("pages.settings.browserDefaultLanguage", {
                      language: getLanguageLabel(browserLanguage),
                    })}
                  </option>
                  {SUPPORTED_LANGUAGES.map((language) => (
                    <option key={language.code} value={language.code}>
                      {language.label}
                    </option>
                  ))}
                </select>
                <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                  {t("pages.settings.defaultLanguageHelp")}
                </p>
              </div>
              <div>
                <label className={labelClass}>
                  {t("pages.settings.defaultTimeFormat")}
                </label>
                <select
                  value={
                    form[TIME_FORMAT_SETTING_KEY] || BROWSER_TIME_FORMAT_SETTING
                  }
                  onChange={(e) =>
                    setForm({
                      ...form,
                      [TIME_FORMAT_SETTING_KEY]: e.target.value,
                    })
                  }
                  className={inputClass}
                >
                  <option value={BROWSER_TIME_FORMAT_SETTING}>
                    {t("pages.settings.browserDefaultTimeFormat", {
                      format: t(`pages.settings.timeFormat.${browserTimeFormat}`),
                    })}
                  </option>
                  <option value="12h">{t("pages.settings.timeFormat.12h")}</option>
                  <option value="24h">{t("pages.settings.timeFormat.24h")}</option>
                </select>
                <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                  {t("pages.settings.defaultTimeFormatHelp")}
                </p>
              </div>
            </div>
          </SettingSection>

          {/* SSH */}
          <SettingSection title={t("pages.settings.ssh")}>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className={labelClass}>
                  {t("pages.settings.connectionTimeoutS")}
                </label>
                <input
                  type="number"
                  value={form.ssh_timeout_seconds || "30"}
                  onChange={(e) =>
                    setNumericField("ssh_timeout_seconds", e.target.value)
                  }
                  onBlur={() => normalizeNumericField("ssh_timeout_seconds")}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>
                  {t("pages.settings.commandTimeoutS")}
                </label>
                <input
                  type="number"
                  value={form.cmd_timeout_seconds || "120"}
                  onChange={(e) =>
                    setNumericField("cmd_timeout_seconds", e.target.value)
                  }
                  onBlur={() => normalizeNumericField("cmd_timeout_seconds")}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>
                  {t("pages.settings.concurrentConnections")}
                </label>
                <input
                  type="number"
                  value={form.concurrent_connections || "5"}
                  onChange={(e) =>
                    setNumericField("concurrent_connections", e.target.value)
                  }
                  onBlur={() => normalizeNumericField("concurrent_connections")}
                  className={inputClass}
                />
              </div>
            </div>
            <div className="mt-4 pt-4 border-t border-border">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.enable_root_user_check !== "false"}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      enable_root_user_check: e.target.checked ? "true" : "false",
                    })
                  }
                  className="mt-0.5 rounded border-border"
                />
                <span>
                  <span className="block text-sm">
                    {t("pages.settings.leastPrivilegeRootUserCheck")}
                  </span>
                  <span className="block mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {t("pages.settings.showANoticeWhenASystemConnectsAs")}
                  </span>
                </span>
              </label>
            </div>
          </SettingSection>
          <button
            type="button"
            onClick={handleSaveGeneral}
            disabled={saving}
            className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
          >
            {t("pages.settings.save")}
          </button>
        </TabPanel>
      )}

      {activeTab === "account" && (
        <TabPanel idPrefix="settings" id="account">
          <SettingSection
            title={t("pages.settings.preferences")}
            description={t("pages.settings.preferencesDescription")}
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-2xl">
              <div>
                <label htmlFor="account-language" className={labelClass}>
                  {t("pages.settings.language")}
                </label>
                <select
                  id="account-language"
                  value={preferenceForm.language}
                  onChange={(e) =>
                    setPreferenceForm({ ...preferenceForm, language: e.target.value })
                  }
                  className={inputClass}
                >
                  <option value="">
                    {t("pages.settings.instanceDefault", {
                      value:
                        instanceLanguage === BROWSER_LANGUAGE_SETTING
                          ? t("pages.settings.browserDefaultLanguage", {
                              language: getLanguageLabel(browserLanguage),
                            })
                          : getLanguageLabel(instanceLanguage),
                    })}
                  </option>
                  <option value={BROWSER_LANGUAGE_SETTING}>
                    {t("pages.settings.browserDefaultLanguage", {
                      language: getLanguageLabel(browserLanguage),
                    })}
                  </option>
                  {SUPPORTED_LANGUAGES.map((language) => (
                    <option key={language.code} value={language.code}>
                      {language.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="account-time-format" className={labelClass}>
                  {t("pages.settings.timeFormat")}
                </label>
                <select
                  id="account-time-format"
                  value={preferenceForm.time_format}
                  onChange={(e) =>
                    setPreferenceForm({ ...preferenceForm, time_format: e.target.value })
                  }
                  className={inputClass}
                >
                  <option value="">
                    {t("pages.settings.instanceDefault", {
                      value: t(
                        `pages.settings.timeFormat.${
                          instanceTimeFormat === BROWSER_TIME_FORMAT_SETTING
                            ? browserTimeFormat
                            : instanceTimeFormat
                        }`,
                      ),
                    })}
                  </option>
                  <option value={BROWSER_TIME_FORMAT_SETTING}>
                    {t("pages.settings.browserDefaultTimeFormat", {
                      format: t(`pages.settings.timeFormat.${browserTimeFormat}`),
                    })}
                  </option>
                  <option value="12h">{t("pages.settings.timeFormat.12h")}</option>
                  <option value="24h">{t("pages.settings.timeFormat.24h")}</option>
                </select>
              </div>
            </div>
            <button
              type="button"
              onClick={handleSavePreferences}
              disabled={updatePreferences.isPending}
              className="mt-6 px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
            >
              {t("pages.settings.save")}
            </button>
          </SettingSection>

          {hasPassword && (
            <SettingSection title={t("pages.settings.password")}>
              <>
                <h3 className="text-sm font-semibold mb-4">
                  {t("pages.settings.changePassword")}
                </h3>
                <form
                  onSubmit={handleChangePassword}
                  className="space-y-4 max-w-sm"
                >
                  {pwError && (
                    <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm">
                      {pwError}
                    </div>
                  )}
                  <div>
                    <label className={labelClass}>
                      {t("pages.settings.currentPassword")}
                    </label>
                    <input
                      type="password"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      required
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>
                      {t("pages.settings.newPassword")}
                    </label>
                    <input
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      required
                      minLength={8}
                      className={inputClass}
                    />
                    <p className="mt-1 text-xs text-slate-400">
                      {t(
                        "pages.settings.minimumCharactersMustIncludeUppercaseLowercaseAndA",
                      )}
                    </p>
                  </div>
                  <div>
                    <label className={labelClass}>
                      {t("pages.settings.confirmNewPassword")}
                    </label>
                    <input
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      required
                      className={inputClass}
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={pwLoading}
                    className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
                  >
                    {pwLoading ? (
                      <span className="spinner spinner-sm" />
                    ) : (
                      t("pages.settings.changePassword")
                    )}
                  </button>
                </form>

                <hr className="my-6 border-border" />
                <h3 className="text-sm font-semibold mb-2">
                  {t("pages.settings.twoFactorAuthentication")}
                </h3>
                <p className="max-w-lg text-sm text-slate-500 dark:text-slate-400">
                  {totpEnabled
                    ? t("pages.settings.totpEnabledDescription")
                    : t("pages.settings.totpDisabledDescription")}
                </p>
                <button
                  type="button"
                  onClick={() => void openTotpModal()}
                  className={`mt-4 px-4 py-2 text-sm rounded-lg text-white transition-colors disabled:opacity-50 ${
                    totpEnabled
                      ? "bg-red-600 hover:bg-red-700"
                      : "bg-blue-600 hover:bg-blue-700"
                  }`}
                >
                  {totpEnabled
                    ? t("pages.settings.disableTotp")
                    : t("pages.settings.enableTotp")}
                </button>

                <Modal
                  open={totpModalOpen}
                  onClose={closeTotpModal}
                  title={
                    totpEnabled
                      ? t("pages.settings.disableTotp")
                      : t("pages.settings.enableTotp")
                  }
                  dismissible={!totpSaving}
                >
                  {totpEnabled ? (
                    <form onSubmit={disableTotp} className="space-y-4">
                      <p className="text-sm text-slate-500 dark:text-slate-400">
                        {t("pages.settings.disableTotpDescription")}
                      </p>
                      <div>
                        <label className={labelClass}>
                          {t("pages.settings.currentPassword")}
                        </label>
                        <input
                          type="password"
                          value={totpDisablePassword}
                          onChange={(e) => setTotpDisablePassword(e.target.value)}
                          required
                          autoComplete="current-password"
                          className={inputClass}
                        />
                      </div>
                      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                        <button
                          type="button"
                          onClick={closeTotpModal}
                          disabled={totpSaving}
                          className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors disabled:opacity-50"
                        >
                          {t("pages.settings.cancel")}
                        </button>
                        <button
                          type="submit"
                          disabled={totpSaving || !totpDisablePassword}
                          className="px-4 py-2 text-sm rounded-lg bg-red-600 hover:bg-red-700 text-white transition-colors disabled:opacity-50"
                        >
                          {totpSaving ? (
                            <span className="spinner spinner-sm" />
                          ) : (
                            t("pages.settings.disableTotp")
                          )}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <form onSubmit={enableTotp} className="space-y-4">
                      <p className="text-sm text-slate-500 dark:text-slate-400">
                        {t("pages.settings.setupTotpDescription")}
                      </p>
                      {totpLoading ? (
                        <div className="flex justify-center py-8">
                          <span className="spinner !w-6 !h-6 text-blue-500" />
                        </div>
                      ) : totpSecret ? (
                        <>
                          <div className="flex flex-col items-center gap-3">
                            {totpQrDataUrl ? (
                              <img
                                src={totpQrDataUrl}
                                alt={t("pages.settings.totpQrAlt")}
                                className="w-full max-w-64 rounded-lg border border-border bg-white p-3"
                              />
                            ) : (
                              <div className="flex h-64 w-full max-w-64 items-center justify-center rounded-lg border border-border bg-slate-50 text-sm text-slate-500 dark:bg-slate-900">
                                {t("pages.settings.generatingQrCode")}
                              </div>
                            )}
                            {totpOtpAuthUrl && (
                              <a
                                href={totpOtpAuthUrl}
                                className="inline-flex min-h-10 items-center justify-center rounded-lg border border-border px-4 py-2 text-center text-sm font-medium transition-colors hover:bg-slate-100 dark:hover:bg-slate-700"
                              >
                                {t("pages.settings.openAuthenticatorApp")}
                              </a>
                            )}
                          </div>
                          <div>
                            <label className={labelClass}>
                              {t("pages.settings.manualTotpSecret")}
                            </label>
                            <div className="flex gap-2">
                              <input
                                value={totpSecret}
                                readOnly
                                className={`${inputClass} font-mono`}
                              />
                              <button
                                type="button"
                                onClick={() => void copyTotpSecret()}
                                disabled={!totpSecret}
                                className="shrink-0 px-3 py-2 text-sm rounded-lg border border-border hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors disabled:opacity-50"
                              >
                                {t("pages.settings.copy")}
                              </button>
                            </div>
                          </div>
                          <div>
                            <label className={labelClass}>
                              {t("pages.settings.authenticatorCode")}
                            </label>
                            <input
                              value={totpCode}
                              onChange={(e) => setTotpCode(e.target.value)}
                              required
                              inputMode="numeric"
                              autoComplete="one-time-code"
                              pattern="[0-9 ]*"
                              className={inputClass}
                            />
                          </div>
                        </>
                      ) : null}
                      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                        <button
                          type="button"
                          onClick={closeTotpModal}
                          disabled={totpSaving}
                          className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors disabled:opacity-50"
                        >
                          {t("pages.settings.cancel")}
                        </button>
                        <button
                          type="submit"
                          disabled={
                            totpLoading ||
                            totpSaving ||
                            !totpSecret ||
                            !totpCode.trim()
                          }
                          className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
                        >
                          {totpSaving || totpLoading ? (
                            <span className="spinner spinner-sm" />
                          ) : totpSecret ? (
                            t("pages.settings.verifyAndEnableTotp")
                          ) : (
                            t("pages.settings.enableTotp")
                          )}
                        </button>
                      </div>
                    </form>
                  )}
                </Modal>
              </>
            </SettingSection>
          )}

          {/* Passkeys — only in secure contexts where WebAuthn is available */}
          {window.isSecureContext && passkeysAvailable && (
            <SettingSection title={t("pages.settings.passkeys")}>
              {passkeysLoading ? (
                <div className="flex justify-center py-4">
                  <span className="spinner !w-5 !h-5 text-blue-500" />
                </div>
              ) : passkeys && passkeys.length > 0 ? (
                <div className="space-y-2 mb-4">
                  {passkeys.map((pk) => (
                    <div
                      key={pk.id}
                      className="flex items-center justify-between p-3 rounded-lg border border-border"
                    >
                      <div className="min-w-0 flex items-center">
                        {editingId === pk.id ? (
                          <input
                            autoFocus
                            value={editingName}
                            onChange={(e) => setEditingName(e.target.value)}
                            onBlur={() => {
                              const trimmed = editingName.trim();
                              const nameError = trimmed
                                ? validateRequiredText(trimmed, "Passkey name", 50)
                                : null;
                              if (nameError) {
                                addToast(nameError, "danger");
                              } else if (trimmed && trimmed !== (pk.name ?? "")) {
                                renamePasskey.mutate(
                                  { id: pk.id, name: trimmed },
                                  {
                                    onSuccess: () =>
                                      addToast(
                                        t("pages.settings.passkeyRenamed"),
                                        "success",
                                      ),
                                    onError: (err) =>
                                      addToast(
                                        err.message ||
                                          t("pages.settings.failedToRename"),
                                        "danger",
                                      ),
                                  },
                                );
                              }
                              setEditingId(null);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") e.currentTarget.blur();
                              if (e.key === "Escape") setEditingId(null);
                            }}
                            maxLength={50}
                            className="text-sm px-1.5 py-0.5 rounded border border-blue-500 bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 w-48"
                          />
                        ) : (
                          <button
                            onClick={() => {
                              setEditingId(pk.id);
                              setEditingName(pk.name ?? "");
                            }}
                            className="text-sm truncate hover:underline cursor-pointer text-left"
                            title={t("pages.settings.clickToRename")}
                          >
                            {pk.name || (
                              <span className="font-mono text-slate-400">
                                {pk.credentialId.slice(0, 16)}…
                              </span>
                            )}
                          </button>
                        )}
                        <span className="ml-3 text-xs text-slate-500 shrink-0">
                          {t("pages.settings.added")}{" "}
                          {formatDate(new Date(pk.createdAt + "Z"))}
                        </span>
                      </div>
                      <button
                        onClick={() => setDeleteTarget(pk.id)}
                        className="ml-4 shrink-0 p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500 transition-colors"
                        title={t("pages.settings.removePasskey")}
                        aria-label={t("pages.settings.removePasskeyName", {
                          name: pk.name || pk.credentialId.slice(0, 16),
                        })}
                      >
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                          />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-slate-500 mb-4">
                  {t(
                    "pages.settings.noPasskeysRegisteredAddOneToEnablePasswordless",
                  )}
                </p>
              )}

              {showNamePrompt ? (
                <div className="flex items-center gap-2">
                  <input
                    autoFocus
                    value={newPasskeyName}
                    onChange={(e) => setNewPasskeyName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        registerPasskey.mutate(newPasskeyName.trim() || undefined, {
                          onSuccess: () => {
                            addToast(
                              t("pages.settings.passkeyRegisteredSuccessfully"),
                              "success",
                            );
                            setShowNamePrompt(false);
                            setNewPasskeyName("");
                          },
                          onError: (err) =>
                            addToast(
                              err.message ||
                                t("pages.settings.failedToRegisterPasskey"),
                              "danger",
                            ),
                        });
                      }
                      if (e.key === "Escape") {
                        setShowNamePrompt(false);
                        setNewPasskeyName("");
                      }
                    }}
                    maxLength={50}
                    placeholder={t("pages.settings.passkeyNameEGYubikeyMacbook")}
                    className="px-3 py-2 text-sm rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 w-64"
                  />
                  <button
                    onClick={() => {
                      registerPasskey.mutate(newPasskeyName.trim() || undefined, {
                        onSuccess: () => {
                          addToast(
                            t("pages.settings.passkeyRegisteredSuccessfully"),
                            "success",
                          );
                          setShowNamePrompt(false);
                          setNewPasskeyName("");
                        },
                        onError: (err) =>
                          addToast(
                            err.message ||
                              t("pages.settings.failedToRegisterPasskey"),
                            "danger",
                          ),
                      });
                    }}
                    disabled={registerPasskey.isPending}
                    className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
                  >
                    {registerPasskey.isPending ? (
                      <span className="spinner spinner-sm" />
                    ) : (
                      t("pages.settings.register")
                    )}
                  </button>
                  <button
                    onClick={() => {
                      setShowNamePrompt(false);
                      setNewPasskeyName("");
                    }}
                    className="px-3 py-2 text-sm rounded-lg border border-border hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                  >
                    {t("pages.settings.cancel")}
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowNamePrompt(true)}
                  disabled={registerPasskey.isPending}
                  className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
                >
                  {t("pages.settings.registerNewPasskey")}
                </button>
              )}

              <ConfirmDialog
                open={deleteTarget !== null}
                onClose={() => setDeleteTarget(null)}
                onConfirm={() => {
                  if (deleteTarget !== null) {
                    deletePasskey.mutate(deleteTarget, {
                      onSuccess: () => {
                        addToast(t("pages.settings.passkeyRemoved"), "success");
                        setDeleteTarget(null);
                      },
                      onError: (err) => {
                        addToast(
                          err.message || t("pages.settings.failedToRemovePasskey"),
                          "danger",
                        );
                        setDeleteTarget(null);
                      },
                    });
                  }
                }}
                title={t("pages.settings.removePasskey2")}
                message={t("pages.settings.areYouSureYouWantToRemoveThis")}
                confirmLabel={t("pages.settings.remove")}
                danger
                loading={deletePasskey.isPending}
              />
            </SettingSection>
          )}

        </TabPanel>
      )}

      {activeTab === "users" && isAdmin && (
        <TabPanel idPrefix="settings" id="users">
          <UsersSettings />
        </TabPanel>
      )}

      {activeTab === "authentication" && (
        <TabPanel idPrefix="settings" id="authentication">
          {/* Password login */}
          <SettingSection title={t("pages.settings.passwordLogin")}>
            {(() => {
              const hasAlternativeAuth =
                (passkeys && passkeys.length > 0) ||
                !!(form.oidc_issuer && form.oidc_client_id);
              const passwordLoginEnvVar = managedSettings.disable_password_login;
              const canDisable = hasAlternativeAuth && !passwordLoginEnvVar;
              const checkboxDisabled =
                !!passwordLoginEnvVar ||
                (!canDisable && form.disable_password_login !== "true");
              return (
                <>
                  <label
                    className={`flex items-center gap-2 ${checkboxDisabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
                  >
                    <input
                      type="checkbox"
                      checked={form.disable_password_login === "true"}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          disable_password_login: e.target.checked
                            ? "true"
                            : "false",
                        })
                      }
                      disabled={checkboxDisabled}
                      className="rounded border-border"
                    />
                    <span className="text-sm">
                      {t("pages.settings.disablePasswordLogin")}
                    </span>
                  </label>
                  {passwordLoginEnvVar ? (
                    <ManagedSettingHint envVar={passwordLoginEnvVar} />
                  ) : !canDisable ? (
                    <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                      {t(
                        "pages.settings.registerAPasskeyOrConfigureSsoBeforeDisabling",
                      )}
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-slate-400">
                      {t("pages.settings.whenEnabledOnlyPasskeyAndSsoLoginMethods")}
                    </p>
                  )}
                  {settingsResponse?.passwordLoginFallback && (
                    <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                      {t("pages.settings.passwordLoginFallback")}
                    </p>
                  )}
                </>
              );
            })()}

          </SettingSection>

          {/* OIDC */}
          <SettingSection
            title={t("pages.settings.oidcSso")}
            description={t("pages.settings.oidcDescription")}
          >
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="lg:col-span-2">
                <label htmlFor="oidc-issuer" className={labelClass}>
                  {t("pages.settings.issuerUrl")}
                </label>
                <input
                  id="oidc-issuer"
                  disabled={!!managedSettings.oidc_issuer}
                  type="url"
                  value={form.oidc_issuer || ""}
                  onChange={(e) =>
                    setForm({ ...form, oidc_issuer: e.target.value })
                  }
                  className={inputClass}
                  placeholder="https://auth.example.com"
                />
                <ManagedSettingHint envVar={managedSettings.oidc_issuer} />
              </div>
              <div>
                <label htmlFor="oidc-client-id" className={labelClass}>
                  {t("pages.settings.clientId")}
                </label>
                <input
                  id="oidc-client-id"
                  disabled={!!managedSettings.oidc_client_id}
                  type="text"
                  value={form.oidc_client_id || ""}
                  onChange={(e) =>
                    setForm({ ...form, oidc_client_id: e.target.value })
                  }
                  className={inputClass}
                />
                <ManagedSettingHint envVar={managedSettings.oidc_client_id} />
              </div>
              <div>
                <label htmlFor="oidc-client-secret" className={labelClass}>
                  {t("pages.settings.clientSecret")}
                </label>
                <input
                  id="oidc-client-secret"
                  disabled={!!managedSettings.oidc_client_secret}
                  type="password"
                  value={form.oidc_client_secret || ""}
                  onChange={(e) =>
                    setForm({ ...form, oidc_client_secret: e.target.value })
                  }
                  className={inputClass}
                  placeholder={
                    storedSecrets.oidc_client_secret &&
                    !form.oidc_client_secret &&
                    !managedSettings.oidc_client_secret
                      ? t("pages.settings.unchanged")
                      : ""
                  }
                />
                <ManagedSettingHint envVar={managedSettings.oidc_client_secret} />
              </div>
              <div className="lg:col-span-2">
                <ListEditor
                  id="oidc-scopes"
                  label={t("pages.settings.oidcScopes")}
                  items={parseOidcList("oidc_scope", form.oidc_scope)}
                  draft={oidcListDrafts.oidc_scope}
                  onDraftChange={(value) =>
                    setOidcListDrafts((prev) => ({ ...prev, oidc_scope: value }))
                  }
                  onAdd={() => addOidcListItem("oidc_scope")}
                  disabled={!!managedSettings.oidc_scope}
                  hint={<ManagedSettingHint envVar={managedSettings.oidc_scope} />}
                  onRemove={(scope) => removeOidcListItem("oidc_scope", scope)}
                  canRemove={(scope) => scope !== "openid"}
                  placeholder={DEFAULT_OIDC_SCOPE}
                  addLabel={t("pages.settings.add")}
                  emptyLabel={t("pages.settings.noScopesConfigured")}
                  removeLabel={(scope) =>
                    t("pages.settings.removeScope", { scope })
                  }
                  labelClass={labelClass}
                />
              </div>
              <div>
                <label htmlFor="oidc-groups-claim" className={labelClass}>
                  {t("pages.settings.oidcGroupsClaim")}
                </label>
                <input
                  id="oidc-groups-claim"
                  disabled={!!managedSettings.oidc_groups_claim}
                  type="text"
                  value={form.oidc_groups_claim ?? ""}
                  onChange={(e) =>
                    setForm({ ...form, oidc_groups_claim: e.target.value })
                  }
                  className={inputClass}
                  placeholder="groups"
                />
                <ManagedSettingHint envVar={managedSettings.oidc_groups_claim} />
              </div>
              <div>
                <label htmlFor="oidc-unmatched-role" className={labelClass}>
                  {t("pages.settings.oidcUnmatchedRole")}
                </label>
                <select
                  id="oidc-unmatched-role"
                  disabled={!!managedSettings.oidc_unmatched_role}
                  aria-describedby="oidc-unmatched-role-help"
                  value={form.oidc_unmatched_role || "deny"}
                  onChange={(e) =>
                    setForm({ ...form, oidc_unmatched_role: e.target.value })
                  }
                  className={inputClass}
                >
                  <option value="deny">
                    {t("pages.settings.oidcUnmatchedRoleDeny")}
                  </option>
                  <option value="admin">
                    {t("pages.settings.oidcUnmatchedRoleAdmin")}
                  </option>
                  <option value="read-only">
                    {t("pages.settings.oidcUnmatchedRoleReadOnly")}
                  </option>
                </select>
                <p
                  id="oidc-unmatched-role-help"
                  className="mt-1 text-xs text-slate-500 dark:text-slate-400"
                >
                  {t("pages.settings.oidcUnmatchedRoleHelp")}
                </p>
                <ManagedSettingHint envVar={managedSettings.oidc_unmatched_role} />
              </div>
              <ListEditor
                id="oidc-admin-groups"
                label={t("pages.settings.oidcAdminGroups")}
                items={parseOidcList("oidc_admin_groups", form.oidc_admin_groups)}
                draft={oidcListDrafts.oidc_admin_groups}
                onDraftChange={(value) =>
                  setOidcListDrafts((prev) => ({
                    ...prev,
                    oidc_admin_groups: value,
                  }))
                }
                onAdd={() => addOidcListItem("oidc_admin_groups")}
                  disabled={!!managedSettings.oidc_admin_groups}
                  hint={<ManagedSettingHint envVar={managedSettings.oidc_admin_groups} />}
                onRemove={(group) =>
                  removeOidcListItem("oidc_admin_groups", group)
                }
                placeholder="ludash-admins"
                addLabel={t("pages.settings.add")}
                emptyLabel={t("pages.settings.noGroupsConfigured")}
                removeLabel={(group) => t("pages.settings.removeGroup", { group })}
                labelClass={labelClass}
              />
              <ListEditor
                id="oidc-read-only-groups"
                label={t("pages.settings.oidcReadOnlyGroups")}
                items={parseOidcList(
                  "oidc_read_only_groups",
                  form.oidc_read_only_groups,
                )}
                draft={oidcListDrafts.oidc_read_only_groups}
                onDraftChange={(value) =>
                  setOidcListDrafts((prev) => ({
                    ...prev,
                    oidc_read_only_groups: value,
                  }))
                }
                onAdd={() => addOidcListItem("oidc_read_only_groups")}
                  disabled={!!managedSettings.oidc_read_only_groups}
                  hint={<ManagedSettingHint envVar={managedSettings.oidc_read_only_groups} />}
                onRemove={(group) =>
                  removeOidcListItem("oidc_read_only_groups", group)
                }
                placeholder="ludash-viewers"
                addLabel={t("pages.settings.add")}
                emptyLabel={t("pages.settings.noGroupsConfigured")}
                removeLabel={(group) => t("pages.settings.removeGroup", { group })}
                labelClass={labelClass}
              />
              <label
                className={`lg:col-span-2 flex items-start gap-2 ${managedSettings.oidc_end_session ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
              >
                <input
                  type="checkbox"
                  checked={form.oidc_end_session === "true"}
                  disabled={!!managedSettings.oidc_end_session}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      oidc_end_session: e.target.checked ? "true" : "false",
                    })
                  }
                  className="mt-0.5 rounded border-border"
                />
                <span>
                  <span className="block text-sm">
                    {t("pages.settings.oidcEndSession")}
                  </span>
                  <span className="block mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {t("pages.settings.oidcEndSessionHelp", {
                      url: `${window.location?.origin ?? ""}/login`,
                    })}
                  </span>
                  <ManagedSettingHint envVar={managedSettings.oidc_end_session} />
                </span>
              </label>
              <label
                className={`lg:col-span-2 flex items-start gap-2 ${managedSettings.oidc_backchannel_logout ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
              >
                <input
                  type="checkbox"
                  checked={form.oidc_backchannel_logout === "true"}
                  disabled={!!managedSettings.oidc_backchannel_logout}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      oidc_backchannel_logout: e.target.checked ? "true" : "false",
                    })
                  }
                  className="mt-0.5 rounded border-border"
                />
                <span>
                  <span className="block text-sm">
                    {t("pages.settings.oidcBackchannelLogout")}
                  </span>
                  <span className="block mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {t("pages.settings.oidcBackchannelLogoutHelp", {
                      url: `${window.location?.origin ?? ""}/api/auth/oidc/backchannel-logout`,
                    })}
                  </span>
                  <ManagedSettingHint
                    envVar={managedSettings.oidc_backchannel_logout}
                  />
                </span>
              </label>
              <label
                className={`lg:col-span-2 flex items-start gap-2 ${managedSettings.oidc_auto_login ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
              >
                <input
                  type="checkbox"
                  checked={form.oidc_auto_login === "true"}
                  disabled={!!managedSettings.oidc_auto_login}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      oidc_auto_login: e.target.checked ? "true" : "false",
                    })
                  }
                  className="mt-0.5 rounded border-border"
                />
                <span>
                  <span className="block text-sm">
                    {t("pages.settings.oidcAutoLogin")}
                  </span>
                  <span className="block mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {t("pages.settings.oidcAutoLoginHelp", {
                      url: `${window.location?.origin ?? ""}/login?local=1`,
                    })}
                  </span>
                  {settingsResponse?.settings.oidc_auto_login === "true" &&
                    settingsResponse.oidcAutoLoginActive === false && (
                      <span className="block mt-1 text-xs text-amber-600 dark:text-amber-400">
                        {t("pages.settings.oidcAutoLoginInactive")}
                      </span>
                    )}
                  <ManagedSettingHint envVar={managedSettings.oidc_auto_login} />
                </span>
              </label>
            </div>
          </SettingSection>
          {!allAuthSettingsManaged && (
            <button
              type="button"
              onClick={handleSaveAuthentication}
              disabled={saving}
              className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
            >
              {t("pages.settings.save")}
            </button>
          )}
        </TabPanel>
      )}

      {activeTab === "api-tokens" && (
        <TabPanel idPrefix="settings" id="api-tokens">
          {/* API Tokens */}
          <SettingSection title={t("pages.settings.apiTokens")}>
            <p className="text-xs text-slate-500 mb-4">
              {t("pages.settings.useApiTokensToAccessDashboardDataFrom")}
            </p>
            {tokensLoading ? (
              <div className="flex justify-center py-4">
                <span className="spinner !w-5 !h-5 text-blue-500" />
              </div>
            ) : apiTokens && apiTokens.length > 0 ? (
              <div className="space-y-2 mb-4">
                {apiTokens.map((tk) => {
                  const isExpired = tk.expiresAt
                    ? new Date(tk.expiresAt + "Z") <= new Date()
                    : false;
                  return (
                    <div
                      key={tk.id}
                      className="flex items-center justify-between p-3 rounded-lg border border-border"
                    >
                      <div className="min-w-0 flex items-center flex-wrap gap-y-1">
                        {tokenEditingId === tk.id ? (
                          <input
                            autoFocus
                            value={tokenEditingName}
                            onChange={(e) => setTokenEditingName(e.target.value)}
                            onBlur={() => {
                              const trimmed = tokenEditingName.trim();
                              const nameError = trimmed
                                ? validateRequiredText(trimmed, "Token name", 50)
                                : null;
                              if (nameError) {
                                addToast(nameError, "danger");
                              } else if (trimmed && trimmed !== (tk.name ?? "")) {
                                renameApiToken.mutate(
                                  { id: tk.id, name: trimmed },
                                  {
                                    onSuccess: () =>
                                      addToast(
                                        t("pages.settings.tokenRenamed"),
                                        "success",
                                      ),
                                    onError: (err) =>
                                      addToast(
                                        err.message ||
                                          t("pages.settings.failedToRename"),
                                        "danger",
                                      ),
                                  },
                                );
                              }
                              setTokenEditingId(null);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") e.currentTarget.blur();
                              if (e.key === "Escape") setTokenEditingId(null);
                            }}
                            maxLength={50}
                            className="text-sm px-1.5 py-0.5 rounded border border-blue-500 bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 w-48"
                          />
                        ) : (
                          <button
                            onClick={() => {
                              setTokenEditingId(tk.id);
                              setTokenEditingName(tk.name ?? "");
                            }}
                            className="text-sm truncate hover:underline cursor-pointer text-left"
                            title={t("pages.settings.clickToRename")}
                          >
                            {tk.name || (
                              <span className="italic text-slate-400">
                                {t("pages.settings.unnamedToken")}
                              </span>
                            )}
                          </button>
                        )}
                        <span
                          className={`ml-2 text-xs px-1.5 py-0.5 rounded ${
                            tk.readOnly
                              ? "bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300"
                              : "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                          }`}
                        >
                          {tk.readOnly
                            ? t("pages.settings.readOnly")
                            : t("pages.settings.readWrite")}
                        </span>
                        {isExpired ? (
                          <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300">
                            {t("pages.settings.expired")}
                          </span>
                        ) : tk.expiresAt ? (
                          <span className="ml-2 text-xs text-slate-500 shrink-0">
                            {t("pages.settings.expires")}{" "}
                            {formatDate(new Date(tk.expiresAt + "Z"))}
                          </span>
                        ) : (
                          <span className="ml-2 text-xs text-slate-500 shrink-0">
                            {t("pages.settings.neverExpires")}
                          </span>
                        )}
                        <span className="ml-2 text-xs text-slate-500 shrink-0">
                          {t("pages.settings.created")}{" "}
                          {formatDate(new Date(tk.createdAt + "Z"))}
                        </span>
                      </div>
                      <button
                        onClick={() => setTokenDeleteTarget(tk.id)}
                        className="ml-4 shrink-0 p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500 transition-colors"
                        title={t("pages.settings.revokeApiToken")}
                        aria-label={t("pages.settings.revokeApiTokenName", {
                          name: tk.name ?? "",
                        })}
                      >
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                          />
                        </svg>
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-slate-500 mb-4">
                {t("pages.settings.noApiTokensCreatedYet")}
              </p>
            )}

            {showTokenForm ? (
              <div className="flex items-end gap-2 flex-wrap">
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">
                    {t("pages.settings.name")}
                  </label>
                  <input
                    autoFocus
                    value={newTokenName}
                    onChange={(e) => setNewTokenName(e.target.value)}
                    maxLength={50}
                    placeholder={t("pages.settings.eGHomepageWidget")}
                    className="px-3 py-2 text-sm rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 w-52"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">
                    {t("pages.settings.permission")}
                  </label>
                  <select
                    value={newTokenReadOnly ? "readonly" : "readwrite"}
                    onChange={(e) =>
                      setNewTokenReadOnly(e.target.value === "readonly")
                    }
                    className="px-3 py-2 text-sm rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="readonly">{t("pages.settings.readOnly")}</option>
                    <option value="readwrite">
                      {t("pages.settings.readWrite2")}
                    </option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">
                    {t("pages.settings.validFor")}
                  </label>
                  <select
                    value={newTokenExpiry}
                    onChange={(e) => setNewTokenExpiry(e.target.value)}
                    className="px-3 py-2 text-sm rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="30">{t("pages.settings.days")}</option>
                    <option value="60">{t("pages.settings.days2")}</option>
                    <option value="90">{t("pages.settings.days3")}</option>
                    <option value="365">{t("pages.settings.year")}</option>
                    <option value="0">{t("pages.settings.neverExpires")}</option>
                  </select>
                </div>
                <button
                  onClick={() => {
                    createApiToken.mutate(
                      {
                        name: newTokenName.trim() || undefined,
                        expiresInDays: parseInt(newTokenExpiry, 10),
                        readOnly: newTokenReadOnly,
                      },
                      {
                        onSuccess: (data) => {
                          setGeneratedToken(data.token);
                          setTokenCopied(false);
                          setShowTokenForm(false);
                          setNewTokenName("");
                          setNewTokenExpiry("30");
                          setNewTokenReadOnly(true);
                        },
                        onError: (err) =>
                          addToast(
                            err.message || t("pages.settings.failedToCreateToken"),
                            "danger",
                          ),
                      },
                    );
                  }}
                  disabled={createApiToken.isPending}
                  className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
                >
                  {createApiToken.isPending ? (
                    <span className="spinner spinner-sm" />
                  ) : (
                    t("pages.settings.generate")
                  )}
                </button>
                <button
                  onClick={() => {
                    setShowTokenForm(false);
                    setNewTokenName("");
                    setNewTokenExpiry("30");
                    setNewTokenReadOnly(true);
                  }}
                  className="px-3 py-2 text-sm rounded-lg border border-border hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                >
                  {t("pages.settings.cancel")}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowTokenForm(true)}
                className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
              >
                {t("pages.settings.generateNewToken")}
              </button>
            )}

            {/* Token created modal */}
            <Modal
              open={generatedToken !== null}
              onClose={() => setGeneratedToken(null)}
              title={t("pages.settings.apiTokenCreated")}
            >
              <p className="text-sm text-slate-600 dark:text-slate-300 mb-4">
                {t("pages.settings.copyThisTokenNowItWillNotBe")}
              </p>
              <div className="flex items-center gap-2 mb-6">
                <input
                  readOnly
                  value={generatedToken ?? ""}
                  className="flex-1 px-3 py-2 text-sm font-mono rounded-lg border border-border bg-slate-50 dark:bg-slate-900 select-all"
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                />
                <button
                  onClick={() => {
                    if (generatedToken) {
                      navigator.clipboard.writeText(generatedToken);
                      setTokenCopied(true);
                    }
                  }}
                  className="px-3 py-2 text-sm rounded-lg border border-border hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors shrink-0"
                >
                  {tokenCopied
                    ? t("pages.settings.copied")
                    : t("pages.settings.copy")}
                </button>
              </div>
              <div className="flex justify-end">
                <button
                  onClick={() => setGeneratedToken(null)}
                  className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors"
                >
                  {t("pages.settings.done")}
                </button>
              </div>
            </Modal>

            {/* Delete confirmation */}
            <ConfirmDialog
              open={tokenDeleteTarget !== null}
              onClose={() => setTokenDeleteTarget(null)}
              onConfirm={() => {
                if (tokenDeleteTarget !== null) {
                  deleteApiToken.mutate(tokenDeleteTarget, {
                    onSuccess: () => {
                      addToast(t("pages.settings.apiTokenRevoked"), "success");
                      setTokenDeleteTarget(null);
                    },
                    onError: (err) => {
                      addToast(
                        err.message || t("pages.settings.failedToRevokeToken"),
                        "danger",
                      );
                      setTokenDeleteTarget(null);
                    },
                  });
                }
              }}
              title={t("pages.settings.revokeApiToken2")}
              message={t("pages.settings.areYouSureYouWantToRevokeThis")}
              confirmLabel={t("pages.settings.revoke")}
              danger
              loading={deleteApiToken.isPending}
            />
          </SettingSection>
        </TabPanel>
      )}

      {activeTab === "branding" && (
        <TabPanel idPrefix="settings" id="branding">
          {/* Branding */}
          <SettingSection
            title={t("pages.settings.branding")}
            description={t("pages.settings.brandingDescription")}
          >
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div>
                <label className={labelClass}>{t("pages.settings.appName")}</label>
                <input
                  type="text"
                  value={form[APP_NAME_SETTING_KEY] || ""}
                  maxLength={MAX_APP_NAME_LENGTH}
                  placeholder={DEFAULT_APP_NAME}
                  onChange={(e) =>
                    setForm({ ...form, [APP_NAME_SETTING_KEY]: e.target.value })
                  }
                  className={inputClass}
                />
                <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                  {t("pages.settings.appNameHelp")}
                </p>
              </div>
              {/* Starts a new row so both logos sit side by side below the name. */}
              <div className="lg:col-start-1">{renderLogoField("default")}</div>
              {renderLogoField("dark")}
            </div>

            <BrandingColorsSettings
              theme={draftTheme}
              onChange={setThemeDraft}
              disabled={saving}
              inputClass={inputClass}
              labelClass={labelClass}
            />
          </SettingSection>
          <button
            type="button"
            onClick={handleSaveBranding}
            disabled={saving}
            className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
          >
            {t("pages.settings.save")}
          </button>
        </TabPanel>
      )}
    </Layout>
  );
}
