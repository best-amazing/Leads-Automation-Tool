// src/lib/deed-data/parcel-data-service.ts
// ─────────────────────────────────────────────────────────────────────────────
// Two backends (ATTOM -> OGRIP), one common ParcelResult shape, tried in
// order until one returns a deed date.
// ─────────────────────────────────────────────────────────────────────────────

import axios from "axios";
import { ParcelResult, EMPTY_PARCEL_RESULT } from "./types";
import { logger } from "../../utils/logger";
import { withRetry } from "./retry";

// ── 1. ATTOM (API key, address-keyed) ─────────────────────────────────────────

const ATTOM_API_KEY = process.env.ATTOM_API_KEY;
const ATTOM_BASE = "https://api.gateway.attomdata.com/propertyapi/v1.0.0";

interface AttomSaleResponse {
  property?: Array<{
    identifier?: { attomId?: number; apn?: string };
    sale?: {
      saleTransDate?: string;
      amount?: { saleAmt?: number };
    };
    address?: { county?: string };
    owner?: { owner1?: { fullName?: string } };
  }>;
}

export async function getFromAttomByAddress(
  address1: string,
  address2: string
): Promise<ParcelResult | null> {
  if (!ATTOM_API_KEY) return null;

  const params = new URLSearchParams({ address1, address2 });
  try {
    const res = await withRetry(
      () =>
        axios.get<AttomSaleResponse>(`${ATTOM_BASE}/sale/detail?${params.toString()}`, {
          headers: {
            Accept: "application/json",
            apikey: ATTOM_API_KEY,
          },
          timeout: 12_000,
        }),
      { retries: 3, baseDelayMs: 300, logLabel: "attom" }
    );

    const prop = res.data?.property?.[0];
    if (!prop?.sale?.saleTransDate) return null;

    return {
      latestDeedTransferDate: normalizeDate(prop.sale.saleTransDate),
      lastSalePrice: prop.sale.amount?.saleAmt ?? null,
      parcelId: prop.identifier?.apn ?? null,
      ownerName: prop.owner?.owner1?.fullName ?? null,
      county: prop.address?.county ?? null,
      deedDataSource: "attom",
    };
  } catch (err: any) {
    logger.warn(`[parcel-service] ATTOM error: ${err.response?.status || err.message}`);
    return null;
  }
}

// ── 2. OGRIP (Ohio Statewide Parcels — free fallback) ───────────────────────

const OGRIP_URL = process.env.OGRIP_PARCELS_URL;
const OGRIP_SALE_DATE_FIELD = process.env.OGRIP_SALE_DATE_FIELD || "SALEDATE";
const OGRIP_PARCEL_ID_FIELD = process.env.OGRIP_PARCEL_ID_FIELD || "PARCELID";
const OGRIP_OWNER_FIELD = process.env.OGRIP_OWNER_FIELD || "OWNERNAME";
// Only run the expensive per-parcel discovery when explicitly enabled. The
// public OGRIP view layer has no sale-date field, so discovery is off by default.
const OGRIP_FIELD_DISCOVERY = process.env.OGRIP_FIELD_DISCOVERY === "1";

let ogripWarned = false;

// Known aliases across OGRIP's public view and credentialed/full layers.
// The public view exposes only County/StateParcelID/LocalParcelID/SitusAddressAll
// (no sale date or owner); credentialed layers may use different field names.
const SALE_DATE_ALIASES = ["SALEDATE", "saledate", "transfer_date", "transferdate", "lastsaledate", "sale_date"];
const PARCEL_ID_ALIASES = ["PARCELID", "StateParcelID", "LocalParcelID", "PARCEL_ID", "PARCELNO", "parcelnumb"];
const OWNER_ALIASES = ["OWNERNAME", "OWNER", "OWNER1", "OWNER2", "OwnerAll", "owner"];

function pickField(attrs: Record<string, unknown>, aliases: string[], preferred?: string): string | undefined {
  if (preferred && attrs[preferred] != null) return String(attrs[preferred]);
  for (const alias of aliases) {
    if (attrs[alias] != null) return String(attrs[alias]);
  }
  return undefined;
}

async function queryOgripPoint(lat: number, lon: number, outFields: string): Promise<any | null> {
  const params = new URLSearchParams({
    f: "json",
    geometry: `${lon},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields,
    returnGeometry: "false",
    resultRecordCount: "1",
  });
  const res = await withRetry(
    () => axios.get(`${OGRIP_URL}/query?${params.toString()}`, { timeout: 10_000 }),
    { retries: 2, baseDelayMs: 300, logLabel: "ogrip" }
  );
  const attrs = res.data?.features?.[0]?.attributes;
  if (attrs) return attrs;
  // Surface the OGRIP error only once so a misconfigured layer doesn't spam logs.
  if (!ogripWarned && (res.data?.error || res.data?.error?.message)) {
    ogripWarned = true;
    logger.warn(`[parcel-service] OGRIP query returned no feature or error: ${res.data?.error?.message || "none"}`);
  }
  return null;
}

export async function getFromOgrip(lat: number, lon: number): Promise<ParcelResult | null> {
  if (!OGRIP_URL) return null;

  // Try configured field names first (credentialed/full layers).
  let attrs = await queryOgripPoint(lat, lon, [OGRIP_SALE_DATE_FIELD, OGRIP_PARCEL_ID_FIELD, OGRIP_OWNER_FIELD, "COUNTY"].join(","));
  if (!attrs) return null;

  // Optional slow fallback: query every field and map known aliases. Only useful
  // against layers whose sale-date/parcel/owner fields use different names.
  if (OGRIP_FIELD_DISCOVERY && !attrs[OGRIP_SALE_DATE_FIELD]) {
    const allAttrs = await queryOgripPoint(lat, lon, "*");
    if (allAttrs) {
      attrs = {
        ...attrs,
        [OGRIP_SALE_DATE_FIELD]: pickField(allAttrs, SALE_DATE_ALIASES, attrs[OGRIP_SALE_DATE_FIELD]) ?? null,
        [OGRIP_PARCEL_ID_FIELD]: pickField(allAttrs, PARCEL_ID_ALIASES, attrs[OGRIP_PARCEL_ID_FIELD]) ?? null,
        [OGRIP_OWNER_FIELD]: pickField(allAttrs, OWNER_ALIASES, attrs[OGRIP_OWNER_FIELD]) ?? null,
      };
    }
  }

  const saleDate = attrs[OGRIP_SALE_DATE_FIELD];
  if (!saleDate) return null;

  return {
    latestDeedTransferDate: normalizeDate(saleDate),
    lastSalePrice: null,
    parcelId: attrs[OGRIP_PARCEL_ID_FIELD] ? String(attrs[OGRIP_PARCEL_ID_FIELD]) : null,
    ownerName: attrs[OGRIP_OWNER_FIELD] ? String(attrs[OGRIP_OWNER_FIELD]) : null,
    county: attrs["COUNTY"] ? String(attrs["COUNTY"]) : null,
    deedDataSource: "ogrip",
  };
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

export interface GetParcelDataInput {
  lat: number;
  lon: number;
  address1?: string;
  address2?: string;
}

export async function getParcelData(input: GetParcelDataInput): Promise<ParcelResult> {
  const { lat, lon, address1, address2 } = input;

  // 1. ATTOM (address-keyed)
  if (address1 && address2) {
    const attom = await safeCall(() => getFromAttomByAddress(address1, address2));
    if (attom) return attom;
  }

  // 2. OGRIP (Ohio Statewide Parcels, point lookup — free fallback)
  const ogrip = await safeCall(() => getFromOgrip(lat, lon));
  if (ogrip) return ogrip;

  return EMPTY_PARCEL_RESULT;
}

async function safeCall(fn: () => Promise<ParcelResult | null>): Promise<ParcelResult | null> {
  try {
    return await fn();
  } catch (err: any) {
    logger.error(`[parcel-data-service] backend error: ${err.message || err}`);
    return null;
  }
}

function normalizeDate(raw: string | number): string | null {
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}
