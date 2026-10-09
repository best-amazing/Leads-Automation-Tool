import 'dotenv/config';
import { DelayedError, Job } from 'bullmq';
import { createDescriptionWorker } from '../../../utils/queue';
import { logger } from '../../../utils/logger';
import { AduResearchListing } from '../core/adu-research.parser';
import { aduRunState } from '../core/adu-run-state';
import {
  oxylabsFetch,
  extractNextData,
} from '../../zillow/zillow.scraper';
import { findAduKeyword } from '../core/adu-keywords';
import { parseCraigslistDetailPage } from '../../craigslist/craigslist.parser';
import { ColdwellBankerAduScraper } from '../sources/coldwellbanker-adu.scraper';

// We need to trigger the same logic as `onMatch` in run-adu-research
import {
  validateLeadZip,
  passesNewConstructionGate,
  passesTargetStateGate,
} from '../filters/adu-research.scraper';
import { resolvePublicRecords } from '../core/public-records';
import { qualifiesForStrictSheet } from '../core/strict-sheet';
import { appendAduResult } from '../core/adu-csv-writer';
import { queueAduSheetWrite } from '../../../utils/google-sheets';
import { AduDedupeTracker } from '../core/adu-dedupe-tracker';

const tracker = new AduDedupeTracker();
let capturedCount = 0;

// ── Per-source throttle ─────────────────────────────────────────────────────
// Some sources (e.g. Coldwell Banker) rate-limit aggressively. Each job for a
// throttled source reserves a start slot spaced SOURCE_MIN_DELAY_MS apart. A
// job whose slot is in the future is moved back to BullMQ's delayed set
// instead of sleeping, so it never occupies a worker slot while waiting and
// jobs for other sources keep flowing.
const SOURCE_MIN_DELAY_MS: Record<string, number> = {
  'coldwellbanker-adu': 5_000,  // 5s between CB fetch starts
  'craigslist-adu': 2_000,      // 2s between CL fetch starts
};
const nextSlotAt: Record<string, number> = {};
const SLOT_TOLERANCE_MS = 250;

/** Returns 0 when the job may run now, otherwise the timestamp to delay it to. */
function reserveSlot(job: Job, source: string): number {
  const minDelay = SOURCE_MIN_DELAY_MS[source];
  if (!minDelay) return 0; // no throttle for this source

  const now = Date.now();
  const reserved = job.data._slotAt;
  if (typeof reserved === 'number' && now >= reserved - SLOT_TOLERANCE_MS) {
    return 0; // this job's reserved slot has arrived
  }

  const slot = Math.max(now, nextSlotAt[source] ?? 0);
  nextSlotAt[source] = slot + minDelay;
  return slot - now <= SLOT_TOLERANCE_MS ? 0 : slot;
}

async function handleMatch(listing: AduResearchListing) {
  if (!passesTargetStateGate(listing)) return;

  if (!validateLeadZip(listing)) {
    logger.warn(`[worker] Ignoring lead outside allowed ZIPs for its state: ${listing.address || listing.url} | zip=${String(listing.zip ?? '(missing)')}`);
    return;
  }

  if (!passesNewConstructionGate(listing)) return;

  if (!(await tracker.track(listing))) {
    logger.debug(`[worker] Skipping duplicate: ${listing.address || listing.url}`);
    return;
  }

  capturedCount++;
  logger.info(`[worker] Match #${capturedCount}: ${listing.address || listing.url}`);

  // Deed date + year built from public records, then the final
  // new-construction check with the most complete year available.
  await resolvePublicRecords(listing, '[worker]');
  if (!passesNewConstructionGate(listing)) return;

  appendAduResult(listing);
  // Buffered: flushed to Sheets in batches and serialized, so concurrent
  // jobs never race on the target row.
  queueAduSheetWrite(listing);
  // Second spreadsheet: same lead, tighter criteria (core/strict-sheet.ts)
  if (qualifiesForStrictSheet(listing)) queueAduSheetWrite(listing, 'strict');
}

/**
 * Zillow detail fetcher
 */
async function processZillow(job: Job) {
  const { url, preFilter, sessionId } = job.data as { url: string; preFilter: AduResearchListing; sessionId: string };
  const sourceName = 'zillow-adu';
  
  logger.info(`[${sourceName}-worker] Fetching description: ${preFilter.address ?? url} (daysOnZillow=${preFilter.daysOnMarket ?? '?'})`);

  let description = '';
  let units: number | undefined;
  let yearBuilt: number | undefined;
  let schoolRating: string | undefined;
  let status: string | undefined;
  let lotSqft: number | undefined;
  let hoaFee: number | undefined;
  let homeType: string | undefined;

  try {
    const FETCH_TIMEOUT_MS = Number(process.env.ADU_FETCH_TIMEOUT_MS ?? 180_000);
    // Simple promise race for timeout
    let html: string | null = await Promise.race([
      oxylabsFetch(url, sessionId),
      new Promise<null>((_, reject) => setTimeout(() => reject(new Error(`[hang] detail fetch ${url} did not finish`)), FETCH_TIMEOUT_MS))
    ]);

    if (html) {
      const json = extractNextData(html);
      html = null; 
      if (json) {
        const props = json?.props?.pageProps;
        description = props?.componentProps?.description ?? '';
        // Always read the property cache: it carries yearBuilt (needed for the
        // new-construction exclusion), status, lot size and schools even when
        // the description came from componentProps.
        const rawCache = props?.gdpClientCache ?? props?.componentProps?.gdpClientCache;
        if (rawCache) {
          try {
            const cache = typeof rawCache === 'string' ? JSON.parse(rawCache) : rawCache;
            for (const key of Object.keys(cache ?? {})) {
              const propData = cache[key]?.property;
              if (propData) {
                if (!description && propData.description) description = propData.description;
                if (propData.yearBuilt) yearBuilt = Number(propData.yearBuilt);
                if (propData.homeStatus) status = propData.homeStatus;
                if (propData.homeType) homeType = String(propData.homeType);
                // Monthly HOA: numeric field, else resoFacts text like "$45 monthly"
                const hoaRaw = propData.monthlyHoaFee ?? propData.resoFacts?.hoaFee ?? propData.resoFacts?.associationFee;
                if (hoaRaw != null) {
                  const fee = typeof hoaRaw === 'number' ? hoaRaw : Number(String(hoaRaw).replace(/[^\d.]/g, ''));
                  if (Number.isFinite(fee)) hoaFee = fee;
                }
                if (propData.lotAreaValue) {
                  if (propData.lotAreaUnit === 'acres') lotSqft = Math.round(propData.lotAreaValue * 43560);
                  else lotSqft = Math.round(propData.lotAreaValue);
                }
                if (Array.isArray(propData.schools) && propData.schools.length > 0) {
                  const hs = propData.schools.find((s: any) => s.level === 'High');
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
  } catch (err) {
    logger.warn(`[${sourceName}-worker] ${url}: ${err instanceof Error ? err.message : err}`);
    throw err; // Let BullMQ handle retries
  }

  const enriched: AduResearchListing = {
    ...preFilter,
    description,
    units,
    yearBuilt: yearBuilt ?? preFilter.yearBuilt,
    schoolRating,
    status: status ?? preFilter.status,
    lotSqft: lotSqft ?? preFilter.lotSqft,
    hoaFee: hoaFee ?? preFilter.hoaFee,
    homeType: homeType ?? preFilter.homeType,
  } as AduResearchListing;

  const haystack = [enriched.title, enriched.description, enriched.address].join(' ').toLowerCase();
  const matchedKeyword = findAduKeyword(haystack);

  if (matchedKeyword) {
    enriched.matchedKeyword = matchedKeyword;
    logger.info(`[${sourceName}-worker] ✓ MATCHED ADU KEYWORD: ${matchedKeyword}`);
    await handleMatch(enriched);
  }
}


async function processCraigslist(job: Job) {
  const { url, preFilter } = job.data as { url: string; preFilter: AduResearchListing };
  const sourceName = 'craigslist-adu';
  
  logger.info(`[${sourceName}-worker] Fetching description: ${url}`);
  let description = "";
  let detail = {};

  try {
    const FETCH_TIMEOUT_MS = Number(process.env.ADU_FETCH_TIMEOUT_MS ?? 180_000);
    const detailHtml = await Promise.race([
      oxylabsFetch(url),
      new Promise<null>((_, reject) => setTimeout(() => reject(new Error(`[hang] detail fetch ${url} did not finish`)), FETCH_TIMEOUT_MS))
    ]);
    if (detailHtml) {
      detail = parseCraigslistDetailPage(detailHtml);
      description = (detail as any).description || "";
    }
  } catch (err) {
    logger.warn(`[${sourceName}-worker] ${url}: ${err instanceof Error ? err.message : err}`);
    // Let BullMQ retry the fetch; only on the final attempt fall through and
    // match on the search-page title alone.
    if (job.attemptsMade + 1 < (job.opts.attempts ?? 1)) throw err;
  }

  const enriched: AduResearchListing = {
    ...preFilter,
    ...detail,
    description,
  } as AduResearchListing;

  const haystack = [enriched.title, enriched.description, enriched.address].join(" ").toLowerCase();
  const matchedKeyword = findAduKeyword(haystack);

  if (matchedKeyword) {
    enriched.matchedKeyword = matchedKeyword;
    logger.info(`[${sourceName}-worker] ✓ MATCHED ADU KEYWORD: ${matchedKeyword}`);
    await handleMatch(enriched);
  }
}

async function processColdwellBanker(job: Job) {
  const { url } = job.data as { url: string };
  const scraper = new ColdwellBankerAduScraper({ onMatch: handleMatch });
  const listing = await scraper.fetchListingDetail(url);
  if (listing) {
    await (scraper as any).ingestAduListing(listing);
  }
}


async function processInvestorLift(job: Job) {
  const { listing } = job.data as { listing: AduResearchListing };
  const sourceName = 'investorlift-adu';

  // The listing already passed location + property filters in the scraper.
  // Apply keyword check and handleMatch directly — do NOT call enrichAfterFilter
  // because it would enqueue right back to this queue (infinite loop).
  const haystack = [listing.title, listing.description, listing.address]
    .join(' ')
    .toLowerCase();
  const matchedKeyword = findAduKeyword(haystack);

  if (matchedKeyword) {
    listing.matchedKeyword = matchedKeyword;
    logger.info(`[${sourceName}-worker] ✓ MATCHED ADU KEYWORD: ${matchedKeyword}`);
    await handleMatch(listing);
  }
}

// Create and export the worker
export const worker = createDescriptionWorker(async (job, token) => {
  const source = job.data.source;

  // Respect per-source rate limits without holding a worker slot
  const delayUntil = reserveSlot(job, source);
  if (delayUntil) {
    logger.debug(`[worker] Throttling ${source} job ${job.id} for ${delayUntil - Date.now()}ms`);
    await job.updateData({ ...job.data, _slotAt: delayUntil });
    await job.moveToDelayed(delayUntil, token);
    throw new DelayedError();
  }

  logger.info(`[worker] Processing job ${job.id} for source ${source}`);

  if (source === 'zillow-adu') {
    if (job.data.listing) {
      // Already matched on title/address during the search walk — no detail fetch.
      await handleMatch(job.data.listing);
    } else {
      await processZillow(job);
    }
  } else if (source === 'craigslist-adu') {
    await processCraigslist(job);
  } else if (source === 'coldwellbanker-adu') {
    await processColdwellBanker(job);
  } else if (source === 'investorlift-adu') {
    await processInvestorLift(job);
  } else if (
    source === 'redfin-adu' ||
    source === 'creative-listing-adu' ||
    source === 'crexi-adu' ||
    source === 'offmarket-adu'
  ) {
    // These "fast" scrapers already did all the heavy lifting upfront.
    // They just enqueue the final listing here to be written to Google Sheets.
    await handleMatch(job.data.listing);
  } else {
    logger.warn(`[worker] Unknown source ${source}`);
  }
}, {
  concurrency: Number(process.env.ADU_DETAIL_CONCURRENCY ?? 5)
});

logger.info(`[worker] Description queue worker started successfully.`);
