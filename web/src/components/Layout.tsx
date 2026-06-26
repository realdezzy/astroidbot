import { useState, useEffect } from "react";
import { Outlet, NavLink, useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  Receipt,
  Settings,
  LogOut,
  Bot,
  Clock,
  ShieldBan,
  UserCog,
  ArrowRightLeft,
  Wallet,
  PieChart,
  Sun,
  Moon,
  Menu,
  X,
  MessageSquare,
  TrendingUp,
  BookOpen,
} from "lucide-react";
import { useAuth } from "../lib/auth";

const navItems = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/chat", icon: MessageSquare, label: "AI Assistant" },
  { to: "/portfolio", icon: PieChart, label: "Portfolio" },
  { to: "/wallets", icon: Wallet, label: "Wallets" },
  { to: "/trade", icon: ArrowRightLeft, label: "Trade" },
  { to: "/perp", icon: TrendingUp, label: "Perp" },
  { to: "/limit-orders", icon: Clock, label: "Limit Orders" },
  { to: "/agents", icon: Bot, label: "Agents" },
  { to: "/tokens", icon: ShieldBan, label: "Tokens" },
  { to: "/settings", icon: Settings, label: "Settings" },
  { to: "/account", icon: UserCog, label: "Account" },
];


export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const stored = localStorage.getItem("theme") as "light" | "dark" | null;
    if (stored) return stored;
    if (window.matchMedia("(prefers-color-scheme: light)").matches) return "light";
    return "dark";
  });

  // Apply theme class on mount and on change
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

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-main-bg text-main-text transition-colors duration-300">
      {/* Mobile Top Header */}
      <header className="md:hidden flex items-center justify-between px-6 py-4 bg-sidebar-bg border-b border-sidebar-border transition-colors duration-300">
        <div className="flex items-center gap-3">
          <img src="/logo.png" alt="AstroidBot Logo" className="w-8 h-8 object-contain shrink-0" />
          <div>
            <h1 className="text-md font-bold text-title-text">AstroidBot</h1>
            <p className="text-[10px] text-muted-text">AI Trading</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={toggleTheme}
            className="p-2 text-muted-text hover:text-title-text rounded-lg bg-bg-hover hover:bg-input-bg transition-colors"
          >
            {theme === "dark" ? <Sun className="w-5 h-5 text-yellow-400" /> : <Moon className="w-5 h-5 text-indigo-500" />}
          </button>
          <button
            onClick={() => setMobileOpen(true)}
            className="p-2 text-muted-text hover:text-title-text rounded-lg bg-bg-hover hover:bg-input-bg transition-colors"
          >
            <Menu className="w-6 h-6" />
          </button>
        </div>
      </header>

      {/* Desktop Sidebar */}
      <aside className="hidden md:flex w-64 bg-sidebar-bg border-r border-sidebar-border flex-col transition-colors duration-300">
        <div className="p-6 border-b border-sidebar-border flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="/logo.png" alt="AstroidBot Logo" className="w-8 h-8 object-contain shrink-0" />
            <div>
              <h1 className="text-lg font-bold text-title-text">AstroidBot</h1>
              <p className="text-xs text-muted-text">AI Trading</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 p-4 space-y-1">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/dashboard"}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${isActive
                  ? "bg-brand-500/20 text-brand-400 font-semibold"
                  : "text-muted-text hover:text-title-text hover:bg-bg-hover"
                }`
              }
            >
              <Icon className="w-5 h-5" />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="p-4 border-t border-sidebar-border space-y-4">
          {/* Theme Toggle Button */}
          <button
            onClick={toggleTheme}
            className="flex items-center justify-between w-full px-3 py-2 text-sm text-muted-text hover:text-title-text hover:bg-bg-hover rounded-lg transition-colors"
          >
            <div className="flex items-center gap-2">
              {theme === "dark" ? <Sun className="w-4 h-4 text-yellow-400" /> : <Moon className="w-4 h-4 text-indigo-500" />}
              <span>{theme === "dark" ? "Light Mode" : "Dark Mode"}</span>
            </div>
          </button>

          {/* User Account Info */}
          <div className="flex items-center gap-3 px-2">
            <div className="w-8 h-8 rounded-full bg-brand-500 flex items-center justify-center text-sm font-bold text-white shrink-0">
              {user?.username?.[0]?.toUpperCase() ?? "U"}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-title-text truncate">
                {user?.username ?? "User"}
              </p>
              <p className="text-xs text-muted-text">{user?.points ?? 0} pts</p>
            </div>
          </div>

          <button
            onClick={handleLogout}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-muted-text hover:text-red-400 hover:bg-bg-hover rounded-lg transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Logout
          </button>
        </div>
      </aside>

      {/* Slide-over Drawer for Mobile */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          {/* Overlay backdrop */}
          <div
            onClick={() => setMobileOpen(false)}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-300"
          />

          <aside className="relative w-64 max-w-xs bg-sidebar-bg border-r border-sidebar-border flex flex-col z-10 transition-colors duration-300">
            <div className="p-6 border-b border-sidebar-border flex items-center justify-between">
              <div className="flex items-center gap-3">
                <img src="/logo.png" alt="AstroidBot Logo" className="w-8 h-8 object-contain shrink-0" />
                <div>
                  <h1 className="text-md font-bold text-title-text">AstroidBot</h1>
                  <p className="text-[10px] text-muted-text">AI Trading</p>
                </div>
              </div>
              <button
                onClick={() => setMobileOpen(false)}
                className="p-1.5 text-muted-text hover:text-title-text rounded-lg hover:bg-gray-100/10 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
              {navItems.map(({ to, icon: Icon, label }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={to === "/dashboard"}
                  onClick={() => setMobileOpen(false)}
                  className={({ isActive }) =>
                    `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${isActive
                      ? "bg-brand-500/20 text-brand-400 font-semibold"
                      : "text-muted-text hover:text-title-text hover:bg-gray-100/10 transition-colors"
                    }`
                  }
                >
                  <Icon className="w-5 h-5" />
                  {label}
                </NavLink>
              ))}
            </nav>

            <div className="p-4 border-t border-sidebar-border space-y-4">
              <div className="flex items-center gap-3 px-2">
                <div className="w-8 h-8 rounded-full bg-brand-500 flex items-center justify-center text-sm font-bold text-white shrink-0">
                  {user?.username?.[0]?.toUpperCase() ?? "U"}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-title-text truncate">
                    {user?.username ?? "User"}
                  </p>
                  <p className="text-xs text-muted-text">{user?.points ?? 0} pts</p>
                </div>
              </div>

              <button
                onClick={() => {
                  setMobileOpen(false);
                  handleLogout();
                }}
                className="flex items-center gap-2 w-full px-3 py-2 text-sm text-muted-text hover:text-red-400 hover:bg-bg-hover rounded-lg transition-colors"
              >
                <LogOut className="w-4 h-4" />
                Logout
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 overflow-auto bg-main-bg transition-colors duration-300">
        <div className="p-4 md:p-8 max-w-6xl mx-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
