import { useState } from "react";
import { useAuth } from "../context/AuthContext";

export default function Setup() {
  const { setup } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    setLoading(true);
    try {
      await setup(username, password);
    } catch (err: unknown) {
      setError((err as Error).message || "Setup failed");
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
          <h1 className="mt-3 text-xl font-semibold">Initial Setup</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Create your admin account
          </p>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
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
              minLength={8}
              className="w-full px-3 py-2 rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
            />
            <p className="mt-1 text-xs text-slate-400">Minimum 8 characters</p>
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            {loading ? <span className="spinner spinner-sm" /> : "Create Account"}
          </button>
        </form>
      </div>
    </div>
  );
}
