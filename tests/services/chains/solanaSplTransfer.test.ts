import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import bs58 from "bs58";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { SOLANA_MAINNET } from "../../../src/services/chains/descriptors/solana.js";

/**
 * Solana wallets could trade SPL tokens through Jupiter but could not send one
 * out: `transfer` refused anything that wasn't native SOL. So a user could
 * acquire a position on Solana and then have no way to move it, which on a
 * custodial wallet is the difference between holding an asset and being locked
 * out of it.
 *
 * The instructions are built by @solana/spl-token and inspected here off the
 * compiled transaction rather than through spies on the library, so these
 * assertions are about the bytes that would actually be submitted.
 */

const mockDb = {
  findWalletById: vi.fn(),
  updateTradeStatus: vi.fn(),
  prisma: { trade: { findUnique: vi.fn() } },
};
const mockRedis = {
  acquireLock: vi.fn(),
  renewLockUntilDone: vi.fn(() => () => undefined),
  releaseLock: vi.fn(),
};
const mockKms = { decryptPrivateKey: vi.fn() };

vi.mock("../../../src/services/db.js", () => ({
  DatabaseService: { getInstance: () => mockDb },
}));
vi.mock("../../../src/services/redis.js", () => ({
  RedisService: { getInstance: () => mockRedis },
}));
vi.mock("../../../src/services/kms.js", () => ({
  KMSService: { getInstance: () => mockKms },
}));

/** USDC on Solana — a real mint, used as a stand-in for any SPL token. */
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

/** The transferChecked discriminator in the SPL Token instruction enum. */
const TRANSFER_CHECKED = 12;

describe("Solana SPL transfers", () => {
  let SolanaAdapter: typeof import("../../../src/services/chains/svm/solanaAdapter.js").SolanaAdapter;
  let adapter: import("../../../src/services/chains/svm/solanaAdapter.js").SolanaAdapter;
  let sender: Keypair;
  let sent: VersionedTransaction | undefined;
  let mintOwner: PublicKey;
  let mintAccountExists: boolean;

  function fakeConnection() {
    return {
      getLatestBlockhash: vi.fn().mockResolvedValue({
        blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k",
      }),
      getAccountInfo: vi.fn(async (key: PublicKey) => {
        if (key.toBase58() === MINT) {
          return mintAccountExists ? { owner: mintOwner, data: Buffer.alloc(82) } : null;
        }
        return null;
      }),
      sendTransaction: vi.fn(async (tx: VersionedTransaction) => {
        sent = tx;
        return "sig-abc";
      }),
    };
  }

  beforeAll(async () => {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    // Not a dry run: the point is the instructions that get built.
    process.env.DRY_RUN = "false";
    if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
    if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;
    const { ConfigManager } = await import("../../../src/config.js");
    ConfigManager.reset();
    ConfigManager.load();
    ({ SolanaAdapter } = await import("../../../src/services/chains/svm/solanaAdapter.js"));
    adapter = new SolanaAdapter(SOLANA_MAINNET);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sent = undefined;
    mintOwner = TOKEN_PROGRAM_ID;
    mintAccountExists = true;
    sender = Keypair.generate();
    mockRedis.acquireLock.mockResolvedValue("lock-token");
    mockDb.findWalletById.mockResolvedValue({ id: 1, address: sender.publicKey.toBase58(), encryptedKey: "enc" });
    mockKms.decryptPrivateKey.mockResolvedValue(bs58.encode(sender.secretKey));
    vi.spyOn(adapter, "connection").mockReturnValue(fakeConnection() as never);
  });

  function transferParams(over: Record<string, unknown> = {}) {
    return {
      walletId: 1,
      senderAddress: sender.publicKey.toBase58(),
      toAddress: RECIPIENT,
      amount: 2.5,
      token: MINT,
      decimals: 6,
      ...over,
    };
  }

  /** The decoded instructions of the transaction that was actually submitted. */
  function submittedInstructions() {
    expect(sent).toBeDefined();
    const message = sent!.message;
    const keys = message.staticAccountKeys;
    return message.compiledInstructions.map((ix) => ({
      programId: keys[ix.programIdIndex]!.toBase58(),
      data: Buffer.from(ix.data),
      accounts: ix.accountKeyIndexes.map((i) => keys[i]!.toBase58()),
    }));
  }

  it("no longer refuses a non-native token", async () => {
    const result = await adapter.transfer(transferParams());
    expect(result).not.toHaveProperty("error");
    expect(result).toHaveProperty("txId");
  });

  it("uses transferChecked rather than transfer", async () => {
    // transferChecked makes the chain verify the decimals we scaled by. With
    // plain `transfer`, a wrong decimals value moves the wrong amount and
    // succeeds; here it fails.
    await adapter.transfer(transferParams());

    const ix = submittedInstructions().find((i) => i.programId === TOKEN_PROGRAM_ID.toBase58());
    expect(ix).toBeDefined();
    expect(ix!.data[0]).toBe(TRANSFER_CHECKED);
  });

  it("scales the amount by the token's decimals", async () => {
    // 2.5 at 6 decimals is 2_500_000 base units.
    await adapter.transfer(transferParams({ amount: 2.5, decimals: 6 }));

    const ix = submittedInstructions().find((i) => i.programId === TOKEN_PROGRAM_ID.toBase58())!;
    expect(ix.data.readBigUInt64LE(1)).toBe(2_500_000n);
    expect(ix.data[9]).toBe(6);
  });

  it("does not lose precision on an amount a float would round", async () => {
    // 0.1 + 0.2 territory: at 9 decimals, amount * 10 ** decimals in floating
    // point is where a transfer quietly sends the wrong number of base units.
    await adapter.transfer(transferParams({ amount: 1.005, decimals: 9 }));

    const ix = submittedInstructions().find((i) => i.programId === TOKEN_PROGRAM_ID.toBase58())!;
    expect(ix.data.readBigUInt64LE(1)).toBe(1_005_000_000n);
  });

  it("creates the recipient's associated token account idempotently", async () => {
    // A recipient who has never held this mint has no account to credit. Doing
    // it idempotently means two concurrent sends don't race each other into a
    // failure.
    await adapter.transfer(transferParams());

    const ata = submittedInstructions().find(
      (i) => i.programId === ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()
    );
    expect(ata).toBeDefined();
    expect(ata!.data[0]).toBe(1); // CreateIdempotent
  });

  it("addresses the recipient's associated token account, not their wallet", async () => {
    await adapter.transfer(transferParams());

    const expected = getAssociatedTokenAddressSync(
      new PublicKey(MINT), new PublicKey(RECIPIENT), true, TOKEN_PROGRAM_ID
    ).toBase58();

    const ix = submittedInstructions().find((i) => i.programId === TOKEN_PROGRAM_ID.toBase58())!;
    expect(ix.accounts).toContain(expected);
    expect(ix.accounts).not.toContain(RECIPIENT);
  });

  it("routes a Token-2022 mint to the Token-2022 program", async () => {
    // Token-2022 mints are owned by a different program, and building against
    // the classic program id derives the wrong account and fails at submission.
    mintOwner = TOKEN_2022_PROGRAM_ID;

    await adapter.transfer(transferParams());

    const programs = submittedInstructions().map((i) => i.programId);
    expect(programs).toContain(TOKEN_2022_PROGRAM_ID.toBase58());
    expect(programs).not.toContain(TOKEN_PROGRAM_ID.toBase58());
  });

  it("refuses when the mint cannot be read", async () => {
    // Not knowing which token program owns the mint means not knowing how to
    // build the transfer. Guessing sends to a derived address that may belong
    // to nobody.
    mintAccountExists = false;

    const result = await adapter.transfer(transferParams());

    expect(result).toHaveProperty("error");
    expect(sent).toBeUndefined();
  });

  it("still sends native SOL through the system program", async () => {
    const result = await adapter.transfer(transferParams({ token: "SOL", decimals: undefined }));

    expect(result).toHaveProperty("txId");
    const programs = submittedInstructions().map((i) => i.programId);
    expect(programs).toContain("11111111111111111111111111111111");
    expect(programs).not.toContain(TOKEN_PROGRAM_ID.toBase58());
  });
});
