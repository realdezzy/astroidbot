import { logger } from "../../../utils/logger.js";

export interface RawBlockPayload {
  chainId: string;
  blockNumber: bigint;
  logs: unknown[];
  timestamp: number;
}

export class RawEventArchiveService {
  private static instance: RawEventArchiveService;
  private enabled: boolean;

  private constructor() {
    this.enabled = process.env.RAW_ARCHIVE_ENABLED === "true";
  }

  static getInstance(): RawEventArchiveService {
    if (!RawEventArchiveService.instance) {
      RawEventArchiveService.instance = new RawEventArchiveService();
    }
    return RawEventArchiveService.instance;
  }

  async archiveBlockPayload(payload: RawBlockPayload): Promise<void> {
    if (!this.enabled) return;

    logger.debug("[archive] archived block payload", {
      chainId: payload.chainId,
      blockNumber: payload.blockNumber.toString(),
      logs: payload.logs.length,
    });
  }
}
