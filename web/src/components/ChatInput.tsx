import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Send, Loader2, Sparkles, Mic } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";
import { useChains } from "../hooks/useChains";
import { WEB_INFO_LINK_MAP } from "@shared/navigation";

interface ChatInputProps {
  onCommand?: (type: string, data: Record<string, unknown>) => void;
  contextHint?: string;
}

export function ChatInput({ onCommand, contextHint }: ChatInputProps) {
  const navigate = useNavigate();
  const { chains } = useChains();

  // Used only to phrase the example command; the trade path re-reads wallets
  // at submit time so a stale cache can never pick the wallet to spend from.
  const { data: wallets } = useQuery<{ id: number; chain?: string | null; isDefault?: boolean }[]>({
    queryKey: ["wallets"],
    queryFn: () => apiFetch("/me/wallets"),
    staleTime: 60_000,
  });
  const defaultWallet = wallets?.find((w) => w.isDefault) ?? wallets?.[0];
  const defaultChain = chains.find((c) => c.chainId === defaultWallet?.chain);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [showVoiceTooltip, setShowVoiceTooltip] = useState(false);
  const tooltipTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (tooltipTimeoutRef.current) clearTimeout(tooltipTimeoutRef.current);
    };
  }, []);

  const handleVoiceClick = (e: React.MouseEvent) => {
    e.preventDefault();
    setShowVoiceTooltip(true);
    if (tooltipTimeoutRef.current) {
      clearTimeout(tooltipTimeoutRef.current);
    }
    tooltipTimeoutRef.current = setTimeout(() => {
      setShowVoiceTooltip(false);
    }, 2000);
  };

  // The example pair comes from the user's default wallet's chain, so the
  // suggestion is something this account can actually execute rather than a
  // Stacks pair shown to a Base-only user.
  const example =
    defaultChain
      ? `buy 10 ${defaultChain.nativeSymbol} with ${defaultChain.stableSymbol}`
      : "buy 10 of a token";

  const placeholder = contextHint
    ? `Ask about ${contextHint}... e.g. "what are agents?"`
    : `Type a command... e.g. '${example}' or 'show portfolio'`;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loading) return;

    setLoading(true);
    setResponse(null);

    try {
      const result = await apiFetch<Record<string, unknown>>("/ai/command", {
        method: "POST",
        body: JSON.stringify({ input: input.trim() }),
      });

      const action = result.action as string;

      if (action === "trade") {
        const wallets = await apiFetch<
          { id: number; chain?: string | null; isDefault?: boolean }[]
        >("/me/wallets");
        // The default wallet, and its chain's pair as the fallback — not
        // whichever wallet came back first and a Stacks pair.
        const wallet = wallets?.find((w) => w.isDefault) ?? wallets?.[0];
        const walletChain = chains.find((c) => c.chainId === wallet?.chain);
        const tokenIn = result.tokenIn ?? walletChain?.nativeSymbol;
        const tokenOut = result.tokenOut ?? walletChain?.stableSymbol;

        if (!wallet || !tokenIn || !tokenOut) {
          setResponse("⚠️ I need a wallet on a tradable chain before I can do that.");
          return;
        }

        const tradeResp = await apiFetch<{ ok: boolean; txId: string }>("/me/trades/execute", {
          method: "POST",
          body: JSON.stringify({
            walletId: wallet.id,
            tokenIn,
            tokenOut,
            amountIn: result.amountIn ?? 1,
            direction: result.direction ?? "BUY",
          }),
        });
        setResponse(`✅ Trade executed! TX: ${tradeResp.txId?.slice(0, 12)}...`);
      } else if (action === "chat") {
        const reply = (result.replyText as string) ?? "Hello! How can I help you today?";
        setResponse(`💬 ${reply}`);
        const link = result.suggestedLink as string | undefined;
        if (link) {
          setTimeout(() => navigate(link), 1200);
        }
      } else if (action === "create_strategy") {
        setResponse("📋 Opening agents page to create a strategy...");
        setTimeout(() => navigate("/agents"), 800);
      } else if (action === "info") {
        const topic = result.topic as string;
        setResponse(`📊 Opening ${topic}...`);
        const link = (result.suggestedLink as string) ?? WEB_INFO_LINK_MAP[topic];
        if (link) setTimeout(() => navigate(link), 600);
        onCommand?.(action, result);
      } else if (action === "settings") {
        setResponse(`✅ ${result.key as string} updated to ${result.value}`);
      } else if (action === "halt" || action === "resume") {
        setResponse(`✅ Bot ${action === "halt" ? "halted" : "resumed"}`);
      } else {
        setResponse(`🤔 I didn't understand that. Try: '${example}' or 'show portfolio'`);
      }
    } catch {
      setResponse("❌ Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (response) {
      timerRef.current = setTimeout(() => setResponse(null), 8000);
    }
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [response]);

  return (
    <div>
      <form onSubmit={handleSubmit} className="relative">
        <div className="flex items-center gap-2 glass-card rounded-2xl px-4 py-2 focus-within:border-brand-500/50 transition-all">
          <Sparkles className="w-4 h-4 text-brand-400 flex-shrink-0" />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={placeholder}
            className="flex-1 bg-transparent text-sm text-title-text placeholder:text-muted-text focus:outline-none py-2"
          />
          <div className="relative flex items-center justify-center">
            <button
              type="button"
              onClick={handleVoiceClick}
              className="p-1.5 rounded-lg hover:bg-bg-hover text-muted-text/30 transition-colors cursor-pointer"
              title="Voice (coming soon)"
            >
              <Mic className="w-4 h-4" />
            </button>
            {showVoiceTooltip && (
              <div className="absolute bottom-full mb-2 bg-brand-500 text-white text-[11px] font-medium px-2 py-1 rounded shadow-md whitespace-nowrap z-50 animate-fadeIn">
                Coming soon
                <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-brand-500" />
              </div>
            )}
          </div>
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="p-1.5 rounded-lg bg-brand-500 hover:bg-brand-600 text-white transition-colors disabled:opacity-40"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      </form>
      {response && (
        <div className="mt-2 px-4 py-2 glass-card rounded-xl text-xs text-muted-text">
          {response}
        </div>
      )}
    </div>
  );
}
