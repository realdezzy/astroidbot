import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import {
  Bot,
  ArrowRight,
  TrendingUp,
  Shield,
  Zap,
  Lock,
  Check,
  Wallet,
  Activity,
  RefreshCw,
  Mail,
  ChevronRight,
  Sparkles,
  Sun,
  Moon,
} from "lucide-react";
import { useAuth } from "../lib/auth";

export function Landing() {
  const { user } = useAuth();
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
        return 0.12;
      case "moderate":
        return 0.28;
      case "aggressive":
        return 0.58;
    }
  };

  const apy = getAPY();
  const estimatedProfit = investment * (Math.pow(1 + apy / 365, days) - 1);
  const projectedTotal = investment + estimatedProfit;

  // Generate SVG path points for the profit calculator graph
  const generateGraphPath = () => {
    const width = 500;
    const height = 180;
    const pointsCount = 10;
    const points: string[] = [];

    for (let i = 0; i <= pointsCount; i++) {
      const x = (i / pointsCount) * width;
      const progress = i / pointsCount;
      // Growth function + volatility sine wave
      const growth = investment * (Math.pow(1 + apy / 365, (days * progress)) - investment) / (projectedTotal - investment || 1);
      const volatility = Math.sin(progress * Math.PI * 3) * 15 * (1 - progress);
      const y = height - 30 - (growth * (height - 60)) + volatility;
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
      <div className="absolute top-0 left-1/4 w-96 h-96 bg-brand-500/10 rounded-full filter blur-[120px] pointer-events-none" />
      <div className="absolute top-[800px] right-1/4 w-[500px] h-[500px] bg-indigo-500/5 rounded-full filter blur-[160px] pointer-events-none" />
      <div className="absolute top-[1800px] left-1/3 w-[600px] h-[600px] bg-brand-600/5 rounded-full filter blur-[180px] pointer-events-none" />

      {/* Header / Navigation */}
      <header className="sticky top-0 z-50 backdrop-blur-md bg-main-bg/80 border-b border-sidebar-border">
        <div className="mx-auto px-6 h-16 flex items-center">
          <a href="/" className="flex-1 flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0">
              <img src="/logo.png" alt="AstroidBot Logo" className="w-9 h-9 object-contain" />
            </div>
            <div className="shrink-0">
              <span className="font-bold text-title-text text-lg tracking-tight">AstroidBot</span>
              <span className="text-xs block text-muted-text -mt-1 font-mono">AI TRADING</span>
            </div>
          </a>

          <nav className="hidden md:flex items-center gap-8 text-sm text-muted-text font-medium">
            <a href="#features" className="hover:text-title-text transition-colors">Features</a>
            <a href="#calculator" className="hover:text-title-text transition-colors">Calculator</a>
            <a href="#integrations" className="hover:text-title-text transition-colors">Integrations</a>
            <Link to="/docs" className="hover:text-title-text transition-colors">Docs</Link>
            <a href="#contact" className="hover:text-title-text transition-colors">Contact</a>
          </nav>

          <div className="flex-1 flex items-center justify-end gap-4">
            <button
              onClick={toggleTheme}
              className="p-2 text-muted-text hover:text-title-text rounded-lg bg-bg-hover hover:bg-input-bg transition-colors cursor-pointer"
            >
              {theme === "dark" ? <Sun className="w-4 h-4 text-yellow-400" /> : <Moon className="w-4 h-4 text-indigo-500" />}
            </button>
            {user ? (
              <Link
                to="/dashboard"
                className="flex items-center gap-2 px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white rounded-lg text-sm font-medium transition-all duration-200 shadow-lg shadow-brand-500/20"
              >
                Go to Dashboard
                <ArrowRight className="w-4 h-4" />
              </Link>
            ) : (
              <>
                <Link
                  to="/login"
                  className="text-sm font-medium text-muted-text hover:text-title-text transition-colors px-2 py-1"
                >
                  Sign In
                </Link>
                <Link
                  to="/register"
                  className="px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white rounded-lg text-sm font-medium transition-all duration-200 shadow-lg shadow-brand-500/20"
                >
                  Get Started
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative mx-auto px-6 pt-20 pb-28 text-center">

        <h1 className="text-4xl sm:text-6xl font-black text-title-text tracking-tight leading-tight max-w-4xl mx-auto">
          AstroidBot: The <span className="text-transparent bg-clip-text bg-gradient-to-r from-brand-400 via-indigo-400 to-indigo-500">smart trading bot</span> for Stacks
        </h1>

        <p className="mt-6 text-lg text-muted-text max-w-2xl mx-auto leading-relaxed">
          Automate your trading strategy, optimize order placement, and compound yield non-custodially using advanced algorithmic grid engines.
        </p>

        <div className="mt-10 flex flex-wrap justify-center gap-4">
          <Link
            to={user ? "/dashboard" : "/register"}
            className="px-8 py-4 bg-brand-500 hover:bg-brand-600 text-white font-medium rounded-xl text-base transition-all duration-200 shadow-xl shadow-brand-500/30 flex items-center gap-2 hover:translate-x-0.5"
          >
            Launch Trading Bot
            <ArrowRight className="w-5 h-5" />
          </Link>
          <a
            href="#features"
            className="px-8 py-4 bg-card-bg hover:bg-bg-hover border border-card-border hover:border-brand-500/30 text-main-text font-medium rounded-xl text-base transition-all duration-200"
          >
            Explore Features
          </a>
        </div>

        {/* Dashboard Showcase */}
        <div className="mt-20 relative max-w-5xl mx-auto rounded-2xl border border-card-border bg-card-bg p-4 backdrop-blur-sm shadow-2xl">
          <div className="absolute -inset-0.5 bg-gradient-to-r from-brand-500 to-indigo-500 rounded-2xl opacity-10 filter blur-xl pointer-events-none" />

          {/* Top panel bar */}
          <div className="flex items-center justify-between pb-3 border-b border-card-border mb-4 px-2">
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-red-500/80" />
              <span className="w-3 h-3 rounded-full bg-yellow-500/80" />
              <span className="w-3 h-3 rounded-full bg-green-500/80" />
              <span className="text-xs text-muted-text ml-2 font-mono">Astroidbot-dashboard</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs font-mono px-2 py-0.5 rounded bg-brand-500/20 text-brand-400 border border-brand-500/20">
                STX: $1.85
              </span>
              <span className="text-xs text-muted-text font-mono">Connected: SP1P...4R8S</span>
            </div>
          </div>

          {/* Interactive Interface Simulation */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-left">
            {/* Sidebar Simulation */}
            <div className="hidden md:block col-span-1 border-r border-card-border pr-4 space-y-2">
              <div className="flex items-center gap-2.5 px-3 py-2 bg-brand-500/15 text-brand-400 rounded-lg text-xs font-semibold">
                <Activity className="w-4 h-4" />
                <span>Dashboard</span>
              </div>
              <div className="flex items-center gap-2.5 px-3 py-2 text-muted-text hover:text-title-text rounded-lg text-xs font-medium cursor-pointer transition-colors">
                <TrendingUp className="w-4 h-4" />
                <span>Trades</span>
              </div>
              <div className="flex items-center gap-2.5 px-3 py-2 text-muted-text hover:text-title-text rounded-lg text-xs font-medium cursor-pointer transition-colors">
                <Wallet className="w-4 h-4" />
                <span>Wallets</span>
              </div>
              <div className="flex items-center gap-2.5 px-3 py-2 text-muted-text hover:text-title-text rounded-lg text-xs font-medium cursor-pointer transition-colors">
                <Bot className="w-4 h-4" />
                <span>Agents</span>
              </div>
            </div>

            {/* Main Content Area Simulation */}
            <div className="col-span-1 md:col-span-3 space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-main-bg/80 border border-card-border rounded-xl p-3">
                  <div className="text-[10px] text-muted-text uppercase font-semibold">Portfolio Value</div>
                  <div className="text-lg font-bold text-title-text mt-0.5">$18,452.20</div>
                  <div className="text-[10px] text-emerald-400 mt-1 flex items-center gap-0.5">
                    <span>↑ 14.2%</span> <span className="text-muted-text/80">this week</span>
                  </div>
                </div>
                <div className="bg-main-bg/80 border border-card-border rounded-xl p-3">
                  <div className="text-[10px] text-muted-text uppercase font-semibold">Bot Status</div>
                  <div className="text-lg font-bold text-emerald-400 mt-0.5 flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping" />
                    <span>ACTIVE</span>
                  </div>
                  <div className="text-[10px] text-muted-text mt-1">Grid mode enabled</div>
                </div>
                <div className="bg-main-bg/80 border border-card-border rounded-xl p-3">
                  <div className="text-[10px] text-muted-text uppercase font-semibold">Total Profit</div>
                  <div className="text-lg font-bold text-title-text mt-0.5">+$3,412.80</div>
                  <div className="text-[10px] text-muted-text mt-1">45 trades executed</div>
                </div>
              </div>

              {/* Graphic Chart Simulation */}
              <div className="bg-main-bg/80 border border-card-border rounded-xl p-4 relative overflow-hidden h-44">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-xs font-semibold text-muted-text">Yield Progression (30d)</span>
                  <span className="text-[10px] text-brand-400 font-mono">Auto-refreshes in 4s</span>
                </div>
                <svg className="w-full h-28" viewBox="0 0 500 100" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="glowGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#5b8def" stopOpacity="0.4" />
                      <stop offset="100%" stopColor="#5b8def" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  <path
                    d="M0,80 Q 80,60 160,75 T 320,35 T 500,15 L 500,100 L 0,100 Z"
                    fill="url(#glowGrad)"
                  />
                  <path
                    d="M0,80 Q 80,60 160,75 T 320,35 T 500,15"
                    fill="none"
                    stroke="#5b8def"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  />
                  {/* Grid lines */}
                  <line x1="0" y1="25" x2="500" y2="25" stroke="var(--border-card)" strokeWidth="0.5" strokeDasharray="3,3" />
                  <line x1="0" y1="50" x2="500" y2="50" stroke="var(--border-card)" strokeWidth="0.5" strokeDasharray="3,3" />
                  <line x1="0" y1="75" x2="500" y2="75" stroke="var(--border-card)" strokeWidth="0.5" strokeDasharray="3,3" />
                </svg>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section id="features" className="max-w-[1400px] mx-auto px-6 py-24 border-t border-sidebar-border">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h2 className="text-3xl sm:text-4xl font-extrabold text-title-text">Why automate with AstroidBot?</h2>
          <p className="mt-4 text-muted-text">
            Engineered exclusively for the Stacks network, leveraging quick confirmations and low fees to run optimized trading models.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="bg-card-bg border border-card-border p-8 rounded-2xl hover:border-brand-500/30 transition-all duration-300 group">
            <div className="w-12 h-12 rounded-xl bg-brand-500/10 flex items-center justify-center border border-brand-500/20 text-brand-400 mb-6 group-hover:scale-110 transition-transform">
              <Zap className="w-6 h-6" />
            </div>
            <h3 className="text-xl font-bold text-title-text mb-3">AI-Driven Parameter Optimization</h3>
            <p className="text-muted-text text-sm leading-relaxed">
              Our models dynamically evaluate Stacks trading pairs (e.g. STX/ALEX, STX/WELAR) to adjust grids based on volatility, ensuring optimized buy-low, sell-high setups.
            </p>
          </div>

          <div className="bg-card-bg border border-card-border p-8 rounded-2xl hover:border-brand-500/30 transition-all duration-300 group">
            <div className="w-12 h-12 rounded-xl bg-brand-500/10 flex items-center justify-center border border-brand-500/20 text-brand-400 mb-6 group-hover:scale-110 transition-transform">
              <TrendingUp className="w-6 h-6" />
            </div>
            <h3 className="text-xl font-bold text-title-text mb-3">Automated Limit Order Engines</h3>
            <p className="text-muted-text text-sm leading-relaxed">
              Set precise buy or sell targets. AstroidBot monitors prices off-chain and auto-signs transactions when limits are hit, bypassing browser-locking mechanisms.
            </p>
          </div>

          <div className="bg-card-bg border border-card-border p-8 rounded-2xl hover:border-brand-500/30 transition-all duration-300 group">
            <div className="w-12 h-12 rounded-xl bg-brand-500/10 flex items-center justify-center border border-brand-500/20 text-brand-400 mb-6 group-hover:scale-110 transition-transform">
              <Lock className="w-6 h-6" />
            </div>
            <h3 className="text-xl font-bold text-title-text mb-3">Secure Non-Custodial Architecture</h3>
            <p className="text-muted-text text-sm leading-relaxed">
              No keys are ever stored on centralized servers. All actions use localized cryptographic contexts, keeping your funds safe in your own wallet.
            </p>
          </div>
        </div>
      </section>

      {/* Profit Calculator Section */}
      <section id="calculator" className="max-w-[1400px] mx-auto px-6 py-24 border-t border-sidebar-border">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
          <div>
            <h2 className="text-3xl sm:text-4xl font-extrabold text-title-text">Project your profits</h2>
            <p className="mt-4 text-muted-text leading-relaxed">
              Choose your trading capital, specify the AI grid bot risk profile, and see how compounding performance performs over time on Stacks.
            </p>

            <div className="mt-8 space-y-6">
              {/* Investment capital slider */}
              <div>
                <div className="flex justify-between text-sm mb-2">
                  <span className="text-muted-text font-medium">Investment Amount (STX)</span>
                  <span className="text-brand-400 font-bold font-mono">{investment.toLocaleString()} STX</span>
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
                <label className="block text-sm text-muted-text font-medium mb-3">Trading Strategy</label>
                <div className="grid grid-cols-3 gap-3">
                  {(["conservative", "moderate", "aggressive"] as const).map((strat) => (
                    <button
                      key={strat}
                      onClick={() => setStrategy(strat)}
                      className={`py-2 px-4 rounded-xl text-xs font-bold border capitalize transition-all duration-200 cursor-pointer ${strategy === strat
                        ? "bg-brand-500/20 border-brand-500 text-brand-400"
                        : "bg-card-bg border-card-border text-muted-text hover:text-title-text hover:border-brand-500/30"
                        }`}
                    >
                      {strat === "conservative" && "Conservative (12% APY)"}
                      {strat === "moderate" && "Balanced (28% APY)"}
                      {strat === "aggressive" && "Aggressive (58% APY)"}
                    </button>
                  ))}
                </div>
              </div>

              {/* Duration selector */}
              <div>
                <label className="block text-sm text-muted-text font-medium mb-3">Duration</label>
                <div className="grid grid-cols-3 gap-3">
                  {([30, 90, 365] as const).map((d) => (
                    <button
                      key={d}
                      onClick={() => setDays(d)}
                      className={`py-2 px-4 rounded-xl text-xs font-bold border transition-all duration-200 cursor-pointer ${days === d
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
                  +{estimatedProfit.toFixed(2)} <span className="text-brand-400 text-2xl">STX</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 py-4 border-y border-card-border">
                <div>
                  <span className="text-xs text-muted-text block">Projected Total</span>
                  <span className="text-lg font-bold text-title-text mt-0.5 font-mono">{projectedTotal.toFixed(2)} STX</span>
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


      {/* Integrations Section */}
      <section id="integrations" className="max-w-[1400px] mx-auto px-6 py-16 border-t border-sidebar-border text-center">
        <span className="text-xs uppercase text-muted-text tracking-wider font-semibold">Integrations & Protocols</span>
        <div className="mt-8 flex flex-wrap justify-center items-center gap-12 opacity-65 grayscale hover:grayscale-0 transition-all duration-300">
          <div className="flex items-center gap-2">
            <span className="font-bold text-lg text-title-text font-mono">STACKS</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand-500/20 text-brand-400">Layer 2</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-bold text-lg text-title-text font-mono">ALEX SDK</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400">DeFi</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-bold text-lg text-title-text font-mono">VELUMX</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400">Relayer</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-bold text-lg text-title-text font-mono">VELAR</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400">DEX</span>
          </div>
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
            <div className="bg-brand-500/10 border border-brand-500/20 text-brand-400 text-sm p-4 rounded-xl text-center">
              Message submitted successfully! We will get back to you shortly.
            </div>
          ) : (
            <form onSubmit={handleContactSubmit} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-muted-text mb-1.5">Name</label>
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
                  <label className="block text-xs text-muted-text mb-1.5">Email</label>
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
                <label className="block text-xs text-muted-text mb-1.5">Message</label>
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
                className="w-full py-3 bg-brand-500 hover:bg-brand-600 text-white rounded-xl font-bold text-sm transition-colors flex items-center justify-center gap-2 cursor-pointer"
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

          <div className="flex items-center gap-8 text-xs text-muted-text">
            <a href="#features" className="hover:text-title-text transition-colors">Features</a>
            <a href="#calculator" className="hover:text-title-text transition-colors">Calculator</a>
            <Link to="/docs" className="hover:text-title-text transition-colors">Docs</Link>
            <a href="/terms" className="hover:text-title-text transition-colors">Terms of Service</a>
            <a href="/privacy" className="hover:text-title-text transition-colors">Privacy Policy</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
