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
import { logger } from "../../utils/logger";
import { ADU_KEYWORDS, TARGET_STATES } from "./adu-keywords";

async function main(): Promise<void> {
  logger.info("═".repeat(60));
  logger.info("ADU Property Purchase Research Scraper");
  logger.info("═".repeat(60));
  logger.info(`Target states: ${TARGET_STATES.join(", ")}`);
  logger.info(`Keywords: ${ADU_KEYWORDS.length} patterns loaded`);
  logger.info("─".repeat(60));

  const scraper = new AduResearchScraper({
    maxPages:    1,        // InvestorLift is single-page
    maxListings: 10_000,   // No artificial limit — keyword filter does the work
  });

  try {
    const results = await scraper.run();

    logger.info("═".repeat(60));
    logger.info(`ADU Research Complete — ${results.length} matches found`);
    if (results.length > 0) {
      logger.info(`Output: logs/adu-research.csv + logs/adu-research.json`);
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
