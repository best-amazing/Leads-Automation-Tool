// src/scrapers/zillow/zillow.parser.ts

import { RawListing } from "../../types/listing";
import { logger }     from "../../utils/logger";

export const MAX_DAYS_OLD = 90;

// ── Price parsing ─────────────────────────────────────────────────────────────
//
// Zillow's __NEXT_DATA__ sometimes gives price as a number (195000) and
// sometimes as a formatted string ("$195,000" or "$195K"). We normalise all
// forms to a plain integer so the DB and scorer always receive a number.

function parsePrice(raw: any): number | undefined {
  if (typeof raw === "number" && raw > 0) return raw;
  if (typeof raw === "string") {
    // Handle shorthand: "$195K" → 195000, "$1.2M" → 1200000
    const s = raw.replace(/[$,\s]/g, "").toUpperCase();
    if (s.endsWith("K")) return Math.round(parseFloat(s) * 1_000);
    if (s.endsWith("M")) return Math.round(parseFloat(s) * 1_000_000);
    const n = parseInt(s, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return undefined;
}

// ── Zestimate extraction ──────────────────────────────────────────────────────
//
// We probe every known JSON path where Zillow embeds the Zestimate inside
// __NEXT_DATA__, and log exactly what we find so you can confirm which path
// is populated in your scraped pages.
//
// Known paths (confirmed from Zillow's JSON shape as of 2025):
//
//   item.zestimate                          — top-level on listResults items
//   item.hdpData.homeInfo.zestimate         — nested homeInfo block
//   item.hdpData.homeInfo.zestimateLow      — lower bound of Zestimate range
//   item.hdpData.homeInfo.rentZestimate     — rental estimate (different field)
//
// If NONE of these are present it means Zillow did not include the Zestimate
// for that listing in the search-results payload. In that case the detail page
// (<p data-testid="primary-zestimate">) is the only source — which requires a
// second fetch per listing.

function extractZestimate(item: any, address: string): number | undefined {
  const candidates: Array<{ path: string; value: unknown }> = [
    { path: "item.zestimate",                       value: item?.zestimate },
    { path: "item.hdpData.homeInfo.zestimate",      value: item?.hdpData?.homeInfo?.zestimate },
    { path: "item.hdpData.homeInfo.zestimateLow",   value: item?.hdpData?.homeInfo?.zestimateLow },
    { path: "item.hdpData.homeInfo.rentZestimate",  value: item?.hdpData?.homeInfo?.rentZestimate },
  ];

  // Log every candidate so you can see what Zillow is actually returning
  logger.debug(
    `[zillow-parser] Zestimate candidates for "${address}":\n` +
    candidates.map(c => `  ${c.path} = ${JSON.stringify(c.value)}`).join("\n")
  );

  for (const { value } of candidates) {
    const parsed = parsePrice(value);
    if (parsed) return parsed;
  }

  logger.debug(`[zillow-parser] No Zestimate found in __NEXT_DATA__ for "${address}" — needs detail-page fetch`);
  return undefined;
}

// ── Main parser ───────────────────────────────────────────────────────────────

export function parseZillowResults(
  json: any,
  applyDateFilter = true
): {
  listings: RawListing[];
  allStale:  boolean;
} {
  // Log the top-level keys so you can see the full shape of what Zillow returns
  logger.debug(
    `[zillow-parser] searchPageState top-level keys: ${Object.keys(json ?? {}).join(", ")}`
  );

  const raw = [
    ...(json?.cat1?.searchResults?.listResults ?? []),
    ...(json?.cat1?.searchResults?.mapResults  ?? []),
  ];

  if (raw.length === 0) {
    logger.debug("[zillow-parser] No raw results found — check JSON path cat1.searchResults");
    return { listings: [], allStale: true };
  }

  // Log the keys of the first item so you can see every field Zillow provides
  if (raw[0]) {
    logger.debug(
      `[zillow-parser] First result item keys: ${Object.keys(raw[0]).join(", ")}`
    );
    if (raw[0].hdpData?.homeInfo) {
      logger.debug(
        `[zillow-parser] First result hdpData.homeInfo keys: ${Object.keys(raw[0].hdpData.homeInfo).join(", ")}`
      );
    }
  }

  const results: RawListing[] = [];
  let staleCount = 0;

  for (const item of raw) {
    if (!item?.zpid) continue;

    // ── Days on market ────────────────────────────────────────────────────
    const daysOnZillow: number | undefined =
      item.daysOnZillow                    ??
      item.hdpData?.homeInfo?.daysOnZillow ??
      undefined;

    // ── Listed date ───────────────────────────────────────────────────────
    let listedAt: Date | undefined;
    if (item.listingDateTime) {
      listedAt = new Date(Number(item.listingDateTime));
    } else if (typeof daysOnZillow === "number") {
      const d = new Date();
      d.setDate(d.getDate() - daysOnZillow);
      listedAt = d;
    }

    // ── Staleness filter ──────────────────────────────────────────────────
    if (applyDateFilter && typeof daysOnZillow === "number" && daysOnZillow > MAX_DAYS_OLD) {
      staleCount++;
      continue;
    }

    // ── Address ───────────────────────────────────────────────────────────
    const address = [
      item.address,
      item.hdpData?.homeInfo?.city,
      item.hdpData?.homeInfo?.state,
      item.hdpData?.homeInfo?.zipcode,
    ].filter(Boolean).join(", ");

    // ── Price (normalised to number) ──────────────────────────────────────
    const price = parsePrice(item.price ?? item.hdpData?.homeInfo?.price);

    // ── Zestimate ─────────────────────────────────────────────────────────
    const zestimate = extractZestimate(item, address);

    results.push({
      url:          `https://www.zillow.com/homedetails/${item.zpid}_zpid/`,
      source:       "zillow",
      title:        item.address || "Zillow Listing",
      address,
      price,
      zestimate,
      bedrooms:     item.beds,
      bathrooms:    item.baths,
      squareFeet:   item.area,
      propertyType: item.homeType || "unknown",
      description:  "",
      listedAt,
      daysOnZillow,
    });
  }

  const itemsWithAge = raw.filter(
    (i: any) => i?.daysOnZillow != null || i?.hdpData?.homeInfo?.daysOnZillow != null
  ).length;

  const allStale = itemsWithAge > 0 && staleCount >= itemsWithAge;
  return { listings: results, allStale };
}