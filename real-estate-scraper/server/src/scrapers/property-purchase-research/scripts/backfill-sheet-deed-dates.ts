// src/scrapers/property-purchase-research/backfill-sheet-deed-dates.ts
// ─────────────────────────────────────────────────────────────────────────────
// Reads every listing row from the "New Property Research Tool" Google Sheet
// (the sheet scrape:adu-research writes to), looks up each address's deed
// transfer date via the ATTOM -> OGRIP pipeline, and updates the
// "Deed Transfer Date" column of that row in place.
//
// Usage:
//   npm run backfill:deed-dates
//   npm run backfill:deed-dates -- --force     # re-fetch rows that already have a date
//   npm run backfill:deed-dates -- --limit 10  # process at most 10 unique addresses
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { google } from "googleapis";
import { enrichOneListing } from "../../lib/deed-data/enrich-listings";
import { logger } from "../../utils/logger";

const SHEET_NAME = "New Property Research Tool";
const DEED_DATE_FALLBACK_COLUMN = 22; // column W — where adu-research writes the deed date

const FORCE = process.argv.includes("--force");
const LIMIT_ARG = process.argv.indexOf("--limit");
const LIMIT = LIMIT_ARG >= 0 ? Number(process.argv[LIMIT_ARG + 1]) : Infinity;

function getServiceAccountPath(): string {
  let raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || "";
  if (raw.startsWith("/mnt/c/")) {
    raw = "C:\\" + raw.slice(7).replace(/\//g, "\\");
  }

  const candidates = [
    raw,
    path.resolve(raw),
    path.join(process.cwd(), "amazing-properties-447020-b2f3946f4b3e.json"),
    path.join(__dirname, "../..", "amazing-properties-447020-b2f3946f4b3e.json"),
    path.join(__dirname, "../../..", "amazing-properties-447020-b2f3946f4b3e.json"),
  ];

  for (const cand of candidates) {
    if (cand && fs.existsSync(cand)) {
      return cand;
    }
  }
  return raw;
}

function colLetter(index: number): string {
  let s = "";
  let i = index + 1;
  while (i > 0) {
    const rem = (i - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

interface DataRow {
  sheetRow: number; // 1-based row index in the sheet (including header rows)
  address: string;
  currentDeedDate: string;
  deedCol: number; // column where "Deed Transfer Date" lives for this row
}

function findColumn(headers: string[], name: string, fallback: number): number {
  const idx = headers.indexOf(name);
  return idx >= 0 ? idx : fallback;
}

async function main(): Promise<void> {
  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) {
    logger.error("[backfill] SPREADSHEET_ID not found in .env");
    process.exit(1);
  }

  const keyPath = getServiceAccountPath();
  if (!fs.existsSync(keyPath) || !keyPath) {
    logger.error(`[backfill] Google service account key not found (${keyPath})`);
    process.exit(1);
  }

  logger.info("═".repeat(60));
  logger.info("Google Sheet Deed-Date Backfill");
  logger.info("═".repeat(60));
  logger.info(`Sheet: ${SHEET_NAME}`);
  logger.info(`Mode:  ${FORCE ? "force (re-fetch all)" : "only rows missing a deed date"}`);
  logger.info(`Limit: ${LIMIT === Infinity ? "none" : LIMIT} unique addresses`);
  logger.info("─".repeat(60));

  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  // 1. Read the whole sheet.
  const getRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_NAME}!A:Z`,
  });
  const rows = getRes.data.values || [];
  logger.info(`Sheet has ${rows.length} rows total`);

  if (rows.length === 0) {
    logger.info("No data rows in the sheet — nothing to do.");
    return;
  }

  // 2. Parse the sheet. The sheet can contain several day-block sections with
  //    different layouts, so we track the active header's column positions as
  //    we scan downward. A listing row is identified by its "Date Found" cell.
  let lastHeaderIndex = -1;
  let activeAddressCol = 5; // index of "Address" in the full layout
  let activeDeedCol = DEED_DATE_FALLBACK_COLUMN; // index of "Deed Transfer Date"
  const dataRows: DataRow[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const first = (r[0] || "").toString().trim();

    if (first === "Date Found") {
      // Day-block header — adopt its column layout for the rows below.
      lastHeaderIndex = i;
      activeAddressCol = findColumn(r, "Address", 5);
      activeDeedCol = findColumn(r, "Deed Transfer Date", DEED_DATE_FALLBACK_COLUMN);
      continue;
    }
    if (/^== \d{4}-\d{2}-\d{2} ==$/.test(first)) continue; // day marker
    if (!/^\d{1,2}\/\d{1,2}\/\d{4}/.test(first)) continue; // not a listing row

    const address = (r[activeAddressCol] || "").toString().trim();
    if (!address) continue;

    const currentDeedDate = (r[activeDeedCol] || "").toString().trim();
    if (!FORCE && currentDeedDate) continue; // already filled (idempotent)

    dataRows.push({ sheetRow: i + 1, address, currentDeedDate, deedCol: activeDeedCol });
  }

  logger.info(`Data rows needing a deed date: ${dataRows.length}`);

  const uniqueAddresses: string[] = [];
  const seen = new Set<string>();
  for (const d of dataRows) {
    const key = d.address.toLowerCase().replace(/\s+/g, " ");
    if (!key) continue;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueAddresses.push(d.address);
    }
  }
  logger.info(`Unique addresses to query: ${uniqueAddresses.length}`);

  // 3. Look up deed dates (with a shared cache per address).
  const deedCache = new Map<string, string>();
  const toProcess = uniqueAddresses.slice(0, LIMIT);
  let found = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const address = toProcess[i];
    try {
      const result = await enrichOneListing({ address } as any);
      const date = result.latestDeedTransferDate || "";
      if (date) {
        found++;
        logger.info(`  ✓ ${date} (${result.deedDataSource}) :: ${address}`);
      } else {
        logger.warn(`  ✗ none :: ${address} (${result.enrichmentNote || "no deed date"})`);
      }
      deedCache.set(address.toLowerCase().replace(/\s+/g, " "), date);
    } catch (err: any) {
      logger.warn(`  ✗ error :: ${address}: ${err.message || err}`);
      deedCache.set(address.toLowerCase().replace(/\s+/g, " "), "");
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  logger.info(`Deed dates found: ${found}/${toProcess.length} unique addresses`);

  // 4. Build the updates: map every data row back to its cached address result.
  const updates: { range: string; value: string }[] = [];
  for (const d of dataRows) {
    const key = d.address.toLowerCase().replace(/\s+/g, " ");
    const date = deedCache.get(key);
    if (!date) continue;
    const range = `${SHEET_NAME}!${colLetter(d.deedCol)}${d.sheetRow}`;
    updates.push({ range, value: date });
  }

  // Label the column on the latest header block if it predates the new field.
  const lastDeedCol = activeDeedCol;
  if (lastHeaderIndex >= 0 && (rows[lastHeaderIndex][lastDeedCol] || "").toString() !== "Deed Transfer Date") {
    updates.push({
      range: `${SHEET_NAME}!${colLetter(lastDeedCol)}${lastHeaderIndex + 1}`,
      value: "Deed Transfer Date",
    });
  }

  // 5. Write in chunks.
  const CHUNK = 100;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: chunk.map((u) => ({ range: u.range, values: [[u.value]] })),
      },
    });
    logger.info(`  Wrote ${i + chunk.length}/${updates.length} cells`);
  }

  logger.info("─".repeat(60));
  logger.info(`Done — updated ${updates.length} cells with deed transfer dates.`);
  logger.info("═".repeat(60));
}

main();