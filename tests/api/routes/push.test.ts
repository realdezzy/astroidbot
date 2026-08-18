import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import { bootstrap } from "../../../src/bootstrap.js";
import { DatabaseService } from "../../../src/services/db.js";
import { RedisService } from "../../../src/services/redis.js";
import { QueueManager } from "../../../src/services/queue.js";
import jwt from "jsonwebtoken";
import { ConfigManager } from "../../../src/config.js";

describe("Push Notification Routes (/api/push)", () => {
  let server: Server;
  let authToken: string;
  let testUserId: number;

  beforeAll(async () => {
    process.env.PORT = "0";
    server = await bootstrap();
    const db = DatabaseService.getInstance();

    const testUser = await db.prisma.user.upsert({
      where: { email: "pushtest@astroidbot.io" },
      update: {},
      create: {
        email: "pushtest@astroidbot.io",
        username: "pushtestuser",
        passwordHash: "hashedpass",
      },
    });

    testUserId = testUser.id;
    const config = ConfigManager.getInstance().config;
    authToken = jwt.sign({ userId: testUserId, email: testUser.email }, config.JWT_SECRET, {
      expiresIn: "1h",
    });
  });

  afterAll(async () => {
    const db = DatabaseService.getInstance();
    await db.prisma.pushSubscription.deleteMany({ where: { userId: testUserId } });
    await db.prisma.user.deleteMany({ where: { email: "pushtest@astroidbot.io" } });

    await new Promise<void>((resolve) => {
      server?.close?.(() => resolve());
      if (!server) resolve();
    });
    await QueueManager.getInstance().shutdown();
    await RedisService.getInstance().shutdown();
    await db.disconnect();
  });

  it("GET /api/push/vapid-key - returns VAPID public key without authentication", async () => {
    const res = await request(server).get("/api/push/vapid-key");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("publicKey");
    expect(typeof res.body.publicKey).toBe("string");
    expect(res.body.publicKey.length).toBeGreaterThan(10);
  });

  it("POST /api/push/subscribe - requires authentication", async () => {
    const res = await request(server).post("/api/push/subscribe").send({
      subscription: {
        endpoint: "https://fcm.googleapis.com/fcm/send/test-endpoint",
        keys: { p256dh: "key-p256dh", auth: "key-auth" },
      },
    });

    expect(res.status).toBe(401);
  });

  it("POST /api/push/subscribe - saves push subscription for authenticated user", async () => {
    const res = await request(server)
      .post("/api/push/subscribe")
      .set("Authorization", `Bearer ${authToken}`)
      .send({
        subscription: {
          endpoint: "https://fcm.googleapis.com/fcm/send/test-endpoint-1",
          keys: { p256dh: "key-p256dh-1", auth: "key-auth-1" },
        },
      });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });

    const db = DatabaseService.getInstance();
    const sub = await db.prisma.pushSubscription.findUnique({
      where: { endpoint: "https://fcm.googleapis.com/fcm/send/test-endpoint-1" },
    });
    expect(sub).not.toBeNull();
    expect(sub?.userId).toBe(testUserId);
  });

  it("POST /api/push/unsubscribe - removes push subscription", async () => {
    const res = await request(server)
      .post("/api/push/unsubscribe")
      .set("Authorization", `Bearer ${authToken}`)
      .send({
        endpoint: "https://fcm.googleapis.com/fcm/send/test-endpoint-1",
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const db = DatabaseService.getInstance();
    const sub = await db.prisma.pushSubscription.findUnique({
      where: { endpoint: "https://fcm.googleapis.com/fcm/send/test-endpoint-1" },
    });
    expect(sub).toBeNull();
  });
});
