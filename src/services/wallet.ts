import {
  makeRandomPrivKey,
  getAddressFromPrivateKey,
} from "@stacks/transactions";
import { ConfigManager } from "../config.js";
import { DatabaseService } from "./db.js";
import { logger } from "../utils/logger.js";
import { KMSService } from "./kms.js";

function getNetworkString(): "mainnet" | "testnet" {
  const network = ConfigManager.getInstance().config.STACKS_NETWORK;
  return network === "mainnet" ? "mainnet" : "testnet";
}

export function generateWalletKeypair(): { privateKey: string; address: string } {
  const privateKey = makeRandomPrivKey();
  const address = getAddressFromPrivateKey(privateKey, getNetworkString());
  return { privateKey, address };
}

export function deriveAddressFromPrivateKey(privateKey: string): string {
  // getAddressFromPrivateKey automatically validates the private key format and throws if invalid
  return getAddressFromPrivateKey(privateKey, getNetworkString());
}

export async function provisionDefaultWallet(userId: number): Promise<void> {
  const db = DatabaseService.getInstance();
  const existing = await db.findWalletsByUserId(userId);
  if (existing.length > 0) return;

  const { privateKey, address } = generateWalletKeypair();
  const encryptedKey = await KMSService.getInstance().encryptPrivateKey(privateKey);

  await db.createWallet({
    userId,
    address,
    name: "Wallet 1",
    encryptedKey,
  });

  logger.info("Default wallet provisioned for new user", { userId, address });
}
