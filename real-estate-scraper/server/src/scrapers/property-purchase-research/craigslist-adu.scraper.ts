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
import { ADU_KEYWORDS, TARGET_STATES } from "./adu-keywords";
import { sleep, jitter }         from "../../utils/browser";
import { config } from "../../config";

const BETWEEN_DETAIL_MS = 1_000;
const BACKFILL_BATCH_SIZE = Number(process.env.ADU_BACKFILL_BATCH_SIZE ?? 1000);
const DAYS_TO_LOOK_BACK = 30;

// Micro-concurrency: fetch this many detail pages at the same time.
// Kept at 2 to stay within Render's 512 MB RAM (each HTML page is ~1-2 MB).
const DETAIL_CONCURRENCY = Number(process.env.ADU_DETAIL_CONCURRENCY ?? 2);

// Craigslist subdomain → US state. Needed because search results only carry a
// neighborhood string ("West Bend area"), never a state, and
// passesLocationFilter requires listing.state to match TARGET_STATES.
const CITY_TO_STATE: Record<string, string> = {
  milwaukee: "WI",
  columbus: "OH",
  cleveland: "OH",
  toledo: "OH",
};

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

// ── Promise pool: run tasks N-at-a-time ─────────────────────────────────────
// Processes an array of async task functions with a concurrency limit.
// Returns when all tasks have settled (resolved or rejected).
async function runPool(tasks: Array<() => Promise<void>>, concurrency: number): Promise<void> {
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (idx < tasks.length) {
      const taskIndex = idx++;
      try {
        await tasks[taskIndex]();
      } catch (err) {
        logger.warn(`[craigslist-adu] Pool task ${taskIndex} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  });
  await Promise.all(workers);
}

export class CraigslistAduScraper {
  readonly sourceName = "craigslist-adu";
  public results: AduResearchListing[] = [];
  public visited = new Set<string>();
  
  constructor(public options: ScraperOptions = {}) {}

  async run(): Promise<RawListing[]> {
    logger.info(`[${this.sourceName}] Starting ADU research scrape via Craigslist (concurrency=${DETAIL_CONCURRENCY})`);
    this.visited.clear();
    this.results = [];

    const craigslistSources = config.sources.craigslist;
    const previouslySeen = await loadSeenFromDb(this.sourceName);
    const allSeenUrls = new Set(previouslySeen);
    let processedThisBatch = 0;
    let skippedAsSeen = 0;

    for (const [cityName, baseUrl] of Object.entries(craigslistSources)) {
      if (typeof baseUrl !== "string") continue; // guard in case of other properties

      const cityState = CITY_TO_STATE[cityName];
      if (cityState && !TARGET_STATES.includes(cityState)) {
        logger.info(`[${this.sourceName}] ${cityName} → ${cityState} not in target states (${TARGET_STATES.join(", ")}), skipping city`);
        continue;
      }

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

        // ── Phase 1: Cheap filters — collect listings that need detail fetch ──
        const pendingDetails: Array<{ rawListing: Omit<RawListing, "source">; preFilter: AduResearchListing }> = [];

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
            state: CITY_TO_STATE[cityName] ?? rawListing.state,
          } as AduResearchListing;

          if (!passesLocationFilter(preFilter)) {
            continue;
          }

          if (!passesPropertyCriteria(preFilter)) {
            continue;
          }

          // Listing passed cheap filters — queue it for detail fetch
          pendingDetails.push({ rawListing, preFilter });
        }

        // ── Phase 2: Fetch detail pages with micro-concurrency ───────────────
        if (pendingDetails.length > 0) {
          logger.info(
            `[${this.sourceName}] ${cityName} offset ${offset}: ` +
            `${pendingDetails.length} listings need detail fetch (concurrency=${DETAIL_CONCURRENCY})`
          );

          const detailTasks = pendingDetails.map(({ rawListing, preFilter }, idx) => {
            return async () => {
              logger.info(
                `[${this.sourceName}] [${idx + 1}/${pendingDetails.length}] Fetching description: ${rawListing.url}`
              );

              let description = "";
              let detail = {};
              
              try {
                const FETCH_TIMEOUT_MS = Number(process.env.ADU_FETCH_TIMEOUT_MS ?? 180_000);
                const detailHtml = await raceTimeout(
                  oxylabsFetch(rawListing.url!),
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

              // Re-check property criteria now that description is available
              // (the pre-detail check only had title + address)
              if (!passesPropertyCriteria(enriched)) {
                return;
              }

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
            };
          });

          await runPool(detailTasks, DETAIL_CONCURRENCY);
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
