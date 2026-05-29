// src/runner.ts
import { RawListing, ListingUpsertPayload, DealScore } from "./types/listing";
import { upsertMany, upsertZillowListings, upsertRedfinListings, upsertRealtorListings, upsertPropwireListings, getSummaryStats, upsertPropertyFromEnrichment, upsertEstimateFromZillow, upsertEstimateFromRedfin, upsertEstimateFromPropwire, upsertSingleListing, updateListingPropertyId, getOldListingsWithoutPropertyLink } from "./db/repository";
import { zillowEnrichmentService } from "./services/zillow-enrichment.service";
import { redfinEnrichmentService } from "./services/redfin-enrichment.service";
import { propwireEnrichmentService } from "./services/propwire-enrichment.service";
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
      logger.warn(`[${key}] No fresh listings from scraper — checking for old unenriched listings`);
      // Continue to check for old listings anyway
    }

    // ✨ NEW: Also fetch old listings from database that haven't been enriched yet
    let oldDbListings: RawListing[] = [];
    try {
      const oldListings = await getOldListingsWithoutPropertyLink(key, 50);
      oldDbListings = oldListings.map((l) => ({
        url: l.url,
        source: l.source,
        title: l.title ?? undefined,
        price: l.price ?? undefined,
        address: l.rawAddress ?? undefined,
        location: l.location ?? undefined,
        propertyType: (l.propertyType as any) ?? undefined,
        bedrooms: l.bedrooms ?? undefined,
        bathrooms: l.bathrooms ?? undefined,
        squareFeet: l.squareFeet ?? undefined,
        description: l.description ?? undefined,
        ownerName: l.ownerName ?? undefined,
        ownerPhone: l.ownerPhone ?? undefined,
        postedDate: l.postedDate ?? undefined,
      } as RawListing));
      
      if (oldDbListings.length > 0) {
        logger.info(`[${key}] Found ${oldDbListings.length} old unenriched listings from database`);
      }
    } catch (err) {
      logger.warn(`[${key}] Could not fetch old listings for re-enrichment: ${err}`);
    }

    // Combine fresh + old listings for unified enrichment
    const allListings = [...rawListings, ...oldDbListings];

    if (allListings.length === 0) {
      logger.warn(`[${key}] No listings to process (fresh or old) — skipping`);
      setProgress({ current: key });
      setProgress({ completed: (getStatus().completed || 0) + 1 });
      continue;
    }

    // ✨ NEW: Enrich ALL listings with Zillow + Redfin estimates (fresh + old, cross-platform)
    const enrichmentConcurrency = parseInt(process.env.ZILLOW_ENRICHMENT_CONCURRENCY || "2");
    logger.info(`\n${"─".repeat(60)}`);
    logger.info(`[${key}] Starting Zillow enrichment phase`);
    logger.info(`[${key}] Input: ${rawListings.length} fresh + ${oldDbListings.length} old = ${allListings.length} total listings`);
    logger.info(`[${key}] Enrichment concurrency: ${enrichmentConcurrency}`);
    logger.info(`${"─".repeat(60)}\n`);
    
    // Enrich with Zillow
    let enrichedListings = await zillowEnrichmentService.enrichAllListings(allListings, enrichmentConcurrency);
    
    // Then enrich with Redfin
    logger.info(`\n${"─".repeat(60)}`);
    logger.info(`[${key}] Starting Redfin enrichment phase`);
    logger.info(`[${key}] Enrichment concurrency: ${enrichmentConcurrency}`);
    logger.info(`${"─".repeat(60)}\n`);
    enrichedListings = await redfinEnrichmentService.enrichAllListings(enrichedListings, enrichmentConcurrency);

    // Then enrich with Propwire
    const propwireConcurrency = parseInt(process.env.PROPWIRE_ENRICHMENT_CONCURRENCY || "1");
    logger.info(`\n${"─".repeat(60)}`);
    logger.info(`[${key}] Starting Propwire enrichment phase`);
    logger.info(`[${key}] Enrichment concurrency: ${propwireConcurrency}`);
    logger.info(`${"─".repeat(60)}\n`);
    enrichedListings = await propwireEnrichmentService.enrichAllListings(enrichedListings, propwireConcurrency);

    // Score listings first
    const payloads = scoreListings(enrichedListings);

    // Upsert listings to main Listing table and link to Property+Estimate
    let propertiesCreated = 0;
    try {
      setProgress({ current: key });
      
      for (const payload of payloads) {
        try {
          // 1. Upsert listing to main table and get its ID
          const listingId = await upsertSingleListing(payload);
          
          // 2. Extract enriched data for this listing
          const enrichedListing = enrichedListings.find(l => l.url === payload.url);
          if (!enrichedListing || !enrichedListing.address) continue;
          
          let propertyLinked = false;
          
          // 3. Process Zillow enrichment
          if (enrichedListing.zestimate != null) {
            const propertyId = await upsertPropertyFromEnrichment(
              enrichedListing.address,
              enrichedListing.zpid,
              "zillow",
              enrichedListing.sourceUrl ?? payload.url
            );
            await upsertEstimateFromZillow(propertyId, enrichedListing.zestimate, listingId, enrichedListing.sourceUrl ?? payload.url);
            
            // Link listing to property
            if (!propertyLinked) {
              await updateListingPropertyId(listingId, propertyId);
              propertyLinked = true;
              propertiesCreated++;
            }
          }
          
          // 4. Process Redfin enrichment
          if (enrichedListing.redfinEstimate != null) {
            const propertyId = await upsertPropertyFromEnrichment(
              enrichedListing.address,
              undefined,
              "redfin",
              enrichedListing.sourceUrl ?? payload.url
            );
            await upsertEstimateFromRedfin(
              propertyId,
              enrichedListing.redfinEstimate,
              listingId,
              enrichedListing.sourceUrl ?? payload.url
            );
            
            // Link listing to property if not already linked
            if (!propertyLinked) {
              await updateListingPropertyId(listingId, propertyId);
              propertyLinked = true;
            }
          }

          // 5. Process Propwire enrichment
          if (enrichedListing.propwireEstimate != null) {
            const propertyId = await upsertPropertyFromEnrichment(
              enrichedListing.address,
              undefined,
              "propwire",
              enrichedListing.sourceUrl ?? payload.url
            );
            await upsertEstimateFromPropwire(
              propertyId,
              enrichedListing.propwireEstimate,
              listingId,
              enrichedListing.sourceUrl ?? payload.url
            );

            if (!propertyLinked) {
              await updateListingPropertyId(listingId, propertyId);
              propertyLinked = true;
            }
          }
        } catch (err) {
          logger.warn(`[${key}] Error processing listing ${payload.url}: ${err}`);
        }
      }

      totalSaved += payloads.length;
      logger.info(`[${key}] Saved ${payloads.length} listings to DB`);
      
      // Log enrichment summary
      const zilowEnrichedCount = enrichedListings.filter(l => l.zestimate != null).length;
      const redfinEnrichedCount = enrichedListings.filter(l => l.redfinEstimate != null).length;
      const propwireEnrichedCount = enrichedListings.filter(l => l.propwireEstimate != null).length;
      logger.info(`\n${"─".repeat(60)}`);
      logger.info(`[${key}] Enrichment phase complete:`);
      logger.info(`[${key}]   • Fresh listings processed: ${rawListings.length}`);
      logger.info(`[${key}]   • Old listings re-enriched: ${oldDbListings.length}`);
      logger.info(`[${key}]   • Total processed: ${allListings.length}`);
      logger.info(`[${key}]   • Zillow enriched: ${zilowEnrichedCount}`);
      logger.info(`[${key}]   • Redfin enriched: ${redfinEnrichedCount}`);
      logger.info(`[${key}]   • Propwire enriched: ${propwireEnrichedCount}`);
      logger.info(`[${key}]   • Property+Estimate records created: ${propertiesCreated}`);
      logger.info(`${"─".repeat(60)}\n`);

      // 4. Also upsert to source-specific tables (mirrors)
      if (key === "zillow") {
        await upsertZillowListings(payloads);
      } else if (key === "redfin") {
        await upsertRedfinListings(payloads);
      } else if (key === "realtor") {
        await upsertRealtorListings(payloads);
      } else if (key === "propwire") {
        await upsertPropwireListings(payloads);
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