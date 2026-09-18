// src/scrapers/property-purchase-research/scripts/run-offmarket-adu.ts
// ─────────────────────────────────────────────────────────────────────────────
// Standalone entry point for the off-market ADU property purchase research
// scraper (offmarket.com).
//
// Usage:
//   npm run scrape:offmarket-adu
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { OffmarketAduScraper } from "../sources/offmarket-adu.scraper";
import { InvestorLiftAduScraper } from "../sources/investorlift-adu.scraper";

import { logger } from "../../../utils/logger";
import { getLastBackfillStatus } from "../../../utils/backfill-store";
import { ADU_KEYWORDS, TARGET_STATES } from "../core/adu-keywords";
import { appendAduResult } from "../core/adu-csv-writer";
import { AduResearchListing } from "../core/adu-research.parser";
import { fetchDeedTransferDate } from "../core/deed-data-resolver";
import * as fs from "fs";
import * as path from "path";
import { writeAduResearchToSheets } from "../../../utils/google-sheets";
import { validateIndianaLeadZip } from "../filters/adu-research.scraper";
import { AduDedupeTracker } from "../core/adu-dedupe-tracker";

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

export async function runOffmarketAduResearch(): Promise<void> {
  logger.info("═".repeat(60));
  logger.info("Off-Market (offmarket.com) ADU Property Purchase Research");
  logger.info("═".repeat(60));
  logger.info(`Target states: ${TARGET_STATES.join(", ")}`);
  logger.info(`Keywords: ${ADU_KEYWORDS.length} patterns loaded`);
  logger.info("─".repeat(60));

  const maxListings = Number(process.env.MAX_LISTINGS ?? 5000);

  const offmarket = new OffmarketAduScraper({
    maxListings,
    onMatch: handleMatch,
  });

  const investorlift = new InvestorLiftAduScraper({
    maxListings,
    onMatch: handleMatch,
  });

  try {
    async function runContinuous(scraper: any): Promise<AduResearchListing[]> {
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

    const investorLiftResults = await runContinuous(investorlift);
    // const offmarketResults = await runContinuous(offmarket);
    
    if (global.gc) global.gc();

    const results = [ ...investorLiftResults];

    try {
      const DEBUG_DIR = path.resolve("logs");
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
    } catch (err) {
      logger.warn(`[runner] Failed to prepare logs dir: ${err}`);
    }

    logger.info("═".repeat(60));
    logger.info(
      `Off-Market ADU Research Complete — ${results.length} matches found`,
    );
    if (results.length > 0) {
      logger.info(
        `Outputs incrementally streamed to CSV, JSON, and Google Sheets`,
      );
    }
    logger.info("═".repeat(60));
  } catch (err: any) {
    logger.error(`Off-Market ADU Research scraper failed: ${err}`);
    throw err;
  }
}

// ── Direct execution ────────────────────────────────────────────────────────
// When run as `npm run scrape:offmarket-adu`, surface failures and exit non-zero.
if (require.main === module) {
  runOffmarketAduResearch().catch(() => {
    process.exit(1);
  });
}