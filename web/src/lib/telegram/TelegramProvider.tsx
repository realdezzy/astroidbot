import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";

interface TelegramWebApp {
  initData: string;
  initDataUnsafe?: { start_param?: string };
  colorScheme?: "light" | "dark";
  themeParams?: Record<string, string>;
  ready(): void;
  expand(): void;
  requestFullscreen?: () => void;
  close(): void;
  openTelegramLink?(url: string): void;
  BackButton?: { show(): void; hide(): void; onClick(fn: () => void): void; offClick(fn: () => void): void };
  HapticFeedback?: { impactOccurred(style: "light" | "medium" | "heavy"): void };
  onEvent?(event: string, fn: () => void): void;
  offEvent?(event: string, fn: () => void): void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

interface TelegramRuntime {
  webApp: TelegramWebApp | null;
  isTelegram: boolean;
  initData: string;
  startParam?: string;
}

const TelegramContext = createContext<TelegramRuntime>({ webApp: null, isTelegram: false, initData: "" });

function applyTheme(webApp: TelegramWebApp): void {
  const root = document.documentElement;
  root.dataset.telegram = "true";
  root.dataset.theme = webApp.colorScheme ?? "dark";
  for (const [key, value] of Object.entries(webApp.themeParams ?? {})) {
    root.style.setProperty(`--tg-${key.replaceAll("_", "-")}`, value);
  }
}

export function TelegramProvider({ children }: { children: ReactNode }) {
  const webApp = typeof window === "undefined" ? null : window.Telegram?.WebApp ?? null;

  useEffect(() => {
    if (!webApp) return;
    applyTheme(webApp);
    const updateTheme = () => applyTheme(webApp);
    webApp.onEvent?.("themeChanged", updateTheme);
    webApp.ready();
    webApp.expand();
    return () => webApp.offEvent?.("themeChanged", updateTheme);
  }, [webApp]);

  const value = useMemo<TelegramRuntime>(() => ({
    webApp,
    isTelegram: Boolean(webApp?.initData),
    initData: webApp?.initData ?? "",
    startParam: webApp?.initDataUnsafe?.start_param,
  }), [webApp]);

  return <TelegramContext.Provider value={value}>{children}</TelegramContext.Provider>;
}

export function useTelegram(): TelegramRuntime {
  return useContext(TelegramContext);
}
