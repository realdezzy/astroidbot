import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  Send, Loader2, Sparkles, Mic, MicOff, Bot, User, Trash2,
  Zap, ShieldAlert, ArrowRight, CheckCircle2, AlertTriangle, HelpCircle
} from "lucide-react";
import { apiFetch, getAccessToken } from "../lib/api";
import { useAuth } from "../lib/auth";
import { classNames } from "../lib/utils";
import { useChains } from "../hooks/useChains";

interface ActionResult {
  type: "success" | "error" | "warning" | "info";
  title: string;
  details?: string;
  txId?: string;
  /** Resolved by the API from the executing wallet's chain. */
  explorerUrl?: string | null;
  link?: string;
}

/**
 * A swap the AI parsed out of a message, waiting on an explicit click.
 *
 * The chat used to POST `/me/trades/execute` straight from the parsed intent:
 * one ambiguous sentence, or one LLM misread of "sell half", and money moved
 * with nothing in between. The Telegram bot has always routed the identical
 * action through a pending action the user has to confirm; this is the web
 * surface catching up to it.
 */
interface PendingTrade {
  walletId: number;
  walletName: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  direction: string;
  /** When the intent was parsed. Confirmations are refused past the TTL. */
  parsedAt: number;
}

interface Message {
  id: string;
  sender: "user" | "bot";
  text: string;
  timestamp: string;
  actionResult?: ActionResult;
  /** Set until the user confirms or cancels; cleared either way. */
  pendingTrade?: PendingTrade;
}

/** What one parsed AI intent turns into. */
interface ParsedOutcome {
  replyText: string;
  actionResult?: ActionResult;
  pendingTrade?: PendingTrade;
}

/**
 * How long a parsed swap stays confirmable.
 *
 * The bot's equivalent (`QUOTE_TTL_MS`) is 60s because what it is confirming
 * is a *quote* — a displayed "you will receive X" that goes stale with the
 * market. This card shows no price, so what expires here is the intent: five
 * minutes on from typing it, "swap 10 for USDC" is no longer obviously the
 * thing you meant to do, and chat history survives a page reload, so without a
 * deadline yesterday's card is still one click from spending.
 */
const PENDING_TRADE_TTL_MS = 5 * 60_000;

export function AgentChat() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { chains } = useChains();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [showVoiceTooltip, setShowVoiceTooltip] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
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

  useEffect(() => {
    if (user?.id) {
      const stored = localStorage.getItem(`astroid_chat_history_${user.id}`);
      if (stored) {
        try {
          setMessages(JSON.parse(stored));
        } catch {
          setMessages([]);
        }
      } else {
        const welcomeMsg: Message = {
          id: "welcome",
          sender: "bot",
          text: `Hello ${user.username || "Trader"}! I am your AstroidBot AI assistant. I can execute swaps, manage trading agents, configure risk settings, and check your portfolio. How can I help you today?`,
          timestamp: new Date().toISOString()
        };
        setMessages([welcomeMsg]);
        localStorage.setItem(`astroid_chat_history_${user.id}`, JSON.stringify([welcomeMsg]));
      }
    }
  }, [user?.id]);

  const saveMessages = (newMessages: Message[]) => {
    setMessages(newMessages);
    if (user?.id) {
      localStorage.setItem(`astroid_chat_history_${user.id}`, JSON.stringify(newMessages));
    }
  };

  /**
   * Patch one message in place.
   *
   * Functional form because the confirm handler resolves after an await, by
   * which point the `messages` it closed over is a render behind — a swap
   * confirmed while a reply is streaming would otherwise resurrect the older
   * list.
   */
  const updateMessage = (messageId: string, patch: Partial<Message>) => {
    setMessages((prev) => {
      const next = prev.map((m) => (m.id === messageId ? { ...m, ...patch } : m));
      if (user?.id) {
        localStorage.setItem(`astroid_chat_history_${user.id}`, JSON.stringify(next));
      }
      return next;
    });
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingText]);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      } catch {
        recorder = new MediaRecorder(stream);
      }

      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        await handleVoiceUpload(audioBlob);
        stream.getTracks().forEach((track) => track.stop());
      };

      recorder.start();
      setIsRecording(true);
    } catch (err: any) {
      console.error("Error accessing microphone:", err);
      alert("Microphone access is required for voice commands.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const toggleRecording = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  // The swap example follows whichever chain this deployment leads with, so a
  // Base-only install doesn't suggest a Stacks pair it cannot route.
  const exampleChain = chains.find((c) => c.tradable) ?? chains[0];
  const swapExample = exampleChain
    ? `Swap 10 ${exampleChain.nativeSymbol} for ${exampleChain.stableSymbol}`
    : "Swap 10 of one token for another";

  /**
   * Resolve the wallet and pair for a parsed swap — and stop there.
   *
   * Nothing is sent from here. The caller renders the result as a card the
   * user has to click.
   */
  const prepareTrade = async (parsed: Record<string, unknown>): Promise<ParsedOutcome> => {
    try {
      const wallets = await apiFetch<
        { id: number; name: string; chain?: string | null; isDefault?: boolean }[]
      >("/me/wallets");
      // The user's default wallet, not whichever came back first. With one
      // chain those were the same wallet; with several, "wallets[0]" is an
      // arbitrary chain to spend from.
      const wallet = wallets?.find((w) => w.isDefault) ?? wallets?.[0];
      if (!wallet) {
        return {
          replyText: "I parsed this as a trade request, but you don't have any wallets configured.",
          actionResult: {
            type: "warning",
            title: "Trade Suspended",
            details: "Please configure a wallet first."
          }
        };
      }

      // Defaults come from the wallet's own chain. Hardcoding STX/USDCx meant
      // an unqualified "buy 10" on a Base wallet asked for a pair that chain
      // cannot route.
      const walletChain = chains.find((c) => c.chainId === wallet.chain);
      const tokenIn = (parsed.tokenIn as string) ?? walletChain?.nativeSymbol;
      const tokenOut = (parsed.tokenOut as string) ?? walletChain?.stableSymbol;
      const amountIn = (parsed.amountIn as number) ?? 1;
      const direction = (parsed.direction as string) ?? "BUY";

      if (!tokenIn || !tokenOut) {
        throw new Error(
          "I could not tell which tokens to trade, and this wallet's chain has no default pair."
        );
      }

      return {
        replyText: `I read that as swapping ${amountIn} ${tokenIn} for ${tokenOut} out of ${wallet.name}. Check it and confirm below — nothing is sent until you do.`,
        pendingTrade: {
          walletId: wallet.id,
          walletName: wallet.name,
          tokenIn,
          tokenOut,
          amountIn,
          direction,
          parsedAt: Date.now(),
        },
      };
    } catch (err: any) {
      return {
        replyText: `I could not prepare that trade: ${err.message || "Unknown error"}`,
        actionResult: {
          type: "error",
          title: "Trade Preparation Failed",
          details: err.message || "Could not load your wallets."
        }
      };
    }
  };

  /**
   * One parsed AI intent in, one reply (and any side effect) out.
   *
   * This body existed twice — once for voice, once for typed text — and the
   * copies had already drifted: only the typed one handled `clarify` and
   * `perp_trade`, and only the typed one knew about the tokens page. A voice
   * note asking for something the typed path executed fell through to "no
   * automated action was mapped".
   *
   * A swap is the one action that does not happen here; it comes back as a
   * `pendingTrade` for the user to confirm.
   */
  const runParsedAction = async (
    parsed: Record<string, unknown>,
    source: "voice" | "text"
  ): Promise<ParsedOutcome> => {
    const action = parsed.action as string;
    const replyText = (parsed.replyText as string) ?? "";

    if (action === "trade") {
      return prepareTrade(parsed);
    }

    if (action === "settings") {
      try {
        const key = parsed.key as string;
        const value = parsed.value as number;

        await apiFetch("/me/settings", {
          method: "PUT",
          body: JSON.stringify({ [key]: value }),
        });

        return {
          replyText: replyText || `I have updated your risk configuration. Your ${key} is now set to ${value}.`,
          actionResult: {
            type: "success",
            title: "Settings Updated",
            details: `Updated ${key} to ${value} in user settings database.`
          }
        };
      } catch (err: any) {
        return {
          replyText: `Failed to update settings: ${err.message}`,
          actionResult: {
            type: "error",
            title: "Settings Modification Error",
            details: err.message
          }
        };
      }
    }

    if (action === "halt" || action === "resume") {
      try {
        await apiFetch(`/bot/${action}`, { method: "POST" });
        return {
          replyText: replyText || `I have successfully sent a command to ${action} the trading bot.`,
          actionResult: {
            type: "success",
            title: `Bot ${action === "halt" ? "Halted" : "Resumed"}`,
            details: `Global trading execution is now ${action === "halt" ? "paused" : "running"}.`
          }
        };
      } catch (err: any) {
        return {
          replyText: `Failed to change bot status: ${err.message}`,
          actionResult: {
            type: "error",
            title: "Bot Command Failure",
            details: err.message
          }
        };
      }
    }

    if (action === "create_strategy") {
      setTimeout(() => navigate("/agents"), 2000);
      return {
        replyText: "I can help you configure strategies! I will take you to the Agents tab where you can customize strategies and launch trading agents.",
        actionResult: {
          type: "info",
          title: "Strategy Engine Redirection",
          details: "Redirecting to Agents dashboard page...",
          link: "/agents"
        }
      };
    }

    if (action === "info") {
      const topic = parsed.topic as string;
      const linkMap: Record<string, string> = {
        portfolio: "/portfolio",
        wallets: "/wallets",
        orders: "/limit-orders",
        trades: "/trades",
        agents: "/agents",
        settings: "/settings",
        tokens: "/tokens",
      };
      const link = (parsed.suggestedLink as string) ?? linkMap[topic] ?? "/dashboard";

      setTimeout(() => navigate(link), 1500);
      return {
        replyText: replyText || `Redirecting you to the ${topic || "requested"} screen now.`,
        actionResult: {
          type: "info",
          title: `Navigating to ${topic || "requested page"}`,
          details: "Click below if you are not automatically redirected.",
          link
        }
      };
    }

    if (action === "clarify") {
      return {
        replyText: (parsed.prompt as string) ?? "Could you please clarify your trade intent?",
        actionResult: {
          type: "info",
          title: "Clarification Needed",
          details: "AstroidBot supports spot swaps, limit orders, and perpetual leverage trading.",
        }
      };
    }

    if (action === "perp_trade") {
      try {
        const wallets = await apiFetch<{ id: number; name: string }[]>("/me/wallets");
        const wallet = wallets?.[0];
        if (!wallet) {
          return {
            replyText: "I parsed this as a perpetual leverage trade request, but you don't have any wallets configured.",
            actionResult: {
              type: "warning",
              title: "Perp Trade Suspended",
              details: "Please configure a wallet first."
            }
          };
        }

        const market = (parsed.market as string) ?? "BTC-USD";
        const direction = (parsed.direction as string) ?? "LONG";
        const margin = (parsed.margin as number) ?? 10;
        const leverage = (parsed.leverage as number) ?? 5;

        const perpResp = await apiFetch<{ id: number; txId: string }>("/me/perp/positions", {
          method: "POST",
          body: JSON.stringify({
            walletId: wallet.id,
            market,
            direction,
            margin,
            leverage,
          }),
        });

        return {
          replyText: `Successfully opened a ${leverage}x ${direction} perpetual leverage position on ${market}!`,
          actionResult: {
            type: "success",
            title: "Perp Trade Executed",
            details: `Opened ${leverage}x ${direction} position using ${wallet.name}`,
            txId: perpResp.txId
          }
        };
      } catch (err: any) {
        return {
          replyText: `I attempted to execute the perpetual position, but it failed: ${err.message || "Unknown error"}`,
          actionResult: {
            type: "error",
            title: "Perp Trade Execution Failed",
            details: err.message || "DEX or margin error."
          }
        };
      }
    }

    if (action === "chat") {
      const link = parsed.suggestedLink as string | undefined;
      if (link) {
        setTimeout(() => navigate(link), 2500);
        return {
          replyText: replyText || "I'm your AstroidBot AI assistant. How can I help you optimize your portfolio or execute trades today?",
          actionResult: {
            type: "info",
            title: "Suggested Page Link",
            details: "Would you like to navigate to this page?",
            link
          }
        };
      }
      return {
        replyText: replyText || "I'm your AstroidBot AI assistant. How can I help you optimize your portfolio or execute trades today?"
      };
    }

    return {
      replyText:
        replyText ||
        (source === "voice"
          ? `I transcribed your voice, but no automated action was mapped. Try something like "${swapExample.toLowerCase()}".`
          : `I parsed your command. Try commands like "wallets", "portfolio", "halt bot", or "${swapExample.toLowerCase()}".`)
    };
  };

  /** Send the swap the user just clicked Confirm on. */
  const confirmPendingTrade = async (messageId: string, pending: PendingTrade) => {
    if (confirmingId) return;

    if (Date.now() - pending.parsedAt > PENDING_TRADE_TTL_MS) {
      updateMessage(messageId, {
        pendingTrade: undefined,
        actionResult: {
          type: "warning",
          title: "Confirmation Expired",
          details: "This swap was parsed too long ago to send now. Ask again and I'll re-read it."
        }
      });
      return;
    }

    setConfirmingId(messageId);
    try {
      const tradeResp = await apiFetch<{
        ok: boolean;
        txId: string;
        dex?: string;
        explorerUrl?: string | null;
      }>("/me/trades/execute", {
        method: "POST",
        body: JSON.stringify({
          walletId: pending.walletId,
          tokenIn: pending.tokenIn,
          tokenOut: pending.tokenOut,
          amountIn: pending.amountIn,
          direction: pending.direction,
        }),
      });

      updateMessage(messageId, {
        pendingTrade: undefined,
        actionResult: {
          type: "success",
          title: "Trade Executed Successfully",
          details: `Swapped ${pending.amountIn} ${pending.tokenIn} → ${pending.tokenOut} using ${pending.walletName}${tradeResp.dex ? ` via ${tradeResp.dex}` : ""}`,
          txId: tradeResp.txId,
          explorerUrl: tradeResp.explorerUrl ?? null,
        }
      });
    } catch (err: any) {
      updateMessage(messageId, {
        pendingTrade: undefined,
        actionResult: {
          type: "error",
          title: "Swap Execution Failed",
          details: err.message || "DEX quote discrepancy or insufficient balance."
        }
      });
    } finally {
      setConfirmingId(null);
    }
  };

  const dismissPendingTrade = (messageId: string) => {
    updateMessage(messageId, {
      pendingTrade: undefined,
      actionResult: {
        type: "info",
        title: "Trade Cancelled",
        details: "Nothing was sent."
      }
    });
  };

  const handleVoiceUpload = async (audioBlob: Blob) => {
    if (loading || streamingMessageId) return;
    setLoading(true);

    const botMsgId = Math.random().toString(36).substring(7);
    const tempUserMsgId = Math.random().toString(36).substring(7);
    const tempUserMsg: Message = {
      id: tempUserMsgId,
      sender: "user",
      text: "...Transcribing voice...",
      timestamp: new Date().toISOString()
    };
    
    // We need to keep a snapshot of messages before any updates
    let currentMsgs = [...messages];
    saveMessages([...currentMsgs, tempUserMsg]);

    const chatHistory = currentMsgs.slice(-6).map(m => ({
      role: m.sender === "bot" ? "assistant" as const : "user" as const,
      content: m.text
    }));

    try {
      const token = getAccessToken();
      const headers: Record<string, string> = {};
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }
      headers["Content-Type"] = "audio/webm";

      const queryParams = new URLSearchParams({
        history: JSON.stringify(chatHistory)
      }).toString();

      const res = await fetch(`/api/ai/voice?${queryParams}`, {
        method: "POST",
        headers,
        body: audioBlob,
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: "Voice transcription failed" }));
        throw new Error(errData.error || "Voice transcription failed");
      }

      const data = await res.json() as { text: string; parsed: any };
      const transcriptionText = data.text;
      
      if (!transcriptionText) {
        throw new Error("Could not transcribe any text from audio.");
      }

      const { replyText, actionResult, pendingTrade } = await runParsedAction(
        (data.parsed ?? {}) as Record<string, unknown>,
        "voice"
      );

      const newBotMsg: Message = {
        id: botMsgId,
        sender: "bot",
        text: "",
        timestamp: new Date().toISOString(),
        actionResult,
        pendingTrade
      };

      const finalUserMsg: Message = {
        id: tempUserMsgId,
        sender: "user",
        text: transcriptionText,
        timestamp: tempUserMsg.timestamp
      };
      
      const finalMessages = [...currentMsgs, finalUserMsg, newBotMsg];
      startStreaming(botMsgId, replyText, finalMessages);

    } catch (error: any) {
      const errBotMsg: Message = {
        id: botMsgId,
        sender: "bot",
        text: `Error processing voice command: ${error.message || "Please check your microphone and connection."}`,
        timestamp: new Date().toISOString()
      };
      saveMessages([...currentMsgs, errBotMsg]);
    } finally {
      setLoading(false);
    }
  };

  const startStreaming = (messageId: string, fullText: string, finalMessagesList: Message[]) => {
    setStreamingMessageId(messageId);
    setStreamingText("");
    
    let index = 0;
    const words = fullText.split(" ");
    
    const interval = setInterval(() => {
      if (index < words.length) {
        setStreamingText((prev) => (prev ? prev + " " + words[index] : words[index]!));
        index++;
      } else {
        clearInterval(interval);
        // Merge against live state rather than replacing it. `finalMessagesList`
        // is the history as it stood when streaming began, so a pending-trade
        // card the user confirmed while this was typing itself out would
        // otherwise come back unconfirmed.
        setMessages((prev) => {
          const live = new Map(prev.map((m) => [m.id, m]));
          const next = finalMessagesList.map((m) =>
            m.id === messageId ? { ...m, text: fullText } : live.get(m.id) ?? m
          );
          if (user?.id) {
            localStorage.setItem(`astroid_chat_history_${user.id}`, JSON.stringify(next));
          }
          return next;
        });
        setStreamingMessageId(null);
        setStreamingText("");
      }
    }, 45);
  };

  const handleClearHistory = () => {
    if (confirm("Are you sure you want to clear your chat history?")) {
      const welcomeMsg: Message = {
        id: "welcome",
        sender: "bot",
        text: `Hello ${user?.username || "Trader"}! History cleared. How can I help you today?`,
        timestamp: new Date().toISOString()
      };
      saveMessages([welcomeMsg]);
    }
  };

  const executeCommandText = async (commandText: string) => {
    if (!commandText.trim() || loading || streamingMessageId) return;

    const userText = commandText.trim();
    setInput("");
    setLoading(true);

    const userMsg: Message = {
      id: Math.random().toString(36).substring(7),
      sender: "user",
      text: userText,
      timestamp: new Date().toISOString()
    };

    const chatHistory = messages.slice(-6).map(m => ({
      role: m.sender === "bot" ? "assistant" as const : "user" as const,
      content: m.text
    }));

    const botMsgId = Math.random().toString(36).substring(7);
    const initialMessages = [...messages, userMsg];
    saveMessages(initialMessages);

    try {
      const result = await apiFetch<Record<string, unknown>>("/ai/command", {
        method: "POST",
        body: JSON.stringify({ input: userText, history: chatHistory }),
      });

      const { replyText, actionResult, pendingTrade } = await runParsedAction(result, "text");

      const newBotMsg: Message = {
        id: botMsgId,
        sender: "bot",
        text: "",
        timestamp: new Date().toISOString(),
        actionResult,
        pendingTrade
      };

      const finalMessages = [...initialMessages, newBotMsg];
      startStreaming(botMsgId, replyText, finalMessages);

    } catch (error: any) {
      const errBotMsg: Message = {
        id: botMsgId,
        sender: "bot",
        text: `Error processing request: ${error.message || "Please check your network connection and try again."}`,
        timestamp: new Date().toISOString()
      };
      saveMessages([...initialMessages, errBotMsg]);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    executeCommandText(input);
  };

  const handleSuggestion = (command: string) => {
    setInput(command);
    executeCommandText(command);
  };

  const SUGGESTIONS = [
    "What are trading agents?",
    "Show my wallets list",
    swapExample,
    "Halt the bot execution",
    "Set slippageBps to 150",
  ];

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between mb-4 flex-shrink-0">
        <div>
          <h2 className="text-xl font-bold text-title-text flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-brand-400" />
            AI Chat Assistant
          </h2>
          <p className="text-muted-text text-xs">
            Conversational assistant that triggers trades, modifies configurations, and navigates screens.
          </p>
        </div>
        <button
          onClick={handleClearHistory}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/5 rounded-lg border border-transparent hover:border-red-500/10 transition-colors"
          title="Clear all messages"
        >
          <Trash2 className="w-3.5 h-3.5" />
          Clear Chat
        </button>
      </div>

      <div className="flex-1 flex gap-4 min-h-0">
        <div className="flex-1 flex flex-col glass-card p-4 min-w-0">
          <div className="flex-1 overflow-y-auto space-y-4 pr-2 custom-scrollbar">
            {messages.map((m) => {
              const isBot = m.sender === "bot";
              const isStreamingThis = m.id === streamingMessageId;
              
              return (
                <div
                  key={m.id}
                  className={classNames(
                    "flex gap-3 max-w-[85%] animate-fadeIn",
                    isBot ? "self-start" : "self-end flex-row-reverse ml-auto"
                  )}
                >
                  <div
                    className={classNames(
                      "w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 shadow-sm",
                      isBot
                        ? "bg-brand-500/10 text-brand-400 border border-brand-500/20"
                        : "bg-brand-500 text-white font-bold text-sm"
                    )}
                  >
                    {isBot ? <Bot className="w-4 h-4" /> : <User className="w-4 h-4" />}
                  </div>

                  <div className="space-y-2 max-w-[calc(100%-2.5rem)]">
                    <div
                      className={classNames(
                        "px-4 py-3 rounded-2xl text-sm leading-relaxed break-words",
                        isBot
                          ? "bg-input-bg/40 text-title-text border border-divider-color/40"
                          : "bg-brand-500 text-white shadow-md rounded-tr-none"
                      )}
                    >
                      {isStreamingThis ? (
                        <span className="after:content-['▋'] after:animate-pulse after:ml-0.5">
                          {streamingText}
                        </span>
                      ) : (
                        m.text
                      )}
                    </div>

                    {m.actionResult && !isStreamingThis && (
                      <div
                        className={classNames(
                          "border rounded-xl p-3.5 space-y-2 shadow-sm animate-slideUp text-xs break-words",
                          m.actionResult.type === "success" && "bg-green-500/5 border-green-500/20 text-green-400",
                          m.actionResult.type === "error" && "bg-red-500/5 border-red-500/20 text-red-400",
                          m.actionResult.type === "warning" && "bg-amber-500/5 border-amber-500/20 text-amber-400",
                          m.actionResult.type === "info" && "bg-blue-500/5 border-blue-500/20 text-blue-400"
                        )}
                      >
                        <div className="flex items-center gap-2 font-semibold">
                          {m.actionResult.type === "success" && <CheckCircle2 className="w-4 h-4" />}
                          {m.actionResult.type === "error" && <ShieldAlert className="w-4 h-4" />}
                          {m.actionResult.type === "warning" && <AlertTriangle className="w-4 h-4" />}
                          {m.actionResult.type === "info" && <HelpCircle className="w-4 h-4" />}
                          <span>{m.actionResult.title}</span>
                        </div>
                        {m.actionResult.details && (
                          <p className="text-muted-text leading-normal">{m.actionResult.details}</p>
                        )}
                        {m.actionResult.txId && (
                          <div className="flex items-center justify-between bg-input-bg/40 p-2 rounded-lg mt-1 border border-divider-color/20 font-mono text-[10px]">
                            <span className="text-muted-text truncate select-all">{m.actionResult.txId}</span>
                            {/* Link only when the server resolved one for the
                              * trade's chain. A hardcoded Hiro URL sent every
                              * Base and Solana trade to a 404. */}
                            {m.actionResult.explorerUrl && (
                              <a
                                href={m.actionResult.explorerUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-brand-400 hover:text-brand-300 ml-2 flex-shrink-0"
                              >
                                Explorer
                              </a>
                            )}
                          </div>
                        )}
                        {m.actionResult.link && (
                          <button
                            onClick={() => navigate(m.actionResult!.link!)}
                            className="flex items-center gap-1 text-[11px] font-semibold text-brand-400 hover:text-brand-300 transition-colors pt-1"
                          >
                            Go to page <ArrowRight className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    )}
                    {m.pendingTrade && !isStreamingThis && (
                      <div className="border rounded-xl p-3.5 space-y-3 shadow-sm animate-slideUp text-xs break-words bg-amber-500/5 border-amber-500/20">
                        <div className="flex items-center gap-2 font-semibold text-amber-400">
                          <ShieldAlert className="w-4 h-4" />
                          <span>Confirm this swap</span>
                        </div>
                        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-[11px]">
                          <dt className="text-muted-text">Wallet</dt>
                          <dd className="text-title-text text-right">{m.pendingTrade.walletName}</dd>
                          <dt className="text-muted-text">Direction</dt>
                          <dd className="text-title-text text-right">{m.pendingTrade.direction}</dd>
                          <dt className="text-muted-text">Spend</dt>
                          <dd className="text-title-text text-right">
                            {m.pendingTrade.amountIn} {m.pendingTrade.tokenIn}
                          </dd>
                          <dt className="text-muted-text">Receive</dt>
                          <dd className="text-title-text text-right">{m.pendingTrade.tokenOut}</dd>
                        </dl>
                        <p className="text-[11px] text-muted-text leading-normal">
                          Filled at the best quote available when you confirm, within your slippage
                          setting. No quote is shown because none has been requested yet.
                        </p>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => void confirmPendingTrade(m.id, m.pendingTrade!)}
                            disabled={confirmingId !== null}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-500 hover:bg-brand-600 text-white font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {confirmingId === m.id ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <CheckCircle2 className="w-3.5 h-3.5" />
                            )}
                            Confirm swap
                          </button>
                          <button
                            onClick={() => dismissPendingTrade(m.id)}
                            disabled={confirmingId !== null}
                            className="px-3 py-1.5 rounded-lg border border-divider-color bg-bg-hover hover:bg-input-bg text-title-text font-semibold transition-colors disabled:opacity-40"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {loading && (
              <div className="flex gap-3 max-w-[85%] self-start animate-fadeIn">
                <div className="w-8 h-8 rounded-full bg-brand-500/10 text-brand-400 border border-brand-500/20 flex items-center justify-center">
                  <Bot className="w-4 h-4" />
                </div>
                <div className="bg-input-bg/40 text-title-text border border-divider-color/40 px-4 py-3 rounded-2xl text-sm flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin text-brand-400" />
                  <span>Thinking...</span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <form onSubmit={handleSubmit} className="mt-4 flex-shrink-0">
            <div className="flex items-center gap-2 bg-input-bg border border-divider-color focus-within:border-brand-500/50 rounded-2xl px-4 py-2.5 transition-all">
              <Sparkles className="w-4 h-4 text-brand-400 flex-shrink-0" />
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={
                  isRecording
                    ? "Listening... Speak clearly now."
                    : `Type your query (e.g. '${swapExample.toLowerCase()}')`
                }
                className="flex-1 bg-transparent text-sm text-title-text placeholder:text-muted-text/60 focus:outline-none py-1.5"
                disabled={loading || !!streamingMessageId}
              />
              <div className="relative flex items-center justify-center">
                <button
                  type="button"
                  onClick={handleVoiceClick}
                  className="p-2 rounded-xl text-muted-text/30 hover:bg-bg-hover transition-all duration-200 cursor-pointer"
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
                disabled={loading || !input.trim() || !!streamingMessageId}
                className="p-2 rounded-xl bg-brand-500 hover:bg-brand-600 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </button>
            </div>
          </form>
        </div>

        <div className="w-72 hidden lg:flex flex-col gap-4 flex-shrink-0">
          <div className="glass-card p-4 space-y-4">
            <h3 className="text-xs font-semibold text-muted-text uppercase tracking-wider flex items-center gap-2">
              <Zap className="w-4 h-4 text-brand-400" />
              Suggested Commands
            </h3>
            <div className="space-y-2">
              {SUGGESTIONS.map((s, idx) => (
                <button
                  key={idx}
                  onClick={() => handleSuggestion(s)}
                  className="w-full text-left p-3 rounded-xl bg-input-bg/40 hover:bg-bg-hover border border-divider-color/30 text-xs text-title-text hover:text-brand-400 transition-all duration-150"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div className="glass-card p-4 flex-1 space-y-4 text-xs text-muted-text leading-relaxed">
            <h3 className="font-semibold text-title-text uppercase text-[10px] tracking-wider">
              About AI Assistant
            </h3>
            <p>
              The AstroidBot assistant listens to natural language commands or voice notes to control your portfolio, wallets, and automated trading agents.
            </p>
            <div className="space-y-2 border-t border-divider-color/40 pt-3">
              <div className="flex gap-2">
                <span className="text-brand-400 font-bold font-mono">1.</span>
                <span>Swaps tokens using the best quote across the DEXs on your wallet&apos;s chain, once you confirm the trade it read out of your message.</span>
              </div>
              <div className="flex gap-2">
                <span className="text-brand-400 font-bold font-mono">2.</span>
                <span>Adjusts trading parameters like slippage or rebalance thresholds directly.</span>
              </div>
              <div className="flex gap-2">
                <span className="text-brand-400 font-bold font-mono">3.</span>
                <span>Navigates you directly to specific dashboards and portfolio views automatically.</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
