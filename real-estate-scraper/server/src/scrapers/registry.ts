// src/scrapers/registry.ts
// ─────────────────────────────────────────────────────────────────────────────
// To add a new scraping source:
//   1. Create src/scrapers/<site>/<site>.scraper.ts extending BaseScraper
//   2. Import it here and add an entry to SCRAPER_REGISTRY
//   3. Run: ts-node index.ts --source <key>
// That's it — storage, filtering, dedup are all handled automatically.
// ─────────────────────────────────────────────────────────────────────────────

import { BaseScraper } from "./base.scraper";
import { CraigslistScraper } from "./craigslist/craigslist.scraper";
import { ZillowScraper } from "./zillow/zillow.scraper";
import { InvestorLiftScraper } from "./investorlift/investorlift.scraper";
import { OffmarketScraper } from "./offmarket/offmarket.scraper";
import { MarketplaceScraper } from "./marketplace/marketplace.scraper";
import { FacebookScraper } from "./facebook/facebook.scraper";
import { CrexiScraper } from "./crexi/crexi.scraper";
import { LoopNetScraper } from "./loopnet/loopnet.scraper";
import { CreativeListingScraper } from "./creative-listing/creative-listing.scraper";
import { RealtorScraper } from "./realtor/realtor.scraper";
import { RedfinScraper } from "./redfin/redfin.scraper";
import { PropwireScraper } from "./propwire/propwire.scraper";
import { config } from "../config";

/** Each entry returns a ready-to-run BaseScraper instance */
export type ScraperFactory = () => BaseScraper;

export const SCRAPER_REGISTRY: Record<string, ScraperFactory> = {
  // Facebook marketplace is technically part of Facebook, but we treat it as a separate source since the listings are different and more structured
  facebook_marketplace: () => new MarketplaceScraper(),

  // ── Facebook ───────────────────────────────────────────────────────────────
  facebook: () => new FacebookScraper(),
  
  // ── Offmarket (uses proxy) ────────────────────────────────────────────────
  offmarket: () => new OffmarketScraper({ proxyUrl: config.proxyUrl }),

  // ── InvestorLift (highest priority per project doc §3.1) ─────────────────
  investorlift: () => new InvestorLiftScraper({ headless: process.env.INVESTORLIFT_HEADLESS !== "false" }),

  // ── Crexi ─────────────────────────────────────────────────────────────────
  crexi: () => new CrexiScraper(),

  // CreativeListing (creative-finance marketplace, uses proxy)
  creativelisting: () => new CreativeListingScraper({ proxyUrl: config.proxyUrl }),
  // Accept hyphenated variant from frontend: "creative-listing"
  "creative-listing": () => new CreativeListingScraper({ proxyUrl: config.proxyUrl }),

  // ── LoopNet ───────────────────────────────────────────────────────────────
  loopnet: () => new LoopNetScraper(),

  // ── Craigslist cities (use proxy) ─────────────────────────────────────────
  craigslist_milwaukee: () =>
    new CraigslistScraper(config.sources.craigslist.milwaukee, { proxyUrl: config.proxyUrl }),

  craigslist_columbus: () =>
    new CraigslistScraper(config.sources.craigslist.columbus, { proxyUrl: config.proxyUrl }),

  craigslist_cleveland: () =>
    new CraigslistScraper(config.sources.craigslist.cleveland, { proxyUrl: config.proxyUrl }),

  craigslist_toledo: () =>
    new CraigslistScraper(config.sources.craigslist.toledo, { proxyUrl: config.proxyUrl }),

  // ── Zillow ────────────────────────────────────────────────────────────────
  zillow: () => new ZillowScraper(),

  // ── Realtor.com ───────────────────────────────────────────────────────────
  realtor: () => new RealtorScraper(),

  // ── Redfin ────────────────────────────────────────────────────────────────
  redfin: () => new RedfinScraper(),

  // ── Propwire ─────────────────────────────────────────────────────────────
  propwire: () => new PropwireScraper()
};

// ── Source group aliases ──────────────────────────────────────────────────────

const ALIASES: Record<string, string[]> = {
  // "craigslist" runs all CL cities at once
  craigslist: Object.keys(SCRAPER_REGISTRY).filter((k) =>
    k.startsWith("craigslist_"),
  ),
  // "all" runs every registered scraper
  all: Object.keys(SCRAPER_REGISTRY),
};

/** Expand a source name or alias into concrete registry keys */
export function resolveSourceKeys(source: string): string[] {
  if (ALIASES[source]) return ALIASES[source];

  if (!SCRAPER_REGISTRY[source]) {
    const available = [
      ...Object.keys(SCRAPER_REGISTRY),
      ...Object.keys(ALIASES),
    ].join(", ");
    throw new Error(`Unknown source "${source}". Available: ${available}`);
  }

  return [source];
}
