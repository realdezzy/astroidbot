import { describe, it, expect, vi, beforeEach } from "vitest";
import { apiFetch, isAuthenticated, getAccessToken, saveTokens, clearTokens } from "./api";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("api.ts client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearTokens();
    localStorage.clear();
  });

  describe("isAuthenticated", () => {
    it("returns false when no tokens are stored", () => {
      expect(isAuthenticated()).toBe(false);
    });

    it("returns true after tokens are saved", () => {
      saveTokens({ accessToken: "access-abc", refreshToken: "refresh-xyz" });
      expect(isAuthenticated()).toBe(true);
    });

    it("returns false after tokens are cleared", () => {
      saveTokens({ accessToken: "access-abc", refreshToken: "refresh-xyz" });
      clearTokens();
      expect(isAuthenticated()).toBe(false);
    });
  });

  describe("getAccessToken", () => {
    it("returns null when not authenticated", () => {
      expect(getAccessToken()).toBeNull();
    });

    it("returns the access token after saving", () => {
      saveTokens({ accessToken: "my-token", refreshToken: "my-refresh" });
      expect(getAccessToken()).toBe("my-token");
    });
  });

  describe("apiFetch", () => {
    it("sends a request with Content-Type and auth header when authenticated", async () => {
      saveTokens({ accessToken: "test-access", refreshToken: "test-refresh" });
      mockFetch.mockResolvedValueOnce(makeResponse({ ok: true }));

      const result = await apiFetch<{ ok: boolean }>("/me");

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("/api/me");
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer test-access");
      expect(result).toEqual({ ok: true });
    });

    it("sends a request without an auth header when not authenticated", async () => {
      mockFetch.mockResolvedValueOnce(makeResponse({ data: [] }));

      await apiFetch("/tokens");

      const [, init] = mockFetch.mock.calls[0];
      expect((init.headers as Record<string, string>)["Authorization"]).toBeUndefined();
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(makeResponse({ error: "Not found" }, 404));

      await expect(apiFetch("/missing")).rejects.toThrow("Not found");
    });

    it("retries with refreshed token on 401 and succeeds", async () => {
      saveTokens({ accessToken: "expired-access", refreshToken: "valid-refresh" });

      // First call: 401
      mockFetch.mockResolvedValueOnce(makeResponse({ error: "Unauthorized" }, 401));
      // Refresh token call: success
      mockFetch.mockResolvedValueOnce(makeResponse({ accessToken: "new-access", refreshToken: "new-refresh" }));
      // Retry original: success
      mockFetch.mockResolvedValueOnce(makeResponse({ data: "protected" }));

      const result = await apiFetch<{ data: string }>("/protected");

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(result).toEqual({ data: "protected" });
      expect(getAccessToken()).toBe("new-access");
    });

    it("throws if 401 persists after token refresh failure", async () => {
      saveTokens({ accessToken: "expired-access", refreshToken: "bad-refresh" });

      // First call: 401
      mockFetch.mockResolvedValueOnce(makeResponse({ error: "Unauthorized" }, 401));
      // Refresh token call: failure
      mockFetch.mockResolvedValueOnce(makeResponse({ error: "Invalid" }, 401));

      await expect(apiFetch("/protected")).rejects.toThrow();
    });
  });
});
