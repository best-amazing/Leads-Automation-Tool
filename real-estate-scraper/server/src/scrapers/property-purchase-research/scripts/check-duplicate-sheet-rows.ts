import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { google } from "googleapis";
import { logger } from "../../../utils/logger";
import { dedupKey } from "../filters/address-dedupe";

const SHEET_NAME = "New Property Research Tool";
const DEFAULT_ROWS_TO_PRINT = 100;
const SHOW_ALL = process.argv.includes("--all");

type DuplicateRow = {
  row: number;
  firstRow: number;
  key: string;
  address: string;
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
  logger.info("Property Research Duplicate Check");
  logger.info("═".repeat(60));
  logger.info(`Sheet: ${SHEET_NAME}`);

  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_NAME}!A:Z`,
  });
  const rows = response.data.values || [];

  let activeAddressColumn = 5;
  let activeLinkColumn = 21;
  const firstRows = new Map<string, number>();
  const duplicates: DuplicateRow[] = [];
  let listingRows = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const firstCell = (row[0] || "").toString().trim();

    if (firstCell === "Date Found") {
      activeAddressColumn = findColumn(row, "Address", 5);
      activeLinkColumn = findColumn(row, "Link", 21);
      continue;
    }

    if (/^== \d{4}-\d{2}-\d{2} ==$/.test(firstCell)) {
      continue;
    }

    if (!/^\d{1,2}\/\d{1,2}\/\d{4}/.test(firstCell)) {
      continue;
    }

    listingRows += 1;
    const address = (row[activeAddressColumn] || "").toString().trim();
    const link = (row[activeLinkColumn] || "").toString().trim();

    if (!address && !link) {
      continue;
    }

    const key = dedupKey({
      address: address || undefined,
      url: link || undefined,
    });
    const firstRow = firstRows.get(key);

    if (firstRow !== undefined) {
      duplicates.push({
        row: index + 1,
        firstRow,
        key,
        address,
        link,
      });
    } else {
      firstRows.set(key, index + 1);
    }
  }

  logger.info(`Sheet rows: ${rows.length}`);
  logger.info(`Listing rows: ${listingRows}`);
  logger.info(`Unique listing keys: ${firstRows.size}`);
  logger.info(`Duplicate entries: ${duplicates.length}`);

  if (duplicates.length === 0) {
    logger.info("No duplicates found.");
    return;
  }

  logger.warn("Duplicate listing entries found:");
  const rowsToPrint = SHOW_ALL
    ? duplicates
    : duplicates.slice(0, DEFAULT_ROWS_TO_PRINT);

  for (const duplicate of rowsToPrint) {
    logger.warn(
      `  row ${duplicate.row} duplicates row ${duplicate.firstRow} ` +
        `[${duplicate.key}] ${duplicate.address || duplicate.link}`,
    );
  }

  if (rowsToPrint.length < duplicates.length) {
    logger.info(
      `Showing ${rowsToPrint.length} of ${duplicates.length} duplicates. ` +
        "Use --all to show every entry.",
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`[sheets] Failed: ${error}`);
    process.exit(1);
  });
