// scripts/console-sheet-keys.js
// Keys that identify a listing already in one of the sheets. Used by
// update-console-skiplists.ts to build the SKIP_KEYS list, and copied verbatim
// (via toString) into every browser-console script so both sides match the
// same way. Must stay self-contained: no imports, no outer variables.
//
//   a:<house number> <first street word>|<zip>   — "230-234 N Woodlawn Ave, Lima, OH 45805" → "a:230 woodlawn|45805"
//   c:<house number> <first street word>|<city>  — "c:230 woodlawn|lima"
//   d:<normalized street>|<zip>                  — "d:230 woodlawn ave|45805" (matches AduDedupeKey)
//   rf:<id>  Redfin          …/home/<id>
//   z:<id>   Zillow          …/<id>_zpid
//   rl:<id>  Realtor         …_M<id> (permalink id)
//   il:<id>  InvestorLift    …/deal/<id> or …/p/<id>
//   cx:<id>  Crexi           …/properties/<id>/<slug>
//   cl:<id>  Craigslist      …/<id>.html (post id)
//   cb:<id>  Coldwell Banker …/lid-<id>
//   pw:<id>  Propwire        …/realestate/…/<id>/… or …/property/<id>
function sheetKeys(address, zip, url) {
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
}

module.exports = { sheetKeys };
