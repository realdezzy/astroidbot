import { InlineKeyboard } from "grammy";
import { ChainAdapterRegistry } from "../../services/chains/chainAdapterRegistry.js";
import { encodeCallback, shortenChainId } from "../callbacks/codec.js";
import type { ChainDescriptor } from "../../types/chain.js";

/**
 * Shared keyboard builders.
 *
 * Everything here is button-first by construction: a flow assembled from these
 * needs no typing except the trade amount. They also mean no screen hardcodes
 * a chain list — enabling a chain in ENABLED_CHAINS makes it appear in the bot,
 * the web app and the API at once.
 */

/** A small emoji per chain so the active chain is recognisable at a glance. */
const CHAIN_ICONS: Record<string, string> = {
  stacks: "🟠",
  evm: "🔵",
  svm: "🟣",
};

export function chainIcon(descriptor: ChainDescriptor): string {
  return CHAIN_ICONS[descriptor.family] ?? "⛓";
}

export function chainLabel(descriptor: ChainDescriptor): string {
  return `${chainIcon(descriptor)} ${descriptor.displayName}`;
}

/**
 * Chain picker, fed by the registry rather than a literal.
 *
 * `tradableOnly` filters to chains that can actually swap — used by trade and
 * order flows, where offering a chain with no router would produce a dead end.
 * Wallet creation passes false: holding funds on a chain you can't yet swap on
 * is legitimate.
 */
export function chainPicker(
  namespace: string,
  action: string,
  opts: { tradableOnly?: boolean; columns?: number } = {}
): InlineKeyboard {
  const registry = ChainAdapterRegistry.getInstance();
  const chains = opts.tradableOnly ? registry.tradable() : registry.list();
  const keyboard = new InlineKeyboard();

  const columns = opts.columns ?? 2;
  chains.forEach((d, i) => {
    keyboard.text(chainLabel(d), encodeCallback(namespace, action, shortenChainId(d.chainId)));
    if ((i + 1) % columns === 0) keyboard.row();
  });

  return keyboard;
}

/**
 * Amount presets as a percentage of the available balance.
 *
 * The single most-typed value in the bot is a trade amount, so it gets buttons.
 * "Custom" remains for anyone who wants an exact figure.
 */
export function amountPresets(namespace: string, action: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("25%", encodeCallback(namespace, action, "25"))
    .text("50%", encodeCallback(namespace, action, "50"))
    .text("75%", encodeCallback(namespace, action, "75"))
    .text("Max", encodeCallback(namespace, action, "100"))
    .row()
    .text("✍️ Custom", encodeCallback(namespace, action, "custom"));
}

export function confirmCancel(
  namespace: string,
  confirmAction: string,
  cancelAction = "cancel"
): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Confirm", encodeCallback(namespace, confirmAction))
    .text("✖️ Cancel", encodeCallback(namespace, cancelAction));
}

export interface PageOptions {
  page: number;
  pageSize: number;
  total: number;
}

/** Prev/next row appended to a paginated list. Omitted entirely on one page. */
export function paginate(
  keyboard: InlineKeyboard,
  namespace: string,
  action: string,
  { page, pageSize, total }: PageOptions
): InlineKeyboard {
  const pages = Math.ceil(total / pageSize);
  if (pages <= 1) return keyboard;

  keyboard.row();
  if (page > 1) keyboard.text("◀️", encodeCallback(namespace, action, String(page - 1)));
  keyboard.text(`${page}/${pages}`, encodeCallback(namespace, "noop"));
  if (page < pages) keyboard.text("▶️", encodeCallback(namespace, action, String(page + 1)));
  return keyboard;
}

/**
 * Breadcrumb header showing the active chain and wallet.
 *
 * Losing track of which chain you're on is the main way a multichain bot goes
 * wrong — the same ticker exists on several chains, and a trade confirmed on
 * the wrong one is unrecoverable. Every chain-scoped screen carries this.
 */
export function breadcrumb(descriptor: ChainDescriptor, walletName?: string): string {
  const parts = [chainLabel(descriptor)];
  if (walletName) parts.push(walletName);
  return `_${parts.join(" · ")}_\n\n`;
}
