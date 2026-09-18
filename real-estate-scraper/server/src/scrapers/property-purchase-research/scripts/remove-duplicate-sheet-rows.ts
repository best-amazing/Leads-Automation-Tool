// src/scrapers/property-purchase-research/scripts/remove-duplicate-sheet-rows.ts
// ─────────────────────────────────────────────────────────────────────────────
// Removes duplicate listing rows from the "New Property Research Tool" Google
// Sheet. For each dedup key, the first occurrence (topmost row) is kept and
// later copies of the same key are deleted. Header blocks and day markers
// (`== YYYY-MM-DD ==`) are preserved.
//
// Usage:
//   npm run sheet:remove-duplicates            # delete duplicate rows
//   npm run sheet:remove-duplicates -- --dry-run   # report only
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { google } from "googleapis";
import { logger } from "../../../utils/logger";
import { dedupKey } from "../filters/address-dedupe";

const SHEET_NAME = "New Property Research Tool";
const DRY_RUN = process.argv.includes("--dry-run");

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

  for (const cand of candidates) {
    if (cand && fs.existsSync(cand)) {
      return cand;
    }
  }
  return raw;
}

function findColumn(headers: string[], name: string, fallback: number): number {
  const idx = headers.indexOf(name);
  return idx >= 0 ? idx : fallback;
}

async function main(): Promise<void> {
  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) {
    logger.error("[sheets] SPREADSHEET_ID not found in .env");
    process.exit(1);
  }

  const keyPath = getServiceAccountPath();
  if (!fs.existsSync(keyPath) || !keyPath) {
    logger.error(`[sheets] Google service account key not found (${keyPath})`);
    process.exit(1);
  }

  logger.info("═".repeat(60));
  logger.info("Google Sheet Duplicate Row Removal");
  logger.info("═".repeat(60));
  logger.info(`Sheet: ${SHEET_NAME}`);
  logger.info(`Mode:  ${DRY_RUN ? "dry-run (report only)" : "DELETE rows"}`);
  logger.info("─".repeat(60));

  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  const getRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_NAME}!A:Z`,
  });
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet =
    meta.data.sheets?.find((s) => s.properties?.title === SHEET_NAME)?.properties
      ?.sheetId ??
    (() => {
      throw new Error(`Sheet "${SHEET_NAME}" not found`);
    })();

  const rows = getRes.data.values || [];
  logger.info(`Sheet has ${rows.length} rows total`);

  let activeAddressCol = 5;
  let activeLinkCol = 21;
  const seen = new Set<string>();
  const toDelete: { row: number; key: string; address: string }[] = [];
  let listingRows = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const first = (r[0] || "").toString().trim();

    if (first === "Date Found") {
      activeAddressCol = findColumn(r, "Address", 5);
      activeLinkCol = findColumn(r, "Link", 21);
      continue;
    }
    if (/^== \d{4}-\d{2}-\d{2} ==$/.test(first)) continue;
    if (!/^\d{1,2}\/\d{1,2}\/\d{4}/.test(first)) continue;

    listingRows++;
    const address = (r[activeAddressCol] || "").toString().trim();
    const link = (r[activeLinkCol] || "").toString().trim();
    if (!address && !link) continue;

    const key = dedupKey({
      address: address || undefined,
      url: link || undefined,
    });
    if (seen.has(key)) {
      toDelete.push({ row: i + 1, key, address });
    } else {
      seen.add(key);
    }
  }

  logger.info(`Listing rows: ${listingRows}`);
  logger.info(`Unique keys (kept): ${seen.size}`);
  logger.info(`Duplicate rows (to delete): ${toDelete.length}`);

  if (toDelete.length === 0) {
    logger.info("Nothing to delete.");
    return;
  }

  if (DRY_RUN) {
    logger.info("─".repeat(60));
    logger.info("Rows that would be deleted:");
    for (const d of toDelete.slice(0, 25)) {
      logger.info(`  #${d.row} [${d.key}] ${d.address}`);
    }
    if (toDelete.length > 25) {
      logger.info(`  … and ${toDelete.length - 25} more`);
    }
    return;
  }

  // Delete from bottom to top so row indices stay valid.
  const sorted = [...toDelete].sort((a, b) => b.row - a.row);
  const CHUNK = 100; // max 100 requests per batchUpdate
  let deleted = 0;

  for (let i = 0; i < sorted.length; i += CHUNK) {
    const chunk = sorted.slice(i, i + CHUNK);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: chunk.map((d) => ({
          deleteDimension: {
            range: {
              sheetId: sheet,
              dimension: "ROWS",
              startIndex: d.row - 1,
              endIndex: d.row,
            },
          },
        })),
      },
    });
    deleted += chunk.length;
    logger.info(`  Deleted ${deleted}/${toDelete.length} rows`);
  }

  logger.info("─".repeat(60));
  logger.info(`Done — ${deleted} duplicate row(s) deleted from "${SHEET_NAME}".`);
  logger.info("═".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`[sheets] Failed: ${err}`);
    process.exit(1);
  });