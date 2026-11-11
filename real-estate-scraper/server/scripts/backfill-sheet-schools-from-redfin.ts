// scripts/backfill-sheet-schools-from-redfin.ts
// ─────────────────────────────────────────────────────────────────────────────
// Looks up school ratings on Redfin for listings in Google Sheets that are
// missing a School Rating, and writes them back in place.
//
// Usage:
//   npx ts-node --transpile-only scripts/backfill-sheet-schools-from-redfin.ts
//   npx ts-node --transpile-only scripts/backfill-sheet-schools-from-redfin.ts --tab2     # Target Tool 2
//   npx ts-node --transpile-only scripts/backfill-sheet-schools-from-redfin.ts --today    # Only listings from today
//   npx ts-node --transpile-only scripts/backfill-sheet-schools-from-redfin.ts --source realtor # Only Realtor listings
//   npx ts-node --transpile-only scripts/backfill-sheet-schools-from-redfin.ts --limit 20 # Limit to 20 listings
//   npx ts-node --transpile-only scripts/backfill-sheet-schools-from-redfin.ts --dry-run
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import * as path from "path";
import { google } from "googleapis";
import { resolveAduTab, SheetTarget, tabRange } from "../src/utils/google-sheets";

const TAB_TARGET: SheetTarget = process.argv.includes("--tab2") ? "strict" : "main";
const DRY_RUN = process.argv.includes("--dry-run");

const LIMIT_ARG = process.argv.indexOf("--limit");
const LIMIT = LIMIT_ARG >= 0 ? Number(process.argv[LIMIT_ARG + 1]) : Infinity;

const SOURCE_ARG = process.argv.indexOf("--source");
const FILTER_SOURCE = SOURCE_ARG >= 0 ? process.argv[SOURCE_ARG + 1].toLowerCase() : null;

const TODAY = new Date().toLocaleDateString();
const DATE_ARG = process.argv.indexOf("--date");
const FILTER_DATE = process.argv.includes("--today")
  ? TODAY
  : DATE_ARG >= 0
    ? process.argv[DATE_ARG + 1]
    : null;

const KEY_FILE = path.join(__dirname, "..", "amazing-properties-447020-b2f3946f4b3e.json");

function colLetter(colIdx: number): string {
  let letter = "";
  let temp = colIdx;
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchRedfinJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "application/json, text/plain, */*",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const text = await res.text();
  const clean = text.replace(/^\{\}&&/, "");
  return JSON.parse(clean);
}

function summariseSchools(schools: any[]): { rating: string; detail: string } {
  if (!schools || !schools.length) return { rating: "", detail: "" };
  const levels: Record<string, number[]> = { E: [], M: [], H: [] };

  for (const sc of schools) {
    const r = Number(sc.greatSchoolsRating);
    if (!(r > 0)) continue;
    const [lo, hi] = String(sc.gradeRanges ?? "")
      .toUpperCase()
      .replace(/PREK|PK|K/g, "0")
      .split("-")
      .map(Number);
    if (Number.isNaN(lo)) continue;
    const top = Number.isNaN(hi) ? lo : hi;
    if (lo <= 5) levels.E.push(r);
    if (lo <= 8 && top >= 6) levels.M.push(r);
    if (top >= 9) levels.H.push(r);
  }

  const best = (arr: number[]) => (arr.length ? Math.max(...arr) : null);
  const detail = Object.entries(levels)
    .filter(([, arr]) => arr.length > 0)
    .map(([k, arr]) => `${k} ${best(arr)}`)
    .join(" / ");
  const headline = best(levels.H) ?? best(levels.M) ?? best(levels.E);

  return { rating: headline ? `${headline}/10` : "", detail };
}

async function lookupRedfinSchool(address: string): Promise<{ rating: string; detail: string; propertyId?: string } | null> {
  try {
    const autoUrl = `https://www.redfin.com/stingray/do/location-autocomplete?location=${encodeURIComponent(address)}&v=2&al=1`;
    const autoJson = await fetchRedfinJson(autoUrl);

    const rows: any[] = [];
    const walk = (o: any) => {
      if (!o || typeof o !== "object") return;
      if (typeof o.id === "string" && o.id.startsWith("1_") && o.name) rows.push(o);
      for (const v of Object.values(o)) walk(v);
    };
    walk(autoJson);

    const propId = rows[0]?.id?.split("_")[1];
    if (!propId) {
      return null;
    }

    const detailUrl = `https://www.redfin.com/stingray/api/home/details/belowTheFold?propertyId=${propId}&accessLevel=1`;
    const detailJson = await fetchRedfinJson(detailUrl);
    const schoolsInfo = detailJson.payload?.schoolsAndDistrictsInfo;
    const schools = schoolsInfo?.servingThisHomeSchools?.length
      ? schoolsInfo.servingThisHomeSchools
      : schoolsInfo?.schoolsToShowOnDP || [];

    const summary = summariseSchools(schools);
    return { ...summary, propertyId: propId };
  } catch (err: any) {
    return null;
  }
}

(async () => {
  console.log(`Starting Redfin school ratings backfill for ${TAB_TARGET === "main" ? "Tool 1" : "Tool 2"}...`);
  if (FILTER_DATE) console.log(`Filter date: ${FILTER_DATE}`);
  if (FILTER_SOURCE) console.log(`Filter source: ${FILTER_SOURCE}`);
  if (LIMIT < Infinity) console.log(`Limit: ${LIMIT}`);

  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const tab = await resolveAduTab(sheets, TAB_TARGET);

  console.log(`Resolved sheet: "${tab.title}" (ID: ${tab.spreadsheetId})`);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: tab.spreadsheetId,
    range: tabRange(tab.title, "A:Z"),
  });
  const rows: string[][] = res.data.values || [];
  if (rows.length === 0) {
    console.log("No rows found.");
    return;
  }

  // Find column indices
  let headerRowIdx = -1;
  let dateCol = 0;
  let sourceCol = 2;
  let addrCol = 5;
  let schoolRatingCol = 18; // S column default
  let urlCol = 21; // V column default

  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const r = rows[i];
    if (r.includes("Address") || r.includes("Date Found")) {
      headerRowIdx = i;
      dateCol = r.indexOf("Date Found") >= 0 ? r.indexOf("Date Found") : dateCol;
      sourceCol = r.indexOf("Source") >= 0 ? r.indexOf("Source") : sourceCol;
      addrCol = r.indexOf("Address") >= 0 ? r.indexOf("Address") : addrCol;
      schoolRatingCol = r.indexOf("School Rating") >= 0 ? r.indexOf("School Rating") : schoolRatingCol;
      urlCol = r.indexOf("Link") >= 0 ? r.indexOf("Link") : urlCol;
      break;
    }
  }

  console.log(`Column indices: Date=${dateCol}, Source=${sourceCol}, Address=${addrCol}, SchoolRating=${schoolRatingCol}, Link=${urlCol}`);

  interface PendingRow {
    sheetRowNum: number; // 1-indexed
    address: string;
    source: string;
    date: string;
  }

  const targets: PendingRow[] = [];
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.length) continue;
    const address = (r[addrCol] || "").trim();
    if (!address) continue;

    const currentRating = (r[schoolRatingCol] || "").trim();
    if (currentRating) continue; // Already has school rating

    const dateVal = (r[dateCol] || "").trim();
    if (FILTER_DATE && !dateVal.includes(FILTER_DATE)) continue;

    const sourceVal = (r[sourceCol] || "").trim();
    if (FILTER_SOURCE && !sourceVal.toLowerCase().includes(FILTER_SOURCE)) continue;

    targets.push({
      sheetRowNum: i + 1,
      address,
      source: sourceVal,
      date: dateVal,
    });
  }

  console.log(`Found ${targets.length} row(s) missing School Rating matching criteria.`);
  const batch = targets.slice(0, LIMIT);

  const updates: { range: string; value: string }[] = [];
  let successCount = 0;

  for (let i = 0; i < batch.length; i++) {
    const item = batch[i];
    console.log(`[${i + 1}/${batch.length}] Checking Redfin for: "${item.address}"...`);

    const res = await lookupRedfinSchool(item.address);
    if (res && res.rating) {
      console.log(`  ✓ Found: ${res.rating} (${res.detail || "no breakdown"})`);
      successCount++;
      const cellRange = tabRange(tab.title, `${colLetter(schoolRatingCol)}${item.sheetRowNum}`);
      updates.push({
        range: cellRange,
        value: res.rating,
      });
    } else {
      console.log(`  ✗ Not found on Redfin or no rating.`);
    }

    // Delay between requests to respect rate limits
    await sleep(1000 + Math.random() * 800);
  }

  console.log(`\nLookup completed: ${successCount}/${batch.length} found on Redfin.`);

  if (updates.length > 0) {
    if (DRY_RUN) {
      console.log(`[Dry Run] Would update ${updates.length} cells in "${tab.title}".`);
    } else {
      console.log(`Writing ${updates.length} updates to Google Sheet...`);
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: tab.spreadsheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: updates.map((u) => ({
            range: u.range,
            values: [[u.value]],
          })),
        },
      });
      console.log(`✓ Successfully updated ${updates.length} rows with school ratings in "${tab.title}"!`);
    }
  }
})();
