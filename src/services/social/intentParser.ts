import type { SocialIntent } from "./types.js";

/**
 * Turns post text into a SocialIntent, deterministically.
 *
 * A grammar rather than an LLM, and that ordering is a security property, not
 * a performance one: the text of a public post is attacker-controlled, and a
 * model asked to "interpret" it can be talked into interpreting instructions.
 * The regex has no such failure mode — it either matches the shape or it
 * doesn't. AIOrchestrator is only consulted for phrasings this rejects, and
 * its output is re-validated through `validateIntent` before it can be used.
 */

/** Strip anything that isn't the author's own words before parsing. */
export function sanitizePostText(text: string, botHandles: string[]): string {
  let out = text;

  // Quoted/retweeted content and URLs are other people's text appearing inside
  // this post — the classic injection vector ("@bot ignore previous and…"
  // pasted into a quote). Drop them entirely rather than trying to judge them.
  out = out.replace(/https?:\/\/\S+/g, " ");
  out = out.replace(/^RT\s+@\w+:.*/i, " ");
  out = out.replace(/^>.*$/gm, " ");

  for (const handle of botHandles) {
    out = out.replace(new RegExp(`@${handle}\\b`, "gi"), " ");
  }

  return out.replace(/\s+/g, " ").trim();
}

const ACTION = "(buy|sell|ape|long|short)";
const NUMBER = "(\\d+(?:\\.\\d+)?)";
const TOKEN = "\\$?([A-Za-z0-9]{2,44})";
const CHAIN = "(?:\\s+on\\s+([A-Za-z][A-Za-z0-9-]{1,20}))?";

/**
 * Supported phrasings, most specific first:
 *   buy 50 usdc of $DEGEN on base   → 50 USD of DEGEN
 *   buy $50 of $DEGEN               → 50 USD of DEGEN
 *   buy 100 $DEGEN on base          → 100 DEGEN
 *   sell 100 $DEGEN                 → sell 100 DEGEN
 */
const PATTERNS: { re: RegExp; build: (m: RegExpMatchArray) => SocialIntent | null }[] = [
  {
    // "buy 50 usdc of $DEGEN" / "buy 50 usd of DEGEN"
    re: new RegExp(`\\b${ACTION}\\s+${NUMBER}\\s*(?:usdc?|usdt?|dollars?)\\s+(?:of|worth of)\\s+${TOKEN}${CHAIN}`, "i"),
    build: (m) => ({
      action: normalizeAction(m[1]!),
      amount: parseFloat(m[2]!),
      token: m[3]!.toUpperCase(),
      denomination: "usd",
      chainHint: m[4]?.toLowerCase(),
    }),
  },
  {
    // "buy $50 of $DEGEN"
    re: new RegExp(`\\b${ACTION}\\s+\\$${NUMBER}\\s+(?:of|worth of)?\\s*${TOKEN}${CHAIN}`, "i"),
    build: (m) => ({
      action: normalizeAction(m[1]!),
      amount: parseFloat(m[2]!),
      token: m[3]!.toUpperCase(),
      denomination: "usd",
      chainHint: m[4]?.toLowerCase(),
    }),
  },
  {
    // "buy 100 $DEGEN" — amount denominated in the token itself
    re: new RegExp(`\\b${ACTION}\\s+${NUMBER}\\s+${TOKEN}${CHAIN}`, "i"),
    build: (m) => ({
      action: normalizeAction(m[1]!),
      amount: parseFloat(m[2]!),
      token: m[3]!.toUpperCase(),
      denomination: "token",
      chainHint: m[4]?.toLowerCase(),
    }),
  },
];

function normalizeAction(raw: string): "buy" | "sell" {
  const a = raw.toLowerCase();
  return a === "sell" || a === "short" ? "sell" : "buy";
}

/** Deterministic parse. Returns null when nothing matches — never a guess. */
export function parseIntent(text: string): SocialIntent | null {
  for (const { re, build } of PATTERNS) {
    const match = text.match(re);
    if (match) {
      const intent = build(match);
      if (intent && validateIntent(intent)) return intent;
    }
  }
  return null;
}

/**
 * The single gate every intent passes, whether it came from the grammar or
 * from the LLM fallback. An LLM-produced intent is not trusted any further
 * than a regex-produced one.
 */
export function validateIntent(intent: unknown): intent is SocialIntent {
  if (!intent || typeof intent !== "object") return false;
  const i = intent as Partial<SocialIntent>;

  if (i.action !== "buy" && i.action !== "sell") return false;
  if (typeof i.token !== "string" || !/^[A-Za-z0-9]{2,44}$/.test(i.token)) return false;
  if (typeof i.amount !== "number" || !Number.isFinite(i.amount) || i.amount <= 0) return false;
  if (i.denomination !== "usd" && i.denomination !== "token") return false;
  if (i.chainHint !== undefined && !/^[A-Za-z][A-Za-z0-9:-]{1,30}$/.test(i.chainHint)) return false;

  // Reject any property outside the schema. An LLM asked to emit JSON can be
  // coaxed into adding fields ("walletId", "recipient"); silently ignoring
  // them is fine today and a vulnerability the moment someone reads the object
  // more permissively.
  const allowed = new Set(["action", "token", "amount", "denomination", "chainHint"]);
  return Object.keys(i).every((k) => allowed.has(k));
}
