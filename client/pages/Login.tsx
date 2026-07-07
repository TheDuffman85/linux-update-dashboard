import { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { PenguinLogo } from "../components/PenguinLogo";
import { ApiError, apiFetch } from "../lib/client";
import { useI18n } from "../lib/i18n";

function base64urlToBuffer(base64url: string): ArrayBuffer {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4 === 0 ? "" : "=".repeat(4 - (base64.length % 4));
  const binary = atob(base64 + pad);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0)).buffer;
}

function bufferToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export default function Login() {
  const { login, oidcEnabled, passwordLoginDisabled, passkeysEnabled, refresh } = useAuth();
  const { t } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [requiresTotp, setRequiresTotp] = useState(false);

  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);

  const handlePasswordLogin = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    setNotice("");

    if (!e.currentTarget.checkValidity()) {
      const invalidInput = e.currentTarget.querySelector<HTMLInputElement>("input:invalid");
      setError(invalidInput?.validationMessage || t("pages.login.loginFailed"));
      invalidInput?.focus();
      return;
    }

    setLoading(true);
    try {
      await login(username, password, requiresTotp ? totpCode : undefined);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.details.requiresTotp === true) {
        setRequiresTotp(true);
        if (!requiresTotp) {
          setNotice(t("pages.login.authenticatorCodeRequired"));
          return;
        }
        setError(t("pages.login.invalidAuthenticatorCode"));
        return;
      }
      setError(
        err instanceof ApiError
          ? t("pages.login.loginFailed")
          : (err as Error).message || t("pages.login.loginFailed"),
      );
    } finally {
      setLoading(false);
    }
  };

  const resetTotpPrompt = () => {
    setRequiresTotp(false);
    setPassword("");
    setTotpCode("");
    setError("");
    setNotice("");
  };

  const handlePasskeyLogin = async () => {
    setError("");
    setNotice("");
    setLoading(true);
    try {
      if (!window.isSecureContext || !navigator.credentials) {
        throw new Error(t("pages.login.passkeysRequireASecureContextOrLocalhost"));
      }
      const options = await apiFetch<Record<string, unknown>>("/auth/webauthn/login/options", {
        method: "POST",
        body: JSON.stringify({}),
      });

      const publicKeyOptions = {
        ...options,
        challenge: base64urlToBuffer(options.challenge as string),
        allowCredentials: (options.allowCredentials as Array<{ id: string; type: string; transports?: string[] }> | undefined)?.map((c) => ({
          ...c,
          id: base64urlToBuffer(c.id),
        })),
      };

      const credential = (await navigator.credentials.get({
        publicKey: publicKeyOptions as PublicKeyCredentialRequestOptions,
      })) as PublicKeyCredential;

      if (!credential) {
        setError(t("pages.login.noCredentialReturned"));
        return;
      }

      const response = credential.response as AuthenticatorAssertionResponse;
      const body = {
        id: credential.id,
        rawId: bufferToBase64url(credential.rawId),
        type: credential.type,
        response: {
          authenticatorData: bufferToBase64url(response.authenticatorData),
          clientDataJSON: bufferToBase64url(response.clientDataJSON),
          signature: bufferToBase64url(response.signature),
          userHandle: response.userHandle ? bufferToBase64url(response.userHandle) : null,
        },
      };

      await apiFetch("/auth/webauthn/login/verify", {
        method: "POST",
        body: JSON.stringify(body),
      });

      await refresh();
    } catch (err: unknown) {
      setError((err as Error).message || t("pages.login.passkeyAuthenticationFailed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-900 p-4">
      <div className="w-full max-w-sm bg-white dark:bg-slate-800 rounded-xl shadow-lg p-8">
        <div className="text-center mb-6">
          <div className="flex justify-center">
            <PenguinLogo size={48} />
          </div>
          <h1 className="mt-3 text-xl font-semibold">{t("pages.login.welcomeBack")}</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            {t("pages.login.signInToYourDashboard")}
          </p>
        </div>

        {error && (
          <div
            role="alert"
            className="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm"
          >
            {error}
          </div>
        )}
        {notice && !error && (
          <div
            role="status"
            className="mb-4 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 text-sm"
          >
            {notice}
          </div>
        )}

        {!passwordLoginDisabled && (
          <form onSubmit={handlePasswordLogin} noValidate className="space-y-4">
            {!requiresTotp ? (
              <>
                <div>
                  <label className="block text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">
                    {t("pages.login.username")}
                  </label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                    autoComplete="username"
                    className="w-full px-3 py-2 rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">
                    {t("pages.login.password")}
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="current-password"
                    className="w-full px-3 py-2 rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                  />
                </div>
              </>
            ) : (
              <div>
                <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-border bg-slate-50 px-3 py-2 dark:bg-slate-900">
                  <div className="min-w-0">
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                      {t("pages.login.signingInAs")}
                    </p>
                    <p className="truncate text-sm font-medium">{username}</p>
                  </div>
                  <button
                    type="button"
                    onClick={resetTotpPrompt}
                    disabled={loading}
                    className="shrink-0 rounded px-2 py-1 text-xs font-medium text-blue-600 transition-colors hover:bg-blue-50 disabled:opacity-50 dark:text-blue-400 dark:hover:bg-slate-800"
                  >
                    {t("pages.login.change")}
                  </button>
                </div>
                <label className="block text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">
                  {t("pages.login.authenticatorCode")}
                </label>
                <input
                  type="text"
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                  required
                  autoFocus
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9 ]*"
                  className="w-full px-3 py-2 rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                />
              </div>
            )}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
            >
              {loading ? <span className="spinner spinner-sm" /> : t("pages.login.signIn")}
            </button>
          </form>
        )}

        {!requiresTotp && (passkeysEnabled || oidcEnabled) && (
          <div className={`${passwordLoginDisabled ? "" : "mt-4"} space-y-2`}>
            {passkeysEnabled && (
              <button
                onClick={handlePasskeyLogin}
                disabled={loading}
                className="w-full py-2 border border-border rounded-lg text-sm font-medium transition-colors hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50"
              >
                {t("pages.login.signInWithPasskey")}
              </button>
            )}
            {oidcEnabled && (
              <a
                href="/api/auth/oidc/login"
                className="block w-full py-2 text-center border border-border rounded-lg text-sm font-medium transition-colors hover:bg-slate-100 dark:hover:bg-slate-700"
              >
                {t("pages.login.continueWithSso")}
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
