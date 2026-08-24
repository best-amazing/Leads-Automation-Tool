// src/scrapers/property-purchase-research/deed-data-resolver.ts
// ─────────────────────────────────────────────────────────────────────────────
// Deed transfer date lookup for ADU Property Research
//
// Strategy (cascading):
//   1. Geocode the address via the Census Bureau geocoder
//   2. ATTOM API — look up saleTransDate via /sale/detail endpoint
//   3. OGRIP ArcGIS fallback — query Ohio's statewide parcel service by lat/lon
//
// Ported from: Driving-for-dollars/integrations/deed-data-resolver.ts
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import axios from "axios";
import { logger } from "../../utils/logger";

const ATTOM_API_KEY = process.env.ATTOM_API_KEY;
const ATTOM_BASE = "https://api.gateway.attomdata.com/propertyapi/v1.0.0";

const OGRIP_URL =
  process.env.OGRIP_PARCELS_URL ||
  "https://services2.arcgis.com/MlJ0G8iWUyC7jAmu/arcgis/rest/services/OhioStatewidePacels_full_view/FeatureServer/0";
const OGRIP_SALE_DATE_FIELD = process.env.OGRIP_SALE_DATE_FIELD || "SALEDATE";

// ── Types ─────────────────────────────────────────────────────────────────────

interface AttomSaleResponse {
  property?: Array<{
    sale?: {
      saleTransDate?: string;
    };
  }>;
}

export interface DeedLookupInput {
  /** Street address. Optional when latitude/longitude are provided. */
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  latitude?: number;
  longitude?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeDate(raw: string | number | undefined | null): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function splitForAttom(normalizedAddress: string): { address1: string; address2: string } {
  const [first, ...rest] = normalizedAddress.split(",").map((p) => p.trim());
  return { address1: first, address2: rest.join(", ") };
}

// ── Census Bureau Geocoder ────────────────────────────────────────────────────

export async function geocodeAddress(
  addressStr: string,
): Promise<{ lat: number; lon: number; matchedAddress?: string } | null> {
  const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(addressStr)}&benchmark=Public_AR_Current&format=json`;

  try {
    const res = await axios.get(url, { timeout: 10_000, family: 4 });
    const match = res.data?.result?.addressMatches?.[0];
    if (!match) {
      logger.debug(`[deed-resolver] [geocode] No match for: "${addressStr}"`);
      return null;
    }

    logger.debug(`[deed-resolver] [geocode] Matched: "${match.matchedAddress}"`);
    return {
      lat: match.coordinates.y,
      lon: match.coordinates.x,
      matchedAddress: match.matchedAddress,
    };
  } catch (err: any) {
    logger.debug(`[deed-resolver] [geocode] ERROR: ${err.message || err}`);
    return null;
  }
}

// ── ATTOM API ─────────────────────────────────────────────────────────────────

export async function getFromAttom(
  address1: string,
  address2: string,
): Promise<string | null> {
  if (!ATTOM_API_KEY || !address1 || !address2) return null;

  try {
    const params = new URLSearchParams({ address1, address2 });
    const res = await axios.get<AttomSaleResponse>(
      `${ATTOM_BASE}/sale/detail?${params.toString()}`,
      {
        headers: {
          Accept: "application/json",
          apikey: ATTOM_API_KEY,
        },
        timeout: 12_000,
        family: 4,
      },
    );

    const saleDate = res.data?.property?.[0]?.sale?.saleTransDate;
    if (!saleDate) {
      logger.debug(`[deed-resolver] [attom] No saleTransDate in response for "${address1}"`);
    }
    return normalizeDate(saleDate);
  } catch (err: any) {
    const status = err.response?.status;
    const msg = err.response?.data?.status?.msg || err.message || err;
    logger.debug(`[deed-resolver] [attom] ERROR ${status || "network"}: ${msg}`);
    return null;
  }
}

// ── OGRIP ArcGIS Fallback ─────────────────────────────────────────────────────

export async function getFromOgrip(
  lat: number | null,
  lon: number | null,
): Promise<string | null> {
  if (lat == null || lon == null || !OGRIP_URL) return null;

  try {
    const params = new URLSearchParams({
      f: "json",
      geometry: `${lon},${lat}`,
      geometryType: "esriGeometryPoint",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: `${OGRIP_SALE_DATE_FIELD},SALEDATE,transfer_date,transferdate,lastsaledate,sale_date`,
      returnGeometry: "false",
      resultRecordCount: "1",
    });

    const res = await axios.get(`${OGRIP_URL}/query?${params.toString()}`, {
      timeout: 10_000,
      family: 4,
    });
    const attrs = res.data?.features?.[0]?.attributes;
    if (!attrs) return null;

    const rawDate =
      attrs[OGRIP_SALE_DATE_FIELD] ??
      attrs.SALEDATE ??
      attrs.transfer_date ??
      attrs.transferdate ??
      attrs.lastsaledate ??
      attrs.sale_date;
    if (!rawDate) {
      logger.debug(
        `[deed-resolver] [ogrip] No sale date field found. Available fields: ${Object.keys(attrs).join(", ")}`,
      );
    }
    return normalizeDate(rawDate);
  } catch (err: any) {
    logger.debug(`[deed-resolver] [ogrip] ERROR: ${err.message || err}`);
    return null;
  }
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

export async function fetchDeedTransferDate(
  input: DeedLookupInput,
): Promise<string | null> {
  const collapseWs = (s: string) => s.replace(/\s+/g, " ").trim();

  // Coordinates-only path (no address): skip geocoding + ATTOM, go straight
  // to the parcel service (craigslist 2025+ exposes a pin but no address).
  if (!input.address) {
    if (input.latitude != null && input.longitude != null) {
      const ogripDate = await getFromOgrip(input.latitude, input.longitude);
      if (ogripDate) {
        logger.info(`[deed-resolver] ✓ OGRIP matched (lat/lon): ${ogripDate}`);
        return ogripDate;
      }
    }
    logger.debug(`[deed-resolver] Neither address nor usable coordinates — skipping lookup`);
    return null;
  }

  // Build a full address string for geocoding + ATTOM
  const addressParts = input.address.split(",").map((p) => p.trim());
  const streetPart = collapseWs(addressParts[0] || input.address);

  const city = collapseWs(input.city?.trim() ?? "");
  const state = collapseWs(input.state?.trim() || "OH");
  const zip = collapseWs(input.zip?.trim() ?? "");
  const cityStateZipPart = city
    ? `${city}, ${state}${zip ? " " + zip : ""}`
    : zip
      ? `${state} ${zip}`
      : state;

  let fullAddrStr = cityStateZipPart
    ? collapseWs(`${streetPart}, ${cityStateZipPart}`)
    : collapseWs(input.address);

  let lat = input.latitude ?? null;
  let lon = input.longitude ?? null;

  // 1. Geocode the address (also gets lat/lon for OGRIP fallback)
  const geocoded = await geocodeAddress(fullAddrStr);
  if (geocoded) {
    if (lat == null) lat = geocoded.lat;
    if (lon == null) lon = geocoded.lon;
    if (geocoded.matchedAddress) {
      fullAddrStr = geocoded.matchedAddress;
    }
  }

  // 2. Split address for ATTOM
  const { address1, address2 } = splitForAttom(fullAddrStr);

  logger.debug(
    `[deed-resolver] address1="${address1}" | address2="${address2}" | lat=${lat} lon=${lon}`,
  );

  // 3. Try ATTOM first
  if (address1 && address2) {
    const attomDate = await getFromAttom(address1, address2);
    if (attomDate) {
      logger.info(`[deed-resolver] ✓ ATTOM matched: ${attomDate} for "${input.address}"`);
      return attomDate;
    }
  }

  // 4. Try OGRIP fallback with point geometry
  const ogripDate = await getFromOgrip(lat, lon);
  if (ogripDate) {
    logger.info(`[deed-resolver] ✓ OGRIP matched: ${ogripDate} for "${input.address}"`);
    return ogripDate;
  }

  logger.debug(`[deed-resolver] No deed date found for "${input.address}"`);
  return null;
}
