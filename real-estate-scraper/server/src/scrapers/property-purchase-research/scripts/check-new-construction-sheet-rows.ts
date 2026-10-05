// src/scrapers/property-purchase-research/scripts/check-new-construction-sheet-rows.ts
// ─────────────────────────────────────────────────────────────────────────────
// READ-ONLY report of existing sheet rows that the new-construction exclusion
// would now reject: built in/after NEW_CONSTRUCTION_MIN_YEAR (default: last
// calendar year), or with new-build wording in the description preview.
// Uses the same newConstructionReason() rule as the live pipeline.
//
// Usage:
//   npm run check:new-construction            # first 100 flagged rows
//   npm run check:new-construction -- --all   # every flagged row
//   npm run check:new-construction -- --csv   # also save logs/new-construction-rows-<date>.csv
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { google } from "googleapis";
import { logger } from "../../../utils/logger";
import { newConstructionReason } from "../filters/adu-research.scraper";

const SHEET_NAME = "New Property Research Tool";
const DEFAULT_ROWS_TO_PRINT = 100;
const SHOW_ALL = process.argv.includes("--all");
const WRITE_CSV = process.argv.includes("--csv");

type FlaggedRow = {
  row: number;
  dateFound: string;
  source: string;
  address: string;
  yearBuilt: string;
  reason: string;
  link: string;
};

function getServiceAccountPath(): string {
  let raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || "";
  if (raw.startsWith("/mnt/c/")) {
    raw = "C:\\" + raw.slice(7).replace(/\//g, "\\");
  }

  const candidates = [
    raw,
    path.resolve(raw),
    path.join(process.cwd(), "amazing-properties-447020-b2f3946f4b3e.json"),
    path.join(
      __dirname,
      "../..",
      "amazing-properties-447020-b2f3946f4b3e.json",
    ),
    path.join(
      __dirname,
      "../../..",
      "amazing-properties-447020-b2f3946f4b3e.json",
    ),
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return raw;
}

function findColumn(headers: string[], name: string, fallback: number): number {
  const index = headers.indexOf(name);
  return index >= 0 ? index : fallback;
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

async function main(): Promise<void> {
  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) {
    throw new Error("[sheets] SPREADSHEET_ID not found in .env");
  }

  const keyPath = getServiceAccountPath();
  if (!keyPath || !fs.existsSync(keyPath)) {
    throw new Error(`[sheets] Google service account key not found (${keyPath})`);
  }

  logger.info("═".repeat(60));
  logger.info("Property Research New-Construction Check (read-only)");
  logger.info("═".repeat(60));
  logger.info(`Sheet: ${SHEET_NAME}`);

  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_NAME}!A:Z`,
  });
  const rows = response.data.values || [];

  // Column positions are re-read at every header block (one per day).
  let col = { source: 2, address: 5, year: 17, link: 21, description: 22 };
  const flagged: FlaggedRow[] = [];
  let listingRows = 0;
  let unknownYear = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const firstCell = (row[0] || "").toString().trim();

    if (firstCell === "Date Found") {
      col = {
        source: findColumn(row, "Source", 2),
        address: findColumn(row, "Address", 5),
        year: findColumn(row, "Year Built", 17),
        link: findColumn(row, "Link", 21),
        description: findColumn(row, "Description Preview", 22),
      };
      continue;
    }

    if (!/^\d{1,2}\/\d{1,2}\/\d{4}/.test(firstCell)) {
      continue;
    }

    listingRows += 1;
    const cell = (i: number) => (row[i] || "").toString().trim();
    const yearText = cell(col.year);
    const year = Number(yearText);
    if (!(year > 0)) unknownYear += 1;

    const reason = newConstructionReason({
      yearBuilt: year > 0 ? year : undefined,
      description: cell(col.description),
    });
    if (!reason) continue;

    flagged.push({
      row: index + 1,
      dateFound: firstCell,
      source: cell(col.source),
      address: cell(col.address),
      yearBuilt: yearText || "Unknown",
      reason,
      link: cell(col.link),
    });
  }

  const byYear = flagged.filter((f) => f.reason.includes("(built "));
  const byWording = flagged.length - byYear.length;

  logger.info(`Sheet rows: ${rows.length}`);
  logger.info(`Listing rows: ${listingRows} (${unknownYear} with no Year Built)`);
  logger.info(
    `Flagged as new construction: ${flagged.length} ` +
      `(${byYear.length} by build year, ${byWording} by description wording)`,
  );

  if (flagged.length === 0) {
    logger.info("No new-construction rows found.");
    return;
  }

  logger.warn("Rows the new-construction exclusion would reject:");
  const rowsToPrint = SHOW_ALL ? flagged : flagged.slice(0, DEFAULT_ROWS_TO_PRINT);
  for (const f of rowsToPrint) {
    logger.warn(
      `  row ${f.row} | ${f.dateFound} | ${f.source || "?"} | year ${f.yearBuilt} | ` +
        `${f.reason} | ${f.address || f.link}`,
    );
  }
  if (rowsToPrint.length < flagged.length) {
    logger.info(
      `Showing ${rowsToPrint.length} of ${flagged.length} rows. ` +
        "Use --all to show every entry.",
    );
  }

  if (WRITE_CSV) {
    const outDir = path.resolve("logs");
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(
      outDir,
      `new-construction-rows-${new Date().toISOString().slice(0, 10)}.csv`,
    );
    const header = "Sheet Row,Date Found,Source,Address,Year Built,Reason,Link";
    const lines = flagged.map((f) =>
      [String(f.row), f.dateFound, f.source, f.address, f.yearBuilt, f.reason, f.link]
        .map(csvEscape)
        .join(","),
    );
    fs.writeFileSync(outPath, [header, ...lines].join("\n"), "utf-8");
    logger.info(`CSV written: ${outPath}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`[sheets] Failed: ${error}`);
    process.exit(1);
  });
