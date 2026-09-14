import "dotenv/config";
import { CraigslistAduScraper } from "../sources/craigslist-adu.scraper";
import { AduResearchListing } from "../core/adu-research.parser";
import { displayAddress } from "../core/adu-csv-writer";
import { logger } from "../../utils/logger";

async function testCraigslistAdu() {
  const scraper = new CraigslistAduScraper({
    maxListings: 10,
    onMatch: async (match) => {
      logger.info(`Test match: ${match.url}`);
    },
  });

  const results = await scraper.run();
  logger.info(`Test complete. Found ${results.length} matches.`);
  for (const r of results as AduResearchListing[]) {
    logger.info(
      `  matched [${r.matchedKeyword}] ${r.title} — addr="${displayAddress(r)}" zip=${r.zip ?? ""} ` +
        `lat/lon=${r.latitude ?? "?"},${r.longitude ?? "?"} — ${r.url}`,
    );
  }
  process.exit(0);
}

testCraigslistAdu().catch(console.error);
