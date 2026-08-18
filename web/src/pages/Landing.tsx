import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import {
  Bot,
  ArrowRight,
  TrendingUp,
  Shield,
  Zap,
  Lock,
  Wallet,
  Activity,
  Mail,
  ChevronRight,
  Sparkles,
  Sun,
  Moon,
  Mic,
  BarChart3,
  Flame,
  Layers,
  Cpu,
  Globe,
  ArrowUpRight,
  Terminal,
} from "lucide-react";
import { useAuth } from "../lib/auth";

export function Landing() {
  const { user } = useAuth();
  const [currency, setCurrency] = useState<"USD" | "STX" | "SOL" | "ETH">("USD");
  const [investment, setInvestment] = useState<number>(1000);
  const [strategy, setStrategy] = useState<"conservative" | "moderate" | "aggressive">("moderate");
  const [days, setDays] = useState<number>(90);
  const [contactSubmitted, setContactSubmitted] = useState<boolean>(false);
  const [contactForm, setContactForm] = useState({ name: "", email: "", message: "" });

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

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: light)");
    const handleChange = (e: MediaQueryListEvent) => {
      const stored = localStorage.getItem("theme");
      if (!stored) {
        setTheme(e.matches ? "light" : "dark");
      }
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  const toggleTheme = () => {
    const nextTheme = theme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
    localStorage.setItem("theme", nextTheme);
  };

  // Calculator logic
  const getAPY = () => {
    switch (strategy) {
      case "conservative":
        return 0.14;
      case "moderate":
        return 0.32;
      case "aggressive":
        return 0.65;
    }
  };

  const apy = getAPY();
  const estimatedProfit = investment * (Math.pow(1 + apy / 365, days) - 1);
  const projectedTotal = investment + estimatedProfit;

  const currencySymbol = currency === "USD" ? "$" : "";

  // Generate SVG path points for the profit calculator graph
  const generateGraphPath = () => {
    const width = 500;
    const height = 180;
    const pointsCount = 10;
    const points: string[] = [];

    for (let i = 0; i <= pointsCount; i++) {
      const x = (i / pointsCount) * width;
      const progress = i / pointsCount;
      const growth = investment * (Math.pow(1 + apy / 365, days * progress) - investment) / (projectedTotal - investment || 1);
      const volatility = Math.sin(progress * Math.PI * 3) * 15 * (1 - progress);
      const y = height - 30 - growth * (height - 60) + volatility;
      points.push(`${x},${y}`);
    }
    return `M 0,${height - 30} Q ${points.slice(1).join(" ")}`;
  };

  const handleContactSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setContactSubmitted(true);
    setContactForm({ name: "", email: "", message: "" });
    setTimeout(() => setContactSubmitted(false), 5000);
  };

  return (
    <div className="min-h-screen bg-main-bg text-main-text selection:bg-brand-500/30 overflow-x-hidden font-sans">
      {/* Background glow effects */}
      <div className="absolute top-0 left-1/4 w-[500px] h-[500px] bg-brand-500/10 rounded-full filter blur-[140px] pointer-events-none" />
      <div className="absolute top-[800px] right-1/4 w-[600px] h-[600px] bg-indigo-500/5 rounded-full filter blur-[180px] pointer-events-none" />
      <div className="absolute top-[1800px] left-1/3 w-[650px] h-[650px] bg-purple-600/5 rounded-full filter blur-[200px] pointer-events-none" />

      {/* Header / Navigation */}
      <header className="sticky top-0 z-50 backdrop-blur-md bg-main-bg/80 border-b border-sidebar-border">
        <div className="mx-auto px-6 h-16 flex items-center">
          <a href="/" className="flex-1 flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0">
              <img src="/logo.png" alt="AstroidBot Logo" className="w-9 h-9 object-contain" />
            </div>
            <div className="shrink-0">
              <span className="font-bold text-title-text text-lg tracking-tight">AstroidBot</span>
              <span className="text-xs block text-brand-400 font-mono -mt-1">MULTI-CHAIN AI 2.0</span>
            </div>
          </a>

          <nav className="hidden md:flex items-center gap-8 text-sm text-muted-text font-medium">
            <a href="#features" className="hover:text-title-text transition-colors">Features</a>
            <Link to="/tokens" className="hover:text-title-text transition-colors flex items-center gap-1">
              <span>Token Discovery</span>
              <span className="px-1.5 py-0.2 text-[9px] font-bold rounded bg-brand-500/20 text-brand-400 border border-brand-500/30">Live</span>
            </Link>
            <a href="#ai-assistant" className="hover:text-title-text transition-colors">AI Assistant</a>
            <a href="#integrations" className="hover:text-title-text transition-colors">Supported Chains</a>
            <a href="#calculator" className="hover:text-title-text transition-colors">Yield Calculator</a>
            <Link to="/docs" className="hover:text-title-text transition-colors">Docs</Link>
          </nav>

          <div className="flex-grow flex items-center justify-end gap-2 sm:gap-4">
            <button
              onClick={toggleTheme}
              className="p-2 text-muted-text hover:text-title-text rounded-lg bg-bg-hover hover:bg-input-bg transition-colors cursor-pointer"
              title="Toggle theme"
            >
              {theme === "dark" ? <Sun className="w-4 h-4 text-yellow-400" /> : <Moon className="w-4 h-4 text-indigo-500" />}
            </button>
            {user ? (
              <Link
                to="/dashboard"
                className="flex items-center gap-1.5 sm:gap-2 px-3 py-1.5 sm:px-4 sm:py-2 bg-brand-500 hover:bg-brand-600 text-white rounded-lg text-xs sm:text-sm font-medium transition-all duration-200 shadow-lg shadow-brand-500/20"
              >
                Dashboard
                <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            ) : (
              <>
                <Link
                  to="/login"
                  className="text-xs sm:text-sm font-medium text-muted-text hover:text-title-text transition-colors px-2 py-1 hidden xs:inline-block"
                >
                  Sign In
                </Link>
                <Link
                  to="/register"
                  className="px-3 py-1.5 sm:px-4 sm:py-2 bg-brand-500 hover:bg-brand-600 text-white rounded-lg text-xs sm:text-sm font-medium transition-all duration-200 shadow-lg shadow-brand-500/20"
                >
                  Get Started
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative mx-auto px-6 pt-16 pb-24 text-center">
        {/* Release Pill */}
        <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-brand-500/10 border border-brand-500/30 text-brand-400 text-xs font-semibold mb-8">
          <Sparkles className="w-3.5 h-3.5 animate-pulse" />
          <span>ASTROIDBOT 2.0 — MULTI-CHAIN AI TRADING INDEXER & ROUTER</span>
        </div>

        <h1 className="text-4xl sm:text-6xl font-black text-title-text tracking-tight leading-tight max-w-5xl mx-auto">
          The <span className="text-transparent bg-clip-text bg-gradient-to-r from-brand-400 via-indigo-400 to-purple-400">Multi-Chain AI Indexer</span> & Autonomous DEX Trading Suite
        </h1>

        <p className="mt-6 text-lg text-muted-text max-w-3xl mx-auto leading-relaxed">
          Index live market data, discover real-time DEX liquidity across Solana, Base, Stacks, and EVM networks, and execute voice-powered AI trading strategies non-custodially.
        </p>

        <div className="mt-10 flex flex-wrap justify-center gap-4">
          <Link
            to={user ? "/dashboard" : "/register"}
            className="px-8 py-4 bg-brand-500 hover:bg-brand-600 text-white font-bold rounded-xl text-base transition-all duration-200 shadow-xl shadow-brand-500/30 flex items-center gap-2 hover:translate-x-0.5"
          >
            Launch Trading App
            <ArrowRight className="w-5 h-5" />
          </Link>
          <Link
            to="/tokens"
            className="px-8 py-4 bg-card-bg hover:bg-bg-hover border border-card-border hover:border-brand-500/40 text-main-text font-bold rounded-xl text-base transition-all duration-200 flex items-center gap-2"
          >
            <Flame className="w-4 h-4 text-orange-400" />
            Explore Dex Markets
          </Link>
        </div>

        {/* Dashboard Showcase Simulation */}
        <div className="mt-16 relative max-w-5xl mx-auto rounded-2xl border border-card-border bg-card-bg p-4 backdrop-blur-sm shadow-2xl overflow-hidden">
          <div className="absolute -inset-0.5 bg-gradient-to-r from-brand-500 via-indigo-500 to-purple-600 rounded-2xl opacity-10 filter blur-xl pointer-events-none" />

          {/* Window control bar */}
          <div className="flex items-center justify-between pb-3 border-b border-card-border mb-4 px-2">
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-red-500/80" />
              <span className="w-3 h-3 rounded-full bg-yellow-500/80" />
              <span className="w-3 h-3 rounded-full bg-green-500/80" />
              <span className="text-xs text-muted-text ml-2 font-mono">astroidbot-indexer-v2.0</span>
            </div>
            <div className="flex items-center gap-2 sm:gap-3">
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 font-bold flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                INDEXER ONLINE
              </span>
              <span className="text-xs text-muted-text font-mono hidden sm:inline">Chains: Solana · Base · Stacks · EVM</span>
            </div>
          </div>

          {/* Interactive Mockup Grid */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-left">
            {/* Sidebar Simulation */}
            <div className="hidden md:block col-span-1 border-r border-card-border pr-4 space-y-2">
              <div className="flex items-center gap-2.5 px-3 py-2 bg-brand-500/15 text-brand-400 rounded-lg text-xs font-semibold">
                <BarChart3 className="w-4 h-4" />
                <span>Live Indexer</span>
              </div>
              <div className="flex items-center gap-2.5 px-3 py-2 text-muted-text hover:text-title-text rounded-lg text-xs font-medium cursor-pointer transition-colors">
                <Bot className="w-4 h-4 text-purple-400" />
                <span>AI Voice Assistant</span>
              </div>
              <div className="flex items-center gap-2.5 px-3 py-2 text-muted-text hover:text-title-text rounded-lg text-xs font-medium cursor-pointer transition-colors">
                <Activity className="w-4 h-4 text-emerald-400" />
                <span>Multi-DEX Swaps</span>
              </div>
              <div className="flex items-center gap-2.5 px-3 py-2 text-muted-text hover:text-title-text rounded-lg text-xs font-medium cursor-pointer transition-colors">
                <Zap className="w-4 h-4 text-yellow-400" />
                <span>Limit Orders</span>
              </div>
            </div>

            {/* Main Content Simulation */}
            <div className="col-span-1 md:col-span-3 space-y-4">
              {/* Quick stats strip */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="bg-main-bg/80 border border-card-border rounded-xl p-3">
                  <div className="text-[10px] text-muted-text uppercase font-semibold">Indexed DEX Pools</div>
                  <div className="text-lg font-bold text-title-text mt-0.5">14,280+</div>
                  <div className="text-[10px] text-emerald-400 mt-1 flex items-center gap-0.5">
                    <span>↑ Real-time websocket sync</span>
                  </div>
                </div>
                <div className="bg-main-bg/80 border border-card-border rounded-xl p-3">
                  <div className="text-[10px] text-muted-text uppercase font-semibold">AI Agent Execution</div>
                  <div className="text-lg font-bold text-emerald-400 mt-0.5 flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-emerald-400" />
                    <span>AUTOMATED</span>
                  </div>
                  <div className="text-[10px] text-muted-text mt-1">Non-custodial cryptographic key</div>
                </div>
                <div className="bg-main-bg/80 border border-card-border rounded-xl p-3">
                  <div className="text-[10px] text-muted-text uppercase font-semibold">24H Tracked Volume</div>
                  <div className="text-lg font-bold text-title-text mt-0.5">$48.6M</div>
                  <div className="text-[10px] text-brand-400 mt-1">Across 6 supported networks</div>
                </div>
              </div>

              {/* AI Prompt Simulator */}
              <div className="bg-main-bg/80 border border-card-border rounded-xl p-3.5 font-mono text-xs space-y-2">
                <div className="flex items-center justify-between text-muted-text text-[10px]">
                  <span className="flex items-center gap-1 text-purple-400 font-bold">
                    <Mic className="w-3 h-3" /> Voice & Chat AI Orchestrator
                  </span>
                  <span>Status: Ready</span>
                </div>
                <div className="bg-input-bg border border-card-border rounded-lg p-2.5 flex items-center gap-2 text-title-text">
                  <Terminal className="w-4 h-4 text-brand-400 shrink-0" />
                  <span className="text-brand-300 font-bold">&gt;</span>
                  <span className="truncate">&quot;Swap 500 USDC to STX on Bitflow when 1-hour RSI falls below 30&quot;</span>
                </div>
                <div className="flex items-center justify-between text-[11px] text-emerald-400 font-sans font-semibold pt-1">
                  <span>✔ Parsed strategy target: STX / USDC · Auto-limit order scheduled</span>
                  <span className="text-muted-text font-mono text-[10px]">Latency: 12ms</span>
                </div>
              </div>

              {/* Mini Token Indexer Preview Table */}
              <div className="bg-main-bg/80 border border-card-border rounded-xl p-3 overflow-hidden text-xs">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-bold text-title-text text-xs flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5 text-brand-400" />
                    Live Indexed Token Discovery
                  </span>
                  <Link to="/tokens" className="text-[11px] text-brand-400 font-semibold hover:underline flex items-center gap-0.5">
                    View All Markets <ArrowUpRight className="w-3 h-3" />
                  </Link>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="text-[10px] text-muted-text border-b border-card-border uppercase">
                        <th className="py-1.5 px-2">Token</th>
                        <th className="py-1.5 px-2">Chain</th>
                        <th className="py-1.5 px-2 text-right">Price</th>
                        <th className="py-1.5 px-2 text-right">24h Vol</th>
                        <th className="py-1.5 px-2 text-right">24h %</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-card-border/40 font-mono text-[11px]">
                      <tr>
                        <td className="py-1.5 px-2 font-bold text-title-text">wSTX</td>
                        <td className="py-1.5 px-2"><span className="text-[9px] px-1 py-0.5 rounded bg-orange-500/15 text-orange-400 font-bold uppercase">Stacks</span></td>
                        <td className="py-1.5 px-2 text-right text-title-text">$1.845</td>
                        <td className="py-1.5 px-2 text-right text-muted-text">$2.4M</td>
                        <td className="py-1.5 px-2 text-right text-emerald-400 font-bold">+12.4%</td>
                      </tr>
                      <tr>
                        <td className="py-1.5 px-2 font-bold text-title-text">SOL</td>
                        <td className="py-1.5 px-2"><span className="text-[9px] px-1 py-0.5 rounded bg-purple-500/15 text-purple-400 font-bold uppercase">Solana</span></td>
                        <td className="py-1.5 px-2 text-right text-title-text">$182.10</td>
                        <td className="py-1.5 px-2 text-right text-muted-text">$18.9M</td>
                        <td className="py-1.5 px-2 text-right text-emerald-400 font-bold">+8.1%</td>
                      </tr>
                      <tr>
                        <td className="py-1.5 px-2 font-bold text-title-text">WELSH</td>
                        <td className="py-1.5 px-2"><span className="text-[9px] px-1 py-0.5 rounded bg-blue-500/15 text-blue-400 font-bold uppercase">Base</span></td>
                        <td className="py-1.5 px-2 text-right text-title-text">$0.0034</td>
                        <td className="py-1.5 px-2 text-right text-muted-text">$840K</td>
                        <td className="py-1.5 px-2 text-right text-red-400 font-bold">-3.2%</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Supported Chains & Protocols Section */}
      <section id="integrations" className="max-w-[1400px] mx-auto px-6 py-16 border-t border-sidebar-border text-center">
        <span className="text-xs uppercase text-muted-text tracking-wider font-bold">Supported Multi-Chain Ecosystems & Protocols</span>
        <div className="mt-8 flex flex-wrap justify-center items-center gap-8 md:gap-12 opacity-85">
          <div className="flex items-center gap-2 bg-card-bg px-4 py-2 rounded-xl border border-card-border">
            <span className="font-bold text-sm text-title-text font-mono">SOLANA</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400 font-bold">Jupiter DEX</span>
          </div>
          <div className="flex items-center gap-2 bg-card-bg px-4 py-2 rounded-xl border border-card-border">
            <span className="font-bold text-sm text-title-text font-mono">BASE</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 font-bold">Uniswap V3</span>
          </div>
          <div className="flex items-center gap-2 bg-card-bg px-4 py-2 rounded-xl border border-card-border">
            <span className="font-bold text-sm text-title-text font-mono">STACKS</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-400 font-bold">Bitflow · ALEX · Velar</span>
          </div>
          <div className="flex items-center gap-2 bg-card-bg px-4 py-2 rounded-xl border border-card-border">
            <span className="font-bold text-sm text-title-text font-mono">ROBINHOOD CHAIN</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-bold">EVM</span>
          </div>
          <div className="flex items-center gap-2 bg-card-bg px-4 py-2 rounded-xl border border-card-border">
            <span className="font-bold text-sm text-title-text font-mono">CELO</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-bold">Refuel</span>
          </div>
        </div>
      </section>

      {/* Upgraded Features Section */}
      <section id="features" className="max-w-[1400px] mx-auto px-6 py-24 border-t border-sidebar-border">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h2 className="text-3xl sm:text-4xl font-black text-title-text">Upgraded Platform Capabilities</h2>
          <p className="mt-4 text-muted-text">
            AstroidBot 2.0 brings together real-time market indexing, natural language AI controls, and non-custodial cross-chain execution in one unified system.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <div className="bg-card-bg border border-card-border p-6 rounded-2xl hover:border-brand-500/40 transition-all duration-300 group">
            <div className="w-12 h-12 rounded-xl bg-brand-500/10 flex items-center justify-center border border-brand-500/20 text-brand-400 mb-6 group-hover:scale-110 transition-transform">
              <Globe className="w-6 h-6" />
            </div>
            <h3 className="text-lg font-bold text-title-text mb-2">Live Token Indexer</h3>
            <p className="text-muted-text text-xs leading-relaxed">
              DexScreener-style real-time token discovery, 24h volume tracking, top traders analytics, liquidity statistics, and historical candles across all active chains.
            </p>
          </div>

          <div className="bg-card-bg border border-card-border p-6 rounded-2xl hover:border-brand-500/40 transition-all duration-300 group" id="ai-assistant">
            <div className="w-12 h-12 rounded-xl bg-purple-500/10 flex items-center justify-center border border-purple-500/20 text-purple-400 mb-6 group-hover:scale-110 transition-transform">
              <Mic className="w-6 h-6" />
            </div>
            <h3 className="text-lg font-bold text-title-text mb-2">Voice & AI Commands</h3>
            <p className="text-muted-text text-xs leading-relaxed">
              Execute complex swaps, limit orders, and agent strategies using natural speech or chat. Powered by Whisper AI and Astroid AI Orchestration.
            </p>
          </div>

          <div className="bg-card-bg border border-card-border p-6 rounded-2xl hover:border-brand-500/40 transition-all duration-300 group">
            <div className="w-12 h-12 rounded-xl bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20 text-emerald-400 mb-6 group-hover:scale-110 transition-transform">
              <Cpu className="w-6 h-6" />
            </div>
            <h3 className="text-lg font-bold text-title-text mb-2">Autonomous AI Agents</h3>
            <p className="text-muted-text text-xs leading-relaxed">
              Deploy intelligent trading agents with customizable risk parameters, signal strategies, and automated grid rebalancing logic.
            </p>
          </div>

          <div className="bg-card-bg border border-card-border p-6 rounded-2xl hover:border-brand-500/40 transition-all duration-300 group">
            <div className="w-12 h-12 rounded-xl bg-yellow-500/10 flex items-center justify-center border border-yellow-500/20 text-yellow-400 mb-6 group-hover:scale-110 transition-transform">
              <Zap className="w-6 h-6" />
            </div>
            <h3 className="text-lg font-bold text-title-text mb-2">Limit Orders & Perps</h3>
            <p className="text-muted-text text-xs leading-relaxed">
              Set precise trigger targets off-chain. Transactions execute auto-signed when limits are met, eliminating manual browser interaction.
            </p>
          </div>
        </div>
      </section>

      {/* Yield Calculator Section */}
      <section id="calculator" className="max-w-[1400px] mx-auto px-6 py-24 border-t border-sidebar-border">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
          <div>
            <h2 className="text-3xl sm:text-4xl font-black text-title-text">Project your compounding yields</h2>
            <p className="mt-4 text-muted-text leading-relaxed text-sm">
              Select your preferred base asset, configure your AI bot strategy risk profile, and visualize projected compounding performance across automated grid cycles.
            </p>

            <div className="mt-8 space-y-6">
              {/* Base Currency Selection */}
              <div>
                <label className="block text-xs text-muted-text font-bold mb-2 uppercase">Base Asset</label>
                <div className="grid grid-cols-4 gap-2">
                  {(["USD", "STX", "SOL", "ETH"] as const).map((c) => (
                    <button
                      key={c}
                      onClick={() => setCurrency(c)}
                      className={`py-2 px-3 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                        currency === c
                          ? "bg-brand-500/20 border-brand-500 text-brand-400"
                          : "bg-card-bg border-card-border text-muted-text hover:text-title-text"
                      }`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>

              {/* Investment capital slider */}
              <div>
                <div className="flex justify-between text-sm mb-2">
                  <span className="text-muted-text font-medium">Investment Amount ({currency})</span>
                  <span className="text-brand-400 font-bold font-mono">
                    {currencySymbol}{investment.toLocaleString()} {currency !== "USD" ? currency : ""}
                  </span>
                </div>
                <input
                  type="range"
                  min="100"
                  max="50000"
                  step="100"
                  value={investment}
                  onChange={(e) => setInvestment(Number(e.target.value))}
                  className="w-full h-1.5 bg-bg-hover border border-card-border rounded-lg appearance-none cursor-pointer accent-brand-500"
                />
              </div>

              {/* Bot strategy selector */}
              <div>
                <label className="block text-xs text-muted-text font-bold mb-2 uppercase">Strategy Profile</label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {(["conservative", "moderate", "aggressive"] as const).map((strat) => (
                    <button
                      key={strat}
                      onClick={() => setStrategy(strat)}
                      className={`py-2.5 px-4 rounded-xl text-xs font-bold border capitalize transition-all duration-200 cursor-pointer ${
                        strategy === strat
                          ? "bg-brand-500/20 border-brand-500 text-brand-400"
                          : "bg-card-bg border-card-border text-muted-text hover:text-title-text hover:border-brand-500/30"
                      }`}
                    >
                      {strat === "conservative" && "Conservative (14% APY)"}
                      {strat === "moderate" && "Balanced (32% APY)"}
                      {strat === "aggressive" && "Aggressive (65% APY)"}
                    </button>
                  ))}
                </div>
              </div>

              {/* Duration selector */}
              <div>
                <label className="block text-xs text-muted-text font-bold mb-2 uppercase">Time Horizon</label>
                <div className="grid grid-cols-3 gap-3">
                  {([30, 90, 365] as const).map((d) => (
                    <button
                      key={d}
                      onClick={() => setDays(d)}
                      className={`py-2 px-4 rounded-xl text-xs font-bold border transition-all duration-200 cursor-pointer ${
                        days === d
                          ? "bg-brand-500/20 border-brand-500 text-brand-400"
                          : "bg-card-bg border-card-border text-muted-text hover:text-title-text hover:border-brand-500/30"
                      }`}
                    >
                      {d} Days
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Calculator Output Display */}
          <div className="bg-card-bg border border-card-border rounded-3xl p-8 backdrop-blur-sm relative overflow-hidden">
            <div className="absolute top-0 right-0 w-24 h-24 bg-brand-500/10 rounded-full filter blur-2xl pointer-events-none" />

            <div className="space-y-6">
              <div>
                <span className="text-xs text-muted-text uppercase tracking-wider font-semibold">Estimated Profit</span>
                <div className="text-4xl sm:text-5xl font-black text-title-text mt-1 font-mono">
                  +{currencySymbol}{estimatedProfit.toFixed(2)} <span className="text-brand-400 text-xl font-sans font-bold">{currency !== "USD" ? currency : ""}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 py-4 border-y border-card-border">
                <div>
                  <span className="text-xs text-muted-text block">Projected Total</span>
                  <span className="text-lg font-bold text-title-text mt-0.5 font-mono">
                    {currencySymbol}{projectedTotal.toFixed(2)} {currency !== "USD" ? currency : ""}
                  </span>
                </div>
                <div>
                  <span className="text-xs text-muted-text block">Yield APY</span>
                  <span className="text-lg font-bold text-brand-400 mt-0.5 font-mono">{(apy * 100).toFixed(0)}%</span>
                </div>
              </div>

              {/* Dynamic graph drawing */}
              <div className="relative h-44 bg-main-bg/80 border border-card-border rounded-xl p-4 overflow-hidden">
                <div className="absolute top-2 left-3 text-[10px] text-muted-text font-mono">PROJECTED COMPOUND CURVE</div>
                <svg className="w-full h-full" viewBox="0 0 500 180" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="calcGlow" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#3b6dcf" stopOpacity="0.3" />
                      <stop offset="100%" stopColor="#3b6dcf" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  <path
                    d={`${generateGraphPath()} L 500,180 L 0,180 Z`}
                    fill="url(#calcGlow)"
                    className="transition-all duration-300"
                  />
                  <path
                    d={generateGraphPath()}
                    fill="none"
                    stroke="#5b8def"
                    strokeWidth="3"
                    strokeLinecap="round"
                    className="transition-all duration-300"
                  />
                </svg>
              </div>

              <Link
                to={user ? "/dashboard" : "/register"}
                className="w-full py-3.5 bg-brand-500 hover:bg-brand-600 text-white rounded-xl text-center font-bold text-sm transition-colors flex items-center justify-center gap-2"
              >
                Launch Bot with Capital
                <ChevronRight className="w-4 h-4" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Security & Non-Custodial Banner */}
      <section className="max-w-[1400px] mx-auto px-6 py-16 border-t border-sidebar-border">
        <div className="bg-gradient-to-r from-brand-500/10 via-indigo-500/10 to-purple-500/10 border border-brand-500/20 rounded-3xl p-8 flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-4">
            <div className="p-3 rounded-2xl bg-brand-500/20 text-brand-400 border border-brand-500/30 shrink-0">
              <Shield className="w-8 h-8" />
            </div>
            <div>
              <h3 className="text-xl font-bold text-title-text">100% Non-Custodial & Wallet Encrypted</h3>
              <p className="text-xs text-muted-text mt-1 max-w-xl">
                Your private keys remain exclusively in your wallet context. Transactions execute with explicit user permissions, cryptographic signature verification, and fail-closed safety.
              </p>
            </div>
          </div>
          <Link
            to={user ? "/dashboard" : "/register"}
            className="px-6 py-3 bg-brand-500 hover:bg-brand-600 text-white font-bold rounded-xl text-sm whitespace-nowrap transition-colors shadow-lg shadow-brand-500/20"
          >
            Start Trading Securely
          </Link>
        </div>
      </section>

      {/* Contact Section */}
      <section id="contact" className="max-w-4xl mx-auto px-6 py-24 border-t border-sidebar-border">
        <div className="bg-card-bg border border-card-border rounded-3xl p-8 md:p-12 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-500/5 rounded-full filter blur-3xl pointer-events-none" />

          <div className="text-center max-w-xl mx-auto mb-10">
            <h2 className="text-2xl sm:text-3xl font-extrabold text-title-text">Have questions? Let's connect</h2>
            <p className="mt-3 text-sm text-muted-text">
              Need custom integrations or have inquiries about our algorithms? Send a message and our engineers will reply shortly.
            </p>
          </div>

          {contactSubmitted ? (
            <div className="bg-brand-500/10 border border-brand-500/20 text-brand-400 text-sm p-4 rounded-xl text-center font-semibold">
              Message submitted successfully! We will get back to you shortly.
            </div>
          ) : (
            <form onSubmit={handleContactSubmit} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-muted-text mb-1.5 font-bold">Name</label>
                  <input
                    type="text"
                    required
                    value={contactForm.name}
                    onChange={(e) => setContactForm({ ...contactForm, name: e.target.value })}
                    className="w-full px-4 py-2.5 bg-input-bg border border-card-border rounded-xl text-sm text-title-text placeholder-muted-text/60 focus:border-brand-500 focus:outline-none"
                    placeholder="John Doe"
                  />
                </div>
                <div>
                  <label className="block text-xs text-muted-text mb-1.5 font-bold">Email</label>
                  <input
                    type="email"
                    required
                    value={contactForm.email}
                    onChange={(e) => setContactForm({ ...contactForm, email: e.target.value })}
                    className="w-full px-4 py-2.5 bg-input-bg border border-card-border rounded-xl text-sm text-title-text placeholder-muted-text/60 focus:border-brand-500 focus:outline-none"
                    placeholder="john@example.com"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs text-muted-text mb-1.5 font-bold">Message</label>
                <textarea
                  required
                  rows={4}
                  value={contactForm.message}
                  onChange={(e) => setContactForm({ ...contactForm, message: e.target.value })}
                  className="w-full px-4 py-2.5 bg-input-bg border border-card-border rounded-xl text-sm text-title-text placeholder-muted-text/60 focus:border-brand-500 focus:outline-none resize-none"
                  placeholder="How can we help you?"
                />
              </div>
              <button
                type="submit"
                className="w-full py-3 bg-brand-500 hover:bg-brand-600 text-white rounded-xl font-bold text-sm transition-colors flex items-center justify-center gap-2 cursor-pointer shadow-lg shadow-brand-500/20"
              >
                Send Message
                <Mail className="w-4 h-4" />
              </button>
            </form>
          )}
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-main-bg border-t border-sidebar-border py-12">
        <div className="mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center">
              <img src="/logo.png" alt="AstroidBot Logo" className="w-8 h-8 object-contain" />
            </div>
            <div>
              <span className="font-bold text-title-text text-sm">AstroidBot</span>
              <span className="text-[10px] block text-muted-text font-mono -mt-1">© 2026. All rights reserved.</span>
            </div>
          </div>

          <div className="flex flex-wrap justify-center items-center gap-4 sm:gap-8 text-xs text-muted-text">
            <a href="#features" className="hover:text-title-text transition-colors">Features</a>
            <Link to="/tokens" className="hover:text-title-text transition-colors">Token Discovery</Link>
            <a href="#ai-assistant" className="hover:text-title-text transition-colors">AI Assistant</a>
            <a href="#calculator" className="hover:text-title-text transition-colors">Yield Calculator</a>
            <Link to="/docs" className="hover:text-title-text transition-colors">Docs</Link>
            <a href="/terms" className="hover:text-title-text transition-colors">Terms of Service</a>
            <a href="/privacy" className="hover:text-title-text transition-colors">Privacy Policy</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default Landing;
