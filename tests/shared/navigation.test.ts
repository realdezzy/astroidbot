import { describe, it, expect } from "vitest";
import { WEB_ROUTES, WEB_INFO_LINK_MAP, TELEGRAM_SCREENS, TELEGRAM_COMMANDS } from "../../shared/navigation.js";

describe("Shared navigation routes and screens mapping", () => {
  it("should have correct Web routing items", () => {
    expect(WEB_ROUTES.length).toBeGreaterThan(0);
    for (const route of WEB_ROUTES) {
      expect(route.to.startsWith("/")).toBe(true);
      expect(route.label).toBeDefined();
      expect(route.iconKey).toBeDefined();
    }
  });

  it("should cover info key map routing targets", () => {
    const keys = Object.keys(WEB_INFO_LINK_MAP);
    expect(keys).toContain("portfolio");
    expect(keys).toContain("wallets");
    expect(keys).toContain("orders");
    expect(keys).toContain("trades");
    expect(keys).toContain("agents");
    
    for (const key of keys) {
      expect(WEB_INFO_LINK_MAP[key]!.startsWith("/")).toBe(true);
    }
  });

  it("should register standard Telegram command descriptions", () => {
    expect(TELEGRAM_SCREENS).toContain("main");
    expect(TELEGRAM_SCREENS).toContain("portfolio");
    expect(TELEGRAM_SCREENS).toContain("wallets");

    const commands = Object.keys(TELEGRAM_COMMANDS);
    expect(commands).toContain("start");
    expect(commands).toContain("trade");
    expect(commands).toContain("help");
    for (const cmd of commands) {
      expect(TELEGRAM_COMMANDS[cmd]).toBeDefined();
    }
  });
});
