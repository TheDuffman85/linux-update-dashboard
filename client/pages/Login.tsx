import { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { PenguinLogo } from "../components/PenguinLogo";
import { apiFetch } from "../lib/client";

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
  const { login, oidcEnabled, refresh } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(username, password);
    } catch (err: unknown) {
      setError((err as Error).message || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  const handlePasskeyLogin = async () => {
    setError("");
    setLoading(true);
    try {
      if (!window.isSecureContext || !navigator.credentials) {
        throw new Error("Passkeys require a secure context (HTTPS or localhost)");
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
        setError("No credential returned");
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
      setError((err as Error).message || "Passkey authentication failed");
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
          <h1 className="mt-3 text-xl font-semibold">Welcome back</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Sign in to your dashboard
          </p>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handlePasswordLogin} className="space-y-4">
          <div>
            <label className="block text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">
              Username
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              className="w-full px-3 py-2 rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full px-3 py-2 rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            {loading ? <span className="spinner spinner-sm" /> : "Sign In"}
          </button>
        </form>

        <div className="mt-4 space-y-2">
          <button
            onClick={handlePasskeyLogin}
            disabled={loading}
            className="w-full py-2 border border-border rounded-lg text-sm font-medium transition-colors hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50"
          >
            Sign In with Passkey
          </button>
          {oidcEnabled && (
            <a
              href="/api/auth/oidc/login"
              className="block w-full py-2 text-center border border-border rounded-lg text-sm font-medium transition-colors hover:bg-slate-100 dark:hover:bg-slate-700"
            >
              Continue with SSO
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
