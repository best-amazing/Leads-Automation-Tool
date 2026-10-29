// scripts/import-console-csv.ts
// ─────────────────────────────────────────────────────────────────────────────
// Imports the CSV a browser-console script downloads (scripts/console/tool1/*
// and scripts/console/tool2-under200k/*) into the property research sheets.
//
//   npm run console:import -- "C:/Users/USER/Downloads/tool1-redfin-2026-10-26.csv"
//   npm run console:import -- <file.csv> --dry-run      # report only
//
// Rows from a Tool 1 run (they carry "Matched Keyword") go to Tool 1, and also
// to Tab 2 when they meet its criteria; rows from a Tab 2 run go to Tab 2.
// Anything already in the target sheet — same address, same house under a
// differently spelled street, or same Redfin/Zillow/Realtor listing — or in the
// dedupe store is skipped. Each lead passes the server's own criteria, ZIP and
// school-rating rules again before it is written, and keeps its keyword
// evidence, property type and school rating.
// ─────────────────────────────────────────────────────────────────────────────
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { google } from "googleapis";
import { resolveAduTab, tabRange, writeAduResearchToSheets } from "../src/utils/google-sheets";
import { AduDedupeTracker } from "../src/scrapers/property-purchase-research/core/adu-dedupe-tracker";
import {
  passesPropertyCriteria,
  schoolRatingFailure,
  strictCriteriaFailure,
  validateLeadZip,
} from "../src/scrapers/property-purchase-research/filters/adu-research.scraper";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sheetKeys } = require("./console-sheet-keys");

const KEY_FILE = path.join(__dirname, "..", "amazing-properties-447020-b2f3946f4b3e.json");

/** RFC-4180 CSV → array of records keyed by the header row. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

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

/** ZIP (ZCTA) containing a map pin, from the free Census geocoder; undefined if none. */
async function zipFromPin(lat: number, lng: number): Promise<string | undefined> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  const url = "https://geocoding.geo.census.gov/geocoder/geographies/coordinates?" + new URLSearchParams({
    x: String(lng), y: String(lat), benchmark: "Public_AR_Current", vintage: "Current_Current",
    layers: "2020 Census ZIP Code Tabulation Areas", format: "json",
  });
  try {
    const json: any = await (await fetch(url)).json();
    return json?.result?.geographies?.["2020 Census ZIP Code Tabulation Areas"]?.[0]?.ZCTA5;
  } catch {
    return undefined;
  }
}

const num = (s?: string) => {
  const n = Number(String(s ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

(async () => {
  const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const dryRun = process.argv.includes("--dry-run");
  if (!file || !fs.existsSync(file)) {
    console.error("Usage: npm run console:import -- <console CSV> [--dry-run]");
    process.exit(1);
  }
  const records = parseCsv(fs.readFileSync(file, "utf8"));
  const mainRun = records.length > 0 && "Matched Keyword" in records[0];
  console.log(`${path.basename(file)}: ${records.length} row(s), ${mainRun ? "Tool 1 run" : "Tab 2 run"}`);

  const auth = new google.auth.GoogleAuth({ keyFile: KEY_FILE, scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
  const sheets = google.sheets({ version: "v4", auth });
  const inMain = mainRun ? await sheetKeySet(sheets, "main") : new Set<string>();
  const inStrict = await sheetKeySet(sheets, "strict");
  const tracker = new AduDedupeTracker();

  const main: any[] = [], strict: any[] = [];
  const skipped: Record<string, number> = {};
  const skip = (why: string, address: string) => {
    skipped[why] = (skipped[why] ?? 0) + 1;
    console.log(`  skip (${why}): ${address}`);
  };

  for (const r of records) {
    const url = r.Link ?? "";
    let address = r.Address ?? "";
    // Craigslist posts rarely state a ZIP — look it up from the map pin
    if (!/\d{5}/.test(r.Zip ?? "") && r.Latitude && r.Longitude) {
      const zip = await zipFromPin(Number(r.Latitude), Number(r.Longitude));
      if (zip) {
        r.Zip = zip;
        address = `${address} ${zip}`;
      }
    }
    const source = /zillow/.test(url) ? "zillow-adu" : /realtor/.test(url) ? "realtor-adu"
      : /investorlift/.test(url) ? "investorlift-adu" : /crexi/.test(url) ? "crexi-adu"
      : /craigslist/.test(url) ? "craigslist-adu" : "redfin-adu";
    const lotAcres = num(r["Lot (acres)"]);
    const listing: any = {
      source,
      status: "Active",
      address,
      title: address,
      city: address.split(",").slice(-2, -1)[0]?.trim(),
      state: r.State,
      zip: r.Zip,
      price: num(r.Price),
      bedrooms: num(r.Beds),
      totalBedrooms: num(r.Beds),
      bathrooms: num(r.Baths),
      squareFeet: num(r.SqFt),
      lotSqft: lotAcres ? Math.round(lotAcres * 43_560) : undefined,
      units: num(r.Units), // Crexi
      yearBuilt: num(r["Year Built"]),
      homeType: r["Home Type"] || undefined,
      daysOnMarket: num(r["Days on Market"] ?? r["Days on Zillow"]),
      schoolRating: r["School Rating"] || undefined,
      ownerName: r.Seller || undefined, // InvestorLift: the wholesaler offering the deal
      matchedKeyword: r["Matched Keyword"] || undefined,
      // The console preview is the text around the keyword — the sheet's
      // keyword evidence is cut from it
      description: r["Description Preview"] || undefined,
      url,
    };
    const keys: string[] = sheetKeys(address, r.Zip, url);

    if (!validateLeadZip(listing)) { skip("outside allowed ZIPs", address); continue; }
    // A numbered lot/space, or a "#9"-style unit on a house, is almost always
    // a mobile-home park site
    if (/\b(lot|space|site)\s*#?\d+/i.test(address) || (/#\s*\d+/.test(address) && /single/i.test(r["Home Type"] ?? ""))) {
      skip("park unit (likely manufactured)", address);
      continue;
    }
    if (schoolRatingFailure(listing)) { skip("high school rating < 3", address); continue; }

    let wrote = false;
    if (mainRun) {
      if (keys.some((k) => inMain.has(k))) skip("already in sheet", address);
      else if (!passesPropertyCriteria(listing)) skip("fails Tool 1 criteria", address);
      else if (!dryRun && !(await tracker.track(listing))) skip("already in sheet", address);
      else { main.push(listing); keys.forEach((k) => inMain.add(k)); wrote = true; }
    }
    if (!strictCriteriaFailure(listing) && !keys.some((k) => inStrict.has(k))) {
      if (dryRun || (await tracker.track(listing, "strict"))) {
        strict.push(listing);
        keys.forEach((k) => inStrict.add(k));
        wrote = true;
      }
    } else if (!mainRun && !wrote) {
      skip(keys.some((k) => inStrict.has(k)) ? "already in sheet" : `fails Tab 2 criteria (${strictCriteriaFailure(listing)})`, address);
    }
  }

  console.log(`New for Tool 1: ${main.length} | new for Tab 2: ${strict.length} | skipped: ${JSON.stringify(skipped)}`);
  if (dryRun) { console.log("Dry run — nothing written."); process.exit(0); }
  if (main.length) await writeAduResearchToSheets(main, "main");
  if (strict.length) await writeAduResearchToSheets(strict, "strict");
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
