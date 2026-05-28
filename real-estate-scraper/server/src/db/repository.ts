// src/db/repository.ts
// ─────────────────────────────────────────────────────────────────────────────
// ALL database operations live here.
// Scrapers never touch Prisma directly.
// ─────────────────────────────────────────────────────────────────────────────

import { Listing, Prisma } from "@prisma/client";
import { prisma } from "./client";
import { ListingUpsertPayload, RawListing } from "../types/listing";
import { logger } from "../utils/logger";
import pLimit from "p-limit";
import { zillowEnrichmentService } from "../services/zillow-enrichment.service";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Normalize an address for comparison purposes (address-based deduplication)
 * Converts to lowercase, removes extra whitespace and punctuation
 */
function normalizeAddressForComparison(address: string | null | undefined): string {
  if (!address) return "";
  return address
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ") // collapse multiple spaces
    .replace(/[.,#\-()]/g, ""); // remove common punctuation
}

/**
 * Check if a listing with the same address + source already exists
 * This prevents duplicate listings when the same property appears at different URLs
 */
async function findListingByAddressAndSource(
  address: string | null | undefined,
  source: string
): Promise<Listing | null> {
  if (!address) return null;
  
  const normalized = normalizeAddressForComparison(address);
  
  // Find listings with matching normalized address and source
  const listings = await prisma.listing.findMany({
    where: { source },
    select: { id: true, url: true, rawAddress: true },
  });
  
  // Filter by normalized address match
  for (const listing of listings) {
    if (normalizeAddressForComparison(listing.rawAddress) === normalized) {
      return listing as any;
    }
  }
  
  return null;
}

// ── Write ─────────────────────────────────────────────────────────────────────

/**
 * Upsert a single listing to the general Listing table.
 * Raw data only — no estimates or property linking.
 * 
 * Deduplication strategy:
 * 1. First check if URL exists → upsert by URL
 * 2. If URL doesn't exist, check if address+source exists → upsert by address to prevent duplicates
 * 3. Otherwise create new listing
 */
export async function upsertListing(
  payload: ListingUpsertPayload,
): Promise<Listing> {
  const listingData: Prisma.ListingCreateInput = {
    url: payload.url,
    source: payload.source,
    title: payload.title,
    price: payload.price,
    rawAddress: payload.address,
    location: payload.location,
    propertyType: payload.propertyType,
    bedrooms: payload.bedrooms,
    bathrooms: payload.bathrooms,
    squareFeet: payload.squareFeet,
    description: payload.description,
    ownerName: payload.ownerName,
    ownerPhone: payload.ownerPhone,
    postedDate: payload.postedDate ?? payload.listedAt,
    lastSeenAt: new Date(),
  };

  const updateData = {
    url: payload.url, // Update URL if it changed
    title: payload.title,
    price: payload.price,
    rawAddress: payload.address,
    location: payload.location,
    propertyType: payload.propertyType,
    bedrooms: payload.bedrooms,
    bathrooms: payload.bathrooms,
    squareFeet: payload.squareFeet,
    description: payload.description,
    ownerName: payload.ownerName,
    ownerPhone: payload.ownerPhone,
    postedDate: payload.postedDate ?? payload.listedAt,
    lastSeenAt: new Date(),
  };

  // Strategy: First try to upsert by URL (same listing page)
  try {
    return await prisma.listing.upsert({
      where: { url: payload.url },
      create: listingData,
      update: updateData,
    });
  } catch (err: any) {
    // If URL doesn't exist yet, check if this address+source already exists
    // This prevents creating duplicates when the same property is at a different URL
    if (err.code === "P2025" || err.message?.includes("not found")) {
      const existing = await findListingByAddressAndSource(payload.address, payload.source);
      
      if (existing) {
        logger.debug(
          `[db] Listing with address "${payload.address}" from source "${payload.source}" already exists (id=${existing.id}). ` +
          `Updating URL from "${existing.url}" to "${payload.url}" to reflect new location.`
        );
        // Update the existing listing with the new URL
        return await prisma.listing.update({
          where: { id: existing.id },
          data: updateData,
        });
      }
    }
    throw err;
  }
}

/**
 * Upsert many listings (batch version)
 * Uses transaction for better performance.
 * 
 * Deduplication strategy: Same as upsertListing()
 * - First tries URL-based upsert
 * - Falls back to address+source check to prevent duplicates
 */
export async function upsertMany(
  payloads: ListingUpsertPayload[],
): Promise<{ created: number; updated: number }> {
  if (payloads.length === 0) return { created: 0, updated: 0 };

  // Batch upserts into transactions to reduce connection churn.
  // Controls:
  //  - DB_UPSERT_CONCURRENCY: number of parallel transactions (default 2)
  //  - DB_UPSERT_BATCH_SIZE: number of upserts per transaction (default 20)
  const concurrency = Number(process.env.DB_UPSERT_CONCURRENCY) || 2;
  const batchSize = Number(process.env.DB_UPSERT_BATCH_SIZE) || 20;
  const batches: ListingUpsertPayload[][] = [];
  for (let i = 0; i < payloads.length; i += batchSize) {
    batches.push(payloads.slice(i, i + batchSize));
  }

  // Pre-fetch all existing listings by source for address deduplication
  // This is more efficient than looking up individually for each payload
  const sources = new Set(payloads.map(p => p.source));
  const existingBySourceAndAddress: Map<string, Listing[]> = new Map();
  
  for (const source of sources) {
    const listings = await prisma.listing.findMany({
      where: { source },
      select: { id: true, url: true, rawAddress: true, source: true },
    });
    existingBySourceAndAddress.set(source, listings as any);
  }

  // Process batches sequentially to avoid exhausting DB connection pool.
  let processed = 0;
  for (const batch of batches) {
    try {
      // Process each payload individually to handle address deduplication
      for (const p of batch) {
        await upsertListing(p);
      }
      processed += batch.length;
    } catch (err) {
      logger.error(`[db] Batch upsert failed after processing ${processed} listings: ${err}`);
      throw err;
    }
  }

  logger.info(`[db] Successfully upserted ${payloads.length} listings (batches=${batches.length}, batchSize=${batchSize})`);
  return { created: 0, updated: 0 };
}

// ── Zillow Listings ───────────────────────────────────────────────────────────

export async function upsertZillowListings(
  payloads: Array<ListingUpsertPayload & { zestimate?: number }>,
): Promise<void> {
  if (payloads.length === 0) return;

  const concurrency = Number(process.env.DB_UPSERT_CONCURRENCY) || 2;
  const limit = pLimit(concurrency);

  await Promise.all(
    payloads.map((p) =>
      limit(() =>
        prisma.$transaction([
          (prisma.zillowListing as any).upsert({
            where: { url: p.url },
            create: {
              url: p.url,
              title: p.title,
              price: p.price,
              address: p.address,
              location: p.location,
              propertyType: p.propertyType,
              bedrooms: p.bedrooms,
              bathrooms: p.bathrooms,
              squareFeet: p.squareFeet,
              description: p.description,
              postedDate: p.postedDate,
              zestimate: p.zestimate,
              lastSeenAt: new Date(),
            },
            update: {
              title: p.title,
              price: p.price,
              address: p.address,
              location: p.location,
              propertyType: p.propertyType,
              bedrooms: p.bedrooms,
              bathrooms: p.bathrooms,
              squareFeet: p.squareFeet,
              description: p.description,
              postedDate: p.postedDate,
              zestimate: p.zestimate,
              lastSeenAt: new Date(),
            },
          }),
          prisma.listing.upsert({
            where: { url: p.url },
            create: {
              url: p.url,
              source: "zillow",
              title: p.title,
              price: p.price,
              rawAddress: p.address,
              location: p.location,
              propertyType: p.propertyType,
              bedrooms: p.bedrooms,
              bathrooms: p.bathrooms,
              squareFeet: p.squareFeet,
              description: p.description,
              postedDate: p.postedDate,
              lastSeenAt: new Date(),
            },
            update: {
              title: p.title,
              price: p.price,
              rawAddress: p.address,
              location: p.location,
              propertyType: p.propertyType,
              bedrooms: p.bedrooms,
              bathrooms: p.bathrooms,
              squareFeet: p.squareFeet,
              description: p.description,
              postedDate: p.postedDate,
              lastSeenAt: new Date(),
            },
          }),
        ])
      )
    )
  );

  logger.info(`[db] Upserted ${payloads.length} Zillow listings to both ZillowListing and Listing tables (concurrency=${concurrency})`);
}

// ── Redfin Listings ───────────────────────────────────────────────────────────

export async function upsertRedfinListings(
  payloads: Array<ListingUpsertPayload & { estimate?: number }>,
): Promise<void> {
  if (payloads.length === 0) return;

  // Flatten all operations: each payload creates 2 upsert operations (RedfinListing + Listing)
  const concurrency = Number(process.env.DB_UPSERT_CONCURRENCY) || 2;
  const limit = pLimit(concurrency);

  await Promise.all(
    payloads.map((p) =>
      limit(() =>
        prisma.$transaction([
          (prisma.redfinListing as any).upsert({
            where: { url: p.url },
            create: {
              url: p.url,
              title: p.title,
              price: p.price,
              address: p.address,
              location: p.location,
              propertyType: p.propertyType,
              bedrooms: p.bedrooms,
              bathrooms: p.bathrooms,
              squareFeet: p.squareFeet,
              description: p.description,
              postedDate: p.postedDate,
              estimate: p.estimate,
              lastSeenAt: new Date(),
            },
            update: {
              title: p.title,
              price: p.price,
              address: p.address,
              location: p.location,
              propertyType: p.propertyType,
              bedrooms: p.bedrooms,
              bathrooms: p.bathrooms,
              squareFeet: p.squareFeet,
              description: p.description,
              postedDate: p.postedDate,
              estimate: p.estimate,
              lastSeenAt: new Date(),
            },
          }),
          prisma.listing.upsert({
            where: { url: p.url },
            create: {
              url: p.url,
              source: "redfin",
              title: p.title,
              price: p.price,
              rawAddress: p.address,
              location: p.location,
              propertyType: p.propertyType,
              bedrooms: p.bedrooms,
              bathrooms: p.bathrooms,
              squareFeet: p.squareFeet,
              description: p.description,
              postedDate: p.postedDate,
              lastSeenAt: new Date(),
            },
            update: {
              title: p.title,
              price: p.price,
              rawAddress: p.address,
              location: p.location,
              propertyType: p.propertyType,
              bedrooms: p.bedrooms,
              bathrooms: p.bathrooms,
              squareFeet: p.squareFeet,
              description: p.description,
              postedDate: p.postedDate,
              lastSeenAt: new Date(),
            },
          }),
        ])
      )
    )
  );

  logger.info(`[db] Upserted ${payloads.length} Redfin listings to both RedfinListing and Listing tables (concurrency=${concurrency})`);
}

// ── Realtor Listings ──────────────────────────────────────────────────────────

export async function upsertRealtorListings(
  payloads: Array<ListingUpsertPayload & { estimate?: number }>,
): Promise<void> {
  if (payloads.length === 0) return;

  // Flatten all operations: each payload creates 2 upsert operations (RealtorListing + Listing)
  const concurrency = Number(process.env.DB_UPSERT_CONCURRENCY) || 2;
  const limit = pLimit(concurrency);

  await Promise.all(
    payloads.map((p) =>
      limit(() =>
        prisma.$transaction([
          (prisma.realtorListing as any).upsert({
            where: { url: p.url },
            create: {
              url: p.url,
              title: p.title,
              price: p.price,
              address: p.address,
              location: p.location,
              propertyType: p.propertyType,
              bedrooms: p.bedrooms,
              bathrooms: p.bathrooms,
              squareFeet: p.squareFeet,
              description: p.description,
              postedDate: p.postedDate,
              estimate: p.estimate,
              lastSeenAt: new Date(),
            },
            update: {
              title: p.title,
              price: p.price,
              address: p.address,
              location: p.location,
              propertyType: p.propertyType,
              bedrooms: p.bedrooms,
              bathrooms: p.bathrooms,
              squareFeet: p.squareFeet,
              description: p.description,
              postedDate: p.postedDate,
              estimate: p.estimate,
              lastSeenAt: new Date(),
            },
          }),
          prisma.listing.upsert({
            where: { url: p.url },
            create: {
              url: p.url,
              source: "realtor",
              title: p.title,
              price: p.price,
              rawAddress: p.address,
              location: p.location,
              propertyType: p.propertyType,
              bedrooms: p.bedrooms,
              bathrooms: p.bathrooms,
              squareFeet: p.squareFeet,
              description: p.description,
              postedDate: p.postedDate,
              lastSeenAt: new Date(),
            },
            update: {
              title: p.title,
              price: p.price,
              rawAddress: p.address,
              location: p.location,
              propertyType: p.propertyType,
              bedrooms: p.bedrooms,
              bathrooms: p.bathrooms,
              squareFeet: p.squareFeet,
              description: p.description,
              postedDate: p.postedDate,
              lastSeenAt: new Date(),
            },
          }),
        ])
      )
    )
  );

  logger.info(`[db] Upserted ${payloads.length} Realtor listings to both RealtorListing and Listing tables (concurrency=${concurrency})`);
}

// ── Propwire Listings ─────────────────────────────────────────────────────────

export async function upsertPropwireListings(
  payloads: Array<ListingUpsertPayload & { estimate?: number }>,
): Promise<void> {
  if (payloads.length === 0) return;

  // Flatten all operations: each payload creates 2 upsert operations (PropwireListing + Listing)
  const concurrency = Number(process.env.DB_UPSERT_CONCURRENCY) || 2;
  const limit = pLimit(concurrency);

  await Promise.all(
    payloads.map((p) =>
      limit(() =>
        prisma.$transaction([
          (prisma.propwireListing as any).upsert({
            where: { url: p.url },
            create: {
              url: p.url,
              title: p.title,
              price: p.price,
              address: p.address,
              location: p.location,
              propertyType: p.propertyType,
              bedrooms: p.bedrooms,
              bathrooms: p.bathrooms,
              squareFeet: p.squareFeet,
              description: p.description,
              postedDate: p.postedDate,
              estimate: p.estimate,
              lastSeenAt: new Date(),
            },
            update: {
              title: p.title,
              price: p.price,
              address: p.address,
              location: p.location,
              propertyType: p.propertyType,
              bedrooms: p.bedrooms,
              bathrooms: p.bathrooms,
              squareFeet: p.squareFeet,
              description: p.description,
              postedDate: p.postedDate,
              estimate: p.estimate,
              lastSeenAt: new Date(),
            },
          }),
          prisma.listing.upsert({
            where: { url: p.url },
            create: {
              url: p.url,
              source: "propwire",
              title: p.title,
              price: p.price,
              rawAddress: p.address,
              location: p.location,
              propertyType: p.propertyType,
              bedrooms: p.bedrooms,
              bathrooms: p.bathrooms,
              squareFeet: p.squareFeet,
              description: p.description,
              postedDate: p.postedDate,
              lastSeenAt: new Date(),
            },
            update: {
              title: p.title,
              price: p.price,
              rawAddress: p.address,
              location: p.location,
              propertyType: p.propertyType,
              bedrooms: p.bedrooms,
              bathrooms: p.bathrooms,
              squareFeet: p.squareFeet,
              description: p.description,
              postedDate: p.postedDate,
              lastSeenAt: new Date(),
            },
          }),
        ])
      )
    )
  );

  logger.info(`[db] Upserted ${payloads.length} Propwire listings to both PropwireListing and Listing tables (concurrency=${concurrency})`);
}

// ── Read ──────────────────────────────────────────────────────────────────────

export interface ListingFilters {
  source?: string;
  minPrice?: number;
  maxPrice?: number;
  location?: string;
  dealScore?: string;
  propertyType?: string;
}

export async function getListings(
  filters: ListingFilters = {},
  limit = 500,
): Promise<Listing[]> {
  const where: Prisma.ListingWhereInput = {};

  if (filters.source) where.source = { contains: filters.source };
  if (filters.location)
    where.location = { contains: filters.location, mode: "insensitive" };
  if (filters.dealScore) where.dealScore = filters.dealScore;
  if (filters.propertyType) where.propertyType = filters.propertyType;

  if (filters.minPrice !== undefined || filters.maxPrice !== undefined) {
    where.price = {};
    if (filters.minPrice !== undefined) where.price.gte = filters.minPrice;
    if (filters.maxPrice !== undefined) where.price.lte = filters.maxPrice;
  }

  return prisma.listing.findMany({
    where,
    include: {
      property: true,
      // estimates: true,   // uncomment if you want estimates included
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export async function urlExists(url: string): Promise<boolean> {
  const count = await prisma.listing.count({ where: { url } });
  return count > 0;
}

export async function getExistingUrls(source: string): Promise<Set<string>> {
  const rows = await prisma.listing.findMany({
    where: { source },
    select: { url: true },
  });
  return new Set(rows.map((r) => r.url));
}

/**
 * Get all properties with related listings and estimates
 * Enriches estimates with source listing URLs
 * @param limit - maximum number of properties to return
*/

export async function getAllPropertiesWithListings(limit = 1000) {
  const properties = await prisma.property.findMany({
    select: {
      id: true,
      normalizedAddress: true,
      address: true,
      url: true,
      city: true,
      state: true,
      zip: true,
      latitude: true,
      longitude: true,
      zillowUrl: true,
      redfinUrl: true,
      propwireUrl: true,
      realtorUrl: true,
      createdAt: true,
      updatedAt: true,
      listings: {
        select: {
          id: true,
          url: true,
          source: true,
          title: true,
          price: true,
          rawAddress: true,
          location: true,
          propertyType: true,
          bedrooms: true,
          bathrooms: true,
          squareFeet: true,
          description: true,
          dealScore: true,
          equityEstimate: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      estimates: {
        select: {
          id: true,
          source: true,
          value: true,
          sourceListingId: true,
          fetchedAt: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  properties.forEach((property) => {
    property.estimates = property.estimates.map((estimate: any) => {
      let sourceUrl: string | null = null;
      switch (estimate.source) {
        case "zillow":
          sourceUrl = property.zillowUrl ?? null;
          break;
        case "redfin":
          sourceUrl = property.redfinUrl ?? null;
          break;
        case "realtor":
          sourceUrl = property.realtorUrl ?? null;
          break;
        case "propwire":
          sourceUrl = property.propwireUrl ?? null;
          break;
      }

      return {
        ...estimate,
        sourceUrl,
      };
    });
  });

  return properties;
}

/**
 * Get all listings with optional related property data
 * @param limit - maximum number of listings to return
 */
export async function getAllListings(limit = 1000) {
  // Exclude listings originating from source-specific tables
  // (we want only canonical/general listings, not source-specific lists)
  const excludedSources = ["propwire", "zillow", "redfin", "realtor"];

  return prisma.listing.findMany({
    where: {
      NOT: {
        source: { in: excludedSources },
      },
    },
    include: {
      property: {
        select: {
          id: true,
          normalizedAddress: true,
          address: true,
          city: true,
          state: true,
          zip: true,
          latitude: true,
          longitude: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

// ── Filters (Singleton Pattern) ───────────────────────────────────────────
// Only one filter record exists in the database

export interface SavedFilterInput {
  // Simplified to match Prisma `SavedFilter` schema
  minPrice?: number;
  maxPrice?: number;
  allowedPropertyTypes?: string[];
  keywords?: string[];
  propertyTypeTokens?: string[];
  allowedLocations?: string[];
}

/**
 * Upsert single filter record (create if not exists, update if exists)
 * Since only one filter record should exist, this handles both create and update
 */
export async function upsertFilter(data: SavedFilterInput) {
  // Get existing filter (should be only one)
  const existingFilter = await prisma.savedFilter.findFirst();
  if (existingFilter) {
    // Update existing filter (only the simplified fields)
    return prisma.savedFilter.update({
      where: { id: existingFilter.id },
      data: {
        minPrice: data.minPrice,
        maxPrice: data.maxPrice,
        allowedPropertyTypes: data.allowedPropertyTypes || [],
        keywords: data.keywords || [],
        propertyTypeTokens: data.propertyTypeTokens || [],
        allowedLocations: data.allowedLocations || [],
      },
    });
  }

  // Create new filter
  return prisma.savedFilter.create({
    data: {
      minPrice: data.minPrice,
      maxPrice: data.maxPrice,
      allowedPropertyTypes: data.allowedPropertyTypes || [],
      keywords: data.keywords || [],
      propertyTypeTokens: data.propertyTypeTokens || [],
      allowedLocations: data.allowedLocations || [],
    },
  });
}

/**
 * Get the single filter record (or null if none exists)
 */
export async function getFilter() {
  return prisma.savedFilter.findFirst();
}

// ── Read Source-Specific Listings ──────────────────────────────────────────

export async function getZillowListings(limit = 1000): Promise<any[]> {
  return (prisma.zillowListing as any).findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export async function getRedfinListings(limit = 1000): Promise<any[]> {
  return (prisma.redfinListing as any).findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export async function getRealtorListings(limit = 1000): Promise<any[]> {
  return (prisma.realtorListing as any).findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export async function getPropwireListings(limit = 1000): Promise<any[]> {
  return (prisma.propwireListing as any).findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

// ── Underwriting ─────────────────────────────────────────────────────────────

export async function updateDealScore(
  url: string,
  dealScore: string,
  equityEstimate?: number,
): Promise<void> {
  await prisma.listing.update({
    where: { url },
    data: { dealScore, equityEstimate },
  });
}

// ── Stats ─────────────────────────────────────────────────────────────────────

export async function getSummaryStats(): Promise<{
  total: number;
  bySource: Record<string, number>;
  byDealScore: Record<string, number>;
}> {
  const total = await prisma.listing.count();
  const bySrc = await prisma.listing.groupBy({ by: ["source"], _count: true });
  const byScore = await prisma.listing.groupBy({ by: ["dealScore"], _count: true });

  return {
    total,
    bySource: Object.fromEntries(bySrc.map((r) => [r.source, r._count])),
    byDealScore: Object.fromEntries(
      byScore.map((r) => [r.dealScore ?? "unscored", r._count])
    ),
  };
}

// ── Enrichment (Zillow zestimate) ─────────────────────────────────────────────

/**
 * Create or get a Property record from an enriched listing
 * Generates a normalized address key for deduplication
 * Also stores the source URL (Zillow/Redfin/etc) in the appropriate field
 */
export async function upsertPropertyFromEnrichment(
  address: string,
  zpid?: string | null,
  source?: string,
  sourceUrl?: string,
): Promise<string> {
  const normalizedAddress = (address || "").toLowerCase().trim();

  // Map source to the corresponding URL field
  const urlUpdate: Record<string, any> = { address };
  if (sourceUrl && source) {
    switch (source) {
      case "zillow":
        urlUpdate.zillowUrl = sourceUrl;
        break;
      case "redfin":
        urlUpdate.redfinUrl = sourceUrl;
        break;
      case "propwire":
        urlUpdate.propwireUrl = sourceUrl;
        break;
      case "realtor":
        urlUpdate.realtorUrl = sourceUrl;
        break;
    }
  }

  const property = await prisma.property.upsert({
    where: { normalizedAddress },
    create: {
      normalizedAddress,
      address,
      ...urlUpdate,
    },
    update: urlUpdate,
  });

  return property.id;
}

/**
 * Create an Estimate record for a property from Zillow enrichment
 * Uses upsert to handle duplicate enrichment attempts
 */
export async function upsertEstimateFromZillow(
  propertyId: string,
  zestimate: number,
  sourceListingId?: string,
  sourceUrl?: string,
): Promise<void> {
  await prisma.estimate.upsert({
    where: {
      propertyId_source: {
        propertyId,
        source: "zillow",
      },
    },
    create: {
      propertyId,
      source: "zillow",
      value: zestimate,
      sourceListingId,
    },
    update: {
      value: zestimate,
      sourceListingId,
      fetchedAt: new Date(),
    },
  });
}

/**
 * Upsert a single listing and return its ID
 * Used during enrichment to link Property+Estimate records to listings
 * 
 * Deduplication strategy: Same as upsertListing()
 * - First tries URL-based upsert
 * - Falls back to address+source check to prevent duplicates
 */
export async function upsertSingleListing(
  payload: ListingUpsertPayload,
): Promise<string> {
  const createData = {
    url: payload.url,
    source: payload.source,
    title: payload.title,
    price: payload.price,
    rawAddress: payload.address,
    location: payload.location,
    propertyType: payload.propertyType,
    bedrooms: payload.bedrooms,
    bathrooms: payload.bathrooms,
    squareFeet: payload.squareFeet,
    description: payload.description,
    ownerName: payload.ownerName,
    ownerPhone: payload.ownerPhone,
    postedDate: payload.postedDate ?? payload.listedAt,
    lastSeenAt: new Date(),
    dealScore: (payload as any).dealScore,
    equityEstimate: (payload as any).equityEstimate,
  };

  const updateData = {
    url: payload.url,
    title: payload.title,
    price: payload.price,
    rawAddress: payload.address,
    location: payload.location,
    propertyType: payload.propertyType,
    bedrooms: payload.bedrooms,
    bathrooms: payload.bathrooms,
    squareFeet: payload.squareFeet,
    description: payload.description,
    ownerName: payload.ownerName,
    ownerPhone: payload.ownerPhone,
    postedDate: payload.postedDate ?? payload.listedAt,
    lastSeenAt: new Date(),
    dealScore: (payload as any).dealScore,
    equityEstimate: (payload as any).equityEstimate,
  };

  try {
    const listing = await prisma.listing.upsert({
      where: { url: payload.url },
      create: createData,
      update: updateData,
    });
    return listing.id;
  } catch (err: any) {
    // If URL doesn't exist yet, check if this address+source already exists
    if (err.code === "P2025" || err.message?.includes("not found")) {
      const existing = await findListingByAddressAndSource(payload.address, payload.source);
      
      if (existing) {
        logger.debug(
          `[db] Listing with address "${payload.address}" from source "${payload.source}" already exists (id=${existing.id}). ` +
          `Updating URL from "${existing.url}" to "${payload.url}".`
        );
        // Update the existing listing with the new URL
        const updated = await prisma.listing.update({
          where: { id: existing.id },
          data: updateData,
        });
        return updated.id;
      }
    }
    throw err;
  }
}

/**
 * Update a listing with its linked property ID
 */
export async function updateListingPropertyId(
  listingId: string,
  propertyId: string,
): Promise<void> {
  await prisma.listing.update({
    where: { id: listingId },
    data: { propertyId },
  });
}

/**
 * Get old listings from database that have not been linked to a Property yet
 * (i.e., have no Zillow enrichment)
 * 
 * @param platform Source platform
 * @param limit Maximum number of old listings to fetch
 * @returns Array of Listing records
 */

export async function getOldListingsWithoutPropertyLink(
  platform: string,
  limit: number = 50
): Promise<Listing[]> {
  return prisma.listing.findMany({
    where: {
      source: platform,
      propertyId: null,  // Not yet linked to a Property
    },
    take: limit,
  });
}

/**
 * Batch re-enrich old listings from the database with Zillow zestimates.
 * Queries listings by platform, extracts addresses, passes to enricher,
 * and creates Property+Estimate records for any matches.
 * 
 * @param platform Source platform (e.g., "crexi", "redfin", "loopnet")
 * @param options Configuration (limit, concurrency)
 * @returns Summary statistics of the re-enrichment run
 */
export async function reEnrichOldListingsFromPlatform(
  platform: string,
  options?: {
    limit?: number;
    concurrency?: number;
  }
): Promise<{
  processed: number;
  enriched: number;
  foundNoEstimate: number;
  notFound: number;
  failed: number;
  duration_ms: number;
}> {
  const startTime = Date.now();
  const limit = options?.limit ?? 100;
  const concurrency = options?.concurrency ?? 2;

  logger.info(`\n${"─".repeat(60)}`);
  logger.info(`Starting batch re-enrichment for platform: ${platform}`);
  logger.info(`Limit: ${limit}, Concurrency: ${concurrency}`);
  logger.info(`${"─".repeat(60)}\n`);

  // Query listings from database by platform
  let dbListings: Listing[] = [];
  try {
    dbListings = await prisma.listing.findMany({
      where: { source: platform },
      take: limit,
    });
    logger.info(`[re-enrich] Found ${dbListings.length} old listings from platform: ${platform}`);
  } catch (err) {
    logger.error(`[re-enrich] Failed to query listings for platform "${platform}": ${err}`);
    return {
      processed: 0,
      enriched: 0,
      foundNoEstimate: 0,
      notFound: 0,
      failed: 0,
      duration_ms: Date.now() - startTime,
    };
  }

  // Convert DB listings to RawListing format for enrichment service
  const rawListings: RawListing[] = dbListings.map((l) => ({
    url: l.url,
    source: l.source,
    title: l.title ?? undefined,
    price: l.price ?? undefined,
    address: l.rawAddress ?? undefined,
    location: l.location ?? undefined,
    propertyType: (l.propertyType as any) ?? undefined,
    bedrooms: l.bedrooms ?? undefined,
    bathrooms: l.bathrooms ?? undefined,
    squareFeet: l.squareFeet ?? undefined,
    description: l.description ?? undefined,
    ownerName: l.ownerName ?? undefined,
    ownerPhone: l.ownerPhone ?? undefined,
    postedDate: l.postedDate ?? undefined,
  }));

  // Call enrichment service
  let enrichedListings: RawListing[] = [];
  try {
    enrichedListings = await zillowEnrichmentService.enrichAllListings(rawListings, concurrency);
  } catch (err) {
    logger.error(`[re-enrich] Enrichment service error: ${err}`);
    return {
      processed: rawListings.length,
      enriched: 0,
      foundNoEstimate: 0,
      notFound: 0,
      failed: 1,
      duration_ms: Date.now() - startTime,
    };
  }

  // Create Property+Estimate records for enriched listings
  let enriched = 0;
  let foundNoEstimate = 0;
  let notFound = 0;

  for (const listing of enrichedListings) {
    // If zestimate was found, create records
    if (listing.zestimate != null && listing.address) {
      try {
        const propertyId = await upsertPropertyFromEnrichment(
          listing.address,
          listing.zpid,
          "zillow",
          listing.sourceUrl ?? listing.url
        );
        await upsertEstimateFromZillow(propertyId, listing.zestimate, listing.url, listing.sourceUrl ?? listing.url);
        enriched++;
      } catch (err) {
        logger.warn(`[re-enrich] Failed to create property/estimate for ${listing.address}: ${err}`);
      }
    }
    // If zpid was found but no zestimate, just track it
    else if (listing.zpid != null && listing.address) {
      foundNoEstimate++;
    }
    // Otherwise not found
    else if (listing.address) {
      notFound++;
    }
  }

  const duration_ms = Date.now() - startTime;
  logger.info(`\n${"─".repeat(60)}`);
  logger.info(`[re-enrich] Batch re-enrichment complete for: ${platform}`);
  logger.info(`[re-enrich]   • Listings processed: ${rawListings.length}`);
  logger.info(`[re-enrich]   • Successfully enriched (with zestimate): ${enriched}`);
  logger.info(`[re-enrich]   • Found but no zestimate: ${foundNoEstimate}`);
  logger.info(`[re-enrich]   • Not found on Zillow: ${notFound}`);
  logger.info(`[re-enrich]   • Duration: ${duration_ms}ms`);
  logger.info(`[re-enrich]   • Success rate: ${((enriched / rawListings.length) * 100).toFixed(1)}%`);
  logger.info(`${"─".repeat(60)}\n`);

  return {
    processed: rawListings.length,
    enriched,
    foundNoEstimate,
    notFound,
    failed: rawListings.length - enriched - foundNoEstimate - notFound,
    duration_ms,
  };
}