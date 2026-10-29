// scripts/console-sheet-keys.js
// Keys that identify a listing already in one of the sheets. Used by
// update-console-skiplists.ts to build the SKIP_KEYS list, and copied verbatim
// (via toString) into every browser-console script so both sides match the
// same way. Must stay self-contained: no imports, no outer variables.
//
//   a:<house number> <first street word>|<zip>   — "230-234 N Woodlawn Ave, Lima, OH 45805" → "a:230 woodlawn|45805"
//   c:<house number> <first street word>|<city>  — "c:230 woodlawn|lima"
//   rf:<id>  Redfin  …/home/<id>
//   z:<id>   Zillow  …/<id>_zpid
//   rl:<id>  Realtor …_M<id>  (permalink id)
//   il:<id>  InvestorLift …/deal/<id> or …/p/<id>
//   cx:<id>  Crexi …/properties/<id>/<slug>
//   cl:<id>  Craigslist …/<id>.html (post id)
function sheetKeys(address, zip, url) {
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
}

module.exports = { sheetKeys };
