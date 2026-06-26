const API_BASE = "/api";

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

let tokens: Tokens | null = null;

function loadTokens(): void {
  const stored = localStorage.getItem("astroidbot_tokens");
  if (stored) {
    try {
      tokens = JSON.parse(stored);
    } catch {
      tokens = null;
    }
  }
}

function saveTokens(t: Tokens): void {
  tokens = t;
  localStorage.setItem("astroidbot_tokens", JSON.stringify(t));
}

function clearTokens(): void {
  tokens = null;
  localStorage.removeItem("astroidbot_tokens");
}

function getAuthHeaders(): Record<string, string> {
  loadTokens();
  if (tokens?.accessToken) {
    return { Authorization: `Bearer ${tokens.accessToken}` };
  }
  return {};
}

async function refreshAccessToken(): Promise<boolean> {
  if (!tokens?.refreshToken) return false;

  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    });

    if (!res.ok) {
      clearTokens();
      return false;
    }

    const data = await res.json();
    saveTokens({
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
    });
    return true;
  } catch {
    return false;
  }
}

export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...getAuthHeaders(),
    ...(options.headers as Record<string, string>),
  };

  let res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (res.status === 401 && tokens?.refreshToken) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      headers.Authorization = `Bearer ${tokens!.accessToken}`;
      res = await fetch(`${API_BASE}${path}`, { ...options, headers });
    }
  }

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(error.error || "Request failed");
  }

  return res.json() as Promise<T>;
}

export function isAuthenticated(): boolean {
  loadTokens();
  return !!tokens?.accessToken;
}

export function getAccessToken(): string | null {
  loadTokens();
  return tokens?.accessToken ?? null;
}

export { saveTokens, clearTokens };
