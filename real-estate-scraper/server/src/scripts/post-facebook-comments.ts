// src/scripts/post-facebook-comments.ts
/**
 * Script to fetch all Facebook listings from the database and post
 * a comment on each one using the FacebookCommenter tool.
 *
 * Run with: npx ts-node src/scripts/post-facebook-comments.ts
 */

import { prisma } from "../db/client";
import { commentOnListings } from "../scrapers/facebook/facebook.commenter";
import { RawListing } from "../types/listing";
import { logger } from "../utils/logger";

const DEFAULT_COMMENT = `We are real end buyers. Please send these details and all your other deals you may have. We will underwrite them and send you our offers.
admin@amazingpropertiesusa.com`;

async function main() {
  try {
    logger.info("[facebook-bulk-commenter] Starting…");

    // ── Fetch all Facebook listings ──────────────────────────────────────

    const facebookListings = await prisma.listing.findMany({
      where: {
        source: "facebook",
      },
    });

    if (facebookListings.length === 0) {
      logger.warn(
        "[facebook-bulk-commenter] No Facebook listings found in database",
      );
      return;
    }

    logger.info(
      `[facebook-bulk-commenter] Found ${facebookListings.length} Facebook listings`,
    );

    // ── Convert to RawListing format ─────────────────────────────────────

    const rawListings: RawListing[] = facebookListings.map((listing) => ({
      url: listing.url,
      source: listing.source,
      title: listing.title ?? undefined,
      price: listing.price ?? undefined,
      address: listing.rawAddress ?? undefined,
      location: listing.location ?? undefined,
      propertyType: (listing.propertyType as any) ?? undefined,
      bedrooms: listing.bedrooms ?? undefined,
      bathrooms: listing.bathrooms ?? undefined,
      squareFeet: listing.squareFeet ?? undefined,
      description: listing.description ?? undefined,
      ownerName: listing.ownerName ?? undefined,
      ownerPhone: listing.ownerPhone ?? undefined,
    }));

    // ── Post comments ──────────────────────────────────────────────────

    logger.info(
      `[facebook-bulk-commenter] Posting comments on ${rawListings.length} listings…`,
    );

    const results = await commentOnListings(
      rawListings,
      DEFAULT_COMMENT,
      { headless: false, dailyLimit: Infinity }, // headless: false to watch the browser, dailyLimit: Infinity to remove the daily limit
    );

    // ── Summary ────────────────────────────────────────────────────────

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success && !r.skipped).length;
    const skipped = results.filter((r) => r.skipped).length;

    logger.info(
      `[facebook-bulk-commenter] Complete — ${succeeded} posted, ${failed} failed, ${skipped} skipped`,
    );

    // ── Detailed results ────────────────────────────────────────────────

    if (failed > 0) {
      logger.error("[facebook-bulk-commenter] Failed comments:");
      results
        .filter((r) => !r.success && !r.skipped)
        .forEach((r) => {
          logger.error(`  ${r.listing.url} — ${r.error}`);
        });
    }

    if (skipped > 0) {
      logger.warn("[facebook-bulk-commenter] Skipped comments:");
      results
        .filter((r) => r.skipped)
        .forEach((r) => {
          logger.warn(`  ${r.listing.url ?? "unknown"} — ${r.error}`);
        });
    }

    process.exit(succeeded > 0 ? 0 : 1);
  } catch (err: any) {
    logger.error(`[facebook-bulk-commenter] Fatal error: ${err.message}`);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
