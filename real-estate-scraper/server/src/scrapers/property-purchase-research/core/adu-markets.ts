// src/scrapers/property-purchase-research/core/adu-markets.ts
// ─────────────────────────────────────────────────────────────────────────────
// City markets for the ADU research scrapers only — the main lead pipeline
// keeps using config.sources.* unchanged.
//
// ORDER MATTERS: markets are walked in this order (no shuffling), so Ohio is
// worked first and the expansion markets are reached once the Ohio inventory
// is exhausted (already-seen listings are skipped via the backfill store).
// ZIP restrictions per state live in STATE_ZIP_PREFIXES (adu-keywords.ts).
// ─────────────────────────────────────────────────────────────────────────────

import { TARGET_STATES } from "./adu-keywords";

// Markets are listed by state here, but always exported sorted by
// TARGET_STATES priority — reorder TARGET_STATES to change the scrape order.
const byStatePriority = <T>(items: T[], stateOf: (m: T) => string): T[] =>
  items
    .filter((m) => TARGET_STATES.includes(stateOf(m)))
    .sort((a, b) => statePriority(stateOf(a)) - statePriority(stateOf(b)));

const stateFromName = (name: string) => name.match(/,\s*([A-Z]{2})\b/)?.[1] ?? "";

export const ADU_ZILLOW_MARKETS: Array<{
  name: string;
  baseUrl: string;
  listingType: "active" | "pre_foreclosure" | "foreclosure";
}> = byStatePriority(
  [
    { name: "Columbus, OH - Active", baseUrl: "https://www.zillow.com/columbus-oh/", listingType: "active" as const },
    { name: "Cleveland, OH - Active", baseUrl: "https://www.zillow.com/cleveland-oh/", listingType: "active" as const },
    { name: "Toledo, OH - Active", baseUrl: "https://www.zillow.com/toledo-oh/", listingType: "active" as const },
    { name: "Indianapolis, IN - Active", baseUrl: "https://www.zillow.com/indianapolis-in/", listingType: "active" as const },
    { name: "Milwaukee, WI - Active", baseUrl: "https://www.zillow.com/milwaukee-wi/", listingType: "active" as const },
    { name: "Waterloo, IA - Active", baseUrl: "https://www.zillow.com/waterloo-ia/", listingType: "active" as const },
    { name: "Chicago, IL - Active", baseUrl: "https://www.zillow.com/chicago-il/", listingType: "active" as const },
    { name: "Louisville, KY - Active", baseUrl: "https://www.zillow.com/louisville-ky/", listingType: "active" as const },
  ],
  (m) => stateFromName(m.name),
);

// Region IDs come from Redfin city URLs: redfin.com/city/<id>/<state>/<city>
// (verified October 2026).
export const ADU_REDFIN_MARKETS: Array<{
  name: string;
  regionId: number;
  regionType: number;
}> = byStatePriority(
  [
    { name: "Columbus, OH", regionId: 4664, regionType: 6 },
    { name: "Cleveland, OH", regionId: 4145, regionType: 6 },
    { name: "Toledo, OH", regionId: 19458, regionType: 6 },
    { name: "Indianapolis, IN", regionId: 9170, regionType: 6 },
    { name: "Milwaukee, WI", regionId: 35759, regionType: 6 },
    { name: "Waterloo, IA", regionId: 20487, regionType: 6 },
    { name: "Chicago, IL", regionId: 29470, regionType: 6 },
    { name: "Louisville, KY", regionId: 12262, regionType: 6 },
  ],
  (m) => stateFromName(m.name),
);

export const ADU_CRAIGSLIST_MARKETS: Array<{
  city: string;
  state: string;
  url: string;
}> = byStatePriority(
  [
    { city: "columbus", state: "OH", url: "https://columbus.craigslist.org/search/rea" },
    { city: "cleveland", state: "OH", url: "https://cleveland.craigslist.org/search/rea" },
    { city: "toledo", state: "OH", url: "https://toledo.craigslist.org/search/rea" },
    { city: "indianapolis", state: "IN", url: "https://indianapolis.craigslist.org/search/rea" },
    { city: "milwaukee", state: "WI", url: "https://milwaukee.craigslist.org/search/rea" },
    { city: "waterloo", state: "IA", url: "https://waterloo.craigslist.org/search/rea" },
    { city: "chicago", state: "IL", url: "https://chicago.craigslist.org/search/rea" },
    { city: "louisville", state: "KY", url: "https://louisville.craigslist.org/search/rea" },
  ],
  (m) => m.state,
);

const STATE_NAMES: Record<string, string> = {
  OH: "Ohio",
  IN: "Indiana",
  WI: "Wisconsin",
  IA: "Iowa",
  IL: "Illinois",
  KY: "Kentucky",
};

/** Statewide markets (Creative Listing) in TARGET_STATES priority order. */
export const ADU_STATE_MARKETS = TARGET_STATES.map((stateAbbr) => ({
  name: STATE_NAMES[stateAbbr] ?? stateAbbr,
  stateAbbr,
}));

/** Sort key: position of `state` in TARGET_STATES (unknown states last). */
export function statePriority(state: string | undefined): number {
  const i = TARGET_STATES.indexOf((state ?? "").toUpperCase());
  return i === -1 ? TARGET_STATES.length : i;
}
