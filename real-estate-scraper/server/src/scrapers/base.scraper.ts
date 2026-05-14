// src/scrapers/base.scraper.ts
// ─────────────────────────────────────────────────────────────────────────────
// Every scraper extends this class.
// The runner only ever calls `scraper.run()` — it doesn't care which site
// is being scraped.  All storage is handled by the runner, not the scraper.
// ─────────────────────────────────────────────────────────────────────────────

import { RawListing, PropertyType } from "../types/listing";
import { config } from "../config";
import { logger } from "../utils/logger";
import { BrowserHandle, createBrowser, sleep, jitter } from "../utils/browser";
import * as fs from "fs";
import * as path from "path";

export interface ScraperOptions {
  maxPages?: number;
  maxListings?: number;
  /** Override the global proxy for this specific scraper */
  proxyUrl?: string | null;
}

export abstract class BaseScraper {
  /** Human-readable identifier stored in the `source` DB column */
  abstract readonly sourceName: string;

  protected options: Required<ScraperOptions>;
  protected visited = new Set<string>();
  protected results: RawListing[] = [];

  constructor(options: ScraperOptions = {}) {
    this.options = {
      maxPages: options.maxPages ?? config.maxPages,
      maxListings: options.maxListings ?? config.maxListings,
      proxyUrl: options.proxyUrl !== undefined ? options.proxyUrl : null,
    };
  }

  // ── Abstract interface (implement in each scraper) ─────────────────────────

  /**
   * Scrape one page and return raw listings found on it.
   * The base class handles pagination, dedup, and limits.
   */
  protected abstract scrapePage(
    handle: BrowserHandle,
    pageNumber: number,
  ): Promise<RawListing[]>;

  /**
   * Return true if there are more pages to fetch.
   * Default: stop when scrapePage returns an empty array.
   */
  protected hasMorePages(
    _pageNumber: number,
    lastPageResults: RawListing[],
  ): boolean {
    return lastPageResults.length > 0;
  }

  // ── Filtering helpers (available to all scrapers) ─────────────────────────

  protected isRelevant(listing: RawListing): boolean {
    const text =
      `${listing.title ?? ""} ${listing.address ?? ""} ${listing.description ?? ""}`.toLowerCase();
    return (
      config.filter.keywords.some((k) => text.includes(k)) ||
      config.filter.propertyTypeTokens.some((t) => text.includes(t))
    );
  }

  protected passesFilter(listing: RawListing): boolean {
    if (!listing.price) return false;
    if (listing.price < config.filter.minPrice) return false;
    if (listing.price > config.filter.maxPrice) return false;
    // Location filtering: match parsed `address` / `location` against allowed tokens
    const locText =
      `${listing.address ?? ""} ${listing.location ?? ""}`.toLowerCase();
    const allowed = (config.filter.allowedLocations ?? []).map((s) =>
      s.toLowerCase(),
    );

    // Match tokens carefully: short tokens (state abbreviations like "wi", "oh")
    // must match as whole words to avoid false positives (e.g. "Windcrest").
    const matchToken = (token: string): boolean => {
      const t = token.trim();
      if (t.length === 0) return false;
      if (t.length <= 2) {
        try {
          const re = new RegExp(
            "\\b" + t.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&") + "\\b",
            "i",
          );
          return re.test(locText);
        } catch {
          return locText.includes(t);
        }
      }
      return locText.includes(t);
    };

    if (allowed.length > 0 && !allowed.some((token) => matchToken(token))) {
      logger.debug(
        `[${this.sourceName}] ✗ Location filtered: ${listing.address ?? listing.location ?? listing.title}`,
      );
      return false;
    }

    return true;
  }

  protected normalizePropertyType(raw: string | undefined): PropertyType {
    if (!raw) return "unknown";
    const t = raw.toLowerCase();
    if (t.includes("single") || t.includes("sfh")) return "single_family";
    if (t.includes("multi") || t.includes("duplex")) return "multi_family";
    if (t.includes("condo")) return "condo";
    if (t.includes("town")) return "townhouse";
    return "unknown";
  }

  // ── Main run loop ─────────────────────────────────────────────────────────

  /**
   * Execute the full scrape run.
   * Returns all accepted listings — the runner saves them to the DB.
   */
  async run(): Promise<RawListing[]> {
    logger.info(`[${this.sourceName}] Starting scrape`);
    this.visited.clear();
    this.results = [];
    const rejected: Array<{ listing: RawListing; reason: string }> = [];

    const handle = await createBrowser(this.options.proxyUrl);

    try {
      for (let page = 1; page <= this.options.maxPages; page++) {
        if (this.results.length >= this.options.maxListings) {
          logger.info(
            `[${this.sourceName}] Reached ${this.options.maxListings} listings — stopping`,
          );
          break;
        }

        logger.info(`[${this.sourceName}] Scraping page ${page}`);

        let pageListings: RawListing[] = [];
        try {
          pageListings = await this.scrapePage(handle, page);
        } catch (err) {
          logger.error(`[${this.sourceName}] Page ${page} failed: ${err}`);
          continue;
        }

        logger.info(
          `[${this.sourceName}] Page ${page}: ${pageListings.length} raw listings`,
        );

        for (const listing of pageListings) {
          if (this.results.length >= this.options.maxListings) break;

          if (!listing.url) {
            rejected.push({ listing, reason: "no_url" });
            continue;
          }

          if (this.visited.has(listing.url)) {
            rejected.push({ listing, reason: "already_seen" });
            continue;
          }

          if (!this.passesFilter(listing)) {
            rejected.push({ listing, reason: "filtered" });
            logger.debug(
              `[${this.sourceName}] ✗ Price/Location filtered: ${listing.address} @ ${listing.price}`,
            );
            continue;
          }

          if (!this.isRelevant(listing)) {
            rejected.push({ listing, reason: "not_relevant" });
            logger.debug(
              `[${this.sourceName}] ✗ Not relevant: ${listing.title}`,
            );
            continue;
          }

          this.visited.add(listing.url);
          this.results.push(listing);
          logger.info(
            `[${this.sourceName}] ✓ [${this.results.length}/${this.options.maxListings}] ` +
              `${listing.address ?? listing.title} @ $${listing.price?.toLocaleString()}`,
          );
        }

        if (!this.hasMorePages(page, pageListings)) {
          logger.info(`[${this.sourceName}] No more pages`);
          break;
        }

        await sleep(jitter(config.requestDelay));
      }
    } finally {
      await handle.close();
    }

    logger.info(
      `[${this.sourceName}] Finished — ${this.results.length} listings collected`,
    );
    // Write JSON output for this run: accepted + rejected
    try {
      const outDir = path.join(process.cwd(), "logs");
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      const outPath = path.join(outDir, `${this.sourceName}.json`);
      const payload = {
        accepted: this.results,
        rejected,
        generatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");
      logger.info(`[${this.sourceName}] Wrote results to ${outPath}`);
    } catch (err) {
      logger.error(`[${this.sourceName}] Failed to write results JSON: ${err}`);
    }

    return this.results;
  }
}
