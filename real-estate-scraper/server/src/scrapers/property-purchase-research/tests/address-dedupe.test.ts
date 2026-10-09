import assert from "node:assert/strict";
import { dedupKey } from "../filters/address-dedupe";
import { STATE_ZIP_PREFIXES, TARGET_STATES } from "../core/adu-keywords";
import {
  ADU_CRAIGSLIST_MARKETS,
  ADU_REDFIN_MARKETS,
  ADU_STATE_MARKETS,
  ADU_ZILLOW_MARKETS,
} from "../core/adu-markets";
import {
  isIndianaZipAllowed,
  validateIndianaLeadZip,
  validateLeadZip,
  newConstructionReason,
  passesNewConstructionGate,
  strictCriteriaFailure,
} from "../filters/adu-research.scraper";

const a = { address: "53316 Nadine Street, South Bend, IN, 46637" };
const b = {
  address: "53316 Nadine St, South Bend, IN 46637, South Bend, IN, 46637",
};
const c = { address: "53317 Nadine Street, South Bend, IN, 46637" };

assert.equal(
  dedupKey(a),
  dedupKey(b),
  "same address with different formatting should dedupe",
);
assert.notEqual(dedupKey(a), dedupKey(c), "different street should not dedupe");

assert.equal(
  isIndianaZipAllowed("46637"),
  true,
  "46xxx Indiana ZIP should pass",
);
assert.equal(
  isIndianaZipAllowed("46311"),
  true,
  "another 46xxx ZIP should pass",
);
assert.equal(
  isIndianaZipAllowed("47201"),
  false,
  "non-46xxx Indiana ZIP should be rejected",
);
assert.equal(
  validateIndianaLeadZip({
    state: "IN",
    zip: "47201",
    address: "123 Main St, Bloomington, IN",
  }),
  false,
  "Indiana listings outside 46xxx ZIP should be rejected",
);
assert.equal(
  validateIndianaLeadZip({
    state: "IN",
    zip: "46637",
    address: "123 Main St, South Bend, IN",
  }),
  true,
  "Indiana listings in 46xxx ZIP should pass",
);

// ── Per-state ZIP gates for the expansion markets ───────────────────────────
const zipCases: Array<[string, string, boolean]> = [
  ["WI", "53208", true],
  ["WI", "54701", false], // Eau Claire
  ["KY", "40202", true],
  ["KY", "41011", false], // Covington
  ["IN", "46201", true], // Indianapolis
  ["IN", "47201", false], // Columbus, IN
  ["IA", "50701", true], // Waterloo
  ["IA", "52401", true], // Cedar Rapids
  ["IA", "51101", false], // Sioux City
  ["IL", "60623", true], // Chicago
  ["IL", "60544", true], // Plainfield
  ["IL", "61104", false], // Rockford
  ["IL", "62701", false], // Springfield
  ["OH", "43215", true], // Columbus
  ["OH", "44114", true], // Cleveland
  ["OH", "45202", true], // Cincinnati
  ["OH", "12345", true], // Ohio accepts every ZIP
  ["MI", "48201", true], // Detroit
  ["MI", "49007", true], // Kalamazoo
  ["PA", "15213", true], // Pittsburgh
  ["PA", "19103", false], // Philadelphia
  ["MO", "63101", true], // St. Louis
  ["MO", "64105", true], // Kansas City, MO
  ["MO", "65801", false], // Springfield, MO
  ["NE", "68102", true], // Omaha
  ["NE", "69101", false], // North Platte
  ["KS", "66101", true], // Kansas City, KS
  ["KS", "67202", false], // Wichita
  ["TN", "37203", true], // Nashville
  ["TN", "38103", false], // Memphis
  ["GA", "30303", true], // Atlanta
  ["GA", "31401", false], // Savannah
];
for (const [state, zip, expected] of zipCases) {
  assert.equal(
    validateLeadZip({ state, zip, address: `1 Main St, Town, ${state}` }),
    expected,
    `${state} ${zip} should ${expected ? "pass" : "be rejected"}`,
  );
}
assert.equal(
  validateLeadZip({ state: "KY", address: "1 Main St, Louisville, KY" }),
  false,
  "restricted-state lead with no ZIP should be rejected",
);
assert.equal(
  validateLeadZip({ address: "1 Main St, Chicago, IL 60623" }),
  true,
  "ZIP and state can be read from the address when fields are empty",
);
assert.equal(
  validateLeadZip({ address: "1 Main St, Rockford, IL 61104" }),
  false,
  "address-only IL lead outside 60xxx should be rejected",
);

// ── Scrape priority: every market list follows TARGET_STATES order ─────────
assert.deepEqual(TARGET_STATES, [
  "OH", "IN", "WI", "IA", "IL", "KY", "MI", "PA", "MO", "NE", "KS", "TN", "GA",
]);
const stateOfName = (n: string) => n.match(/,\s*([A-Z]{2})\b/)?.[1] ?? "";
// [source, states in list order, must cover every target state?]
const marketOrders: Array<[string, string[], boolean]> = [
  ["zillow", ADU_ZILLOW_MARKETS.map((m) => stateOfName(m.name)), true],
  ["redfin", ADU_REDFIN_MARKETS.map((m) => stateOfName(m.name)), true],
  // Kansas shares the Kansas City Craigslist site (tagged MO), so KS is absent.
  ["craigslist", ADU_CRAIGSLIST_MARKETS.map((m) => m.state), false],
  ["creative-listing", ADU_STATE_MARKETS.map((m) => m.stateAbbr), true],
];
for (const [source, states, complete] of marketOrders) {
  const distinct = states.filter((s, i) => states.indexOf(s) === i);
  const expected = complete
    ? TARGET_STATES
    : TARGET_STATES.filter((s) => distinct.includes(s));
  assert.deepEqual(distinct, expected, `${source} markets should follow TARGET_STATES order`);
}
// Every targeted state except Ohio has a ZIP rule
for (const s of TARGET_STATES.filter((s) => s !== "OH")) {
  assert.ok(STATE_ZIP_PREFIXES[s], `${s} should have a ZIP rule`);
}

// ── New construction exclusion ──────────────────────────────────────────────
const lastYear = new Date().getFullYear() - 1;
const buildCases: Array<[string, Parameters<typeof newConstructionReason>[0], boolean]> = [
  ["built last year", { yearBuilt: lastYear }, true],
  ["built this year", { yearBuilt: lastYear + 1 }, true],
  ["future build year", { yearBuilt: lastYear + 2 }, true],
  ["built 2005", { yearBuilt: 2005 }, false],
  ["year unknown, plain copy", { description: "Charming ranch with guest house" }, false],
  ["new construction wording", { description: "Gorgeous new construction by Ryan Homes" }, true],
  ["to-be-built wording", { title: "To-Be-Built ranch with in-law suite" }, true],
  ["estimated completion", { description: "Est. completion March 2027" }, true],
  ["newly built", { description: "Newly built home on a quiet street" }, true],
  ["brand new roof is fine", { description: "Brand new roof and furnace" }, false],
  ["newer windows is fine", { description: "Newer windows, updated kitchen" }, false],
  // False positives found in the sheet (rows 396 and 611)
  ["newly built garage", { description: "A newly built 20x20 two-car garage adds parking" }, false],
  ["older year beats wording", { yearBuilt: 1993, description: "the worry-free longevity of a brand-new build" }, false],
  // True positive from the sheet (row 424)
  ["new construction on acreage", { description: "Exceptional new construction on approximately 3.064 acres" }, true],
];
for (const [label, listing, expected] of buildCases) {
  assert.equal(!!newConstructionReason(listing), expected, `new-construction: ${label}`);
}
// The two example leads that slipped through (Coldwell Banker, year built set)
assert.equal(
  passesNewConstructionGate({ address: "4316 Dogwood Avenue, Perry, OH, 44081", yearBuilt: 2026 }),
  false,
  "4316 Dogwood Ave (built 2026) should be excluded",
);
assert.equal(
  passesNewConstructionGate({ address: "14814 S Parkview Drive, Plainfield, IL, 60544", yearBuilt: 2027 }),
  false,
  "14814 S Parkview Dr (built 2027) should be excluded",
);

// ── Second spreadsheet (strict criteria) ────────────────────────────────────
const good = {
  price: 180_000, bedrooms: 4, bathrooms: 2, squareFeet: 1_800,
  lotSqft: 0.6 * 43_560, yearBuilt: 1972, homeType: "SINGLE_FAMILY",
  description: "Main house plus a guest house on a large lot.",
};
const strictCases: Array<[string, Record<string, unknown>, boolean]> = [
  ["meets every criterion", good, true],
  ["all values unknown (written for review)", { description: "In-law suite" }, true],
  ["price over $200k", { ...good, price: 205_000 }, false],
  ["3 beds", { ...good, bedrooms: 3 }, false],
  ["1.5 baths", { ...good, bathrooms: 1.5 }, false],
  ["1,400 sqft", { ...good, squareFeet: 1_400 }, false],
  ["0.4 acre lot", { ...good, lotSqft: 0.4 * 43_560 }, false],
  ["exactly 0.5 acre lot", { ...good, lotSqft: 0.5 * 43_560 }, true],
  ["built 1950", { ...good, yearBuilt: 1950 }, false],
  ["built 1955", { ...good, yearBuilt: 1955 }, true],
  ["new construction (built this year)", { ...good, yearBuilt: new Date().getFullYear() }, false],
  ["HOA fee reported", { ...good, hoaFee: 45 }, false],
  ["HOA fee 0", { ...good, hoaFee: 0 }, true],
  ["HOA in description", { ...good, description: "Guest house. HOA dues $40/mo." }, false],
  ["'No HOA' in description", { ...good, description: "Guest house, no HOA!" }, true],
  ["condo home type", { ...good, homeType: "CONDO" }, false],
  ["multifamily home type", { ...good, homeType: "MULTI_FAMILY" }, true],
  ["apartment home type", { ...good, homeType: "APARTMENT" }, true],
  ["bungalow", { ...good, description: "Charming bungalow with in-law suite" }, false],
  ["55+ community", { ...good, description: "In-law suite in a 55+ community" }, false],
  ["auction", { ...good, description: "Selling at auction, guest house" }, false],
  ["short sale", { ...good, description: "Short sale. In-law suite." }, false],
  ["vacant land", { ...good, description: "Vacant land, two homes allowed" }, false],
];
for (const [label, listing, expected] of strictCases) {
  const failure = strictCriteriaFailure(listing as any);
  assert.equal(failure === null, expected, `strict: ${label} (got: ${failure ?? "pass"})`);
}

console.log("address dedupe checks passed");
