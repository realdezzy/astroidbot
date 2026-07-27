/**
 * Typed callback-data codec.
 *
 * Telegram caps `callback_data` at 64 *bytes* and silently truncates anything
 * longer — the button still renders, the tap still fires, and the handler
 * receives a mangled string. Hand-built template literals are therefore a
 * latent bug: adding a chainId to an existing callback ("trade:sel:USDC"
 * becoming "trade:sel:base:mainnet:USDC") is exactly the kind of change that
 * pushes a payload over the limit, and it fails invisibly.
 *
 * So callback data is built and parsed in one place, with the length checked
 * at build time where it's a loud developer error rather than a silent
 * production one.
 */

export const CALLBACK_DATA_MAX_BYTES = 64;

/** Separator. Chosen because ChainIds contain ":" and would collide with it. */
const SEP = "|";

export class CallbackDataTooLongError extends Error {
  constructor(data: string) {
    super(
      `Callback data is ${Buffer.byteLength(data, "utf8")} bytes, over Telegram's ` +
      `${CALLBACK_DATA_MAX_BYTES}-byte limit: "${data}". Shorten the namespace or ` +
      `move the payload into session state.`
    );
    this.name = "CallbackDataTooLongError";
  }
}

/**
 * Builds callback data as `namespace|action|...args`.
 *
 * Throws rather than truncating: a payload that doesn't fit is a bug to fix at
 * the call site, and silently shipping a truncated one produces a button that
 * does the wrong thing.
 */
export function encodeCallback(namespace: string, action: string, ...args: string[]): string {
  const parts = [namespace, action, ...args];

  for (const part of parts) {
    if (part.includes(SEP)) {
      throw new Error(`Callback segment "${part}" contains the reserved separator "${SEP}"`);
    }
  }

  const data = parts.join(SEP);
  if (Buffer.byteLength(data, "utf8") > CALLBACK_DATA_MAX_BYTES) {
    throw new CallbackDataTooLongError(data);
  }
  return data;
}

export interface ParsedCallback {
  namespace: string;
  action: string;
  args: string[];
}

/** Parses callback data. Returns null for anything not in this scheme, so
 *  legacy handlers can still see raw strings during the migration. */
export function decodeCallback(data: string): ParsedCallback | null {
  if (!data.includes(SEP)) return null;
  const [namespace, action, ...args] = data.split(SEP);
  if (!namespace || !action) return null;
  return { namespace, action, args };
}

/**
 * ChainIds ("base:mainnet") are long relative to a 64-byte budget and appear in
 * most chain-aware callbacks. These shorten them to a stable token and back.
 *
 * Deliberately not a hash: the mapping has to be reversible without shared
 * state, because a callback can arrive after a process restart.
 */
export function shortenChainId(chainId: string): string {
  return chainId.replace(":mainnet", "").replace(":", ".");
}

export function expandChainId(short: string): string {
  if (short.includes(".")) return short.replace(".", ":");
  return `${short}:mainnet`;
}
