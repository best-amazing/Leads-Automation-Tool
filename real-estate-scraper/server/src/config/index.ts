// src/config/index.ts

function urlListFromEnv(envVar: string, defaults: string[]): string[] {
  const raw = (process.env[envVar] ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  return raw.length > 0 ? raw : defaults;
}

export const config = {

  // ── Browser ───────────────────────────────────────────────────────────────
  browser: {
    headless:   true,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport:   { width: 1440, height: 900 },
    locale:     "en-US",
    timezoneId: "America/New_York",
    extraHeaders: {
      "Accept-Language":           "en-US,en;q=0.9",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      Connection:                  "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest":            "document",
      "Sec-Fetch-Mode":            "navigate",
      "Sec-Fetch-Site":            "none",
      "Sec-Fetch-User":            "?1",
    },
    useStealth: true,
  },

  // ── Proxy ─────────────────────────────────────────────────────────────────
  // Single proxy (legacy, overrides PROXY_URLS if set)
  proxyUrl: process.env.PROXY_URL || null,
  
  // Multiple proxies for rotation (comma-separated)
  proxyUrls: urlListFromEnv("PROXY_URLS", []),

  // ── Global scraping limits ────────────────────────────────────────────────
  maxPages:     Number(process.env.MAX_PAGES        ?? 10),
  maxListings:  Number(process.env.MAX_LISTINGS     ?? 10000),
  requestDelay: Number(process.env.REQUEST_DELAY_MS ?? 2_000),

  // ── Filtering criteria ────────────────────────────────────────────────────
  filter: {
  minPrice: 50_000,
  maxPrice: 300_000,
  allowedPropertyTypes: [
    "single_family",
    "multi_family",
    "duplex",
  ] as string[],
  keywords: [
    "single family", "single-family", "single family home",
    "investment", "rental", "duplex", "multi-family", "multifamily",
    // ── LoopNet-specific terms ──
    "apartment", "unit", "units", "plex", "for sale",
    "residential", "income", "cash flow", "cap rate",
  ],
  propertyTypeTokens: [
    "single family", "single-family", "sfh", "duplex",
    "multi-family", "multifamily",
    // ── LoopNet-specific tokens ──
    "apartment", "unit", "units", "triplex", "fourplex",
    "quadplex", "mixed use", "mixed-use",
  ],
  allowedLocations: [
    "ohio", "oh", "cleveland", "columbus", "toledo",
    "milwaukee", "wisconsin", "wi",
    // ── Add common OH/WI cities that appear in LoopNet addresses ──
    "cincinnati", "akron", "dayton",
  ],
},

  // ── Sources ───────────────────────────────────────────────────────────────
  sources: {

    propwire: {
      markets: [
        { name: "Columbus, OH",  state: "OH", stateName: "Ohio",      city: "Columbus"  },
        { name: "Cleveland, OH", state: "OH", stateName: "Ohio",      city: "Cleveland" },
        { name: "Toledo, OH",    state: "OH", stateName: "Ohio",      city: "Toledo"    },
        { name: "Milwaukee, WI", state: "WI", stateName: "Wisconsin", city: "Milwaukee" },
      ] as Array<{ name: string; state: string; stateName: string; city?: string }>,

      // ── Off-market lead types ────────────────────────────────────────────
      //
      // Default targets all five off-market signals. Override at runtime:
      //   PROPWIRE_LEAD_TYPES=preforeclosure,absentee_owner
      //
      // Available values:
      //   preforeclosure  — owner behind on mortgage / lis pendens filed
      //   absentee_owner  — owner lives elsewhere (landlord or vacant)
      //   vacant_home     — confirmed vacant / utility shutoff signals
      //   high_equity     — estimated LTV < ~50% (motivated cash-out candidates)
      //   free_and_clear  — no mortgage on record
      //   for_sale        — MLS active (maps to mls_active; not off-market)
      leadTypes: [
        "preforeclosure",
        "absentee_owner",
        "vacant_home",
        "high_equity",
        "free_and_clear",
      ] as string[],

      maxPages:      Number(process.env.PROPWIRE_MAX_PAGES    ?? 10),
      detailLimit:   Number(process.env.PROPWIRE_DETAIL_LIMIT ?? 20),
    },

    craigslist: {
      milwaukee: "https://milwaukee.craigslist.org/search/rea",
      columbus:  "https://columbus.craigslist.org/search/rea",
      cleveland: "https://cleveland.craigslist.org/search/rea",
      toledo:    "https://toledo.craigslist.org/search/rea",
    },

    zillow: {
      markets: [
        {
          name:        "Ohio - Pre-Foreclosure",
          baseUrl:     "https://www.zillow.com/oh/",
          listingType: "pre_foreclosure" as const,
        },
        {
          name:        "Ohio - Foreclosure (REO)",
          baseUrl:     "https://www.zillow.com/oh/",
          listingType: "foreclosure" as const,
        },
        {
          name:        "Wisconsin - Pre-Foreclosure",
          baseUrl:     "https://www.zillow.com/wi/",
          listingType: "pre_foreclosure" as const,
        },
        {
          name:        "Wisconsin - Foreclosure (REO)",
          baseUrl:     "https://www.zillow.com/wi/",
          listingType: "foreclosure" as const,
        },
        {
          name:        "Indiana - Pre-Foreclosure",
          baseUrl:     "https://www.zillow.com/in/",
          listingType: "pre_foreclosure" as const,
        },
        {
          name:        "Indiana - Foreclosure (REO)",
          baseUrl:     "https://www.zillow.com/in/",
          listingType: "foreclosure" as const,
        },
        {
          name:        "Iowa - Pre-Foreclosure",
          baseUrl:     "https://www.zillow.com/ia/",
          listingType: "pre_foreclosure" as const,
        },
        {
          name:        "Iowa - Foreclosure (REO)",
          baseUrl:     "https://www.zillow.com/ia/",
          listingType: "foreclosure" as const,
        },
        {
          name:        "Illinois - Pre-Foreclosure",
          baseUrl:     "https://www.zillow.com/il/",
          listingType: "pre_foreclosure" as const,
        },
        {
          name:        "Illinois - Foreclosure (REO)",
          baseUrl:     "https://www.zillow.com/il/",
          listingType: "foreclosure" as const,
        },
      ] as Array<{
        name:        string;
        baseUrl:     string;
        listingType: "pre_foreclosure" | "foreclosure";
      }>,

      maxPagesPerMarket: Number(process.env.ZILLOW_MAX_PAGES    ?? 20),
      detailFetchLimit:  Number(process.env.ZILLOW_DETAIL_LIMIT ?? 0),
    },

    realtor: {
      searchUrls: urlListFromEnv("REALTOR_SEARCH_URLS", [
        "https://www.realtor.com/realestateandhomes-search/Columbus_OH/?price_max=300000&type=single_family,multi_family",
        "https://www.realtor.com/realestateandhomes-search/Cleveland_OH/?price_max=300000&type=single_family,multi_family",
        "https://www.realtor.com/realestateandhomes-search/Toledo_OH/?price_max=300000&type=single_family,multi_family",
        "https://www.realtor.com/realestateandhomes-search/Milwaukee_WI/?price_max=300000&type=single_family,multi_family",
      ]),
      maxPagesPerUrl:   Number(process.env.REALTOR_MAX_PAGES    ?? 10),
      detailFetchLimit: Number(process.env.REALTOR_DETAIL_LIMIT ?? 50),
    },

    redfin: {
      markets: [
        { name: "Cleveland, OH",  regionId: 4145,  regionType: 6 },
        { name: "Columbus, OH",   regionId: 4664,  regionType: 6 },
        { name: "Toledo, OH",     regionId: 19458, regionType: 6 },
        { name: "Milwaukee, WI",  regionId: 35759, regionType: 6 },
      ] as Array<{ name: string; regionId: number; regionType: number }>,

      uipt: [1, 4] as number[],

      pageSize:          Number(process.env.REDFIN_PAGE_SIZE    ?? 50),
      maxPagesPerMarket: Number(process.env.REDFIN_MAX_PAGES    ?? 5),
      detailFetchLimit:  Number(process.env.REDFIN_DETAIL_LIMIT ?? 10000),
    },

    crexi: {
      searchUrls: urlListFromEnv("CREXI_SEARCH_URLS", [
        "https://www.crexi.com/properties/OH/Multifamily",
        "https://www.crexi.com/properties/OH/Columbus_",
        "https://www.crexi.com/properties/OH/Cleveland",
        "https://www.crexi.com/properties/OH/Toledo",
        "https://www.crexi.com/properties/WI/Milwaukee",
        "https://www.crexi.com/properties/WI/Multifamily",
      ]),
    },

    loopnet: {
      searchUrls: urlListFromEnv("LOOPNET_SEARCH_URLS", [
        "https://www.loopnet.com/search/multifamily-properties/oh/for-sale/",
        "https://www.loopnet.com/search/apartment-buildings/oh/for-sale/",
        "https://www.loopnet.com/search/multifamily-properties/columbus-oh/for-sale/",
        "https://www.loopnet.com/search/multifamily-properties/cleveland-oh/for-sale/",
        "https://www.loopnet.com/search/multifamily-properties/toledo-oh/for-sale/",
        "https://www.loopnet.com/search/multifamily-properties/milwaukee-wi/for-sale/",
        "https://www.loopnet.com/search/apartment-buildings/wi/for-sale/",
      ]),
      maxPagesPerUrl: Number(process.env.LOOPNET_MAX_PAGES ?? 3),
    },

    creativelisting: {
      markets: [
        { name: "Ohio",      stateAbbr: "OH" },
        { name: "Wisconsin", stateAbbr: "WI" },
      ] as Array<{ name: string; stateAbbr: string }>,

      // Set to 0 to skip detail page fetches (faster, uses fewer Oxylabs credits).
      // Increase if listing cards lack bedrooms/sqft data.
      detailFetchLimit: Number(process.env.CL_DETAIL_LIMIT ?? 0),
    },

  },
};

// Apply a saved filter (from the database) into the runtime config.filter
// This avoids importing the DB client into the config module and keeps
// the config initialization explicit and testable.
export function applySavedFilter(saved?: Partial<typeof config.filter> | null) {
  if (!saved) return;

  // Only overwrite fields that are actually present on the saved filter
  if (typeof saved.minPrice === 'number') config.filter.minPrice = saved.minPrice;
  if (typeof saved.maxPrice === 'number') config.filter.maxPrice = saved.maxPrice;

  if (Array.isArray(saved.allowedPropertyTypes) && saved.allowedPropertyTypes.length > 0) {
    config.filter.allowedPropertyTypes = saved.allowedPropertyTypes.slice();
  }

  if (Array.isArray(saved.keywords) && saved.keywords.length > 0) {
    config.filter.keywords = saved.keywords.slice();
  }

  if (Array.isArray(saved.propertyTypeTokens) && saved.propertyTypeTokens.length > 0) {
    config.filter.propertyTypeTokens = saved.propertyTypeTokens.slice();
  }

  if (Array.isArray(saved.allowedLocations) && saved.allowedLocations.length > 0) {
    config.filter.allowedLocations = saved.allowedLocations.slice();
  }
}

export type Config = typeof config;