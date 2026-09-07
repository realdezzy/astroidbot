import { describe, it, expect, beforeAll, vi } from "vitest";
import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { ConfigManager } from "../../src/config.js";
import { JWT_ALGORITHM, JWT_ISSUER } from "../../src/api/jwtOptions.js";

vi.mock("../../src/services/db.js", () => ({
  DatabaseService: { getInstance: () => ({ findUserById: vi.fn() }) },
}));

const { authenticate } = await import("../../src/api/middleware/auth.js");

function loadConfig() {
  process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
  process.env.AES_KEY = "testkey";
  process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
  if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
  if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;
  ConfigManager.reset();
  ConfigManager.load();
}

/** Runs the middleware and reports what it passed to `next`. */
function run(token: string): Promise<Error | undefined> {
  return new Promise((resolve) => {
    const req = { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
    const next: NextFunction = (err?: unknown) => resolve(err as Error | undefined);
    authenticate(req, {} as Response, next);
  });
}

describe("access token verification", () => {
  let secret: string;

  beforeAll(() => {
    loadConfig();
    secret = ConfigManager.getInstance().config.JWT_SECRET;
  });

  it("accepts a token this service issued", async () => {
    const token = jwt.sign({ userId: 42 }, secret, {
      algorithm: JWT_ALGORITHM,
      issuer: JWT_ISSUER,
    });

    expect(await run(token)).toBeUndefined();
  });

  it("rejects a token signed by another issuer with the same secret", async () => {
    // A shared secret between two services should not make one's tokens valid
    // at the other. Without an issuer claim it would.
    const token = jwt.sign({ userId: 42 }, secret, {
      algorithm: JWT_ALGORITHM,
      issuer: "some-other-service",
    });

    expect(await run(token)).toBeInstanceOf(Error);
  });

  it("rejects a token with no issuer claim at all", async () => {
    const token = jwt.sign({ userId: 42 }, secret, { algorithm: JWT_ALGORITHM });
    expect(await run(token)).toBeInstanceOf(Error);
  });

  it("rejects a token signed with a different HMAC algorithm", async () => {
    // Pinning means the accepted set is exactly one, not "whatever this key
    // type supports".
    const token = jwt.sign({ userId: 42 }, secret, {
      algorithm: "HS512",
      issuer: JWT_ISSUER,
    });

    expect(await run(token)).toBeInstanceOf(Error);
  });

  it("rejects an unsigned token", async () => {
    const token = jwt.sign({ userId: 42 }, "", {
      algorithm: "none" as jwt.Algorithm,
      issuer: JWT_ISSUER,
    });

    expect(await run(token)).toBeInstanceOf(Error);
  });
});
