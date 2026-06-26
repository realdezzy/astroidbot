export function shortenAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function escapeMd(text: string): string {
  return text.replace(/([_*`\\])/g, "\\$1");
}
