// src/scrapers/property-purchase-research/adu-keywords.ts
// ─────────────────────────────────────────────────────────────────────────────
// Shared ADU (Accessory Dwelling Unit) keyword list and target states
// for the property purchase research scraper.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Keywords that indicate a listing may have an ADU, guest house,
 * multi-generational layout, or multiple structures on one lot.
 *
 * Matched case-insensitively against title + description + address.
 */
export const ADU_KEYWORDS = [
  "main residence",
  "main house",
  "main home",
  "two homes",
  "two houses",
  "second home",
  "second house",
  "package",
  "ADU",
  "add-on unit",
  "in-law",
  "both homes",
  "both house",
  "both residence",
  "multi-generational living",
  "multi generational living",
  "multi-generation",
  "multi generation",
  "multiple structures",
  "multiple house",
  "multiple home",
  "guest house",
  "guest home",
  "guest residence",
  "private entrance",
  "same lot",
  "in one lot",
  "in one parcel",
  "carriage",
];

/**
 * US state abbreviations to filter listings by geography.
 */
export const TARGET_STATES = ["OH", "IN", "WI", "IA", "IL"];
