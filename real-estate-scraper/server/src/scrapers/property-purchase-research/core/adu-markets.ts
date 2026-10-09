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

// ── Zillow ──────────────────────────────────────────────────────────────────
// Zillow serves at most 20 pages (~820 listings) per search, so one
// unfiltered search per city only ever reaches its ~820 newest listings
// (Columbus alone has 2,000+). Each city is therefore searched once per price
// band, with the ADU criteria (≤ $600k, 3+ beds, 2+ baths — see
// passesPropertyCriteria) applied server-side, so every band fits inside
// Zillow's window and every result is a candidate.
// Bands: ZILLOW_ADU_PRICE_BANDS="min-max,min-max,…" (default 3 bands to $600k).
const ZILLOW_PRICE_BANDS: Array<[number, number]> = (
  process.env.ZILLOW_ADU_PRICE_BANDS ?? "0-250000,250000-400000,400000-600000"
)
  .split(",")
  .map((band) => band.split("-").map(Number) as [number, number])
  .filter(([min, max]) => Number.isFinite(min) && Number.isFinite(max) && max > min);

const ZILLOW_CITIES: Array<{ name: string; slug: string }> = [
  { name: "Columbus, OH", slug: "columbus-oh" },
  { name: "Cleveland, OH", slug: "cleveland-oh" },
  { name: "Toledo, OH", slug: "toledo-oh" },
  { name: "Cincinnati, OH", slug: "cincinnati-oh" },
  { name: "Dayton, OH", slug: "dayton-oh" },
  { name: "Akron, OH", slug: "akron-oh" },
  { name: "Youngstown, OH", slug: "youngstown-oh" },
  { name: "Canton, OH", slug: "canton-oh" },
  { name: "Indianapolis, IN", slug: "indianapolis-in" },
  { name: "Milwaukee, WI", slug: "milwaukee-wi" },
  { name: "Waterloo, IA", slug: "waterloo-ia" },
  { name: "Des Moines, IA", slug: "des-moines-ia" },
  { name: "Cedar Rapids, IA", slug: "cedar-rapids-ia" },
  { name: "Chicago, IL", slug: "chicago-il" },
  { name: "Louisville, KY", slug: "louisville-ky" },
  { name: "Detroit, MI", slug: "detroit-mi" },
  { name: "Kalamazoo, MI", slug: "kalamazoo-mi" },
  { name: "Pittsburgh, PA", slug: "pittsburgh-pa" },
  { name: "St. Louis, MO", slug: "st-louis-mo" },
  { name: "Kansas City, MO", slug: "kansas-city-mo" },
  { name: "Omaha, NE", slug: "omaha-ne" },
  { name: "Kansas City, KS", slug: "kansas-city-ks" },
  { name: "Nashville, TN", slug: "nashville-tn" },
  { name: "Atlanta, GA", slug: "atlanta-ga" },
];

const formatK = (n: number) => `$${Math.round(n / 1000)}k`;

export const ADU_ZILLOW_MARKETS: Array<{
  name: string;
  baseUrl: string;
  listingType: "active" | "pre_foreclosure" | "foreclosure";
  searchFilters: {
    priceMin: number;
    priceMax: number;
    bedsMin: number;
    bathsMin: number;
  };
}> = byStatePriority(
  ZILLOW_CITIES.flatMap((city) =>
    ZILLOW_PRICE_BANDS.map(([priceMin, priceMax]) => ({
      name: `${city.name} - Active ${formatK(priceMin)}–${formatK(priceMax)}`,
      baseUrl: `https://www.zillow.com/${city.slug}/`,
      listingType: "active" as const,
      searchFilters: { priceMin, priceMax, bedsMin: 3, bathsMin: 2 },
    })),
  ),
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
    { name: "Cincinnati, OH", regionId: 3879, regionType: 6 },
    { name: "Dayton, OH", regionId: 5413, regionType: 6 },
    { name: "Akron, OH", regionId: 244, regionType: 6 },
    { name: "Youngstown, OH", regionId: 21075, regionType: 6 },
    { name: "Canton, OH", regionId: 3101, regionType: 6 },
    { name: "Indianapolis, IN", regionId: 9170, regionType: 6 },
    { name: "Milwaukee, WI", regionId: 35759, regionType: 6 },
    { name: "Waterloo, IA", regionId: 20487, regionType: 6 },
    { name: "Des Moines, IA", regionId: 5415, regionType: 6 },
    { name: "Cedar Rapids, IA", regionId: 3103, regionType: 6 },
    { name: "Chicago, IL", regionId: 29470, regionType: 6 },
    { name: "Louisville, KY", regionId: 12262, regionType: 6 },
    { name: "Detroit, MI", regionId: 5665, regionType: 6 },
    { name: "Kalamazoo, MI", regionId: 10728, regionType: 6 },
    { name: "Pittsburgh, PA", regionId: 15702, regionType: 6 },
    { name: "St. Louis, MO", regionId: 16661, regionType: 6 },
    { name: "Kansas City, MO", regionId: 35751, regionType: 6 },
    { name: "Omaha, NE", regionId: 9417, regionType: 6 },
    { name: "Kansas City, KS", regionId: 35754, regionType: 6 },
    { name: "Nashville, TN", regionId: 13415, regionType: 6 },
    { name: "Atlanta, GA", regionId: 30756, regionType: 6 },
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
    { city: "cincinnati", state: "OH", url: "https://cincinnati.craigslist.org/search/rea" },
    { city: "dayton", state: "OH", url: "https://dayton.craigslist.org/search/rea" },
    // Akron and Canton share one Craigslist site
    { city: "akroncanton", state: "OH", url: "https://akroncanton.craigslist.org/search/rea" },
    { city: "youngstown", state: "OH", url: "https://youngstown.craigslist.org/search/rea" },
    { city: "indianapolis", state: "IN", url: "https://indianapolis.craigslist.org/search/rea" },
    { city: "milwaukee", state: "WI", url: "https://milwaukee.craigslist.org/search/rea" },
    { city: "waterloo", state: "IA", url: "https://waterloo.craigslist.org/search/rea" },
    { city: "desmoines", state: "IA", url: "https://desmoines.craigslist.org/search/rea" },
    { city: "cedarrapids", state: "IA", url: "https://cedarrapids.craigslist.org/search/rea" },
    { city: "chicago", state: "IL", url: "https://chicago.craigslist.org/search/rea" },
    { city: "louisville", state: "KY", url: "https://louisville.craigslist.org/search/rea" },
    { city: "detroit", state: "MI", url: "https://detroit.craigslist.org/search/rea" },
    { city: "kalamazoo", state: "MI", url: "https://kalamazoo.craigslist.org/search/rea" },
    { city: "pittsburgh", state: "PA", url: "https://pittsburgh.craigslist.org/search/rea" },
    { city: "stlouis", state: "MO", url: "https://stlouis.craigslist.org/search/rea" },
    // One site for both sides of Kansas City; Craigslist search results carry
    // no state, so its leads are tagged MO (Kansas-side 66xxx ZIPs then fail
    // the MO ZIP rule). Kansas, KS leads still come via Zillow/Redfin/CB.
    { city: "kansascity", state: "MO", url: "https://kansascity.craigslist.org/search/rea" },
    { city: "omaha", state: "NE", url: "https://omaha.craigslist.org/search/rea" },
    { city: "nashville", state: "TN", url: "https://nashville.craigslist.org/search/rea" },
    { city: "atlanta", state: "GA", url: "https://atlanta.craigslist.org/search/rea" },
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
  MI: "Michigan",
  PA: "Pennsylvania",
  MO: "Missouri",
  NE: "Nebraska",
  KS: "Kansas",
  TN: "Tennessee",
  GA: "Georgia",
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
