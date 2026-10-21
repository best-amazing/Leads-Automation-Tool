// scripts/redfin-console-strict.js
// ─────────────────────────────────────────────────────────────────────────────
// Browser-console script: collects listings from Redfin that meet the second
// spreadsheet's criteria ("Eddy Property Research Tool 2") across the target
// states. No ADU keyword is required.
//
// Usage:
//   1. Open https://www.redfin.com in a normal browser tab.
//   2. DevTools → Console → paste this whole file → Enter.
//   3. It's finished when the console prints "[redfin-strict] Done: N
//      listing(s)". Results print as a table, are copied to the clipboard as
//      CSV, a CSV file is downloaded, and they're kept on
//      window.__redfinStrictListings.
//
// Redfin's search API returns lot size, year built, HOA, property type and the
// listing remarks with every result, so no detail pages are fetched and every
// criterion is checked on real data (a value Redfin doesn't have passes, like
// the scraper).
//
// Criteria mirror STRICT_CRITERIA / strictCriteriaFailure in
// src/scrapers/property-purchase-research/filters/adu-research.scraper.ts and
// STATE_ZIP_PREFIXES / TARGET_STATES in core/adu-keywords.ts — keep in sync.
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  // Some sites silence console.log; borrow a clean console from a hidden iframe.
  const out = (() => {
    try {
      const f = document.createElement("iframe");
      f.style.display = "none";
      document.documentElement.appendChild(f);
      return f.contentWindow?.console ?? console;
    } catch {
      return console;
    }
  })();
  const REQUEST_TIMEOUT_MS = 30_000; // a hung request is reported, not waited on forever

  const TARGET = 200; // total listings to collect
  const MAX_PER_STATE = 30; // spread results across states (Infinity = no cap)
  const ONLY_STATES = []; // limit a run to these states, e.g. ["OH"] (empty = all)
  // Redfin GIS region_type for a state (verified: OH 22, IN 31, IA 33 → all in-state)
  const STATE_REGION_TYPES = [4];
  const PAGE_SIZE = 350; // Redfin's maximum per request
  const MAX_PER_SEARCH = 30_000; // safety cap on one search's depth
  const DELAY_MS = [1000, 2000]; // random pause between requests

  // [abbr, full name, ZIP prefixes (null = any)] in TARGET_STATES order.
  const STATES = [
    ["OH", "Ohio", null], ["IN", "Indiana", ["46"]], ["WI", "Wisconsin", ["53"]],
    ["IA", "Iowa", ["50", "52"]], ["IL", "Illinois", ["60"]], ["KY", "Kentucky", ["40"]],
    ["MI", "Michigan", ["48", "49"]], ["PA", "Pennsylvania", ["15"]],
    ["MO", "Missouri", ["63", "64"]], ["NE", "Nebraska", ["68"]], ["KS", "Kansas", ["66"]],
    ["TN", "Tennessee", ["37"]], ["GA", "Georgia", ["30"]],
  ];

  // Fallback when a statewide region can't be resolved: the scraper's
  // verified city regions (ADU_REDFIN_MARKETS).
  const CITY_REGIONS = {
    OH: [4664, 4145, 19458, 3879, 5413, 244, 21075, 3101], IN: [9170], WI: [35759],
    IA: [20487, 5415, 3103], IL: [29470], KY: [12262], MI: [5665, 10728], PA: [15702],
    MO: [16661, 35751], NE: [9417], KS: [35754], TN: [13415], GA: [30756],
  };

  // Redfin ignores min/max price on statewide searches, so bands don't split
  // the results. One range, sorted cheapest first (see SORT_ORDERS), paged
  // until a whole page is over budget.
  const PRICE_BANDS = [[0, 200_000]];
  const SORT_ORDERS = ["price-asc", "price-desc"]; // falls back if Redfin rejects price-asc
  let sortOrder = SORT_ORDERS[0];

  const C = {
    maxPrice: 200_000,
    minBeds: 4,
    minBaths: 2,
    minSqft: 1_500,
    minLotSqft: 0.5 * 43_560, // 0.5 acres
    minYearBuilt: 1955,
    newConstructionMinYear: new Date().getFullYear() - 1,
  };

  // Redfin uiPropertyType codes (redfin.parser.ts PROPERTY_TYPE)
  const HOME_TYPES = { 1: "SINGLE_FAMILY", 2: "CONDO", 3: "TOWNHOUSE", 4: "MULTI_FAMILY", 5: "LAND", 6: "UNKNOWN", 7: "MOBILE" };
  const SEARCH_TYPES = "1,4"; // houses + multi-family

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

  let failedRequests = 0;
  /**
   * getJsonOnce with retries: Redfin rate-limits or serves a bot check after
   * many fast requests — wait and retry instead of skipping the search.
   */
  async function getJson(url) {
    const waits = [5_000, 15_000, 45_000];
    for (let attempt = 0; ; attempt++) {
      try {
        return await getJsonOnce(url);
      } catch (err) {
        // Only temporary problems are worth waiting for (not a 404 or a rejected request)
        if (!err.retryable || attempt >= waits.length) { if (err.retryable) failedRequests++; throw err; }
        out.warn(`[redfin-strict] request failed (${err.message}) — retrying in ${waits[attempt] / 1000}s`);
        await sleep(waits[attempt]);
      }
    }
  }

  /** Redfin's JSON endpoints prefix responses with "{}&&" (XSSI guard). */
  async function getJsonOnce(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    let res, text;
    try {
      res = await fetch(url, { credentials: "include", signal: ctrl.signal });
      text = await res.text();
    } catch (err) {
      throw Object.assign(new Error(err.name === "AbortError" ? `timed out after ${REQUEST_TIMEOUT_MS / 1000}s` : err.message), { retryable: true });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      // 403 / 429 / 5xx: blocked, rate-limited or a server hiccup
      throw Object.assign(new Error(`HTTP ${res.status}`), { retryable: res.status === 403 || res.status === 429 || res.status >= 500 });
    }
    let json;
    try { json = JSON.parse(text.replace(/^\{\}&&/, "")); } catch { throw Object.assign(new Error("response wasn't JSON (bot check?)"), { retryable: true }); }
    if (json.resultCode && json.resultCode !== 0) throw new Error(json.errorMessage || `resultCode ${json.resultCode}`);
    return json.payload ?? json;
  }

  /** Statewide region from Redfin's own search-box autocomplete, or null. */
  async function resolveStateRegion(fullName) {
    try {
      const payload = await getJson(
        `https://www.redfin.com/stingray/do/location-autocomplete?location=${encodeURIComponent(fullName)}&v=2&al=1`,
      );
      const rows = [];
      const walk = (o) => {
        if (!o || typeof o !== "object") return;
        if (typeof o.id === "string" && /^\d+_\d+$/.test(o.id) && o.name) rows.push(o);
        for (const v of Object.values(o)) walk(v);
      };
      walk(payload);
      // The state itself is the autocomplete's type 11 row ("11_22", url "/state/Ohio")
      const row =
        rows.find((r) => r.id.startsWith("11_") && r.name.toLowerCase() === fullName.toLowerCase()) ??
        rows.find((r) => /^\/state\//i.test(r.url ?? "") && r.name.toLowerCase() === fullName.toLowerCase());
      if (!row) return null;
      return { regionId: Number(row.id.split("_")[1]) };
    } catch {
      return null;
    }
  }

  function gisUrl(region, [minPrice, maxPrice], start) {
    const params = new URLSearchParams({
      al: "1",
      region_id: String(region.regionId),
      region_type: String(region.regionType),
      uipt: SEARCH_TYPES,
      ...(minPrice ? { min_price: String(minPrice) } : {}),
      max_price: String(maxPrice),
      num_homes: String(PAGE_SIZE),
      start: String(start),
      status: "1", // for sale
      sf: "1,2,3,5,6,7",
      ord: sortOrder,
    });
    return `https://www.redfin.com/stingray/api/gis?${params}`;
  }

  /** GIS home → the fields the criteria need. */
  function toListing(h) {
    const v = (f) => (f && typeof f === "object" ? f.value : f);
    // streetLine often already ends with the unit ("… Lot 11"), and some
    // feeds repeat a word ("Church St St")
    const street = String(v(h.streetLine) ?? "").replace(/\b(\w+)\s+\1\b/gi, "$1");
    const unit = v(h.unitNumber);
    const unitPart = unit && !street.includes(String(unit)) ? ` ${unit}` : "";
    const zip = String(h.zip ?? v(h.postalCode) ?? "").slice(0, 5); // drop ZIP+4
    const address = `${street}${unitPart}, ${h.city ?? ""}, ${h.state ?? ""} ${zip}`.trim();
    return {
      id: String(h.propertyId ?? h.listingId ?? h.url),
      address,
      title: address,
      state: h.state,
      zip,
      price: v(h.price),
      beds: h.beds,
      baths: h.baths,
      sqft: v(h.sqFt),
      lotSqft: v(h.lotSize),
      yearBuilt: v(h.yearBuilt),
      hoaFee: v(h.hoa),
      // uiPropertyType only — the raw propertyType uses different codes (6 = single family)
      homeType: HOME_TYPES[h.uiPropertyType] ?? "",
      street,
      isNewConstruction: !!h.isNewConstruction,
      daysOnMarket: v(h.dom),
      description: h.listingRemarks ?? "",
      url: `https://www.redfin.com${h.url}`,
    };
  }

  const found = [];
  const stateSummary = {};
  const seen = new Set();
  const rejected = {};
  const reject = (reason) => {
    const k = reason.replace(/[\d$,.]+.*$/, "").trim() || reason;
    rejected[k] = (rejected[k] ?? 0) + 1;
  };

  const RUN_STATES = ONLY_STATES.length ? STATES.filter(([abbr]) => ONLY_STATES.includes(abbr)) : STATES;
  out.log(`%c[redfin-strict] Looking for ${TARGET} listings across ${RUN_STATES.map(([s]) => s).join(", ")}…`, "font-weight:bold");

  run: for (const [state, fullName, zipPrefixes] of RUN_STATES) {
    if (found.length >= TARGET) break;
    out.log(`[redfin-strict] ${state}: looking up the statewide region…`);
    const statewide = await resolveStateRegion(fullName);
    await pause();
    const cities = (CITY_REGIONS[state] ?? []).map((regionId) => ({ regionId, regionType: 6, label: `${state} city ${regionId}` }));
    // GIS region_type codes differ from the autocomplete's; try likely state types in turn
    const stateTypes = statewide ? [...STATE_REGION_TYPES] : [];
    const stateRegion = (t) => ({ regionId: statewide.regionId, regionType: t, statewide: true, label: `${fullName} (statewide, type ${t})` });
    const regions = statewide ? [stateRegion(stateTypes.shift())] : cities;
    if (statewide) out.log(`[redfin-strict] ${state}: statewide region id ${statewide.regionId}`);
    else out.warn(`[redfin-strict] ${state}: statewide region not found — using ${cities.length} city search(es)`);

    let stateFound = 0;
    stateSummary[state] = () => stateFound;
    regionsLoop: for (let r = 0; r < regions.length; r++) {
      const region = regions[r];
      for (const band of PRICE_BANDS) {
        for (let start = 0; start < MAX_PER_SEARCH; start += PAGE_SIZE) {
          let homes;
          try {
            homes = (await getJson(gisUrl(region, band, start))).homes ?? [];
          } catch (err) {
            // A rejected sort order is permanent: fall back and redo this page
            if (!err.retryable && sortOrder !== SORT_ORDERS[1]) {
              out.warn(`[redfin-strict] Redfin rejected sort "${sortOrder}" (${err.message}) — using "${SORT_ORDERS[1]}"`);
              sortOrder = SORT_ORDERS[1];
              start -= PAGE_SIZE;
              continue;
            }
            out.error(`[redfin-strict] ${region.label}: ${err.message}`);
            break;
          }
          out.log(`[redfin-strict] ${region.label} $${band[0] / 1000}k–$${band[1] / 1000}k @${start}: ${homes.length} home(s) — ${found.length}/${TARGET} found`);
          await pause();

          // Redfin ignores a region it doesn't recognise and returns homes
          // from elsewhere — if the statewide search isn't mostly this state,
          // use the verified city regions instead.
          if (region.statewide && !region.checked) {
            region.checked = true;
            const inState = homes.filter((h) => h.state === state).length;
            if (!homes.length || inState / homes.length < 0.5) {
              if (stateTypes.length) {
                out.warn(`[redfin-strict] ${state}: region type ${region.regionType} returned other states (${inState}/${homes.length} in ${state}) — trying type ${stateTypes[0]}`);
                regions.push(stateRegion(stateTypes.shift()));
              } else {
                out.warn(`[redfin-strict] ${state}: no statewide region type worked — using ${cities.length} city search(es)`);
                regions.push(...cities);
              }
              continue regionsLoop;
            }
          }
          if (region.statewide && region.checked && !region.confirmed) {
            region.confirmed = true;
            out.log(`%c[redfin-strict] ${state}: statewide search works with region type ${region.regionType}`, "color:green");
          }
          const newHomes = homes.filter((h) => !seen.has(String(h.propertyId ?? h.listingId ?? h.url))).length;

          for (const h of homes) {
            if (found.length >= TARGET) break run;
            if (stateFound >= MAX_PER_STATE) continue run;
            const l = toListing(h);
            if (seen.has(l.id)) continue;
            seen.add(l.id);

            if (l.state && l.state !== state) { reject("outside state"); continue; }
            if (zipPrefixes && !zipPrefixes.some((p) => l.zip.startsWith(p))) { reject("zip"); continue; }
            if (l.isNewConstruction) { reject("new construction"); continue; }
            // Redfin lists lots and placeholders alongside homes: no price, no
            // bedrooms or no street number means it isn't a home for sale
            if (!(l.price > 0)) { reject("no price"); continue; }
            if (l.price < 10_000) { reject("price too low (likely rent)"); continue; }
            if (!(l.beds > 0)) { reject("no bedrooms (lot/land)"); continue; }
            if (!/^\d/.test(l.street) || /^0\s/.test(l.street)) { reject("no street number"); continue; }
            // A numbered lot or space in a park is almost always a manufactured home
            if (/\b(lot|space|site)\s*#?\d+/i.test(l.address)) { reject("park lot (likely manufactured)"); continue; }
            const fail = strictFailure(l);
            if (fail) { reject(fail); continue; }

            found.push(l);
            stateFound++;
            out.log(`%c[redfin-strict] ✓ ${found.length}/${TARGET} ${l.address} — $${l.price?.toLocaleString()}`, "color:green");
          }
          // Last page, Redfin repeating pages, or (cheapest first) everything
          // from here on is over budget
          const overBudget = sortOrder === "price-asc" && homes.length &&
            homes.every((h) => (toListing(h).price ?? 0) > 200_000);
          if (homes.length < PAGE_SIZE || newHomes === 0 || overBudget) break;
        }
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
    "Days on Market": l.daysOnMarket ?? "",
    Link: l.url,
  }));
  window.__redfinStrictListings = rows;

  out.log(`%c[redfin-strict] Done: ${found.length} listing(s)`, "font-weight:bold");
  out.log("[redfin-strict] Rejected by reason:", rejected);
  out.log(`[redfin-strict] Found per state: ${Object.entries(stateSummary).map(([st, n]) => `${st} ${n()}`).join(", ")}`);
  if (found.length < TARGET) {
    out.warn(
      failedRequests
        ? `[redfin-strict] Stopped short of ${TARGET}: ${failedRequests} request(s) failed even after retries — Redfin may be rate-limiting; wait a few minutes and run again.`
        : `[redfin-strict] Stopped short of ${TARGET}: every state was searched — that's all the matching listings Redfin returned.`,
    );
  }
  out.table(rows);

  if (rows.length) {
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [Object.keys(rows[0]), ...rows.map(Object.values)]
      .map((r) => r.map(esc).join(","))
      .join("\n");
    try {
      // DevTools' copy() works without page focus; fall back to the API
      if (typeof copy === "function") copy(csv);
      else await navigator.clipboard.writeText(csv);
      out.log("[redfin-strict] CSV copied to clipboard.");
    } catch {}
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `redfin-strict-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }
})();
