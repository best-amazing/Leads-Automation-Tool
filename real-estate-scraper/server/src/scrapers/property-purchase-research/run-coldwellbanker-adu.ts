// src/scrapers/property-purchase-research/run-coldwellbanker-adu.ts
// ─────────────────────────────────────────────────────────────────────────────
// Standalone entry point for the Coldwell Banker ADU research scraper.
//
// Usage:
//   npm run scrape:coldwellbanker
//   CB_INVENTORY_MODE=full npm run scrape:coldwellbanker   # one-time backfill
//
// Env:
//   CB_INVENTORY_MODE         new-day | new-week | full   (default: new-day)
//   CB_BACKFILL_BATCH_SIZE    max listings per run()      (default: 1000)
//   CB_CONCURRENCY            parallel detail fetches     (default: 3)
//   CB_DELAY_MS               politeness delay per worker (default: 1000)
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { ColdwellBankerAduScraper } from "./coldwellbanker-adu.scraper";

import { logger } from "../../utils/logger";
import { getLastBackfillStatus } from "../../utils/backfill-store";
import { TARGET_STATES } from "./adu-keywords";
import { appendAduResult } from "./adu-csv-writer";
import { AduResearchListing } from "./adu-research.parser";
import { fetchDeedTransferDate } from "./deed-data-resolver";
import { writeAduResearchToSheets } from "../../utils/google-sheets";

let capturedCount = 0;
const seenKeys = new Set<string>();

function dedupKey(listing: AduResearchListing): string {
  if (listing.address) {
    return listing.address.replace(/\s+/g, " ").trim().toLowerCase();
  }
  return listing.url ?? "";
}

async function handleMatch(listing: AduResearchListing) {
  const key = dedupKey(listing);
  if (seenKeys.has(key)) {
    logger.debug(`[runner] Skipping duplicate: ${listing.address || listing.url}`);
    return;
  }
  seenKeys.add(key);

  capturedCount++;
  logger.info(`[runner] Match #${capturedCount}: ${listing.address || listing.url}`);

  // ── Inline deed transfer date lookup (same as zillow/redfin pipeline) ──
  if (listing.address) {
    try {
      logger.info(`[runner] Looking up deed transfer date for: ${listing.address}`);
      const deedDate = await fetchDeedTransferDate({
        address: listing.address,
        city: listing.city,
        state: listing.state,
        zip: listing.zip,
        latitude: listing.latitude,
        longitude: listing.longitude,
      });
      if (deedDate) {
        listing.deedTransferDate = deedDate;
        logger.info(`[runner] ✓ Deed transfer date: ${deedDate}`);
      } else {
        logger.info(`[runner] ✗ No deed transfer date found`);
      }
    } catch (err) {
      logger.warn(`[runner] Deed date lookup failed: ${err}`);
    }
  }

  appendAduResult(listing);
  await writeAduResearchToSheets([listing]);
}

export async function runColdwellBankerAduResearch(): Promise<void> {
  logger.info("═".repeat(60));
  logger.info("Coldwell Banker ADU Research Scraper");
  logger.info("═".repeat(60));
  logger.info(`Target states: ${TARGET_STATES.join(", ")}`);
  logger.info(`Inventory mode: ${process.env.CB_INVENTORY_MODE ?? "new-day"}`);
  logger.info("─".repeat(60));

  const maxListings = Number(process.env.MAX_LISTINGS ?? 5000);

  const coldwell = new ColdwellBankerAduScraper({
    maxListings,
    onMatch: handleMatch,
  });

  try {
    // Same contract as zillow/redfin backfill: keep fetching batches while
    // the last batch hit the cap, so a full-inventory sweep progresses
    // batch-by-batch within a single invocation.
    const allResults: AduResearchListing[] = [];
    while (true) {
      const results = await coldwell.run();
      allResults.push(...(results as AduResearchListing[]));
      if (global.gc) global.gc();
      logger.info(
        `Memory after coldwellbanker-adu: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`
      );

      const { processedCount } = await getLastBackfillStatus(coldwell.sourceName);
      if (processedCount >= Number(process.env.CB_BACKFILL_BATCH_SIZE ?? 500)) {
        logger.info(`[runner] coldwellbanker-adu hit batch limit, immediately fetching next batch...`);
        await new Promise((r) => setTimeout(r, 500));
      } else {
        logger.info(`[runner] coldwellbanker-adu backfill complete or reached end of inventory.`);
        break;
      }
    }

    logger.info("═".repeat(60));
    logger.info(`Coldwell Banker ADU Research Complete — ${allResults.length} matches found`);
    if (allResults.length > 0) {
      logger.info(`Outputs incrementally streamed to CSV, JSON, and Google Sheets`);
    }
    logger.info("═".repeat(60));
  } catch (err: any) {
    logger.error(`Coldwell Banker ADU scraper failed: ${err}`);
    throw err;
  }
}

if (require.main === module) {
  runColdwellBankerAduResearch().catch(() => {
    process.exit(1);
  });
}
