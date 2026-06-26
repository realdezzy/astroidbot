import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from "react";
import { apiFetch, saveTokens, clearTokens, isAuthenticated } from "./api";

interface User {
  id: number;
  telegramId: string | null;
  username: string | null;
  email: string | null;
  emailVerified: boolean;
  referralCode: string;
  points: number;
}

interface AuthState {
  user: User | null;
  loading: boolean;
  error: string | null;
  login: (telegramData: {
    id: number;
    first_name?: string;
    username?: string;
    auth_date: number;
    hash: string;
  }) => Promise<void>;
  loginWithEmail: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, username?: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const login = useCallback(
    async (telegramData: {
      id: number;
      first_name?: string;
      username?: string;
      auth_date: number;
      hash: string;
    }) => {
      setError(null);
      setLoading(true);
      try {
        const data = await apiFetch<{
          accessToken: string;
          refreshToken: string;
          user: User;
        }>("/auth/telegram", {
          method: "POST",
          body: JSON.stringify(telegramData),
        });
        saveTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken });
        setUser(data.user);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Login failed");
        throw err;
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const loginWithEmail = useCallback(
    async (email: string, password: string) => {
      setError(null);
      setLoading(true);
      try {
        const data = await apiFetch<{
          accessToken: string;
          refreshToken: string;
          user: User;
        }>("/auth/email/login", {
          method: "POST",
          body: JSON.stringify({ email, password }),
        });
        saveTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken });
        setUser(data.user);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Login failed");
        throw err;
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const register = useCallback(
    async (email: string, password: string, username?: string) => {
      setError(null);
      setLoading(true);
      try {
        const data = await apiFetch<{
          accessToken: string;
          refreshToken: string;
          user: User;
        }>("/auth/email/register", {
          method: "POST",
          body: JSON.stringify({ email, password, username }),
        });
        saveTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken });
        setUser(data.user);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Registration failed");
        throw err;
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const logout = useCallback(async () => {
    try {
      const stored = localStorage.getItem("astroidbot_tokens");
      await apiFetch("/auth/logout", {
        method: "POST",
        body: JSON.stringify({
          refreshToken: stored ? JSON.parse(stored).refreshToken : "",
        }),
      });
    } catch {
      // Ignore logout errors
    }
    clearTokens();
    setUser(null);
  }, []);

  useEffect(() => {
    if (isAuthenticated()) {
      apiFetch<User>("/me")
        .then(setUser)
        .catch(() => clearTokens())
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, error, login, loginWithEmail, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
