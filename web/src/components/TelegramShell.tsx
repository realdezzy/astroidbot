import { useEffect } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useTelegram } from "../lib/telegram/TelegramProvider";

export function TelegramShell() {
  const { webApp } = useTelegram();
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const back = webApp?.BackButton;
    if (!back) return;
    const goBack = () => location.pathname === "/tg" ? webApp.close() : navigate(-1);
    if (location.pathname === "/tg") back.hide(); else back.show();
    back.onClick(goBack);
    return () => back.offClick(goBack);
  }, [location.pathname, navigate, webApp]);

  return (
    <div className="min-h-screen bg-main-bg text-white tg-safe-area">
      <Outlet />
    </div>
  );
}
