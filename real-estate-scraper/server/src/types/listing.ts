// src/types/listing.ts
// ─────────────────────────────────────────────────────────────────────────────
// Canonical shape every scraper must return.
// Updated to match the new Prisma schema (Listing + Estimate separation)
// ─────────────────────────────────────────────────────────────────────────────

export type PropertyType =
  | "single_family"
  | "multi_family"
  | "duplex"
  | "condo"
  | "townhouse"
  | "unknown";

export type DealScore = "good_deal" | "average_deal" | "low_potential" | "unknown";

/** 
 * Raw output from any scraper.
 * This is the main interface scrapers (LoopNet, Realtor, Zillow, etc.) should return.
 */
export interface RawListing {
  url: string;
  source: string;                    // e.g. "loopnet", "realtor", "craigslist_milwaukee"

  title?: string;
  price?: number;
  address?: string;                  // Will be mapped to rawAddress in DB
  location?: string;                 // e.g. "Columbus, OH"
  city?: string;
  state?: string;

  propertyType?: PropertyType;

  // Basic property details
  bedrooms?: number;                 // also accept "beds" from some parsers
  bathrooms?: number;                // also accept "baths"
  squareFeet?: number;
  lotSqft?: number;
  yearBuilt?: number;

  description?: string;

  // Owner / Broker contact
  ownerName?: string;
  ownerPhone?: string;

  // Dates
  postedDate?: Date;
  listedAt?: Date;
  daysOnMarket?: number;

  // Legacy / scraper-specific fields (kept for compatibility)
  daysOnZillow?: number;
  listedDate?: number;               // timestamp

  // Estimates — these will be moved to the Estimate model in repository
  // We still accept them here for backward compatibility with runner/scorers
  zpid?: string;                     // Zillow property ID from enrichment
  zestimate?: number;                // Zillow estimate from enrichment
  zestimateLow?: number;             // Zillow estimate range (low)
  zestimateHigh?: number;            // Zillow estimate range (high)
  realtorEstimate?: number;
  realtorEstimateLow?: number;
  realtorEstimateHigh?: number;
  redfinEstimate?: number;
  propwireEstimate?: number;

  // Optional metadata
  imgSrc?: string;
  status?: string;                   // "for_sale", "pending", etc.
  priceReduced?: boolean;
}

/** 
 * Result from the underwriting / scoring engine 
 */
export interface UnderwritingResult {
  dealScore: DealScore;
  equityEstimate?: number;           // ARV - price
  arvEstimate?: number;              // After Repair Value (if calculated)
}

/**
 * What the DB repository accepts.
 * Combines raw scraper data + underwriting results.
 */
export type ListingUpsertPayload = RawListing & Partial<UnderwritingResult>;

/**
 * Shape returned from database queries when including relations
 */
export interface ListingWithRelations extends ListingUpsertPayload {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  lastSeenAt: Date;
  property?: {
    id: string;
    normalizedAddress: string;
    address?: string;
    city?: string;
    state?: string;
  };
  estimates?: Array<{
    id: string;
    source: string;
    value: number;
    fetchedAt: Date;
  }>;
}