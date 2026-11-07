import { useState, useEffect } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { Bot, Mail, MessageCircle } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../lib/auth";
import { apiFetch } from "../lib/api";
import { AstroidMark } from "../components/Brand/AstroidMark";
import { ThemeToggle } from "../components/ThemeToggle";
import { TelegramLoginWidget } from "../components/TelegramLoginWidget";

export function Login() {
  const { user, login, loginWithEmail, loading, error } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Where to land after signing in. Set by the public token pages so a user who
  // clicked "Trade" arrives at the prefilled trade form rather than a bare
  // dashboard with their choice discarded.
  //
  // Only same-origin relative paths are honoured: an attacker-supplied
  // absolute URL here would turn the login page into an open redirect, and
  // "//evil.com" is a protocol-relative URL, not a local path.
  const rawRedirect = searchParams.get("redirect");
  const redirectTo =
    rawRedirect && rawRedirect.startsWith("/") && !rawRedirect.startsWith("//")
      ? rawRedirect
      : "/dashboard";
  const [tab, setTab] = useState<"email" | "telegram">("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);

  // Which bot the Login Widget authenticates against. There is no sensible
  // default here: the widget is bound to one bot, and a wrong username renders
  // a button that authenticates into somebody else's deployment.
  const { data: health } = useQuery<{ telegramBotUsername: string | null }>({
    queryKey: ["health"],
    queryFn: () => apiFetch("/health"),
    staleTime: 5 * 60_000,
  });
  const botUsername = health?.telegramBotUsername;

  useEffect(() => {
    if (user) navigate(redirectTo, { replace: true });
  }, [user, navigate, redirectTo]);

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    try {
      await loginWithEmail(email, password);
      navigate(redirectTo, { replace: true });
    } catch {
      setLoginError(error || "Invalid email or password");
    }
  };

  const handleTelegramAuth = async (data: Record<string, unknown>) => {
    setLoginError(null);
    try {
      await login({
        id: Number(data.id),
        first_name: data.first_name as string,
        username: data.username as string,
        auth_date: Number(data.auth_date),
        hash: data.hash as string,
      });
      navigate(redirectTo, { replace: true });
    } catch {
      setLoginError("Telegram authentication failed");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-main-bg">
      <div className="fixed right-4 top-4 z-10">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-badge-bg/40 border border-brand-500/30 mb-4">
            <AstroidMark className="w-10 h-10 text-brand-400" />
          </div>
          <h1 className="text-2xl font-bold text-title-text tracking-tight">AstroidBot</h1>
          <p className="text-muted-text mt-1 text-xs font-mono uppercase tracking-wider">Algorithmic Trading Terminal</p>
        </div>

        <div className="bg-card-bg border border-card-border rounded-xl overflow-hidden">
          <div className="flex border-b border-card-border">
            <button
              onClick={() => setTab("email")}
              className={`flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors ${
                tab === "email"
                  ? "text-brand-400 border-b-2 border-brand-400"
                  : "text-muted-text hover:text-title-text"
              }`}
            >
              <Mail className="w-4 h-4" />
              Email
            </button>
            <button
              onClick={() => setTab("telegram")}
              className={`flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors ${
                tab === "telegram"
                  ? "text-brand-400 border-b-2 border-brand-400"
                  : "text-muted-text hover:text-title-text"
              }`}
            >
              <MessageCircle className="w-4 h-4" />
              Telegram
            </button>
          </div>

          <div className="p-6">
            {(error || loginError) && (
              <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                {error || loginError}
              </div>
            )}

            {tab === "email" ? (
              <form onSubmit={handleEmailLogin} className="space-y-4">
                <div>
                  <label className="block text-xs text-muted-text mb-1">Email</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="w-full px-3 py-2.5 bg-input-bg border border-card-border rounded-lg text-sm text-title-text placeholder-muted-text focus:border-brand-500 focus:outline-none"
                    placeholder="your@email.com"
                  />
                </div>
                <div>
                  <label className="block text-xs text-muted-text mb-1">Password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className="w-full px-3 py-2.5 bg-input-bg border border-card-border rounded-lg text-sm text-title-text placeholder-muted-text focus:border-brand-500 focus:outline-none"
                    placeholder="••••••••"
                  />
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-2.5 bg-brand-500 hover:bg-brand-600 text-title-text rounded-lg font-medium text-sm transition-colors disabled:opacity-50"
                >
                  {loading ? "Signing in..." : "Sign In"}
                </button>
                <div className="flex justify-between text-xs text-muted-text">
                  <Link to="/reset-password" className="hover:text-brand-400">
                    Forgot password?
                  </Link>
                  <Link to="/register" className="hover:text-brand-400">
                    Create account
                  </Link>
                </div>
              </form>
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-muted-text text-center">
                  Sign in securely with your Telegram account
                </p>
                {botUsername ? (
                  <>
                    <TelegramLoginWidget botUsername={botUsername} onAuth={handleTelegramAuth} />
                    {loading && (
                      <p className="text-xs text-muted-text text-center">Connecting...</p>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-muted-text text-center italic">
                    Telegram sign-in is unavailable — this deployment has no bot username
                    configured.
                  </p>
                )}
                <p className="text-xs text-muted-text text-center">
                  Don't have Telegram?{" "}
                  <button onClick={() => setTab("email")} className="text-brand-400 hover:underline">
                    Use email instead
                  </button>
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
