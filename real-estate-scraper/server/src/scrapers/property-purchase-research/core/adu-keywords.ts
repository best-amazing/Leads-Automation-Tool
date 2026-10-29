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

  // ── Added 10/26/2026 (management list) ───────────────────────────────────
  "living quarters",
  "quarter", // matched as living space only — see KEYWORD_PATTERN_OVERRIDES
  "3 home",
  "3 structures",
  "3 house",
  "3 dwelling",
  "4 home",
  "4 structures",
  "4 house",
  "4 dwelling",
  "many home",
  "many structures",
  "many house",
  "many dwelling",
];

/**
 * Keywords matched by a custom pattern instead of the plain word. "quarter"
 * on its own would hit "quarter acre" / "quarter mile" / "Quarter Horse", so
 * it only counts as living space: "quarters" ("guest quarters", "separate
 * quarters") or "<guest|living|…> quarter" — never a fraction ("three-
 * quarters of an acre", "3 quarters mile").
 */
const KEYWORD_PATTERN_OVERRIDES: Record<string, RegExp> = {
  quarter:
    /(?<!\b(?:three|two|\d)[\s-]?)\bquarters\b(?!\s+(?:of\s+an?|acres?|miles?)\b)|\b(?:guest|living|separate|private|caretaker'?s?|servants?'?|staff|maid'?s?|nanny|in-?law|mother-in-law)\s+quarter\b/i,
};

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
  KY: ["402", "405", "421"], // Louisville (402) · Lexington (405) · Bowling Green (421)
  MI: ["482", "490"], // Detroit (482) · Kalamazoo (490)
  PA: ["15"], // Pittsburgh
  MO: ["63", "64"], // St. Louis (63) · Kansas City (64)
  NE: ["68"], // Omaha
  KS: ["66"], // Kansas City, KS
  TN: ["372"], // Nashville
  GA: ["303"], // Atlanta
};

// Compiled once at load (in ADU_KEYWORDS priority order) instead of building
// a fresh RegExp per keyword per listing.
const ADU_KEYWORD_PATTERNS = ADU_KEYWORDS.map((kw) => ({
  kw,
  re:
    KEYWORD_PATTERN_OVERRIDES[kw] ??
    new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
}));

/** The pattern a keyword is matched with (for highlighting its evidence). */
export function aduKeywordPattern(kw: string): RegExp | undefined {
  return ADU_KEYWORD_PATTERNS.find((p) => p.kw === kw)?.re;
}

/**
 * Returns the highest-priority ADU keyword found in `text`, or undefined.
 * Priority follows ADU_KEYWORDS order, not position in the text.
 */
export function findAduKeyword(text: string): string | undefined {
  return ADU_KEYWORD_PATTERNS.find(({ re }) => re.test(text))?.kw;
}
