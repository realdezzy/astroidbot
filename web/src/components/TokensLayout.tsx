import { useState, useEffect } from "react";
import { Outlet, NavLink, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  LayoutDashboard,
  LogOut,
  Sun,
  Moon,
  Menu,
  X,
  Search,
  Layers,
  LogIn,
} from "lucide-react";
import { useAuth } from "../lib/auth";
import { apiFetch } from "../lib/api";
import { classNames } from "../lib/utils";
import { MarqueeTicker } from "./MarqueeTicker";

interface ChainInfo {
  chainId: string;
  displayName: string;
}

interface DiscoverItem {
  contractId: string;
  symbol: string;
  chainId: string;
  priceUsd: number | null;
  priceChange: {
    m5: number | null;
    h1: number | null;
    h6: number | null;
    h24: number | null;
  };
}

export function TokensLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState(searchParams.get("q") ?? "");
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const stored = localStorage.getItem("theme") as "light" | "dark" | null;
    if (stored) return stored;
    if (window.matchMedia("(prefers-color-scheme: light)").matches) return "light";
    return "dark";
  });

  useEffect(() => {
    if (theme === "light") {
      document.documentElement.classList.add("light");
    } else {
      document.documentElement.classList.remove("light");
    }
  }, [theme]);

  const toggleTheme = () => {
    const nextTheme = theme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
    localStorage.setItem("theme", nextTheme);
  };

  const handleLogout = async () => {
    await logout();
    navigate("/login");
  };

  const { data: chainData } = useQuery<{ chains: ChainInfo[] }>({
    queryKey: ["chains"],
    queryFn: () => apiFetch("/chains"),
    staleTime: 5 * 60_000,
  });

  const { data: marqueeData, isLoading: marqueeLoading } = useQuery<{ items: DiscoverItem[] }>({
    queryKey: ["marquee-tokens"],
    queryFn: () => apiFetch("/tokens/discover?category=gainers&pageSize=20"),
    refetchInterval: 30_000,
  });

  const chains = chainData?.chains ?? [];
  const activeChainId = searchParams.get("chainId");

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      navigate(`/tokens?q=${encodeURIComponent(searchQuery.trim())}`);
    }
  };

  const handleSelectChain = (chainId: string | null) => {
    const newParams = new URLSearchParams(searchParams);
    if (chainId) {
      newParams.set("chainId", chainId);
    } else {
      newParams.delete("chainId");
    }
    navigate(`/tokens?${newParams.toString()}`);
  };

  const marqueeTokens = (marqueeData?.items ?? []).map((t) => ({
    symbol: t.symbol,
    priceChange24h: t.priceChange.h24,
    priceChange6h: t.priceChange.h6,
    priceUsd: t.priceUsd,
    chainId: t.chainId,
    contractId: t.contractId,
  }));

  return (
    <div className="min-h-screen flex flex-col bg-main-bg text-main-text transition-colors duration-300">
      {/* Moving Marquee Ticker */}
      <MarqueeTicker tokens={marqueeTokens} isLoading={marqueeLoading} />

      <div className="flex-1 flex flex-col md:flex-row">
        {/* Mobile Header */}
        <header className="md:hidden flex items-center justify-between px-4 py-3 bg-sidebar-bg border-b border-sidebar-border transition-colors duration-300">
          <NavLink to="/tokens" className="flex items-center gap-2.5">
            <img src="/logo.png" alt="AstroidBot Logo" className="w-7 h-7 object-contain shrink-0" />
            <div>
              <h1 className="text-sm font-bold text-title-text leading-tight">AstroidBot</h1>
              <p className="text-[9px] text-muted-text">DexScreener AI</p>
            </div>
          </NavLink>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleTheme}
              className="p-2 text-muted-text hover:text-title-text rounded-lg bg-bg-hover transition-colors"
            >
              {theme === "dark" ? <Sun className="w-4 h-4 text-yellow-400" /> : <Moon className="w-4 h-4 text-indigo-500" />}
            </button>
            <button
              onClick={() => setMobileOpen(true)}
              className="p-2 text-muted-text hover:text-title-text rounded-lg bg-bg-hover transition-colors"
            >
              <Menu className="w-5 h-5" />
            </button>
          </div>
        </header>

        {/* Tokens Sidebar (Search & Chains Rail) */}
        <aside className="hidden md:flex w-60 bg-sidebar-bg border-r border-sidebar-border flex-col shrink-0 transition-colors duration-300">
          <div className="p-4 border-b border-sidebar-border flex items-center justify-between">
            <NavLink to="/tokens" className="flex items-center gap-2.5">
              <img src="/logo.png" alt="AstroidBot Logo" className="w-8 h-8 object-contain shrink-0" />
              <div>
                <h1 className="text-base font-bold text-title-text leading-tight">AstroidBot</h1>
                <p className="text-[10px] text-muted-text">DexScreener AI</p>
              </div>
            </NavLink>
          </div>

          <div className="p-3 border-b border-sidebar-border">
            <form onSubmit={handleSearchSubmit} className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-text" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search token or contract"
                className="w-full rounded-lg border border-card-border bg-input-bg py-1.5 pl-8 pr-2 text-xs text-title-text placeholder-muted-text focus:border-brand-500/50 focus:outline-none"
              />
            </form>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-4">
            {/* Quick link to Dashboard if logged in */}
            {user && (
              <NavLink
                to="/dashboard"
                className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs text-muted-text hover:text-title-text hover:bg-bg-hover transition-colors font-medium border border-card-border/60 bg-bg-hover/30"
              >
                <LayoutDashboard className="w-4 h-4 text-brand-400" />
                <span>Go to Dashboard</span>
              </NavLink>
            )}

            {/* Chains Rail */}
            <div className="space-y-1">
              <div className="px-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-muted-text/70">
                Chains
              </div>
              <button
                onClick={() => handleSelectChain(null)}
                className={classNames(
                  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors cursor-pointer",
                  !activeChainId
                    ? "bg-brand-500/15 text-title-text font-bold"
                    : "text-muted-text hover:bg-bg-hover hover:text-title-text"
                )}
              >
                <Layers className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">All Chains</span>
              </button>

              {chains.map((c) => (
                <button
                  key={c.chainId}
                  onClick={() => handleSelectChain(c.chainId)}
                  className={classNames(
                    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors cursor-pointer",
                    activeChainId === c.chainId
                      ? "bg-brand-500/15 text-title-text font-bold"
                      : "text-muted-text hover:bg-bg-hover hover:text-title-text"
                  )}
                >
                  <span
                    aria-hidden
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: chainColor(c.chainId) }}
                  />
                  <span className="truncate font-medium">{c.displayName}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="p-3 border-t border-sidebar-border space-y-3">
            <button
              onClick={toggleTheme}
              className="flex items-center justify-between w-full px-2.5 py-1.5 text-xs text-muted-text hover:text-title-text hover:bg-bg-hover rounded-lg transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-2">
                {theme === "dark" ? <Sun className="w-3.5 h-3.5 text-yellow-400" /> : <Moon className="w-3.5 h-3.5 text-indigo-500" />}
                <span>{theme === "dark" ? "Light Mode" : "Dark Mode"}</span>
              </div>
            </button>

            {user ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2.5 px-2">
                  <div className="w-7 h-7 rounded-full bg-brand-500 flex items-center justify-center text-xs font-bold text-white shrink-0">
                    {user?.username?.[0]?.toUpperCase() ?? "U"}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-title-text truncate">
                      {user?.username ?? "User"}
                    </p>
                    <p className="text-[10px] text-muted-text">{user?.points ?? 0} pts</p>
                  </div>
                </div>

                <button
                  onClick={handleLogout}
                  className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs text-muted-text hover:text-red-400 hover:bg-bg-hover rounded-lg transition-colors cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Logout
                </button>
              </div>
            ) : (
              <NavLink
                to="/login"
                className="flex items-center justify-center gap-1.5 w-full py-2 px-3 rounded-lg bg-brand-500 hover:bg-brand-600 text-white font-bold text-xs transition-colors"
              >
                <LogIn className="w-3.5 h-3.5" />
                <span>Sign In</span>
              </NavLink>
            )}
          </div>
        </aside>

        {/* Mobile Drawer */}
        {mobileOpen && (
          <div className="fixed inset-0 z-50 flex md:hidden">
            <div
              onClick={() => setMobileOpen(false)}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-300"
            />

            <aside className="relative w-64 max-w-xs bg-sidebar-bg border-r border-sidebar-border flex flex-col z-10 transition-colors duration-300">
              <div className="p-4 border-b border-sidebar-border flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <img src="/logo.png" alt="AstroidBot Logo" className="w-7 h-7 object-contain shrink-0" />
                  <div>
                    <h1 className="text-sm font-bold text-title-text">AstroidBot</h1>
                    <p className="text-[9px] text-muted-text">DexScreener AI</p>
                  </div>
                </div>
                <button
                  onClick={() => setMobileOpen(false)}
                  className="p-1 text-muted-text hover:text-title-text rounded-lg hover:bg-input-bg transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-3 border-b border-sidebar-border">
                <form onSubmit={handleSearchSubmit} className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-text" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search token"
                    className="w-full rounded-lg border border-card-border bg-input-bg py-1.5 pl-8 pr-2 text-xs text-title-text focus:outline-none"
                  />
                </form>
              </div>

              <div className="flex-1 p-3 space-y-3 overflow-y-auto">
                {user && (
                  <NavLink
                    to="/dashboard"
                    onClick={() => setMobileOpen(false)}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs text-muted-text hover:text-title-text hover:bg-input-bg transition-colors font-medium border border-card-border/60"
                  >
                    <LayoutDashboard className="w-4 h-4 text-brand-400" />
                    <span>Go to Dashboard</span>
                  </NavLink>
                )}

                <div className="space-y-1">
                  <div className="px-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-muted-text/70">
                    Chains
                  </div>
                  <button
                    onClick={() => {
                      handleSelectChain(null);
                      setMobileOpen(false);
                    }}
                    className={classNames(
                      "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors cursor-pointer",
                      !activeChainId
                        ? "bg-brand-500/15 text-title-text font-bold"
                        : "text-muted-text hover:bg-bg-hover hover:text-title-text"
                    )}
                  >
                    <Layers className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">All Chains</span>
                  </button>

                  {chains.map((c) => (
                    <button
                      key={c.chainId}
                      onClick={() => {
                        handleSelectChain(c.chainId);
                        setMobileOpen(false);
                      }}
                      className={classNames(
                        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors cursor-pointer",
                        activeChainId === c.chainId
                          ? "bg-brand-500/15 text-title-text font-bold"
                          : "text-muted-text hover:bg-bg-hover hover:text-title-text"
                      )}
                    >
                      <span
                        aria-hidden
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: chainColor(c.chainId) }}
                      />
                      <span className="truncate font-medium">{c.displayName}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="p-3 border-t border-sidebar-border space-y-3">
                {user ? (
                  <button
                    onClick={() => {
                      setMobileOpen(false);
                      handleLogout();
                    }}
                    className="flex items-center gap-2 w-full px-3 py-2 text-xs text-muted-text hover:text-red-400 hover:bg-bg-hover rounded-lg transition-colors"
                  >
                    <LogOut className="w-4 h-4" />
                    Logout
                  </button>
                ) : (
                  <NavLink
                    to="/login"
                    onClick={() => setMobileOpen(false)}
                    className="flex items-center justify-center gap-2 w-full py-2 px-3 rounded-lg bg-brand-500 text-white font-bold text-xs"
                  >
                    <LogIn className="w-4 h-4" />
                    Sign In
                  </NavLink>
                )}
              </div>
            </aside>
          </div>
        )}

        {/* Main Content Area */}
        <main className="flex-1 overflow-y-auto bg-main-bg transition-colors duration-300">
          <div className="p-4 md:p-6 max-w-7xl mx-auto">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

function chainColor(chainId: string): string {
  let hash = 0;
  for (let i = 0; i < chainId.length; i++) hash = chainId.charCodeAt(i) + ((hash << 5) - hash);
  return `hsl(${Math.abs(hash) % 360} 70% 55%)`;
}
