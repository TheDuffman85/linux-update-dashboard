import { createContext, useContext, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, apiFetch } from "../lib/client";

interface User {
  userId: number;
  username: string;
}

export interface AuthState {
  user: User | null;
  loading: boolean;
  setupRequired: boolean;
  oidcEnabled: boolean;
  passwordLoginDisabled: boolean;
  passkeysEnabled: boolean;
  hasPassword: boolean;
  totpEnabled: boolean;
  backendUnavailable: boolean;
}

interface AuthContextType extends AuthState {
  login: (username: string, password: string, totpCode?: string) => Promise<void>;
  logout: () => Promise<void>;
  setup: (username: string, password: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function isHardAuthRefreshFailure(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

export function getRecoverableAuthRefreshState(state: AuthState): AuthState {
  return {
    ...state,
    loading: !state.user,
    backendUnavailable: true,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    loading: true,
    setupRequired: false,
    oidcEnabled: false,
    passwordLoginDisabled: false,
    passkeysEnabled: false,
    hasPassword: false,
    totpEnabled: false,
    backendUnavailable: false,
  });
  const retryTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const refresh = useCallback(async () => {
    clearTimeout(retryTimer.current);
    try {
      const data = await apiFetch<{
        setupRequired: boolean;
        authenticated: boolean;
        user: User | null;
        oidcEnabled: boolean;
        passwordLoginDisabled: boolean;
        passkeysEnabled: boolean;
        hasPassword: boolean;
        totpEnabled: boolean;
      }>("/auth/status");

      setState({
        user: data.authenticated ? data.user : null,
        loading: false,
        setupRequired: data.setupRequired,
        oidcEnabled: data.oidcEnabled,
        passwordLoginDisabled: data.passwordLoginDisabled,
        passkeysEnabled: data.passkeysEnabled,
        hasPassword: data.hasPassword,
        totpEnabled: data.totpEnabled,
        backendUnavailable: false,
      });
    } catch (error) {
      if (isHardAuthRefreshFailure(error)) {
        setState((s) => ({
          ...s,
          user: null,
          loading: false,
          backendUnavailable: false,
        }));
        return;
      }

      setState(getRecoverableAuthRefreshState);
      retryTimer.current = setTimeout(() => {
        void refresh();
      }, 3000);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => clearTimeout(retryTimer.current);
  }, [refresh]);

  const login = async (username: string, password: string, totpCode?: string) => {
    await apiFetch("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password, totpCode }),
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
