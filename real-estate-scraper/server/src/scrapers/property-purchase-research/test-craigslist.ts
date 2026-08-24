import "dotenv/config";
import { CraigslistAduScraper } from "./craigslist-adu.scraper";
import { AduResearchListing } from "./adu-research.parser";
import { logger } from "../../utils/logger";

async function testCraigslistAdu() {
  const scraper = new CraigslistAduScraper({
    maxListings: 10,
    onMatch: async (match) => {
      logger.info(`Test match: ${match.url}`);
    }
  });

  const results = await scraper.run();
  logger.info(`Test complete. Found ${results.length} matches.`);
  for (const r of results as AduResearchListing[]) {
    logger.info(`  matched [${r.matchedKeyword}] ${r.title} — ${r.url}`);
  }
  process.exit(0);
}

testCraigslistAdu().catch(console.error);
