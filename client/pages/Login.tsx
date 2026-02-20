import { useState } from "react";
import { useAuth } from "../context/AuthContext";

export default function Login() {
  const { login, oidcEnabled } = useAuth();
  const [tab, setTab] = useState<"password" | "passkey" | "sso">("password");
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

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-900 p-4">
      <div className="w-full max-w-sm bg-white dark:bg-slate-800 rounded-xl shadow-lg p-8">
        <div className="text-center mb-6">
          <span className="bg-blue-500 text-white text-sm font-bold px-3 py-1.5 rounded">
            LUD
          </span>
          <h1 className="mt-3 text-xl font-semibold">Welcome back</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Sign in to your dashboard
          </p>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border mb-6">
          <button
            onClick={() => setTab("password")}
            className={`flex-1 pb-2 text-sm font-medium border-b-2 transition-colors ${
              tab === "password"
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            Password
          </button>
          <button
            onClick={() => setTab("passkey")}
            className={`flex-1 pb-2 text-sm font-medium border-b-2 transition-colors ${
              tab === "passkey"
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            Passkey
          </button>
          {oidcEnabled && (
            <button
              onClick={() => setTab("sso")}
              className={`flex-1 pb-2 text-sm font-medium border-b-2 transition-colors ${
                tab === "sso"
                  ? "border-blue-500 text-blue-600"
                  : "border-transparent text-slate-500 hover:text-slate-700"
              }`}
            >
              SSO
            </button>
          )}
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm">
            {error}
          </div>
        )}

        {tab === "password" && (
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
        )}

        {tab === "passkey" && (
          <div className="text-center py-8">
            <p className="text-sm text-slate-500 mb-4">
              Use your passkey to sign in
            </p>
            <button
              onClick={() => {
                // WebAuthn login flow would be implemented here
                setError("Passkey login coming soon");
              }}
              className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
            >
              Use Passkey
            </button>
          </div>
        )}

        {tab === "sso" && (
          <div className="text-center py-8">
            <p className="text-sm text-slate-500 mb-4">
              Sign in with your organization
            </p>
            <a
              href="/api/auth/oidc/login"
              className="inline-block px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
            >
              Continue with SSO
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
