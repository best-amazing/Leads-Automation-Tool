// src/scrapers/property-purchase-research/run-adu-research.ts
// ─────────────────────────────────────────────────────────────────────────────
// Standalone entry point for the ADU property purchase research scraper.
//
// Usage:
//   npm run scrape:adu-research
//   node --max-old-space-size=512 -r ./polyfill-file.js -r ts-node/register \
//        src/scrapers/property-purchase-research/run-adu-research.ts
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { ZillowAduScraper } from "../sources/zillow-adu.scraper";
import { RedfinAduScraper } from "../sources/redfin-adu.scraper";
import { CraigslistAduScraper } from "../sources/craigslist-adu.scraper";
import { CrexiAduScraper } from "../sources/crexi-adu.scraper";
import { RealtorAduScraper } from "../sources/realtor-adu.scraper";
import { CreativeListingAduScraper } from "../sources/creative-listing-adu.scraper";
import { OffmarketAduScraper } from "../sources/offmarket-adu.scraper";
import {
  ColdwellBankerAduScraper,
  CB_BACKFILL_BATCH_SIZE,
} from "../sources/coldwellbanker-adu.scraper";
import { logger } from "../../../utils/logger";
import { getLastBackfillStatus } from "../../../utils/backfill-store";
import { ADU_KEYWORDS, TARGET_STATES } from "../core/adu-keywords";
import {
  appendAduResult,
  writeAduResults,
  writeCsvOnly,
} from "../core/adu-csv-writer";
import { AduResearchListing } from "../core/adu-research.parser";
import {
  passesKeywordFilter,
  passesLocationFilter,
  validateLeadZip,
  passesNewConstructionGate,
} from "../filters/adu-research.scraper";
import { resolvePublicRecords } from "../core/public-records";
import * as fs from "fs";
import * as path from "path";
import {
  flushAduSheetWrites,
  queueAduSheetWrite,
} from "../../../utils/google-sheets";
import { descriptionQueue } from "../../../utils/queue";
import { AduDedupeTracker } from "../core/adu-dedupe-tracker";

let capturedCount = 0;
const tracker = new AduDedupeTracker();

async function handleMatch(listing: AduResearchListing) {
  if (!validateLeadZip(listing)) {
    logger.warn(
      `[runner] Ignoring lead outside allowed ZIPs for its state: ${listing.address || listing.url} | zip=${String(listing.zip ?? "(missing)")}`,
    );
    return;
  }

  if (!passesNewConstructionGate(listing)) return;

  if (!(await tracker.track(listing))) {
    logger.debug(
      `[runner] Skipping duplicate: ${listing.address || listing.url}`,
    );
    return;
  }

  capturedCount++;
  logger.info(
    `[runner] Match #${capturedCount}: ${listing.address || listing.url}`,
  );

  // Deed date + year built from public records, then the final
  // new-construction check with the most complete year available.
  await resolvePublicRecords(listing, "[runner]");
  if (!passesNewConstructionGate(listing)) return;

  appendAduResult(listing);
  queueAduSheetWrite(listing);
}

export async function runAduResearch(): Promise<void> {
  logger.info("═".repeat(60));
  logger.info("ADU Property Purchase Research Scraper");
  logger.info("═".repeat(60));
  logger.info(`Target states: ${TARGET_STATES.join(", ")}`);
  logger.info(`Keywords: ${ADU_KEYWORDS.length} patterns loaded`);
  logger.info("─".repeat(60));

  const maxListings = Number(process.env.MAX_LISTINGS ?? 5000);

  const zillow = new ZillowAduScraper({
    maxListings,
    onMatch: handleMatch,
  });

  const redfin = new RedfinAduScraper({
    maxListings,
    onMatch: handleMatch,
  });

  const creativeListing = new CreativeListingAduScraper({
    maxListings,
    onMatch: handleMatch,
  });

  const craigslist = new CraigslistAduScraper({
    maxListings,
    onMatch: handleMatch,
  });

  const crexi = new CrexiAduScraper({
    maxListings,
    onMatch: handleMatch,
  });

  const realtor = new RealtorAduScraper({
    maxListings,
    onMatch: handleMatch,
  });

  const offmarket = new OffmarketAduScraper({
    maxListings,
    onMatch: handleMatch,
  });

  const coldwell = new ColdwellBankerAduScraper({
    maxListings,
    onMatch: handleMatch,
  });

  try {
    // Backpressure: once this many jobs are waiting/delayed, stop enqueueing
    // further batches this run — the next cron tick resumes from the stored
    // seen-set, so the queue never grows faster than the worker drains it.
    const maxBacklog = Number(process.env.ADU_MAX_QUEUE_BACKLOG ?? 2000);

    async function runContinuous(
      scraper: any,
      batchThreshold = Number(process.env.ADU_BACKFILL_BATCH_SIZE ?? 500),
    ): Promise<AduResearchListing[]> {
      const sourceName = scraper.sourceName;
      const allResults: AduResearchListing[] = [];
      while (true) {
        const results = await scraper.run();
        allResults.push(...(results as AduResearchListing[]));
        if (global.gc) global.gc();
        logger.info(
          `Memory after ${sourceName}: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`,
        );

        const { processedCount } = await getLastBackfillStatus(sourceName);

        const backlog =
          (await descriptionQueue.getWaitingCount()) +
          (await descriptionQueue.getDelayedCount());

        if (processedCount >= batchThreshold && backlog >= maxBacklog) {
          logger.info(
            `[runner] ${sourceName} paused — queue backlog ${backlog} >= ${maxBacklog}; resuming next run.`,
          );
          break;
        } else if (processedCount >= batchThreshold) {
          logger.info(
            `[runner] ${sourceName} backfill hit batch limit, immediately fetching next batch...`,
          );
          // Small 500ms sleep to avoid hammering the DB
          await new Promise((r) => setTimeout(r, 500));
        } else {
          logger.info(
            `[runner] ${sourceName} backfill complete or reached end of inventory.`,
          );
          break;
        }
      }
      return allResults;
    }

    // Coldwell caps each batch at CB_BACKFILL_BATCH_SIZE, so compare against
    // that — against ADU_BACKFILL_BATCH_SIZE it never ran a second batch.
    const coldwellResults = await runContinuous(coldwell, CB_BACKFILL_BATCH_SIZE);
    const redfinResults = await runContinuous(redfin);
    const creativeListingResults = await runContinuous(creativeListing);
    const craigslistResults = await runContinuous(craigslist);
    // const crexiResults = await runContinuous(crexi);
    // const realtorResults = await runContinuous(realtor);
    // const offmarketResults = await runContinuous(offmarket);
    const zillowResults = await runContinuous(zillow);
    if (global.gc) global.gc();
    await flushAduSheetWrites();

    const finalResults = [
      ...redfinResults,
      ...creativeListingResults,
      ...craigslistResults,
      // ...crexiResults,
      // ...realtorResults,
      // ...offmarketResults,
      ...zillowResults,
      ...coldwellResults,
    ];

    try {
      const DEBUG_DIR = path.resolve("logs");
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
      // Removed the intermediate CSV write as the finalResults are now fully filtered
    } catch (err) {
      logger.warn(`[runner] Failed to save combined CSV: ${err}`);
    }

    logger.info("═".repeat(60));
    logger.info(`ADU Research Complete — ${finalResults.length} matches found`);
    if (finalResults.length > 0) {
      logger.info(
        `Outputs incrementally streamed to CSV, JSON, and Google Sheets`,
      );
    }
    logger.info("═".repeat(60));
  } catch (err: any) {
    logger.error(`ADU Research scraper failed: ${err}`);
    throw err;
  }
}

// ── Direct execution ────────────────────────────────────────────────────────
// When run as `npm run scrape:adu-research`, surface failures and exit non-zero.
// The cron scheduler imports runAduResearch() instead and keeps going on error.
if (require.main === module) {
  runAduResearch().catch(() => {
    process.exit(1);
  });
}
