import { ScriptOnce } from "@tanstack/react-router";
import { createContext, use, useEffect, useState } from "react";

// shadcn dark mode for TanStack Start: https://ui.shadcn.com/docs/dark-mode/tanstack-start
type Theme = "dark" | "light" | "system";

const themes: ReadonlyArray<Theme> = ["dark", "light", "system"];

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
};

type ThemeProviderState = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
};

const ThemeProviderContext = createContext<ThemeProviderState | null>(null);

function isTheme(value: string | null): value is Theme {
  return themes.some((theme) => theme === value);
}

function applyTheme(theme: Theme) {
  const root = window.document.documentElement;

  const system = window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";

  const resolved = theme === "system" ? system : theme;

  root.classList.remove("light", "dark");
  root.classList.add(resolved);
  root.style.colorScheme = resolved;
}

// Runs before hydration so the first paint already has the right class.
function themeScript(storageKey: string, defaultTheme: Theme) {
  return `(function(){try{var t=localStorage.getItem(${JSON.stringify(storageKey)})||${JSON.stringify(defaultTheme)};var d=t==="dark"||(t==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;r.classList.remove("light","dark");r.classList.add(d?"dark":"light");r.style.colorScheme=d?"dark":"light";}catch(e){}})();`;
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "theme",
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(defaultTheme);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(storageKey);

    if (isTheme(stored)) setThemeState(stored);

    setMounted(true);
  }, [storageKey]);

  useEffect(() => {
    if (!mounted) return;

    applyTheme(theme);

    if (theme !== "system") return;

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");

    media.addEventListener("change", onChange);

    return () => media.removeEventListener("change", onChange);
  }, [theme, mounted]);

  const setTheme = (next: Theme) => {
    localStorage.setItem(storageKey, next);
    setThemeState(next);
  };

  return (
    <ThemeProviderContext value={{ theme, setTheme }}>
      <ScriptOnce>{themeScript(storageKey, defaultTheme)}</ScriptOnce>
      {children}
    </ThemeProviderContext>
  );
}

export function useTheme() {
  const context = use(ThemeProviderContext);

  if (context === null) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }

  return context;
}
