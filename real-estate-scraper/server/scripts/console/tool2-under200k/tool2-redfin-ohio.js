// scripts/console/tool2-under200k/tool2-redfin-ohio.js — Ohio only (generated from tool2-redfin.js)
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
  const MAX_PER_STATE = Infinity; // spread results across states (Infinity = no cap)
  const ONLY_STATES = ["OH"]; // limit a run to these states, e.g. ["OH"] (empty = all)
  // Redfin GIS region_type for a state (verified: OH 22, IN 31, IA 33 → all in-state)
  const STATE_REGION_TYPES = [4];
  const PAGE_SIZE = 350; // Redfin's maximum per request
  const MAX_PER_SEARCH = 200_000; // safety cap on one search's depth (Ohio alone is 30,000+ homes)
  const DELAY_MS = [1000, 2000]; // random pause between requests

  // [abbr, full name, ZIP prefixes (null = any)] in TARGET_STATES order.
  const STATES = [
    ["OH", "Ohio", null], ["IN", "Indiana", ["46"]], ["WI", "Wisconsin", ["53"]],
    ["IA", "Iowa", ["50", "52"]], ["IL", "Illinois", ["60"]], ["KY", "Kentucky", ["402", "405", "421"]],
    ["MI", "Michigan", ["482", "490"]], ["PA", "Pennsylvania", ["15"]],
    ["MO", "Missouri", ["63", "64"]], ["NE", "Nebraska", ["68"]], ["KS", "Kansas", ["66"]],
    ["TN", "Tennessee", ["372"]], ["GA", "Georgia", ["303"]],
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

  const MIN_HIGH_SCHOOL_RATING = 3; // management: skip areas whose high school is rated below 3 (unknown passes)
  const lowSchool = (rating) => { const n = parseFloat(rating ?? ""); return n > 0 && n < MIN_HIGH_SCHOOL_RATING; };
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
      propertyId: h.propertyId,
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

  // @skiplist-start — generated by `npm run console:skiplists`; don't edit by hand
  // Listings already in "Eddy Property under200k_Tool2" (2026-10-28 19:18 UTC) — skipped
  const SKIP_KEYS = new Set([
    "a:10 oak|45780", "a:100 chaucer|44035", "a:100 van|50452", "a:1003 patricia|64744", "a:1007 locke|30721", "a:101 kellys|50436", "a:102 kellys|50436", "a:1021 big|30650",
    "a:1027 winfield|45205", "a:10270 state|45784", "a:1031 euclid|40208", "a:104 depot|15666", "a:104 prospect|52060", "a:10465 chalk|63841", "a:105 kellys|50436", "a:105 pawn|30116",
    "a:106 pine|60918", "a:10640 brook|63023", "a:10694 state|43137", "a:107 king|64440", "a:107 redbud|15650", "a:108 bay|66716", "a:10882 chase|48653", "a:110 forestdale|60409",
    "a:110 hummel|15902", "a:110 plummer|66720", "a:1100 route|15701", "a:1109 fox|30815", "a:111 county|37309", "a:112 13th|66534", "a:112 2nd|66523", "a:112 dawson|63862",
    "a:113 danko|15601", "a:114 victory|30421", "a:1146 elm|52501", "a:115 belmont|30294", "a:115 ccc|40447", "a:116 haynes|52544", "a:116 quapaw|63877", "a:11635 laflin|60643",
    "a:117 main|64628", "a:1182 cleveland|30643", "a:12010 derby|44125", "a:1207 grove|50841", "a:121 maple|30471", "a:1217 vaughn|30223", "a:1224 franklin|63501", "a:12455 brown|40351",
    "a:1249 myrna|43512", "a:127 mckinley|63940", "a:13 crawford|45044", "a:130 old|42141", "a:1303 meadows|30474", "a:13058 kevin|44024", "a:1307 park|49783", "a:1328 19th|66607",
    "a:133 ambrose|30233", "a:1332 braden|50049", "a:136 hatfield|15480", "a:137 brix|30248", "a:13936 locust|43144", "a:1401 ewing|46201", "a:141 whitethorne|43223", "a:14117 lincoln|60419",
    "a:14197 new|63841", "a:142 franklin|15061", "a:1425 stanley|60409", "a:14505 minerva|60419", "a:1487 dutch|37716", "a:14910 wood|60426", "a:1515 4th|45638", "a:1534 9th|50314",
    "a:15436 airport|48906", "a:1553 friendship|30458", "a:15538 turlington|60426", "a:158 river|68850", "a:1589 fairview|48813", "a:16 hemphill|30747", "a:1605 valley|68355", "a:16051 gauger|60426",
    "a:16236 lathrop|60428", "a:1629 hyder|37660", "a:163 ave|49017", "a:163 foster|44902", "a:1632 birch|48632", "a:1699 new|30248", "a:1701 harrison|46001", "a:1703 ayodhya|52556",
    "a:1703 kosola|52556", "a:1705 5th|45402", "a:1705 ayodhya|52556", "a:1724 mercer|30223", "a:1733 bethsaida|30296", "a:1737 brook|30452", "a:17607 stonebridge|60429", "a:1806 william|15909",
    "a:189 gentry|40759", "a:1893 lanark|49240", "a:1916 218th|60411", "a:1921 state|40769", "a:1944 massieville|45601", "a:19548 county|63852", "a:1969 corners|30058", "a:1979 bloomfield|40069",
    "a:201 court|48658", "a:201 page|63382", "a:20120 keystone|60443", "a:203 1st|50529", "a:203 main|15486", "a:203 poplar|46911", "a:2034 jackson|52001", "a:205 idalia|63825",
    "a:2052 stivers|45101", "a:206 benefield|30553", "a:208 witt|15545", "a:209 john|49868", "a:2096 2500|64783", "a:210 main|45807", "a:21107 4th|64056", "a:2115 pine|30013",
    "a:2123 33rd|53208", "a:2123 grand|40210", "a:2133 central|52001", "a:2139 central|52001", "a:215 church|50456", "a:218 doerzbach|44870", "a:2208 albemarle|30906", "a:221 park|30241",
    "a:222 church|30401", "a:2224 howard|30421", "a:225 4th|46173", "a:225 orchard|60466", "a:22710 state|53581", "a:2274 washington|52001", "a:2282 baltimore|45225", "a:22911 bruce|60471",
    "a:22951 chippewa|48219", "a:23 grace|40140", "a:230 woodlawn|45805", "a:2315 maywood|64052", "a:2329 melody|48509", "a:2418 wetters|48708", "a:24207 hemlock|48118", "a:25 6th|50401",
    "a:2510 morris|40380", "a:2514 reid|44052", "a:2518 bellview|30582", "a:2518 whitemore|48602", "a:2570 f30|48745", "a:26 ebenezer|30401", "a:26 leanne|30643", "a:2626 nordholme|46805",
    "a:26813 osage|64866", "a:26854 woodlawn|60417", "a:275 normandy|49265", "a:2754 main|40212", "a:276 oak|37381", "a:2800 bender|45750", "a:2815 deans|30906", "a:2820 river|50126",
    "a:28615 state|46031", "a:2916 philadelphia|45405", "a:2919 market|40212", "a:2934 cromwell|44052", "a:29515 charles|48174", "a:3012 keysville|30815", "a:3041 sherwood|60428", "a:305 chestnut|50129",
    "a:307 mulberry|52585", "a:307 xenia|45410", "a:309 cosby|37821", "a:309 johnston|49783", "a:310 river|30274", "a:310 wick|66939", "a:3105 harris|63628", "a:311 harrison|63501",
    "a:3126 jones|49738", "a:313 4th|43812", "a:313 old|52542", "a:3135 burr|46406", "a:314 main|46911", "a:314 university|45810", "a:316 bullock|48770", "a:320 whyte|48650",
    "a:329 main|48740", "a:3305 coville|48745", "a:332 rainbow|30741", "a:33259 orchard|49043", "a:3341 spore|44820", "a:3345 old|49712", "a:335 oakwood|60466", "a:3355 wedgewood|30909",
    "a:336 153rd|60409", "a:340 ridge|49783", "a:3415 copper|37814", "a:34600 state|64747", "a:351 main|49795", "a:3583 austin|44041", "a:3590 108th|44105", "a:3591 state|45118",
    "a:3594 bennetts|30442", "a:3616 morgan|30815", "a:371 jarvis|40906", "a:376 penn|15631", "a:3814 saint|45205", "a:3819 sunnyside|52802", "a:389 2nd|45601", "a:392 pine|30153",
    "a:4 house|45804", "a:40 2nd|44875", "a:402 market|64482", "a:402 richmond|52501", "a:404 10th|52544", "a:404 3rd|50158", "a:404 oak|60962", "a:407 main|50258",
    "a:407 northside|30223", "a:407 st|63537", "a:408 sauk|60466", "a:408 washington|60942", "a:409 center|63468", "a:4095 kirk|44511", "a:4101 willow|30135", "a:412 main|52035",
    "a:416 1st|50585", "a:417 jefferson|60435", "a:419 felch|48851", "a:424 cassett|15644", "a:4257 53rd|53216", "a:4259 cote|63113", "a:426 quail|30222", "a:4272 reid|48473",
    "a:43054 judd|48111", "a:431 bardstown|42160", "a:431 metcalf|45801", "a:434 prospect|45804", "a:435 clay|63555", "a:4401 51st|48210", "a:44073 bell|44432", "a:4500 dayton|45417",
    "a:4508 maypole|60624", "a:4625 lewis|43612", "a:4718 ky-1809|40906", "a:4779 huntsman|30034", "a:49 moore|40939", "a:490 grand|44833", "a:494 jeffery|60409", "a:5006 shoals|37416",
    "a:5008 burt|48457", "a:501 left|40939", "a:502 eliza|52060", "a:504 main|66781", "a:506 main|63561", "a:515 hawk|45638", "a:515 madison|66860", "a:5183 sauls|49753",
    "a:5260 town|48739", "a:5331 ridge|63112", "a:5338 wood|60609", "a:53853 county|46514", "a:54193 quince|46628", "a:551 bradford|30525", "a:552 township|45619", "a:5540 state|44413",
    "a:5614 verona|15147", "a:5647 tyler|48845", "a:568 loras|52001", "a:569 county|45619", "a:573 bank|15627", "a:58970 vocational|43723", "a:5960 bluebonnet|30349", "a:603 county|44811",
    "a:604 adams|49783", "a:606 164th|60473", "a:606 8th|49093", "a:606 franklin|63501", "a:612 brown|40175", "a:612 kimball|49783", "a:6120 green|60621", "a:614 constitution|15068",
    "a:6160 rollways|48739", "a:62 marathon|63901", "a:621 elm|45801", "a:623 brookside|45661", "a:624 16th|52803", "a:6359 bells|30102", "a:6395 2nd|49715", "a:6414 gids|30058",
    "a:6551 ann|49201", "a:669 41st|40211", "a:67 wolf|40729", "a:6800 old|30349", "a:6825 maddox|30260", "a:6830 us-60|40351", "a:6830 us|40351", "a:6853 new|30273",
    "a:6889 wayne|48174", "a:6921 normal|60621", "a:6944 saddler|49623", "a:6948 morningview|44003", "a:697 caledonia|52001", "a:7020 skyview|30102", "a:703 washington|63561", "a:705 charles|45067",
    "a:705 elm|45801", "a:71 oakwood|37388", "a:710 linn|48706", "a:714 cedar|40212", "a:71571 main|43950", "a:7207 airport|49795", "a:722 laramie|60644", "a:724 broad|15906",
    "a:736 hopkins|30901", "a:754 orchard|43609", "a:769 railroad|15963", "a:788 fenelon|52001", "a:7946 muskegon|60617", "a:804 elm|49913", "a:809 liberty|66066", "a:810 minneapolis|49783",
    "a:8145 attleboro|30238", "a:819 summit|45204", "a:825 commonwealth|15122", "a:8287 dylan|64804", "a:835 littlefield|48893", "a:842 wayne|45801", "a:855 pleasant|40962", "a:861 mountain|30533",
    "a:866 cotton|40962", "a:9000 edinburg|30187", "a:905 5th|52732", "a:906 mott|63869", "a:907 1st|68048", "a:9105 state|45784", "a:9133 dahna|49460", "a:915 crest|30707",
    "a:917 8th|66757", "a:918 cimarron|66030", "a:930 booth|52001", "a:930 james|37914", "a:942 rice|45805", "a:9510 whittier|48224", "a:953 7th|15068", "a:957 orchard|15601",
    "a:9668 townsquare|48430", "a:971 al|49651", "a:9784 birmingham|48430", "c:10 oak|the plains", "c:100 chaucer|elyria", "c:100 van|latimer", "c:1003 patricia|el dorado spg", "c:1007 locke|dalton",
    "c:101 kellys|forest city", "c:102 kellys|forest city", "c:1021 big|madison", "c:1027 winfield|cincinnati", "c:10270 state|vincent", "c:1031 euclid|louisville", "c:104 depot|mount pleasant", "c:104 prospect|maquoketa",
    "c:10465 chalk|dexter", "c:105 kellys|forest city", "c:105 pawn|carrollton", "c:106 pine|buckley", "c:10640 brook|dittmer", "c:10694 state|lockbourne", "c:107 king|de kalb", "c:107 redbud|latrobe",
    "c:108 bay|bronson", "c:10882 chase|roscommon", "c:110 forestdale|calumet city", "c:110 hummel|johnstown", "c:110 plummer|chanute", "c:1100 route|indiana", "c:1109 fox|hephzibah", "c:111 county|calhoun",
    "c:112 13th|sabetha", "c:112 2nd|osage city", "c:112 dawson|lilbourn", "c:113 danko|greensburg", "c:114 victory|collins", "c:1146 elm|ottumwa", "c:115 belmont|ellenwood", "c:115 ccc|mckee",
    "c:116 haynes|centerville", "c:116 quapaw|steele", "c:11635 laflin|chicago", "c:117 main|brookfield", "c:1182 cleveland|hartwell", "c:12010 derby|garfield heights", "c:1207 grove|corning", "c:121 maple|twin city",
    "c:1217 vaughn|griffin", "c:1224 franklin|kirksville", "c:12455 brown|morehead", "c:1249 myrna|defiance", "c:127 mckinley|fisk", "c:13 crawford|middletown", "c:130 old|glasgow", "c:1303 meadows|vidalia",
    "c:13058 kevin|chardon", "c:1307 park|sault sainte marie", "c:1328 19th|topeka", "c:133 ambrose|jackson", "c:1332 braden|chariton", "c:136 hatfield|smock", "c:137 brix|locust grove", "c:13936 locust|murray city",
    "c:1401 ewing|indianapolis", "c:141 whitethorne|columbus", "c:14117 lincoln|dolton", "c:14197 new|dexter", "c:142 franklin|monaca", "c:1425 stanley|calumet city", "c:14505 minerva|dolton", "c:1487 dutch|clinton",
    "c:14910 wood|harvey", "c:1515 4th|ironton", "c:1534 9th|des moines", "c:15436 airport|lansing", "c:1553 friendship|statesboro", "c:15538 turlington|harvey", "c:158 river|lexington", "c:1589 fairview|charlotte",
    "c:16 hemphill|summerville", "c:1605 valley|falls city", "c:16051 gauger|harvey", "c:16236 lathrop|markham", "c:1629 hyder|kingsport", "c:163 ave|battle creek", "c:163 foster|mansfield", "c:1632 birch|lake",
    "c:1699 new|locust grove", "c:1701 harrison|alexandria", "c:1703 ayodhya|fairfield", "c:1703 kosola|fairfield", "c:1705 5th|dayton", "c:1705 ayodhya|fairfield", "c:1724 mercer|griffin", "c:1733 bethsaida|riverdale",
    "c:1737 brook|register", "c:17607 stonebridge|hazel crest", "c:1806 william|johnstown", "c:189 gentry|rockholds", "c:1893 lanark|grass lake", "c:1916 218th|sauk village", "c:1921 state|williamsburg", "c:1944 massieville|chillicothe",
    "c:19548 county|holcomb", "c:1969 corners|lithonia", "c:1979 bloomfield|springfield", "c:201 court|standish", "c:201 page|vandalia", "c:20120 keystone|matteson", "c:203 1st|dakota city", "c:203 main|vanderbilt",
    "c:203 poplar|amboy", "c:2034 jackson|dubuque", "c:205 idalia|bloomfield", "c:2052 stivers|aberdeen", "c:206 benefield|lavonia", "c:208 witt|east-other area", "c:209 john|newberry", "c:2096 2500|schell city",
    "c:210 main|lima", "c:21107 4th|independence", "c:2115 pine|conyers", "c:2123 33rd|milwaukee", "c:2123 grand|louisville", "c:2133 central|dubuque", "c:2139 central|dubuque", "c:215 church|manly",
    "c:218 doerzbach|sandusky", "c:2208 albemarle|augusta", "c:221 park|lagrange", "c:222 church|swainsboro", "c:2224 howard|collins", "c:225 4th|rushville", "c:225 orchard|park forest", "c:22710 state|richland center",
    "c:2274 washington|dubuque", "c:2282 baltimore|cincinnati", "c:22911 bruce|richton park", "c:22951 chippewa|detroit", "c:23 grace|garfield", "c:230 woodlawn|lima", "c:2315 maywood|independence", "c:2329 melody|burton",
    "c:2418 wetters|kawkawlin", "c:24207 hemlock|chelsea", "c:25 6th|mason city", "c:2510 morris|stanton", "c:2514 reid|lorain", "c:2518 bellview|young harris", "c:2518 whitemore|saginaw", "c:2570 f30|mikado",
    "c:26 ebenezer|swainsboro", "c:26 leanne|hartwell", "c:2626 nordholme|fort wayne", "c:26813 osage|stark city", "c:26854 woodlawn|crete", "c:275 normandy|onsted", "c:2754 main|louisville", "c:276 oak|spring city",
    "c:2800 bender|marietta", "c:2815 deans|augusta", "c:2820 river|iowa falls", "c:28615 state|atlanta", "c:2916 philadelphia|dayton", "c:2919 market|louisville", "c:2934 cromwell|lorain", "c:29515 charles|romulus",
    "c:3012 keysville|hephzibah", "c:3041 sherwood|markham", "c:305 chestnut|jefferson", "c:307 mulberry|richland", "c:307 xenia|dayton", "c:309 cosby|newport", "c:309 johnston|sault sainte marie", "c:310 river|riverdale",
    "c:310 wick|courtland", "c:3105 harris|bonne terre", "c:311 harrison|kirksville", "c:3126 jones|grayling", "c:313 4th|coshocton", "c:313 old|cantril", "c:3135 burr|gary", "c:314 main|amboy",
    "c:314 university|ada", "c:316 bullock|whittemore", "c:320 whyte|pinconning", "c:329 main|harrisville", "c:3305 coville|mikado", "c:332 rainbow|rossville", "c:33259 orchard|covert", "c:3341 spore|bucyrus",
    "c:3345 old|boyne city", "c:335 oakwood|park forest", "c:3355 wedgewood|augusta", "c:336 153rd|calumet city", "c:340 ridge|sault sainte marie", "c:3415 copper|morristown", "c:34600 state|garden city", "c:351 main|vanderbilt",
    "c:3583 austin|geneva", "c:3590 108th|cleveland", "c:3591 state|fayetteville", "c:3594 bennetts|millen", "c:3616 morgan|hephzibah", "c:371 jarvis|barbourville", "c:376 penn|everson", "c:3814 saint|cincinnati",
    "c:3819 sunnyside|davenport", "c:389 2nd|chillicothe", "c:392 pine|rockmart", "c:4 house|lima", "c:40 2nd|shelby", "c:402 market|rock port", "c:402 richmond|ottumwa", "c:404 10th|centerville",
    "c:404 3rd|marshalltown", "c:404 oak|roberts", "c:407 main|union", "c:407 northside|griffin", "c:407 st|edina", "c:408 sauk|park forest", "c:408 washington|hoopeston", "c:409 center|shelbina",
    "c:4095 kirk|youngstown", "c:4101 willow|douglasville", "c:412 main|colesburg", "c:416 1st|sioux rapids", "c:417 jefferson|joliet", "c:419 felch|lyons", "c:424 cassett|jeannette", "c:4257 53rd|milwaukee",
    "c:4259 cote|saint louis", "c:426 quail|greenville", "c:4272 reid|swartz creek", "c:43054 judd|belleville", "c:431 bardstown|park city", "c:431 metcalf|lima", "c:434 prospect|lima", "c:435 clay|memphis",
    "c:4401 51st|detroit", "c:44073 bell|lisbon", "c:4500 dayton|jefferson twp", "c:4508 maypole|chicago", "c:4625 lewis|toledo", "c:4718 ky-1809|barbourville", "c:4779 huntsman|decatur", "c:49 moore|ivy grove",
    "c:490 grand|galion", "c:494 jeffery|calumet city", "c:5006 shoals|chattanooga", "c:5008 burt|montrose", "c:501 left|ivy grove", "c:502 eliza|maquoketa", "c:504 main|weir", "c:506 main|queen city",
    "c:515 hawk|ironton", "c:515 madison|madison", "c:5183 sauls|lachine", "c:5260 town|hale", "c:5331 ridge|saint louis", "c:5338 wood|chicago", "c:53853 county|elkhart", "c:54193 quince|south bend",
    "c:551 bradford|clayton", "c:552 township|chesapeake", "c:5540 state|east palestine", "c:5614 verona|verona", "c:5647 tyler|hubbardston", "c:568 loras|dubuque", "c:569 county|chesapeake", "c:573 bank|derry",
    "c:58970 vocational|byesville", "c:5960 bluebonnet|south fulton", "c:603 county|bellevue", "c:604 adams|sault sainte marie", "c:606 164th|south holland", "c:606 8th|three rivers", "c:606 franklin|kirksville", "c:612 brown|vine grove",
    "c:612 kimball|sault sainte marie", "c:6120 green|chicago", "c:614 constitution|new kensington", "c:6160 rollways|hale", "c:62 marathon|poplar bluff", "c:621 elm|lima", "c:623 brookside|piketon", "c:624 16th|davenport",
    "c:6359 bells|acworth", "c:6395 2nd|brimley", "c:6414 gids|lithonia", "c:6551 ann|jackson", "c:669 41st|louisville", "c:67 wolf|east bernstadt", "c:6800 old|south fulton", "c:6825 maddox|morrow",
    "c:6830 us-60|morehead", "c:6830 us|morehead", "c:6853 new|rex", "c:6889 wayne|romulus", "c:6921 normal|chicago", "c:6944 saddler|chase", "c:6948 morningview|andover", "c:697 caledonia|dubuque",
    "c:7020 skyview|acworth", "c:703 washington|queen city", "c:705 charles|trenton", "c:705 elm|lima", "c:71 oakwood|tullahoma", "c:710 linn|bay city", "c:714 cedar|louisville", "c:71571 main|st clairsville",
    "c:7207 airport|vanderbilt", "c:722 laramie|chicago", "c:724 broad|johnstown", "c:736 hopkins|augusta", "c:754 orchard|toledo", "c:769 railroad|windber", "c:788 fenelon|dubuque", "c:7946 muskegon|chicago",
    "c:804 elm|calumet", "c:809 liberty|oskaloosa", "c:810 minneapolis|sault sainte marie", "c:8145 attleboro|jonesboro", "c:819 summit|cincinnati", "c:825 commonwealth|west mifflin", "c:8287 dylan|joplin", "c:835 littlefield|weidman",
    "c:842 wayne|lima", "c:855 pleasant|manchester", "c:861 mountain|dahlonega", "c:866 cotton|manchester", "c:9000 edinburg|winston", "c:905 5th|clinton", "c:906 mott|new madrid", "c:907 1st|plattsmouth",
    "c:9105 state|vincent", "c:9133 dahna|west olive", "c:915 crest|chickamauga", "c:917 8th|neodesha", "c:918 cimarron|gardner", "c:930 booth|dubuque", "c:930 james|knoxville", "c:942 rice|lima",
    "c:9510 whittier|detroit", "c:953 7th|new kensington", "c:957 orchard|greensburg", "c:9668 townsquare|fenton", "c:971 al|lake city", "c:9784 birmingham|fenton", "cx:2309078", "cx:2431276",
    "cx:2431277", "cx:2477640", "cx:2518678", "cx:2558367", "cx:2614984", "cx:2639143", "cx:2642446", "cx:2656092",
    "cx:2667021", "cx:2668702", "cx:2673328", "cx:2673329", "cx:2677154", "cx:2688426", "cx:2695200", "cx:2722080",
    "cx:2733593", "cx:2750126", "cx:2758061", "cx:2765823", "il:319153", "il:340419", "rf:102216473", "rf:102674417",
    "rf:102680432", "rf:102688156", "rf:102766640", "rf:103368016", "rf:107106854", "rf:107544609", "rf:111878020", "rf:114355553",
    "rf:116445366", "rf:117362670", "rf:117581410", "rf:117919944", "rf:118269177", "rf:118966042", "rf:119068376", "rf:119993256",
    "rf:121601492", "rf:123513552", "rf:124242478", "rf:124757353", "rf:126125487", "rf:127501797", "rf:128087729", "rf:128111938",
    "rf:128316857", "rf:128541053", "rf:12854941", "rf:12861029", "rf:12863507", "rf:12873637", "rf:12897602", "rf:128996653",
    "rf:12915299", "rf:12917884", "rf:129302136", "rf:12940833", "rf:12952732", "rf:12967494", "rf:130324427", "rf:130494703",
    "rf:13065847", "rf:131138590", "rf:131432652", "rf:131930953", "rf:13215380", "rf:132595932", "rf:133920317", "rf:133928923",
    "rf:134014462", "rf:135910433", "rf:135993139", "rf:136023326", "rf:137191293", "rf:137780686", "rf:138131222", "rf:139076316",
    "rf:13929860", "rf:13955371", "rf:141688425", "rf:141798045", "rf:141900376", "rf:141990281", "rf:142010107", "rf:142093712",
    "rf:142108471", "rf:142115502", "rf:142143211", "rf:142487673", "rf:142490509", "rf:142655690", "rf:142684584", "rf:162277755",
    "rf:162830065", "rf:163152095", "rf:163358154", "rf:180454232", "rf:182858396", "rf:183856652", "rf:188492695", "rf:18930443",
    "rf:191592378", "rf:192515892", "rf:193047294", "rf:194567110", "rf:195645877", "rf:196725648", "rf:198528110", "rf:199615392",
    "rf:199863140", "rf:199873269", "rf:200517542", "rf:200690627", "rf:201268441", "rf:201418633", "rf:201782128", "rf:202569264",
    "rf:202669424", "rf:203174577", "rf:203188245", "rf:203373359", "rf:204590450", "rf:204597472", "rf:204636904", "rf:205329040",
    "rf:205333560", "rf:205540845", "rf:205970207", "rf:205994598", "rf:206197765", "rf:206610826", "rf:206634897", "rf:206691035",
    "rf:206691036", "rf:23299335", "rf:23691045", "rf:23710687", "rf:23731753", "rf:23803986", "rf:23945507", "rf:24105509",
    "rf:24132539", "rf:24147965", "rf:24224097", "rf:24227179", "rf:24234260", "rf:24383264", "rf:24410208", "rf:24415170",
    "rf:24834102", "rf:24852124", "rf:25157482", "rf:25182893", "rf:25184388", "rf:25188306", "rf:25191743", "rf:25207286",
    "rf:25224839", "rf:25256065", "rf:26851723", "rf:57762506", "rf:60551289", "rf:62933820", "rf:63982078", "rf:66653320",
    "rf:67035376", "rf:67036983", "rf:69197318", "rf:69245508", "rf:69251868", "rf:69280203", "rf:69996004", "rf:70215635",
    "rf:70412783", "rf:70418648", "rf:70568211", "rf:70575238", "rf:70577045", "rf:70790144", "rf:71916576", "rf:72099166",
    "rf:72112111", "rf:73458883", "rf:75948212", "rf:76316827", "rf:76926322", "rf:77049358", "rf:77068999", "rf:77105449",
    "rf:77117582", "rf:77791408", "rf:77798240", "rf:78036027", "rf:78152804", "rf:79946729", "rf:80120042", "rf:81594207",
    "rf:81661584", "rf:82048589", "rf:82539550", "rf:82646319", "rf:82692920", "rf:82698865", "rf:83507904", "rf:83623904",
    "rf:83629760", "rf:83677500", "rf:83678511", "rf:84469553", "rf:84525087", "rf:84537936", "rf:87240114", "rf:90692659",
    "rf:90838495", "rf:90890498", "rf:90966665", "rf:95686468", "rf:96138528", "rf:97473816", "rf:97752539", "rf:97784542",
    "rf:97803943", "rf:97891646", "rf:97912700", "rf:97916886", "rf:98067698", "rf:98577257", "rf:98922655", "rf:98929122",
    "rf:99809762", "z:105966115", "z:10626434", "z:106289587", "z:106307785", "z:106307811", "z:106309851", "z:106571347",
    "z:108951837", "z:110996468", "z:112025377", "z:113535962", "z:113537883", "z:113863243", "z:115509590", "z:115967869",
    "z:117952307", "z:118155653", "z:123778548", "z:123780969", "z:123807042", "z:123900453", "z:126775799", "z:127066363",
    "z:127066980", "z:128524209", "z:140961613", "z:14948763", "z:194135804", "z:194572542", "z:194830939", "z:2060971602",
    "z:2064888996", "z:2070428702", "z:2079345634", "z:2085141582", "z:2087075477", "z:209561277", "z:2096452174", "z:2098804547",
    "z:226780600", "z:2318055", "z:246806338", "z:2963109", "z:2965881", "z:33118011", "z:33118654", "z:33121729",
    "z:33123800", "z:33127572", "z:33853457", "z:341226954", "z:34240326", "z:34240934", "z:34242998", "z:34262764",
    "z:35079911", "z:35097601", "z:353736523", "z:40462588", "z:41643897", "z:4287844", "z:4314721", "z:4331947",
    "z:441050323", "z:441101322", "z:450896747", "z:456209232", "z:463144879", "z:463212405", "z:463470528", "z:463679544",
    "z:464414586", "z:464586171", "z:464629247", "z:464778701", "z:464893128", "z:465032319", "z:465675291", "z:465793328",
    "z:465948745", "z:465979385", "z:466046795", "z:466142131", "z:466222247", "z:50158265", "z:50167356", "z:50168214",
    "z:50169536", "z:53721843", "z:55509104", "z:73456133", "z:73540402", "z:73583619", "z:76622448", "z:76793688",
    "z:76840230", "z:78541420", "z:789408", "z:86629931", "z:86946100", "z:87003618", "z:91177624", "z:91229705",
    "z:91255849", "z:95263319",
  ]);
  const sheetKeys = function sheetKeys(address, zip, url) {
    const keys = [];
    const addr = String(address ?? "");
    const street = addr.split(",")[0].toLowerCase().replace(/[.#]/g, " ").replace(/['’]/g, ""); // "Kelly's Ct" = "Kellys Ct"
    // "230-234 N Woodlawn", "906 & 908 Mott", "W10004 Main" (no plain number → no key)
    const m = street.match(/^\s*(\d+)[a-z]?(?:\s*(?:-|&|and)\s*\d+[a-z]?)?\s+(.*)$/);
    const z = (String(zip ?? "").match(/\d{5}/) || addr.match(/\b(\d{5})(?:-\d{4})?\s*$/) || [])[0];
    const word = m && m[2].split(/\s+/).find((w) => w && !/^(n|s|e|w|ne|nw|se|sw|north|south|east|west)$/.test(w));
    if (word && z) keys.push(`a:${m[1]} ${word}|${z}`);
    // Same house + street + city: catches sheet rows saved with a wrong ZIP
    const city = (addr.split(",")[1] || "").trim().toLowerCase();
    if (word && city) keys.push(`c:${m[1]} ${word}|${city}`);
    const u = String(url ?? "");
    const rf = u.match(/redfin\.com\/.*\/home\/(\d+)/);
    if (rf) keys.push(`rf:${rf[1]}`);
    const zp = u.match(/(\d+)_zpid/);
    if (zp) keys.push(`z:${zp[1]}`);
    const rl = u.match(/realtor\.com\/.*_(M[\d-]+)/);
    if (rl) keys.push(`rl:${rl[1]}`);
    const il = u.match(/investorlift\.com\/marketplace\/(?:deal|p)\/(\d+)/);
    if (il) keys.push(`il:${il[1]}`);
    const cx = u.match(/crexi\.com\/properties\/(\d+)/);
    if (cx) keys.push(`cx:${cx[1]}`);
    const cl = u.match(/craigslist\.org\/.*\/(\d+)\.html/);
    if (cl) keys.push(`cl:${cl[1]}`);
    return keys;
  };
  const alreadyInSheet = (address, zip, url) => sheetKeys(address, zip, url).some((k) => SKIP_KEYS.has(k));
  // @skiplist-end

  const found = [];
  const stateSummary = {};
  const coverage = { pages: 0, homes: 0, minPrice: Infinity, maxPrice: 0, cappedAt: [] };
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
          coverage.pages++;
          coverage.homes += homes.length;
          for (const h of homes) {
            const p = toListing(h).price;
            if (p > 0) { coverage.minPrice = Math.min(coverage.minPrice, p); coverage.maxPrice = Math.max(coverage.maxPrice, p); }
          }
          const newHomes = homes.filter((h) => !seen.has(String(h.propertyId ?? h.listingId ?? h.url))).length;

          for (const h of homes) {
            if (found.length >= TARGET) break run;
            if (stateFound >= MAX_PER_STATE) continue run;
            const l = toListing(h);
            if (seen.has(l.id)) continue;
            seen.add(l.id);
            if (typeof alreadyInSheet === "function" && alreadyInSheet(l.address, l.zip, l.url)) { reject("already in sheet"); continue; }

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
          if (start + PAGE_SIZE >= MAX_PER_SEARCH) coverage.cappedAt.push(region.label);
        }
      }
    }
  }

  // School ratings come from each home's details API, not the search
  // results, so they're looked up only for the listings that were kept.
  /** Assigned schools → { rating: "7/10" (high school, like the Zillow worker), detail: "E 4 / M 4 / H 3" } */
  function summariseSchools(schools) {
    const levels = { E: [], M: [], H: [] };
    for (const sc of schools) {
      const r = Number(sc.greatSchoolsRating);
      if (!(r > 0)) continue;
      // gradeRanges looks like "PreK-8", "K-5", "6-8", "9-12"
      const [lo, hi] = String(sc.gradeRanges ?? "").toUpperCase().replace(/PREK|PK|K/g, "0").split("-").map(Number);
      if (Number.isNaN(lo)) continue;
      const top = Number.isNaN(hi) ? lo : hi;
      if (lo <= 5) levels.E.push(r);
      if (lo <= 8 && top >= 6) levels.M.push(r);
      if (top >= 9) levels.H.push(r);
    }
    const best = (a) => (a.length ? Math.max(...a) : null);
    const detail = Object.entries(levels).filter(([, a]) => a.length).map(([k, a]) => `${k} ${best(a)}`).join(" / ");
    const headline = best(levels.H) ?? best(levels.M) ?? best(levels.E);
    return { rating: headline ? `${headline}/10` : "", detail };
  }
  if (found.length) out.log(`[redfin-strict] Looking up school ratings for ${found.length} listing(s)…`);
  let schoolMisses = 0;
  for (let i = 0; i < found.length; i++) {
    const l = found[i];
    l.schoolRating = "";
    l.schools = "";
    if (!l.propertyId) { schoolMisses++; continue; }
    try {
      const p = await getJson(`https://www.redfin.com/stingray/api/home/details/belowTheFold?propertyId=${l.propertyId}&accessLevel=1`);
      const info = p?.schoolsAndDistrictsInfo ?? {};
      const schools = info.servingThisHomeSchools?.length ? info.servingThisHomeSchools : info.schoolsToShowOnDP ?? [];
      Object.assign(l, (({ rating, detail }) => ({ schoolRating: rating, schools: detail }))(summariseSchools(schools)));
      if (!l.schoolRating) schoolMisses++;
    } catch (err) {
      schoolMisses++;
      out.warn(`[redfin-strict] schools for ${l.address}: ${err.message}`);
    }
    if ((i + 1) % 10 === 0 || i === found.length - 1) out.log(`[redfin-strict] school ratings ${i + 1}/${found.length}`);
    await pause();
  }
  if (schoolMisses) out.log(`[redfin-strict] ${schoolMisses} listing(s) have no school rating on Redfin.`);
  for (let i = found.length - 1; i >= 0; i--) {
    if (lowSchool(found[i].schoolRating)) {
      out.log(`[redfin-strict] ✗ high school rated ${found[i].schoolRating}: ${found[i].address}`);
      reject("high school rating < 3");
      found.splice(i, 1);
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
    "School Rating": l.schoolRating ?? "",
    "Schools (E/M/H)": l.schools ?? "",
    Link: l.url,
  }));
  window.__redfinStrictListings = rows;

  out.log(`%c[redfin-strict] Done: ${found.length} listing(s)`, "font-weight:bold");
  out.log("[redfin-strict] Rejected by reason:", rejected);
  out.log(`[redfin-strict] Found per state: ${Object.entries(stateSummary).map(([st, n]) => `${st} ${n()}`).join(", ")}`);
  out.log(
    `[redfin-strict] Searched ${coverage.homes.toLocaleString()} homes on ${coverage.pages} page(s)` +
      (coverage.maxPrice ? `, prices ${coverage.minPrice.toLocaleString()}–${coverage.maxPrice.toLocaleString()}` : "") +
      `, sorted ${sortOrder === "price-asc" ? "cheapest first" : "most expensive first (Redfin rejected cheapest-first)"}`,
  );
  if (coverage.cappedAt.length) {
    out.warn(`[redfin-strict] Hit the ${MAX_PER_SEARCH.toLocaleString()}-home limit in: ${coverage.cappedAt.join(", ")} — those searches did NOT reach the end. Raise MAX_PER_SEARCH and run again.`);
  }
  if (found.length < TARGET) {
    out.warn(
      failedRequests
        ? `[redfin-strict] Stopped short of ${TARGET}: ${failedRequests} request(s) failed even after retries — Redfin may be rate-limiting; wait a few minutes and run again.`
        : coverage.cappedAt.length
          ? `[redfin-strict] Stopped short of ${TARGET}: some searches hit the depth limit (see above), so there may be more.`
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
    a.download = `tool2-redfin-ohio-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }
})();
