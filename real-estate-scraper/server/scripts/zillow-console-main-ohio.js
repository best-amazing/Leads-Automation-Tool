// scripts/zillow-console-main-ohio.js — Ohio only (generated from zillow-console-main.js)
// ─────────────────────────────────────────────────────────────────────────────
// Browser-console script: collects listings from Zillow that meet the main
// spreadsheet's criteria ("Eddy Property Research Tool 1"): an ADU keyword in
// the title/description/address plus the property criteria.
//
// Usage:
//   1. Open https://www.zillow.com in a normal browser tab.
//   2. DevTools → Console → paste this whole file → Enter.
//   3. Wait (requests are paced ~2s apart; keywords need each listing's
//      description, so most candidates cost a detail fetch). It's finished
//      when the console prints "[main] Done: N listing(s)". Results print as
//      a table, are copied to the clipboard as CSV, a CSV file is
//      downloaded, and they're kept on window.__mainListings.
//
// Criteria mirror passesPropertyCriteria / ADU_KEYWORDS / STATE_ZIP_PREFIXES
// in src/scrapers/property-purchase-research — keep them in sync. Like the
// scraper, a value the listing doesn't have passes; a listing whose detail
// page can't be read is skipped (its description is needed for keywords).
// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  const TARGET = 200; // total listings to collect
  const MAX_PER_STATE = Infinity; // spread results across states (Infinity = no cap)
  const ONLY_STATES = ["OH"]; // limit a run to these states, e.g. ["OH"] (empty = all)
  const MAX_PAGES = 20; // Zillow serves at most 20 pages (~41 results) per search
  const LOOKBACK_DAYS = 90; // ZILLOW_LOOKBACK_DAYS
  const DELAY_MS = [1500, 3000]; // random pause between requests

  // Priority order and ZIP rules from TARGET_STATES / STATE_ZIP_PREFIXES.
  // null = any ZIP. Remove states here to narrow a run.
  const STATES = [
    ["OH", null], ["IN", ["46"]], ["WI", ["53"]], ["IA", ["50", "52"]],
    ["IL", ["60"]], ["KY", ["40"]], ["MI", ["48", "49"]], ["PA", ["15"]],
    ["MO", ["63", "64"]], ["NE", ["68"]], ["KS", ["66"]], ["TN", ["37"]],
    ["GA", ["30"]],
  ];

  // Same bands as the scraper's Zillow markets (ZILLOW_ADU_PRICE_BANDS)
  const PRICE_BANDS = [[0, 250_000], [250_000, 400_000], [400_000, 600_000]];

  const C = {
    maxPrice: 600_000,
    minBeds: 3,
    minBaths: 2,
    minYearBuilt: 1950,
    newConstructionMinYear: new Date().getFullYear() - 1,
  };

  // ADU_KEYWORDS — order matters: the first match is reported
  const ADU_KEYWORDS = [
    "ADU", "add-on unit", "add on unit", "add on units", "in-law", "in-laws",
    "in law", "in laws", "guest house", "guest home", "guest residence",
    "multi-generational living", "multi generational living",
    "multi-generation", "multi generation", "two homes", "two houses",
    "both homes", "both house", "multiple structures",
    "main residence", "main house", "main home", "second home", "second house",
    "both residence", "multiple house", "multiple home",
    "private entrance", "private studio", "private apartment", "same lot",
    "in one lot", "in one parcel", "carriage house", "carriage home",
  ];
  const KEYWORD_PATTERNS = ADU_KEYWORDS.map((kw) => ({
    kw,
    re: new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
  }));
  const findKeyword = (text) => KEYWORD_PATTERNS.find(({ re }) => re.test(text))?.kw;

  // Zillow-side narrowing: price band + beds/baths + listing-type flags.
  // Everything else is checked client-side below.
  const filterStateFor = ([min, max]) => ({
    price: { ...(min ? { min } : {}), max },
    beds: { min: C.minBeds },
    baths: { min: C.minBaths },
    nc: { value: false }, auc: { value: false },
    fore: { value: false }, cmsn: { value: false },
    sort: { value: "days" },
  });

  // Zillow home types outside "single family or multi-family"
  const EXCLUDED_HOME_TYPES = /^(condo|townhouse|townhome|manufactured|mobile|lot|land|apartment|timeshare|co-?op)/i;
  const PROPERTY_TYPE_TEXT =
    /\b(condo|townhouse|townhome|mobile home|manufactured|mobile|vacant land|bare land|lot only)\b/i;
  const NEW_CONSTRUCTION_RE =
    /\b(new[- ]construction|newly (?:constructed|built)|new[- ]build|to[- ]be[- ]built|under construction|pre[- ]?construction|proposed construction|spec home|est(?:\.|imated)? completion)\b/gi;
  const IMPROVEMENT_RE =
    /^[^.;!]{0,30}?\b(garage|barn|pole barn|shed|deck|porch|patio|addition|fence|driveway|roof|carport|workshop|outbuilding)s?\b/i;

  function newConstructionReason(l) {
    const year = Number(l.yearBuilt);
    if (year > 0) {
      return year >= C.newConstructionMinYear ? `new construction (built ${year})` : null;
    }
    const text = `${l.title ?? ""} ${l.description ?? ""}`;
    for (const m of text.matchAll(NEW_CONSTRUCTION_RE)) {
      if (IMPROVEMENT_RE.test(text.slice(m.index + m[0].length))) continue;
      return `new construction ("${m[0].toLowerCase()}")`;
    }
    return null;
  }

  /** Port of passesPropertyCriteria: first failing reason, or null. */
  function criteriaFailure(l) {
    if (l.price != null && l.price > C.maxPrice) return `price ${l.price}`;
    if (l.beds != null && l.beds < C.minBeds) return `beds ${l.beds}`;
    if (l.baths != null && l.baths < C.minBaths) return `baths ${l.baths}`;
    if (l.yearBuilt != null && l.yearBuilt < C.minYearBuilt) return `built ${l.yearBuilt}`;
    if (EXCLUDED_HOME_TYPES.test(l.homeType ?? "")) return `type ${l.homeType}`;
    const hay = [l.title, l.description, l.address].join(" ").toLowerCase();
    if (PROPERTY_TYPE_TEXT.test(hay)) return "property type";
    if (/\bhoa\b/.test(hay) || /home ?owner'?s? association/.test(hay)) return "HOA";
    if (/55\+|55 and older|active adult|senior community/.test(hay)) return "55+ community";
    const nc = newConstructionReason(l);
    if (nc) return nc;
    if (hay.includes("auction")) return "auction";
    if (hay.includes("foreclosure") || hay.includes("reo ") || hay.includes("bank owned")) return "foreclosure";
    if (hay.includes("short sale")) return "short sale";
    return null;
  }

  /** Up to 200 characters of description around the keyword (sheet preview). */
  function keywordContext(description, kw) {
    if (!description || !kw) return "";
    const i = description.toLowerCase().indexOf(kw.toLowerCase());
    if (i < 0) return description.slice(0, 200).trim();
    return description.slice(Math.max(0, i - 80), i + kw.length + 120).replace(/\s+/g, " ").trim();
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pause = () => sleep(DELAY_MS[0] + Math.random() * (DELAY_MS[1] - DELAY_MS[0]));
  const toLotSqft = (value, unit) =>
    value ? Math.round(/acre/i.test(unit ?? "") ? value * 43560 : value) : undefined;

  class CaptchaError extends Error {}

  async function getHtml(url) {
    const res = await fetch(url, { credentials: "include" });
    const html = await res.text();
    // Real pages mention their bot-protection scripts too, so only a page
    // without Zillow's data payload counts as a captcha.
    if (!html.includes("__NEXT_DATA__") && !html.includes("gdpClientCache") &&
        (res.status === 403 || /captcha|press & hold|access to this page has been denied/i.test(html))) {
      throw new CaptchaError("Zillow showed a captcha — open any Zillow page in this tab, solve it, then re-run.");
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return html;
  }

  const parseDoc = (html) => new DOMParser().parseFromString(html, "text/html");
  function nextData(doc) {
    const el = doc.getElementById("__NEXT_DATA__");
    try { return el ? JSON.parse(el.textContent) : null; } catch { return null; }
  }

  /** Zillow region for a state, read from its own state page. */
  async function resolveRegion(state) {
    const json = nextData(parseDoc(await getHtml(`https://www.zillow.com/${state.toLowerCase()}/`)));
    const info = json?.props?.pageProps?.searchPageState?.regionState?.regionInfo?.[0];
    return info?.regionId ? { regionId: info.regionId, regionType: info.regionType ?? 2 } : null;
  }

  function searchUrl(state, region, band, page) {
    const qs = {
      pagination: page > 1 ? { currentPage: page } : {},
      usersSearchTerm: state,
      regionSelection: [region],
      isMapVisible: false,
      isListVisible: true,
      filterState: filterStateFor(band),
    };
    return `https://www.zillow.com/${state.toLowerCase()}/?searchQueryState=${encodeURIComponent(JSON.stringify(qs))}`;
  }

  /**
   * First string value of `key` in the page — as plain JSON or JSON embedded
   * in a JSON string (one extra level of escaping) — fully unescaped.
   */
  function stringField(html, key) {
    for (const [open, doubleEncoded] of [[`"${key}":"`, false], [`\\"${key}\\":\\"`, true]]) {
      const at = html.indexOf(open);
      if (at < 0) continue;
      let s = "";
      for (let i = at + open.length; i < html.length && s.length < 2_000_000; i++) {
        if (doubleEncoded && html[i] === "\\") i++; // drop the outer escape
        s += html[i];
        // closing quote = one not escaped by an odd run of backslashes
        if (html[i] === '"' && s.slice(0, -1).match(/\\*$/)[0].length % 2 === 0) {
          try { return JSON.parse(`"${s.slice(0, -1)}"`); } catch { return s.slice(0, -1); }
        }
      }
    }
    return undefined;
  }

  /** The `property` object from Zillow's detail-page cache, wherever it sits. */
  function propertyFromPage(doc, html) {
    const props = nextData(doc)?.props?.pageProps;
    const candidates = [
      props?.gdpClientCache,
      props?.componentProps?.gdpClientCache,
      stringField(html, "gdpClientCache"), // cache embedded outside __NEXT_DATA__
    ];
    for (const raw of candidates) {
      try {
        const cache = typeof raw === "string" ? JSON.parse(raw) : raw;
        const p = Object.values(cache ?? {}).find((v) => v?.property)?.property;
        if (p) return { p, description: props?.componentProps?.description };
      } catch {}
    }
    return null;
  }

  /**
   * Detail page → description, year built, HOA, home type. Tries Zillow's
   * property cache first, then the rendered page text. Returns null when no
   * description or facts can be read.
   */
  async function fetchDetail(url) {
    const html = await getHtml(url);
    const doc = parseDoc(html);

    const found = propertyFromPage(doc, html);
    if (found) {
      const { p } = found;
      const hoaRaw = p.monthlyHoaFee ?? p.resoFacts?.hoaFee ?? p.resoFacts?.associationFee;
      const hoaFee = hoaRaw == null ? undefined
        : typeof hoaRaw === "number" ? hoaRaw : Number(String(hoaRaw).replace(/[^\d.]/g, ""));
      return {
        description: found.description ?? p.description ?? "",
        yearBuilt: p.yearBuilt ? Number(p.yearBuilt) : undefined,
        hoaFee: Number.isFinite(hoaFee) ? hoaFee : undefined,
        homeType: p.homeType,
        lotSqft: toLotSqft(p.lotAreaValue, p.lotAreaUnit) ?? (p.lotSize || undefined),
      };
    }

    // Fallback: the server-rendered page text
    const text = doc.body?.innerText || doc.body?.textContent || "";
    const description =
      doc.querySelector('[data-testid="description"]')?.textContent?.trim() ||
      doc.querySelector("article")?.textContent?.trim() ||
      "";
    const year = Number(text.match(/Built in (\d{4})/i)?.[1]);
    const hoa = text.match(/\$([\d,]+)\s*(?:\/mo|monthly)\s*HOA/i)?.[1];
    const lot = text.match(/([\d,.]+)\s*(Acres?|sqft)\s*lot/i);
    if (!description && !year) {
      window.__mainLastFailedDetail = { url, html }; // for debugging the page shape
      return null;
    }
    return {
      description,
      yearBuilt: year || undefined,
      hoaFee: hoa ? Number(hoa.replace(/,/g, "")) : undefined,
      lotSqft: lot ? toLotSqft(Number(lot[1].replace(/,/g, "")), lot[2]) : undefined,
    };
  }

  const found = [];
  const seen = new Set();
  const rejected = {};
  let detailFailures = 0;
  const reject = (reason) => {
    const k = reason.replace(/[\d$,.]+.*$/, "").trim() || reason;
    rejected[k] = (rejected[k] ?? 0) + 1;
  };

  const RUN_STATES = ONLY_STATES.length ? STATES.filter(([abbr]) => ONLY_STATES.includes(abbr)) : STATES;
  console.log(`%c[main] Looking for ${TARGET} listings across ${RUN_STATES.map(([s]) => s).join(", ")}…`, "font-weight:bold");

  run: for (const [state, zipPrefixes] of RUN_STATES) {
    if (found.length >= TARGET) break;
    let region;
    try {
      region = await resolveRegion(state);
    } catch (err) {
      console.error(`[main] ${err.message}`);
      if (err instanceof CaptchaError) break;
      continue;
    }
    await pause();
    if (!region) { console.warn(`[main] ${state}: couldn't resolve Zillow region, skipping`); continue; }

    let stateFound = 0;
    bands: for (const band of PRICE_BANDS) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        let json;
        try {
          json = nextData(parseDoc(await getHtml(searchUrl(state, region, band, page))));
        } catch (err) {
          console.error(`[main] ${err.message}`);
          if (err instanceof CaptchaError) break run;
          break;
        }
        const cat1 = json?.props?.pageProps?.searchPageState?.cat1;
        const results = cat1?.searchResults?.listResults ?? [];
        const totalPages = cat1?.searchList?.totalPages ?? 1;
        const total = cat1?.searchList?.totalResultCount;
        const bandLabel = `$${band[0] / 1000}k–$${band[1] / 1000}k`;
        console.log(`[main] ${state} ${bandLabel} p${page}/${totalPages}${total != null ? ` (${total} total)` : ""}: ${results.length} result(s) — ${found.length}/${TARGET} found`);
        await pause();

        for (const r of results) {
          if (found.length >= TARGET) break run;
          if (stateFound >= MAX_PER_STATE) break bands;
          const info = r.hdpData?.homeInfo ?? {};
          const zpid = String(r.zpid ?? info.zpid ?? r.detailUrl);
          if (seen.has(zpid)) continue;
          seen.add(zpid);

          const listingState = r.addressState ?? info.state;
          const zip = String(r.addressZipcode ?? info.zipcode ?? "");
          if (listingState && listingState !== state) { reject("outside state"); continue; }
          if (zipPrefixes && !zipPrefixes.some((p) => zip.startsWith(p))) { reject("zip"); continue; }
          const sub = info.listing_sub_type ?? {};
          if (sub.is_foreclosure || sub.is_bankOwned || sub.is_forAuction || sub.is_newHome) {
            reject("listing type"); continue;
          }
          const dom = info.daysOnZillow;
          if (typeof dom === "number" && dom > LOOKBACK_DAYS) { reject("older than 90 days"); continue; }

          const listing = {
            zpid,
            address: r.address,
            title: r.address,
            state,
            zip,
            price: info.price ?? r.unformattedPrice,
            beds: info.bedrooms ?? r.beds,
            baths: info.bathrooms ?? r.baths,
            sqft: info.livingArea ?? r.area,
            lotSqft: toLotSqft(info.lotAreaValue, info.lotAreaUnit),
            homeType: info.homeType,
            daysOnZillow: dom,
            url: r.detailUrl?.startsWith("http") ? r.detailUrl : `https://www.zillow.com${r.detailUrl}`,
          };

          // Cheap check on search data before spending a detail fetch
          const pre = criteriaFailure(listing);
          if (pre) { reject(pre); continue; }

          let detail;
          try {
            detail = await fetchDetail(listing.url);
          } catch (err) {
            console.warn(`[main] detail failed (${listing.address}): ${err.message}`);
            if (err instanceof CaptchaError) break run;
            detailFailures++;
            reject("detail unavailable");
            continue;
          } finally {
            await pause();
          }
          if (!detail) {
            detailFailures++;
            reject("detail unavailable");
            continue;
          }
          for (const [k, v] of Object.entries(detail)) if (v != null && v !== "") listing[k] = v;

          const fail = criteriaFailure(listing);
          if (fail) { reject(fail); continue; }
          const kw = findKeyword(`${listing.title} ${listing.description ?? ""} ${listing.address}`);
          if (!kw) { reject("no ADU keyword"); continue; }

          listing.matchedKeyword = kw;
          found.push(listing);
          stateFound++;
          console.log(`%c[main] ✓ ${found.length}/${TARGET} "${kw}" — ${listing.address} — $${listing.price?.toLocaleString()}`, "color:green");
        }
        if (page >= totalPages) break;
      }
    }
  }

  const rows = found.map((l) => ({
    State: l.state,
    Address: l.address,
    Zip: l.zip,
    Price: l.price,
    Beds: l.beds,
    Baths: l.baths,
    SqFt: l.sqft ?? "",
    "Lot (acres)": l.lotSqft ? (l.lotSqft / 43560).toFixed(2) : "",
    "Year Built": l.yearBuilt ?? "Unknown",
    "Home Type": l.homeType ?? "",
    "Days on Zillow": l.daysOnZillow ?? "",
    "Matched Keyword": l.matchedKeyword,
    "Description Preview": keywordContext(l.description, l.matchedKeyword),
    Link: l.url,
  }));
  window.__mainListings = rows;

  console.log(`%c[main] Done: ${found.length} listing(s)`, "font-weight:bold");
  console.log("[main] Rejected by reason:", rejected);
  if (detailFailures) {
    console.warn(
      `[main] ${detailFailures} detail page(s) couldn't be read. To help fix that, run ` +
        "copy(window.__mainLastFailedDetail?.html) and send the result.",
    );
  }
  console.table(rows);

  if (rows.length) {
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [Object.keys(rows[0]), ...rows.map(Object.values)]
      .map((r) => r.map(esc).join(","))
      .join("\n");
    try {
      // DevTools' copy() works without page focus; fall back to the API
      if (typeof copy === "function") copy(csv);
      else await navigator.clipboard.writeText(csv);
      console.log("[main] CSV copied to clipboard.");
    } catch {}
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `zillow-main-ohio-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }
})();
