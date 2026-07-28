import type { BotContext } from "../../types/bot.js";

/**
 * Callback dispatch.
 *
 * `router.ts` had one `callback_query:data` handler ~600 lines long: a flat
 * chain of `if (action === …)` / `if (action.startsWith(…))` where the order of
 * the branches was load-bearing and invisible. Adding a route meant reading the
 * whole chain to check nothing above it matched first, and a typo silently fell
 * through to the main menu.
 *
 * Routes are now declared per domain and resolved by lookup: exact matches
 * first, then the *longest* matching prefix. Longest-first is what makes
 * `agent_toggle_details:` and `agent_toggle:` coexist safely — under the old
 * sequential chain that pair only worked because one happened to be written
 * above the other.
 */

/** `args` is the callback data after the matched prefix, split on ":". */
export type CallbackHandler = (
  ctx: BotContext,
  args: string[],
  raw: string
) => Promise<unknown>;

export interface CallbackRoutes {
  /** Matched against the full action, e.g. "trade_confirm". */
  exact?: Record<string, CallbackHandler>;
  /** Keys must end with ":", e.g. "agent_details:". */
  prefix?: Record<string, CallbackHandler>;
}

export class CallbackRouter {
  private exact = new Map<string, CallbackHandler>();
  /** Sorted longest-first so the most specific prefix always wins. */
  private prefixes: { key: string; handler: CallbackHandler }[] = [];

  register(...modules: CallbackRoutes[]): this {
    for (const routes of modules) {
      for (const [action, handler] of Object.entries(routes.exact ?? {})) {
        if (this.exact.has(action)) {
          throw new Error(`Duplicate callback route "${action}"`);
        }
        this.exact.set(action, handler);
      }

      for (const [key, handler] of Object.entries(routes.prefix ?? {})) {
        if (!key.endsWith(":")) {
          throw new Error(`Prefix route "${key}" must end with ":"`);
        }
        if (this.prefixes.some((p) => p.key === key)) {
          throw new Error(`Duplicate callback prefix "${key}"`);
        }
        this.prefixes.push({ key, handler });
      }
    }

    this.prefixes.sort((a, b) => b.key.length - a.key.length);
    return this;
  }

  /**
   * Resolves an action to its handler without invoking it.
   *
   * Separate from `dispatch` so a test can assert a route *exists* without
   * having to construct a working context — which otherwise makes "the handler
   * threw" indistinguishable from "there is no such route".
   */
  resolve(action: string): { handler: CallbackHandler; args: string[] } | null {
    const exact = this.exact.get(action);
    if (exact) return { handler: exact, args: [] };

    for (const { key, handler } of this.prefixes) {
      if (action.startsWith(key)) {
        return { handler, args: action.slice(key.length).split(":") };
      }
    }

    return null;
  }

  /** True when some route claims this action. */
  has(action: string): boolean {
    return this.resolve(action) !== null;
  }

  /** Returns the handler's result, or `handled: false` when nothing matched. */
  async dispatch(ctx: BotContext, action: string): Promise<{ handled: boolean; result?: unknown }> {
    const match = this.resolve(action);
    if (!match) return { handled: false };
    return { handled: true, result: await match.handler(ctx, match.args, action) };
  }

  /** Test/introspection helper. */
  routeCount(): { exact: number; prefix: number } {
    return { exact: this.exact.size, prefix: this.prefixes.length };
  }
}

/** Parses a numeric argument, or null when it isn't one. */
export function numericArg(args: string[], index = 0): number | null {
  const n = parseInt(args[index] ?? "", 10);
  return Number.isNaN(n) ? null : n;
}
