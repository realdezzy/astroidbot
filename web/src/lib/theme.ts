import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const THEME_EVENT = "astroid:theme";

function readTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("light") ? "light" : "dark";
}

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("light", theme === "light");
  localStorage.setItem("theme", theme);
  // `storage` only fires in *other* tabs, so same-tab toggles need their own
  // notification or a header toggle and a chart would disagree.
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: theme }));
}

/** Shared current theme, persisted in localStorage and applied to `<html>`. */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(readTheme);

  useEffect(() => {
    const sync = () => setThemeState(readTheme());
    const fromEvent = (event: Event) => {
      const detail = (event as CustomEvent<Theme>).detail;
      setThemeState(detail ?? readTheme());
    };

    window.addEventListener("storage", sync);
    window.addEventListener(THEME_EVENT, fromEvent);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(THEME_EVENT, fromEvent);
    };
  }, []);

  const setTheme = useCallback((next: Theme) => {
    applyTheme(next);
    setThemeState(next);
  }, []);

  const toggle = useCallback(() => {
    setTheme(readTheme() === "light" ? "dark" : "light");
  }, [setTheme]);

  return { theme, setTheme, toggle };
}
