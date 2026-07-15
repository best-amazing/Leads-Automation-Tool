// src/scrapers/property-purchase-research/adu-research.parser.ts
// ─────────────────────────────────────────────────────────────────────────────
// Extended InvestorLift parser that captures additional fields needed
// for the ADU property purchase research:
//   • description / remarks  — for keyword matching
//   • year_built             — spreadsheet column
//   • units                  — spreadsheet column
//   • school_rating          — spreadsheet column
//   • matchedKeyword         — QA traceability
//
// Also logs all available API keys on the first item for diagnostics.
// ─────────────────────────────────────────────────────────────────────────────

import { RawListing } from "../../types/listing";
import { logger } from "../../utils/logger";
import { ADU_KEYWORDS } from "./adu-keywords";

// ── Extended listing type ──────────────────────────────────────────────────

export interface AduResearchListing extends RawListing {
  /** Number of units on the property */
  units?: number;
  /** Total bedrooms across all units (vs. RawListing.bedrooms = main unit) */
  totalBedrooms?: number;
  /** Year the property was built */
  yearBuilt?: number;
  /** High school rating (e.g. "7/10") */
  schoolRating?: string;
  /** Which ADU keyword triggered the match — for QA */
  matchedKeyword?: string;
  /** Zip code of the property */
  zip?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function normalizePrice(val: unknown): number | undefined {
  if (typeof val === "number") return Math.round(val);
  if (typeof val === "string") {
    const m = val.replace(/[$,\s]/g, "").match(/\d+/);
    return m ? parseInt(m[0], 10) : undefined;
  }
  return undefined;
}

let hasLoggedKeys = false;

// How many items to log full diagnostics for
const PARSER_DIAG_LIMIT = 3;

// ── Object-per-row mapper (extended) ──────────────────────────────────────

/**
 * Map raw API items to AduResearchListing[], capturing all fields
 * needed for the ADU research spreadsheet.
*/

export function mapAduItems(
  items: any[],
  source: string,
): AduResearchListing[] {
  if (items.length === 0) {
    logger.warn("[adu-parser] No items in API response (empty array)");
    return [];
  }

  // ── Diagnostic: log all keys from the first item ──────────────────────
  if (!hasLoggedKeys) {
    hasLoggedKeys = true;
    const keys = Object.keys(items[0]);
    logger.info(
      `[adu-parser] API response keys (first item): ${keys.join(", ")}`,
    );
    // Also log a sample of field values to understand data shape
    const sample: Record<string, unknown> = {};
    for (const k of keys) {
      const v = items[0][k];
      sample[k] =
        typeof v === "string" && v.length > 120 ? v.slice(0, 120) + "…" : v;
    }
    logger.info(`[adu-parser] First item sample: ${JSON.stringify(sample)}`);
  }

  // ── Diagnostic: log description-candidate fields for first N items ────
  // This helps identify which fields actually contain description text
  const descCandidateKeys = [
    "description", "remarks", "notes", "comment", "comments",
    "overview", "body", "details", "summary", "narrative",
    "public_remarks", "agent_remarks", "listing_remarks",
    "property_description", "marketing_remarks",
  ];

  for (let diagIdx = 0; diagIdx < Math.min(items.length, PARSER_DIAG_LIMIT); diagIdx++) {
    const item = items[diagIdx];
    logger.info(`[adu-parser] ── ITEM [${diagIdx + 1}] DESCRIPTION FIELD DIAGNOSTICS ──`);
    logger.info(`[adu-parser]   id=${item.id} | title="${(item.title ?? "").slice(0, 80)}"`);

    for (const candKey of descCandidateKeys) {
      const val = item[candKey];
      if (val !== undefined && val !== null && val !== "") {
        const preview = typeof val === "string" ? val.slice(0, 150) : JSON.stringify(val).slice(0, 150);
        logger.info(`[adu-parser]   ✓ FOUND "${candKey}" (${typeof val}, ${String(val).length} chars): "${preview}"`);
      } else {
        logger.debug(`[adu-parser]   ✗ "${candKey}" = ${JSON.stringify(val)}`);
      }
    }

    // Also check for any string field > 50 chars that might be a description
    for (const [k, v] of Object.entries(item)) {
      if (
        typeof v === "string" &&
        v.length > 50 &&
        !descCandidateKeys.includes(k) &&
        !["title", "url", "image", "photo", "img"].some(skip => k.toLowerCase().includes(skip))
      ) {
        logger.info(
          `[adu-parser]   ⚠ POSSIBLE DESC FIELD "${k}" (${v.length} chars): "${v.slice(0, 150)}"`,
        );
      }
    }
  }

  logger.debug(`[adu-parser] Mapping ${items.length} raw items`);

  return items
    .map((item): AduResearchListing | null => {
      try {
        const id = item.id;
        const price = item.price;
        if (!id) return null; // price can be 0 for some listings

        // Build address from available fields
        const address = [item.city, item.county, item.state_code, item.zip]
          .filter(Boolean)
          .join(", ");

        // Capture description from all possible field names
        const description =
          item.description ?? item.remarks ?? item.notes ?? item.comment ?? "";

        // Find which ADU keyword matched (if any) — for QA
        const haystack = [item.title, description, address]
          .join(" ")
          .toLowerCase();
        const matchedKeyword = ADU_KEYWORDS.find((kw) => {
          const regex = new RegExp(`\\b${kw}\\b`, 'i');
          return regex.test(haystack);
        });

        return {
          source,
          url: `https://investorlift.com/marketplace/deal/${id}`,
          title: item.title || address,
          address,
          price: normalizePrice(price),
          description,

          // Standard fields
          bedrooms:
            item.bedrooms != null ? Number(item.bedrooms) : undefined,
          bathrooms:
            item.bathrooms != null ? Number(item.bathrooms) : undefined,
          squareFeet:
            item.sq_footage != null ? Number(item.sq_footage) : undefined,

          // ADU-specific fields
          units: item.units != null ? Number(item.units) : undefined,
          totalBedrooms:
            item.total_bedrooms != null
              ? Number(item.total_bedrooms)
              : undefined,
          yearBuilt:
            item.year_built != null ? Number(item.year_built) : undefined,
          schoolRating: item.school_rating ?? undefined,
          matchedKeyword,

           // Location fields for filtering
          city: item.city ?? undefined,
          state: item.state_code ?? undefined,
          zip: item.zip ?? undefined,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean) as AduResearchListing[];
}

// ── API response parser (extended) ─────────────────────────────────────────

/**
 * Parse the full API JSON payload using the extended ADU field mapper.
 * Handles the same envelope shapes as the base investorlift parser
 * (columnar, object array, nested).
 */
export function parseAduApiResponse(
  json: unknown,
  source: string,
): AduResearchListing[] {
  if (!json) return [];

  if (typeof json === "object" && !Array.isArray(json)) {
    const raw = json as Record<string, unknown>;

    // Columnar format envelope shape (InvestorLift often returns this)
    if (Array.isArray(raw.columns) && Array.isArray(raw.data)) {
      const columns = raw.columns as string[];
      const rows = raw.data as any[][];
      const objects = rows.map(row => {
        const obj: any = {};
        columns.forEach((col, idx) => {
          obj[col] = row[idx];
        });
        return obj;
      });
      return mapAduItems(objects, source);
    }

    // Object array envelope shapes
    if (Array.isArray(raw.data)) {
      return mapAduItems(raw.data as any[], source);
    }
    if (Array.isArray(raw.results)) {
      return mapAduItems(raw.results as any[], source);
    }
    if (Array.isArray(raw.properties)) {
      return mapAduItems(raw.properties as any[], source);
    }
    if (Array.isArray(raw.items)) {
      return mapAduItems(raw.items as any[], source);
    }
    if (
      typeof raw.data === "object" &&
      !Array.isArray(raw.data) &&
      Array.isArray((raw.data as any).properties)
    ) {
      return mapAduItems((raw.data as any).properties as any[], source);
    }

    // Try any top-level array key as last resort
    for (const key of Object.keys(raw)) {
      if (Array.isArray(raw[key])) {
        return mapAduItems(raw[key] as any[], source);
      }
    }

    logger.warn(
      `[adu-parser] No array found — keys: ${Object.keys(raw).join(", ")}`,
    );
  } else if (Array.isArray(json)) {
    return mapAduItems(json as any[], source);
  }

  logger.warn("[adu-parser] No items found in API response");
  return [];
}
