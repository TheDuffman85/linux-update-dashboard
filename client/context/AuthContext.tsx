import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { apiFetch } from "../api/client";

interface User {
  userId: number;
  username: string;
}

interface AuthState {
  user: User | null;
  loading: boolean;
  setupRequired: boolean;
  oidcEnabled: boolean;
}

interface AuthContextType extends AuthState {
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  setup: (username: string, password: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    loading: true,
    setupRequired: false,
    oidcEnabled: false,
  });

  const refresh = async () => {
    try {
      const data = await apiFetch<{
        setupRequired: boolean;
        authenticated: boolean;
        user: User | null;
        oidcEnabled: boolean;
      }>("/auth/status");

      setState({
        user: data.authenticated ? data.user : null,
        loading: false,
        setupRequired: data.setupRequired,
        oidcEnabled: data.oidcEnabled,
      });
    } catch {
      setState((s) => ({ ...s, loading: false }));
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const login = async (username: string, password: string) => {
    await apiFetch("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    await refresh();
  };

  const logout = async () => {
    await apiFetch("/auth/logout", { method: "POST" });
    setState((s) => ({ ...s, user: null }));
  };

  const setup = async (username: string, password: string) => {
    await apiFetch("/auth/setup", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    await refresh();
  };

  return (
    <AuthContext.Provider value={{ ...state, login, logout, setup, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
