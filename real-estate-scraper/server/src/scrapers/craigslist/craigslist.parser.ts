// src/scrapers/craigslist/craigslist.parser.ts
import * as cheerio from "cheerio";
import { RawListing, PropertyType } from "../../types/listing";
import { logger } from "../../utils/logger";

// ── Helpers ────────────────────────────────────────────────────────────────

function parsePrice(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = raw.replace(/[$,\s]/g, "").match(/\d+/);
  return m ? parseInt(m[0], 10) : undefined;
}

function extractBedsBathsSqft(text: string): {
  bedrooms?: number;
  bathrooms?: number;
  squareFeet?: number;
} {
  const beds = text.match(/(\d+)\s*br/i);
  const baths = text.match(/(\d+(?:\.\d+)?)\s*ba/i);
  const sqft = text.match(/(\d[\d,]*)\s*ft/i);
  return {
    bedrooms: beds ? parseInt(beds[1], 10) : undefined,
    bathrooms: baths ? parseFloat(baths[1]) : undefined,
    squareFeet: sqft ? parseInt(sqft[1].replace(/,/g, ""), 10) : undefined,
  };
}

/**
 * Normalise raw Craigslist property-type text into our canonical enum.
 * Craigslist uses free-text so we match on keywords.
 */
function detectPropertyType(text: string): PropertyType | undefined {
  const t = text.toLowerCase();
  if (
    t.includes("single family") ||
    t.includes("single-family") ||
    t.includes("sfh")
  ) {
    return "single_family";
  }
  if (
    t.includes("multi") ||
    t.includes("duplex") ||
    t.includes("triplex") ||
    t.includes("quadplex")
  ) {
    return "multi_family";
  }
  if (t.includes("condo")) return "condo";
  if (t.includes("townhouse") || t.includes("town house")) return "townhouse";
  return undefined;
}

/**
 * Extract a US phone number from arbitrary text.
 * Matches formats: (414) 555-1234 / 414-555-1234 / 4145551234 / +1 414 555 1234
 */
function extractPhone(text: string): string | undefined {
  const m = text.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
  return m ? m[0].trim() : undefined;
}

/**
 * Try to extract a seller/owner name.
 * Craigslist sometimes puts a name in:
 *   • <p class="attrgroup"> with a label like "name:" or as the first line of the body
 *   • The reply modal / contact section (rarely present in static HTML)
 * We attempt a best-effort extraction — it won't always be available.
 */
function extractOwnerName(
  $: cheerio.CheerioAPI,
  bodyText: string,
): string | undefined {
  // Some posts include a "name:" attribute in the attr groups
  let name: string | undefined;
  $(".attrgroup span, p.attrgroup span").each((_, el) => {
    const txt = $(el).text().trim();
    if (/^name\s*:/i.test(txt)) {
      name = txt.replace(/^name\s*:\s*/i, "").trim() || undefined;
    }
  });
  if (name) return name;

  // Heuristic: look for "contact [Name]" or "call [Name]" in the body
  const contactMatch = bodyText.match(
    /(?:contact|call|text|reach)\s+([A-Z][a-z]+(?: [A-Z][a-z]+)?)/,
  );
  return contactMatch ? contactMatch[1] : undefined;
}

/**
 * Parse Craigslist's posted-date text into an absolute Date.
 * Handles relative ("4h ago", "3d ago") and absolute ("8/19") formats.
 * Returns undefined when unparseable.
 */
function parsePostedDateText(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const text = raw.trim();

  // Relative: "4h ago", "3d ago", "12m ago"
  const rel = text.match(/^(\d+)\s*(min|m|h|hr|d|w)\b/i);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    const msPerUnit: Record<string, number> = {
      min: 60_000, m: 60_000,
      h: 3_600_000, hr: 3_600_000,
      d: 86_400_000,
      w: 7 * 86_400_000,
    };
    return new Date(Date.now() - n * msPerUnit[unit]);
  }

  // Absolute month/day: "8/19" (current year; roll back one year if in future)
  const abs = text.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (abs) {
    const now = new Date();
    const d = new Date(now.getFullYear(), parseInt(abs[1], 10) - 1, parseInt(abs[2], 10));
    if (d > now) d.setFullYear(d.getFullYear() - 1);
    return d;
  }

  return undefined;
}

// ── Search results page ────────────────────────────────────────────────────

/**
 * Parse a Craigslist real-estate search results page.
 * Handles all four known layouts:
 *   1. New 2025+ (div[data-pid].cl-search-result / .gallery-card)
 *   2. Static (li.cl-static-search-result)  — served via proxies / no JS
 *   3. New 2023+ (li[data-pid])
 *   4. Classic (li.result-row)
 *
 * Note: owner name/phone are only available on the detail page, not search results.
 */
export function parseCraigslistSearchPage(
  html: string,
  baseUrl: string,
): Omit<RawListing, "source">[] {
  const $ = cheerio.load(html);
  const results: Omit<RawListing, "source">[] = [];

  // ── Layout 1: 2025+ gallery cards (div.cl-search-result) ─────────────────
  const galleryItems = $("div.cl-search-result[data-pid]");
  if (galleryItems.length > 0) {
    logger.debug(`[cl-parser] 2025 layout: ${galleryItems.length} items`);
    galleryItems.each((_, el) => {
      const anchor = $(el).find("a.posting-title").first();
      const href = anchor.attr("href");
      if (!href) return;

      const titleText =
        anchor.find(".label").text().trim() ||
        anchor.text().trim() ||
        $(el).attr("title")?.trim() ||
        "";

      // Targeted extraction — combining the whole .meta blob into one regex
      // haystack misfires (house numbers like "213 Brice Rd" parse as "213br").
      const bedroomsText = $(el).find(".post-bedrooms").text();
      const sqftText = $(el).find(".post-sqft").text();
      const bedrooms = bedroomsText.match(/(\d+)\s*br/i)
        ? parseInt(bedroomsText.match(/(\d+)\s*br/i)![1], 10)
        : undefined;
      const squareFeet = sqftText.match(/(\d[\d,]*)\s*ft/i)
        ? parseInt(sqftText.match(/(\d[\d,]*)\s*ft/i)![1].replace(/,/g, ""), 10)
        : undefined;
      const metaText = $(el).find(".meta").text();

      results.push({
        url: href.startsWith("http") ? href : new URL(href, baseUrl).toString(),
        title: titleText || undefined,
        price: parsePrice($(el).find(".priceinfo").first().text()),
        location:
          $(el)
            .find(".result-location")
            .text()
            .trim()
            .replace(/[()]/g, "")
            .trim() || undefined,
        postedDate: parsePostedDateText(
          $(el).find(".result-posted-date").text(),
        ),
        propertyType: detectPropertyType(`${titleText} ${metaText}`),
        bedrooms,
        bathrooms: undefined,
        squareFeet,
      });
    });
    return results;
  }

  // ── Layout 2: static ──────────────────────────────────────────────────────
  const staticItems = $("li.cl-static-search-result");
  if (staticItems.length > 0) {
    logger.debug(`[cl-parser] static layout: ${staticItems.length} items`);
    staticItems.each((_, el) => {
      const anchor = $(el).find("a").first();
      const href = anchor.attr("href");
      if (!href) return;
      const titleText =
        $(el).find(".title").text().trim() || anchor.text().trim();
      results.push({
        url: href.startsWith("http") ? href : new URL(href, baseUrl).toString(),
        title: titleText || undefined,
        price: parsePrice($(el).find(".price").text()),
        location: $(el).find(".location").text().trim() || undefined,
        propertyType: detectPropertyType(titleText),
      });
    });
    return results;
  }

  // ── Layout 3: new (data-pid) ───────────────────────────────────────────────
  const newItems = $("li[data-pid]");
  if (newItems.length > 0) {
    logger.debug(`[cl-parser] new layout: ${newItems.length} items`);
    newItems.each((_, el) => {
      const anchor =
        $(el).find("a.cl-app-anchor, a[data-id]").first() ||
        $(el).find("a").first();
      const href = anchor.attr("href");
      if (!href) return;

      const titleText = anchor.text().trim();
      const housingText = $(el).find(".housing").text();
      const { bedrooms, bathrooms, squareFeet } =
        extractBedsBathsSqft(housingText);

      results.push({
        url: href.startsWith("http") ? href : new URL(href, baseUrl).toString(),
        title: titleText || undefined,
        price: parsePrice($(el).find(".priceinfo, .price").first().text()),
        location:
          $(el).find(".supertitle").text().trim().replace(/[()]/g, "").trim() ||
          undefined,
        postedDate: $(el).find("time").attr("datetime")
          ? new Date($(el).find("time").attr("datetime")!)
          : undefined,
        propertyType: detectPropertyType(`${titleText} ${housingText}`),
        bedrooms,
        bathrooms,
        squareFeet,
      });
    });
    return results;
  }

  // ── Layout 4: classic (result-row) ────────────────────────────────────────
  const classicItems = $("li.result-row");
  logger.debug(`[cl-parser] classic layout: ${classicItems.length} items`);
  classicItems.each((_, el) => {
    const anchor = $(el).find("a.result-title").first();
    const href = anchor.attr("href");
    if (!href) return;

    const titleText = anchor.text().trim();
    const housingText = $(el).find(".housing").text();
    const { bedrooms, bathrooms, squareFeet } =
      extractBedsBathsSqft(housingText);

    results.push({
      url: href.startsWith("http") ? href : new URL(href, baseUrl).toString(),
      title: titleText || undefined,
      price: parsePrice($(el).find(".result-price").first().text()),
      location:
        $(el).find(".result-hood").text().trim().replace(/[()]/g, "").trim() ||
        undefined,
      postedDate: $(el).find("time").attr("datetime")
        ? new Date($(el).find("time").attr("datetime")!)
        : undefined,
      propertyType: detectPropertyType(`${titleText} ${housingText}`),
      bedrooms,
      bathrooms,
      squareFeet,
    });
  });

  return results;
}

// ── Detail page ────────────────────────────────────────────────────────────

export interface CraigslistDetail {
  description?: string;
  address?: string;
  bedrooms?: number;
  bathrooms?: number;
  squareFeet?: number;
  propertyType?: PropertyType;
  // Project doc §3.2 — owner contact fields
  ownerName?: string;
  ownerPhone?: string;
}

/**
 * Parse a Craigslist listing detail page.
 *
 * Extracts all fields the project goals doc requires:
 *   ✓ description, address, beds/baths/sqft
 *   ✓ propertyType — from the housing attributes block
 *   ✓ ownerPhone   — scanned from the full posting body
 *   ✓ ownerName    — best-effort from attrgroup or "contact [Name]" patterns
 *
 * Note: Craigslist deliberately hides seller email/phone behind a reply wall.
 * Phone numbers appear only when the seller chose to include them in their post text.
 */
export function parseCraigslistDetailPage(html: string): CraigslistDetail {
  const $ = cheerio.load(html);

  // ── Description — strip QR boilerplate ───────────────────────────────────
  const bodyEl = $("#postingbody");
  bodyEl.find(".print-qrcode-container, .printqrcode").remove();
  const description = bodyEl.text().trim() || undefined;
  const bodyText = description ?? "";

  // ── Address ───────────────────────────────────────────────────────────────
  const address =
    $("div.mapaddress, .postingtitletext .mapaddress").first().text().trim() ||
    undefined;

  // ── Beds / baths / sqft + property type from attr groups ─────────────────
  let bedrooms: number | undefined;
  let bathrooms: number | undefined;
  let squareFeet: number | undefined;
  let propertyType: PropertyType | undefined;

  $("p.attrgroup, .attrgroup").each((_, group) => {
    $(group)
      .find("span")
      .each((_, span) => {
        const txt = $(span).text().toLowerCase();
        const {
          bedrooms: b,
          bathrooms: ba,
          squareFeet: s,
        } = extractBedsBathsSqft(txt);
        if (b && !bedrooms) bedrooms = b;
        if (ba && !bathrooms) bathrooms = ba;
        if (s && !squareFeet) squareFeet = s;

        // Craigslist sometimes puts property type in the attrs, e.g. "housing type: single-family"
        if (!propertyType) propertyType = detectPropertyType(txt);
      });
  });

  // Fallback: derive property type from the full title + description
  if (!propertyType) {
    const fullText = `${$(".postingtitletext").text()} ${bodyText}`;
    propertyType = detectPropertyType(fullText);
  }

  // ── Owner contact ─────────────────────────────────────────────────────────
  // Phone: scan the full posting body (some sellers paste their number in)
  const ownerPhone = extractPhone(bodyText);

  // Name: best-effort from attrgroups or "contact [Name]" patterns in body
  const ownerName = extractOwnerName($, bodyText);

  if (ownerPhone) logger.debug(`[cl-parser] Found phone: ${ownerPhone}`);
  if (ownerName) logger.debug(`[cl-parser] Found owner: ${ownerName}`);

  return {
    description,
    address,
    bedrooms,
    bathrooms,
    squareFeet,
    propertyType,
    ownerName,
    ownerPhone,
  };
}
