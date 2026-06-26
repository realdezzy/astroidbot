import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import type { IncomingMessage } from "node:http";
import jwt from "jsonwebtoken";
import { ConfigManager } from "../config.js";
import { logger } from "../utils/logger.js";
import { UnauthorizedError } from "./errors.js";
import type { JwtPayload } from "./middleware/auth.js";

interface AuthenticatedClient {
  ws: WebSocket;
  userId: number;
  isAlive: boolean;
}

interface WsMessage {
  type: string;
  payload: unknown;
}

const HEARTBEAT_INTERVAL_MS = 30_000;

export class WebSocketManager {
  private static instance: WebSocketManager;
  private wss: WebSocketServer | null = null;
  private clients: Map<WebSocket, AuthenticatedClient> = new Map();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private constructor() {
  }

  static getInstance(): WebSocketManager {
    if (!WebSocketManager.instance) {
      WebSocketManager.instance = new WebSocketManager();
    }
    return WebSocketManager.instance;
  }

  initialize(server: Server): void {
    this.wss = new WebSocketServer({ server, path: "/ws" });

    this.wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
      const userId = this.authenticateConnection(req);

      if (userId === null) {
        ws.close(4001, "Unauthorized");
        logger.warn("WebSocket connection rejected: unauthorized");
        return;
      }

      const client: AuthenticatedClient = { ws, userId, isAlive: true };
      this.clients.set(ws, client);

      logger.info("WebSocket client connected", { userId });

      ws.send(
        JSON.stringify({
          type: "connected",
          payload: { userId },
        })
      );

      ws.on("pong", () => {
        const c = this.clients.get(ws);
        if (c) c.isAlive = true;
      });

      ws.on("close", () => {
        this.clients.delete(ws);
        logger.info("WebSocket client disconnected", { userId });
      });

      ws.on("error", (error) => {
        logger.error("WebSocket error", { userId, error });
        this.clients.delete(ws);
      });
    });

    this.heartbeatTimer = setInterval(() => {
      for (const [ws, client] of this.clients) {
        if (!client.isAlive) {
          logger.warn("Terminating stale WebSocket client", { userId: client.userId });
          ws.terminate();
          this.clients.delete(ws);
          continue;
        }
        client.isAlive = false;
        ws.ping();
      }
    }, HEARTBEAT_INTERVAL_MS);

    this.wss.on("close", () => {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
    });

    logger.info("WebSocket server initialized on /ws");
  }

  broadcastToUser(userId: number, message: WsMessage): void {
    const data = JSON.stringify(message);

    for (const [, client] of this.clients) {
      if (client.userId === userId && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  broadcastToAll(message: WsMessage): void {
    const data = JSON.stringify(message);

    for (const [, client] of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  broadcastTradeEvent(
    userId: number,
    event: "trade_broadcast" | "trade_confirmed" | "trade_failed",
    data: Record<string, unknown>
  ): void {
    this.broadcastToUser(userId, {
      type: event,
      payload: data,
    });
  }

  broadcastStatusChange(status: string, reason?: string): void {
    this.broadcastToAll({
      type: "bot_status",
      payload: { status, reason: reason ?? null },
    });
  }

  broadcastCycleComplete(data: {
    actionsExecuted: number;
    dailyPnl: number;
    timestamp: string;
  }): void {
    this.broadcastToAll({
      type: "cycle_complete",
      payload: data,
    });
  }

  getConnectedCount(): number {
    return this.clients.size;
  }

  private authenticateConnection(req: IncomingMessage): number | null {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const token = url.searchParams.get("token");

    if (!token) {
      return null;
    }

    try {
      const secret = ConfigManager.getInstance().config.JWT_SECRET;
      const payload = jwt.verify(token, secret) as JwtPayload;
      return payload.userId;
    } catch {
      return null;
    }
  }
}
