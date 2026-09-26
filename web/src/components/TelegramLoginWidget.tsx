import { useEffect, useRef } from "react";

declare global {
  interface Window {
    onTelegramWidgetAuth?: (user: Record<string, unknown>) => void;
  }
}

interface TelegramLoginWidgetProps {
  /** The bot the widget authenticates against, from `/api/health`. */
  botUsername: string;
  onAuth: (user: Record<string, unknown>) => void;
  size?: "large" | "medium" | "small";
}

/**
 * Telegram's own Login Widget, mounted as the script tag it has to be.
 *
 * The sign-in button it replaces posted a fixed object —
 * `{ id: 1, first_name: "DemoUser", hash: "demo-hash-for-development" }` — at
 * the login endpoint. That hash is not an HMAC of anything, so the server
 * rejected it every time: the Telegram tab was a button that could not work
 * for any real user, and looked like a backend fault when it failed.
 *
 * Only Telegram can produce the `hash`, which is why this has to be their
 * script and their button rather than a styled one of ours. `Account.tsx`
 * mounts the same widget for account linking, under its own callback name.
 */
export function TelegramLoginWidget({
  botUsername,
  onAuth,
  size = "large",
}: TelegramLoginWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Held in a ref so a re-render of the parent does not tear the script down
  // and remount the button mid-sign-in.
  const onAuthRef = useRef(onAuth);
  onAuthRef.current = onAuth;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !botUsername) return;

    // The widget calls this by name from global scope — `data-onauth` is a
    // string it evaluates, not a handler it can be handed.
    window.onTelegramWidgetAuth = (user) => onAuthRef.current(user);

    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.setAttribute("data-telegram-login", botUsername);
    script.setAttribute("data-size", size);
    script.setAttribute("data-radius", "8");
    script.setAttribute("data-onauth", "onTelegramWidgetAuth(user)");
    script.setAttribute("data-request-access", "write");
    script.async = true;
    container.appendChild(script);

    return () => {
      script.remove();
      delete window.onTelegramWidgetAuth;
    };
  }, [botUsername, size]);

  return <div ref={containerRef} className="flex justify-center" />;
}
