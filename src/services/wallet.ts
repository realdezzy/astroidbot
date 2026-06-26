import {
  makeRandomPrivKey,
  privateKeyToString,
  getAddressFromPrivateKey,
  createStacksPrivateKey,
  TransactionVersion,
} from "@stacks/transactions";
import { ConfigManager } from "../config.js";
import { DatabaseService } from "./db.js";
import { logger } from "../utils/logger.js";
import { KMSService } from "./kms.js";


function networkVersion(): TransactionVersion {
  const network = ConfigManager.getInstance().config.STACKS_NETWORK;
  return network === "mainnet"
    ? TransactionVersion.Mainnet
    : TransactionVersion.Testnet;
}

export function generateWalletKeypair(): { privateKeyHex: string; address: string } {
  const privKey = makeRandomPrivKey();
  const privateKeyHex = privateKeyToString(privKey);
  const address = getAddressFromPrivateKey(privateKeyHex, networkVersion());
  return { privateKeyHex, address };
}

export function deriveAddressFromPrivateKey(privateKeyHex: string): string {
  const normalized = privateKeyHex.endsWith("01")
    ? privateKeyHex
    : privateKeyHex;
  // Validate key is parseable before deriving address
  createStacksPrivateKey(normalized);
  return getAddressFromPrivateKey(normalized, networkVersion());
}

export async function provisionDefaultWallet(userId: number): Promise<void> {
  const db = DatabaseService.getInstance();
  const existing = await db.findWalletsByUserId(userId);
  if (existing.length > 0) return;

  const { privateKeyHex, address } = generateWalletKeypair();
  const encryptedKey = await KMSService.getInstance().encryptPrivateKey(privateKeyHex);

  await db.createWallet({
    userId,
    address,
    name: "Wallet 1",
    encryptedKey,
  });

  logger.info("Default wallet provisioned for new user", { userId, address });
}
