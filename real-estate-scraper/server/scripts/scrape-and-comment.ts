#!/usr/bin/env ts-node

/**
 * Scrape and Comment Pipeline
 *
 * This script demonstrates Pattern 1 (Post-Processing Pipeline):
 * 1. Run FacebookScraper to collect listings
 * 2. Filter listings by criteria (price, location, type)
 * 3. Post comments on filtered listings
 *
 * Usage:
 *   npm run scrape:facebook:with-comments
 *   npm run scrape:facebook:with-comments -- --min-price 50000 --max-price 300000
 */

import * as yargs from "yargs";
import { FacebookScraper } from "../src/scrapers/facebook/facebook.scraper";
import {
  FacebookCommenter,
  CommentText,
} from "../src/scrapers/facebook/facebook.commenter";
import { logger } from "../src/utils/logger";
import { RawListing } from "../src/types/listing";

// ── Command-line arguments ────────────────────────────────────────────────────

const argv = yargs
  .option("min-price", {
    type: "number",
    default: 50000,
    description: "Minimum listing price to comment on",
  })
  .option("max-price", {
    type: "number",
    default: 500000,
    description: "Maximum listing price to comment on",
  })
  .option("comment-template", {
    type: "string",
    default: "dynamic",
    choices: ["dynamic", "static"],
    description:
      "Comment style: dynamic (per-listing) or static (same for all)",
  })
  .option("static-text", {
    type: "string",
    description: "Static comment text (used if --comment-template=static)",
  })
  .option("dry-run", {
    type: "boolean",
    default: false,
    description: "Show what would happen without posting comments",
  })
  .option("skip-scrape", {
    type: "boolean",
    default: false,
    description:
      "Skip scraping, use cached listings from logs/listings.json instead",
  })
  .parseSync();

// ── Comment generators ────────────────────────────────────────────────────────

/**
 * Dynamic comments personalized per listing
 */
function generateDynamicComment(listing: RawListing): string {
  const beds = listing.bedrooms ? `${listing.bedrooms}bed` : "bed";
  const baths = listing.bathrooms ? `${listing.bathrooms}bath` : "bath";
  const price = listing.price
    ? `$${listing.price.toLocaleString()}`
    : "listed price";
  const address = listing.address || listing.location || "this property";

  const templates = [
    `Hi! Interested in your ${beds}/${baths} at ${price}. ` +
      `Is this available for a quick closing?`,

    `Great opportunity! ${address} looks promising. ` +
      `Would love to discuss wholesale or investment terms.`,

    `Saw your listing in ${listing.location}. ` +
      `Are you open to investor offers or seller financing on this ${beds}?`,

    `Hello! The property at ${price} caught my eye. ` +
      `Any motivated seller situations we can discuss?`,

    `Interested in your ${beds}/${baths} investment property. ` +
      `Can we schedule a time to discuss your needs?`,
  ];

  // Deterministic: same listing always gets same comment
  const idx =
    (listing.url?.split("").reduce((a, b) => a + b.charCodeAt(0), 0) ?? 0) %
    templates.length;
  return templates[idx];
}

/**
 * Static comment for all listings
 */
function generateStaticComment(): string {
  return (
    "Hi! Interested in this property. Can you provide more details about " +
    "the condition, recent renovations, and financing terms? Thanks!"
  );
}

// ── Main workflow ────────────────────────────────────────────────────────────

async function main() {
  const minPrice = argv["min-price"] as number;
  const maxPrice = argv["max-price"] as number;
  const isDryRun = argv["dry-run"] as boolean;
  const skipScrape = argv["skip-scrape"] as boolean;
  const commentTemplate = argv["comment-template"] as string;
  const staticText = argv["static-text"] as string | undefined;

  logger.info(
    "═══════════════════════════════════════════════════════════════",
  );
  logger.info("Scrape and Comment Pipeline");
  logger.info(
    "═══════════════════════════════════════════════════════════════",
  );
  logger.info(
    `Price range: $${minPrice.toLocaleString()} - $${maxPrice.toLocaleString()}`,
  );
  logger.info(`Comment style: ${commentTemplate}`);
  logger.info(`Dry run: ${isDryRun}`);

  // ── Step 1: Scrape or load listings ───────────────────────────────────

  let allListings: RawListing[] = [];

  if (skipScrape) {
    logger.info("\n[1/3] Loading cached listings…");
    try {
      const fs = require("fs");
      const path = require("path");
      const filePath = path.join(__dirname, "../logs/listings.json");
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
        allListings = Array.isArray(data) ? data : data.listings || [];
        logger.info(`✓ Loaded ${allListings.length} listings from cache`);
      } else {
        logger.warn(`Cache file not found at ${filePath} — running scraper`);
      }
    } catch (err) {
      logger.warn(`Could not load cache — running scraper: ${err}`);
    }
  }

  if (allListings.length === 0) {
    logger.info("\n[1/3] Running FacebookScraper…");
    const scraper = new FacebookScraper();
    allListings = await scraper.run();
    logger.info(`✓ Scraped ${allListings.length} total listings`);
  }

  // ── Step 2: Filter listings ──────────────────────────────────────────

  logger.info("\n[2/3] Filtering listings…");

  const fbListings = allListings.filter(
    (l) => l.url && l.url.includes("facebook.com"),
  );
  logger.info(`  • With Facebook URLs: ${fbListings.length}`);

  const filteredByPrice = fbListings.filter(
    (l) => l.price && l.price >= minPrice && l.price <= maxPrice,
  );
  logger.info(`  • Price ${minPrice}-${maxPrice}: ${filteredByPrice.length}`);

  const filteredByType = filteredByPrice.filter(
    (l) => l.propertyType && l.propertyType !== "unknown",
  );
  logger.info(`  • Known property type: ${filteredByType.length}`);

  const candidateListings = filteredByType;
  logger.info(`✓ ${candidateListings.length} listings eligible for commenting`);

  if (candidateListings.length === 0) {
    logger.warn(
      "No eligible listings found — try adjusting price range or criteria",
    );
    logger.info(
      "All Facebook listings had: " +
        `${fbListings.length} URLs, ` +
        `${filteredByPrice.length} in price range`,
    );
    process.exit(0);
  }

  // ── Step 3: Show preview and comment ────────────────────────────────

  logger.info("\n[3/3] Commenting workflow…");
  logger.info(
    "───────────────────────────────────────────────────────────────",
  );

  // Show preview
  const commentFn: CommentText =
    commentTemplate === "static"
      ? staticText || generateStaticComment()
      : generateDynamicComment;

  logger.info("\nComment preview (first 3 listings):");
  for (let i = 0; i < Math.min(3, candidateListings.length); i++) {
    const listing = candidateListings[i];
    const comment =
      typeof commentFn === "function" ? commentFn(listing) : commentFn;

    logger.info(`\n  [${i + 1}] ${listing.address || listing.title}`);
    logger.info(`      URL: ${listing.url}`);
    logger.info(`      Comment: "${comment.substring(0, 80)}…"`);
  }

  if (isDryRun) {
    logger.info("\n✓ Dry-run mode — no comments actually posted");
    logger.info(
      "\nTo post real comments, run:\n" +
        `  npm run scrape:facebook:with-comments -- --min-price ${minPrice} --max-price ${maxPrice}`,
    );
    process.exit(0);
  }

  // Actually post comments
  logger.info(
    `\n🚀 Posting comments on ${candidateListings.length} listings…\n`,
  );

  const commenter = new FacebookCommenter();
  const results = await commenter.commentOnListings(
    candidateListings,
    commentFn,
  );

  // ── Summary ───────────────────────────────────────────────────────────

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;

  logger.info(
    "═══════════════════════════════════════════════════════════════",
  );
  logger.info("Results Summary");
  logger.info(
    "═══════════════════════════════════════════════════════════════",
  );
  logger.info(`Scraped:     ${allListings.length}`);
  logger.info(`Filtered:    ${candidateListings.length}`);
  logger.info(`✓ Succeeded: ${succeeded}`);
  logger.info(`✗ Failed:    ${failed}`);
  logger.info(`⊘ Skipped:   ${skipped}`);

  // Show failures
  if (failed > 0) {
    logger.warn("\nFailed listings:");
    results
      .filter((r) => !r.success && !r.skipped)
      .forEach((result) => {
        logger.warn(`  • ${result.listing.address || result.listing.title}`);
        logger.warn(`    Error: ${result.error}`);
      });
  }

  logger.info(
    "\n═══════════════════════════════════════════════════════════════\n",
  );

  process.exit(succeeded === candidateListings.length ? 0 : 1);
}

main().catch((err) => {
  logger.error(`Fatal error: ${err.message}`);
  logger.error(err.stack);
  process.exit(1);
});
