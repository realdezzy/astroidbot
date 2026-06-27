import type { NavItem } from "./types.js";

export const WEB_ROUTES: NavItem[] = [
  { to: "/dashboard", label: "Dashboard", iconKey: "LayoutDashboard" },
  { to: "/portfolio", label: "Portfolio", iconKey: "PieChart" },
  { to: "/wallets", label: "Wallets", iconKey: "Wallet" },
  { to: "/trade", label: "Trade", iconKey: "ArrowRightLeft" },
  { to: "/trades", label: "Trades", iconKey: "Receipt" },
  { to: "/limit-orders", label: "Limit Orders", iconKey: "Clock" },
  { to: "/agents", label: "Agents", iconKey: "Bot" },
  { to: "/tokens", label: "Tokens", iconKey: "ShieldBan" },
  { to: "/settings", label: "Settings", iconKey: "Settings" },
  { to: "/account", label: "Account", iconKey: "UserCog" },
];

export const WEB_INFO_LINK_MAP: Record<string, string> = {
  portfolio: "/portfolio",
  wallets: "/wallets",
  orders: "/limit-orders",
  trades: "/trades",
  agents: "/agents",
  settings: "/settings",
  account: "/account",
  dashboard: "/dashboard",
};

export const TELEGRAM_SCREENS: string[] = [
  "main", "portfolio", "wallets", "trades", "orders", "agents", "settings", "trade", "control",
];

export const TELEGRAM_COMMANDS: Record<string, string> = {
  start: "Main menu",
  trade: "Swap tokens",
  portfolio: "View balances and allocations",
  wallets: "Create, import, reveal, or delete wallets",
  trades: "Trade history",
  orders: "Active limit orders",
  agents: "AI automated trading agents",
  settings: "Risk, slippage, and position configuration",
  help: "Command list",
  link_email: "Link email to access the web dashboard",
};
