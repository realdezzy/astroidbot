import { describe, it, expect, beforeAll } from "vitest";
import { ConfigManager } from "../../src/config.js";

/**
 * Route-coverage guard for the router split.
 *
 * router.ts was a 1,382-line file whose `callback_query:data` handler was a
 * flat chain of ~65 `if (action === …)` branches. Splitting it into per-domain
 * route tables is only safe if nothing was dropped on the way, so this pins
 * every action the old chain handled.
 *
 * Resolution is checked, not execution: `resolve()` exists precisely so "the
 * handler threw on a stub context" can't masquerade as "there is no route".
 */

/** Every action the pre-split router dispatched, taken from its if-chain. */
const LEGACY_ACTIONS = [
  // agents + strategy wizard
  "agent_ai:advisor",
  "agent_aimode_menu:1",
  "agent_aimode_set::1:off",
  "agent_create",
  "agent_ctx:custom",
  "agent_delete:1",
  "agent_delete_details:1",
  "agent_details:1",
  "agent_run:1",
  "agent_run_details:1",
  "agent_strategies_menu:1",
  "agent_toggle:1",
  "agent_toggle_details:1",
  "cancel_agent_create",
  "strat_add:1",
  "strat_confirm_create",
  "strat_delete:1",
  "strat_toggle:1",
  "strat_type:grid",
  "strat_wallet_confirm",
  "strat_wallet_toggle:1",
  // trade + limit orders
  "cancel_order:1",
  "limit_confirm",
  "limit_create_pair",
  "limit_dir:BUY",
  "limit_token:ALEX",
  "trade_confirm",
  "trade_confirm_elite",
  "trade_dir:BUY",
  "trade_pick_pair",
  "trade_restart",
  "trade_token:ALEX",
  "trade_token_in_custom",
  "trade_token_in_select:STX",
  "trade_token_out_custom",
  "trade_token_out_select:ALEX",
  "trade_wallet_select:1",
  // wallets
  "create_wallet",
  "delete_wallet",
  "import_wallet",
  "reveal_wallet",
  "reveal_wallet:1",
  "set_default_wallet:1",
  "set_default_wallet_list",
  // system
  "cancel_session",
  "confirm_halt",
  "confirm_resume",
  "link_email_start",
  "toggle_settings:slippage",
  // refresh
  "refresh_agents",
  "refresh_control",
  "refresh_orders",
  "refresh_portfolio",
  "refresh_trades",
  "refresh_wallets",
];

describe("callback route coverage", () => {
  let router: import("../../src/bot/callbacks/registry.js").CallbackRouter;
  let bareCallbacks: Record<string, unknown>;

  beforeAll(async () => {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
    if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;
    ConfigManager.reset();
    ConfigManager.load();

    const { CallbackRouter } = await import("../../src/bot/callbacks/registry.js");
    const { agentRoutes } = await import("../../src/bot/callbacks/agents.js");
    const { tradeRoutes } = await import("../../src/bot/callbacks/trade.js");
    const { walletRoutes } = await import("../../src/bot/callbacks/wallet.js");
    const mod = await import("../../src/bot/callbacks/system.js");

    router = new CallbackRouter().register(agentRoutes, tradeRoutes, walletRoutes, mod.systemRoutes);
    bareCallbacks = mod.bareCallbacks;
  });

  it.each(LEGACY_ACTIONS)("still routes %s", (action) => {
    expect(router.has(action)).toBe(true);
  });

  it("keeps the bare non-action callbacks", () => {
    // These buttons render without the "action:" prefix, so they never reach
    // the action dispatcher.
    expect(Object.keys(bareCallbacks).sort()).toEqual([
      "broadcast_cmd",
      "resume_cmd",
      "stats_cmd",
    ]);
  });

  it("does not claim an action nobody registered", () => {
    expect(router.has("definitely_not_a_route")).toBe(false);
  });

  describe("longest-prefix resolution", () => {
    it("prefers the more specific prefix", () => {
      // Under the old sequential if-chain these two only worked because one
      // happened to be written above the other. Order is now explicit.
      const specific = router.resolve("agent_toggle_details:7");
      const general = router.resolve("agent_toggle:7");

      expect(specific).not.toBeNull();
      expect(general).not.toBeNull();
      expect(specific!.handler).not.toBe(general!.handler);
      expect(specific!.args).toEqual(["7"]);
    });

    it("splits arguments on colons", () => {
      expect(router.resolve("agent_aimode_set::3:autonomous")!.args).toEqual([
        "",
        "3",
        "autonomous",
      ]);
    });
  });

  describe("registration safety", () => {
    it("rejects a duplicate exact route instead of shadowing it", async () => {
      const { CallbackRouter } = await import("../../src/bot/callbacks/registry.js");
      const noop = async () => undefined;
      expect(() =>
        new CallbackRouter().register({ exact: { a: noop } }, { exact: { a: noop } })
      ).toThrow(/Duplicate callback route/);
    });

    it("rejects a prefix route that doesn't end in a colon", async () => {
      const { CallbackRouter } = await import("../../src/bot/callbacks/registry.js");
      const noop = async () => undefined;
      expect(() => new CallbackRouter().register({ prefix: { agent_run: noop } })).toThrow(
        /must end with ":"/
      );
    });
  });
});
