import { Moon, Sun } from "lucide-react";
import { useTheme } from "../lib/theme";
import { classNames } from "../lib/utils";

interface ThemeToggleProps {
  className?: string;
}

/** Sun in dark mode (switch to light), moon in light mode (switch to dark). */
export function ThemeToggle({ className }: ThemeToggleProps) {
  const { theme, toggle } = useTheme();
  const nextIsDark = theme === "light";

  return (
    <button
      type="button"
      onClick={toggle}
      title={nextIsDark ? "Switch to dark mode" : "Switch to light mode"}
      aria-label={nextIsDark ? "Switch to dark mode" : "Switch to light mode"}
      className={classNames(
        "rounded-lg p-2 text-muted-text transition-colors hover:bg-bg-hover hover:text-title-text",
        className
      )}
    >
      {nextIsDark ? <Moon className="h-5 w-5" /> : <Sun className="h-5 w-5" />}
    </button>
  );
}
