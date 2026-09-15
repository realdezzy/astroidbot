import { useLocation } from "react-router-dom";

export interface AppRoutes {
  isTelegram: boolean;
  tokenList: string;
  tokenDetail(chainId: string, contractId: string): string;
}

/** Keeps reusable market screens inside the shell that opened them. */
export function useAppRoutes(): AppRoutes {
  const { pathname } = useLocation();
  const isTelegram = pathname === "/tg" || pathname.startsWith("/tg/");
  const tokenList = isTelegram ? "/tg/tokens" : "/tokens";

  return {
    isTelegram,
    tokenList,
    tokenDetail: (chainId, contractId) =>
      `${tokenList}/${encodeURIComponent(chainId)}/${encodeURIComponent(contractId)}`,
  };
}
