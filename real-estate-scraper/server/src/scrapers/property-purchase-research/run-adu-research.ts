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
import { AduResearchScraper } from "./adu-research.scraper";
import { ZillowAduScraper } from "./zillow-adu.scraper";

import { logger } from "../../utils/logger";
import { ADU_KEYWORDS, TARGET_STATES } from "./adu-keywords";
import { appendAduResult, writeAduResults, writeCsvOnly } from "./adu-csv-writer";
import { AduResearchListing } from "./adu-research.parser";
import { passesKeywordFilter, passesLocationFilter } from "./adu-research.scraper";
import * as fs from "fs";
import * as path from "path";
import { writeAduResearchToSheets } from "../../utils/google-sheets";

let capturedCount = 0;

async function handleMatch(listing: AduResearchListing) {
  capturedCount++;
  logger.info(`[runner] Immediate write for match #${capturedCount}: ${listing.address || listing.url}`);
  appendAduResult(listing);
  await writeAduResearchToSheets([listing]);
}

async function main(): Promise<void> {
  logger.info("═".repeat(60));
  logger.info("ADU Property Purchase Research Scraper");
  logger.info("═".repeat(60));
  logger.info(`Target states: ${TARGET_STATES.join(", ")}`);
  logger.info(`Keywords: ${ADU_KEYWORDS.length} patterns loaded`);
  logger.info("─".repeat(60));

  const investorLift = new AduResearchScraper({
    maxPages:    1,        // InvestorLift is single-page
    maxListings: 500,
    onMatch: handleMatch,
  });

  const zillow = new ZillowAduScraper({
    maxListings: 500,
    onMatch: handleMatch,
  });

  try {
    // Run sequentially to avoid OOM — each scraper holds large HTML/JSON
    // payloads in memory, running both concurrently exceeds the heap limit.
    const ilResults     = await investorLift.run();
    if (global.gc) global.gc();
    logger.info(`Memory after investorLift: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`);
    const zillowResults = await zillow.run();
    if (global.gc) global.gc();
    logger.info(`Memory after zillow: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`);

    const finalResults = [...ilResults, ...zillowResults] as AduResearchListing[];

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
      logger.info(`Outputs incrementally streamed to CSV, JSON, and Google Sheets`);
    }
    logger.info("═".repeat(60));

  } catch (err: any) {
    if (err.name === "SessionExpiredError") {
      logger.error("─".repeat(60));
      logger.error("InvestorLift session expired or missing!");
      logger.error("");
      logger.error("To fix this:");
      logger.error("  1. Log in to https://investorlift.com/marketplace/ in your browser");
      logger.error("  2. Run:  npm run session:investorlift");
      logger.error("  3. Re-run this script");
      logger.error("─".repeat(60));
    } else {
      logger.error(`ADU Research scraper failed: ${err}`);
    }
    process.exit(1);
  }
}

main();
