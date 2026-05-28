/**
 * Re-enrich old database listings with Zillow zestimates
 * 
 * Usage: npx ts-node re-enrich-old-listings.ts
 * 
 * This script queries old listings from each platform and attempts to find
 * Zillow zestimates for their addresses, creating Property+Estimate records.
 */

import { reEnrichOldListingsFromPlatform } from "./src/db/repository";
import { logger } from "./src/utils/logger";

// Platforms to re-enrich (in order)
const PLATFORMS = ["crexi", "loopnet", "facebook", "investorlift", "craigslist_cleveland", "craigslist_columbus", "craigslist_toledo", "craigslist_milwaukee", "creative-listing"];

interface ReEnrichStats {
  platform: string;
  processed: number;
  enriched: number;
  foundNoEstimate: number;
  notFound: number;
  failed: number;
  duration_ms: number;
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log("Batch Re-enrich: Old Listings with Zillow Zestimates");
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  const allStats: ReEnrichStats[] = [];
  const startTime = Date.now();

  for (const platform of PLATFORMS) {
    console.log(`\n${"─".repeat(70)}`);
    console.log(`→ Re-enriching platform: ${platform}`);
    console.log(`${"─".repeat(70)}\n`);

    try {
      const result = await reEnrichOldListingsFromPlatform(platform, {
        limit: 100,       // Process 100 listings at a time
        concurrency: 2,   // 2 parallel requests to Zillow
      });

      allStats.push({
        platform,
        processed: result.processed,
        enriched: result.enriched,
        foundNoEstimate: result.foundNoEstimate,
        notFound: result.notFound,
        failed: result.failed,
        duration_ms: result.duration_ms,
      });

      console.log(
        `✓ ${platform}: ${result.enriched}/${result.processed} enriched, ` +
        `${result.foundNoEstimate} found (no est), ${result.notFound} not found\n`
      );
    } catch (err) {
      console.error(`✗ ${platform} error: ${err}\n`);
      allStats.push({
        platform,
        processed: 0,
        enriched: 0,
        foundNoEstimate: 0,
        notFound: 0,
        failed: 1,
        duration_ms: 0,
      });
    }
  }

  // Summary
  console.log(`\n${"═".repeat(70)}`);
  console.log("SUMMARY");
  console.log(`${"═".repeat(70)}\n`);

  const totals = {
    processed: allStats.reduce((sum, s) => sum + s.processed, 0),
    enriched: allStats.reduce((sum, s) => sum + s.enriched, 0),
    foundNoEstimate: allStats.reduce((sum, s) => sum + s.foundNoEstimate, 0),
    notFound: allStats.reduce((sum, s) => sum + s.notFound, 0),
    failed: allStats.reduce((sum, s) => sum + s.failed, 0),
  };

  const totalDuration = Date.now() - startTime;

  // Table
  console.log("Platform                | Processed | Enriched | Found-NoEst | NotFound | Failed");
  console.log("─".repeat(95));
  allStats.forEach((s) => {
    const platformPad = s.platform.padEnd(23);
    const processedPad = String(s.processed).padStart(9);
    const enrichedPad = String(s.enriched).padStart(8);
    const foundNoEstPad = String(s.foundNoEstimate).padStart(11);
    const notFoundPad = String(s.notFound).padStart(8);
    const failedPad = String(s.failed).padStart(6);
    console.log(
      `${platformPad}| ${processedPad} | ${enrichedPad} | ${foundNoEstPad} | ${notFoundPad} | ${failedPad}`
    );
  });

  console.log("─".repeat(95));
  console.log(
    `${"TOTALS".padEnd(23)}| ${String(totals.processed).padStart(9)} | ${String(totals.enriched).padStart(8)} | ${String(totals.foundNoEstimate).padStart(11)} | ${String(totals.notFound).padStart(8)} | ${String(totals.failed).padStart(6)}`
  );

  console.log(`\n📊 Success rate: ${((totals.enriched / (totals.processed || 1)) * 100).toFixed(1)}%`);
  console.log(`⏱️  Total duration: ${(totalDuration / 1000).toFixed(1)}s\n`);

  console.log(`${"═".repeat(70)}\n`);
}

main()
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  })
  .finally(() => {
    process.exit(0);
  });
