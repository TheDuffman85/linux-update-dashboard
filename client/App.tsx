import { Suspense, lazy, useEffect } from "react";
import { Routes, Route, Navigate } from "react-router";
import { useAuth } from "./context/AuthContext";
import { useToast } from "./context/ToastContext";
import {
  BROWSER_LANGUAGE_SETTING,
  LANGUAGE_SETTING_KEY,
  getLanguageLabel,
  useI18n,
} from "./lib/i18n";
import { useUpdateSettings } from "./lib/settings";

const Login = lazy(() => import("./pages/Login"));
const Setup = lazy(() => import("./pages/Setup"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const SystemsList = lazy(() => import("./pages/SystemsList"));
const SystemDetail = lazy(() => import("./pages/SystemDetail"));
const Settings = lazy(() => import("./pages/Settings"));
const Notifications = lazy(() => import("./pages/Notifications"));
const Schedules = lazy(() => import("./pages/Schedules"));
const Credentials = lazy(() => import("./pages/Credentials"));
const Scripts = lazy(() => import("./pages/Scripts"));

function PageLoader({ message }: { message?: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3">
      <span className="spinner !w-8 !h-8 text-blue-500" />
      {message && (
        <p className="text-sm text-slate-500 dark:text-slate-400">{message}</p>
      )}
    </div>
  );
}

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, loading, setupRequired, backendUnavailable } = useAuth();
  const { t } = useI18n();

  if (loading) {
    return <PageLoader message={backendUnavailable ? t("app.reconnectingToBackend") : undefined} />;
  }

  if (setupRequired) return <Navigate to="/setup" replace />;
  if (!user) return <Navigate to="/login" replace />;

  return <>{children}</>;
}

const LANGUAGE_PROMPT_STORAGE_KEY = "ludash.languagePermanentPromptDismissed";

function hasDismissedLanguagePrompt(): boolean {
  try {
    return localStorage.getItem(LANGUAGE_PROMPT_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function dismissLanguagePrompt(): void {
  try {
    localStorage.setItem(LANGUAGE_PROMPT_STORAGE_KEY, "true");
  } catch {
    // Ignore storage failures; the prompt is best-effort.
  }
}

function PermanentLanguagePrompt() {
  const { user, loading, setupRequired } = useAuth();
  const { preference, browserLanguage, t } = useI18n();
  const { addToast } = useToast();
  const updateSettings = useUpdateSettings();

  useEffect(() => {
    if (
      loading ||
      setupRequired ||
      !user ||
      preference !== BROWSER_LANGUAGE_SETTING ||
      browserLanguage === "en" ||
      hasDismissedLanguagePrompt()
    ) {
      return;
    }

    dismissLanguagePrompt();
    const languageLabel = getLanguageLabel(browserLanguage);
    addToast(
      t("app.languagePrompt.message", { language: languageLabel }),
      "info",
      {
        durationMs: null,
        actions: [
          {
            label: t("app.languagePrompt.useLanguage", { language: languageLabel }),
            variant: "primary",
            onClick: () => {
              updateSettings.mutate(
                { [LANGUAGE_SETTING_KEY]: browserLanguage },
                {
                  onSuccess: () => addToast(t("app.languagePrompt.saved"), "success"),
                  onError: (err) => addToast(err.message, "danger"),
                },
              );
            },
          },
          {
            label: t("app.languagePrompt.noThanks"),
            onClick: dismissLanguagePrompt,
          },
        ],
        onClose: dismissLanguagePrompt,
      },
    );
  }, [
    addToast,
    browserLanguage,
    loading,
    preference,
    setupRequired,
    t,
    updateSettings,
    user,
  ]);

  return null;
}

export default function App() {
  const { loading, setupRequired, user, backendUnavailable } = useAuth();
  const { t } = useI18n();

  if (loading) {
    return <PageLoader message={backendUnavailable ? t("app.reconnectingToBackend") : undefined} />;
  }

  return (
    <Suspense fallback={<PageLoader />}>
      <PermanentLanguagePrompt />
      <Routes>
        <Route
          path="/login"
          element={
            user ? <Navigate to="/dashboard" replace /> : <Login />
          }
        />
        <Route
          path="/setup"
          element={
            setupRequired ? <Setup /> : <Navigate to="/dashboard" replace />
          }
        />
        <Route
          path="/dashboard"
          element={
            <AuthGuard>
              <Dashboard />
            </AuthGuard>
          }
        />
        <Route
          path="/systems"
          element={
            <AuthGuard>
              <SystemsList />
            </AuthGuard>
          }
        />
        <Route
          path="/systems/:id"
          element={
            <AuthGuard>
              <SystemDetail />
            </AuthGuard>
          }
        />
        <Route
          path="/notifications"
          element={
            <AuthGuard>
              <Notifications />
            </AuthGuard>
          }
        />
        <Route
          path="/schedules"
          element={
            <AuthGuard>
              <Schedules />
            </AuthGuard>
          }
        />
        <Route
          path="/credentials"
          element={
            <AuthGuard>
              <Credentials />
            </AuthGuard>
          }
        />
        <Route
          path="/scripts"
          element={
            <AuthGuard>
              <Scripts />
            </AuthGuard>
          }
        />
        <Route
          path="/settings"
          element={
            <AuthGuard>
              <Settings />
            </AuthGuard>
          }
        />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Suspense>
  );
}
