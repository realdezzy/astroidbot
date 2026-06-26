import { useState, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, XCircle, Link as LinkIcon, Unlink, Key, Loader2, ExternalLink } from "lucide-react";
import { useAuth } from "../lib/auth";
import { apiFetch } from "../lib/api";

export function Account() {
  const { user, login } = useAuth();
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwMsg, setPwMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [telegramError, setTelegramError] = useState<string | null>(null);

  const { data: health } = useQuery<{ telegramBotUsername: string | null }>({
    queryKey: ["health"],
    queryFn: () => apiFetch("/health"),
  });

  const botUsername = health?.telegramBotUsername;

  const changePassword = useMutation({
    mutationFn: (data: { currentPassword: string; newPassword: string }) =>
      apiFetch("/auth/password", { method: "PUT", body: JSON.stringify(data) }),
    onSuccess: () => {
      setPwMsg({ type: "success", text: "Password changed successfully" });
      setPwCurrent(""); setPwNew(""); setPwConfirm("");
    },
    onError: (err: Error) => setPwMsg({ type: "error", text: err.message }),
  });

  const linkTelegram = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      apiFetch("/auth/telegram/link", {
        method: "POST",
        body: JSON.stringify({
          id: Number(data.id),
          first_name: data.first_name,
          username: data.username,
          auth_date: Number(data.auth_date),
          hash: data.hash,
        }),
      }),
    onSuccess: () => window.location.reload(),
    onError: (err: Error) => setTelegramError(err.message),
  });

  const unlinkTelegram = useMutation({
    mutationFn: () => apiFetch("/auth/telegram", { method: "DELETE" }),
    onSuccess: () => window.location.reload(),
  });

  // Register Telegram Login Widget callback
  useEffect(() => {
    if (!botUsername) return;

    const scriptId = "telegram-widget-script";
    if (document.getElementById(scriptId)) return;

    const script = document.createElement("script");
    script.id = scriptId;
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.setAttribute("data-telegram-login", botUsername);
    script.setAttribute("data-size", "medium");
    script.setAttribute("data-radius", "8");
    script.setAttribute("data-onauth", "onTelegramAuth(user)");
    script.setAttribute("data-request-access", "write");
    script.async = true;

    window.onTelegramAuth = (data: Record<string, unknown>) => {
      setTelegramError(null);
      linkTelegram.mutate(data);
    };

    const container = document.getElementById("telegram-widget-container");
    if (container) {
      container.appendChild(script);
    }

    return () => {
      script.remove();
      delete window.onTelegramAuth;
    };
  }, [botUsername]);

  const handleChangePassword = (e: React.FormEvent) => {
    e.preventDefault();
    setPwMsg(null);
    if (pwNew !== pwConfirm) {
      setPwMsg({ type: "error", text: "Passwords do not match" });
      return;
    }
    if (pwNew.length < 8 || !/[a-zA-Z]/.test(pwNew) || !/[0-9]/.test(pwNew)) {
      setPwMsg({ type: "error", text: "Password must be 8+ chars with letter and number" });
      return;
    }
    changePassword.mutate({ currentPassword: pwCurrent, newPassword: pwNew });
  };

  return (
    <div>
      <div className="mb-8">
        <h2 className="text-2xl font-bold text-title-text">Account</h2>
        <p className="text-muted-text mt-1">Manage your linked accounts and security</p>
      </div>

      <div className="space-y-6 max-w-xl">
        {/* Email */}
        <div className="glass-card p-5">
          <h3 className="text-sm font-semibold text-muted-text uppercase tracking-wider mb-3">
            Email
          </h3>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-title-text font-medium">{user?.email || "Not set"}</p>
              {user?.email && (
                <p className="text-xs text-muted-text/80 mt-0.5">
                  {user?.emailVerified ? (
                    <span className="flex items-center gap-1 text-green-400">
                      <CheckCircle2 className="w-3 h-3" /> Verified
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-amber-400">
                      <XCircle className="w-3 h-3" /> Not verified — check your email
                    </span>
                  )}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Telegram */}
        <div className="glass-card p-5">
          <h3 className="text-sm font-semibold text-muted-text uppercase tracking-wider mb-3">
            Telegram
          </h3>

          <div className="flex items-center justify-between">
            <div>
              {user?.telegramId ? (
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-green-400" />
                  <span className="text-title-text font-medium">Connected</span>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <XCircle className="w-4 h-4 text-muted-text" />
                  <span className="text-muted-text">Not connected</span>
                </div>
              )}
            </div>
            {user?.telegramId ? (
              <button
                onClick={() => unlinkTelegram.mutate()}
                disabled={unlinkTelegram.isPending}
                className="flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300 transition-colors disabled:opacity-50"
              >
                {unlinkTelegram.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Unlink className="w-3 h-3" />}
                Unlink
              </button>
            ) : (
              <div>
                {botUsername ? (
                  <div id="telegram-widget-container" className="flex items-center">
                    {linkTelegram.isPending && (
                      <span className="flex items-center gap-1.5 text-xs text-muted-text/80">
                        <Loader2 className="w-3 h-3 animate-spin" /> Linking...
                      </span>
                    )}
                  </div>
                ) : (
                  <span className="text-xs text-muted-text/80 italic">
                    Bot username not configured
                  </span>
                )}
              </div>
            )}
          </div>

          {telegramError && (
            <p className="mt-2 text-xs text-red-400">{telegramError}</p>
          )}

          {!user?.telegramId && botUsername && (
            <>
              <div id="telegram-widget-fallback" className="mt-3 flex items-center gap-3">
                <a
                  href={`https://t.me/${botUsername}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-3 py-2 bg-[#2AABEE] hover:bg-[#229ED9] text-white rounded-lg text-xs font-medium transition-colors"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.161c-.18.717-.962 4.084-1.362 5.411-.168.56-.35.748-.574.767-.488.045-.858-.322-1.33-.63-.738-.484-1.156-.785-1.873-1.257-.829-.546-.292-1.022.181-1.614.124-.155 2.275-2.084 2.316-2.262.005-.022.01-.105-.039-.148-.05-.044-.123-.029-.175-.017-.074.017-1.259.8-3.554 2.35-.336.23-.64.342-.912.336-.3-.007-.878-.17-1.307-.31-.527-.171-.947-.262-.91-.554.02-.152.229-.307.63-.466 2.475-1.078 4.126-1.789 4.952-2.134 2.358-.98 2.848-1.15 3.168-1.156.07-.001.228.016.33.1.103.084.131.197.144.278.012.08.028.263-.016.41z"/></svg>
                  Open @{botUsername}
                </a>
              </div>
              <p className="mt-2 text-xs text-muted-text/80">
                Send <code className="text-title-text bg-input-bg px-1 py-0.5 rounded border border-divider-color">/link_email</code> in the chat to connect via email,
                then your accounts will be linked automatically.
              </p>
            </>
          )}
        </div>

        {/* Change Password */}
        {user?.email && (
          <div className="glass-card p-5">
            <h3 className="text-sm font-semibold text-muted-text uppercase tracking-wider mb-3">
              Change Password
            </h3>

            {pwMsg && (
              <div
                className={`mb-3 p-3 rounded-lg text-sm ${
                  pwMsg.type === "success"
                    ? "bg-green-500/10 border border-green-500/20 text-green-400"
                    : "bg-red-500/10 border border-red-500/20 text-red-400"
                }`}
              >
                {pwMsg.text}
              </div>
            )}

            <form onSubmit={handleChangePassword} className="space-y-3">
              <input
                type="password"
                value={pwCurrent}
                onChange={(e) => setPwCurrent(e.target.value)}
                required
                className="w-full px-3 py-2 bg-input-bg border border-divider-color rounded-lg text-sm text-title-text placeholder:text-muted-text/60 focus:border-brand-500 focus:outline-none"
                placeholder="Current password"
              />
              <input
                type="password"
                value={pwNew}
                onChange={(e) => setPwNew(e.target.value)}
                required
                className="w-full px-3 py-2 bg-input-bg border border-divider-color rounded-lg text-sm text-title-text placeholder:text-muted-text/60 focus:border-brand-500 focus:outline-none"
                placeholder="New password"
              />
              <input
                type="password"
                value={pwConfirm}
                onChange={(e) => setPwConfirm(e.target.value)}
                required
                className="w-full px-3 py-2 bg-input-bg border border-divider-color rounded-lg text-sm text-title-text placeholder:text-muted-text/60 focus:border-brand-500 focus:outline-none"
                placeholder="Confirm new password"
              />
              <button
                type="submit"
                disabled={changePassword.isPending}
                className="flex items-center gap-2 px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white rounded-lg font-medium text-sm transition-colors disabled:opacity-50"
              >
                <Key className="w-4 h-4" />
                {changePassword.isPending ? "Changing..." : "Change Password"}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

// Extend the Window interface for the Telegram widget callback
declare global {
  interface Window {
    onTelegramAuth?: (user: Record<string, unknown>) => void;
  }
}
