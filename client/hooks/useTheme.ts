import {
  createContext,
  useContext,
  useState,
  useEffect,
  createElement,
  type ReactNode,
} from "react";

export type ThemePreference = "light" | "dark" | "system";
type Theme = "light" | "dark";

interface ThemeContextType {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}

const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

const ThemeContext = createContext<ThemeContextType>({
  preference: "system",
  setPreference: () => {},
});

function getSystemTheme(): Theme {
  return window.matchMedia(DARK_SCHEME_QUERY).matches ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>(() => {
    const stored = localStorage.getItem("theme");
    return stored === "light" || stored === "dark" ? stored : "system";
  });
  const [systemTheme, setSystemTheme] = useState<Theme>(getSystemTheme);
  const theme = preference === "system" ? systemTheme : preference;

  useEffect(() => {
    const media = window.matchMedia(DARK_SCHEME_QUERY);
    const onChange = () => setSystemTheme(getSystemTheme());
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("theme", preference);
  }, [preference]);

  return createElement(
    ThemeContext.Provider,
    { value: { preference, setPreference } },
    children
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
