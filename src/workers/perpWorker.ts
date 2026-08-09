import { DatabaseService } from "../services/db.js";
import { PerpService } from "../services/perp/perpService.js";
import { DEXRegistry } from "../services/dex/dexRegistry.js";
import { NotificationService } from "../services/notificationService.js";
import { logger } from "../utils/logger.js";

export async function processPerpLiquidationCheck(): Promise<{ checked: number; liquidated: number }> {
  const db = DatabaseService.getInstance();
  const openPositions = await db.prisma.perpPosition.findMany({
    where: { status: "OPEN" },
  });

  let liquidated = 0;
  const perpService = PerpService.getInstance();
  const dex = DEXRegistry.getInstance();

  for (const position of openPositions) {
    try {
      const symbol = position.market.split("-")[0] || position.market;
      const currentPrice = await dex.getTokenPrice(symbol).catch(() => 0);
      if (currentPrice <= 0) continue;

      const isLiquidationTarget =
        position.direction === "LONG"
          ? currentPrice <= position.liquidationPrice
          : currentPrice >= position.liquidationPrice;

      if (isLiquidationTarget) {
        logger.warn("Perp position liquidation triggered", {
          positionId: position.id,
          userId: position.userId,
          currentPrice,
          liquidationPrice: position.liquidationPrice,
        });

        await perpService.closePosition(position.userId, position.id).catch(async (err) => {
          logger.error("Failed to execute perp position liquidation close", {
            positionId: position.id,
            error: err,
          });
          await db.prisma.perpPosition.update({
            where: { id: position.id },
            data: { status: "LIQUIDATED", updatedAt: new Date() },
          });
        });

        liquidated += 1;

        await NotificationService.getInstance().send({
          userId: position.userId,
          title: "Perp Position Liquidated",
          message: `Your ${position.leverage}x ${position.direction} position on ${position.market} was liquidated at $${currentPrice.toFixed(4)}.`,
          type: "ERROR",
        });
      }
    } catch (err) {
      logger.error("Error processing perp position liquidation check", {
        positionId: position.id,
        error: err,
      });
    }
  }

  return { checked: openPositions.length, liquidated };
}
