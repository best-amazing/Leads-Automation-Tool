import "dotenv/config";
import * as path from "path";
import { google } from "googleapis";
import { resolveAduTab, tabRange, writeAduResearchToSheets } from "../src/utils/google-sheets";
import { AduDedupeTracker } from "../src/scrapers/property-purchase-research/core/adu-dedupe-tracker";
import {
  strictCriteriaFailure,
  validateLeadZip,
} from "../src/scrapers/property-purchase-research/filters/adu-research.scraper";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sheetKeys } = require("./console-sheet-keys");

const KEY_FILE = path.join(__dirname, "..", "amazing-properties-447020-b2f3946f4b3e.json");

const rawListings = [
  {
    state: "OH",
    address: "1539 East 34th Street, Cleveland, OH 44114",
    zip: "44114",
    price: 129900,
    beds: undefined,
    baths: undefined,
    sqft: 2535,
    lotAcres: undefined,
    yearBuilt: undefined,
    homeType: "MULTI_FAMILY",
    dom: 0,
    schoolRating: "",
    source: "crexi-adu",
    url: "https://www.crexi.com/properties/2766573/ohio-1539-e-34th-st-cleveland-oh-44114",
  },
  {
    state: "MO",
    address: "4400 Alaska Avenue, St. Louis, MO 63111",
    zip: "63111",
    price: 199900,
    beds: undefined,
    baths: undefined,
    sqft: 2218,
    lotAcres: undefined,
    yearBuilt: undefined,
    homeType: "MULTI_FAMILY",
    dom: 1,
    schoolRating: "",
    source: "crexi-adu",
    url: "https://www.crexi.com/properties/2755812/missouri-4400-alaska-avenue",
  },
  {
    state: "IL",
    address: "1228 W 74th Place, Chicago, IL 60636",
    zip: "60636",
    price: 171400,
    beds: undefined,
    baths: undefined,
    sqft: undefined,
    lotAcres: undefined,
    yearBuilt: undefined,
    homeType: "MULTI_FAMILY",
    dom: 3,
    schoolRating: "",
    source: "crexi-adu",
    url: "https://www.crexi.com/properties/2764782/illinois-1228-w-74th-place",
  },
  {
    state: "IL",
    address: "340 W 60th Place, Chicago, IL 60621",
    zip: "60621",
    price: 65900,
    beds: undefined,
    baths: undefined,
    sqft: undefined,
    lotAcres: undefined,
    yearBuilt: undefined,
    homeType: "MULTI_FAMILY",
    dom: 4,
    schoolRating: "",
    source: "crexi-adu",
    url: "https://www.crexi.com/properties/2763178/illinois-340-w-60th-place",
  },
  {
    state: "MI",
    address: "13982 CHERRYLAWN ST, DETROIT, MI 48238",
    zip: "48238",
    price: 185000,
    beds: undefined,
    baths: undefined,
    sqft: 2129,
    lotAcres: undefined,
    yearBuilt: undefined,
    homeType: "MULTI_FAMILY",
    dom: 5,
    schoolRating: "",
    source: "crexi-adu",
    url: "https://www.crexi.com/properties/2759667/michigan-13982-cherrylawn-st-detroit-mi-48238",
  },
  {
    state: "KS",
    address: "123 W 4th Street, Junction City, KS 66441",
    zip: "66441",
    price: 179000,
    beds: undefined,
    baths: undefined,
    sqft: undefined,
    lotAcres: undefined,
    yearBuilt: undefined,
    homeType: "MULTI_FAMILY",
    dom: 6,
    schoolRating: "",
    source: "crexi-adu",
    url: "https://www.crexi.com/properties/2762601/kansas-123-w-4th-street",
  },
  {
    state: "IA",
    address: "216 8th Avenue S, Clinton, IA 52732",
    zip: "52732",
    price: 82000,
    beds: undefined,
    baths: undefined,
    sqft: undefined,
    lotAcres: undefined,
    yearBuilt: undefined,
    homeType: "MULTI_FAMILY",
    dom: 6,
    schoolRating: "",
    source: "crexi-adu",
    url: "https://www.crexi.com/properties/2762384/iowa-216-8th-avenue-s",
  },
  {
    state: "IL",
    address: "5300 S Peoria Street, Chicago, IL 60609",
    zip: "60609",
    price: 155000,
    beds: undefined,
    baths: undefined,
    sqft: undefined,
    lotAcres: undefined,
    yearBuilt: undefined,
    homeType: "MULTI_FAMILY",
    dom: 6,
    schoolRating: "",
    source: "crexi-adu",
    url: "https://www.crexi.com/properties/2759597/illinois-5300-s-peoria-street",
  },
  {
    state: "IL",
    address: "7521 S Ridgeland Avenue, Chicago, IL 60649",
    zip: "60649",
    price: 180000,
    beds: undefined,
    baths: undefined,
    sqft: undefined,
    lotAcres: undefined,
    yearBuilt: undefined,
    homeType: "MULTI_FAMILY",
    dom: 6,
    schoolRating: "",
    source: "crexi-adu",
    url: "https://www.crexi.com/properties/2759586/illinois-7521-s-ridgeland-avenue",
  },
  {
    state: "IL",
    address: "6321 S Rhodes Avenue, Chicago, IL 60637",
    zip: "60637",
    price: 200000,
    beds: undefined,
    baths: undefined,
    sqft: undefined,
    lotAcres: undefined,
    yearBuilt: undefined,
    homeType: "MULTI_FAMILY",
    dom: 11,
    schoolRating: "",
    source: "crexi-adu",
    url: "https://www.crexi.com/properties/2762568/illinois-6321-s-rhodes-avenue",
  },
  {
    state: "IL",
    address: "8318 S Manistee Avenue, Chicago, IL 60617",
    zip: "60617",
    price: 69900,
    beds: undefined,
    baths: undefined,
    sqft: undefined,
    lotAcres: undefined,
    yearBuilt: undefined,
    homeType: "MULTI_FAMILY",
    dom: 14,
    schoolRating: "",
    source: "crexi-adu",
    url: "https://www.crexi.com/properties/2747280/illinois-8318-s-manistee-avenue",
  },
  {
    state: "OH",
    address: "1219 W Spring Street, Lima, OH 45805",
    zip: "45805",
    price: 135000,
    beds: undefined,
    baths: undefined,
    sqft: 1772,
    lotAcres: undefined,
    yearBuilt: undefined,
    homeType: "MULTI_FAMILY",
    dom: 15,
    schoolRating: "",
    source: "crexi-adu",
    url: "https://www.crexi.com/properties/2745161/ohio-spring-st-duplex",
  },
  {
    state: "IL",
    address: "7237 S Stony Island Avenue, Chicago, IL 60649",
    zip: "60649",
    price: 150000,
    beds: undefined,
    baths: undefined,
    sqft: undefined,
    lotAcres: undefined,
    yearBuilt: undefined,
    homeType: "MULTI_FAMILY",
    dom: 17,
    schoolRating: "",
    source: "crexi-adu",
    url: "https://www.crexi.com/properties/2744644/illinois-7237-s-stony-island-avenue",
  },
  {
    state: "OH",
    address: "5362 Broadway Avenue, Cleveland, OH 44127",
    zip: "44127",
    price: 100000,
    beds: undefined,
    baths: undefined,
    sqft: 17838,
    lotAcres: undefined,
    yearBuilt: undefined,
    homeType: "MULTI_FAMILY",
    dom: 26,
    schoolRating: "",
    source: "crexi-adu",
    url: "https://www.crexi.com/properties/2727023/ohio-5362-broadway-avenue",
  },
  {
    state: "IL",
    address: "8507 S May Street, Chicago, IL 60620",
    zip: "60620",
    price: 200000,
    beds: undefined,
    baths: undefined,
    sqft: undefined,
    lotAcres: undefined,
    yearBuilt: undefined,
    homeType: "MULTI_FAMILY",
    dom: 28,
    schoolRating: "",
    source: "crexi-adu",
    url: "https://www.crexi.com/properties/2726307/illinois-8507-s-may-street",
  },
  {
    state: "MI",
    address: "14067 Cherrylawn Street, Detroit, MI 48238",
    zip: "48238",
    price: 139000,
    beds: undefined,
    baths: undefined,
    sqft: 2052,
    lotAcres: undefined,
    yearBuilt: undefined,
    homeType: "MULTI_FAMILY",
    dom: 29,
    schoolRating: "",
    source: "crexi-adu",
    url: "https://www.crexi.com/properties/2724106/michigan-14067-cherrylawn-street",
  },
];

async function sheetKeySet(sheets: any, target: "main" | "strict"): Promise<Set<string>> {
  const tab = await resolveAduTab(sheets, target);
  const values: string[][] =
    (await sheets.spreadsheets.values.get({ spreadsheetId: tab.spreadsheetId, range: tabRange(tab.title, "A:Z") })).data.values ?? [];
  const keys = new Set<string>();
  let a = 5, z = 6;
  for (const r of values) {
    if ((r[0] || "").trim() === "Date Found") { a = r.indexOf("Address"); z = r.findIndex((c) => /^zip/i.test(c)); continue; }
    for (const k of sheetKeys(r[a], z >= 0 ? r[z] : undefined, r.find((c) => /^https?:\/\//.test(String(c))))) keys.add(k);
  }
  return keys;
}

(async () => {
  const auth = new google.auth.GoogleAuth({ keyFile: KEY_FILE, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  const sheets = google.sheets({ version: "v4", auth });
  const inStrict = await sheetKeySet(sheets, "strict");
  const tracker = new AduDedupeTracker();

  const toAdd: any[] = [];
  for (const item of rawListings) {
    const listing: any = {
      source: item.source || "redfin-adu",
      status: "Active",
      address: item.address,
      title: item.address,
      city: item.address.split(",").slice(-2, -1)[0]?.trim(),
      state: item.state,
      zip: item.zip,
      price: item.price,
      bedrooms: item.beds,
      totalBedrooms: item.beds,
      bathrooms: item.baths,
      squareFeet: item.sqft,
      lotSqft: item.lotAcres ? Math.round(item.lotAcres * 43_560) : undefined,
      yearBuilt: item.yearBuilt,
      homeType: item.homeType,
      daysOnMarket: item.dom,
      schoolRating: item.schoolRating,
      url: item.url,
    };

    const keys: string[] = sheetKeys(listing.address, listing.zip, listing.url);

    if (!validateLeadZip(listing)) {
      console.log(`SKIP (outside allowed ZIP): ${listing.address}`);
      continue;
    }
    const failStrict = strictCriteriaFailure(listing);
    if (failStrict) {
      console.log(`SKIP (${failStrict}): ${listing.address}`);
      continue;
    }
    if (keys.some((k) => inStrict.has(k))) {
      console.log(`SKIP (already in sheet): ${listing.address}`);
      continue;
    }
    if (!(await tracker.track(listing, "strict"))) {
      console.log(`SKIP (dedupe tracker): ${listing.address}`);
      continue;
    }

    toAdd.push(listing);
    keys.forEach((k) => inStrict.add(k));
  }

  console.log(`\nReady to append ${toAdd.length} listings to Tab 2.`);
  if (toAdd.length > 0) {
    await writeAduResearchToSheets(toAdd, "strict");
    console.log(`Successfully wrote ${toAdd.length} listings to Tab 2!`);
  }
})();
