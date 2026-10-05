// src/scrapers/property-purchase-research/scripts/remove-new-construction-sheet-rows.ts
// ─────────────────────────────────────────────────────────────────────────────
// Removes new-construction listing rows from the "New Property Research Tool"
// Google Sheet — the same rows `npm run check:new-construction` reports, using
// the pipeline's newConstructionReason() rule. Header blocks and day markers
// are preserved.
//
// Before deleting, every matched row is backed up in full (all columns) to
// logs/removed-new-construction-rows-<timestamp>.csv so it can be restored.
//
// Usage:
//   npm run sheet:remove-new-construction              # back up + delete
//   npm run sheet:remove-new-construction -- --dry-run # report only
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { google } from "googleapis";
import { logger } from "../../../utils/logger";
import { newConstructionReason } from "../filters/adu-research.scraper";

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

function csvEscape(value: unknown): string {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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
  logger.info("Google Sheet New-Construction Row Removal");
  logger.info("═".repeat(60));
  logger.info(`Sheet: ${SHEET_NAME}`);
  logger.info(`Mode:  ${DRY_RUN ? "dry-run (report only)" : "BACK UP + DELETE rows"}`);
  logger.info("─".repeat(60));

  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetId = meta.data.sheets?.find(
    (s) => s.properties?.title === SHEET_NAME,
  )?.properties?.sheetId;
  if (sheetId == null) throw new Error(`Sheet "${SHEET_NAME}" not found`);

  // Re-scan the live sheet now (row numbers shift as the scraper appends).
  const getRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_NAME}!A:Z`,
  });
  const rows = getRes.data.values || [];
  logger.info(`Sheet has ${rows.length} rows total`);

  let col = { address: 5, year: 17, description: 22 };
  let activeHeader: string[] = [];
  const toDelete: { row: number; reason: string; address: string; values: string[]; header: string[] }[] = [];
  let listingRows = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const first = (r[0] || "").toString().trim();

    if (first === "Date Found") {
      activeHeader = r.map(String);
      col = {
        address: findColumn(r, "Address", 5),
        year: findColumn(r, "Year Built", 17),
        description: findColumn(r, "Description Preview", 22),
      };
      continue;
    }
    if (!/^\d{1,2}\/\d{1,2}\/\d{4}/.test(first)) continue;

    listingRows++;
    const year = Number((r[col.year] || "").toString().trim());
    const reason = newConstructionReason({
      yearBuilt: year > 0 ? year : undefined,
      description: (r[col.description] || "").toString(),
    });
    if (!reason) continue;

    toDelete.push({
      row: i + 1,
      reason,
      address: (r[col.address] || "").toString().trim(),
      values: r.map(String),
      header: activeHeader,
    });
  }

  logger.info(`Listing rows: ${listingRows}`);
  logger.info(`New-construction rows (to delete): ${toDelete.length}`);

  if (toDelete.length === 0) {
    logger.info("Nothing to delete.");
    return;
  }

  for (const d of toDelete) {
    logger.info(`  #${d.row} | ${d.reason} | ${d.address}`);
  }

  if (DRY_RUN) {
    logger.info("Dry run — no rows deleted.");
    return;
  }

  // ── Back up every matched row in full before touching the sheet ──────────
  const outDir = path.resolve("logs");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(outDir, `removed-new-construction-rows-${stamp}.csv`);
  const header = toDelete[0].header;
  const backup = [
    ["Original Sheet Row", "Reason", ...header].map(csvEscape).join(","),
    ...toDelete.map((d) =>
      [String(d.row), d.reason, ...d.values].map(csvEscape).join(","),
    ),
  ].join("\n");
  fs.writeFileSync(backupPath, backup, "utf-8");
  logger.info(`Backup written: ${backupPath}`);

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
              sheetId,
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
  logger.info(`Done — ${deleted} new-construction row(s) deleted from "${SHEET_NAME}".`);
  logger.info("═".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`[sheets] Failed: ${err}`);
    process.exit(1);
  });
