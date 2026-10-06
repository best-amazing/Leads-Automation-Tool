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

import { RawListing } from "../../../types/listing";
import {
  ColdwellBankerScraper,
  CbInventoryMode,
  discoverUnseenListingUrls,
  extractLid,
  DEFAULT_CB_DELAY_MS,
  CB_CONCURRENCY,
} from "../../coldwellbanker/coldwellbanker.scraper";
import { ScraperOptions } from "../../base.scraper";
import { AduResearchListing } from "../core/adu-research.parser";
import {
  passesLocationFilter,
  passesKeywordFilter,
  passesPropertyCriteria,
} from "../filters/adu-research.scraper";
import { logger } from "../../../utils/logger";
import { sleep, jitter } from "../../../utils/browser";
import {
  filterUnseenIds,
  markSeenIds,
  saveBackfillStatus,
} from "../../../utils/backfill-store";
import { findAduKeyword, TARGET_STATES } from "../core/adu-keywords";
import { descriptionQueue } from "../../../utils/queue";

export const CB_BACKFILL_BATCH_SIZE = Number(process.env.CB_BACKFILL_BATCH_SIZE ?? 500);
const BACKFILL_BATCH_SIZE = CB_BACKFILL_BATCH_SIZE;
const CB_LOOKBACK_DAYS = Number(process.env.CB_LOOKBACK_DAYS ?? 90);

export class ColdwellBankerAduScraper extends ColdwellBankerScraper {
  readonly sourceName: string = "coldwellbanker-adu";

  constructor(options: ScraperOptions = {}) {
    super(options);
  }

  override async run(): Promise<RawListing[]> {
    logger.info(
      `[${this.sourceName}] Starting ADU research scrape via Coldwell Banker`,
    );
    this.visited.clear();
    this.results = [];

    const mode = (process.env.CB_INVENTORY_MODE as CbInventoryMode) || "full";
    logger.info(
      `[${this.sourceName}] Inventory mode: ${mode}, lookback: ${CB_LOOKBACK_DAYS} days`,
    );
    const batchCap = Math.min(BACKFILL_BATCH_SIZE, this.options.maxListings);

    // ── Discover only this batch's unseen listings ───────────────────────
    // Chunks are read in TARGET_STATES priority order (Ohio first) and the
    // seen check runs per chunk against the DB, so neither the full sitemap
    // inventory (~200k URLs) nor the full seen set is ever held in memory,
    // and discovery stops as soon as the batch is full.
    let batch: string[];
    try {
      const discovery = await discoverUnseenListingUrls(
        mode,
        TARGET_STATES,
        batchCap,
        (lids) => filterUnseenIds(this.sourceName, lids),
      );
      batch = discovery.urls;
      logger.info(
        `[${this.sourceName}] ${discovery.skippedSeen} already seen, ` +
          `${batch.length} to process (batch cap ${batchCap})`,
      );
    } catch (err) {
      // Never treat a DB/sitemap failure as "everything is new". Record an
      // empty batch so runContinuous() stops instead of looping on the
      // previous batch's processedCount.
      logger.error(`[${this.sourceName}] Discovery failed, skipping batch: ${err}`);
      await saveBackfillStatus(this.sourceName, 0).catch(() => {});
      return this.results;
    }

    // ── Enqueue detail fetch to BullMQ ────────────────────────────────────
    if (batch.length > 0) {
      await descriptionQueue.addBulk(
        batch.map((url) => ({
          name: 'fetch-description',
          data: { source: this.sourceName, url },
        })),
      );
    }
    const processedThisBatch = batch.length;

    logger.info(
      `[${this.sourceName}] Enqueued ${processedThisBatch} new listing(s), matched ${this.results.length}`,
    );

    // ── Persist: mark this batch seen (insert-only) + batch status ───────
    await markSeenIds(this.sourceName, batch.map(extractLid));
    await saveBackfillStatus(this.sourceName, processedThisBatch);

    return this.results;
  }

  /** Apply ADU filters and emit matches through onMatch. */
  private async ingestAduListing(listing: AduResearchListing): Promise<void> {
    listing.source = this.sourceName;
    listing.totalBedrooms = listing.bedrooms;

    // Stage 0: 90-day lookback — skip listings older than CB_LOOKBACK_DAYS
    if (
      listing.daysOnMarket != null &&
      listing.daysOnMarket > CB_LOOKBACK_DAYS
    ) {
      logger.debug(
        `[${this.sourceName}] Skipping — ${listing.daysOnMarket} days on market > ${CB_LOOKBACK_DAYS}d limit: ${listing.address}`,
      );
      return;
    }

    // Stage 1: location — URLs are state-scoped but verify parsed state
    if (!passesLocationFilter(listing)) return;
    // Stage 2: hard property criteria (price/beds/baths/year/type exclusions)
    if (!passesPropertyCriteria(listing)) return;
    // Stage 3: ADU keyword match against title/description/address
    if (!passesKeywordFilter(listing)) return;

    const haystack = [listing.title, listing.description, listing.address]
      .join(" ")
      .toLowerCase();
    listing.matchedKeyword = findAduKeyword(haystack);

    this.visited.add(extractLid(listing.url));
    this.results.push(listing);
    logger.info(
      `[${this.sourceName}] ✓ MATCHED ADU KEYWORD: ${listing.matchedKeyword} — ${listing.address}`,
    );

    if (this.options.onMatch) {
      try {
        await this.options.onMatch(listing);
      } catch (err) {
        logger.warn(
          `[${this.sourceName}] onMatch failed for ${listing.url}: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }
  }
}
