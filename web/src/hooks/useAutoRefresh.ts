import { useState, useEffect, useCallback, useRef } from "react";

interface AutoRefreshState {
  isActive: boolean;
  toggle: () => void;
  timeLeft: number;
  interval: number | false;
}

const TIMEOUT_SECONDS = 30 * 60;
const INTERVALS: Record<string, number> = {
  dashboard: 60_000,
  trades: 30_000,
  limitOrders: 15_000,
  tokens: 60_000,
  portfolio: 15_000,
  settings: 0,
};

export function useAutoRefresh(panel: string): AutoRefreshState {
  const [isActive, setIsActive] = useState(true);
  const [timeLeft, setTimeLeft] = useState(TIMEOUT_SECONDS);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activityRef = useRef(true);

  const resetTimer = useCallback(() => {
    setTimeLeft(TIMEOUT_SECONDS);
    activityRef.current = true;
  }, []);

  useEffect(() => {
    if (!isActive) return;

    const onActivity = () => {
      resetTimer();
    };

    window.addEventListener("mousemove", onActivity, { passive: true });
    window.addEventListener("keydown", onActivity, { passive: true });
    window.addEventListener("scroll", onActivity, { passive: true });
    window.addEventListener("click", onActivity, { passive: true });

    timerRef.current = setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) {
          setIsActive(false);
          return 0;
        }
        return t - 1;
      });
      activityRef.current = false;
    }, 1000);

    return () => {
      window.removeEventListener("mousemove", onActivity);
      window.removeEventListener("keydown", onActivity);
      window.removeEventListener("scroll", onActivity);
      window.removeEventListener("click", onActivity);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isActive, resetTimer]);

  const toggle = useCallback(() => {
    setIsActive((v) => {
      if (!v) {
        setTimeLeft(TIMEOUT_SECONDS);
      }
      return !v;
    });
  }, []);

  const interval = isActive
    ? (INTERVALS[panel] ?? 60_000)
    : false;

  return { isActive, toggle, timeLeft, interval };
}
