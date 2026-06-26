import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { Bot, CheckCircle2 } from "lucide-react";
import { apiFetch } from "../lib/api";

export function ResetPassword() {
  const { token } = useParams<{ token?: string }>();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<{ type: "success" | "error" | "info"; text: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const handleRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMsg(null);
    try {
      await apiFetch("/auth/email/reset-password", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setMsg({ type: "success", text: "If an account exists, a reset link has been sent." });
    } catch {
      setMsg({ type: "success", text: "If an account exists, a reset link has been sent." });
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setMsg({ type: "error", text: "Passwords do not match" });
      return;
    }
    if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
      setMsg({ type: "error", text: "Password must be 8+ chars with letter and number" });
      return;
    }
    setLoading(true);
    setMsg(null);
    try {
      await apiFetch(`/auth/email/reset-password/${token}`, {
        method: "POST",
        body: JSON.stringify({ newPassword: password }),
      });
      setMsg({ type: "success", text: "Password reset successfully. You can now sign in." });
    } catch (err) {
      setMsg({ type: "error", text: err instanceof Error ? err.message : "Reset failed" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <Bot className="w-12 h-12 text-brand-400 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-white">
            {token ? "Set New Password" : "Reset Password"}
          </h1>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          {msg && (
            <div
              className={`mb-4 p-3 rounded-lg border text-sm ${
                msg.type === "success"
                  ? "bg-green-500/10 border-green-500/20 text-green-400"
                  : msg.type === "error"
                    ? "bg-red-500/10 border-red-500/20 text-red-400"
                    : "bg-blue-500/10 border-blue-500/20 text-blue-400"
              }`}
            >
              {msg.type === "success" && <CheckCircle2 className="w-4 h-4 inline mr-1" />}
              {msg.text}
            </div>
          )}

          {token ? (
            <form onSubmit={handleReset} className="space-y-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1">New Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:border-brand-500 focus:outline-none"
                  placeholder="Min 8 chars, 1 letter + 1 number"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Confirm Password</label>
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:border-brand-500 focus:outline-none"
                  placeholder="Repeat password"
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 bg-brand-500 hover:bg-brand-600 text-white rounded-lg font-medium text-sm transition-colors disabled:opacity-50"
              >
                {loading ? "Resetting..." : "Reset Password"}
              </button>
            </form>
          ) : (
            <form onSubmit={handleRequest} className="space-y-4">
              <p className="text-sm text-gray-400">
                Enter your email and we'll send you a reset link.
              </p>
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
              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 bg-brand-500 hover:bg-brand-600 text-white rounded-lg font-medium text-sm transition-colors disabled:opacity-50"
              >
                {loading ? "Sending..." : "Send Reset Link"}
              </button>
            </form>
          )}

          <p className="mt-4 text-center text-xs text-gray-500">
            <Link to="/login" className="text-brand-400 hover:underline">
              Back to sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
