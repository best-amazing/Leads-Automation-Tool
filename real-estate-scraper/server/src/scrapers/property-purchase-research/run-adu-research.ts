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
import { writeAduResults, writeCsvOnly } from "./adu-csv-writer";
import { AduResearchListing } from "./adu-research.parser";
import { passesKeywordFilter, passesLocationFilter } from "./adu-research.scraper";
import * as fs from "fs";
import * as path from "path";
import { writeAduResearchToSheets } from "../../utils/google-sheets";

async function main(): Promise<void> {
  logger.info("═".repeat(60));
  logger.info("ADU Property Purchase Research Scraper");
  logger.info("═".repeat(60));
  logger.info(`Target states: ${TARGET_STATES.join(", ")}`);
  logger.info(`Keywords: ${ADU_KEYWORDS.length} patterns loaded`);
  logger.info("─".repeat(60));

  const investorLift = new AduResearchScraper({
    maxPages:    1,        // InvestorLift is single-page
    maxListings: 100,
  });

  const zillow = new ZillowAduScraper({
    maxListings: 100,
  });

  try {
    const [ilResults, zillowResults] = await Promise.all([
      investorLift.run(),
      zillow.run()
    ]);

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
      const { csvPath, jsonPath } = writeAduResults(finalResults);
      logger.info(`Output: ${csvPath} + ${jsonPath}`);
      await writeAduResearchToSheets(finalResults);
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
