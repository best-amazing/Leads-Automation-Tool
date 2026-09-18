// src/scrapers/property-purchase-research/scripts/run-creative-listing-adu.ts
// ─────────────────────────────────────────────────────────────────────────────
// Standalone entry point for the Creative Listing ADU property purchase
// research scraper.
//
// Usage:
//   npm run scrape:creative-listing-adu
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { CreativeListingAduScraper } from "../sources/creative-listing-adu.scraper";

import { logger } from "../../../utils/logger";
import { getLastBackfillStatus } from "../../../utils/backfill-store";
import { ADU_KEYWORDS, TARGET_STATES } from "../core/adu-keywords";
import { appendAduResult } from "../core/adu-csv-writer";
import { AduResearchListing } from "../core/adu-research.parser";
import { AduDedupeTracker } from "../core/adu-dedupe-tracker";
import { validateIndianaLeadZip } from "../filters/adu-research.scraper";
import { fetchDeedTransferDate } from "../core/deed-data-resolver";
import * as fs from "fs";
import * as path from "path";
import { writeAduResearchToSheets } from "../../../utils/google-sheets";

let capturedCount = 0;
const tracker = new AduDedupeTracker();

async function handleMatch(listing: AduResearchListing) {
  if (!validateIndianaLeadZip(listing)) {
    logger.warn(
      `[runner] Ignoring Indiana lead with non-46xxx ZIP: ${listing.address || listing.url} | zip=${String(listing.zip ?? "(missing)")}`,
    );
    return;
  }

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

  // ── Inline deed transfer date lookup ──────────────────────────────────
  if (listing.address) {
    try {
      logger.info(
        `[runner] Looking up deed transfer date for: ${listing.address}`,
      );
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

export async function runCreativeListingAduResearch(): Promise<void> {
  logger.info("═".repeat(60));
  logger.info("Creative Listing ADU Property Purchase Research Scraper");
  logger.info("═".repeat(60));
  logger.info(`Target states: ${TARGET_STATES.join(", ")}`);
  logger.info(`Keywords: ${ADU_KEYWORDS.length} patterns loaded`);
  logger.info("─".repeat(60));

  const maxListings = Number(process.env.MAX_LISTINGS ?? 5000);

  const creativeListing = new CreativeListingAduScraper({
    maxListings,
    onMatch: handleMatch,
  });

  try {
    async function runContinuous(
      scraper: CreativeListingAduScraper,
    ): Promise<AduResearchListing[]> {
      const sourceName = scraper.sourceName;
      const allResults: AduResearchListing[] = [];
      while (true) {
        const results = (await scraper.run()) as AduResearchListing[];
        allResults.push(...results);
        if (global.gc) global.gc();
        logger.info(
          `Memory after ${sourceName}: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`,
        );

        const { processedCount } = await getLastBackfillStatus(sourceName);

        if (
          processedCount >= Number(process.env.ADU_BACKFILL_BATCH_SIZE ?? 500)
        ) {
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

    const finalResults = await runContinuous(creativeListing);
    if (global.gc) global.gc();

    try {
      const DEBUG_DIR = path.resolve("logs");
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
    } catch (err) {
      logger.warn(`[runner] Failed to save combined CSV: ${err}`);
    }

    logger.info("═".repeat(60));
    logger.info(
      `Creative Listing ADU Research Complete — ${finalResults.length} matches found`,
    );
    if (finalResults.length > 0) {
      logger.info(
        `Outputs incrementally streamed to CSV, JSON, and Google Sheets`,
      );
    }
    logger.info("═".repeat(60));
  } catch (err: any) {
    logger.error(`Creative Listing ADU Research scraper failed: ${err}`);
    throw err;
  }
}

// ── Direct execution ────────────────────────────────────────────────────────
// When run as `npm run scrape:creative-listing-adu`, surface failures and exit
// non-zero.
if (require.main === module) {
  runCreativeListingAduResearch().catch(() => {
    process.exit(1);
  });
}