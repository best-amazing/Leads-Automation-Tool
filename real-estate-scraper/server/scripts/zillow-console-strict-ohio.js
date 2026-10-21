// scripts/zillow-console-strict-ohio.js — Ohio only (generated from zillow-console-strict.js)
// ─────────────────────────────────────────────────────────────────────────────
// Browser-console script: collects listings from Zillow that meet the second
// spreadsheet's criteria ("Eddy Property Research Tool 2") across the target
// states. No ADU keyword is required.
//
// Usage:
//   1. Open https://www.zillow.com in a normal browser tab.
//   2. DevTools → Console → paste this whole file → Enter.
//   3. Wait (requests are paced ~2s apart). It's finished when the console
//      prints "[strict] Done: N listing(s)". Results print as a table, are
//      copied to the clipboard as CSV, a CSV file is downloaded, and they're
//      kept on window.__strictListings.
//
// Criteria mirror STRICT_CRITERIA / strictCriteriaFailure in
// src/scrapers/property-purchase-research/filters/adu-research.scraper.ts and
// STATE_ZIP_PREFIXES / TARGET_STATES in core/adu-keywords.ts — keep in sync.
// Like the scraper, a value the listing genuinely doesn't have passes; a
// listing whose detail page can't be read is skipped (not passed).
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  const TARGET = 200; // total listings to collect
  const MAX_PER_STATE = Infinity; // spread results across states (Infinity = no cap)
  const ONLY_STATES = ["OH"]; // limit a run to these states, e.g. ["OH"] (empty = all)
  const MAX_PAGES = 20; // Zillow serves at most 20 pages (~41 results) per search
  const DELAY_MS = [1500, 3000]; // random pause between requests

  // Priority order and ZIP rules from TARGET_STATES / STATE_ZIP_PREFIXES.
  // null = any ZIP. Remove states here to narrow a run.
  const STATES = [
    ["OH", null], ["IN", ["46"]], ["WI", ["53"]], ["IA", ["50", "52"]],
    ["IL", ["60"]], ["KY", ["40"]], ["MI", ["48", "49"]], ["PA", ["15"]],
    ["MO", ["63", "64"]], ["NE", ["68"]], ["KS", ["66"]], ["TN", ["37"]],
    ["GA", ["30"]],
  ];

  // Already written to the second sheet — skipped (zpids)
  const SKIP_ZPIDS = new Set([
    "33127572", "465793328", "2064888996", "33853457", "34240326", "34262764",
    "33123800", "33118654", "33118011", "465032319", "33121729",
    "464586171", "86629931", "463679544", "123900453", "2070428702", "110996468",
    "341226954", "34240934", "35097601", "34242998", "456209232", "117952307",
    "76793688", "50158265", "123780969", "87003618", "86946100", "76840230",
    "789408", "50169536", "123778548", "4314721", "353736523", "441101322",
    "4287844", "463212405", "118155653", "463470528", "73540402", "466046795",
    "450896747", "55509104", "2085141582", "50167356", "126775799", "113863243",
    "246806338", "209561277", "76622448", "73456133", "73583619", "464629247",
    "115967869", "2087075477", "95263319", "113535962", "113537883", "106571347",
    "465948745", "465675291", "464893128", "53721843", "2096452174", "78541420",
    "10626434", "2079345634", "127066980", "465979385", "128524209", "463144879",
  ]);

  // Each band is its own search, so a state with more than 20 pages of
  // results is still covered end to end.
  const PRICE_BANDS = [[0, 100_000], [100_000, 150_000], [150_000, 200_000]];

  const C = {
    maxPrice: 200_000,
    minBeds: 4,
    minBaths: 2,
    minSqft: 1_500,
    minLotSqft: 0.5 * 43_560, // 0.5 acres
    minYearBuilt: 1955,
    newConstructionMinYear: new Date().getFullYear() - 1,
  };

  // Zillow-side narrowing — only filters Zillow reliably honours on URL
  // searches (price/beds/baths + listing-type flags). Lot, sqft, year built
  // and home type are checked client-side: Zillow applied its own versions
  // of those inconsistently (empty results in some cities, ignored in others).
  const filterStateFor = ([min, max]) => ({
    price: { ...(min ? { min } : {}), max },
    beds: { min: C.minBeds },
    baths: { min: C.minBaths },
    nc: { value: false }, auc: { value: false },
    fore: { value: false }, cmsn: { value: false },
    sort: { value: "days" },
  });

  const EXCLUDED_HOME_TYPES =
    /^(condo|condominium|townhouse|townhome|co-?op|manufactured|mobile|lot|land|vacant land|timeshare)/i;
  const EXCLUDED_TEXT = [
    [/\b(condo|condominium|townhouse|townhome|mobile home|manufactured home)\b/i, "property type"],
    [/\b(vacant land|bare land|land only|lot only)\b/i, "land only"],
    [/\bbungalows?\b/i, "bungalow"],
    [/\b(55\+|55 and older|55 and over|active adult|senior community)/i, "55+ community"],
    [/\bauctions?\b/i, "auction"],
    [/\b(foreclosures?|bank[- ]owned|reo)\b/i, "foreclosure"],
    [/\bshort sale\b/i, "short sale"],
  ];
  const HOA_TEXT_RE = /\b(hoa|home ?owners?'? association|home owner'?s? association)\b/i;
  const NO_HOA_TEXT_RE =
    /\b(no|without|zero|free of)\s+(an?\s+)?(hoa|home ?owners?'? association)\b|\bhoa\s*(fees?)?\s*[:\-]?\s*(none|no|n\/a|\$?0\b)/i;
  const NEW_CONSTRUCTION_RE =
    /\b(new[- ]construction|newly (?:constructed|built)|new[- ]build|to[- ]be[- ]built|under construction|pre[- ]?construction|proposed construction|spec home|est(?:\.|imated)? completion)\b/gi;
  const IMPROVEMENT_RE =
    /^[^.;!]{0,30}?\b(garage|barn|pole barn|shed|deck|porch|patio|addition|fence|driveway|roof|carport|workshop|outbuilding)s?\b/i;

  const known = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

  function newConstructionReason(l) {
    if (known(l.yearBuilt)) {
      return l.yearBuilt >= C.newConstructionMinYear ? `new construction (built ${l.yearBuilt})` : null;
    }
    const text = `${l.title ?? ""} ${l.description ?? ""}`;
    for (const m of text.matchAll(NEW_CONSTRUCTION_RE)) {
      if (IMPROVEMENT_RE.test(text.slice(m.index + m[0].length))) continue;
      return `new construction ("${m[0].toLowerCase()}")`;
    }
    return null;
  }

  /** Port of strictCriteriaFailure: first failing reason, or null. */
  function strictFailure(l) {
    if (known(l.price) && l.price > C.maxPrice) return `price ${l.price}`;
    if (known(l.beds) && l.beds < C.minBeds) return `beds ${l.beds}`;
    if (known(l.baths) && l.baths < C.minBaths) return `baths ${l.baths}`;
    if (known(l.sqft) && l.sqft < C.minSqft) return `sqft ${l.sqft}`;
    if (known(l.lotSqft) && l.lotSqft < C.minLotSqft) return `lot ${(l.lotSqft / 43560).toFixed(2)} ac`;
    if (known(l.yearBuilt) && l.yearBuilt < C.minYearBuilt) return `built ${l.yearBuilt}`;
    const nc = newConstructionReason(l);
    if (nc) return nc;
    if (known(l.hoaFee)) return `HOA $${l.hoaFee}/mo`;
    if (EXCLUDED_HOME_TYPES.test(l.homeType ?? "")) return `type ${l.homeType}`;
    const text = `${l.title ?? ""} ${l.description ?? ""}`;
    if (HOA_TEXT_RE.test(text) && !NO_HOA_TEXT_RE.test(text)) return "HOA (mentioned)";
    for (const [re, reason] of EXCLUDED_TEXT) if (re.test(text)) return reason;
    return null;
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
    if (!html.includes("__NEXT_DATA__") &&
        (res.status === 403 || /captcha|press & hold|access to this page has been denied/i.test(html))) {
      throw new CaptchaError("Zillow showed a captcha — open any Zillow page in this tab, solve it, then re-run.");
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return html;
  }

  function nextData(html) {
    const el = new DOMParser().parseFromString(html, "text/html").getElementById("__NEXT_DATA__");
    try { return el ? JSON.parse(el.textContent) : null; } catch { return null; }
  }

  /** Zillow region for a state, read from its own state page. */
  async function resolveRegion(state) {
    const json = nextData(await getHtml(`https://www.zillow.com/${state.toLowerCase()}/`));
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
      for (let i = at + open.length; i < html.length && s.length < 20_000; i++) {
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

  /**
   * Detail page → year built, HOA, description, lot, home type. Reads the
   * property cache in __NEXT_DATA__, falling back to the raw page JSON.
   * Returns null when the page carries no property data at all.
   */
  async function fetchDetail(url) {
    const html = await getHtml(url);
    const props = nextData(html)?.props?.pageProps;
    const raw = props?.gdpClientCache ?? props?.componentProps?.gdpClientCache;
    let p;
    try {
      const cache = typeof raw === "string" ? JSON.parse(raw) : raw;
      p = Object.values(cache ?? {}).find((v) => v?.property)?.property;
    } catch {}

    if (p) {
      const hoaRaw = p.monthlyHoaFee ?? p.resoFacts?.hoaFee ?? p.resoFacts?.associationFee;
      const hoaFee = hoaRaw == null ? undefined
        : typeof hoaRaw === "number" ? hoaRaw : Number(String(hoaRaw).replace(/[^\d.]/g, ""));
      return {
        yearBuilt: p.yearBuilt ? Number(p.yearBuilt) : undefined,
        hoaFee: Number.isFinite(hoaFee) ? hoaFee : undefined,
        description: props?.componentProps?.description ?? p.description ?? "",
        homeType: p.homeType,
        lotSqft: toLotSqft(p.lotAreaValue, p.lotAreaUnit) ?? (p.lotSize || undefined),
      };
    }

    // Fallback: first occurrence of each field anywhere in the page JSON
    // (quotes may be escaped inside an embedded JSON string).
    const field = (name, pattern) =>
      html.match(new RegExp(`\\\\?"${name}\\\\?"\\s*:\\s*${pattern}`))?.[1];
    const year = Number(field("yearBuilt", "(\\d{4})"));
    const lotValue = Number(field("lotAreaValue", "([\\d.]+)"));
    const lotUnit = field("lotAreaUnit", '\\\\?"([a-zA-Z]+)');
    const lotSize = Number(field("lotSize", "(\\d+)"));
    const hoa = Number(field("monthlyHoaFee", "([\\d.]+)"));
    const description = stringField(html, "description");
    // A description alone doesn't count: the page's SEO meta description
    // matches too, which let listings through with nothing verified.
    if (!year && !lotValue && !lotSize) {
      window.__strictLastFailedDetail = { url, html }; // for debugging the page shape
      return null;
    }
    return {
      yearBuilt: year || undefined,
      hoaFee: Number.isFinite(hoa) && hoa > 0 ? hoa : undefined,
      description: description ?? "",
      lotSqft: toLotSqft(lotValue, lotUnit) ?? (lotSize || undefined),
    };
  }

  const found = [];
  const seen = new Set(SKIP_ZPIDS);
  const rejected = {};
  const reject = (reason) => {
    const k = reason.replace(/[\d$,.]+.*$/, "").trim() || reason;
    rejected[k] = (rejected[k] ?? 0) + 1;
  };

  const RUN_STATES = ONLY_STATES.length ? STATES.filter(([abbr]) => ONLY_STATES.includes(abbr)) : STATES;
  console.log(`%c[strict] Looking for ${TARGET} listings across ${RUN_STATES.map(([s]) => s).join(", ")}…`, "font-weight:bold");

  run: for (const [state, zipPrefixes] of RUN_STATES) {
    if (found.length >= TARGET) break;
    let region;
    try {
      region = await resolveRegion(state);
    } catch (err) {
      console.error(`[strict] ${err.message}`);
      if (err instanceof CaptchaError) break;
      continue;
    }
    await pause();
    if (!region) { console.warn(`[strict] ${state}: couldn't resolve Zillow region, skipping`); continue; }

    let stateFound = 0;
    bands: for (const band of PRICE_BANDS) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        let json;
        try {
          json = nextData(await getHtml(searchUrl(state, region, band, page)));
        } catch (err) {
          console.error(`[strict] ${err.message}`);
          if (err instanceof CaptchaError) break run;
          break;
        }
        const cat1 = json?.props?.pageProps?.searchPageState?.cat1;
        const results = cat1?.searchResults?.listResults ?? [];
        const totalPages = cat1?.searchList?.totalPages ?? 1;
        const total = cat1?.searchList?.totalResultCount;
        const bandLabel = `$${band[0] / 1000}k–$${band[1] / 1000}k`;
        console.log(`[strict] ${state} ${bandLabel} p${page}/${totalPages}${total != null ? ` (${total} total)` : ""}: ${results.length} result(s) — ${found.length}/${TARGET} found`);
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

          const listing = {
            zpid,
            address: r.address,
            state,
            zip,
            price: info.price ?? r.unformattedPrice,
            beds: info.bedrooms ?? r.beds,
            baths: info.bathrooms ?? r.baths,
            sqft: info.livingArea ?? r.area,
            lotSqft: toLotSqft(info.lotAreaValue, info.lotAreaUnit),
            homeType: info.homeType,
            daysOnZillow: info.daysOnZillow,
            url: r.detailUrl?.startsWith("http") ? r.detailUrl : `https://www.zillow.com${r.detailUrl}`,
          };

          // Cheap check on search data before spending a detail fetch
          const pre = strictFailure(listing);
          if (pre) { reject(pre); continue; }

          let detail;
          try {
            detail = await fetchDetail(listing.url);
          } catch (err) {
            console.warn(`[strict] detail failed (${listing.address}): ${err.message}`);
            if (err instanceof CaptchaError) break run;
            reject("detail unavailable");
            continue;
          } finally {
            await pause();
          }
          if (!detail) {
            console.warn(`[strict] no property data on detail page, skipped: ${listing.url}`);
            reject("detail unavailable");
            continue;
          }
          for (const [k, v] of Object.entries(detail)) if (v != null && v !== "") listing[k] = v;

          const fail = strictFailure(listing);
          if (fail) { reject(fail); continue; }
          found.push(listing);
          stateFound++;
          console.log(`%c[strict] ✓ ${found.length}/${TARGET} ${listing.address} — $${listing.price?.toLocaleString()}`, "color:green");
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
    Link: l.url,
  }));
  window.__strictListings = rows;

  console.log(`%c[strict] Done: ${found.length} listing(s)`, "font-weight:bold");
  console.log("[strict] Rejected by reason:", rejected);
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
      console.log("[strict] CSV copied to clipboard.");
    } catch {}
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `zillow-strict-ohio-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }
})();
