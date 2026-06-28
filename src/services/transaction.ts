import {
  makeContractCall,
  makeSTXTokenTransfer,
  broadcastTransaction,
  AnchorMode,
  PostConditionMode,
  FungibleConditionCode,
  createSTXPostCondition,
  createFungiblePostCondition,
  Cl,
  type ClarityValue,
} from "@stacks/transactions";
import { StacksMainnet, StacksTestnet, StacksMocknet } from "@stacks/network";
import axios from "axios";
import { ConfigManager } from "../config.js";
import { logger } from "../utils/logger.js";
import { DatabaseService } from "./db.js";
import { KMSService } from "./kms.js";
import { RedisService } from "./redis.js";
import type { RebalanceAction } from "../types.js";

export class TransactionService {
  private static instance: TransactionService;
  private readonly network: StacksMainnet | StacksTestnet | StacksMocknet;

  private constructor() {
    const config = ConfigManager.getInstance().config;

    switch (config.STACKS_NETWORK) {
      case "mainnet":
        this.network = new StacksMainnet({ url: config.STACKS_API_URL });
        break;
      case "testnet":
        this.network = new StacksTestnet({ url: config.STACKS_API_URL });
        break;
      case "mocknet":
        this.network = new StacksMocknet({ url: config.STACKS_API_URL });
        break;
    }
  }

  static getInstance(): TransactionService {
    if (!TransactionService.instance) {
      TransactionService.instance = new TransactionService();
    }
    return TransactionService.instance;
  }

  async execute(
    action: RebalanceAction,
    contractAddress: string,
    contractName: string,
    functionName: string,
    functionArgs: any[],
    walletId: number,
    senderAddress: string,
    maxOutbound: number,
    useGasless = false,
    postConditionsOverride?: any[]
  ): Promise<{ txId: string } | { error: string }> {
    const db = DatabaseService.getInstance();
    const redis = RedisService.getInstance();
    const lockKey = `wallet:${walletId}`;
    const lockAcquired = await redis.acquireLock(lockKey, 30_000);

    if (!lockAcquired) {
      return { error: `Wallet ${walletId} is busy executing another transaction` };
    }

    try {
      const wallet = await db.findWalletById(walletId);
      if (!wallet) {
        return { error: `Wallet ${walletId} not found` };
      }

      const privateKey = await KMSService.getInstance().decryptPrivateKey(wallet.encryptedKey);
      const nonce = await redis.getAndIncrementNonce(senderAddress, () =>
        this.fetchOnChainNonce(senderAddress)
      );

      const feeRate = await this.fetchFeeRate();
      const txFee = BigInt(Math.max(10_000, Math.floor(400 * feeRate * 1.2)));

      const postConditions = postConditionsOverride && postConditionsOverride.length > 0
        ? postConditionsOverride
        : this.buildPostConditions(action, senderAddress, contractAddress, txFee);

      const parsedArgs = (functionArgs.length > 0 && typeof functionArgs[0] !== "string")
        ? (functionArgs as ClarityValue[])
        : parseClarityArgs(functionArgs as string[]);

      const tx = await makeContractCall({
        contractAddress,
        contractName,
        functionName,
        functionArgs: parsedArgs,
        fee: txFee,
        nonce,
        senderKey: privateKey,
        network: this.network,
        anchorMode: AnchorMode.Any,
        postConditionMode: PostConditionMode.Allow,
        postConditions,
      });

      const config = ConfigManager.getInstance().config;

      if (config.DRY_RUN) {
        logger.info("DRY RUN: would broadcast transaction", {
          contractAddress,
          contractName,
          functionName,
          nonce,
          sender: senderAddress,
          gasless: useGasless,
        });
        return { txId: "dry-run-tx-id" };
      }

      let txId: string;

      if (useGasless && config.VELUMX_RELAYER_URL && config.VELUMX_API_KEY) {
        txId = await this.broadcastViaVelumX(tx, config.VELUMX_RELAYER_URL, config.VELUMX_API_KEY);
      } else {
        const result = await broadcastTransaction(tx, this.network);
        if ("error" in result && result.error) {
          logger.error("Transaction broadcast rejected by node", {
            error: result.error,
            reason: result.reason,
            reasonData: result.reason_data,
            nonce,
            sender: senderAddress,
          });
          throw new Error(`Broadcast failed: ${result.error} - ${result.reason || ""}`);
        }
        txId = result.txid;
      }

      logger.info("Transaction broadcast", { txId, nonce, sender: senderAddress, gasless: useGasless });
      return { txId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Transaction failed", { error: message, action });
      await redis.clearNonceCache(senderAddress);
      return { error: message };
    } finally {
      await redis.releaseLock(lockKey);
    }
  }

  async transfer(
    walletId: number,
    senderAddress: string,
    toAddress: string,
    amount: number,
    token: string, // "STX" or contractId (e.g. "SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-token")
    decimals = 6
  ): Promise<{ txId: string } | { error: string }> {
    const db = DatabaseService.getInstance();
    const redis = RedisService.getInstance();
    const lockKey = `wallet:${walletId}`;
    const lockAcquired = await redis.acquireLock(lockKey, 30_000);

    if (!lockAcquired) {
      return { error: `Wallet ${walletId} is busy executing another transaction` };
    }

    try {
      const wallet = await db.findWalletById(walletId);
      if (!wallet) {
        return { error: `Wallet ${walletId} not found` };
      }

      const privateKey = await KMSService.getInstance().decryptPrivateKey(wallet.encryptedKey);
      const nonce = await redis.getAndIncrementNonce(senderAddress, () =>
        this.fetchOnChainNonce(senderAddress)
      );

      const feeRate = await this.fetchFeeRate();
      const txSize = token === "STX" ? 180 : 250;
      const minFee = token === "STX" ? 3_000 : 5_000;
      const txFee = BigInt(Math.max(minFee, Math.floor(txSize * feeRate * 1.2)));

      let tx;

      if (token === "STX") {
        tx = await makeSTXTokenTransfer({
          recipient: toAddress,
          amount: BigInt(Math.floor(amount * 1_000_000)),
          fee: txFee,
          nonce,
          senderKey: privateKey,
          network: this.network,
          anchorMode: AnchorMode.Any,
        });
      } else {
        // SIP-010 token transfer
        const [contractAddress, contractName] = token.split(".");
        if (!contractAddress || !contractName) {
          throw new Error("Invalid token contract ID");
        }

        const senderPrincipal = senderAddress.includes(".")
          ? Cl.contractPrincipal(senderAddress.split(".")[0]!, senderAddress.split(".")[1]!)
          : Cl.standardPrincipal(senderAddress);

        const recipientPrincipal = toAddress.includes(".")
          ? Cl.contractPrincipal(toAddress.split(".")[0]!, toAddress.split(".")[1]!)
          : Cl.standardPrincipal(toAddress);

        const rawAmount = BigInt(Math.floor(amount * (10 ** decimals)));
        const functionArgs = [
          Cl.uint(rawAmount),
          senderPrincipal,
          recipientPrincipal,
          Cl.none()
        ];

        tx = await makeContractCall({
          contractAddress,
          contractName,
          functionName: "transfer",
          functionArgs,
          fee: txFee,
          nonce,
          senderKey: privateKey,
          network: this.network,
          anchorMode: AnchorMode.Any,
          postConditionMode: PostConditionMode.Allow,
        });
      }

      const config = ConfigManager.getInstance().config;
      if (config.DRY_RUN) {
        logger.info("DRY RUN: would broadcast transfer", {
          token,
          amount,
          toAddress,
          sender: senderAddress,
        });
        return { txId: "dry-run-tx-id" };
      }

      const result = await broadcastTransaction(tx, this.network);
      if ("error" in result && result.error) {
        logger.error("Transfer transaction broadcast rejected by node", {
          error: result.error,
          reason: result.reason,
          reasonData: result.reason_data,
          nonce,
          sender: senderAddress,
        });
        throw new Error(`Broadcast failed: ${result.error} - ${result.reason || ""}`);
      }
      const txId = result.txid;

      logger.info("Transfer transaction broadcast", { txId, nonce, sender: senderAddress, token, amount });
      return { txId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Transfer failed", { error: message, token, amount, toAddress });
      await redis.clearNonceCache(senderAddress);
      return { error: message };
    } finally {
      await redis.releaseLock(lockKey);
    }
  }

  async confirmTransaction(txId: string, tradeId: number): Promise<boolean> {

    if (txId === "dry-run-tx-id") {
      logger.info("DRY RUN: skipping confirmation for dry-run tx");
      return true;
    }

    const maxAttempts = 20;
    const pollIntervalMs = 30_000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await this.fetchTransactionStatus(txId);

        if (result.status === "success") {
          await DatabaseService.getInstance().updateTradeStatus(tradeId, "CONFIRMED", txId);
          await DatabaseService.getInstance().prisma.limitOrder.updateMany({
            where: { txId },
            data: { status: "FILLED", filledAt: new Date() },
          });
          logger.info("Transaction confirmed", { txId, attempt });
          return true;
        }

        if (result.status === "aborted_by_response" || result.status === "aborted_by_post_condition") {
          await DatabaseService.getInstance().updateTradeStatus(
            tradeId,
            "FAILED",
            txId,
            `Transaction failed with status: ${result.status}`
          );
          await DatabaseService.getInstance().prisma.limitOrder.updateMany({
            where: { txId },
            data: { status: "ACTIVE", txId: null },
          });
          logger.warn("Transaction failed", { txId, status: result.status });
          return false;
        }

        logger.debug("Transaction still pending", { txId, attempt, status: result.status });
        await this.sleep(pollIntervalMs);
      } catch {
        logger.warn("Failed to fetch tx status, retrying", { txId, attempt });
        await this.sleep(pollIntervalMs);
      }
    }

    logger.warn("Transaction confirmation timed out", { txId });
    return false;
  }

  // Broadcasts transaction via the VelumX relayer for gasless execution.
  private async broadcastViaVelumX(
    tx: Awaited<ReturnType<typeof makeContractCall>>,
    relayerUrl: string,
    apiKey: string
  ): Promise<string> {
    const serialized = Buffer.from(tx.serialize()).toString("hex");
    const response = await this.fetchWithFallback(relayerUrl + "/v1/relay", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({ tx: serialized }),
    });
    const txId: string | undefined = response.txId ?? response.txid;
    if (!txId) {
      throw new Error("VelumX relayer returned no txId");
    }
    logger.info("Transaction relayed via VelumX", { txId });
    return txId;
  }

  // Fetches nonces from the Stacks API with fallback node support.
  private async fetchOnChainNonce(address: string): Promise<number> {
    const config = ConfigManager.getInstance().config;
    const urls = [
      config.STACKS_API_URL,
      ...config.STACKS_FALLBACK_API_URLS
        .split(",")
        .map((u) => u.trim())
        .filter(Boolean),
    ];

    for (const url of urls) {
      try {
        const response = await axios.get(
          `${url}/extended/v1/address/${address}/nonces`,
          { timeout: 5000 }
        );
        const possibleNextNonce = response.data?.possible_next_nonce ?? 0;
        const pendingNonces = response.data?.pending_tx_nonces ?? [];
        logger.info("Fetched nonce from chain", {
          address,
          possibleNextNonce,
          pendingNonces,
          url,
        });
        return possibleNextNonce;
      } catch (err) {
        logger.warn("RPC node failed, trying fallback", {
          url,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.error("All RPC nodes failed for nonce fetch, defaulting to 0");
    return 0;
  }

  // Fetches the current fee rate (in microSTX/byte) from the Stacks API
  private async fetchFeeRate(): Promise<number> {
    const config = ConfigManager.getInstance().config;
    const urls = [
      config.STACKS_API_URL,
      ...config.STACKS_FALLBACK_API_URLS
        .split(",")
        .map((u) => u.trim())
        .filter(Boolean),
    ];

    for (const url of urls) {
      try {
        const response = await axios.get(
          `${url}/v2/fees/transfer`,
          { timeout: 5000 }
        );
        const rate = response.data?.fee_rate;
        if (typeof rate === "number") {
          return rate;
        }
      } catch (err) {
        logger.warn("Failed to fetch fee rate, trying fallback", {
          url,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Default rate if all fails (approx 50 microSTX/byte)
    return 50;
  }

  // Fetches transaction status with RPC failover.
  private async fetchTransactionStatus(txId: string): Promise<{ status: string }> {
    const config = ConfigManager.getInstance().config;
    const urls = [
      config.STACKS_API_URL,
      ...config.STACKS_FALLBACK_API_URLS
        .split(",")
        .map((u) => u.trim())
        .filter(Boolean),
    ];

    for (const url of urls) {
      try {
        const response = await axios.get(
          `${url}/extended/v1/tx/${txId}`,
          { timeout: 5000 }
        );
        return { status: response.data?.tx_status ?? "pending" };
      } catch {
        logger.warn("RPC node failed during status check, trying fallback", { url, txId });
      }
    }

    return { status: "pending" };
  }

  // Generic HTTP fetch helper with optional body (used for VelumX relay).
  private async fetchWithFallback(
    url: string,
    options: { method: string; headers: Record<string, string>; body?: string }
  ): Promise<Record<string, string>> {
    const response = await axios({
      url,
      method: options.method,
      headers: options.headers,
      data: options.body,
      timeout: 10_000,
    });
    return response.data as Record<string, string>;
  }

  private buildPostConditions(
    action: RebalanceAction,
    senderAddress: string,
    contractAddress: string,
    txFee: bigint
  ) {
    const postConditions = [];

    if (action.direction === "BUY") {
      const stxLimit = BigInt(Math.floor(action.amountIn * 1e6)) + txFee;
      postConditions.push(
        createSTXPostCondition(senderAddress, FungibleConditionCode.LessEqual, stxLimit)
      );
    } else if (action.direction === "SELL") {
      const assetInfo = action.tokenIn.includes(".")
        ? action.tokenIn
        : `${contractAddress}.${action.tokenIn.split(".").pop() ?? action.tokenIn}`;

      postConditions.push(
        createFungiblePostCondition(
          senderAddress,
          FungibleConditionCode.LessEqual,
          BigInt(Math.floor(action.amountIn * 1e6)),
          assetInfo
        )
      );
      postConditions.push(
        createSTXPostCondition(senderAddress, FungibleConditionCode.LessEqual, txFee)
      );
    }

    return postConditions;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export function parseClarityArgs(args: string[]): ClarityValue[] {
  return args.map((arg) => {
    if (arg.startsWith("u")) {
      return Cl.uint(arg.slice(1));
    }
    if (arg.startsWith("'")) {
      const val = arg.slice(1);
      if (val.includes(".")) {
        const [addr, name] = val.split(".");
        return Cl.contractPrincipal(addr ?? val, name ?? val);
      }
      return Cl.stringAscii(val);
    }
    return Cl.stringAscii(arg);
  });
}

export function getNextNonce(
  cache: Record<string, number>,
  address: string,
  initialValue?: number
): number {
  if (cache[address] !== undefined) {
    const next = cache[address] + 1;
    cache[address] = next;
    return next;
  }
  const start = initialValue ?? 0;
  cache[address] = start;
  return start;
}

export function shouldContinuePolling(
  status: string,
  attempt: number,
  maxAttempts: number
): boolean {
  if (status === "success") return false;
  if (status.startsWith("abort")) return false;
  if (attempt >= maxAttempts) return false;
  return true;
}

export function validateMaxOutbound(amountOut: number, maxAllowed: number): boolean {
  return amountOut <= maxAllowed;
}
