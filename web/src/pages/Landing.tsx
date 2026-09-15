import React, { useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  Shield,
  Zap,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Mic,
  BarChart3,
  Flame,
  CheckCircle2,
  ShieldCheck,
  TrendingUp,
  Wallet,
  Clock,
  RefreshCw,
  Sliders,
  HelpCircle,
} from "lucide-react";
import { useAuth } from "../lib/auth";
import { AstroidMark } from "../components/Brand/AstroidMark";
import { AstroidBadge } from "../components/Brand/AstroidBadge";
import { AstroidSlider } from "../components/Controls/AstroidSlider";
import { AIIndicator } from "../components/AI/AIIndicator";

interface TradePreset {
  id: string;
  category: string;
  userPrompt: string;
  pair: string;
  chain: string;
  dex: string;
  condition: string;
  actionSummary: string;
  expectedBenefit: string;
}

export function Landing() {
  const { user } = useAuth();

  // Interactive AI Showcase Presets
  const tradePresets: TradePreset[] = [
    {
      id: "dip",
      category: "Dip Buyer",
      userPrompt: "Buy $200 of SOL if it dips under $220",
      pair: "SOL / USDC",
      chain: "Solana",
      dex: "Jupiter",
      condition: "Price drops to ≤ $220.00",
      actionSummary: "Automatically swaps 200 USDC for ~0.91 SOL",
      expectedBenefit: "Never miss a flash dip while you're offline",
    },
    {
      id: "profit",
      category: "Auto Take-Profit",
      userPrompt: "Sell 50% of my ETH when price gains 10%",
      pair: "ETH / USDC",
      chain: "Base",
      dex: "Uniswap V3",
      condition: "ETH price reaches +10.0% ($4,709.20)",
      actionSummary: "Secures profits into USDC at peak market price",
      expectedBenefit: "Locks in your earnings without emotional trading",
    },
    {
      id: "dca",
      category: "Weekly DCA",
      userPrompt: "Invest $50 into Bitcoin every Monday morning",
      pair: "BTC / USDC",
      chain: "Stacks / Bitcoin",
      dex: "Bitflow",
      condition: "Recurring schedule: Every Monday @ 09:00 UTC",
      actionSummary: "Buys $50 worth of BTC at best market rate",
      expectedBenefit: "Smooths out volatility and builds long-term wealth",
    },
    {
      id: "slippage",
      category: "Smart Swap",
      userPrompt: "Swap 500 USDC to STX with lowest gas fees",
      pair: "STX / USDC",
      chain: "Stacks",
      dex: "ALEX + Bitflow Multi-Hop",
      condition: "Optimal routing with <0.3% price impact",
      actionSummary: "Routes through deep liquidity pools automatically",
      expectedBenefit: "Guaranteed best execution so you don't overpay",
    },
  ];

  const [activePreset, setActivePreset] = useState<TradePreset>(tradePresets[0]);
  const [demoExecuted, setDemoExecuted] = useState(false);

  // DCA & Growth Simulator State
  const [selectedAsset, setSelectedAsset] = useState<"BTC" | "ETH" | "SOL" | "STX">("SOL");
  const [weeklyAmount, setWeeklyAmount] = useState<number>(50);
  const [timeHorizonWeeks, setTimeHorizonWeeks] = useState<number>(26);

  // Growth rates (conservative realistic annual historical benchmarks)
  const annualRates: Record<string, number> = {
    BTC: 0.45,
    ETH: 0.52,
    SOL: 0.65,
    STX: 0.58,
  };

  const currentRate = annualRates[selectedAsset];
  const totalWeeks = timeHorizonWeeks;
  const totalInvested = weeklyAmount * totalWeeks;
  const weeklyRate = currentRate / 52;
  const projectedValue =
    weeklyAmount * ((Math.pow(1 + weeklyRate, totalWeeks) - 1) / weeklyRate);
  const projectedProfit = Math.max(0, projectedValue - totalInvested);

  // FAQ State
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  const faqs = [
    {
      question: "Does AstroidBot ever hold my funds?",
      answer:
        "Never. AstroidBot is 100% non-custodial. Your crypto stays safely in your own wallet (Phantom, MetaMask, Leather, etc.). AstroidBot only requests your signature to execute trades when your exact conditions are met.",
    },
    {
      question: "Do I need trading experience or coding skills?",
      answer:
        "None at all. AstroidBot was built specifically for everyday crypto enthusiasts. You simply type or speak what you want to achieve in plain English, and AstroidBot figures out the routing, pricing, and timing for you.",
    },
    {
      question: "Which blockchains and tokens can I trade?",
      answer:
        "AstroidBot connects directly to major decentralized liquidity pools across Solana (Jupiter), Base (Uniswap V3), Stacks (Bitflow, ALEX, Velar), and Ethereum EVM. You can trade thousands of verified tokens with zero bridging friction.",
    },
    {
      question: "Can I cancel or pause an automated order at any time?",
      answer:
        "Yes, immediately with one click. Since your funds are always in your own wallet, you remain in complete control 24/7. Cancelling a scheduled order costs zero fees.",
    },
    {
      question: "Is it free to start using AstroidBot?",
      answer:
        "Yes! Getting started, exploring market tokens, and setting up your first automated strategies is completely free. We charge no subscription fees for basic trading.",
    },
  ];

  const handleExecuteDemo = () => {
    setDemoExecuted(true);
    setTimeout(() => setDemoExecuted(false), 3000);
  };

  return (
    <div className="min-h-screen bg-main-bg text-main-text selection:bg-brand-500/30 overflow-x-hidden font-sans">
      {/* Header / Navigation */}
      <header className="sticky top-0 z-50 backdrop-blur-md bg-main-bg/90 border-b border-sidebar-border">
        <div className="mx-auto px-6 h-16 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-[#4B4032]/40 border border-[#DEA34F]/30 flex items-center justify-center shrink-0">
              <AstroidMark className="w-5 h-5 text-brand-400" />
            </div>
            <div>
              <span className="font-bold text-title-text text-lg tracking-tight">AstroidBot</span>
              <span className="text-[10px] block text-brand-400 font-mono tracking-wider -mt-1 uppercase">
                AI Trading
              </span>
            </div>
          </Link>

          <nav className="hidden md:flex items-center gap-8 text-sm text-muted-text font-medium">
            <a href="#how-it-works" className="hover:text-title-text transition-colors">
              How It Works
            </a>
            <a href="#benefits" className="hover:text-title-text transition-colors">
              Why AstroidBot
            </a>
            <Link to="/tokens" className="hover:text-title-text transition-colors flex items-center gap-1.5">
              <span>Token Radar</span>
              <span className="px-1.5 py-0.2 text-[9px] font-bold rounded bg-[#4B4032] text-brand-400 border border-[#DEA34F]/30">
                Live
              </span>
            </Link>
            <a href="#simulator" className="hover:text-title-text transition-colors">
              DCA Calculator
            </a>
            <a href="#faq" className="hover:text-title-text transition-colors">
              FAQ
            </a>
            <Link to="/docs" className="hover:text-title-text transition-colors">
              Docs
            </Link>
          </nav>

          <div className="flex items-center gap-3">
            {user ? (
              <Link
                to="/dashboard"
                className="flex items-center gap-1.5 px-4 py-2 bg-brand-500 hover:bg-brand-600 text-[#1A1B1E] rounded-lg text-sm font-semibold transition-all duration-200"
              >
                Dashboard
                <ArrowRight className="w-4 h-4" />
              </Link>
            ) : (
              <>
                <Link
                  to="/login"
                  className="text-sm font-medium text-muted-text hover:text-title-text transition-colors px-3 py-1.5 hidden sm:inline-block"
                >
                  Sign In
                </Link>
                <Link
                  to="/register"
                  className="flex items-center gap-1.5 px-4 py-2 bg-brand-500 hover:bg-brand-600 text-[#1A1B1E] rounded-lg text-sm font-semibold transition-all duration-200"
                >
                  Start Free
                  <ArrowRight className="w-4 h-4" />
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative mx-auto px-6 pt-16 pb-20 text-center overflow-hidden">
        {/* Technical Grid Overlay */}
        <div
          className="absolute inset-0 opacity-[0.03] pointer-events-none"
          style={{
            backgroundImage: `linear-gradient(to right, #FCFCFC 1px, transparent 1px), linear-gradient(to bottom, #FCFCFC 1px, transparent 1px)`,
            backgroundSize: "40px 40px",
          }}
        />

        <div className="relative z-10 max-w-4xl mx-auto">

          {/* Main Hero Title */}
          <h1 className="text-4xl sm:text-6xl md:text-7xl font-extrabold text-title-text tracking-tight leading-[1.12]">
            Crypto Trading Made as{" "}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#E6BF85] via-[#DEA34F] to-[#EB9100]">
              Simple as Talking.
            </span>
          </h1>

          {/* Subtitle */}
          <p className="mt-6 text-base sm:text-xl text-muted-text max-w-2xl mx-auto leading-relaxed">
            Tell AstroidBot what you want to buy, sell, or automate in plain English. We monitor every major chain to secure best prices, protect your profits 24/7, and execute safely from your own wallet.
          </p>

          {/* Hero CTAs */}
          <div className="mt-8 flex flex-wrap justify-center gap-3 sm:gap-4">
            <Link
              to={user ? "/dashboard" : "/register"}
              className="px-6 py-3.5 bg-brand-500 hover:bg-brand-600 text-[#1A1B1E] font-bold rounded-xl text-sm sm:text-base transition-all duration-200 flex items-center gap-2 hover:translate-x-0.5"
            >
              Start Trading Free
              <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              to="/tokens"
              className="px-6 py-3.5 bg-[#262729] hover:bg-[#2D2B2B] border border-[#3A393B] text-title-text font-semibold rounded-xl text-sm sm:text-base transition-all duration-200 flex items-center gap-2"
            >
              <BarChart3 className="w-4 h-4 text-brand-400" />
              Explore Live Markets
            </Link>
          </div>

          {/* Interactive "Talk to AstroidBot" Card */}
          <div className="mt-14 max-w-3xl mx-auto rounded-2xl border border-card-border bg-[#262729] p-5 sm:p-6 text-left shadow-2xl">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-4 border-b border-card-border">
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full bg-[#00E676] animate-pulse" />
                <span className="font-mono text-xs font-bold text-title-text uppercase tracking-wider">
                  Interactive Live Demo
                </span>
              </div>
              <AIIndicator state="active" showIconContainer={false} />
            </div>

            {/* Prompt presets selector */}
            <div className="mt-4">
              <span className="text-xs font-semibold text-muted-text uppercase tracking-wider block mb-2">
                Click a sample trade to see how AstroidBot works:
              </span>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {tradePresets.map((preset) => (
                  <button
                    key={preset.id}
                    onClick={() => setActivePreset(preset)}
                    className={`px-3 py-2 rounded-lg text-xs font-semibold border transition-all cursor-pointer text-center ${
                      activePreset.id === preset.id
                        ? "bg-[#4B4032] border-[#DEA34F] text-[#DEA34F]"
                        : "bg-[#1A1B1E] border-card-border text-muted-text hover:text-title-text hover:border-card-border/80"
                    }`}
                  >
                    {preset.category}
                  </button>
                ))}
              </div>
            </div>

            {/* Simulated Voice/Chat Input */}
            <div className="mt-4 p-3.5 rounded-xl bg-[#1A1B1E] border border-card-border flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-[#4B4032] text-[#DEA34F] flex items-center justify-center shrink-0">
                <Mic className="w-4 h-4 animate-pulse" />
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-[10px] uppercase font-mono font-bold text-brand-400 block leading-none mb-1">
                  You Say or Type:
                </span>
                <p className="text-sm sm:text-base font-medium text-title-text truncate">
                  &quot;{activePreset.userPrompt}&quot;
                </p>
              </div>
            </div>

            {/* AstroidBot Parsed Execution Card */}
            <div className="mt-4 p-4 rounded-xl bg-[#1A1B1E]/60 border border-card-border space-y-3">
              <div className="flex items-center justify-between text-xs font-mono">
                <span className="text-muted-text uppercase">AstroidBot Smart Understanding:</span>
                <span className="text-[#00E676] font-semibold flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Ready to Execute
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1 text-xs">
                <div className="p-2.5 rounded-lg bg-[#262729] border border-card-border">
                  <span className="text-[10px] text-muted-text uppercase block font-mono">Trading Pair</span>
                  <span className="font-bold text-title-text mt-0.5 block">{activePreset.pair}</span>
                  <span className="text-[10px] text-brand-400">{activePreset.chain}</span>
                </div>
                <div className="p-2.5 rounded-lg bg-[#262729] border border-card-border">
                  <span className="text-[10px] text-muted-text uppercase block font-mono">Best Route DEX</span>
                  <span className="font-bold text-title-text mt-0.5 block">{activePreset.dex}</span>
                  <span className="text-[10px] text-[#00E676]">Zero deposit needed</span>
                </div>
                <div className="p-2.5 rounded-lg bg-[#262729] border border-card-border">
                  <span className="text-[10px] text-muted-text uppercase block font-mono">Execution Trigger</span>
                  <span className="font-bold text-title-text mt-0.5 block truncate">{activePreset.condition}</span>
                  <span className="text-[10px] text-muted-text">24/7 Auto Monitoring</span>
                </div>
              </div>

              <div className="pt-2 flex flex-col sm:flex-row items-center justify-between gap-3">
                <p className="text-xs text-muted-text">
                  <span className="text-title-text font-semibold">Outcome: </span>
                  {activePreset.actionSummary} — {activePreset.expectedBenefit}.
                </p>

                <button
                  onClick={handleExecuteDemo}
                  className={`w-full sm:w-auto px-4 py-2 rounded-lg text-xs font-bold transition-all cursor-pointer shrink-0 ${
                    demoExecuted
                      ? "bg-[#00E676] text-[#1A1B1E]"
                      : "bg-[#DEA34F] hover:bg-[#EB9100] text-[#1A1B1E]"
                  }`}
                >
                  {demoExecuted ? "✓ Order Confirmed (Demo)" : "Simulate One-Click Trade"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Trust & Social Proof Strip */}
      <section className="bg-[#262729]/40 border-y border-sidebar-border py-8">
        <div className="max-w-5xl mx-auto px-6 grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
          <div>
            <div className="text-2xl sm:text-3xl font-black text-title-text font-mono">$48.6M+</div>
            <div className="text-xs text-muted-text font-medium mt-1">Total Volume Tracked</div>
          </div>
          <div>
            <div className="text-2xl sm:text-3xl font-black text-title-text font-mono">14,200+</div>
            <div className="text-xs text-muted-text font-medium mt-1">DEX Liquidity Pairs</div>
          </div>
          <div>
            <div className="text-2xl sm:text-3xl font-black text-brand-400 font-mono">Multichain</div>
            <div className="text-xs text-muted-text font-medium mt-1">Solana, Base, Stacks, EVM</div>
          </div>
          <div>
            <div className="text-2xl sm:text-3xl font-black text-[#00E676] font-mono">100% Non-Custodial</div>
            <div className="text-xs text-muted-text font-medium mt-1">Zero Deposit Risk</div>
          </div>
        </div>
      </section>

      {/* How It Works (Simple 3 Steps for Everyday Users) */}
      <section id="how-it-works" className="max-w-5xl mx-auto px-6 py-24 border-t border-sidebar-border">
        <div className="text-center max-w-2xl mx-auto mb-16">
          <AstroidBadge label="Simple Process" variant="amber" />
          <h2 className="text-3xl sm:text-4xl font-extrabold text-title-text mt-3">
            Trading in 3 Effortless Steps
          </h2>
          <p className="mt-3 text-muted-text text-sm sm:text-base">
            Forget switching between five different exchanges, managing gas settings, or deciphering complicated charts.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-[#262729] border border-card-border p-7 rounded-2xl">
            <div className="w-10 h-10 rounded-xl bg-[#4B4032] flex items-center justify-center text-brand-400 font-mono font-bold text-sm mb-5">
              01
            </div>
            <h3 className="text-lg font-bold text-title-text mb-2">Connect Your Wallet</h3>
            <p className="text-muted-text text-xs leading-relaxed">
              Connect Phantom, Leather, or MetaMask in one click. We never hold your coins or charge deposit fees. Your money stays in your hands.
            </p>
          </div>

          <div className="bg-[#262729] border border-card-border p-7 rounded-2xl">
            <div className="w-10 h-10 rounded-xl bg-[#4B4032] flex items-center justify-center text-brand-400 font-mono font-bold text-sm mb-5">
              02
            </div>
            <h3 className="text-lg font-bold text-title-text mb-2">Say What You Want</h3>
            <p className="text-muted-text text-xs leading-relaxed">
              Speak or type in plain language: &quot;Buy SOL if it drops 5%&quot; or &quot;Invest $50 in Bitcoin every week&quot;. AstroidBot handles the rest.
            </p>
          </div>

          <div className="bg-[#262729] border border-card-border p-7 rounded-2xl">
            <div className="w-10 h-10 rounded-xl bg-[#4B4032] flex items-center justify-center text-brand-400 font-mono font-bold text-sm mb-5">
              03
            </div>
            <h3 className="text-lg font-bold text-title-text mb-2">Automate & Relax</h3>
            <p className="text-muted-text text-xs leading-relaxed">
              AstroidBot scans multiple decentralized exchanges 24/7 to lock in best prices, execute trades instantly, and protect your profits while you sleep.
            </p>
          </div>
        </div>
      </section>

      {/* Why Everyday Traders Choose AstroidBot (Core Benefits) */}
      <section id="benefits" className="max-w-5xl mx-auto px-6 py-24 border-t border-sidebar-border">
        <div className="text-center max-w-2xl mx-auto mb-16">
          <AstroidBadge label="Built For Real Traders" variant="amber" />
          <h2 className="text-3xl sm:text-4xl font-extrabold text-title-text mt-3">
            Why Everyday Traders Choose Astroid
          </h2>
          <p className="mt-3 text-muted-text text-sm sm:text-base">
            Professional trading superpowers without the steep learning curve.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-[#262729] border border-card-border p-6 rounded-2xl flex items-start gap-4">
            <div className="w-10 h-10 rounded-xl bg-[#4B4032] flex items-center justify-center text-brand-400 shrink-0 mt-0.5">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-title-text mb-1">Best Price on Every Trade</h3>
              <p className="text-muted-text text-xs leading-relaxed">
                AstroidBot automatically checks prices across Jupiter, Uniswap, Bitflow, and ALEX so you never overpay for swaps or get crushed by bad slippage.
              </p>
            </div>
          </div>

          <div className="bg-[#262729] border border-card-border p-6 rounded-2xl flex items-start gap-4">
            <div className="w-10 h-10 rounded-xl bg-[#4B4032] flex items-center justify-center text-brand-400 shrink-0 mt-0.5">
              <Clock className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-title-text mb-1">Never Stare at Charts Again</h3>
              <p className="text-muted-text text-xs leading-relaxed">
                Set your buy triggers once and live your life. AstroidBot monitors the charts around the clock and executes automatically when targets are hit.
              </p>
            </div>
          </div>

          <div className="bg-[#262729] border border-card-border p-6 rounded-2xl flex items-start gap-4">
            <div className="w-10 h-10 rounded-xl bg-[#4B4032] flex items-center justify-center text-brand-400 shrink-0 mt-0.5">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-title-text mb-1">100% Non-Custodial Safety</h3>
              <p className="text-muted-text text-xs leading-relaxed">
                You never deposit money into our platform. Your assets stay safely in your private wallet until the exact second a trade executes.
              </p>
            </div>
          </div>

          <div className="bg-[#262729] border border-card-border p-6 rounded-2xl flex items-start gap-4">
            <div className="w-10 h-10 rounded-xl bg-[#4B4032] flex items-center justify-center text-brand-400 shrink-0 mt-0.5">
              <TrendingUp className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-title-text mb-1">Automatic Profit & Stop-Loss Protection</h3>
              <p className="text-muted-text text-xs leading-relaxed">
                Lock in your profits at target levels and protect your portfolio against sudden flash crashes with automatic safety triggers.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Supported Chains Section */}
      <section className="max-w-5xl mx-auto px-6 py-16 border-t border-sidebar-border text-center">
        <span className="text-xs uppercase text-muted-text tracking-wider font-mono font-bold block mb-6">
          Trade Seamlessly Across Top Blockchains
        </span>
        <div className="flex flex-wrap justify-center items-center gap-4 sm:gap-6">
          <div className="flex items-center gap-2.5 bg-[#262729] px-4 py-2.5 rounded-xl border border-card-border">
            <span className="font-bold text-sm text-title-text font-mono">SOLANA</span>
            <span className="text-[10px] px-2 py-0.5 rounded bg-[#4B4032] text-brand-400 font-bold">Jupiter</span>
          </div>
          <div className="flex items-center gap-2.5 bg-[#262729] px-4 py-2.5 rounded-xl border border-card-border">
            <span className="font-bold text-sm text-title-text font-mono">BASE</span>
            <span className="text-[10px] px-2 py-0.5 rounded bg-[#4B4032] text-brand-400 font-bold">Uniswap V3</span>
          </div>
          <div className="flex items-center gap-2.5 bg-[#262729] px-4 py-2.5 rounded-xl border border-card-border">
            <span className="font-bold text-sm text-title-text font-mono">STACKS</span>
            <span className="text-[10px] px-2 py-0.5 rounded bg-[#4B4032] text-brand-400 font-bold">Bitflow · ALEX</span>
          </div>
          <div className="flex items-center gap-2.5 bg-[#262729] px-4 py-2.5 rounded-xl border border-card-border">
            <span className="font-bold text-sm text-title-text font-mono">ETHEREUM & EVM</span>
            <span className="text-[10px] px-2 py-0.5 rounded bg-[#4B4032] text-brand-400 font-bold">Multi-DEX</span>
          </div>
        </div>
      </section>

      {/* Streamlined DCA & Growth Calculator */}
      <section id="simulator" className="max-w-5xl mx-auto px-6 py-24 border-t border-sidebar-border">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 items-center">
          <div>
            <h2 className="text-3xl sm:text-4xl font-extrabold text-title-text mt-3">
              See How Automatic DCA Builds Wealth
            </h2>
            <p className="mt-3 text-muted-text text-sm sm:text-base leading-relaxed">
              Dollar-cost averaging removes emotion from trading. Pick your weekly amount and see how regular automated accumulation compounds over time.
            </p>

            <div className="mt-8 space-y-6">
              {/* Asset Selector */}
              <div>
                <label className="block text-xs text-muted-text font-bold mb-2 uppercase font-mono">
                  Select Target Token
                </label>
                <div className="grid grid-cols-4 gap-2">
                  {(["SOL", "BTC", "ETH", "STX"] as const).map((a) => (
                    <button
                      key={a}
                      onClick={() => setSelectedAsset(a)}
                      className={`py-2 px-3 rounded-lg text-xs font-bold border transition-all cursor-pointer ${
                        selectedAsset === a
                          ? "bg-[#4B4032] border-[#DEA34F] text-[#DEA34F]"
                          : "bg-[#262729] border-card-border text-muted-text hover:text-title-text"
                      }`}
                    >
                      {a}
                    </button>
                  ))}
                </div>
              </div>

              {/* Weekly Slider */}
              <div>
                <div className="flex justify-between text-sm mb-2">
                  <span className="text-muted-text font-medium">Weekly Investment</span>
                  <span className="text-brand-400 font-bold font-mono text-base">
                    ${weeklyAmount} / week
                  </span>
                </div>
                <AstroidSlider
                  min={10}
                  max={500}
                  step={10}
                  value={weeklyAmount}
                  onChange={setWeeklyAmount}
                  className="py-1"
                />
              </div>

              {/* Time Horizon Selector */}
              <div>
                <label className="block text-xs text-muted-text font-bold mb-2 uppercase font-mono">
                  Time Horizon
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { label: "3 Months", weeks: 12 },
                    { label: "6 Months", weeks: 26 },
                    { label: "1 Year", weeks: 52 },
                  ].map((h) => (
                    <button
                      key={h.weeks}
                      onClick={() => setTimeHorizonWeeks(h.weeks)}
                      className={`py-2 px-3 rounded-lg text-xs font-bold border transition-all cursor-pointer ${
                        timeHorizonWeeks === h.weeks
                          ? "bg-[#4B4032] border-[#DEA34F] text-[#DEA34F]"
                          : "bg-[#262729] border-card-border text-muted-text hover:text-title-text"
                      }`}
                    >
                      {h.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Calculator Output Display */}
          <div className="bg-[#262729] border border-card-border rounded-2xl p-6 sm:p-8 space-y-6">
            <div className="flex justify-between items-baseline">
              <div>
                <span className="text-xs text-muted-text uppercase font-mono block">Projected Portfolio</span>
                <div className="text-3xl sm:text-4xl font-black text-title-text mt-1 font-mono">
                  ${projectedValue.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                </div>
              </div>
              <div className="text-right">
                <span className="text-xs text-muted-text uppercase font-mono block">Projected Growth</span>
                <span className="text-lg font-bold text-[#00E676] font-mono">
                  +${projectedProfit.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 py-3 border-y border-card-border text-xs">
              <div>
                <span className="text-muted-text block">Total Contributed</span>
                <span className="font-bold text-title-text font-mono mt-0.5 block">
                  ${totalInvested.toLocaleString()}
                </span>
              </div>
              <div>
                <span className="text-muted-text block">Historical Benchmark</span>
                <span className="font-bold text-brand-400 font-mono mt-0.5 block">
                  ~{(currentRate * 100).toFixed(0)}% Annualized
                </span>
              </div>
            </div>

            {/* Visual Curve Preview */}
            <div className="relative h-32 bg-[#1A1B1E] border border-card-border rounded-xl p-3 overflow-hidden">
              <span className="text-[10px] text-muted-text font-mono block">SIMULATED WEALTH TRAJECTORY</span>
              <svg className="w-full h-24 mt-1" viewBox="0 0 400 100" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="dcaGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#DEA34F" stopOpacity="0.25" />
                    <stop offset="100%" stopColor="#DEA34F" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path
                  d="M 0,90 Q 150,85 250,50 T 400,10 L 400,100 L 0,100 Z"
                  fill="url(#dcaGrad)"
                />
                <path
                  d="M 0,90 Q 150,85 250,50 T 400,10"
                  fill="none"
                  stroke="#DEA34F"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                />
              </svg>
            </div>

            <Link
              to={user ? "/dashboard" : "/register"}
              className="w-full py-3 bg-brand-500 hover:bg-brand-600 text-[#1A1B1E] rounded-xl text-center font-bold text-sm transition-colors flex items-center justify-center gap-2"
            >
              Start Automated DCA
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </section>

      {/* Frequently Asked Questions */}
      <section id="faq" className="max-w-4xl mx-auto px-6 py-24 border-t border-sidebar-border">
        <div className="text-center max-w-2xl mx-auto mb-14">
          <AstroidBadge label="Common Questions" variant="amber" />
          <h2 className="text-3xl sm:text-4xl font-extrabold text-title-text mt-3">
            Frequently Asked Questions
          </h2>
          <p className="mt-3 text-muted-text text-sm">
            Everything you need to know about trading safely with AstroidBot.
          </p>
        </div>

        <div className="space-y-3">
          {faqs.map((faq, idx) => {
            const isOpen = openFaq === idx;
            return (
              <div
                key={idx}
                className="bg-[#262729] border border-card-border rounded-xl overflow-hidden transition-colors"
              >
                <button
                  onClick={() => setOpenFaq(isOpen ? null : idx)}
                  className="w-full px-5 py-4 text-left flex items-center justify-between gap-4 cursor-pointer focus:outline-none"
                >
                  <span className="text-sm sm:text-base font-bold text-title-text">{faq.question}</span>
                  {isOpen ? (
                    <ChevronUp className="w-4 h-4 text-brand-400 shrink-0" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-muted-text shrink-0" />
                  )}
                </button>
                {isOpen && (
                  <div className="px-5 pb-5 pt-1 text-xs sm:text-sm text-muted-text leading-relaxed border-t border-card-border/50">
                    {faq.answer}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Final Call to Action Banner */}
      <section className="max-w-5xl mx-auto px-6 pb-24">
        <div className="bg-[#262729] border border-card-border rounded-3xl p-8 sm:p-12 text-center relative overflow-hidden">
          <div className="relative z-10 max-w-2xl mx-auto">
            <h2 className="text-3xl sm:text-4xl font-extrabold text-title-text tracking-tight">
              Ready to Trade Without the Headache?
            </h2>
            <p className="mt-3 text-sm sm:text-base text-muted-text">
              Join thousands of everyday crypto traders who let AstroidBot handle the complex execution. Zero deposit risk. 100% self-custody.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <Link
                to={user ? "/dashboard" : "/register"}
                className="px-8 py-3.5 bg-brand-500 hover:bg-brand-600 text-[#1A1B1E] font-bold rounded-xl text-sm sm:text-base transition-all duration-200 shadow-lg shadow-brand-500/20"
              >
                Launch AstroidBot Free
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="w-full bg-main-bg border-t border-sidebar-border text-main-text py-12">
        <div className="max-w-5xl mx-auto px-6">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-6">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-[#4B4032]/40 border border-[#DEA34F]/30 flex items-center justify-center shrink-0">
                <AstroidMark className="w-5 h-5 text-brand-400" />
              </div>
              <div>
                <span className="font-extrabold text-title-text text-base tracking-tight block">AstroidBot</span>
                <span className="text-[10px] text-muted-text font-mono">Intelligent DEX Trading Platform</span>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-6 text-xs text-muted-text font-medium">
              <a href="#how-it-works" className="hover:text-title-text transition-colors">
                How It Works
              </a>
              <a href="#benefits" className="hover:text-title-text transition-colors">
                Benefits
              </a>
              <Link to="/tokens" className="hover:text-title-text transition-colors">
                Token Discovery
              </Link>
              <Link to="/docs" className="hover:text-title-text transition-colors">
                Documentation
              </Link>
              <Link to="/login" className="hover:text-title-text transition-colors">
                Sign In
              </Link>
            </div>
          </div>

          <div className="mt-8 pt-6 border-t border-card-border flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-muted-text">
            <span>© 2026 AstroidBot. All rights reserved. Self-custodial trading protocol.</span>
            <div className="flex items-center gap-4">
              <a href="#faq" className="hover:text-title-text transition-colors">
                FAQ
              </a>
              <Link to="/docs" className="hover:text-title-text transition-colors">
                Security & Privacy
              </Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default Landing;
