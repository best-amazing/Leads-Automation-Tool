#!/usr/bin/env ts-node

/**
 * Test script for FacebookCommenter tool
 *
 * This script posts the default buyer comment on specific Facebook post URLs.
 *
 * Usage:
 *   npx ts-node test-facebook-commenter.ts
 *
 * Prerequisites:
 *   1. Must have facebook-session.json (from build-fb-session.ts)
 *   2. Run from the server directory
*/

import * as fs from "fs";
import * as path from "path";
import { RawListing } from "../server/src/types/listing";
import { FacebookCommenter } from "../server/src/scrapers/facebook/facebook.commenter";
import { logger } from "../server/src/utils/logger";

const DEFAULT_COMMENT = `We are real end buyers. Please send these details and all your other deals you may have. We will underwrite them and send you our offers.
admin@amazingpropertiesusa.com`;

// Specific Facebook post URLs to comment on
const TARGET_URLS = [
  "https://web.facebook.com/groups/clevelandohiorealestatedeals/posts/1254196106527326/",
  "https://web.facebook.com/groups/milwaukeerealestate/posts/2762574010795725/",
];

// ── Main test flow ────────────────────────────────────────────────────────────

async function main() {
  logger.info(
    "═══════════════════════════════════════════════════════════════",
  );
  logger.info("Facebook Commenter Test — Specific URLs");
  logger.info(
    "═══════════════════════════════════════════════════════════════",
  );

  // ── Check session ─────────────────────────────────────────────────────────

  const sessionFile = "facebook-session.json";
  if (!fs.existsSync(sessionFile)) {
    logger.error(
      `❌ Session file not found at ${sessionFile}\n` +
        "   Run the build session script first:\n" +
        "   npx ts-node scripts/build-fb-session.ts",
    );
    process.exit(1);
  }
  logger.info("✓ Session file found");

  // ── Create listings from target URLs ──────────────────────────────────────

  const listings: RawListing[] = TARGET_URLS.map((url, idx) => ({
    url,
    source: "facebook",
    title: `Facebook Post ${idx + 1}`,
  }));

  logger.info(`✓ Created ${listings.length} listings from target URLs`);

  // ── Show comment preview ────────────────────────────────────────────────────

  logger.info("\n📝 Comment to post:");
  logger.info(
    "───────────────────────────────────────────────────────────────",
  );
  logger.info(DEFAULT_COMMENT);
  logger.info(
    "───────────────────────────────────────────────────────────────",
  );

  logger.info("\n🎯 Target URLs:");
  listings.forEach((listing, idx) => {
    logger.info(`${idx + 1}. ${listing.url}`);
  });

  // ── Post comments ────────────────────────────────────────────────────────

  logger.info("\n🚀 Starting comment posting…\n");

  const commenter = new FacebookCommenter({ headless: false });
  const results = await commenter.commentOnListings(listings, DEFAULT_COMMENT);

  // ── Results summary ───────────────────────────────────────────────────────

  logger.info(
    "\n═══════════════════════════════════════════════════════════════",
  );
  logger.info("Results Summary");
  logger.info(
    "═══════════════════════════════════════════════════════════════",
  );

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;

  logger.info(`✓ Succeeded: ${succeeded}`);
  logger.info(`✗ Failed:    ${failed}`);
  logger.info(`⊘ Skipped:   ${skipped}`);

  // Show failures
  const failedResults = results.filter((r) => !r.success && !r.skipped);
  if (failedResults.length > 0) {
    logger.warn("\nFailed listings:");
    for (const result of failedResults) {
      logger.warn(`  • ${result.listing.url}`);
      logger.warn(`    Error: ${result.error}`);
    }
  }

  // Show skipped
  const skippedResults = results.filter((r) => r.skipped);
  if (skippedResults.length > 0) {
    logger.info("\nSkipped listings:");
    for (const result of skippedResults) {
      logger.info(`  • ${result.listing.url} (${result.error})`);
    }
  }

  // Save results to file
  const resultsFile = path.join("logs", "facebook_commenter_results.json");
  try {
    const dir = path.dirname(resultsFile);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
    logger.info(`\n📄 Results saved to ${resultsFile}`);
  } catch (err) {
    logger.warn(`Could not save results: ${err}`);
  }

  logger.info(
    "\n═══════════════════════════════════════════════════════════════\n",
  );

  process.exit(succeeded === listings.length ? 0 : 1);
}

main().catch((err) => {
  logger.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
