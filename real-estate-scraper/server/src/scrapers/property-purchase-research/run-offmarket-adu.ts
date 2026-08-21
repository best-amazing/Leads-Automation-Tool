// src/scrapers/property-purchase-research/run-offmarket-adu.ts
// ─────────────────────────────────────────────────────────────────────────────
// Standalone entry point for the off-market ADU property purchase research scraper
// (InvestorLift and Crexi).
//
// Usage:
//   npm run scrape:offmarket-adu
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { AduResearchScraper } from "./adu-research.scraper";
import { CrexiAduScraper } from "./crexi-adu.scraper";

import { logger } from "../../utils/logger";
import { getLastBackfillStatus } from "../../utils/backfill-store";
import { ADU_KEYWORDS, TARGET_STATES } from "./adu-keywords";
import { appendAduResult } from "./adu-csv-writer";
import { AduResearchListing } from "./adu-research.parser";
import { fetchDeedTransferDate } from "./deed-data-resolver";
import * as fs from "fs";
import * as path from "path";
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

  // ── Inline deed transfer date lookup ──────────────────────────────────
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

export async function runOffmarketAduResearch(): Promise<void> {
  logger.info("═".repeat(60));
  logger.info("Off-Market ADU Property Purchase Research Scraper");
  logger.info("═".repeat(60));
  logger.info(`Target states: ${TARGET_STATES.join(", ")}`);
  logger.info(`Keywords: ${ADU_KEYWORDS.length} patterns loaded`);
  logger.info("─".repeat(60));

  const maxListings = Number(process.env.MAX_LISTINGS ?? 5000);

  const investorlift = new AduResearchScraper({
    maxListings,
    onMatch: handleMatch,
  });

  const crexi = new CrexiAduScraper({
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
        logger.info(`Memory after ${sourceName}: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`);

        const { processedCount } = await getLastBackfillStatus(sourceName);

        if (processedCount >= 1000) {
          logger.info(`[runner] ${sourceName} backfill hit batch limit, immediately fetching next batch...`);
          // Add a small 2-second sleep to prevent spamming
          await new Promise(r => setTimeout(r, 2000));
        } else {
          logger.info(`[runner] ${sourceName} backfill complete or reached end of inventory.`);
          break;
        }
      }
      return allResults;
    }

    const ilResults = await runContinuous(investorlift);
    const crexiResults = await runContinuous(crexi);
    if (global.gc) global.gc();

    const finalResults = [...ilResults, ...crexiResults];

    try {
      const DEBUG_DIR = path.resolve("logs");
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
    } catch (err) {
      logger.warn(`[runner] Failed to save combined CSV: ${err}`);
    }

    logger.info("═".repeat(60));
    logger.info(`Off-Market ADU Research Complete — ${finalResults.length} matches found`);
    if (finalResults.length > 0) {
      logger.info(`Outputs incrementally streamed to CSV, JSON, and Google Sheets`);
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
