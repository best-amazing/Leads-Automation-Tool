// scripts/console/tool2-under200k/tool2-propwire.js
// ─────────────────────────────────────────────────────────────────────────────
// Browser-console script: collects Propwire deals that meet the second
// spreadsheet's criteria ("Eddy Property under200k_Tool2") across target states.
//
// Usage:
//   1. Open https://propwire.com in a normal browser tab and log in.
//   2. DevTools → Console → paste this whole file → Enter.
//   3. It's finished when the console prints "[propwire-strict] Done: N listing(s)".
//      Results print as a table, are copied to clipboard as CSV, and rows
//      are stored on window.__propwireStrictListings.
//   4. Import: npm run console:import -- "<CSV file>"
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
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

  if (!/(^|\.)propwire\.com$/.test(location.hostname)) {
    out.error(`This script only works on propwire.com — you ran it on ${location.hostname}. Open https://propwire.com and paste it again.`);
    return;
  }

  const T = "[propwire-strict]";
  const TARGET = 200; // total listings to collect (capped at 200)
  const ONLY_STATES = []; // limit to specific states, e.g. ["OH"] (empty = all)
  const MAX_PER_STATE = 30; // cap results at 30 per state
  const PAGE_SIZE = 50;
  const MAX_PAGES_PER_STATE = 60; // pull up to 60 pages (3,000 listings) per state
  const DELAY_MS = [3000, 6000]; // slower pacing = fewer anti-bot blocks

  const C = {
    maxPrice: 200_000,
    minBeds: 4,
    minBaths: 2,
    minSqft: 1_500,
    minLotSqft: 0.5 * 43_560, // 0.5 acres (21,780 sqft)
    minYearBuilt: 1950,
    newConstructionMinYear: new Date().getFullYear() - 1,
  };

  const STATES = [
    { code: "OH", name: "Ohio", zips: null },
    { code: "IN", name: "Indiana", zips: ["46"] },
    { code: "WI", name: "Wisconsin", zips: ["53"] },
    { code: "IA", name: "Iowa", zips: ["50", "52"] },
    { code: "IL", name: "Illinois", zips: ["60"] },
    { code: "KY", name: "Kentucky", zips: ["402", "405", "421"] },
    { code: "MI", name: "Michigan", zips: ["482", "490"] },
    { code: "PA", name: "Pennsylvania", zips: ["15"] },
    { code: "MO", name: "Missouri", zips: ["63", "64"] },
    { code: "NE", name: "Nebraska", zips: ["68"] },
    { code: "KS", name: "Kansas", zips: ["66"] },
    { code: "TN", name: "Tennessee", zips: ["372"] },
    { code: "GA", name: "Georgia", zips: ["303"] },
  ];

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

  // Tool 2 allowed property types: Single Family (SFR/SFH) and Multi-Family (MFR/MFH/Duplex/etc)
  const ALLOWED_TYPES = /^(SFR|SFH|SINGLE|MFR|MFH|MULTI|DUPLEX|TRIPLEX|FOURPLEX|APARTMENT)/i;
  const DISALLOWED_TYPES = /^(LAND|LOT|VACANT|COMMERCIAL|OFFICE|INDUSTRIAL|RETAIL|OTHER|CONDO|TOWN|MOBILE|MANUF)/i;

  function criteriaFailure(l) {
    if (!l.price || l.price <= 0) return "no price";
    if (l.price > C.maxPrice) return `price $${l.price.toLocaleString()}`;

    // Home Type must be residential house / multifamily (no LAND, COMMERCIAL, etc.)
    const type = String(l.homeType ?? "").trim();
    if (DISALLOWED_TYPES.test(type)) return `type ${type}`;
    if (type && !ALLOWED_TYPES.test(type)) return `type ${type}`;

    // Tool 2 strict requirements: 4+ beds, 2+ baths, 1500+ sqft
    if (!l.beds || l.beds < C.minBeds) return `beds ${l.beds ?? 0}`;
    if (!l.baths || l.baths < C.minBaths) return `baths ${l.baths ?? 0}`;
    if (!l.sqft || l.sqft < C.minSqft) return `sqft ${l.sqft ?? 0}`;

    // Lot size: 0.5+ acres (21,780 sqft)
    if (known(l.lotSqft) && l.lotSqft < C.minLotSqft) return `lot ${(l.lotSqft / 43560).toFixed(2)} ac`;

    // Year Built
    if (known(l.yearBuilt) && l.yearBuilt < C.minYearBuilt) return `built ${l.yearBuilt}`;
    const nc = newConstructionReason(l);
    if (nc) return nc;

    // HOA / Negative keywords
    const text = `${l.title ?? ""} ${l.description ?? ""}`;
    if (HOA_TEXT_RE.test(text) && !NO_HOA_TEXT_RE.test(text)) return "HOA (mentioned)";
    for (const [re, reason] of EXCLUDED_TEXT) {
      if (re.test(text)) return reason;
    }
    return null;
  }

  function findToken() {
    try {
      const appEl = document.getElementById("app");
      if (appEl?.dataset?.page) {
        const page = JSON.parse(appEl.dataset.page);
        const t = page?.props?.token || page?.props?.auth?.token || page?.token;
        if (t && typeof t === "string" && t.length > 30) return t;
      }
    } catch {}

    const storageKeys = ["token", "auth_token", "jwt", "propwire_token", "authToken", "access_token"];
    for (const store of [sessionStorage, localStorage]) {
      for (const k of storageKeys) {
        try {
          const v = store.getItem(k);
          if (v) {
            const clean = v.replace(/^"|"$/g, "").replace(/^Bearer\s+/i, "");
            if (clean.length > 30) return clean;
          }
        } catch {}
      }
      try {
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i);
          const v = store.getItem(k);
          if (typeof v === "string" && v.startsWith("eyJ") && v.length > 50) return v;
          if (typeof v === "string" && v.includes("Bearer eyJ")) {
            const m = v.match(/Bearer\s+(eyJ[\w\.-]+)/i);
            if (m) return m[1];
          }
        }
      } catch {}
    }
    return null;
  }

  let token = findToken();
  if (!token) {
    token = prompt(`${T} Please paste your Propwire Bearer Token (found in DevTools Network tab -> property_search -> Authorization header):`);
    if (token) {
      token = token.replace(/^Bearer\s+/i, "").trim();
      sessionStorage.setItem("propwire_token", token);
    }
  }

  if (!token) {
    out.error(`${T} No Bearer token found. Please perform one search on Propwire, then paste this script again.`);
    return;
  }

  out.log(`${T} Starting search across target states...`);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let requestCount = 0;
  const pause = async () => {
    requestCount++;
    const base = DELAY_MS[0] + Math.random() * (DELAY_MS[1] - DELAY_MS[0]);
    const cooldown = requestCount % 12 === 0 ? 20_000 + Math.random() * 20_000 : 0;
    if (cooldown) out.warn(`${T} Cooling down ${Math.round(cooldown / 1000)}s after ${requestCount} requests…`);
    await sleep(base + cooldown);
  };

  const MAX_FETCH_ATTEMPTS = 4;
  async function propwireSearch(body) {
    for (let attempt = 1; ; attempt++) {
      let resp;
      try {
        resp = await fetch("https://api.propwire.com/api/property_search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/plain, */*",
            "Accept-Language": navigator.language || "en-US,en;q=0.9",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        if (attempt < MAX_FETCH_ATTEMPTS) {
          const wait = 8_000 * attempt;
          out.warn(`${T} Request failed (${err.message}); retrying in ${wait / 1000}s…`);
          await sleep(wait);
          continue;
        }
        throw err;
      }

      if (resp.status === 401) {
        const fresh = findToken();
        if (fresh && fresh !== token && attempt < MAX_FETCH_ATTEMPTS) {
          token = fresh;
          out.warn(`${T} Token expired — refreshed it from the page; retrying…`);
          await sleep(2_000);
          continue;
        }
        throw new Error("401 Unauthorized");
      }

      if (resp.status === 403 || resp.status === 429 || resp.status >= 500) {
        const retryAfter = Number(resp.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 30_000 * attempt;
        if (attempt < MAX_FETCH_ATTEMPTS) {
          out.warn(`${T} HTTP ${resp.status} (anti-bot/rate limit); backing off ${Math.round(wait / 1000)}s (attempt ${attempt}/${MAX_FETCH_ATTEMPTS})…`);
          await sleep(wait);
          continue;
        }
        throw new Error(`HTTP ${resp.status} after ${MAX_FETCH_ATTEMPTS} attempts`);
      }

      return resp;
    }
  }

  // @skiplist-start — generated by `npm run console:skiplists`; don't edit by hand
  // Listings already in "Eddy Property under200k_Tool2" + dedupe store (2026-11-11 16:08 UTC) — skipped
  const SKIP_KEYS = new Set([
    "a:0 elfinwild|15101", "a:0 larimer|15137", "a:0 tin|15357", "a:00 160th|64620", "a:03 51st|48210", "a:1 145th|60426", "a:1 malden|15417", "a:10 oak|45780",
    "a:100 chaucer|44035", "a:100 van|50452", "a:1003 patricia|64744", "a:1007 locke|30721", "a:101 kellys|50436", "a:101 kelly|50436", "a:1013 stone|68355", "a:102 kellys|50436",
    "a:102 kelly|50436", "a:1020 court|60901", "a:1020 ct|60901", "a:1021 big|30650", "a:10220 indiana|60628", "a:1027 winfield|45205", "a:10270 route 550|45784", "a:10270 state|45784",
    "a:103 marion|44903", "a:1031 1033|40208", "a:1031 euclid|40208", "a:1033 euclid|40208", "a:104 106|15666", "a:104 depot|15666", "a:104 prospect|52060", "a:1045 peyton|30311",
    "a:10465 chalk|63841", "a:105 kellys|50436", "a:105 kelly|50436", "a:105 pawn|30116", "a:106 depot|15666", "a:106 pine|60918", "a:10640 brook|63023", "a:10694 route|43137",
    "a:10694 state|43137", "a:107 king|64440", "a:107 redbud|15650", "a:108 bay|66716", "a:10801 hoxie|60617", "a:10828 massasoit|60415", "a:10882 chase|48653", "a:110 forestdale|60409",
    "a:110 hummel|15902", "a:110 plummer|66720", "a:1100 route highway|15701", "a:1100 route|15701", "a:1107 sherman|68949", "a:1109 fox|30815", "a:111 chestnut|60611", "a:111 county rd 737|37309",
    "a:111 county|37309", "a:112 13th|66534", "a:112 2nd|66523", "a:112 dawson|63862", "a:112 second|66523", "a:113 danko|15601", "a:114 victory|30421", "a:1146 elm|52501",
    "a:115 belmont|30294", "a:115 ccc|40447", "a:116 haynes|52544", "a:116 quapaw|63877", "a:116 union|60518", "a:11635 laflin|60643", "a:1164 martin|15725", "a:117 main|64628",
    "a:1170 goodfarm|60420", "a:1179 schuyler|60901", "a:1182 cleveland|30643", "a:120 chapin|15909", "a:12010 derby|44125", "a:1207 grove|50841", "a:121 maple|30471", "a:1217 vaughn|30223",
    "a:1219 spring|45805", "a:122 chapin|15909", "a:1224 franklin|63501", "a:1228 74th|60636", "a:123 4th|66441", "a:12455 brown|40351", "a:1249 myrna|43512", "a:12620 racine|60827",
    "a:127 mckinley|63940", "a:13 crawford|45044", "a:130 old|42141", "a:1303 meadows|30474", "a:1304 independence|68850", "a:1304 karlov|60623", "a:13058 kevin|44024", "a:1307 park|49783",
    "a:1328 19th|66607", "a:133 ambrose|30233", "a:1332 braden|50049", "a:136 hatfield|15480", "a:137 brix|30248", "a:137 woodbrier|42164", "a:139 peach|60466", "a:13936 locust|43144",
    "a:13982 cherrylawn|48238", "a:14 hillcrest|15330", "a:1401 ewing|46201", "a:14067 cherrylawn|48238", "a:141 whitethorne|43223", "a:14117 lincoln|60419", "a:14197 new|63841", "a:142 franklin|15061",
    "a:1425 stanley|60409", "a:14505 minerva|60419", "a:14637 kenwood|60419", "a:1487 dutch|37716", "a:14882 hammansburg|45872", "a:14910 wood|60426", "a:15 colchester|63135", "a:1503 washburn|66604",
    "a:15036 blackstone|60419", "a:1515 4th|45638", "a:1526 schrauder|15212", "a:1534 9th|50314", "a:1534 grant|15104", "a:1539 34th|44114", "a:15436 airport|48906", "a:1551 kings|64854",
    "a:1553 friendship|30458", "a:15538 turlington|60426", "a:158 river|68850", "a:1589 fairview|48813", "a:16 hemphill|30747", "a:1605 valley|68355", "a:16051 gauger|60426", "a:16210 laflin|60428",
    "a:16236 lathrop|60428", "a:1625 hudson|66503", "a:1629 hyder|37660", "a:163 ave|49017", "a:163 foster|44902", "a:1632 birch|48632", "a:1645 jackson|50525", "a:16581 chillicothe|44023",
    "a:1699 new|30248", "a:17 james|45701", "a:1701 harrison|46001", "a:1703 ayodhya|52556", "a:1703 kosola|52556", "a:1705 5th|45402", "a:1705 ayodhya|52556", "a:171 ebensburg|15901",
    "a:17195 17197|48221", "a:17195 stoepel|48221", "a:17197 stoepel|48221", "a:1724 mercer|30223", "a:17318 walter|60438", "a:1733 bethsaida|30296", "a:1734 mills|44870", "a:1737 brook|30452",
    "a:17607 stonebridge|60429", "a:1762 poplar|45662", "a:1806 william|15909", "a:1883 greenbriar|45662", "a:189 gentry|40759", "a:1893 lanark|49240", "a:1894 81st|44103", "a:1909 front|66739",
    "a:1911 front|66739", "a:1915 green|63136", "a:1916 218th|60411", "a:1921 highway 1804|40769", "a:1921 state|40769", "a:193 greentree|43950", "a:1944 massieville|45601", "a:19548 county rd 414|63852",
    "a:19548 county|63852", "a:1963 greenbush|45176", "a:1969 corners|30058", "a:1979 bloomfield|40069", "a:201 court|48658", "a:201 ct|48658", "a:201 page|63382", "a:20120 keystone|60443",
    "a:2020 sagamore|44117", "a:203 1st|50529", "a:203 main|15486", "a:203 poplar|46911", "a:2034 jackson|52001", "a:204 5th|66771", "a:205 idalia|63825", "a:205 vardell|63857",
    "a:2052 stivers|45101", "a:206 benefield|30553", "a:206 benifield|30553", "a:2068 sitser|30349", "a:207 tudor|15205", "a:208 witt|15545", "a:209 john|49868", "a:209 washington|60948",
    "a:2096 2500|64783", "a:210 main|45807", "a:210 pittsburgh|15050", "a:21107 4th|64056", "a:2115 pine|30013", "a:2123 33rd|53208", "a:2123 grand|40210", "a:2133 central|52001",
    "a:2139 central|52001", "a:2149 morningside|66801", "a:215 church|50456", "a:216 8th|52732", "a:218 doerzbach|44870", "a:2185 enon|30331", "a:2208 albemarle|30906", "a:221 park|30241",
    "a:222 church|30401", "a:2224 howard|30421", "a:225 4th|46173", "a:225 orchard|60466", "a:227 early|60466", "a:22710 highway 80|53581", "a:22710 highway|53581", "a:22710 hwy|53581",
    "a:22710 state|53581", "a:2274 washington|52001", "a:2282 baltimore|45225", "a:22911 bruce|60471", "a:22951 chippewa|48219", "a:23 grace|40140", "a:230 234|45805", "a:230 woodlawn|45805",
    "a:2315 maywood|64052", "a:2316 lake|46580", "a:2329 melody|48509", "a:234 woodlawn|45805", "a:2418 wetters|48708", "a:24207 hemlock|48118", "a:2431 ivydale|30311", "a:247 glendale|44146",
    "a:25 27|50401", "a:25 6th|50401", "a:250 hammes|60901", "a:2510 morris|40380", "a:2514 reid|44052", "a:2518 bellview|30582", "a:2518 whitemore|48602", "a:2531 14th|63901",
    "a:2570 f30|48745", "a:26 ebenezer|30401", "a:26 leanne|30643", "a:2626 nordholme|46805", "a:26813 osage|64866", "a:26854 woodlawn|60417", "a:27 6th|50401", "a:2727 106th|49010",
    "a:275 normandy|49265", "a:2754 main|40212", "a:276 oak|37381", "a:2800 bender|45750", "a:2815 deans|30906", "a:2820 river|50126", "a:2829 ganymedes|63020", "a:28615 state|46031",
    "a:2876 mcguffey|43224", "a:2916 philadelphia|45405", "a:2919 market|40212", "a:2934 cromwell|44052", "a:29515 charles|48174", "a:2957 2959|43224", "a:2957 mcguffey|43224", "a:2959 mcguffey|43224",
    "a:3 desdemona|15232", "a:3012 keysville|30815", "a:3029 constitution|15010", "a:3038 223rd|60411", "a:3041 sherwood|60428", "a:305 307|63873", "a:305 broadway|45887", "a:305 chestnut|50129",
    "a:307 mulberry|52585", "a:307 xenia|45410", "a:309 cosby|37821", "a:309 johnston|49783", "a:310 river|30274", "a:310 st|63545", "a:310 wick|66939", "a:3105 harris|63628",
    "a:311 4th|43812", "a:311 harrison|63501", "a:3126 jones|49738", "a:313 311|43812", "a:313 4th|43812", "a:313 old|52542", "a:3135 burr|46406", "a:314 main|46911",
    "a:314 university|45810", "a:316 bullock|48770", "a:320 whyte|48650", "a:3240 benjamin|30311", "a:32755 dexter|45775", "a:329 elm|66861", "a:329 main|48740", "a:3305 coville|48745",
    "a:332 rainbow|30741", "a:33259 orchard|49043", "a:3341 spore|44820", "a:3345 old|49712", "a:335 oakwood|60466", "a:3355 wedgewood|30909", "a:336 153rd|60409", "a:340 60th|60621",
    "a:340 ridge|49783", "a:3401 main|64030", "a:3415 copper|37814", "a:34600 route|64747", "a:34600 state|64747", "a:351 main|49795", "a:3583 austin|44041", "a:3590 108th|44105",
    "a:3591 route 131|45118", "a:3591 state|45118", "a:3594 bennetts|30442", "a:3616 morgan|30815", "a:3624 terrace|52402", "a:369 371|60901", "a:369 3rd|60901", "a:371 3rd|60901",
    "a:371 jarvis|40906", "a:375 winona|60466", "a:3750 pebble|30349", "a:3751 3753|43228", "a:3751 briggs|43228", "a:3753 briggs|43228", "a:376 penn|15631", "a:3814 saint|45205",
    "a:3814 st lawrence|45205", "a:3819 sunnyside|52802", "a:389 2nd|45601", "a:389 391|45601", "a:389 spring|40229", "a:391 2nd|45601", "a:392 pine|30153", "a:3985 demooney|30349",
    "a:39973 770|60960", "a:4 house|45804", "a:40 2nd|44875", "a:402 market|64482", "a:402 richmond|52501", "a:4030 brydle|44048", "a:404 10th|52544", "a:404 3rd|50158",
    "a:404 oak|60962", "a:407 main|50258", "a:407 northside|30223", "a:407 ottawa|60518", "a:407 st|63537", "a:408 sauk|60466", "a:408 washington|60942", "a:409 center|63468",
    "a:409 main|63537", "a:4095 kirk|44511", "a:41 spring|44890", "a:4101 willow|30135", "a:412 main|52035", "a:412 main|60942", "a:416 1st|50585", "a:416 dodge|52240",
    "a:417 arbor|44108", "a:417 jefferson|60435", "a:419 felch|48851", "a:4191 sun|30344", "a:4202 4206|68111", "a:4202 kansas|68111", "a:4206 kansas|68111", "a:422 ash|60970",
    "a:424 426|15644", "a:424 cassett|15644", "a:425 maple|44827", "a:425 spring|15417", "a:4257 53rd|53216", "a:4259 cote|63113", "a:426 cassett|15644", "a:426 quail|30222",
    "a:4272 reid|48473", "a:43054 judd|48111", "a:431 bardstown|42160", "a:431 metcalf|45801", "a:4329 wood|60609", "a:434 prospect|45804", "a:435 clay|63555", "a:4400 alaska|63111",
    "a:4401 03|48210", "a:4401 51st|48210", "a:44073 bell|44432", "a:4500 dayton|45417", "a:4508 maypole|60624", "a:4525 broadbush|45426", "a:4625 lewis|43612", "a:4718 ky-1809|40906",
    "a:4718 ky|40906", "a:4779 huntsman|30034", "a:4815 winchester|60609", "a:49 moore|40939", "a:490 grand|44833", "a:494 jeffery|60409", "a:4952 sioux|66054", "a:5006 shoals|37416",
    "a:5008 burt|48457", "a:501 left|40939", "a:502 4th|15963", "a:502 eliza|52060", "a:504 main|66781", "a:505 columbia|52537", "a:506 main|63561", "a:51 pine|60425",
    "a:514 main|60942", "a:515 hawk|45638", "a:515 madison|66860", "a:5183 sauls|49753", "a:5260 townhall|48739", "a:5260 town|48739", "a:52680 summit|43950", "a:5300 peoria|60609",
    "a:5331 ridge|63112", "a:5338 wood|60609", "a:5362 broadway|44127", "a:53853 county rd 7|46514", "a:53853 county|46514", "a:54193 quince|46628", "a:551 bradford|30525", "a:552 township|45619",
    "a:5540 route 170|44413", "a:5540 state|44413", "a:5613 dibble|44103", "a:5614 verona|15147", "a:5647 tyler|48845", "a:56612 mcgee|43947", "a:568 loras|52001", "a:569 county rd 3|45619",
    "a:569 county|45619", "a:573 bank|15627", "a:577 county rd 68|43964", "a:577 county|43964", "a:578 county|63867", "a:5840 90th|60453", "a:58970 vocational|43723", "a:592 dearborn|60901",
    "a:5960 bluebonnet|30349", "a:603 county rd 314|44811", "a:603 county|44811", "a:603 cr|44811", "a:604 adams|49783", "a:606 164th|60473", "a:606 8th|49093", "a:606 franklin|63501",
    "a:612 brown|40175", "a:612 kimball|49783", "a:6120 green|60621", "a:614 constitution|15068", "a:6160 rollways|48739", "a:62 marathon|63901", "a:62 marquette|60466", "a:621 elm|45801",
    "a:6217 carpenter|60621", "a:623 brookside|45661", "a:624 16th|52803", "a:6321 rhodes|60637", "a:6359 bells|30102", "a:6395 2nd|49715", "a:6414 gids|30058", "a:6551 ann|49201",
    "a:669 41st|40211", "a:67 wolf|40729", "a:6744 us-422|15701", "a:6744 us|15701", "a:6800 old|30349", "a:6825 maddox|30260", "a:6830 us-60|40351", "a:6830 us|40351",
    "a:6853 new|30273", "a:6889 wayne|48174", "a:69 orchard|60466", "a:6921 normal|60621", "a:6944 saddler|49623", "a:6948 morningview|44003", "a:697 caledonia|52001", "a:7020 skyview|30102",
    "a:703 washington|63561", "a:705 charles|45067", "a:705 elm|45801", "a:71 oakwood|37388", "a:710 linn|48706", "a:711 721|68649", "a:711 walnut|68649", "a:714 cedar|40212",
    "a:71571 main|43950", "a:717 case|15905", "a:720 7th|68926", "a:7207 airport|49795", "a:721 walnut|68649", "a:7216 chicago|60619", "a:722 laramie|60644", "a:7237 stony|60649",
    "a:724 broad|15906", "a:736 hopkins|30901", "a:7521 ridgeland|60649", "a:754 orchard|43609", "a:769 railroad|15963", "a:788 fenelon|52001", "a:7946 muskegon|60617", "a:804 elm|49913",
    "a:807 fuller|68638", "a:809 liberty|66066", "a:810 minneapolis|49783", "a:8145 attleboro|30238", "a:815 blackhawk|60484", "a:819 summit|45204", "a:820 von|15902", "a:825 commonwealth|15122",
    "a:8287 dylan|64804", "a:8318 manistee|60617", "a:835 littlefield|48893", "a:842 wayne|45801", "a:8507 may|60620", "a:855 pleasant|40962", "a:861 mountain|30533", "a:866 cotton|40962",
    "a:8719 enon|30331", "a:8744 aspen|46055", "a:8995 100|46147", "a:9000 edinburg|30187", "a:904 monroe|50854", "a:905 5th|52732", "a:906 908|63869", "a:906 mott|63869",
    "a:907 1st|68048", "a:908 mott|63869", "a:9105 route 550|45784", "a:9105 state|45784", "a:9133 dahna|49460", "a:915 crest|30707", "a:917 8th|66757", "a:918 cimarron|66030",
    "a:930 booth|52001", "a:930 james|37914", "a:942 rice|45805", "a:95 private|45669", "a:9510 whittier|48224", "a:953 7th|15068", "a:957 orchard|15601", "a:9668 townsquare|48430",
    "a:971 al|49651", "a:9784 birmingham|48430", "c:0 elfinwild|shaler", "c:0 larimer|north versailles", "c:0 tin|rices landing boro", "c:00 160th|altamont", "c:03 51st|detroit", "c:1 145th|harvey",
    "c:1 malden|brownsville", "c:10 oak|the plains", "c:100 chaucer|elyria", "c:100 van|latimer", "c:1003 patricia|el dorado spg", "c:1007 locke|dalton", "c:101 kellys|forest city", "c:1013 stone|falls city",
    "c:102 kellys|forest city", "c:1020 court|kankakee", "c:1021 big|madison", "c:10220 indiana|chicago", "c:1027 winfield|cincinnati", "c:10270 route 550|vincent", "c:103 marion|mansfield", "c:1031 euclid|louisville",
    "c:1033 euclid|louisville", "c:104 depot|mount pleasant", "c:104 prospect|maquoketa", "c:1045 peyton|atlanta", "c:10465 chalk|dexter", "c:105 kellys|forest city", "c:105 pawn|carrollton", "c:106 depot|mount pleasant",
    "c:106 pine|buckley", "c:10640 brook|dittmer", "c:10694 route|lockbourne", "c:107 king|de kalb", "c:107 redbud|latrobe", "c:108 bay|bronson", "c:10801 hoxie|chicago", "c:10828 massasoit|chicago ridge",
    "c:10882 chase|roscommon", "c:110 forestdale|calumet city", "c:110 hummel|johnstown", "c:110 plummer|chanute", "c:1100 route highway|indiana", "c:1107 sherman|holdrege", "c:1109 fox|hephzibah", "c:111 county rd 737|calhoun",
    "c:112 13th|sabetha", "c:112 2nd|osage city", "c:112 dawson|lilbourn", "c:113 danko|greensburg", "c:114 victory|collins", "c:1146 elm|ottumwa", "c:115 belmont|ellenwood", "c:115 ccc|mckee",
    "c:116 haynes|centerville", "c:116 quapaw|steele", "c:116 union|earlville", "c:11635 laflin|chicago", "c:1164 martin|clarksburg", "c:117 main|brookfield", "c:1179 schuyler|kankakee", "c:1182 cleveland|hartwell",
    "c:120 chapin|johnstown", "c:12010 derby|garfield heights", "c:1207 grove|corning", "c:121 maple|twin city", "c:1217 vaughn|griffin", "c:1219 spring|lima", "c:122 chapin|johnstown", "c:1224 franklin|kirksville",
    "c:1228 74th|chicago", "c:123 4th|junction city", "c:12455 brown|morehead", "c:1249 myrna|defiance", "c:12620 racine|calumet park", "c:127 mckinley|fisk", "c:13 crawford|middletown", "c:130 old|glasgow",
    "c:1303 meadows|vidalia", "c:1304 independence|lexington", "c:1304 karlov|chicago", "c:13058 kevin|chardon", "c:1307 park|sault sainte marie", "c:1328 19th|topeka", "c:133 ambrose|jackson", "c:1332 braden|chariton",
    "c:136 hatfield|smock", "c:137 brix|locust grove", "c:137 woodbrier|scottsville", "c:139 peach|park forest", "c:13936 locust|murray city", "c:13982 cherrylawn|detroit", "c:14 hillcrest|eighty four", "c:1401 ewing|indianapolis",
    "c:14067 cherrylawn|detroit", "c:141 whitethorne|columbus", "c:14117 lincoln|dolton", "c:14197 new|dexter", "c:142 franklin|monaca", "c:1425 stanley|calumet city", "c:14505 minerva|dolton", "c:14637 kenwood|dolton",
    "c:1487 dutch|clinton", "c:14882 hammansburg|north baltimore", "c:14910 wood|harvey", "c:15 colchester|saint louis", "c:1503 washburn|topeka", "c:15036 blackstone|dolton", "c:1515 4th|ironton", "c:1526 schrauder|pittsburgh",
    "c:1534 9th|des moines", "c:1534 grant|braddock", "c:1539 34th|cleveland", "c:15436 airport|lansing", "c:1551 kings|noel", "c:1553 friendship|statesboro", "c:15538 turlington|harvey", "c:158 river|lexington",
    "c:1589 fairview|charlotte", "c:16 hemphill|summerville", "c:1605 valley|falls city", "c:16051 gauger|harvey", "c:16210 laflin|markham", "c:16236 lathrop|markham", "c:1625 hudson|manhattan", "c:1629 hyder|kingsport",
    "c:163 ave|battle creek", "c:163 foster|mansfield", "c:1632 birch|lake", "c:1645 jackson|clarion", "c:16581 chillicothe|chagrin falls", "c:1699 new|locust grove", "c:17 james|the plains", "c:1701 harrison|alexandria",
    "c:1703 ayodhya|fairfield", "c:1703 kosola|fairfield", "c:1705 5th|dayton", "c:1705 ayodhya|fairfield", "c:171 ebensburg|johnstown", "c:17195 stoepel|detroit", "c:17197 stoepel|detroit", "c:1724 mercer|griffin",
    "c:17318 walter|lansing", "c:1733 bethsaida|riverdale", "c:1734 mills|sandusky", "c:1737 brook|register", "c:17607 stonebridge|hazel crest", "c:1762 poplar|portsmouth", "c:1806 william|johnstown", "c:1883 greenbriar|portsmouth",
    "c:189 gentry|rockholds", "c:1893 lanark|grass lake", "c:1894 81st|cleveland", "c:1909 front|galena", "c:1911 front|galena", "c:1915 green|saint louis", "c:1916 218th|sauk village", "c:1921 highway 1804|williamsburg",
    "c:193 greentree|saint clairsville", "c:1944 massieville|chillicothe", "c:19548 county rd 414|holcomb", "c:1963 greenbush|williamsburg", "c:1969 corners|lithonia", "c:1979 bloomfield|springfield", "c:201 court|standish", "c:201 page|vandalia",
    "c:20120 keystone|matteson", "c:2020 sagamore|euclid", "c:203 1st|dakota city", "c:203 main|vanderbilt", "c:203 poplar|amboy", "c:2034 jackson|dubuque", "c:204 5th|saint paul", "c:205 idalia|bloomfield",
    "c:205 vardell|kennett", "c:2052 stivers|aberdeen", "c:206 benefield|lavonia", "c:2068 sitser|atlanta", "c:207 tudor|pittsburgh", "c:208 witt|east-other area", "c:209 john|newberry", "c:209 washington|loda",
    "c:2096 2500|schell city", "c:210 main|lima", "c:210 pittsburgh|hookstown", "c:21107 4th|independence", "c:2115 pine|conyers", "c:2123 33rd|milwaukee", "c:2123 grand|louisville", "c:2133 central|dubuque",
    "c:2139 central|dubuque", "c:2149 morningside|emporia", "c:215 church|manly", "c:216 8th|clinton", "c:218 doerzbach|sandusky", "c:2185 enon|atlanta", "c:2208 albemarle|augusta", "c:221 park|lagrange",
    "c:222 church|swainsboro", "c:2224 howard|collins", "c:225 4th|rushville", "c:225 orchard|park forest", "c:227 early|park forest", "c:22710 highway 80|richland center", "c:2274 washington|dubuque", "c:2282 baltimore|cincinnati",
    "c:22911 bruce|richton park", "c:22951 chippewa|detroit", "c:23 grace|garfield", "c:230 woodlawn|lima", "c:2315 maywood|independence", "c:2316 lake|warsaw", "c:2329 melody|burton", "c:234 woodlawn|lima",
    "c:2418 wetters|kawkawlin", "c:24207 hemlock|chelsea", "c:2431 ivydale|atlanta", "c:247 glendale|bedford", "c:25 6th|mason city", "c:250 hammes|kankakee", "c:2510 morris|stanton", "c:2514 reid|lorain",
    "c:2518 bellview|young harris", "c:2518 whitemore|saginaw", "c:2531 14th|poplar bluff", "c:2570 f30|mikado", "c:26 ebenezer|swainsboro", "c:26 leanne|hartwell", "c:2626 nordholme|fort wayne", "c:26813 osage|stark city",
    "c:26854 woodlawn|crete", "c:27 6th|mason city", "c:275 normandy|onsted", "c:2754 main|louisville", "c:276 oak|spring city", "c:2800 bender|marietta", "c:2815 deans|augusta", "c:2820 river|iowa falls",
    "c:2829 ganymedes|de soto", "c:28615 state|atlanta", "c:2876 mcguffey|columbus", "c:2916 philadelphia|dayton", "c:2919 market|louisville", "c:2934 cromwell|lorain", "c:29515 charles|romulus", "c:2957 mcguffey|columbus",
    "c:2959 mcguffey|columbus", "c:3 desdemona|pittsburgh", "c:3012 keysville|hephzibah", "c:3029 constitution|beaver falls", "c:3038 223rd|sauk village", "c:3041 sherwood|markham", "c:305 broadway|spencerville", "c:305 chestnut|jefferson",
    "c:307 mulberry|richland", "c:307 xenia|dayton", "c:309 cosby|newport", "c:309 johnston|sault sainte marie", "c:310 river|riverdale", "c:310 st|green city", "c:310 wick|courtland", "c:3105 harris|bonne terre",
    "c:311 4th|coshocton", "c:311 harrison|kirksville", "c:3126 jones|grayling", "c:313 4th|coshocton", "c:313 old|cantril", "c:3135 burr|gary", "c:314 main|amboy", "c:314 university|ada",
    "c:316 bullock|whittemore", "c:320 whyte|pinconning", "c:3240 benjamin|atlanta", "c:32755 dexter|rutland", "c:329 elm|marion", "c:329 main|harrisville", "c:3305 coville|mikado", "c:332 rainbow|rossville",
    "c:33259 orchard|covert", "c:3341 spore|bucyrus", "c:3345 old|boyne city", "c:335 oakwood|park forest", "c:3355 wedgewood|augusta", "c:336 153rd|calumet city", "c:340 60th|chicago", "c:340 ridge|sault sainte marie",
    "c:3401 main|grandview", "c:3415 copper|morristown", "c:34600 route|garden city", "c:351 main|vanderbilt", "c:3583 austin|geneva", "c:3590 108th|cleveland", "c:3591 route 131|fayetteville", "c:3594 bennetts|millen",
    "c:3616 morgan|hephzibah", "c:3624 terrace|cedar rapids", "c:369 3rd|kankakee", "c:371 3rd|kankakee", "c:371 jarvis|barbourville", "c:375 winona|park forest", "c:3750 pebble|atlanta", "c:3751 briggs|columbus",
    "c:3753 briggs|columbus", "c:376 penn|everson", "c:3814 st lawrence|cincinnati", "c:3819 sunnyside|davenport", "c:389 2nd|chillicothe", "c:389 spring|louisville", "c:391 2nd|chillicothe", "c:392 pine|rockmart",
    "c:3985 demooney|atlanta", "c:39973 770|rankin", "c:4 house|lima", "c:40 2nd|shelby", "c:402 market|rock port", "c:402 richmond|ottumwa", "c:4030 brydle|kingsville", "c:404 10th|centerville",
    "c:404 3rd|marshalltown", "c:404 oak|roberts", "c:407 main|union", "c:407 northside|griffin", "c:407 ottawa|earlville", "c:407 st|edina", "c:408 sauk|park forest", "c:408 washington|hoopeston",
    "c:409 center|shelbina", "c:409 main|edina", "c:4095 kirk|youngstown", "c:41 spring|willard", "c:4101 willow|douglasville", "c:412 main|colesburg", "c:412 main|hoopeston", "c:416 1st|sioux rapids",
    "c:416 dodge|iowa city", "c:417 arbor|cleveland", "c:417 jefferson|joliet", "c:419 felch|lyons", "c:4191 sun|atlanta", "c:4202 kansas|omaha", "c:4206 kansas|omaha", "c:422 ash|watseka",
    "c:424 cassett|jeannette", "c:425 maple|crestline", "c:425 spring|brownsville", "c:4257 53rd|milwaukee", "c:4259 cote|saint louis", "c:426 cassett|jeannette", "c:426 quail|greenville", "c:4272 reid|swartz creek",
    "c:43054 judd|belleville", "c:431 bardstown|park city", "c:431 metcalf|lima", "c:4329 wood|chicago", "c:434 prospect|lima", "c:435 clay|memphis", "c:4400 alaska|st. louis", "c:4401 51st|detroit",
    "c:44073 bell|lisbon", "c:4500 dayton|jefferson twp", "c:4508 maypole|chicago", "c:4525 broadbush|dayton", "c:4625 lewis|toledo", "c:4718 ky-1809|barbourville", "c:4779 huntsman|decatur", "c:4815 winchester|chicago",
    "c:49 moore|ivy grove", "c:490 grand|galion", "c:494 jeffery|calumet city", "c:4952 sioux|mclouth", "c:5006 shoals|chattanooga", "c:5008 burt|montrose", "c:501 left|ivy grove", "c:502 4th|windber",
    "c:502 eliza|maquoketa", "c:504 main|weir", "c:505 columbia|bloomfield", "c:506 main|queen city", "c:51 pine|glenwood", "c:514 main|hoopeston", "c:515 hawk|ironton", "c:515 madison|madison",
    "c:5183 sauls|lachine", "c:5260 town|hale", "c:52680 summit|saint clairsville", "c:5300 peoria|chicago", "c:5331 ridge|saint louis", "c:5338 wood|chicago", "c:5362 broadway|cleveland", "c:53853 county rd 7|elkhart",
    "c:54193 quince|south bend", "c:551 bradford|clayton", "c:552 township|chesapeake", "c:5540 route 170|east palestine", "c:5613 dibble|cleveland", "c:5614 verona|verona", "c:5647 tyler|hubbardston", "c:56612 mcgee|shadyside",
    "c:568 loras|dubuque", "c:569 county rd 3|chesapeake", "c:573 bank|derry", "c:577 county rd 68|toronto", "c:578 county|matthews", "c:5840 90th|oak lawn", "c:58970 vocational|byesville", "c:592 dearborn|kankakee",
    "c:5960 bluebonnet|south fulton", "c:603 county rd 314|bellevue", "c:604 adams|sault sainte marie", "c:606 164th|south holland", "c:606 8th|three rivers", "c:606 franklin|kirksville", "c:612 brown|vine grove", "c:612 kimball|sault sainte marie",
    "c:6120 green|chicago", "c:614 constitution|new kensington", "c:6160 rollways|hale", "c:62 marathon|poplar bluff", "c:62 marquette|park forest", "c:621 elm|lima", "c:6217 carpenter|chicago", "c:623 brookside|piketon",
    "c:624 16th|davenport", "c:6321 rhodes|chicago", "c:6359 bells|acworth", "c:6395 2nd|brimley", "c:6414 gids|lithonia", "c:6551 ann|jackson", "c:669 41st|louisville", "c:67 wolf|east bernstadt",
    "c:6744 us-422|indiana", "c:6800 old|south fulton", "c:6825 maddox|morrow", "c:6830 us-60|morehead", "c:6830 us|morehead", "c:6853 new|rex", "c:6889 wayne|romulus", "c:69 orchard|park forest",
    "c:6921 normal|chicago", "c:6944 saddler|chase", "c:6948 morningview|andover", "c:697 caledonia|dubuque", "c:7020 skyview|acworth", "c:703 washington|queen city", "c:705 charles|trenton", "c:705 elm|lima",
    "c:71 oakwood|tullahoma", "c:710 linn|bay city", "c:711 walnut|north bend", "c:714 cedar|louisville", "c:71571 main|st clairsville", "c:717 case|johnstown", "c:720 7th|beaver city", "c:7207 airport|vanderbilt",
    "c:721 walnut|north bend", "c:7216 chicago|chicago", "c:722 laramie|chicago", "c:7237 stony|chicago", "c:724 broad|johnstown", "c:736 hopkins|augusta", "c:7521 ridgeland|chicago", "c:754 orchard|toledo",
    "c:769 railroad|windber", "c:788 fenelon|dubuque", "c:7946 muskegon|chicago", "c:804 elm|calumet", "c:807 fuller|fullerton", "c:809 liberty|oskaloosa", "c:810 minneapolis|sault sainte marie", "c:8145 attleboro|jonesboro",
    "c:815 blackhawk|university park", "c:819 summit|cincinnati", "c:820 von|johnstown", "c:825 commonwealth|west mifflin", "c:8287 dylan|joplin", "c:8318 manistee|chicago", "c:835 littlefield|weidman", "c:842 wayne|lima",
    "c:8507 may|chicago", "c:855 pleasant|manchester", "c:861 mountain|dahlonega", "c:866 cotton|manchester", "c:8719 enon|south fulton", "c:8744 aspen|mccordsville", "c:8995 100|jamestown", "c:9000 edinburg|winston",
    "c:904 monroe|mount ayr", "c:905 5th|clinton", "c:906 mott|new madrid", "c:907 1st|plattsmouth", "c:908 mott|new madrid", "c:9105 route 550|vincent", "c:9133 dahna|west olive", "c:915 crest|chickamauga",
    "c:917 8th|neodesha", "c:918 cimarron|gardner", "c:930 booth|dubuque", "c:930 james|knoxville", "c:942 rice|lima", "c:95 private|proctorville", "c:9510 whittier|detroit", "c:953 7th|new kensington",
    "c:957 orchard|greensburg", "c:9668 townsquare|fenton", "c:971 al|lake city", "c:9784 birmingham|fenton", "cb:P00800000HFhOZfPnEtVemFlPF8cru0gTLCAYMlg", "cb:P00800000HH3IIzJTTlv13Wa0pUaQg11j9Owi2D4", "cb:P00800000HHS9sSyxs1VFNMdCkbskbOHUsbnpxSA", "cb:P00800000HIrW15aeqTdcnTRrjw4NPn0zMFE5iID",
    "cb:P00800000HItMbKNuZXWVvPLi0a2gPyJk0TBFgOx", "cb:P00800000HIuC9RzFX2Oh9Zesbu87erLK4MRGAhB", "cb:P00800000HIwZae8s5C8BRPYIUzkfuIMWWIwMKlK", "cb:P00800000HJ0Nv0umzXVxI7l4TUORQcBcFn28aZW", "cb:P00800000HJ1ZbBbU0sZLkpXolEKc40Pg9PLCs4Y", "cb:P00800000HJ69SgzYLzdzpRyhN4FXuPCm9dyuhzz", "cb:P00800000HJ9DveURKkwmyyt2nYkyUm75VdAHIBm", "cb:P00800000HJ9EtipSGdwOFsvP2QBv50RacXnVi6w",
    "cb:P00800000HJ9hc8LKb013zgrg6qik7UeT9k4sj3Q", "cb:P00800000HJAVaf04zM67ExlfAkWK9JaAWU98aYp", "cb:P00800000HJDwhm1kk9RoECDn3MbW8PDmV1TgbeR", "cb:P00800000HJMPtYao4bXqYIRufPTwT6V4dBJ8hE0", "cb:P00800000HJW2v51cgTnUHKB2DxFMiKBtEuQtiwl", "cb:P00800000HJWApU8glvZTs0MvZsYlFycHBuysHPs", "cb:P00800000HJaIoNGCja5Vcshml3LZni1o7EpBQmo", "cb:P00800000HJcZZ4am5B6lrcc0iDR4E6Iy7iuTCwm",
    "cb:P00800000HJd0XcDgPqpm9HWYOknwSFcozQWJjTe", "cb:P00800000HJd0YBbapR8utgVFc0Bc6D8GJxwi8un", "cb:P00800000HJfeK0jp3t8VaqMJN1T9cBwHlBh70fa", "cb:P00800000HJfnjIrioOeiUasdkZfcIkFG3NfxQqY", "cb:P00800000HJgDhCv1M2zz8XLgjdO1XqYNF2MYXxa", "cb:P00800000HJgRw8Vbl0bGxnpwIR27b6ckEiqBt3e", "cb:P00800000HJgRwQCYxnkqL0KHu3ixQ5R332O1v2S", "cb:P00800000HJgjHP3pEKF70qF4rqLZqhMl6khsrqL",
    "cb:P00800000HJk4tVALPi7zoLkkZinwF1Q8l3GPqJu", "cb:P00800000HJmLNDm5z8SoHbXEvFmhF7SwJCTGWrg", "cb:P00800000HJqcEjCAZWKDafLWV1fGpE7rRupeYO3", "cb:P00800000HJr9avv6UQZnE7wG4Iy2blJkGAGDlxu", "cb:P00800000HJsQVzszvNsGEg0lk1UosZEeJvCp3H2", "cb:P00800000HJwKZDgNuai0vNttp1GxNAgOpBjMlpk", "cb:P00800000HJzo4a89MFkbole4SKHN1EClDNALUlM", "cx:2309078",
    "cx:2431276", "cx:2431277", "cx:2477640", "cx:2518678", "cx:2558367", "cx:2614984", "cx:2639143", "cx:2642446",
    "cx:2656092", "cx:2667021", "cx:2668702", "cx:2673328", "cx:2673329", "cx:2677154", "cx:2688426", "cx:2695200",
    "cx:2722080", "cx:2724106", "cx:2726307", "cx:2727023", "cx:2733593", "cx:2744644", "cx:2745161", "cx:2747280",
    "cx:2750126", "cx:2755812", "cx:2758061", "cx:2759586", "cx:2759597", "cx:2759667", "cx:2762384", "cx:2762568",
    "cx:2762601", "cx:2763178", "cx:2764782", "cx:2765823", "cx:2766573", "d:0 elfinwild rd|15101", "d:0 larimer ave|15137", "d:0 tin can hollow rd|15357",
    "d:00 160th st|64620", "d:1 e 145th st|60426", "d:1 malden rd|15417", "d:10 oak st|45780", "d:100 chaucer 116|44035", "d:100 chaucer ct 116|44035", "d:100 chaucer ct|44035", "d:100 chaucer|44035",
    "d:100 n van kirk st|50452", "d:1003 e patricia st|64744", "d:1007 locke dr dr|30721", "d:101 kelly s ct|50436", "d:101 kellys ct|50436", "d:1013 stone st|68355", "d:102 kelly s ct|50436", "d:102 kellys ct|50436",
    "d:1020 e ct st|60901", "d:1021 big sandy creek ln|30650", "d:10220 s indiana ave|60628", "d:1027 winfield ave|45205", "d:10270 route 550|45784", "d:10270 state route 550|45784", "d:103 marion ave|44903", "d:1031 1033 euclid ave|40208",
    "d:104 106 s depot st|15666", "d:104 s prospect st|52060", "d:1045 peyton rd sw|30311", "d:10465 chalk bluff way|63841", "d:105 kelly s ct|50436", "d:105 kellys ct|50436", "d:105 pawn dr|30116", "d:106 s pine st|60918",
    "d:10640 e brook rd|63023", "d:10694 e route 762|43137", "d:10694 e state route 762|43137", "d:107 king st|64440", "d:107 redbud ln|15650", "d:108 bay st|66716", "d:10801 s hoxie ave|60617", "d:10828 massasoit ave|60415",
    "d:10882 chase bridge rd|48653", "d:110 forestdale park|60409", "d:110 hummel st|15902", "d:110 s plummer ave|66720", "d:1100 route 119 hwy n|15701", "d:1100 route highway 119 n|15701", "d:1107 sherman st|68949", "d:1109 fox den rd|30815",
    "d:111 county rd 737|37309", "d:111 e chestnut st 2b 8|60611", "d:112 dawson ave|63862", "d:112 n 13th st|66534", "d:112 n 2nd st|66523", "d:112 n second st|66523", "d:113 danko ln|15601", "d:114 victory dr|30421",
    "d:1146 n elm st|52501", "d:115 belmont farms dr|30294", "d:115 ccc bottom rd|40447", "d:116 n haynes ave|52544", "d:116 quapaw st|63877", "d:116 w union st|60518", "d:11635 s laflin st|60643", "d:1164 martin rd|15725",
    "d:117 n main st|64628", "d:1170 w goodfarm rd|60420", "d:1179 s schuyler ave|60901", "d:1182 cleveland mill rd|30643", "d:120 122 chapin st|15909", "d:12010 derby ave|44125", "d:1207 grove ave|50841", "d:121 maple st|30471",
    "d:1217 vaughn rd|30223", "d:1219 w spring st|45805", "d:1224 n franklin st|63501", "d:1228 w 74th pl|60636", "d:123 w 4th st|66441", "d:12455 brown ridge rd|40351", "d:1249 myrna st|43512", "d:12620 s racine ave|60827",
    "d:127 mckinley ave|63940", "d:13 crawford st|45044", "d:130 old franks mill rd|42141", "d:1303 meadows ln|30474", "d:1304 independence ave|68850", "d:1304 s karlov ave|60623", "d:13058 kevin ln|44024", "d:1307 park st|49783",
    "d:1328 se 19th st|66607", "d:133 ambrose cir|30233", "d:1332 braden ave|50049", "d:136 hatfield rd|15480", "d:137 brix dr|30248", "d:137 woodbrier dr|42164", "d:139 peach st|60466", "d:13936 locust st|43144",
    "d:13982 cherrylawn st|48238", "d:14 w hillcrest rd|15330", "d:1401 n ewing st|46201", "d:14067 cherrylawn st|48238", "d:141 whitethorne ave|43223", "d:14117 lincoln ave|60419", "d:14197 new quest ln|63841", "d:142 franklin ave|15061",
    "d:1425 stanley blvd|60409", "d:14505 minerva ave|60419", "d:14637 kenwood ave|60419", "d:1487 dutch valley rd|37716", "d:14882 hammansburg rd|45872", "d:14910 s wood st|60426", "d:15 colchester dr|63135", "d:1503 sw washburn ave|66604",
    "d:15036 blackstone ave|60419", "d:1515 s 4th st|45638", "d:1515 south 4th st|45638", "d:1526 schrauder rd|15212", "d:1534 9th st|50314", "d:1534 grant st|15104", "d:1539 e 34th st|44114", "d:1539 east 34th st|44114",
    "d:15436 s airport rd|48906", "d:1551 s kings highway|64854", "d:1551 s kings hwy|64854", "d:1553 friendship church rd|30458", "d:15538 turlington ave|60426", "d:158 w river rd|68850", "d:1589 fairview highway|48813", "d:1589 fairview hwy|48813",
    "d:16 hemphill rd|30747", "d:1605 valley ave|68355", "d:16051 gauger ave|60426", "d:16210 laflin ave|60428", "d:16236 s lathrop ave|60428", "d:1625 hudson ave|66503", "d:1629 hyder ave|37660", "d:163 n ave|49017",
    "d:163 north ave|49017", "d:163 s foster|44902", "d:1632 birch dr|48632", "d:1645 jackson ave|50525", "d:16581 chillicothe rd|44023", "d:1699 new hope rd|30248", "d:17 james ln|45701", "d:1701 s harrison st|46001",
    "d:1703 ayodhya ave|52556", "d:1703d kosola 2 ave|52556", "d:1703d kosola ave|52556", "d:1705 ayodhya 2 upper two apts ave|52556", "d:1705 ayodhya two ave|52556", "d:1705 w 5th st|45402", "d:171 ebensburg rd|15901", "d:17195 17197 stoepel st|48221",
    "d:1724 e mercer dr|30223", "d:17318 walter st|60438", "d:1733 bethsaida rd|30296", "d:1734 mills st|44870", "d:1737 brook run dr|30452", "d:17607 stonebridge dr|60429", "d:1762 poplar st|45662", "d:1806 william penn ave|15909",
    "d:1883a greenbriar rd|45662", "d:189 gentry ln|40759", "d:1893 lanark ct|49240", "d:1894 e 81st st|44103", "d:1909 and 1911 front st|66739", "d:1915 green valley dr|63136", "d:1916 218th st|60411", "d:1921 highway 1804|40769",
    "d:1921 state highway 1804|40769", "d:193 greentree dr|43950", "d:1944 massieville rd|45601", "d:19548 county rd 414|63852", "d:1963 greenbush w rd|45176", "d:1963 greenbush west rd|45176", "d:1969 corners cir|30058", "d:1979 bloomfield rd|40069",
    "d:201 ct st n|48658", "d:201 w page st|63382", "d:20120 keystone ave|60443", "d:2020 sagamore dr|44117", "d:203 1st ave s|50529", "d:203 main st 3|15486", "d:203 main st|15486", "d:203 n poplar st|46911",
    "d:2034 jackson st|52001", "d:204 s 5th st|66771", "d:205 e idalia rd|63825", "d:205 vardell pl|63857", "d:2052 stivers ave|45101", "d:206 benefield dr|30553", "d:206 benifield dr|30553", "d:2068 sitser ln|30349",
    "d:207 tudor ln|15205", "d:208 witt rd|15545", "d:209 e washington st|60948", "d:209 w john st|49868", "d:2096 s 2500 rd|64783", "d:210 pittsburgh grade rd|15050", "d:210 w main st|45807", "d:21107 e 4th st s|64056",
    "d:2115 pine knoll cir ne|30013", "d:2123 grand ave|40210", "d:2123 n 33rd st|53208", "d:2133 central ave|52001", "d:2139 central ave|52001", "d:2149 morningside dr|66801", "d:215 church st|50456", "d:216 8th ave s|52732",
    "d:218 doerzbach ave|44870", "d:2185 enon rd sw|30331", "d:2208 albemarle dr|30906", "d:221 park hill dr|30241", "d:222 w church st|30401", "d:2224 howard alexander rd|30421", "d:225 s orchard dr|60466", "d:225 w 4th st|46173",
    "d:227 early st|60466", "d:22710 highway 80|53581", "d:22710 hwy 80|53581", "d:22710 state hwy 80|53581", "d:2274 washington st|52001", "d:2282 baltimore ave|45225", "d:22911 bruce dr|60471", "d:22951 chippewa st|48219",
    "d:23 grace ln|40140", "d:230 234 n woodlawn ave|45805", "d:2315 s maywood ave|64052", "d:2316 s lake sharon rd|46580", "d:2329 melody ln|48509", "d:2418 wetters rd|48708", "d:24207 hemlock cir|48118", "d:2431 ivydale dr sw|30311",
    "d:247 w glendale st|44146", "d:25 27 6th st nw|50401", "d:250 n hammes ave|60901", "d:2510 morris creek rd|40380", "d:2514 reid ave|44052", "d:2518 bellview ln|30582", "d:2518 whitemore pl|48602", "d:2531 n 14th st|63901",
    "d:2570 e f30 rd|48745", "d:26 ebenezer church rd|30401", "d:26 leanne dr|30643", "d:2626 nordholme ave|46805", "d:26813 osage dr|64866", "d:26854 s woodlawn ave|60417", "d:2727 106th ave|49010", "d:275 normandy dr|49265",
    "d:2754 w main st|40212", "d:276 oak dr|37381", "d:2800 bender rd|45750", "d:2815 deans bridge rd|30906", "d:2820 river rd|50126", "d:2829 ganymedes ct|63020", "d:28615 n state rd 19|46031", "d:2876 mcguffey rd|43224",
    "d:2916 philadelphia dr|45405", "d:2916 philadelphia|45405", "d:2919 w market st|40212", "d:2934 cromwell dr|44052", "d:29515 charles st|48174", "d:2957 2959 mcguffey rd|43224", "d:3 desdemona|15232", "d:3012 keysville rd|30815",
    "d:3029 constitution blvd 51|15010", "d:3029 constitution blvd lot rt 51|15010", "d:3038 223rd st|60411", "d:3041 sherwood ave|60428", "d:305 307 w 4th st|63873", "d:305 n broadway st|45887", "d:305 s chestnut st|50129", "d:307 s mulberry st|52585",
    "d:307 xenia ave|45410", "d:309 cosby highway|37821", "d:309 cosby hwy|37821", "d:309 johnston st|49783", "d:310 river oak dr|30274", "d:310 w s st|63545", "d:310 w south st|63545", "d:310 wick st|66939",
    "d:3105 harris rd|63628", "d:311 e harrison st|63501", "d:3126 w jones lake rd|49738", "d:313 311 n 4th st|43812", "d:313 old highway 2|52542", "d:313 old hwy 2|52542", "d:3135 burr st|46406", "d:3135 s burr st|46406",
    "d:314 e university ave|45810", "d:314 s main st|46911", "d:316 s bullock st|48770", "d:320 whyte st|48650", "d:3240 benjamin e mays dr sw|30311", "d:32755 dexter rd 10 rd unit county|45775", "d:32755 dexter rd 10 rd|45775", "d:32755 dexter rd|45775",
    "d:329 elm st|66861", "d:329 w main st|48740", "d:3305 s coville rd|48745", "d:332 rainbow dr|30741", "d:33259 orchard st|49043", "d:3341 spore brandywine rd|44820", "d:3345 old horton bay rd|49712", "d:335 oakwood st|60466",
    "d:3355 wedgewood dr|30909", "d:336 153rd pl|60409", "d:340 ridge st|49783", "d:340 w 60th pl|60621", "d:3401 main st|64030", "d:3415 copper ridge rd|37814", "d:34600 s route f highway|64747", "d:34600 s state route f hwy|64747",
    "d:351 w main st|49795", "d:3583 austin rd 9|44041", "d:3583 austin rd|44041", "d:3590 e 108th st|44105", "d:3591 route 131|45118", "d:3591 state route 131|45118", "d:3594 bennetts landing rd|30442", "d:3616 morgan rd|30815",
    "d:3624 terrace hill dr ne|52402", "d:369 371 s 3rd ave s|60901", "d:371 jarvis branch rd|40906", "d:375 winona st|60466", "d:3750 pebble beach dr|30349", "d:3751 3753 briggs rd|43228", "d:376 penn ave|15631", "d:3814 saint lawrence ave|45205",
    "d:3814 st lawrence ave|45205", "d:3819 sunnyside ave|52802", "d:389 391 e 2nd st|45601", "d:389 spring house ln|40229", "d:392 pine mountain rd|30153", "d:3985 demooney rd|30349", "d:39973 n 770 e rd|60960", "d:39973 n 770 east rd|60960",
    "d:4 house package|45804", "d:40 2nd st|44875", "d:402 richmond st|52501", "d:402 s market st|64482", "d:4030 brydle rd|44048", "d:404 n 10th st|52544", "d:404 oak dr|60962", "d:404 s 3rd st|50158",
    "d:407 e n st|63537", "d:407 e north st|63537", "d:407 main st|50258", "d:407 northside dr|30223", "d:407 s ottawa st|60518", "d:408 e washington st|60942", "d:408 sauk trl|60466", "d:409 n main st|63537",
    "d:409 s center st|63468", "d:4095 kirk rd|44511", "d:41 spring st|44890", "d:4101 willow ridge rd|30135", "d:412 e main st|60942", "d:412 main st|52035", "d:416 1st st|50585", "d:416 s dodge st|52240",
    "d:417 arbor rd|44108", "d:417 w jefferson st|60435", "d:419 felch st|48851", "d:4191 sun valley blvd|30344", "d:4202 4206 kansas ave|68111", "d:422 e ash st|60970", "d:424 426 cassett ave|15644", "d:425 maple dr|44827",
    "d:425 spring rd|15417", "d:4257 n 53rd st|53216", "d:4259 w cote brilliante ave|63113", "d:426 quail dr|30222", "d:4272 reid rd|48473", "d:43054 judd rd|48111", "d:431 bardstown rd|42160", "d:431 n metcalf st|45801",
    "d:4329 s wood st|60609", "d:434 prospect ave|45804", "d:435 n clay st|63555", "d:4400 alaska ave|63111", "d:4401 03 51st st 2|48210", "d:4401 03 51st st|48210", "d:44073 bell rd|44432", "d:4500 dayton liberty rd|45417",
    "d:4508 w maypole ave|60624", "d:4525 broadbush dr|45426", "d:4625 lewis ave|43612", "d:4718 ky 1809|40906", "d:4779 huntsman bnd|30034", "d:4815 s winchester ave|60609", "d:49 moore creek rd|40939", "d:490 grand st|44833",
    "d:494 jeffery ave|60409", "d:4952 sioux ct|66054", "d:5006 shoals ln|37416", "d:5008 w burt rd|48457", "d:501 left fork moore creek rd|40939", "d:502 4th st|15963", "d:502 s eliza st|52060", "d:504 e main st|66781",
    "d:505 n columbia st|52537", "d:506 main st|63561", "d:51 n pine ln|60425", "d:514 e main st|60942", "d:515 hawk st st|45638", "d:515 hawk st|45638", "d:515 w madison st|66860", "d:5183 sauls rd|49753",
    "d:5260 town hall rd|48739", "d:5260 townhall rd|48739", "d:52680 summit ave|43950", "d:5300 s peoria st|60609", "d:5331 ridge ave|63112", "d:5338 s wood st|60609", "d:5362 broadway ave|44127", "d:53853 county rd 7|46514",
    "d:54193 quince rd|46628", "d:551 bradford rd|30525", "d:552 township rd 158|45619", "d:5540 route 170|44413", "d:5540 state route 170|44413", "d:5613 dibble ave|44103", "d:5614 verona rd|15147", "d:5647 tyler|48845",
    "d:56612 mcgee rd|43947", "d:568 loras blvd|52001", "d:569 county rd 3|45619", "d:573 s bank st|15627", "d:577 county rd 68|43964", "d:578 county highway 610|63867", "d:5840 w 90th st|60453", "d:58970 vocational rd|43723",
    "d:592 n dearborn ave|60901", "d:5960 bluebonnet cir|30349", "d:603 county rd 314|44811", "d:603 cr 314|44811", "d:604 adams ave|49783", "d:606 8th st|49093", "d:606 e 164th pl|60473", "d:606 s franklin st|63501",
    "d:612 brown st|40175", "d:612 kimball st|49783", "d:6120 s green st|60621", "d:614 constitution blvd|15068", "d:6160 rollways rd|48739", "d:62 marathon ln|63901", "d:62 marquette st|60466", "d:621 w elm st|45801",
    "d:6217 s carpenter st|60621", "d:623 brookside dr|45661", "d:624 w 16th st|52803", "d:6321 s rhodes ave|60637", "d:6359 bells ferry rd|30102", "d:6395 s 2nd st|49715", "d:6414 gids ct|30058", "d:6551 ann arbor rd|49201",
    "d:669 s 41st st|40211", "d:67 wolf bnd|40729", "d:6744 us 422|15701", "d:6800 old national highway|30349", "d:6800 old national hwy|30349", "d:6825 maddox rd|30260", "d:6830 us 60|40351", "d:6830 us highway 60 w|40351",
    "d:6853 new dale rd|30273", "d:6889 wayne rd|48174", "d:6889 wayne|48174", "d:69 s orchard dr|60466", "d:6921 s normal blvd|60621", "d:6944 s saddler rd|49623", "d:6948 morningview dr|44003", "d:697 caledonia pl|52001",
    "d:7020 skyview ct se|30102", "d:703 washington st|63561", "d:705 charles st|45067", "d:705 w elm st|45801", "d:71 oakwood ln|37388", "d:710 n linn st|48706", "d:711 721 walnut st|68649", "d:714 cedar grove ct 1 4|40212",
    "d:714 cedar grove ct|40212", "d:71571 main st|43950", "d:717 case ave|15905", "d:720 7th st|68926", "d:7207 airport rd|49795", "d:7216 s s chicago ave|60619", "d:7216 s south chicago ave|60619", "d:722 n laramie ave|60644",
    "d:7237 s stony island ave|60649", "d:724 broad st|15906", "d:736 hopkins st|30901", "d:7521 s ridgeland ave|60649", "d:754 orchard st|43609", "d:769 railroad st|15963", "d:788 fenelon pl|52001", "d:7946 s muskegon ave|60617",
    "d:804 elm st|49913", "d:807 fuller st|68638", "d:809 liberty st|66066", "d:810 minneapolis st|49783", "d:8145 attleboro dr|30238", "d:815 blackhawk dr|60484", "d:819 summit ave|45204", "d:820 von lunen rd|15902",
    "d:825 commonwealth ave|15122", "d:8287 dylan ln|64804", "d:8318 s manistee ave|60617", "d:835 n littlefield rd|48893", "d:842 w wayne st|45801", "d:8507 s may st|60620", "d:855 pleasant grove loop|40962", "d:861 mountain ridge dr|30533",
    "d:866 cotton bend rd|40962", "d:8719 enon rd|30331", "d:8744 n aspen way|46055", "d:8995 w 100 s|46147", "d:9000 edinburg dr|30187", "d:904 e monroe|50854", "d:905 s 5th st|52732", "d:906 908 mott st|63869",
    "d:906 908 mott|63869", "d:907 s 1st st|68048", "d:9105 route 550|45784", "d:9105 state route 550|45784", "d:9133 dahna dr|49460", "d:915 crest dr|30707", "d:917 n 8th st|66757", "d:918 cimarron trl|66030",
    "d:930 james rd|37914", "d:930 n booth st|52001", "d:942 rice ave|45805", "d:95 private dr 64|45669", "d:9510 whittier st|48224", "d:953 7th st ext|15068", "d:957 orchard ave|15601", "d:9668 townsquare blvd|48430",
    "d:971 n al moses rd|49651", "d:971 n al moses|49651", "d:9784 birmingham dr|48430", "d:address withheld by seller|44851", "d:applewood dr|15068", "d:chicago|60623", "d:clear run rd peninsula estates|15926", "d:cleveland|44103",
    "d:lot 254 clear run rd peninsula estates|15926", "d:lot 9 applewood dr|15068", "d:ne 232 st|64493", "d:parcel a beighley rd|15613", "d:stivers ave|45101", "d:tbd nickel ave|64620", "il:319153", "il:340419",
    "pw:161784", "pw:243936", "pw:257242", "pw:270869", "pw:275526", "pw:280684", "pw:291683", "pw:505655",
    "pw:613935", "pw:760630", "rf:101144470", "rf:102216473", "rf:102674417", "rf:102680432", "rf:102688156", "rf:102766640",
    "rf:103368016", "rf:107106854", "rf:107544609", "rf:111878020", "rf:114355553", "rf:116445366", "rf:116643144", "rf:116755421",
    "rf:117362670", "rf:117581410", "rf:117919944", "rf:118269177", "rf:118966042", "rf:119068376", "rf:119993256", "rf:121601492",
    "rf:123513552", "rf:124242478", "rf:124757353", "rf:126125487", "rf:127501797", "rf:128087729", "rf:128111938", "rf:128316857",
    "rf:128541053", "rf:12854941", "rf:12861029", "rf:12863507", "rf:12873637", "rf:12897602", "rf:128996653", "rf:12915299",
    "rf:12917884", "rf:129296374", "rf:129302136", "rf:12940833", "rf:12952732", "rf:12967494", "rf:130324427", "rf:130494703",
    "rf:13065847", "rf:131138590", "rf:131432652", "rf:13178847", "rf:131930953", "rf:13215380", "rf:132595932", "rf:133920317",
    "rf:133928923", "rf:134014462", "rf:135910433", "rf:135993139", "rf:136023326", "rf:137191293", "rf:137780686", "rf:138131222",
    "rf:139048334", "rf:139076316", "rf:13929860", "rf:13955371", "rf:141688425", "rf:141798045", "rf:141900376", "rf:141990281",
    "rf:142010107", "rf:142093712", "rf:142108471", "rf:142115502", "rf:142143211", "rf:142487673", "rf:142490509", "rf:142655690",
    "rf:142684584", "rf:162277755", "rf:162830065", "rf:163152095", "rf:163358154", "rf:180454232", "rf:182858396", "rf:183856652",
    "rf:188492695", "rf:18930443", "rf:190973899", "rf:191592378", "rf:192515892", "rf:193047294", "rf:194567110", "rf:195645877",
    "rf:196725648", "rf:198528110", "rf:199615392", "rf:199863140", "rf:199873269", "rf:200517542", "rf:200690627", "rf:201268441",
    "rf:201418633", "rf:201782128", "rf:202569264", "rf:202669424", "rf:203174577", "rf:203188245", "rf:203373359", "rf:204590450",
    "rf:204597472", "rf:204636904", "rf:205329040", "rf:205333560", "rf:205540845", "rf:205970207", "rf:205994598", "rf:206197765",
    "rf:206610826", "rf:206634897", "rf:206691035", "rf:206691036", "rf:206723488", "rf:206757896", "rf:23299335", "rf:23691045",
    "rf:23710687", "rf:23731753", "rf:23803986", "rf:23945507", "rf:24105509", "rf:24132539", "rf:24147965", "rf:24224097",
    "rf:24227179", "rf:24234260", "rf:24383264", "rf:24410208", "rf:24415170", "rf:24834102", "rf:24852124", "rf:25157482",
    "rf:25182893", "rf:25184388", "rf:25188306", "rf:25191743", "rf:25207286", "rf:25224839", "rf:25256065", "rf:26851723",
    "rf:57762506", "rf:60551289", "rf:62933820", "rf:63982078", "rf:64145660", "rf:66564708", "rf:66653320", "rf:67035376",
    "rf:67036983", "rf:69197318", "rf:69245508", "rf:69251868", "rf:69280203", "rf:69996004", "rf:70075055", "rf:70215635",
    "rf:70412783", "rf:70418648", "rf:70568211", "rf:70575238", "rf:70577045", "rf:70756915", "rf:70767392", "rf:70790144",
    "rf:71916576", "rf:72099166", "rf:72112111", "rf:73458883", "rf:75347326", "rf:75948212", "rf:76316827", "rf:76926322",
    "rf:77049358", "rf:77068999", "rf:77105449", "rf:77117582", "rf:77135171", "rf:77791408", "rf:77798240", "rf:78036027",
    "rf:78152804", "rf:79768364", "rf:79946729", "rf:80120042", "rf:81594207", "rf:81661584", "rf:82048589", "rf:82539550",
    "rf:82646319", "rf:82692920", "rf:82698865", "rf:83101712", "rf:83507904", "rf:83623904", "rf:83629760", "rf:83677500",
    "rf:83678511", "rf:84360829", "rf:84469553", "rf:84525087", "rf:84537936", "rf:87240114", "rf:90692659", "rf:90838495",
    "rf:90890498", "rf:90966665", "rf:93825562", "rf:95686468", "rf:96138528", "rf:96880602", "rf:97473816", "rf:97752539",
    "rf:97784542", "rf:97803943", "rf:97891646", "rf:97912700", "rf:97916886", "rf:98067698", "rf:98577257", "rf:98922655",
    "rf:98929122", "rf:99809762", "rl:M30572-93043", "rl:M31528-53833", "rl:M31741-83099", "rl:M33293-29962", "rl:M33582-01132", "rl:M33964-90711",
    "rl:M34569-81190", "rl:M34850-61276", "rl:M35726-95061", "rl:M37557-23849", "rl:M37757-24900", "rl:M38332-41443", "rl:M39594-33859", "rl:M41399-51612",
    "rl:M41891-90103", "rl:M42849-47495", "rl:M43330-44254", "rl:M46894-03267", "rl:M48900-35396", "rl:M49107-00570", "rl:M65709-31962", "rl:M67399-10267",
    "rl:M69264-73725", "rl:M70470-20055", "rl:M70926-20118", "rl:M71033-56746", "rl:M71182-15707", "rl:M73254-69404", "rl:M74055-47436", "rl:M74161-21025",
    "rl:M74482-01776", "rl:M74493-45615", "rl:M74574-95117", "rl:M74710-79916", "rl:M75045-82701", "rl:M75175-19914", "rl:M75437-94144", "rl:M77286-24201",
    "rl:M77744-17107", "rl:M77930-61540", "rl:M78144-18045", "rl:M78218-66126", "rl:M78696-26452", "rl:M78720-69832", "rl:M79140-78548", "rl:M80114-41860",
    "rl:M80656-32838", "rl:M80940-19304", "rl:M80969-90585", "rl:M80998-61347", "rl:M81682-26283", "rl:M81912-55564", "rl:M82809-92720", "rl:M84317-91296",
    "rl:M84401-29666", "rl:M85174-13451", "rl:M85576-57857", "rl:M85606-83980", "rl:M86105-24780", "rl:M86740-78253", "rl:M86920-81219", "rl:M87203-49958",
    "rl:M87842-28858", "rl:M88289-55141", "rl:M88373-35455", "rl:M88436-23250", "rl:M88519-72776", "rl:M91000-34289", "rl:M91826-69918", "rl:M92160-32937",
    "rl:M92169-87479", "rl:M93279-97398", "rl:M94522-65503", "rl:M94819-01414", "rl:M95039-31791", "rl:M95464-17614", "rl:M95727-67015", "rl:M97273-13893",
    "rl:M97418-58436", "z:105966115", "z:10626434", "z:106289587", "z:106307785", "z:106307811", "z:106309851", "z:106571347",
    "z:108947343", "z:108951837", "z:110996468", "z:112025377", "z:113535962", "z:113537883", "z:113863243", "z:115509590",
    "z:115967869", "z:117952307", "z:118155653", "z:123778548", "z:123780969", "z:123807042", "z:123900453", "z:126775799",
    "z:127066363", "z:127066980", "z:128524209", "z:140961613", "z:14948763", "z:194135804", "z:194572542", "z:194830939",
    "z:2060971602", "z:2064888996", "z:2070428702", "z:2079345634", "z:2085141582", "z:2087075477", "z:209561277", "z:2096452174",
    "z:2098804547", "z:226780600", "z:2318055", "z:246806338", "z:2963109", "z:2965881", "z:33118011", "z:33118654",
    "z:33121729", "z:33123800", "z:33127572", "z:33853457", "z:341226954", "z:34240326", "z:34240934", "z:34242998",
    "z:34262764", "z:35079911", "z:35097601", "z:353736523", "z:40462588", "z:41643897", "z:4287844", "z:4314721",
    "z:4331947", "z:441050323", "z:441101322", "z:450896747", "z:456209232", "z:463144879", "z:463212405", "z:463470528",
    "z:463679544", "z:464414586", "z:464586171", "z:464629247", "z:464778701", "z:464893128", "z:465032319", "z:465675291",
    "z:465793328", "z:465948745", "z:465979385", "z:466046795", "z:466142131", "z:466222247", "z:50158265", "z:50167356",
    "z:50168214", "z:50169536", "z:53721843", "z:55509104", "z:73456133", "z:73540402", "z:73583619", "z:76622448",
    "z:76793688", "z:76840230", "z:78541420", "z:789408", "z:86629931", "z:86946100", "z:87003618", "z:91177624",
    "z:91229705", "z:91255849", "z:95263319",
  ]);
  const sheetKeys = function sheetKeys(address, zip, url) {
    const keys = [];
    const addr = String(address ?? "");
    const firstPart = addr.split(",")[0].toLowerCase().replace(/['’]/g, "");
  
    // Strip unit/apt/ste/suite/#/lot/space from street line for base address matching
    let cleanStreet = firstPart
      .replace(/\b(?:apt|unit|ste|suite|lot|space|spc)\s*#?[\w-]+/gi, "")
      .replace(/#\s*[\w-]+/g, "")
      .replace(/[.#]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  
    // Canonicalize rural routes and directionals so the same property matches
    // no matter how a site spells it:
    //   "CR 653" / "County Road 653"            → "county rd 653"
    //   "20006 59 Hwy" / "20006 Highway 59"     → "20006 highway 59"
    //   "Saint Andrews Walk" / "St Andrews Walk" → "st andrews walk"
    cleanStreet = cleanStreet
      .replace(/\bsaint\b/gi, "st")
      .replace(/\bcounty\s+(?:road|rd)\b/gi, "county rd")
      .replace(/\bcty\s+(?:road|rd)\b/gi, "county rd")
      .replace(/\bcr\b/gi, "county rd")
      .replace(/\bstate\s+(?:route|rte|rt)\b/gi, "route")
      .replace(/\bstate\s+(?:hwy|highway)\b/gi, "highway")
      .replace(/\b(?:sr|rte|rt)\b/gi, "route")
      .replace(/\bhwy\b/gi, "highway")
      // Put the route number after the word ("59 Hwy" → "Highway 59"), but
      // leave a leading house number alone ("100 Route 66" stays intact).
      .replace(/(\s)(\d+)\s+(highway|route)\b/gi, "$1$3 $2")
      .replace(/\b(?:northeast|north-east)\b/gi, "ne")
      .replace(/\b(?:northwest|north-west)\b/gi, "nw")
      .replace(/\b(?:southeast|south-east)\b/gi, "se")
      .replace(/\b(?:southwest|south-west)\b/gi, "sw")
      .replace(/\bnorth\b/gi, "n")
      .replace(/\bsouth\b/gi, "s")
      .replace(/\beast\b/gi, "e")
      .replace(/\bwest\b/gi, "w")
      .replace(/\s+/g, " ")
      .trim();
  
    // House number (including Wisconsin grid "W10004", ranges "230-234", "906 & 908")
    const m = cleanStreet.match(/^\s*([a-z]?\d+)[a-z]?(?:\s*(?:-|&|and)\s*([a-z]?\d+)[a-z]?)?\s+(.*)$/);
    const z = (String(zip ?? "").match(/\d{5}/) || addr.match(/\b(\d{5})(?:-\d{4})?\s*$/) || [])[0];
    let word = m && m[3].split(/\s+/).find((w) => w && !/^(n|s|e|w|ne|nw|se|sw|north|south|east|west)$/.test(w));
    // Route addresses must keep the designator in the loose key, otherwise every
    // county road / highway with the same house number in a ZIP would collide.
    const route = m && m[3].match(/^((?:county\s+rd)|highway|route)\s+([a-z0-9]+)/i);
    if (route) {
      const designator = route[2].toLowerCase()
        .replace(/^(?:street|st)$/, "st")
        .replace(/^(?:avenue|ave)$/, "ave")
        .replace(/^(?:road|rd)$/, "rd")
        .replace(/^(?:boulevard|blvd)$/, "blvd")
        .replace(/^(?:drive|dr)$/, "dr")
        .replace(/^(?:lane|ln)$/, "ln")
        .replace(/^(?:court|ct)$/, "ct")
        .replace(/^(?:place|pl)$/, "pl");
      word = `${route[1].toLowerCase().replace(/\s+/g, " ")} ${designator}`;
    } else if (word === "st") {
      // "St Andrews" (Saint) needs the next word, or every St* street with the
      // same house number would share one key.
      const parts = m[3].split(/\s+/).filter(Boolean);
      const next = parts[parts.indexOf("st") + 1];
      if (next) word = `st ${next}`;
    }
    // Both ends of a range, so "7032-7034 NW Winter Ave" matches "7034 NW Winter Ave".
    const houses = m ? [m[1], m[2]].filter(Boolean) : [];
    if (word && z) for (const h of houses) keys.push(`a:${h} ${word}|${z}`);
  
    // Same house + street + city: catches sheet rows saved with a wrong/missing ZIP
    const city = (addr.split(",")[1] || "").trim().toLowerCase();
    if (word && city) for (const h of houses) keys.push(`c:${h} ${word}|${city}`);
  
    // Normalized street token (matches AduDedupeKey format: e.g. "17191 sagamore rd|44146")
    if (z && cleanStreet) {
      const normStreet = cleanStreet
        .replace(/\b(?:street|st)\.?\b/gi, "st")
        .replace(/\b(?:avenue|ave)\.?\b/gi, "ave")
        .replace(/\b(?:road|rd)\.?\b/gi, "rd")
        .replace(/\b(?:boulevard|blvd)\.?\b/gi, "blvd")
        .replace(/\b(?:drive|dr)\.?\b/gi, "dr")
        .replace(/\b(?:lane|ln)\.?\b/gi, "ln")
        .replace(/\b(?:court|ct)\.?\b/gi, "ct")
        .replace(/\b(?:place|pl)\.?\b/gi, "pl")
        .replace(/\b(?:way)\.?\b/gi, "way")
        .replace(/[^a-z0-9\s]/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (normStreet) keys.push(`d:${normStreet}|${z}`);
    }
  
    // Listing platform URL IDs
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
    const cb = u.match(/coldwellbanker\.com\/.*\/lid-([A-Za-z0-9]+)/);
    if (cb) keys.push(`cb:${cb[1]}`);
    const pw = u.match(/propwire\.com\/(?:realestate\/[^/]+\/|property\/)(\d+)/);
    if (pw) keys.push(`pw:${pw[1]}`);
  
    return keys;
  };
  const alreadyInSheet = (address, zip, url) => sheetKeys(address, zip, url).some((k) => SKIP_KEYS.has(k));
  // Also load any listings already seen in this browser tab/session
  try {
    const _prevSeen = JSON.parse(sessionStorage.getItem("__antigravity_seen_listings") || "[]");
    if (Array.isArray(_prevSeen)) _prevSeen.forEach((k) => SKIP_KEYS.add(k));
  } catch {}
  const markSeen = (address, zip, url) => {
    try {
      const ks = sheetKeys(address, zip, url);
      ks.forEach((k) => SKIP_KEYS.add(k));
      const _prev = JSON.parse(sessionStorage.getItem("__antigravity_seen_listings") || "[]");
      const _merged = [...new Set([..._prev, ...ks])].slice(-5000);
      sessionStorage.setItem("__antigravity_seen_listings", JSON.stringify(_merged));
    } catch {}
  };
  // @skiplist-end

  const rejected = {};
  const reject = (r) => { rejected[r] = (rejected[r] || 0) + 1; };
  const found = [];

  const targetStates = ONLY_STATES.length
    ? STATES.filter((s) => ONLY_STATES.includes(s.code))
    : STATES;

  let serverFiltersSupported = true;
  out.log(`${T} Server-side filters: bedrooms>=${C.minBeds}, bathrooms>=${C.minBaths}, building_area_sf>=${C.minSqft}`);

  for (const st of targetStates) {
    if (found.length >= TARGET) break;
    let stateFound = 0;
    out.log(`${T} Searching ${st.name} (${st.code})...`);

    for (let page = 0; page < MAX_PAGES_PER_STATE; page++) {
      if (found.length >= TARGET || stateFound >= MAX_PER_STATE) break;
      const offset = page * PAGE_SIZE;

      const body = {
        size: PAGE_SIZE,
        result_index: offset,
        house: true,
        sort_by: "list_date",
        sort_direction: "desc",
        locations: [
          {
            searchType: "T",
            state: st.code,
            stateName: st.name,
            title: `${st.name}, USA`,
          },
        ],
        lead_type_filters: ["mls_active"],
        estimated_value: { max: C.maxPrice },
      };

      // Narrow the result set server-side so the page budget is spent on
      // 4+ bed / 2+ bath / 1,500+ sqft homes instead of the newest 2–3 bed
      // listings. Falls back to the unfiltered body if Propwire rejects it.
      if (serverFiltersSupported) {
        body.bedrooms = { min: C.minBeds };
        body.bathrooms = { min: C.minBaths };
        body.building_area_sf = { min: C.minSqft };
      }

      let res;
      try {
        const resp = await propwireSearch(body);

        if (resp.status === 401) {
          out.error(`${T} API returned 401 Unauthorized — Bearer token has expired. Log in again or refresh.`);
          sessionStorage.removeItem("propwire_token");
          return;
        }

        if ((resp.status === 400 || resp.status === 422) && serverFiltersSupported) {
          out.warn(`${T} Server-side bed/bath/sqft filters rejected on ${st.code}; retrying without them.`);
          serverFiltersSupported = false;
          page--; // retry the same offset unfiltered
          continue;
        }

        if (!resp.ok) {
          out.warn(`${T} API error HTTP ${resp.status} on ${st.code} page ${page}`);
          break;
        }

        res = await resp.json();
      } catch (err) {
        out.warn(`${T} Request failed on ${st.code} page ${page}: ${err.message}`);
        break;
      }

      if (page === 0 && res?.total != null) {
        out.log(`${T} ${st.code}: ${Number(res.total).toLocaleString()} API match(es)`);
      }

      const items = res?.response ?? res?.data?.properties ?? res?.properties ?? [];
      if (!Array.isArray(items) || items.length === 0) break;

      for (const item of items) {
        const addrObj = item.address ?? {};
        const street = (typeof addrObj === "string" ? addrObj : addrObj.address ?? addrObj.street_address ?? item.street_address ?? "").trim();
        const city = (addrObj.city ?? item.city ?? "").trim();
        const state = (addrObj.state ?? item.state ?? st.code).trim().toUpperCase();
        const zip = String(addrObj.zip ?? item.zip ?? addrObj.postal_code ?? "").trim();
        const fullAddress = [street, city, state, zip].filter(Boolean).join(", ");

        if (!street || !city) { reject("missing address"); continue; }
        if (st.zips && !st.zips.some((p) => zip.startsWith(p))) { reject("zip"); continue; }

        const propId = String(item.id ?? item.property_id ?? "");
        const addrSlug = street.replace(/\s+/g, "-").replace(/[^a-zA-Z0-9-]/g, "");
        const url = `https://propwire.com/realestate/${addrSlug}/${propId}/property-details`;

        if (typeof alreadyInSheet === "function" && alreadyInSheet(fullAddress, zip, url)) {
          reject("already in sheet");
          continue;
        }

        const price = Number(item.list_price ?? item.listing_price ?? item.mls_list_price ?? item.estimated_value) || 0;
        const beds = Number(item.bedrooms) || 0;
        const baths = Number(item.bathrooms) || 0;
        const sqft = Number(item.building_area_sf ?? item.building_area_sqft ?? item.living_area_sqft ?? item.living_area_sf) || 0;
        const yearBuilt = Number(item.year_built) || 0;

        let lotSqft = Number(item.lot_area_sf ?? item.lot_size_sqft ?? item.lot_sqft) || 0;
        if (!lotSqft && Number(item.lot_size_acres ?? item.lot_area_acres)) {
          lotSqft = Number(item.lot_size_acres ?? item.lot_area_acres) * 43560;
        }

        const l = {
          id: propId,
          url,
          title: street,
          address: fullAddress,
          state,
          zip,
          price,
          beds,
          baths,
          sqft,
          lotSqft,
          yearBuilt,
          homeType: String(item.property_type ?? item.propertyType ?? "SFR"),
          daysOnMarket: item.days_on_market != null ? Number(item.days_on_market) : "",
          deedTransferDate: (item.last_sold_date ?? item.last_sale_date ?? item.last_sale_recording_date ?? item.deed_date ?? item.recording_date ?? "").toString().trim().slice(0, 10),
          description: Object.entries(item.lead_type || {}).filter(([, v]) => v === true).map(([k]) => k).join(", "),
        };

        const fail = criteriaFailure(l);
        if (fail) { reject(fail); continue; }

        found.push(l);
        if (typeof markSeen === "function") markSeen(l.address, l.zip, l.url);
        stateFound++;
        out.log(`%c${T} ✓ ${found.length}/${TARGET} [${st.code}] ${l.address} — $${l.price.toLocaleString()} — ${l.url}`, "color:green");
        if (found.length >= TARGET || stateFound >= MAX_PER_STATE) break;
      }

      await pause();
    }
  }

  const rows = found.map((l) => ({
    State: l.state,
    Address: l.address,
    Zip: l.zip,
    Price: l.price,
    Beds: l.beds,
    Baths: l.baths,
    SqFt: l.sqft || "",
    "Lot (acres)": l.lotSqft ? (l.lotSqft / 43560).toFixed(2) : "",
    "Year Built": l.yearBuilt || "Unknown",
    "Home Type": l.homeType,
    "Days on Market": l.daysOnMarket,
    "School Rating": "",
    "Deed Transfer Date": l.deedTransferDate || "",
    Link: l.url,
  }));

  window.__propwireStrictListings = rows;

  out.log(`%c${T} Done: ${found.length} listing(s)`, "font-weight:bold");
  out.log(`${T} Rejected by reason:`, rejected);
  out.table(rows);

  if (rows.length) {
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [Object.keys(rows[0]), ...rows.map(Object.values)]
      .map((r) => r.map(esc).join(","))
      .join("\n");
    try {
      if (typeof copy === "function") copy(csv);
      else await navigator.clipboard.writeText(csv);
      out.log(`${T} CSV copied to clipboard.`);
    } catch {}
  }
})();
