import 'dotenv/config';
import { Job } from 'bullmq';
import { createDescriptionWorker } from '../../../utils/queue';
import { logger } from '../../../utils/logger';
import { AduResearchListing } from '../core/adu-research.parser';
import { aduRunState } from '../core/adu-run-state';
import {
  oxylabsFetch,
  extractNextData,
} from '../../zillow/zillow.scraper';
import { sleep, jitter } from '../../../utils/browser';
import { ADU_KEYWORDS } from '../core/adu-keywords';
import { parseCraigslistDetailPage } from '../../craigslist/craigslist.parser';
import { ColdwellBankerAduScraper } from '../sources/coldwellbanker-adu.scraper';

// We need to trigger the same logic as `onMatch` in run-adu-research
import {
  validateIndianaLeadZip,
} from '../filters/adu-research.scraper';
import { fetchDeedTransferDate } from '../core/deed-data-resolver';
import { appendAduResult } from '../core/adu-csv-writer';
import { writeAduResearchToSheets } from '../../../utils/google-sheets';
import { AduDedupeTracker } from '../core/adu-dedupe-tracker';

const tracker = new AduDedupeTracker();
let capturedCount = 0;

async function handleMatch(listing: AduResearchListing) {
  if (!validateIndianaLeadZip(listing)) {
    logger.warn(`[worker] Ignoring Indiana lead with non-46xxx ZIP: ${listing.address || listing.url} | zip=${String(listing.zip ?? '(missing)')}`);
    return;
  }

  if (!(await tracker.track(listing))) {
    logger.debug(`[worker] Skipping duplicate: ${listing.address || listing.url}`);
    return;
  }

  capturedCount++;
  logger.info(`[worker] Match #${capturedCount}: ${listing.address || listing.url}`);

  if (listing.address) {
    try {
      logger.info(`[worker] Looking up deed transfer date for: ${listing.address}`);
      const deedDate = await fetchDeedTransferDate({
        address: listing.address,
        city: listing.city,
        state: listing.state,
        zip: listing.zip,
        latitude: listing.latitude,
        longitude: listing.longitude,
      });
      if (deedDate) {
        listing.deedTransferDate = deedDate;
        logger.info(`[worker] ✓ Deed transfer date: ${deedDate}`);
      } else {
        logger.info(`[worker] ✗ No deed transfer date found`);
      }
    } catch (err) {
      logger.warn(`[worker] Deed date lookup failed: ${err}`);
    }
  }

  appendAduResult(listing);
  await writeAduResearchToSheets([listing]);
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
        if (!description) {
          const rawCache = props?.gdpClientCache ?? props?.componentProps?.gdpClientCache;
          if (rawCache) {
            try {
              const cache = typeof rawCache === 'string' ? JSON.parse(rawCache) : rawCache;
              for (const key of Object.keys(cache ?? {})) {
                const propData = cache[key]?.property;
                if (propData) {
                  if (propData.description) description = propData.description;
                  if (propData.yearBuilt) yearBuilt = Number(propData.yearBuilt);
                  if (propData.homeStatus) status = propData.homeStatus;
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
  } as AduResearchListing;

  const haystack = [enriched.title, enriched.description, enriched.address].join(' ').toLowerCase();
  const matchedKeyword = ADU_KEYWORDS.find((kw) => {
    const regex = new RegExp(`\\b${kw}\\b`, 'i');
    return regex.test(haystack);
  });

  if (matchedKeyword) {
    enriched.matchedKeyword = matchedKeyword;
    logger.info(`[${sourceName}-worker] ✓ MATCHED ADU KEYWORD: ${matchedKeyword}`);
    await handleMatch(enriched);
    await sleep(jitter(1000));
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
  }

  const enriched: AduResearchListing = {
    ...preFilter,
    ...detail,
    description,
  } as AduResearchListing;

  const haystack = [enriched.title, enriched.description, enriched.address].join(" ").toLowerCase();
  const matchedKeyword = ADU_KEYWORDS.find((kw) => {
    const regex = new RegExp(`\\b${kw}\\b`, "i");
    return regex.test(haystack);
  });

  if (matchedKeyword) {
    enriched.matchedKeyword = matchedKeyword;
    logger.info(`[${sourceName}-worker] ✓ MATCHED ADU KEYWORD: ${matchedKeyword}`);
    await handleMatch(enriched);
    await sleep(jitter(1000));
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
  const matchedKeyword = ADU_KEYWORDS.find((kw) => {
    const regex = new RegExp(`\\b${kw.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}\\b`, 'i');
    return regex.test(haystack);
  });

  if (matchedKeyword) {
    listing.matchedKeyword = matchedKeyword;
    logger.info(`[${sourceName}-worker] ✓ MATCHED ADU KEYWORD: ${matchedKeyword}`);
    await handleMatch(listing);
  }
}

// Create and export the worker
export const worker = createDescriptionWorker(async (job) => {
  logger.info(`[worker] Processing job ${job.id} for source ${job.data.source}`);
  
  if (job.data.source === 'zillow-adu') {
    await processZillow(job);
  } else if (job.data.source === 'craigslist-adu') {
    await processCraigslist(job);
  } else if (job.data.source === 'coldwellbanker-adu') {
    await processColdwellBanker(job);
  } else if (job.data.source === 'investorlift-adu') {
    await processInvestorLift(job);
  } else if (
    job.data.source === 'redfin-adu' ||
    job.data.source === 'creative-listing-adu' ||
    job.data.source === 'crexi-adu' ||
    job.data.source === 'offmarket-adu'
  ) {
    // These "fast" scrapers already did all the heavy lifting upfront.
    // They just enqueue the final listing here to be written to Google Sheets.
    await handleMatch(job.data.listing);
  } else {
    logger.warn(`[worker] Unknown source ${job.data.source}`);
  }
}, {
  concurrency: Number(process.env.ADU_DETAIL_CONCURRENCY ?? 5)
});

logger.info(`[worker] Description queue worker started successfully.`);
