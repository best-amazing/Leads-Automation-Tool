import "dotenv/config";
import { prisma } from "./db/client";
import { logger } from "./utils/logger";

/**
 * One-time reset of the redfin-adu backfill state.
 *
 * Why: Redfin listings never had descriptions (hardcoded ""), so keyword
 * matching ran against title/address only and virtually nothing matched.
 * Every scanned URL was still marked "seen" — 28k+ URLs are now permanently
 * skipped even though descriptions are available. Clearing the row makes the
 * cursor-driven sweep restart from page 0 and re-evaluate the catalog with
 * descriptions enabled (~1000 listings per run, bounded by BACKFILL_BATCH_SIZE).
 */
async function main() {
  const before = await prisma.backfillCursor.findUnique({
    where: { source: "redfin-adu" },
  });
  logger.info(
    `Before: seenIds=${Array.isArray(before?.seenIds) ? (before!.seenIds as any[]).length : "?"} ` +
    `resumeCursor=${JSON.stringify(before?.resumeCursor ?? null)}`
  );

  await prisma.backfillCursor.deleteMany({ where: { source: "redfin-adu" } });

  const after = await prisma.backfillCursor.findUnique({
    where: { source: "redfin-adu" },
  });
  logger.info(`After: ${after ? JSON.stringify(after) : "row deleted — next run starts a fresh full sweep"}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
