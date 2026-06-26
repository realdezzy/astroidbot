import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Bot, Mail, MessageCircle } from "lucide-react";
import { useAuth } from "../lib/auth";

export function Login() {
  const { user, login, loginWithEmail, loading, error } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState<"email" | "telegram">("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);

  useEffect(() => {
    if (user) navigate("/dashboard", { replace: true });
  }, [user, navigate]);

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    try {
      await loginWithEmail(email, password);
      navigate("/dashboard", { replace: true });
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
      navigate("/dashboard", { replace: true });
    } catch {
      setLoginError("Telegram authentication failed");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-4">
            <img src="/logo.png" alt="AstroidBot Logo" className="w-16 h-16 object-contain" />
          </div>
          <h1 className="text-2xl font-bold text-white">AstroidBot</h1>
          <p className="text-gray-400 mt-1">AI-Powered Trading Bot for Stacks</p>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="flex border-b border-gray-800">
            <button
              onClick={() => setTab("email")}
              className={`flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors ${
                tab === "email"
                  ? "text-brand-400 border-b-2 border-brand-400"
                  : "text-gray-500 hover:text-gray-300"
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
                  : "text-gray-500 hover:text-gray-300"
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
                  <label className="block text-xs text-gray-500 mb-1">Email</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:border-brand-500 focus:outline-none"
                    placeholder="your@email.com"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:border-brand-500 focus:outline-none"
                    placeholder="••••••••"
                  />
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-2.5 bg-brand-500 hover:bg-brand-600 text-white rounded-lg font-medium text-sm transition-colors disabled:opacity-50"
                >
                  {loading ? "Signing in..." : "Sign In"}
                </button>
                <div className="flex justify-between text-xs text-gray-500">
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
                <p className="text-sm text-gray-400 text-center">
                  Sign in securely with your Telegram account
                </p>
                <button
                  onClick={() =>
                    handleTelegramAuth({
                      id: 1,
                      first_name: "DemoUser",
                      username: "demouser",
                      auth_date: Math.floor(Date.now() / 1000),
                      hash: "demo-hash-for-development",
                    })
                  }
                  disabled={loading}
                  className="w-full flex items-center justify-center gap-3 py-3 px-4 rounded-lg bg-[#2AABEE] hover:bg-[#229ED9] text-white font-medium transition-colors disabled:opacity-50"
                >
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.161c-.18.717-.962 4.084-1.362 5.411-.168.56-.35.748-.574.767-.488.045-.858-.322-1.33-.63-.738-.484-1.156-.785-1.873-1.257-.829-.546-.292-1.022.181-1.614.124-.155 2.275-2.084 2.316-2.262.005-.022.01-.105-.039-.148-.05-.044-.123-.029-.175-.017-.074.017-1.259.8-3.554 2.35-.336.23-.64.342-.912.336-.3-.007-.878-.17-1.307-.31-.527-.171-.947-.262-.91-.554.02-.152.229-.307.63-.466 2.475-1.078 4.126-1.789 4.952-2.134 2.358-.98 2.848-1.15 3.168-1.156.07-.001.228.016.33.1.103.084.131.197.144.278.012.08.028.263-.016.41z" />
                  </svg>
                  {loading ? "Connecting..." : "Sign in with Telegram"}
                </button>
                <p className="text-xs text-gray-600 text-center">
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
