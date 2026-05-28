// server/test-crexi-enrichment.ts
// ─────────────────────────────────────────────────────────────────────────────
// Test script to validate unified Zillow enrichment with Crexi scraper
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from "dotenv";
dotenv.config();

import { CrexiScraper } from "./src/scrapers/crexi/crexi.scraper";
import { zillowEnrichmentService } from "./src/services/zillow-enrichment.service";
import { upsertPropertyFromEnrichment, upsertEstimateFromZillow } from "./src/db/repository";
import { logger } from "./src/utils/logger";

async function testCrexiEnrichment() {
  logger.info("═".repeat(80));
  logger.info("TEST: Crexi Scraper + Zillow Enrichment");
  logger.info("═".repeat(80));

  try {
    // Step 1: Scrape a small sample from Crexi
    logger.info("\n1️⃣  Starting Crexi scrape...");
    const scraper = new CrexiScraper({
      headless: true,
      proxyUrl: process.env.CREXI_PROXY_URL,
    });

    const crexiListings = await scraper.run();
    logger.info(`✓ Scraped ${crexiListings.length} Crexi listings`);

    if (crexiListings.length === 0) {
      logger.warn("⚠️  No Crexi listings returned — skipping enrichment test");
      return;
    }

    // Show first few listings before enrichment
    logger.info("\nFirst 3 listings before enrichment:");
    crexiListings.slice(0, 3).forEach((listing, idx) => {
      logger.info(
        `  [${idx + 1}] ${listing.address || "N/A"} | ` +
        `price: $${listing.price?.toLocaleString() ?? "?"} | ` +
        `zestimate: ${listing.zestimate ?? "N/A"}`
      );
    });

    // Step 2: Enrich with Zillow API
    logger.info("\n2️⃣  Starting Zillow enrichment...");
    const enrichedListings = await zillowEnrichmentService.enrichAllListings(
      crexiListings,
      2 // concurrency
    );

    // Show enriched results
    logger.info("\nFirst 3 listings after enrichment:");
    enrichedListings.slice(0, 3).forEach((listing, idx) => {
      logger.info(
        `  [${idx + 1}] ${listing.address || "N/A"} | ` +
        `price: $${listing.price?.toLocaleString() ?? "?"} | ` +
        `zestimate: ${listing.zestimate != null ? "$" + listing.zestimate.toLocaleString() : "N/A"}`
      );
    });

    // Count successful enrichments
    const enriched = enrichedListings.filter((l) => l.zestimate != null);
    logger.info(`\n✓ Successfully enriched ${enriched.length}/${enrichedListings.length} listings`);

    // Step 3: Create Property + Estimate records
    logger.info("\n3️⃣  Creating Property + Estimate records...");
    let propertiesCreated = 0;
    for (const listing of enrichedListings) {
      if (listing.zestimate != null && listing.address) {
        try {
          const propertyId = await upsertPropertyFromEnrichment(listing.address, listing.zpid);
          await upsertEstimateFromZillow(propertyId, listing.zestimate, listing.url);
          propertiesCreated++;
        } catch (err) {
          logger.warn(`Could not create property/estimate: ${err}`);
        }
      }
    }
    logger.info(`✓ Created ${propertiesCreated} Property+Estimate records`);

    // Summary
    logger.info("\n" + "═".repeat(80));
    logger.info("TEST COMPLETE ✓");
    logger.info("═".repeat(80));
    logger.info(`\nSummary:`);
    logger.info(`  • Crexi listings scraped: ${crexiListings.length}`);
    logger.info(`  • Successfully enriched: ${enriched.length}`);
    logger.info(`  • Property+Estimate records created: ${propertiesCreated}`);
    logger.info(`  • Enrichment success rate: ${((enriched.length / crexiListings.length) * 100).toFixed(1)}%`);

  } catch (err) {
    logger.error(`TEST FAILED: ${err}`);
    process.exit(1);
  }
}

// Run test
testCrexiEnrichment()
  .then(() => {
    logger.info("\nTest script completed successfully");
    process.exit(0);
  })
  .catch((err) => {
    logger.error(`Unhandled error: ${err}`);
    process.exit(1);
  });
