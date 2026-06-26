import { logger } from "../utils/logger.js";
import { encrypt, decrypt } from "../utils/crypto.js";

export class KMSService {
  private static instance: KMSService;

  private constructor() {
  }

  static getInstance(): KMSService {
    if (!KMSService.instance) {
      KMSService.instance = new KMSService();
    }
    return KMSService.instance;
  }

  async encryptPrivateKey(privateKey: string): Promise<string> {
    try {
      return encrypt(privateKey);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Local key encryption failed", { error: msg });
      throw new Error(`Failed to encrypt private key: ${msg}`);
    }
  }

  async decryptPrivateKey(encryptedKey: string): Promise<string> {
    try {
      return decrypt(encryptedKey);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Local key decryption failed", { error: msg });
      throw new Error(`Failed to decrypt private key: ${msg}`);
    }
  }
}
