// src/scrapers/facebook/facebook.parser.ts

import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import { RawListing, PropertyType } from "../../types/listing";
import { logger } from "../../utils/logger";

// ── Helpers ────────────────────────────────────────────────────────────────

function extractPrice(text: string): number | undefined {
  // Match $67,000 style — but require the number NOT be immediately preceded
  // by digits (prevents zip codes like 43615 being swallowed into the match).
  const m =
    text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*[Kk]\b/) ||
    text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*[Mm]\b/) ||
    text.match(/(?<!\d)\$\s*([\d,]+)(?!\d)/);

  if (!m) return undefined;
  let val = parseFloat(m[1].replace(/,/g, ""));
  const raw    = m[0];
  const suffix = raw[raw.length - 1]?.toLowerCase();
  if (suffix === "k") val *= 1000;
  if (suffix === "m") val *= 1_000_000;
  return Math.round(val);
}

function extractBedsBaths(text: string): { bedrooms?: number; bathrooms?: number } {
  const beds      = text.match(/(\d+)\s*(?:bd|bed|br|bedroom)/i);
  const baths     = text.match(/(\d+(?:\.\d+)?)\s*(?:ba|bath|bathroom)/i);
  // Shorthand "3/2" only if followed by br/ba/bed/bath — avoids matching zip
  // codes and other numeric pairs.
  const shorthand = text.match(/\b(\d)\s*\/\s*(\d(?:\.\d+)?)\s*(?:br|ba|bed|bath)\b/i);
  return {
    bedrooms:  beds  ? parseInt(beds[1], 10)      : shorthand ? parseInt(shorthand[1], 10)  : undefined,
    bathrooms: baths ? parseFloat(baths[1])       : shorthand ? parseFloat(shorthand[2])    : undefined,
  };
}

function extractSqft(text: string): number | undefined {
  const m = text.match(/([\d,]+)\s*(?:sqft|sq\.?\s*ft|sf|square\s*feet)/i);
  return m ? parseInt(m[1].replace(/,/g, ""), 10) : undefined;
}

function detectPropertyType(text: string): PropertyType {
  const t = text.toLowerCase();
  if (t.includes("single family") || t.includes("sfh") || t.includes("single-family")) return "single_family";
  if (t.includes("duplex"))                                                               return "duplex";
  if (t.includes("multi") || t.includes("triplex") || t.includes("fourplex") || t.includes("4plex")) return "multi_family";
  if (t.includes("condo"))                                                                return "condo";
  if (t.includes("townhome") || t.includes("townhouse"))                                 return "townhouse";
  return "unknown";
}

function extractPhone(text: string): string | undefined {
  const m = text.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
  return m ? m[0].trim() : undefined;
}

function extractAddress(text: string): string | undefined {
  // Full address with zip
  const fullAddr = text.match(
    /\d+\s+[A-Z][a-zA-Z\s]+(?:St|Ave|Blvd|Dr|Rd|Ln|Way|Ct|Pl|Circle|Court|Place|Drive|Street|Avenue)\b[^,\n]*,?\s*[A-Z][a-zA-Z\s]+,\s*[A-Z]{2}\s*\d{5}/i
  );
  if (fullAddr) return fullAddr[0].trim();

  // Street address without zip
  const streetAddr = text.match(
    /\d+\s+[A-Z][a-zA-Z\s]+(?:St|Ave|Blvd|Dr|Rd|Ln|Way|Ct|Pl|Circle|Court|Place|Drive|Street|Avenue)\b[^,\n]*/i
  );
  if (streetAddr) return streetAddr[0].trim();

  // City, State
  const cityState = text.match(/[A-Z][a-zA-Z\s]+,\s*(?:OH|WI|Ohio|Wisconsin)\b/);
  return cityState ? cityState[0].trim() : undefined;
}

// Extract a location string (city/state) even when there's no full address
function extractLocation(text: string): string | undefined {
  const patterns = [
    // "Cleveland, OH" / "Milwaukee, WI"
    /\b(Cleveland|Columbus|Toledo|Akron|Dayton|Cincinnati|Youngstown|Canton|Milwaukee|Madison)[,\s]+(?:OH|WI|Ohio|Wisconsin)\b/i,
    // Standalone city names we care about
    /\b(Cleveland|Columbus|Toledo|Akron|Dayton|Cincinnati|Youngstown|Canton|Milwaukee|Madison)\b/i,
    // State only
    /\b(Ohio|Wisconsin)\b/i,
    /\b(OH|WI)\b/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[0].trim();
  }
  return undefined;
}

// ── Stable dedup key ───────────────────────────────────────────────────────

/**
 * Produces a timestamp-agnostic fingerprint for a post's text so that the
 * same listing cross-posted to multiple groups (where relative timestamps like
 * "14m", "22m", "2d" differ) is still recognised as a duplicate.
 */
export function stableKey(text: string): string {
  return text
    // Strip relative timestamps: "14m ·", "2d ·", "3h", "1 week ago", etc.
    .replace(/\b\d+\s*(?:m|h|d|w|min|hr|hour|day|week)s?\b\s*·?\s*/gi, "")
    // Strip "Shared with Public group" boilerplate
    .replace(/shared with public group/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

// ── Noise detection ────────────────────────────────────────────────────────

const SIDEBAR_NOISE_PATTERNS = [
  /private group/i,
  /only members can see who's in the group/i,
  /anyone can find this group/i,
  /group created on/i,
  /about this group/i,
  /buy and sell/i,
  /join group/i,
  /\d+(\.\d+)?[KkMm]?\s*members/i,
];

function isSidebarNoise(text: string): boolean {
  const hits = SIDEBAR_NOISE_PATTERNS.filter((p) => p.test(text)).length;
  return hits >= 3;
}

function isRelevantPost(text: string): boolean {
  const lower = text.toLowerCase();

  const investmentKeywords = [
    "seller financ", "owner financ", "for sale", "asking", "arv",
    "investment", "rental", "cash flow", "flip", "wholesale", "deal",
    "single family", "sfh", "duplex", "multi", "buy", "property",
    "motivated seller", "off market", "off-market",
    "bed", "bath", "sqft", "sq ft", "bedroom", "house", "home",
    "price", "reduced", "contract", "closing", "rehab", "distressed",
    "fixer", "turnkey", "turn key", "reo", "foreclos", "lease option",
    "infill", "lot", "land",
  ];

  const locationKeywords = [
    "ohio", " oh ", "oh,", "cleveland", "columbus", "toledo",
    "akron", "dayton", "cincinnati", "youngstown", "canton",
    "milwaukee", "wisconsin", " wi ", "wi,", "madison",
  ];

  const hasInvestment = investmentKeywords.some((k) => lower.includes(k));
  const hasLocation   = locationKeywords.some((k) => lower.includes(k));
  return hasInvestment || hasLocation;
}

function stripNoise(text: string): string {
  const patterns = [
    /log\s*in\s*or\s*sign\s*up/gi,
    /you must log in to continue/gi,
    /sign up for facebook/gi,
    /create a new account/gi,
    /log into facebook/gi,
    /forgot (?:password|account)\?/gi,
    /by clicking .+, you agree to/gi,
    /see more of .+ on facebook/gi,
    /not now/gi,
  ];
  let cleaned = text;
  for (const p of patterns) cleaned = cleaned.replace(p, " ");
  return cleaned.replace(/\s{2,}/g, " ").trim();
}

function isModalElement($el: cheerio.Cheerio<any>, $: cheerio.CheerioAPI): boolean {
  const role      = $el.attr("role");
  const ariaModal = $el.attr("aria-modal");
  if (role === "dialog" || ariaModal === "true") return true;

  const testId = $el.attr("data-testid") ?? "";
  if (testId.includes("login") || testId.includes("signup")) return true;

  const text = $el.text().toLowerCase();
  const modalPhrases = [
    "log in or sign up", "you must log in",
    "sign up for facebook", "log into facebook", "create a new account",
  ];
  return modalPhrases.filter((p) => text.includes(p)).length >= 2;
}

// ── Debug dump ─────────────────────────────────────────────────────────────

function saveCandidateDebug(
  candidates: Array<{ text: string; len: number; relevant: boolean; sidebar: boolean }>
) {
  try {
    const dir = path.resolve("logs");
    fs.mkdirSync(dir, { recursive: true });
    const lines = candidates.map((c, i) =>
      [
        `\n${"─".repeat(60)}`,
        `CANDIDATE #${i + 1} | len:${c.len} | relevant:${c.relevant} | sidebar:${c.sidebar}`,
        `${"─".repeat(60)}`,
        c.text.slice(0, 500),
      ].join("\n")
    );
    fs.writeFileSync(
      path.join(dir, "facebook_candidates_debug.txt"),
      lines.join("\n")
    );
  } catch {}
}

// ── Main parser ────────────────────────────────────────────────────────────

export function parseFacebookGroupPosts(
  html: string,
  groupUrl: string,
  source: string
): RawListing[] {
  const $ = cheerio.load(html);
  const results: RawListing[] = [];

  // Remove overlay/modal elements from the DOM entirely
  $("[role='dialog'], [aria-modal='true']").remove();
  $("[data-testid='login_dialog'], [data-testid='signup-dialog']").remove();

  // ── Strategy 1: role=article (Facebook's own semantic markup — most reliable)
  let posts = $("[role='article']");
  
  // Filter out comments (which are articles nested inside another article)
  posts = posts.filter((_, el) => $(el).parents("[role='article']").length === 0);
  
  logger.info(`[fb-parser] role=article count: ${posts.length}`);

  // ── Strategy 2: data-pagelet feed children
  if (posts.length === 0) {
    posts = $(
      "[data-pagelet='GroupFeed'] > div, [data-pagelet='GroupDiscussionFeed'] > div"
    );
    logger.info(`[fb-parser] data-pagelet children count: ${posts.length}`);
  }

  // ── Strategy 3: role=feed direct children
  if (posts.length === 0) {
    posts = $("[role='feed'] > div");
    logger.info(`[fb-parser] role=feed > div count: ${posts.length}`);
  }

  // ── Broad fallback: sized divs that aren't sidebar/modal
  if (posts.length === 0) {
    logger.warn("[fb-parser] No structured posts found — using broad fallback");
    posts = $("div").filter((_, el) => {
      const $el = $(el);
      if (isModalElement($el, $)) return false;
      const text = $el.text().trim();
      if (isSidebarNoise(text)) return false;
      return text.length > 150 && text.length < 6000;
    });
  }

  logger.info(`[fb-parser] ${posts.length} post candidates after selector pass`);

  const debugCandidates: Array<{
    text: string;
    len: number;
    relevant: boolean;
    sidebar: boolean;
  }> = [];

  const seen = new Set<string>();

  posts.each((_, el) => {
    const post = $(el);
    if (isModalElement(post, $)) return;

    const rawText = post.text().trim();
    const text    = stripNoise(rawText);

    const sidebar  = isSidebarNoise(text);
    const relevant = !sidebar && isRelevantPost(text);

    if (debugCandidates.length < 25) {
      debugCandidates.push({ text, len: text.length, relevant, sidebar });
    }

    if (sidebar) return;
    if (text.length < 50) return;
    if (!relevant) return;

    // Use stable key so posts with different relative timestamps ("14m" vs
    // "22m") from the same content are treated as duplicates within a page.
    const textKey = stableKey(text);
    if (seen.has(textKey)) return;
    seen.add(textKey);

    // ── Post URL ───────────────────────────────────────────────
    const postLinkEl = post
      .find("a[href*='/posts/'], a[href*='/permalink/'], a[href*='/groups/'][href*='/posts/']")
      .first();
    const rawHref = postLinkEl.attr("href") ?? "";
    const url = rawHref.startsWith("http")
      ? rawHref
      : rawHref
      ? `https://www.facebook.com${rawHref}`
      : `${groupUrl}#post-${seen.size}`;

    // ── Extract fields ─────────────────────────────────────────
    const price                   = extractPrice(text);
    const { bedrooms, bathrooms } = extractBedsBaths(text);
    const squareFeet              = extractSqft(text);
    const address                 = extractAddress(text);
    const location                = address ?? extractLocation(text);
    const propertyType            = detectPropertyType(text);
    const ownerPhone              = extractPhone(text);

    const nameEl    = post.find("h2, h3, strong, b, [role='heading']").first();
    const ownerName = nameEl.text().trim() || undefined;

    // ── Acceptance criteria (relaxed) ──────────────────────────
    // Accept the post if it has ANY TWO of: price, known property type,
    // address/location. This lets through posts like "Off-Market Lot –
    // Cleveland, OH" (no price yet) and "duplex, $250k" (no address).
    const signals = [
      price !== undefined,
      propertyType !== "unknown",
      location !== undefined,
    ].filter(Boolean).length;

    if (signals < 1) return; // need at least one meaningful signal

    results.push({
      url,
      source,
      title:       text.slice(0, 120).replace(/\s+/g, " ").trim(),
      price,
      address,
      location,
      propertyType,
      bedrooms,
      bathrooms,
      squareFeet,
      description: text.slice(0, 2000),
      ownerName,
      ownerPhone,
    });
  });

  saveCandidateDebug(debugCandidates);
  logger.info(`[fb-parser] ${results.length} listings extracted from ${groupUrl}`);
  return results;
}