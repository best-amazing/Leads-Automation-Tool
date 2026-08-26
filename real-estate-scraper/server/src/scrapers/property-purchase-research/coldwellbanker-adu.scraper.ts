// src/scrapers/property-purchase-research/coldwellbanker-adu.scraper.ts
// ─────────────────────────────────────────────────────────────────────────────
// ADU research wrapper around the Coldwell Banker sitemap scraper.
//
// Mirrors ZillowAduScraper / RedfinAduScraper:
//   • DB-backed seen-set (backfill-store) keyed on the stable lid- id, so
//     "process the entire inventory" converges — each run only fetches
//     listings never processed before.
//   • Discovery-time dedup happens BEFORE any detail fetch, so re-sweeps of
//     the full sitemap cost ~50 free HTTP calls instead of thousands.
//   • Same ADU filter chain (location → property criteria → keyword match on
//     the description) and the same onMatch → CSV → Sheets pipeline.
//
// Inventory mode via CB_INVENTORY_MODE env:
//   "new-day"  — fresh listings added today (default for steady-state cron)
//   "new-week" — rolling week window
//   "full"     — entire active OH inventory (~47K) for one-time backfill
//
// Batch cap: CB_BACKFILL_BATCH_SIZE (default 1000) per run() call; the
// runner's runContinuous() loop immediately starts the next batch while
// processedCount >= 1000, exactly like zillow/redfin backfill behavior.
// ─────────────────────────────────────────────────────────────────────────────

import { RawListing } from "../../types/listing";
import {
  ColdwellBankerScraper,
  CbInventoryMode,
  discoverOhioListingUrls,
  extractLid,
  DEFAULT_CB_DELAY_MS,
  CB_CONCURRENCY,
} from "../coldwellbanker/coldwellbanker.scraper";
import { ScraperOptions } from "../base.scraper";
import { AduResearchListing } from "./adu-research.parser";
import {
  passesLocationFilter,
  passesKeywordFilter,
  passesPropertyCriteria,
} from "./adu-research.scraper";
import { logger } from "../../utils/logger";
import { sleep, jitter } from "../../utils/browser";
import {
  loadSeenListings as loadSeenFromDb,
  saveSeenListings as saveSeenToDb,
} from "../../utils/backfill-store";
import { ADU_KEYWORDS } from "./adu-keywords";

const BACKFILL_BATCH_SIZE = Number(process.env.CB_BACKFILL_BATCH_SIZE ?? 500);
const CB_LOOKBACK_DAYS = Number(process.env.CB_LOOKBACK_DAYS ?? 90);

export class ColdwellBankerAduScraper extends ColdwellBankerScraper {
  readonly sourceName: string = "coldwellbanker-adu";

  constructor(options: ScraperOptions = {}) {
    super(options);
  }

  override async run(): Promise<RawListing[]> {
    logger.info(`[${this.sourceName}] Starting ADU research scrape via Coldwell Banker`);
    this.visited.clear();
    this.results = [];

    const mode = (process.env.CB_INVENTORY_MODE as CbInventoryMode) || "full";
    logger.info(`[${this.sourceName}] Inventory mode: ${mode}, lookback: ${CB_LOOKBACK_DAYS} days`);
    const previouslySeen = await loadSeenFromDb(this.sourceName);
    const reservedLids = new Set(previouslySeen); // intra-run double-processing guard

    // ── Discover + subtract seen BEFORE any expensive fetch ──────────────
    const discovered = await discoverOhioListingUrls(mode);
    const queue: string[] = [];
    let skippedAsSeen = 0;
    for (const url of discovered) {
      const lid = extractLid(url);
      if (reservedLids.has(lid)) {
        skippedAsSeen++;
        continue;
      }
      reservedLids.add(lid); // reserve now so concurrent workers can't double-process
      queue.push(url);
    }
    logger.info(
      `[${this.sourceName}] ${discovered.length} discovered, ` +
        `${skippedAsSeen} already seen, ${queue.length} to process ` +
        `(batch cap ${Math.min(BACKFILL_BATCH_SIZE, this.options.maxListings)})`
    );

    const work = queue.slice(0, Math.min(BACKFILL_BATCH_SIZE, this.options.maxListings));
    let processedThisBatch = 0;

    // Only lids whose fetch attempt COMPLETED (listing parsed, or definitive
    // no-data such as non-ACTIVE status) may be persisted as seen. Transport
    // failures throw and stay out of this set, so the listing is retried on
    // the next run instead of being burned as "seen" unprocessed.
    const completedLids = new Set<string>();

    // ── Concurrent detail fetch with polite pacing ────────────────────────
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < work.length && processedThisBatch < BACKFILL_BATCH_SIZE) {
        const url = work[cursor++];
        try {
          const listing = await this.fetchListingDetail(url);
          completedLids.add(extractLid(url));
          if (listing) {
            await this.ingestAduListing(listing as AduResearchListing);
          }
        } catch (err) {
          logger.warn(
            `[${this.sourceName}] ${url}: ${err instanceof Error ? err.message : err}`
          );
        }
        processedThisBatch++;
        if (processedThisBatch % 25 === 0) {
          logger.info(
            `[${this.sourceName}] progress ${processedThisBatch}/${work.length} ` +
              `(matches: ${this.results.length})`
          );
        }
        await sleep(jitter(DEFAULT_CB_DELAY_MS));
      }
    };

    const workerCount = Math.min(CB_CONCURRENCY, work.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    logger.info(
      `[${this.sourceName}] Processed ${processedThisBatch} new listing(s), ` +
        `skipped ${skippedAsSeen} already-seen, matched ${this.results.length}`
    );

    // ── Persist updated tracker: previously seen + actually completed only ──
    const persistedSeen = new Set(previouslySeen);
    for (const lid of completedLids) persistedSeen.add(lid);
    await saveSeenToDb(this.sourceName, persistedSeen, processedThisBatch);

    return this.results;
  }

  /** Apply ADU filters and emit matches through onMatch. */
  private async ingestAduListing(listing: AduResearchListing): Promise<void> {
    listing.source = this.sourceName;
    listing.totalBedrooms = listing.bedrooms;

    // Stage 0: 90-day lookback — skip listings older than CB_LOOKBACK_DAYS
    if (listing.daysOnMarket != null && listing.daysOnMarket > CB_LOOKBACK_DAYS) {
      logger.debug(
        `[${this.sourceName}] Skipping — ${listing.daysOnMarket} days on market > ${CB_LOOKBACK_DAYS}d limit: ${listing.address}`
      );
      return;
    }

    // Stage 1: location (OH) — URLs are /oh/-scoped but verify parsed state
    if (!passesLocationFilter(listing)) return;
    // Stage 2: hard property criteria (price/beds/baths/year/type exclusions)
    if (!passesPropertyCriteria(listing)) return;
    // Stage 3: ADU keyword match against title/description/address
    if (!passesKeywordFilter(listing)) return;

    const haystack = [listing.title, listing.description, listing.address]
      .join(" ")
      .toLowerCase();
    listing.matchedKeyword = ADU_KEYWORDS.find((kw) => {
      const regex = new RegExp(`\\b${kw.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&")}\\b`, "i");
      return regex.test(haystack);
    });

    this.visited.add(extractLid(listing.url));
    this.results.push(listing);
    logger.info(
      `[${this.sourceName}] ✓ MATCHED ADU KEYWORD: ${listing.matchedKeyword} — ${listing.address}`
    );

    if (this.options.onMatch) {
      try {
        await this.options.onMatch(listing);
      } catch (err) {
        logger.warn(
          `[${this.sourceName}] onMatch failed for ${listing.url}: ${
            err instanceof Error ? err.message : err
          }`
        );
      }
    }
  }
}
