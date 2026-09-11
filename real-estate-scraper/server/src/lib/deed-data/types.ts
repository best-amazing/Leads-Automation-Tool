// src/lib/deed-data/types.ts
// ─────────────────────────────────────────────────────────────────────────────
// Shared shapes used across normalizeAddress, the geocoder, the ATTOM and
// OGRIP backends, and the output pipelines.
// ─────────────────────────────────────────────────────────────────────────────

export type LeadSource =
  | "zillow"
  | "investorlift-on-market"
  | "investorlift-off-market"
  | "dfd-ocr";

export interface RawListing {
  address: string;
  city?: string;
  state?: string;
  zip?: string;
  county?: string | null;
  source?: LeadSource | string;
  price?: number;
  [key: string]: unknown;
}

export interface NormalizedListing extends RawListing {
  normalizedAddress: string;
  hasStreetAddress: boolean;
  enrichmentNote?: string;
  lat?: number;
  lon?: number;
}

/** Common shape the ATTOM / OGRIP backends map their response into. */
export interface ParcelResult {
  latestDeedTransferDate: string | null; // ISO date, e.g. "2023-06-14"
  lastSalePrice: number | null;
  parcelId: string | null;
  ownerName: string | null;
  county: string | null;
  deedDataSource: "attom" | "ogrip" | null;
}

export interface EnrichedListing extends NormalizedListing, Partial<ParcelResult> {}

export const EMPTY_PARCEL_RESULT: ParcelResult = {
  latestDeedTransferDate: null,
  lastSalePrice: null,
  parcelId: null,
  ownerName: null,
  county: null,
  deedDataSource: null,
};
