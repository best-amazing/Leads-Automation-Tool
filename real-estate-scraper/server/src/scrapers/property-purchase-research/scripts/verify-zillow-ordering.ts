// src/scrapers/property-purchase-research/verify-zillow-ordering.ts
// ─────────────────────────────────────────────────────────────────────────────
// Diagnostic tool to prove how Zillow search results are ordered and that the
// ADU scraper pulls them correctly (oldest-first across pages).
//
// It inspects the RAW __NEXT_DATA__ (not the parsed listing shape) and reports:
//   - per page: how many listResults vs mapResults items
//   - per item:  page | bucket | daysOnZillow | address
//   - within-page ordering check: listResults must be ascending in days
//     (Zillow sorts newest-first within a page)
//   - cross-page check: older pages (higher page #) must contain older
//     listings (higher/equal days) than newer pages
//   - duplicate zpid count
//
// Usage:
//   npm run verify:zillow
//   ZILLOW_VERIFY_PAGES="20,10,1" ZILLOW_VERIFY_MARKET=https://www.zillow.com/oh/ \
//     npm run verify:zillow
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { oxylabsFetch, extractNextData } from "../zillow/zillow.scraper";
import { logger } from "../../utils/logger";

const BASE_URL = process.env.ZILLOW_VERIFY_MARKET || "https://www.zillow.com/oh/";
// Pages to fetch. Reverse-pagination order (oldest page first) mirrors the scraper.
const PAGES = (process.env.ZILLOW_VERIFY_PAGES ?? "20,1")
  .split(",").map(Number).filter((n) => !isNaN(n) && n > 0).sort((a, b) => b - a);

function buildUrl(page: number): string {
  const filterState: Record<string, any> = {
    fsba: { value: true }, // active: for-sale by agent
    fsbo: { value: true }, // active: for-sale by owner
    nc:   { value: false },
    cmsn: { value: false },
    auc:  { value: false },
    fore: { value: false },
    pf:   { value: false },
  };
  const state: any = { filterState, sortSelection: { value: "days" } };
  if (page > 1) state.pagination = { currentPage: page };
  return `${BASE_URL}?searchQueryState=${encodeURIComponent(JSON.stringify(state))}`;
}

function daysOf(item: any): number | undefined {
  return item.daysOnZillow ?? item.hdpData?.homeInfo?.daysOnZillow ?? undefined;
}

interface Item { page: number; bucket: "list" | "map"; days: number | undefined; addr: string; zpid: string }

async function main(): Promise<void> {
  const items: Item[] = [];
  const pageRanges = new Map<number, { min: number; max: number; n: number }>();

  for (const page of PAGES) {
    logger.info(`[verify] Fetching page ${page} → ${buildUrl(page)}`);
    const html = await oxylabsFetch(buildUrl(page));
    if (!html) { logger.warn(`[verify] page ${page}: fetch failed/blocked`); continue; }

    const json = extractNextData(html);
    const ss = json?.props?.pageProps?.searchPageState ?? json;
    const cat1 = ss?.cat1?.searchResults ?? {};
    const list = cat1.listResults ?? [];
    const map  = cat1.mapResults ?? [];

    logger.info(`[verify] page ${page}: listResults=${list.length} mapResults=${map.length}`);

    const pageDays: number[] = [];
    for (const it of list) {
      const d = daysOf(it);
      if (d != null) pageDays.push(d);
      items.push({ page, bucket: "list", days: d, addr: it.address ?? "?", zpid: String(it.zpid ?? "") });
    }
    for (const it of map) {
      const d = daysOf(it);
      items.push({ page, bucket: "map", days: d, addr: it.address ?? "?", zpid: String(it.zpid ?? "") });
    }
    if (pageDays.length > 0) {
      pageRanges.set(page, { min: Math.min(...pageDays), max: Math.max(...pageDays), n: pageDays.length });
    }
  }

  // ── Item table (oldest page first, matches scraper order) ───────────────
  logger.info("─".repeat(90));
  logger.info("page | bucket | daysOnZillow | address");
  logger.info("─".repeat(90));
  for (const it of items) {
    logger.info(
      `${String(it.page).padStart(4)} | ${it.bucket.padEnd(4)} | ${String(it.days ?? "null").padStart(5)} | ${it.addr}`
    );
  }

  // ── Within-page ordering: listResults must be ascending in days ──────────
  let withinViolations = 0;
  for (const page of PAGES) {
    const pageItems = items.filter((i) => i.page === page && i.bucket === "list" && i.days != null);
    for (let i = 1; i < pageItems.length; i++) {
      if (pageItems[i].days! < pageItems[i - 1].days!) {
        withinViolations++;
        logger.warn(
          `[verify] WITHIN-PAGE VIOLATION page ${page}: ${pageItems[i-1].days} → ${pageItems[i].days} ` +
          `(${pageItems[i-1].addr} → ${pageItems[i].addr})`
        );
      }
    }
  }
  logger.info(`[verify] Within-page ordering violations: ${withinViolations}${withinViolations === 0 ? " ✓ (listResults ascending in days = Zillow newest-first)" : ""}`);

  // ── Cross-page: older page must have >= days than newer page ─────────────
  const sortedPages = [...pageRanges.entries()].sort((a, b) => b[0] - a[0]); // 20 → 1
  let crossViolations = 0;
  for (let i = 0; i < sortedPages.length - 1; i++) {
    const older = sortedPages[i][1], newer = sortedPages[i + 1][1];
    logger.info(
      `[verify] page ${sortedPages[i][0]} (older): days ${older.min}–${older.max} (n=${older.n})  vs  ` +
      `page ${sortedPages[i+1][0]} (newer): days ${newer.min}–${newer.max} (n=${newer.n})`
    );
    if (older.max < newer.max) {
      crossViolations++;
      logger.warn(`[verify] CROSS-PAGE VIOLATION: older page max (${older.max}) < newer page max (${newer.max})`);
    }
  }
  logger.info(`[verify] Cross-page violations: ${crossViolations}${crossViolations === 0 ? " ✓ (older pages hold older listings)" : ""}`);

  // ── Dedup ────────────────────────────────────────────────────────────────
  const zpids = items.map((i) => i.zpid).filter(Boolean);
  const dupes = zpids.length - new Set(zpids).size;
  logger.info(`[verify] Total items: ${items.length}, duplicate zpids: ${dupes}`);

  // ── Summary ──────────────────────────────────────────────────────────────
  const anomalies = withinViolations + crossViolations;
  logger.info("─".repeat(90));
  if (anomalies === 0) {
    logger.info(`[verify] PASS — Zillow results are ordered correctly (within-page newest-first, pages oldest-first).`);
  } else {
    logger.warn(`[verify] FAIL — ${anomalies} ordering anomaly(ies) found. Review the violations above.`);
  }
}

main().catch((err) => {
  logger.error(`[verify] failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
