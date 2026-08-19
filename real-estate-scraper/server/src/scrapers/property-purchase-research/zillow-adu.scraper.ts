import { RawListing }            from "../../types/listing";
import { ZillowScraper }         from "../zillow/zillow.scraper";
import { ScraperOptions }        from "../base.scraper";
import { AduResearchListing }    from "./adu-research.parser";
import {
  passesAduFilter,
  passesLocationFilter,
  passesKeywordFilter,
  passesPropertyCriteria,
}                                from "./adu-research.scraper";
import { logger }                from "../../utils/logger";
import {
  loadSeenListings as loadSeenFromDb,
  saveSeenListings as saveSeenToDb,
} from "../../utils/backfill-store";
import { ADU_KEYWORDS, TARGET_STATES } from "./adu-keywords";
import { sleep, jitter }         from "../../utils/browser";

// Pause between detail-page fetches to avoid hammering Oxylabs
const BETWEEN_DETAIL_MS = 2_000;

// How many listings to log full diagnostics for
const ZILLOW_DIAG_LIMIT = 10;

const BACKFILL_BATCH_SIZE = 1000;

export class ZillowAduScraper extends ZillowScraper {
  readonly sourceName = "zillow-adu";

  constructor(options: ScraperOptions = {}) {
    super(options);
  }

  async run(): Promise<RawListing[]> {
    logger.info(`[${this.sourceName}] Starting ADU research scrape via Zillow`);
    this.visited.clear();
    this.results = [];
    
    // We import config from base to read markets
    const { config } = await import("../../config");
    const zillowCfg = config.sources.zillow;
    const markets   = zillowCfg.markets;

    // Persistent backfill tracker — skips listings already processed in
    // previous batches and lets runContinuous() advance one batch at a time.
    const previouslySeen = await loadSeenFromDb(this.sourceName);
    const allSeenUrls = new Set(previouslySeen);
    let processedThisBatch = 0;
    let skippedAsSeen = 0;

    for (const market of markets) {
      if (processedThisBatch >= BACKFILL_BATCH_SIZE) break;
      logger.info(`[${this.sourceName}] ── Market: ${market.name} (${market.listingType}) ──`);

      let stopPaging = false;
      let rawScannedForMarket = 0;

      // Reverse pagination (oldest first) to backfill inventory across batches
      for (let page = zillowCfg.maxPagesPerMarket; page >= 1; page--) {
        if (stopPaging) break;
        if (rawScannedForMarket >= this.options.maxListings) break;
        if (processedThisBatch >= BACKFILL_BATCH_SIZE) break;

        logger.info(`[${this.sourceName}] ${market.name} — page ${page}/${zillowCfg.maxPagesPerMarket}`);

        let pageListings: RawListing[] = [];
        try {
          // Call the protected scrapeMarketPage from the parent class, bypassing
          // price filter and the 30-day freshness cutoff so we backfill the
          // full inventory (oldest first via reverse pagination).
          const result = await (this as any).scrapeMarketPage(market, page, true, false);
          pageListings = result.listings;
          if (result.stop) stopPaging = true;
        } catch (err) {
          logger.error(`[${this.sourceName}] ${market.name} page ${page} error: ${err}`);
          continue;
        }

        logger.info(`[${this.sourceName}] ${market.name} page ${page}: ${pageListings.length} raw listing(s)`);

        for (const rawListing of pageListings) {
          if (rawScannedForMarket >= this.options.maxListings) break;
          if (processedThisBatch >= BACKFILL_BATCH_SIZE) break;

          rawScannedForMarket++;

          if (!rawListing.url || this.visited.has(rawListing.url)) {
            continue;
          }

          // Skip listings already processed in a previous backfill batch
          if (allSeenUrls.has(rawListing.url)) {
            skippedAsSeen++;
            continue;
          }

          this.visited.add(rawListing.url);
          allSeenUrls.add(rawListing.url);
          processedThisBatch++;

          logger.info(
            `[${this.sourceName}] [${processedThisBatch}/${BACKFILL_BATCH_SIZE}] Fetching description: ${rawListing.address ?? rawListing.url} ` +
            `(daysOnZillow=${rawListing.daysOnZillow ?? "?"})`
          );

          // Fetch the full description & metadata from the detail page
          let description = "";
          let units: number | undefined;
          let yearBuilt: number | undefined;
          let schoolRating: string | undefined;
          let status: string | undefined;
          let lotSqft: number | undefined;

          try {
            let html: string | null = await (this as any).oxylabsFetch?.(rawListing.url, (this as any).sessionId) || await import("../zillow/zillow.scraper").then(m => m.oxylabsFetch(rawListing.url!, (this as any).sessionId));
            if (html) {
              const { extractNextData } = await import("../zillow/zillow.scraper");
              const json = extractNextData(html);
              html = null; // Release ~1-2 MB HTML string for GC
              if (json) {
                const props = json?.props?.pageProps;
                
                // Extract description
                description = props?.componentProps?.description ?? "";
                if (!description) {
                  const rawCache = props?.gdpClientCache ?? props?.componentProps?.gdpClientCache;
                  if (rawCache) {
                    try {
                      const cache = typeof rawCache === "string" ? JSON.parse(rawCache) : rawCache;
                      for (const key of Object.keys(cache ?? {})) {
                        const propData = cache[key]?.property;
                        if (propData) {
                          if (propData.description) description = propData.description;
                          
                          // Extract units, yearBuilt, schoolRating from gdpClientCache
                          if (propData.yearBuilt) yearBuilt = Number(propData.yearBuilt);
                          if (propData.homeStatus) status = propData.homeStatus;
                          if (propData.lotAreaValue) {
                            if (propData.lotAreaUnit === "acres") lotSqft = Math.round(propData.lotAreaValue * 43560);
                            else lotSqft = Math.round(propData.lotAreaValue);
                          }
                          
                          // Schools
                          if (Array.isArray(propData.schools) && propData.schools.length > 0) {
                             const hs = propData.schools.find((s: any) => s.level === "High");
                             if (hs && hs.rating) schoolRating = `${hs.rating}/10`;
                             else if (propData.schools[0].rating) schoolRating = `${propData.schools[0].rating}/10`;
                          }
                          
                          break;
                        }
                      }
                    } catch {}
                  }
                }
              }
            }
          } catch (err) {
            logger.warn(`[${this.sourceName}] Failed to fetch detail for ${rawListing.url}: ${err}`);
          }

          // Extract zip from address
          let zip: string | undefined;
          if (rawListing.address) {
            const match = rawListing.address.match(/\b\d{5}(-\d{4})?\b/);
            if (match) zip = match[0];
          }

          const enriched: AduResearchListing = {
            ...rawListing,
            description,
            source:        this.sourceName,
            totalBedrooms: rawListing.bedrooms, // Fallback to main bed count
            units,
            yearBuilt,
            schoolRating,
            zip,
            daysOnMarket: rawListing.daysOnMarket ?? rawListing.daysOnZillow,
            status: status ?? rawListing.status,
            lotSqft: lotSqft ?? rawListing.lotSqft
          } as AduResearchListing;

          // Apply location filter — only Ohio
          if (!passesLocationFilter(enriched)) {
             logger.debug(`[${this.sourceName}] ✗ Location filter: ${enriched.address}`);
             continue;
          }

          // Apply strict criteria
          if (!passesPropertyCriteria(enriched)) {
             continue;
          }

          // Now filter by keywords
          const haystack = [enriched.title, enriched.description, enriched.address].join(" ").toLowerCase();
          const matchedKeyword = ADU_KEYWORDS.find((kw) => {
            const regex = new RegExp(`\\b${kw}\\b`, 'i');
            return regex.test(haystack);
          });
          
          if (matchedKeyword) {
             enriched.matchedKeyword = matchedKeyword;
             this.results.push(enriched);
             logger.info(`[${this.sourceName}] ✓ MATCHED ADU KEYWORD: ${matchedKeyword}`);
             if (this.options.onMatch) {
               await this.options.onMatch(enriched);
             }
          }

          await sleep(jitter(BETWEEN_DETAIL_MS));
        }

        if (pageListings.length === 0) {
          logger.info(`[${this.sourceName}] ${market.name} — no listings on page ${page}, skipping to next older page`);
          continue; // going backwards, keep moving to older pages
        }
      }
      if (processedThisBatch >= BACKFILL_BATCH_SIZE) break;
      if (global.gc) global.gc();
      logger.info(`[${this.sourceName}] Memory after ${market.name}: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`);
    }

    logger.info(
      `[${this.sourceName}] Processed ${processedThisBatch} new listings, skipped ${skippedAsSeen} already-seen`
    );

    // ── Save updated tracker to DB ─────────────────────────────
    await saveSeenToDb(this.sourceName, allSeenUrls, processedThisBatch);

    return this.results;
  }
}

