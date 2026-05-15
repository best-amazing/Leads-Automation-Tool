import { cronManager } from "../utils/cronManager";
import { SCRAPER_REGISTRY } from "../scrapers/registry";
import { runScrapers } from "../runner";
import { logger } from "../utils/logger";

const PRIORITY_SCRAPERS = ["zillow", "propwire", "redfin", "realtor"];
const REMAINING_SCRAPERS = [
  "investorlift",
  "offmarket",
  "crexi",
  "creativelisting",
  "loopnet",
  "facebook",
  "facebook_marketplace",
  "craigslist",
];

export function initializeDailyScrapeJob() {
  cronManager.createJob({
    name: "Daily Scrape (2pm WAT)",
    schedule: "0 14 * * *",
    timeZone: process.env.SCRAPE_TIMEZONE || "Africa/Lagos",
    async onTick() {
      try {
        logger.info("[cron] Daily scrape job starting");

        // Run priority scrapers first (sequentially)
        if (PRIORITY_SCRAPERS.length > 0) {
          await runScrapers({ sourceKeys: PRIORITY_SCRAPERS, factories: SCRAPER_REGISTRY });
        }

        // Then run the remaining scrapers
        const remaining = REMAINING_SCRAPERS.filter((s) => !PRIORITY_SCRAPERS.includes(s));
        if (remaining.length > 0) {
          await runScrapers({ sourceKeys: remaining, factories: SCRAPER_REGISTRY });
        }

        logger.info("[cron] Daily scrape job completed");
      } catch (err) {
        logger.error("[cron] Daily scrape job failed", err instanceof Error ? err : String(err));
      }
    },
  });
}

export default initializeDailyScrapeJob;
