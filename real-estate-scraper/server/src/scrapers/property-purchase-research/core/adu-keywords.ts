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
 * US state abbreviations to filter listings by geography.
 */
export const TARGET_STATES = ["OH", "IN", "WI", "IA", "IL"];

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
