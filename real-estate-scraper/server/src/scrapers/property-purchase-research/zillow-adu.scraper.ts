import { RawListing }            from "../../types/listing";
import { ZillowScraper, oxylabsFetch, extractNextData } from "../zillow/zillow.scraper";
import { ScraperOptions }        from "../base.scraper";
import { AduResearchListing }    from "./adu-research.parser";
import {
  passesAduFilter,
  passesLocationFilter,
  passesKeywordFilter,
  passesPropertyCriteria,
}                                from "./adu-research.scraper";
import { logger }                from "../../utils/logger";
import { aduRunState }           from "./adu-run-state";
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

const BACKFILL_BATCH_SIZE = Number(process.env.ADU_BACKFILL_BATCH_SIZE ?? 1000);

// Hard per-step deadline: guarantees a stuck call can never freeze the whole
// run. Logs which listing/step hung, then the loop moves on.
function raceTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`[hang] ${label} did not finish in ${Math.round(ms / 1000)}s`)),
      ms
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

export class ZillowAduScraper extends ZillowScraper {
  readonly sourceName = "zillow-adu";

  constructor(options: ScraperOptions = {}) {
    super(options);
  }

  async run(): Promise<RawListing[]> {
    logger.info(`[${this.sourceName}] Starting ADU research scrape via Zillow`);
    this.visited.clear();
    this.results = [];

    // Progress + memory watchdog: logs once a minute; warns loudly if no
    // listing has completed in 4+ minutes (stuck fetch/OOM climb).
    let lastProgressAt = Date.now();
    const watchdog = setInterval(() => {
      const idleSec = Math.round((Date.now() - lastProgressAt) / 1000);
      const rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
      const heapMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      if (idleSec > 240) {
        logger.warn(`[${this.sourceName}] STALLED — no listing completed in ${idleSec}s (RSS ${rssMB}MB, heap ${heapMB}MB)`);
      } else {
        logger.info(`[${this.sourceName}] watchdog — idle ${idleSec}s, RSS ${rssMB}MB, heap ${heapMB}MB`);
      }
    }, 60_000);
    
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
            aduRunState.skippedSeen = skippedAsSeen;
            continue;
          }

          this.visited.add(rawListing.url);
          allSeenUrls.add(rawListing.url);
          processedThisBatch++ ;

          // Extract zip from address
          let zip: string | undefined;
          if (rawListing.address) {
            const match = rawListing.address.match(/\b\d{5}(-\d{4})?\b/);
            if (match) zip = match[0];
          }

          // Build a lightweight enriched listing for pre-filtering
          // (no detail page fetch yet — just search-page data)
          const preFilter: AduResearchListing = {
            ...rawListing,
            description: "",
            source:        this.sourceName,
            totalBedrooms: rawListing.bedrooms,
            zip,
            daysOnMarket: rawListing.daysOnMarket ?? rawListing.daysOnZillow,
            status: rawListing.status,
            lotSqft: rawListing.lotSqft,
          } as AduResearchListing;

          // ── CHEAP FILTERS FIRST (no network call) ──────────────────
          // 1. Location filter — only Ohio
          if (!passesLocationFilter(preFilter)) {
            logger.debug(`[${this.sourceName}] [#${processedThisBatch}] skipped — location filter`);
            continue;
          }

          // 2. Property criteria (beds/baths/price/year)
          if (!passesPropertyCriteria(preFilter)) {
            logger.debug(`[${this.sourceName}] [#${processedThisBatch}] skipped — property criteria`);
            continue;
          }

          // ── EXPENSIVE DETAIL FETCH (only for Ohio listings that pass criteria) ──
          logger.info(
            `[${this.sourceName}] [${processedThisBatch}/${BACKFILL_BATCH_SIZE}] Fetching description: ${rawListing.address ?? rawListing.url} ` +
            `(daysOnZillow=${rawListing.daysOnZillow ?? "?"})`
          );

          let description = "";
          let units: number | undefined;
          let yearBuilt: number | undefined;
          let schoolRating: string | undefined;
          let status: string | undefined;
          let lotSqft: number | undefined;

          try {
            const FETCH_TIMEOUT_MS = Number(process.env.ADU_FETCH_TIMEOUT_MS ?? 180_000);
            let html: string | null = await raceTimeout(
              oxylabsFetch(rawListing.url!, (this as any).sessionId),
              FETCH_TIMEOUT_MS,
              `detail fetch ${rawListing.url}`
            );
            logger.debug(`[${this.sourceName}] [#${processedThisBatch}] fetched, html=${html ? html.length : 0} chars`);
            if (html) {
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
            logger.warn(`[${this.sourceName}] ${rawListing.url}: ${err instanceof Error ? err.message : err}`);
          }

          logger.debug(`[${this.sourceName}] [#${processedThisBatch}] parsed, desc=${description.length} chars`);

          const enriched: AduResearchListing = {
            ...preFilter,
            description,
            units,
            yearBuilt: yearBuilt ?? preFilter.yearBuilt,
            schoolRating,
            status: status ?? preFilter.status,
            lotSqft: lotSqft ?? preFilter.lotSqft,
          } as AduResearchListing;

          // Now filter by keywords (requires description from detail page)
          const haystack = [enriched.title, enriched.description, enriched.address].join(" ").toLowerCase();
          const matchedKeyword = ADU_KEYWORDS.find((kw) => {
            const regex = new RegExp(`\\b${kw}\\b`, 'i');
            return regex.test(haystack);
          });
          
          if (matchedKeyword) {
             enriched.matchedKeyword = matchedKeyword;
             this.results.push(enriched);
             aduRunState.matched = this.results.length;
             logger.info(`[${this.sourceName}] ✓ MATCHED ADU KEYWORD: ${matchedKeyword}`);
             if (this.options.onMatch) {
               try {
                 const MATCH_TIMEOUT_MS = Number(process.env.ADU_MATCH_TIMEOUT_MS ?? 300_000);
                 await raceTimeout(
                   this.options.onMatch(enriched),
                   MATCH_TIMEOUT_MS,
                   `onMatch ${rawListing.url}`
                 );
               } catch (err) {
                 logger.warn(`[${this.sourceName}] ${rawListing.url}: ${err instanceof Error ? err.message : err}`);
               }
             }
          } else {
            logger.debug(`[${this.sourceName}] [#${processedThisBatch}] no keyword match`);
          }

          await sleep(jitter(BETWEEN_DETAIL_MS));
          logger.debug(`[${this.sourceName}] [#${processedThisBatch}] done`);
          lastProgressAt = Date.now();
          aduRunState.lastProgressAt = lastProgressAt;
          aduRunState.listingsProcessed = processedThisBatch;
          aduRunState.rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
          aduRunState.heapMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
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

    clearInterval(watchdog);
    return this.results;
  }
}

