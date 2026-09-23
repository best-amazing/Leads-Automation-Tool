import { RawListing } from "../../../types/listing";
import {
  ZillowScraper,
  oxylabsFetch,
  extractNextData,
} from "../../zillow/zillow.scraper";
import { ScraperOptions } from "../../base.scraper";
import { AduResearchListing } from "../core/adu-research.parser";
import {
  passesAduFilter,
  passesLocationFilter,
  passesKeywordFilter,
  passesPropertyCriteria,
} from "../filters/adu-research.scraper";
import { logger } from "../../../utils/logger";
import { aduRunState } from "../core/adu-run-state";
import {
  loadSeenListings as loadSeenFromDb,
  saveSeenListings as saveSeenToDb,
} from "../../../utils/backfill-store";
import { ADU_KEYWORDS, TARGET_STATES } from "../core/adu-keywords";
import { sleep, jitter } from "../../../utils/browser";
import { descriptionQueue } from "../../../utils/queue";

// Pause between detail-page fetches to avoid hammering Oxylabs
const BETWEEN_DETAIL_MS = 1_000;

// Pause between page requests (same cadence as the base Zillow scraper)
const BETWEEN_PAGE_MS = 3_000;

// How many listings to log full diagnostics for
const ZILLOW_DIAG_LIMIT = 10;

const BACKFILL_BATCH_SIZE = Number(process.env.ADU_BACKFILL_BATCH_SIZE ?? 500);
const ZILLOW_LOOKBACK_DAYS = Number(process.env.ZILLOW_LOOKBACK_DAYS ?? 90);

// Micro-concurrency: fetch this many detail pages at the same time.
// Each task releases its HTML (~1-2 MB) after parsing, so 5 in-flight
// pages stays comfortably within Render's 512 MB RAM.
const DETAIL_CONCURRENCY = Number(process.env.ADU_DETAIL_CONCURRENCY ?? 5);

// Hard per-step deadline: guarantees a stuck call can never freeze the whole
// run. Logs which listing/step hung, then the loop moves on.
function raceTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `[hang] ${label} did not finish in ${Math.round(ms / 1000)}s`,
          ),
        ),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// ── Promise pool: run tasks N-at-a-time ─────────────────────────────────────
// Processes an array of async task functions with a concurrency limit.
// Returns when all tasks have settled (resolved or rejected).
async function runPool(
  tasks: Array<() => Promise<void>>,
  concurrency: number,
): Promise<void> {
  let idx = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    async () => {
      while (idx < tasks.length) {
        const taskIndex = idx++;
        try {
          await tasks[taskIndex]();
        } catch (err) {
          logger.warn(
            `[zillow-adu] Pool task ${taskIndex} failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    },
  );
  await Promise.all(workers);
}

export class ZillowAduScraper extends ZillowScraper {
  readonly sourceName = "zillow-adu";

  constructor(options: ScraperOptions = {}) {
    super(options);
  }

  async run(): Promise<RawListing[]> {
    logger.info(
      `[${this.sourceName}] Starting ADU research scrape via Zillow (concurrency=${DETAIL_CONCURRENCY})`,
    );
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
        logger.warn(
          `[${this.sourceName}] STALLED — no listing completed in ${idleSec}s (RSS ${rssMB}MB, heap ${heapMB}MB)`,
        );
      } else {
        logger.info(
          `[${this.sourceName}] watchdog — idle ${idleSec}s, RSS ${rssMB}MB, heap ${heapMB}MB`,
        );
      }
    }, 60_000);

    // We import config from base to read markets
    const { config } = await import("../../../config");
    const zillowCfg = config.sources.zillow;
    const markets = zillowCfg.markets;

    // Persistent backfill tracker — skips listings already processed in
    // previous batches and lets runContinuous() advance one batch at a time.
    const previouslySeen = await loadSeenFromDb(this.sourceName);
    const allSeenUrls = new Set(previouslySeen);
    let processedThisBatch = 0;
    let skippedAsSeen = 0;

    for (const market of markets) {
      if (processedThisBatch >= BACKFILL_BATCH_SIZE) break;
      logger.info(
        `[${this.sourceName}] ── Market: ${market.name} (${market.listingType}) ──`,
      );

      let stopPaging = false;
      let rawScannedForMarket = 0;

      // Reverse pagination (oldest first) to backfill inventory across batches
      for (let page = zillowCfg.maxPagesPerMarket; page >= 1; page--) {
        if (stopPaging) break;
        if (rawScannedForMarket >= this.options.maxListings) break;
        if (processedThisBatch >= BACKFILL_BATCH_SIZE) break;

        logger.info(
          `[${this.sourceName}] ${market.name} — page ${page}/${zillowCfg.maxPagesPerMarket}`,
        );

        let pageListings: RawListing[] = [];
        try {
          // Call the protected scrapeMarketPage from the parent class, bypassing
          // price filter and the 30-day freshness cutoff so we backfill the
          // full inventory (oldest first via reverse pagination).
          const PAGE_TIMEOUT_MS = Number(
            process.env.ADU_PAGE_TIMEOUT_MS ?? 180_000,
          );
          const result = await raceTimeout<{
            listings: RawListing[];
            stop: boolean;
          }>(
            (this as any).scrapeMarketPage(market, page, true, false),
            PAGE_TIMEOUT_MS,
            `scrapeMarketPage ${market.name} p${page}`,
          );
          pageListings = result.listings;
          if (result.stop) stopPaging = true;
        } catch (err) {
          logger.error(
            `[${this.sourceName}] ${market.name} page ${page} error: ${err}`,
          );
          continue;
        }

        logger.info(
          `[${this.sourceName}] ${market.name} page ${page}: ${pageListings.length} raw listing(s)`,
        );

        // ── Phase 1: Cheap filters — collect listings that need detail fetch ──
        const pendingDetails: Array<{
          rawListing: RawListing;
          preFilter: AduResearchListing;
        }> = [];

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
          processedThisBatch++;

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
            source: this.sourceName,
            totalBedrooms: rawListing.bedrooms,
            zip,
            daysOnMarket: rawListing.daysOnMarket ?? rawListing.daysOnZillow,
            status: rawListing.status,
            lotSqft: rawListing.lotSqft,
          } as AduResearchListing;

          // ── CHEAP FILTERS FIRST (no network call) ──────────────────
          // 0. 90-day lookback — skip listings older than ZILLOW_LOOKBACK_DAYS
          const dom = preFilter.daysOnMarket;
          if (typeof dom === "number" && dom > ZILLOW_LOOKBACK_DAYS) {
            logger.debug(
              `[${this.sourceName}] [#${processedThisBatch}] skipped — ${dom} days on market > ${ZILLOW_LOOKBACK_DAYS}d limit`,
            );
            continue;
          }

          // 1. Location filter
          if (!passesLocationFilter(preFilter)) {
            logger.debug(
              `[${this.sourceName}] [#${processedThisBatch}] skipped — location filter`,
            );
            continue;
          }

          // 2. Property criteria (beds/baths/price/year)
          if (!passesPropertyCriteria(preFilter)) {
            logger.debug(
              `[${this.sourceName}] [#${processedThisBatch}] skipped — property criteria`,
            );
            continue;
          }

          // 2b. Title/address keyword pre-check — needs no detail fetch.
          const titleHaystack =
            `${preFilter.title ?? ""} ${preFilter.address ?? ""}`.toLowerCase();
          const titleMatchedKeyword = ADU_KEYWORDS.find((kw) => {
            const regex = new RegExp(`\\b${kw}\\b`, "i");
            return regex.test(titleHaystack);
          });

          if (titleMatchedKeyword) {
            const enriched = {
              ...preFilter,
              matchedKeyword: titleMatchedKeyword,
            } as AduResearchListing;
            this.results.push(enriched);
            aduRunState.matched = this.results.length;
            logger.info(
              `[${this.sourceName}] ✓ MATCHED ADU KEYWORD (title/address): ${titleMatchedKeyword}`,
            );
            if (this.options.onMatch) {
              try {
                const MATCH_TIMEOUT_MS = Number(
                  process.env.ADU_MATCH_TIMEOUT_MS ?? 300_000,
                );
                await raceTimeout(
                  this.options.onMatch(enriched),
                  MATCH_TIMEOUT_MS,
                  `onMatch ${rawListing.url}`,
                );
              } catch (err) {
                logger.warn(
                  `[${this.sourceName}] ${rawListing.url}: ${err instanceof Error ? err.message : err}`,
                );
              }
            }
            lastProgressAt = Date.now();
            aduRunState.lastProgressAt = lastProgressAt;
            continue;
          }

          // Listing passed cheap filters — queue it for detail fetch
          pendingDetails.push({ rawListing, preFilter });
        }

        // ── Phase 2: Fetch detail pages via BullMQ Queue ───────────────
        if (pendingDetails.length > 0) {
          logger.info(
            `[${this.sourceName}] ${market.name} page ${page}: Enqueuing ` +
              `${pendingDetails.length} listings to BullMQ queue`
          );

          for (const { rawListing, preFilter } of pendingDetails) {
            await descriptionQueue.add('fetch-description', {
              source: 'zillow-adu',
              url: rawListing.url,
              preFilter,
              sessionId: (this as any).sessionId
            });
          }
          lastProgressAt = Date.now();
        }

        if (pageListings.length === 0) {
          logger.info(
            `[${this.sourceName}] ${market.name} — no listings on page ${page}, skipping to next older page`,
          );
        }

        await sleep(jitter(BETWEEN_PAGE_MS));
      }
      if (processedThisBatch >= BACKFILL_BATCH_SIZE) break;
      if (global.gc) global.gc();
      logger.info(
        `[${this.sourceName}] Memory after ${market.name}: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`,
      );
    }

    logger.info(
      `[${this.sourceName}] Processed ${processedThisBatch} new listings, skipped ${skippedAsSeen} already-seen`,
    );

    // ── Save updated tracker to DB ─────────────────────────────
    await saveSeenToDb(this.sourceName, allSeenUrls, processedThisBatch);

    clearInterval(watchdog);
    return this.results;
  }
}
