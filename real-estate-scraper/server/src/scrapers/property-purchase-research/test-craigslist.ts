import "dotenv/config";
import { CraigslistAduScraper } from "./craigslist-adu.scraper";
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
}

testCraigslistAdu().catch(console.error);
