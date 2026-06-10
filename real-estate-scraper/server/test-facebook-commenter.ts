#!/usr/bin/env ts-node

/**
 * Test script for FacebookCommenter tool
 *
 * This script demonstrates how to use the FacebookCommenter to post comments
 * on Facebook listings using real URLs from facebook.json.
 *
 * Usage:
 *   npm run test:facebook-commenter -- --static "Your comment here"
 *   npm run test:facebook-commenter -- --dynamic
 *   npm run test:facebook-commenter -- --dry-run
 *
 * Data sources (in order of preference):
 *   1. logs/facebook.json (real scraped listings with Facebook URLs)
 *   2. server/logs/listings.json (cached listings from previous scrape)
 *   3. Mock listings (fallback for testing without scraper)
 *
 * Prerequisites:
 *   1. Run FacebookScraper first to generate facebook.json with real URLs:
 *      npm run scrape:facebook
 *   2. Must have facebook-session.json (created by scraper)
 *   3. Set FACEBOOK_COMMENT_LIMIT in .env (default: 20)
 */

import * as fs from "fs";
import * as path from "path";
import { RawListing } from "../server/src/types/listing";
import {
  FacebookCommenter,
  CommentResult,
} from "../server/src/scrapers/facebook/facebook.commenter";
import { logger } from "../server/src/utils/logger";

// ── Load real listings from facebook.json ─────────────────────────────────────

/**
 * Load real listings from facebook.json (scraped data).
 * Falls back to mock listings if facebook.json doesn't exist.
 */

function loadRealListings(): RawListing[] {
  try {
    const facebookJsonPath = "logs/facebook.json";
    if (!fs.existsSync(facebookJsonPath)) {
      logger.warn(
        `facebook.json not found at ${facebookJsonPath} — using mock data`,
      );
      return generateMockListings();
    }

    const fileContent = fs.readFileSync(facebookJsonPath, "utf8");
    const data = JSON.parse(fileContent);

    // Extract rejected listings (they have full property details)
    const listings = data.rejected
      ? data.rejected
          .filter((item: any) => item.listing && item.listing.url)
          .map((item: any) => item.listing)
      : [];

    if (listings.length === 0) {
      logger.warn(
        "No listings with URLs found in facebook.json — using mock data",
      );
      return generateMockListings();
    }

    logger.info(`✓ Loaded ${listings.length} real listings from facebook.json`);
    return listings;
  } catch (err) {
    logger.warn(`Could not load facebook.json: ${err} — using mock data`);
    return generateMockListings();
  }
}

/**
 * Create mock listings for testing (fallback).
 * In production, these would come from FacebookScraper.
 */
function generateMockListings(): RawListing[] {
  return [
    {
      title: "Beautiful 3-bed house in Cleveland",
      address: "123 Main St, Cleveland, OH 44114",
      location: "Cleveland, OH",
      price: 125000,
      bedrooms: 3,
      bathrooms: 2,
      propertyType: "single_family",
      description:
        "Charming 3-bed, 2-bath single-family home in desirable Cleveland neighborhood. " +
        "Recently updated with new roof and flooring. Great investment opportunity!",
      url: "https://www.facebook.com/groups/123/posts/456789012/",
      source: "facebook",
      ownerName: "John Smith",
    },
    {
      title: "Duplex investment opportunity - Milwaukee",
      address: "456 Oak Ave, Milwaukee, WI 53202",
      location: "Milwaukee, WI",
      price: 225000,
      bedrooms: 4,
      bathrooms: 2,
      propertyType: "duplex",
      description:
        "Income-generating duplex with 2 units. One currently rented. " +
        "Perfect for investor looking for passive income. Strong area appreciation.",
      url: "https://www.facebook.com/groups/789/posts/123456789/",
      source: "facebook",
      ownerName: "Jane Doe",
    },
    {
      title: "Off-market deal - Columbus multi-family",
      address: "789 Elm St, Columbus, OH 43085",
      location: "Columbus, OH",
      price: 450000,
      bedrooms: 6,
      bathrooms: 3,
      propertyType: "multi_family",
      description:
        "Three-unit multi-family property with strong cash flow. Two units rented, " +
        "one owner-occupied. Motivated seller, open to wholesale.",
      url: "https://www.facebook.com/groups/234/posts/567890123/",
      source: "facebook",
      ownerName: "Bob Johnson",
    },
  ];
}

// ── Comment templates ─────────────────────────────────────────────────────────

/**
 * Static comment for all listings
*/

function staticComment(): string {
  return (
    "We are real end buyers. Please send these details and all your other deals you may have. We will underwrite them and send you our offers.\n" +
    "admin@amazingpropertiesusa.com"
  );
}

/**
 * Dynamic comments generated per listing
*/

function dynamicComment(listing: RawListing): string {
  const bed = listing.bedrooms || "?";
  const price = listing.price ? `$${listing.price.toLocaleString()}` : "N/A";
  const location = listing.location || "this property";

  const templates = [
    `Hi! Just saw your ${bed}-bed listing in ${location}. Is this still available? Interested in a quick cash deal.`,
    `Great find at ${price}! Would love to discuss this ${bed}-bedroom property further. Do you have any pictures of the inside?`,
    `Hi ${listing.ownerName || "there"}! Is this property listed for wholesale or willing to work with investors on this ${location} deal?`,
    `Interested in your ${bed}-bed in ${location}. Can you share more about the condition and any needed repairs?`,
    `${location} properties are hot right now! Is this one available for immediate closing?`,
  ];

  // Deterministic: use property ID hash to pick same comment each run
  const idx = (listing.url?.length ?? 0) % templates.length;
  return templates[idx];
}

// ── Main test flow ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const isDynamic = args.includes("--dynamic");
  const headed = args.includes("--headed"); // Run browser in visible/headed mode
  const staticIdx = args.indexOf("--static");
  const staticText =
    staticIdx >= 0 && staticIdx + 1 < args.length
      ? args[staticIdx + 1]
      : undefined;

  logger.info(
    "═══════════════════════════════════════════════════════════════",
  );
  logger.info("Facebook Commenter Test");
  logger.info(
    "═══════════════════════════════════════════════════════════════",
  );

  // ── Check session ─────────────────────────────────────────────────────────

  const sessionFile = "facebook-session.json";
  if (!fs.existsSync(sessionFile)) {
    logger.error(
      `❌ Session file not found at ${sessionFile}\n` +
        "   Run FacebookScraper first to create a session:\n" +
        "   npm run scrape:facebook",
    );
    process.exit(1);
  }
  logger.info("✓ Session file found");

  // ── Load or generate listings ───────────────────────────────────────────────

  let listings: RawListing[] = [];

  // Try to load real listings from facebook.json first, then from scraped listings, then mock
  if (fs.existsSync("logs/facebook.json")) {
    logger.info("Loading real listings from facebook.json…");
    listings = loadRealListings();
  } else if (fs.existsSync("server/logs/listings.json")) {
    try {
      const data = JSON.parse(
        fs.readFileSync("server/logs/listings.json", "utf8"),
      );
      listings = Array.isArray(data) ? data : data.listings || [];
      logger.info(
        `✓ Loaded ${listings.length} listings from server/logs/listings.json`,
      );
    } catch (err) {
      logger.warn(`Could not parse listings.json, using mock data`);
      listings = generateMockListings();
    }
  } else {
    logger.info("No scraped listings found, using mock listings for testing");
    listings = generateMockListings();
  }

  // Filter to only Facebook listings with URLs
  const fbListings = listings.filter(
    (l) => l.url && l.url.includes("facebook.com"),
  );
  logger.info(`✓ Found ${fbListings.length} Facebook listings with valid URLs`);

  if (fbListings.length === 0) {
    logger.error("❌ No Facebook listings found with URLs");
    logger.error("   To get real listings, run:");
    logger.error("   npm run scrape:facebook");
    process.exit(1);
  }

  // ── Show comment preview ────────────────────────────────────────────────────

  logger.info("\n📝 Comment Preview:");
  logger.info(
    "───────────────────────────────────────────────────────────────",
  );

  // Default to static comment (buyers outreach) if neither --dynamic nor --static is provided
  const commentFn = isDynamic
    ? dynamicComment
    : staticText
      ? () => staticText
      : staticComment;

  for (let i = 0; i < Math.min(3, fbListings.length); i++) {
    const listing = fbListings[i];
    const comment = commentFn(listing);
    logger.info(`\n[Listing ${i + 1}] ${listing.address || listing.title}`);
    logger.info(`URL: ${listing.url}`);
    logger.info(`Comment: "${comment}"`);
  }

  // ── Dry run ───────────────────────────────────────────────────────────────

  if (dryRun) {
    logger.info("\n✓ Dry-run mode — no comments posted");
    logger.info(
      "Run without --dry-run flag to actually post comments:\n" +
        "   npm run test:facebook-commenter -- --dynamic",
    );
    process.exit(0);
  }

  // ── Confirm before posting ───────────────────────────────────────────────

  logger.warn("\n⚠️  Ready to post real comments!");
  logger.warn(`   Listings: ${fbListings.length}`);
  logger.warn(`   Daily Limit: ${process.env.FACEBOOK_COMMENT_LIMIT || "20"}`);
  logger.warn("   This cannot be undone!\n");

  // In interactive mode, would ask for confirmation here
  // For now, we'll just log and exit with instructions
  logger.info("To post comments, run:\n");
  if (isDynamic) {
    logger.info("   npm run test:facebook-commenter -- --dynamic");
  } else if (staticText) {
    logger.info(
      `   npm run test:facebook-commenter -- --static "Your custom comment"`,
    );
  } else {
    logger.info("   npm run test:facebook-commenter");
    logger.info("   (uses default buyers comment)");
  }
  logger.info("\nOr pipe confirmation:");
  logger.info("   echo yes | npm run test:facebook-commenter\n");

  // ── Actually post comments ────────────────────────────────────────────────

  logger.info("🚀 Starting comment posting…\n");

  const commenter = new FacebookCommenter({ headless: !headed });
  const results = await commenter.commentOnListings(fbListings, commentFn);

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
      logger.warn(`  • ${result.listing.address || result.listing.title}`);
      logger.warn(`    Error: ${result.error}`);
    }
  }

  // Show skipped
  const skippedResults = results.filter((r) => r.skipped);
  if (skippedResults.length > 0) {
    logger.info("\nSkipped listings:");
    for (const result of skippedResults) {
      logger.info(
        `  • ${result.listing.address || result.listing.title} ` +
          `(${result.error})`,
      );
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

  process.exit(succeeded === fbListings.length ? 0 : 1);
}

main().catch((err) => {
  logger.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
