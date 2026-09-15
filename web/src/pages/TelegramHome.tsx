import { Link } from "react-router-dom";
import { useTelegram } from "../lib/telegram/TelegramProvider";

const links = [
  ["Portfolio", "/tg/portfolio"],
  ["Token discovery", "/tg/tokens"],
] as const;

export function TelegramHome() {
  const { webApp } = useTelegram();
  return (
    <main className="mx-auto max-w-xl p-4 pt-6">
      <p className="text-xs uppercase tracking-[0.2em] text-brand-400">AstroidBot Mini App</p>
      <h1 className="mt-2 text-2xl font-semibold">Markets and portfolio</h1>
      <p className="mt-2 text-sm text-muted-text">Review your account here. Financial approvals are sent to the bot chat.</p>
      <div className="mt-6 grid gap-3">
        {links.map(([label, href]) => (
          <Link key={href} to={href} onClick={() => webApp?.HapticFeedback?.impactOccurred("light")}
            className="rounded-xl border border-white/10 bg-white/5 p-4 font-medium">
            {label} <span className="float-right">→</span>
          </Link>
        ))}
      </div>
    </main>
  );
}
