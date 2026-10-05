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

export const ADU_ZILLOW_MARKETS: Array<{
  name: string;
  baseUrl: string;
  listingType: "active" | "pre_foreclosure" | "foreclosure";
}> = [
  { name: "Columbus, OH - Active", baseUrl: "https://www.zillow.com/columbus-oh/", listingType: "active" },
  { name: "Cleveland, OH - Active", baseUrl: "https://www.zillow.com/cleveland-oh/", listingType: "active" },
  { name: "Toledo, OH - Active", baseUrl: "https://www.zillow.com/toledo-oh/", listingType: "active" },
  { name: "Milwaukee, WI - Active", baseUrl: "https://www.zillow.com/milwaukee-wi/", listingType: "active" },
  { name: "Louisville, KY - Active", baseUrl: "https://www.zillow.com/louisville-ky/", listingType: "active" },
  { name: "Indianapolis, IN - Active", baseUrl: "https://www.zillow.com/indianapolis-in/", listingType: "active" },
  { name: "Pittsburgh, PA - Active", baseUrl: "https://www.zillow.com/pittsburgh-pa/", listingType: "active" },
  { name: "Detroit, MI - Active", baseUrl: "https://www.zillow.com/detroit-mi/", listingType: "active" },
  { name: "Kalamazoo, MI - Active", baseUrl: "https://www.zillow.com/kalamazoo-mi/", listingType: "active" },
  { name: "Waterloo, IA - Active", baseUrl: "https://www.zillow.com/waterloo-ia/", listingType: "active" },
];

// Region IDs come from Redfin city URLs: redfin.com/city/<id>/<state>/<city>
// (verified October 2026).
export const ADU_REDFIN_MARKETS: Array<{
  name: string;
  regionId: number;
  regionType: number;
}> = [
  { name: "Columbus, OH", regionId: 4664, regionType: 6 },
  { name: "Cleveland, OH", regionId: 4145, regionType: 6 },
  { name: "Toledo, OH", regionId: 19458, regionType: 6 },
  { name: "Milwaukee, WI", regionId: 35759, regionType: 6 },
  { name: "Louisville, KY", regionId: 12262, regionType: 6 },
  { name: "Indianapolis, IN", regionId: 9170, regionType: 6 },
  { name: "Pittsburgh, PA", regionId: 15702, regionType: 6 },
  { name: "Detroit, MI", regionId: 5665, regionType: 6 },
  { name: "Kalamazoo, MI", regionId: 10728, regionType: 6 },
  { name: "Waterloo, IA", regionId: 20487, regionType: 6 },
];

export const ADU_CRAIGSLIST_MARKETS: Array<{
  city: string;
  state: string;
  url: string;
}> = [
  { city: "columbus", state: "OH", url: "https://columbus.craigslist.org/search/rea" },
  { city: "cleveland", state: "OH", url: "https://cleveland.craigslist.org/search/rea" },
  { city: "toledo", state: "OH", url: "https://toledo.craigslist.org/search/rea" },
  { city: "milwaukee", state: "WI", url: "https://milwaukee.craigslist.org/search/rea" },
  { city: "louisville", state: "KY", url: "https://louisville.craigslist.org/search/rea" },
  { city: "indianapolis", state: "IN", url: "https://indianapolis.craigslist.org/search/rea" },
  { city: "pittsburgh", state: "PA", url: "https://pittsburgh.craigslist.org/search/rea" },
  { city: "detroit", state: "MI", url: "https://detroit.craigslist.org/search/rea" },
  { city: "kalamazoo", state: "MI", url: "https://kalamazoo.craigslist.org/search/rea" },
  { city: "waterloo", state: "IA", url: "https://waterloo.craigslist.org/search/rea" },
];

const STATE_NAMES: Record<string, string> = {
  OH: "Ohio",
  WI: "Wisconsin",
  KY: "Kentucky",
  IN: "Indiana",
  PA: "Pennsylvania",
  MI: "Michigan",
  IA: "Iowa",
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
