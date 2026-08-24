import { RawListing }            from "../../types/listing";
import { ScraperOptions }        from "../base.scraper";
import { parseCraigslistSearchPage, parseCraigslistDetailPage } from "../craigslist/craigslist.parser";
import { oxylabsFetch } from "../zillow/zillow.scraper";
import { AduResearchListing }    from "./adu-research.parser";
import {
  passesLocationFilter,
  passesPropertyCriteria,
}                                from "./adu-research.scraper";
import { logger }                from "../../utils/logger";
import { aduRunState }           from "./adu-run-state";
import {
  loadSeenListings as loadSeenFromDb,
  saveSeenListings as saveSeenToDb,
} from "../../utils/backfill-store";
import { ADU_KEYWORDS } from "./adu-keywords";
import { sleep, jitter }         from "../../utils/browser";
import { config } from "../../config";

const BETWEEN_DETAIL_MS = 2_000;
const BACKFILL_BATCH_SIZE = Number(process.env.ADU_BACKFILL_BATCH_SIZE ?? 1000);
const DAYS_TO_LOOK_BACK = 30;

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

function isWithinLookbackWindow(postedDate: Date | undefined): boolean {
  if (!postedDate) return true;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - DAYS_TO_LOOK_BACK);
  return postedDate >= cutoffDate;
}

export class CraigslistAduScraper {
  readonly sourceName = "craigslist-adu";
  public results: AduResearchListing[] = [];
  public visited = new Set<string>();
  
  constructor(public options: ScraperOptions = {}) {}

  async run(): Promise<RawListing[]> {
    logger.info(`[${this.sourceName}] Starting ADU research scrape via Craigslist using Oxylabs`);
    this.visited.clear();
    this.results = [];

    const craigslistSources = config.sources.craigslist;
    const previouslySeen = await loadSeenFromDb(this.sourceName);
    const allSeenUrls = new Set(previouslySeen);
    let processedThisBatch = 0;
    let skippedAsSeen = 0;

    for (const [cityName, baseUrl] of Object.entries(craigslistSources)) {
      if (typeof baseUrl !== "string") continue; // guard in case of other properties
      
      if (processedThisBatch >= BACKFILL_BATCH_SIZE) break;
      logger.info(`[${this.sourceName}] ── City: ${cityName} ──`);

      const cleanBaseUrl = baseUrl.split("?")[0];
      const PER_PAGE = 120;
      let offset = 0;
      let stopPaging = false;

      while (!stopPaging && processedThisBatch < BACKFILL_BATCH_SIZE) {
        const searchUrl = `${cleanBaseUrl}?s=${offset}`;
        logger.info(`[${this.sourceName}] ${cityName} — fetching offset ${offset}`);

        let rawListings: Omit<RawListing, "source">[] = [];
        try {
          const FETCH_TIMEOUT_MS = Number(process.env.ADU_FETCH_TIMEOUT_MS ?? 180_000);
          const html = await raceTimeout(
            oxylabsFetch(searchUrl),
            FETCH_TIMEOUT_MS,
            `search fetch ${searchUrl}`
          );

          if (!html) {
            logger.warn(`[${this.sourceName}] Empty html for ${searchUrl}`);
            break;
          }
          rawListings = parseCraigslistSearchPage(html, cleanBaseUrl);
        } catch (err) {
          logger.error(`[${this.sourceName}] ${cityName} search error: ${err}`);
          break;
        }

        if (rawListings.length === 0) {
          logger.info(`[${this.sourceName}] ${cityName} — no listings on offset ${offset}, stopping pagination`);
          break;
        }

        let newOnPage = 0;

        for (const rawListing of rawListings) {
          if (processedThisBatch >= BACKFILL_BATCH_SIZE) break;
          
          if (!rawListing.url || this.visited.has(rawListing.url)) {
            continue;
          }
          
          if (allSeenUrls.has(rawListing.url)) {
            skippedAsSeen++;
            aduRunState.skippedSeen = skippedAsSeen;
            continue;
          }

          newOnPage++;
          this.visited.add(rawListing.url);
          allSeenUrls.add(rawListing.url);
          processedThisBatch++;

          if (!isWithinLookbackWindow(rawListing.postedDate)) {
             continue; // Skip very old listings
          }

          const preFilter: AduResearchListing = {
            ...rawListing,
            description: "",
            source: this.sourceName,
            totalBedrooms: rawListing.bedrooms,
          } as AduResearchListing;

          if (!passesLocationFilter(preFilter)) {
            continue;
          }

          if (!passesPropertyCriteria(preFilter)) {
            continue;
          }

          // Expensive detail fetch
          logger.info(
            `[${this.sourceName}] [${processedThisBatch}/${BACKFILL_BATCH_SIZE}] Fetching description: ${rawListing.url}`
          );

          let description = "";
          let detail = {};
          
          try {
            const FETCH_TIMEOUT_MS = Number(process.env.ADU_FETCH_TIMEOUT_MS ?? 180_000);
            const detailHtml = await raceTimeout(
              oxylabsFetch(rawListing.url),
              FETCH_TIMEOUT_MS,
              `detail fetch ${rawListing.url}`
            );
            if (detailHtml) {
              detail = parseCraigslistDetailPage(detailHtml);
              description = (detail as any).description || "";
            }
          } catch (err) {
             logger.warn(`[${this.sourceName}] ${rawListing.url}: ${err instanceof Error ? err.message : err}`);
          }

          const enriched: AduResearchListing = {
            ...preFilter,
            ...detail,
            description,
          } as AduResearchListing;

          // Keyword check
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
          }

          await sleep(jitter(BETWEEN_DETAIL_MS));
        }

        // If no new listings were on this page, or we're hitting completely stale listings, we can stop pagination for this city.
        if (newOnPage === 0) {
           logger.info(`[${this.sourceName}] ${cityName} — no new listings on offset ${offset}, stopping.`);
           stopPaging = true;
        }

        offset += PER_PAGE;
      }
      
      if (global.gc) global.gc();
    }

    logger.info(
      `[${this.sourceName}] Processed ${processedThisBatch} new listings, skipped ${skippedAsSeen} already-seen`
    );

    await saveSeenToDb(this.sourceName, allSeenUrls, processedThisBatch);

    return this.results;
  }
}
