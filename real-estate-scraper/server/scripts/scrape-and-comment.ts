#!/usr/bin/env ts-node
/**
 * Scrape and Comment Pipeline
 *
 * Usage:
 *   npm run scrape:facebook:with-comments
 *   npm run scrape:facebook:with-comments -- --dry-run
 *   npm run scrape:facebook:with-comments -- --skip-scrape
 *   npm run scrape:facebook:with-comments -- --min-price 50000 --max-price 500000
 *   npm run scrape:facebook:with-comments -- --headless false
 */

// ── MUST be the very first lines — load .env before any other imports ─────────
import * as dotenv from "dotenv";
import * as path from "path";

// Resolve .env relative to the project root (one level up from /scripts)
dotenv.config({ path: path.resolve(__dirname, "../.env") });
// Also try the current working directory as fallback
dotenv.config();

// ── All other imports after dotenv ────────────────────────────────────────────
import * as fs from "fs";
import * as yargs from "yargs";

import { FacebookScraper } from "../src/scrapers/facebook/facebook.scraper";
import {
  FacebookCommenter,
  CommentText,
} from "../src/scrapers/facebook/facebook.commenter";
import { logger } from "../src/utils/logger";
import { RawListing } from "../src/types/listing";

// ── Args ──────────────────────────────────────────────────────────────────────

const argv = yargs
  .option("min-price", {
    type: "number",
    default: 0,
    description: "Min price filter (0 = no minimum)",
  })
  .option("max-price", {
    type: "number",
    default: 0,
    description: "Max price filter (0 = no maximum)",
  })
  .option("dry-run", {
    type: "boolean",
    default: false,
    description: "Preview comments without posting",
  })
  .option("skip-scrape", {
    type: "boolean",
    default: false,
    description: "Skip scraping, load from logs/facebook.json",
  })
  .option("headless", {
    type: "boolean",
    default: undefined,
    description:
      "Run browser headless (default from env FACEBOOK_COMMENTER_HEADLESS)",
  })
  .option("comment-limit", {
    type: "number",
    default: 0,
    description: "Override daily comment limit (0 = use env default)",
  })
  .parseSync();

// ── Derived config ────────────────────────────────────────────────────────────

const MIN_PRICE = (argv["min-price"] as number) || 0;
const MAX_PRICE = (argv["max-price"] as number) || 0;
const IS_DRY_RUN = argv["dry-run"] as boolean;
const SKIP_SCRAPE = argv["skip-scrape"] as boolean;
const COMMENT_LIMIT = (argv["comment-limit"] as number) || 0;

// Headless: CLI flag > env var > default true
const headlessArg = argv["headless"] as boolean | undefined;
const HEADLESS =
  headlessArg !== undefined
    ? headlessArg
    : process.env.FACEBOOK_COMMENTER_HEADLESS === "false"
      ? false
      : true;

// ── Comment pool ──────────────────────────────────────────────────────────────
//
// Short, natural-sounding messages. No "wholesale", "investor", price mentions
// — FB's spam filter flags those patterns aggressively.

const COMMENT_TEMPLATES: Array<(l: RawListing) => string> = [
  () => "Hi! Is this still available?",
  () => "Is this property still on the market?",
  () => "Hey, still available? Would love more details!",
  () => "Hi there! Do you have more photos of the inside?",
  () => "Is this still for sale? Interested!",
  () => "Could you DM me more details on this one?",
  () => "Still available? Can we schedule a showing?",
  () => "Interested! What's the best way to reach you?",
  () => "Hi! Any interior photos available?",
  () => "Love this listing — is it still available?",
  () => "Do you have more info on this property?",
  () => "Still on the market? Please DM me!",
  () => "Hi, is this available? I'd love to take a look",
  () => "Any updates on this listing?",
  () => "Interested in this one! Is it still listed?",
  () => "Hi! Can you share more details? Still available?",
  () => "Would love to schedule a viewing if still available!",
  () => "Hi, is this still for sale? Please DM me details",
  () => "Looks great! Is it still available for viewing?",
  () => "Still on the market? I'm very interested!",
];

function autoComment(listing: RawListing): string {
  // Deterministic but varied — same listing always gets same comment
  const seed = (listing.url ?? "")
    .split("")
    .reduce((a, c) => a + c.charCodeAt(0), 0);
  return COMMENT_TEMPLATES[seed % COMMENT_TEMPLATES.length](listing);
}

// ── Price filter ──────────────────────────────────────────────────────────────

function passesPrice(listing: RawListing): boolean {
  // If no price filters set, accept everything
  if (!MIN_PRICE && !MAX_PRICE) return true;

  // If listing has no price, accept it — Facebook posts often omit price
  if (listing.price == null) return true;

  if (MIN_PRICE && listing.price < MIN_PRICE) return false;
  if (MAX_PRICE && listing.price > MAX_PRICE) return false;
  return true;
}

// ── Load listings from cache ───────────────────────────────────────────────────

function loadCachedListings(): RawListing[] {
  const candidates = [
    path.resolve(__dirname, "../logs/facebook.json"),
    path.resolve(process.cwd(), "logs/facebook.json"),
  ];

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const listings: RawListing[] = Array.isArray(data)
        ? data
        : (data.listings ?? data.results ?? []);
      logger.info(`✓ Loaded ${listings.length} listings from ${filePath}`);
      return listings;
    } catch (err: any) {
      logger.warn(`Could not parse ${filePath}: ${err.message}`);
    }
  }

  logger.warn("No cached facebook.json found");
  return [];
}

// ── Verify env is loaded ──────────────────────────────────────────────────────

function checkEnv(): void {
  const missing: string[] = [];
  if (!process.env.FACEBOOK_USERNAME) missing.push("FACEBOOK_USERNAME");
  if (!process.env.FACEBOOK_PASSWORD) missing.push("FACEBOOK_PASSWORD");
  if (!process.env.FACEBOOK_GROUP_URLS) missing.push("FACEBOOK_GROUP_URLS");

  if (missing.length > 0) {
    logger.error(
      `Missing required env vars: ${missing.join(", ")}\n` +
        `Make sure .env is in the project root and contains these variables.\n` +
        `Looked for .env at: ${path.resolve(__dirname, "../.env")}`,
    );
    process.exit(1);
  }

  logger.info(`[env] FACEBOOK_USERNAME  = ${process.env.FACEBOOK_USERNAME}`);
  logger.info(
    `[env] FACEBOOK_GROUP_URLS = ${(process.env.FACEBOOK_GROUP_URLS ?? "").slice(0, 60)}…`,
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info(
    "═══════════════════════════════════════════════════════════════",
  );
  logger.info("Facebook Scrape and Comment Pipeline");
  logger.info(
    "═══════════════════════════════════════════════════════════════",
  );

  const priceStr =
    MIN_PRICE || MAX_PRICE
      ? `$${MIN_PRICE.toLocaleString()} – $${MAX_PRICE ? MAX_PRICE.toLocaleString() : "∞"}`
      : "no price filter";

  logger.info(`Price filter:  ${priceStr}`);
  logger.info(`Dry run:       ${IS_DRY_RUN}`);
  logger.info(`Skip scrape:   ${SKIP_SCRAPE}`);
  logger.info(`Headless:      ${HEADLESS}`);
  if (COMMENT_LIMIT) logger.info(`Comment limit: ${COMMENT_LIMIT}`);

  // Override env vars if CLI flags set
  if (COMMENT_LIMIT) {
    process.env.FACEBOOK_COMMENT_LIMIT = String(COMMENT_LIMIT);
  }

  // Verify env loaded correctly
  checkEnv();

  // ── Step 1: Scrape ────────────────────────────────────────────────────────

  let allListings: RawListing[] = [];

  if (SKIP_SCRAPE) {
    logger.info("\n[1/3] Loading cached listings…");
    allListings = loadCachedListings();

    if (allListings.length === 0) {
      logger.warn("Cache empty — falling back to live scrape");
      SKIP_SCRAPE && (allListings = []); // trigger scrape below
    }
  }

  if (!SKIP_SCRAPE || allListings.length === 0) {
    logger.info("\n[1/3] Running FacebookScraper…");
    try {
      const scraper = new FacebookScraper();
      allListings = await scraper.run();
      logger.info(`✓ Scraped ${allListings.length} total listings`);
    } catch (err: any) {
      logger.error(`FacebookScraper failed: ${err.message}`);
      logger.info("Falling back to cached listings if available…");
      allListings = loadCachedListings();
      if (allListings.length === 0) {
        logger.error("No listings available — aborting");
        process.exit(1);
      }
    }
  }

  // ── Step 2: Filter ────────────────────────────────────────────────────────

  logger.info("\n[2/3] Filtering listings…");

  // All listings with facebook.com URLs
  const fbListings = allListings.filter(
    (l) => l.url && l.url.includes("facebook.com"),
  );
  logger.info(
    `  • With Facebook URLs:    ${fbListings.length} / ${allListings.length}`,
  );

  // Apply price filter (if set)
  const priceFiltered = fbListings.filter(passesPrice);
  logger.info(`  • After price filter:    ${priceFiltered.length}`);

  // Remove listings we likely already commented on this session
  // (no persistent memory, but same-URL dedup helps within a run)
  const seen = new Set<string>();
  const deduped = priceFiltered.filter((l) => {
    if (!l.url || seen.has(l.url)) return false;
    seen.add(l.url);
    return true;
  });
  logger.info(`  • After dedup:           ${deduped.length}`);

  const candidates = deduped;

  if (candidates.length === 0) {
    logger.warn(
      "No eligible listings found.\n" +
        `Total scraped: ${allListings.length} | With FB URL: ${fbListings.length}\n` +
        "Tips:\n" +
        "  • Remove --min-price / --max-price to comment on all listings\n" +
        "  • Run npm run scrape:facebook first and then use --skip-scrape",
    );
    process.exit(0);
  }

  logger.info(`✓ ${candidates.length} listing(s) eligible for commenting`);

  // ── Step 3: Preview and comment ───────────────────────────────────────────

  logger.info("\n[3/3] Commenting…");
  logger.info(
    "───────────────────────────────────────────────────────────────",
  );

  logger.info(`\nComment preview (first ${Math.min(5, candidates.length)}):`);
  for (let i = 0; i < Math.min(5, candidates.length); i++) {
    const l = candidates[i];
    const comment = autoComment(l);
    logger.info(`  [${i + 1}] ${l.address ?? l.title ?? l.url}`);
    logger.info(`      URL:     ${l.url}`);
    logger.info(`      Comment: "${comment}"`);
    if (l.price) logger.info(`      Price:   $${l.price.toLocaleString()}`);
  }

  if (IS_DRY_RUN) {
    logger.info("\n✓ Dry-run mode — no comments posted.");
    logger.info(
      "Remove --dry-run to post for real:\n" +
        "  npm run scrape:facebook:with-comments",
    );
    process.exit(0);
  }

  // ── Post comments ─────────────────────────────────────────────────────────

  logger.info(
    `\n🚀 Posting comments on up to ${candidates.length} listing(s)…\n`,
  );

  const commenter = new FacebookCommenter({ headless: HEADLESS });
  const commentFn: CommentText = autoComment;

  const results = await commenter.commentOnListings(candidates, commentFn);

  // ── Summary ───────────────────────────────────────────────────────────────

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
  logger.info(`Scraped total:   ${allListings.length}`);
  logger.info(`FB candidates:   ${candidates.length}`);
  logger.info(`✓ Succeeded:     ${succeeded}`);
  logger.info(`✗ Failed:        ${failed}`);
  logger.info(`⊘ Skipped:       ${skipped}`);

  if (failed > 0) {
    logger.warn("\nFailed listings:");
    results
      .filter((r) => !r.success && !r.skipped)
      .forEach((r) => {
        logger.warn(`  • ${r.listing.address ?? r.listing.url}`);
        logger.warn(`    Error: ${r.error}`);
      });
  }

  logger.info(
    "═══════════════════════════════════════════════════════════════\n",
  );

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  logger.error(`Fatal error: ${err.message}`);
  logger.error(err.stack);
  process.exit(1);
});
