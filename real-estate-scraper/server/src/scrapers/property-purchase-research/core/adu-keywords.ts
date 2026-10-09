// src/scrapers/property-purchase-research/adu-keywords.ts
// ─────────────────────────────────────────────────────────────────────────────
// Shared ADU (Accessory Dwelling Unit) keyword list and target states
// for the property purchase research scraper.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Keywords that indicate a listing may have an ADU, guest house,
 * multi-generational layout, or multiple structures on one lot.
 *
 * ORDER MATTERS: matching uses Array.find() (first hit wins), so the
 * strongest signals come first and get attributed in the sheet's
 * "Matched Keyword" column. Generic fallbacks ("unit", "package") sit last.
 *
 * Matched case-insensitively against title + description + address.
 */

export const ADU_KEYWORDS = [
  // ── Priority tier 1–20 (strongest ADU signals) ────────────────────────────
  "ADU",
  "add-on unit",
  "add on unit",
  "add on units",
  "in-law",
  "in-laws",
  "in law",
  "in laws",
  "guest house",
  "guest home",
  "guest residence",
  "multi-generational living",
  "multi generational living",
  "multi-generation",
  "multi generation",
  "two homes",
  "two houses",
  "both homes",
  "both house",
  "multiple structures",

  // ── Secondary signals ─────────────────────────────────────────────────────
  "main residence",
  "main house",
  "main home",
  "second home",
  "second house",
  "both residence",
  "multiple house",
  "multiple home",

  // ── Weak / generic fallbacks ──────────────────────────────────────────────
  "private entrance",
  "private studio",
  "private apartment",
  "same lot",
  "in one lot",
  "in one parcel",
  "carriage house",
  "carriage home",
];

/**
 * US state abbreviations to filter listings by geography, IN PRIORITY ORDER.
 * This is the single source of truth for scrape order: every source (Zillow,
 * Redfin, Craigslist, Creative Listing, Coldwell Banker) walks its markets
 * sorted by this list, so an earlier state is worked first and later ones
 * are reached once its unseen inventory is exhausted. To change priority,
 * reorder this array; to add/drop a state, also add/remove its markets in
 * adu-markets.ts and its ZIP rule below.
 *
 * Temporary focus: set ADU_TARGET_STATES (e.g. "OH" or "OH,IN") to scrape
 * only those states, in that order — no code change needed; unset it to
 * return to the full list.
 */
const DEFAULT_TARGET_STATES = [
  "OH",
  "IN",
  "WI",
  "IA",
  "IL",
  "KY",
  "MI",
  "PA",
  "MO",
  "NE",
  "KS",
  "TN",
  "GA",
];

export const TARGET_STATES: string[] = (() => {
  const override = (process.env.ADU_TARGET_STATES ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return override.length > 0 ? override : DEFAULT_TARGET_STATES;
})();

/**
 * Allowed ZIP prefixes per state. Leads in a listed state are only written
 * when their ZIP starts with one of these prefixes (a missing ZIP is
 * rejected). States not listed here accept any ZIP — Ohio: all ZIPs.
 */
export const STATE_ZIP_PREFIXES: Record<string, string[]> = {
  IN: ["46"], // Indianapolis
  WI: ["53"], // Milwaukee
  IA: ["50", "52"], // Waterloo, Des Moines (50) · Cedar Rapids (52)
  IL: ["60"], // Chicago area
  KY: ["40"], // Louisville / Lexington (north-central)
  MI: ["48", "49"], // Detroit (48) · Kalamazoo (49)
  PA: ["15"], // Pittsburgh
  MO: ["63", "64"], // St. Louis (63) · Kansas City (64)
  NE: ["68"], // Omaha
  KS: ["66"], // Kansas City, KS
  TN: ["37"], // Nashville
  GA: ["30"], // Atlanta
};

// Compiled once at load (in ADU_KEYWORDS priority order) instead of building
// a fresh RegExp per keyword per listing.
const ADU_KEYWORD_PATTERNS = ADU_KEYWORDS.map((kw) => ({
  kw,
  re: new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
}));

/**
 * Returns the highest-priority ADU keyword found in `text`, or undefined.
 * Priority follows ADU_KEYWORDS order, not position in the text.
 */
export function findAduKeyword(text: string): string | undefined {
  return ADU_KEYWORD_PATTERNS.find(({ re }) => re.test(text))?.kw;
}
