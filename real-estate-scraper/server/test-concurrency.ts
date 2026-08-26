import { CraigslistAduScraper } from "./src/scrapers/property-purchase-research/craigslist-adu.scraper";
import { logger } from "./src/utils/logger";

// Force a tiny batch size so it stops quickly
process.env.ADU_BACKFILL_BATCH_SIZE = "5";
process.env.ADU_DETAIL_CONCURRENCY = "2"; // 2 at a time

// Monkeypatch the DB load so it forgets what it has seen
import * as BackfillStore from "./src/utils/backfill-store";
(BackfillStore as any).loadSeenListings = async () => [];
(BackfillStore as any).saveSeenListings = async () => {};

async function test() {
  logger.info("=== Starting Concurrency Test ===");
  
  const scraper = new CraigslistAduScraper({
    maxListings: 5,
    onMatch: async (listing) => {
      logger.info(`Found match: ${listing.url}`);
    }
  });

  await scraper.run();
  
  logger.info("=== Concurrency Test Finished ===");
}

test().catch(console.error);
