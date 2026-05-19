// src/runner.ts
import { RawListing, ListingUpsertPayload, DealScore } from "./types/listing";
import { upsertMany, upsertZillowListings, upsertRedfinListings, upsertRealtorListings, upsertPropwireListings, getSummaryStats } from "./db/repository";
import { enrichListingsBySource } from "./services/enrichment";
import { logger } from "./utils/logger";
import { setRunning, setProgress, getStatus } from "./scrape/status";


// ── Underwriting engine ───────────────────────────────────────────────────────

function scoreListings(listings: RawListing[]): Array<ListingUpsertPayload & { estimate?: number }> {
  return listings.map((listing): ListingUpsertPayload & { estimate?: number } => {
    // Prefer any available source-specific estimate (zillow/redfin/realtor/propwire),
    // fall back to price when computing ARV-based equity.
    const sourceEstimate =
      (listing as any).zestimate ??
      (listing as any).redfinEstimate ??
      (listing as any).realtorEstimate ??
      (listing as any).propwireEstimate ??
      (listing as any).estimate ??
      undefined;

    const arv = sourceEstimate ?? listing.price;
    let dealScore: DealScore = "low_potential";
    let equityEstimate: number | undefined;

    if (arv && listing.price) {
      equityEstimate = Math.round(arv - listing.price);
      const ratio = listing.price / arv;
      if (ratio <= 0.7)       dealScore = "good_deal";
      else if (ratio <= 0.85) dealScore = "average_deal";
    }

    return { ...listing, dealScore, equityEstimate, estimate: sourceEstimate };
  });
}

// ── Main runner ───────────────────────────────────────────────────────────────

export interface RunOptions {
  sourceKeys: string[];
  factories: Record<string, () => import("./scrapers/base.scraper").BaseScraper>;
  manageStatus?: boolean;
}

export async function runScrapers(options: RunOptions): Promise<void> {
  const { sourceKeys, factories, manageStatus = true } = options;
  logger.info(`Runner starting | sources: ${sourceKeys.join(", ")}`);

  const scrapingId = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  if (manageStatus) {
    setRunning(true, scrapingId);
    setProgress({ total: sourceKeys.length, completed: 0 });
  }

  let totalSaved = 0;

  for (const key of sourceKeys) {
    // Check if stop was requested
    if (getStatus().stopRequested) {
      logger.warn(`Stop requested by user — aborting scrape run`);
      break;
    }

    const factory = factories[key];
    if (!factory) {
      logger.error(`No factory found for source "${key}" — skipping`);
      continue;
    }

    logger.info(`\n${"─".repeat(60)}`);
    logger.info(`Running scraper: ${key}`);
    logger.info(`${"─".repeat(60)}`);

    const scraper = factory();

    let rawListings: RawListing[] = [];
    try {
      rawListings = await scraper.run();
    } catch (err) {
      logger.error(`Scraper "${key}" threw an error: ${err}`);
      continue;
    }

    if (rawListings.length === 0) {
      logger.warn(`[${key}] No listings returned — nothing to save`);
      // update progress counts even if zero
      setProgress({ current: key });
      setProgress({ completed: (getStatus().completed || 0) + 1 });
      continue;
    }

    // Score listings for deal evaluation
    const payloads = scoreListings(rawListings);

    try {
      setProgress({ current: key });
      // Route to appropriate table based on source
      if (key === "zillow") {
        await upsertZillowListings(payloads);
      } else if (key === "redfin") {
        await upsertRedfinListings(payloads);
      } else if (key === "realtor") {
        await upsertRealtorListings(payloads);
      } else if (key === "propwire") {
        await upsertPropwireListings(payloads);
      } else {
        await upsertMany(payloads);
      }

      totalSaved += payloads.length;
      logger.info(`[${key}] Saved ${payloads.length} listings to DB`);

      // ── ENRICHMENT PHASE: Normalize addresses and match against reference tables
      logger.info(`[${key}] Starting enrichment phase...`);
      try {
        const stats = await enrichListingsBySource(key);
        logger.info(
          `[${key}] Enrichment complete: ${stats.linked} linked, ${stats.estimatesCreated} estimates created, ${stats.skipped} skipped, ${stats.failed} failed in ${stats.duration_ms}ms`
        );
      } catch (enrichErr) {
        logger.error(`[${key}] Enrichment failed: ${enrichErr}`);
      }
    } catch (err) {
      logger.error(`[${key}] DB save failed: ${err}`);
    }
      // increment completed sources count
      setProgress({ completed: (getStatus().completed || 0) + 1 });
  }

  logger.info(`\n${"=".repeat(60)}`);
  logger.info(`Run complete | total saved: ${totalSaved}`);

  try {
    const stats = await getSummaryStats();
    logger.info(`DB totals: ${stats.total} listings across all sources`);
    logger.info(`By source: ${JSON.stringify(stats.bySource)}`);
    logger.info(`By score:  ${JSON.stringify(stats.byDealScore)}`);
  } catch {
    // Stats are non-critical
  }

  logger.info("=".repeat(60));
  if (manageStatus) setRunning(false);
}