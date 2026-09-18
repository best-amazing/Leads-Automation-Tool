// src/scrapers/property-purchase-research/scripts/backfill-dedupe-keys.ts
// ─────────────────────────────────────────────────────────────────────────────
// Backfills every unique dedup key already present in the "New Property
// Research Tool" Google Sheet into the AduDedupeKey table.
//
// Future ADU runs load this table at startup, so listings that have already
// been written to the sheet (from any platform) will not be re-emitted — even
// by a different source or in a later run.
//
// Usage:
//   npm run backfill:dedupe-keys
//   npm run backfill:dedupe-keys -- --dry-run   # report only, don't write
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { google } from "googleapis";
import { prisma } from "../../../db/client";
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
    logger.error("[backfill] SPREADSHEET_ID not found in .env");
    process.exit(1);
  }

  const keyPath = getServiceAccountPath();
  if (!fs.existsSync(keyPath) || !keyPath) {
    logger.error(
      `[backfill] Google service account key not found (${keyPath})`,
    );
    process.exit(1);
  }

  logger.info("═".repeat(60));
  logger.info("Google Sheet Dedup-Key Backfill");
  logger.info("═".repeat(60));
  logger.info(`Sheet: ${SHEET_NAME}`);
  logger.info(`Mode:  ${DRY_RUN ? "dry-run (report only)" : "write to DB"}`);
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
  const rows = getRes.data.values || [];
  logger.info(`Sheet has ${rows.length} rows total`);

  const keys = new Set<string>();
  const seenAddresses = new Set<string>();
  let nonAddressKeys = 0;
  let activeAddressCol = 5; // index of "Address" in the full layout
  let activeLinkCol = 21; // index of "Link" in the full layout

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const first = (r[0] || "").toString().trim();

    if (first === "Date Found") {
      // Day-block header — adopt its column layout for the rows below.
      activeAddressCol = findColumn(r, "Address", 5);
      activeLinkCol = findColumn(r, "Link", 21);
      continue;
    }
    if (/^== \d{4}-\d{2}-\d{2} ==$/.test(first)) continue; // day marker
    if (!/^\d{1,2}\/\d{1,2}\/\d{4}/.test(first)) continue; // not a listing row

    const address = (r[activeAddressCol] || "").toString().trim();
    const link = (r[activeLinkCol] || "").toString().trim();
    if (!address && !link) continue;

    const key = dedupKey({
      address: address || undefined,
      url: link || undefined,
    });
    if (!key) continue;

    keys.add(key);
    if (address) {
      const simple = address.toLowerCase().replace(/\s+/g, " ");
      if (seenAddresses.has(simple)) continue;
      seenAddresses.add(simple);
    } else {
      nonAddressKeys++;
    }
  }

  logger.info(`Unique dedup keys parsed from sheet: ${keys.size}`);
  if (nonAddressKeys > 0) {
    logger.info(`  (${nonAddressKeys} key(s) derived from URL fallback)`);
  }

  if (keys.size === 0) {
    logger.info("Nothing to backfill.");
    return;
  }

  if (DRY_RUN) {
    logger.info("─".repeat(60));
    logger.info(`Dry run — ${keys.size} key(s) would be upserted.`);
    for (const k of Array.from(keys).slice(0, 5)) logger.info(`  · ${k}`);
    if (keys.size > 5) logger.info(`  · … and ${keys.size - 5} more`);
    return;
  }

  const keyList = Array.from(keys);
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < keyList.length; i += CHUNK) {
    const chunk = keyList.slice(i, i + CHUNK).map((k) => ({ dedupKey: k }));
    const res = await prisma.aduDedupeKey.createMany({
      data: chunk,
      skipDuplicates: true,
    });
    inserted += res.count;
    logger.info(`  Inserted ${inserted}/${keyList.length} keys`);
  }

  logger.info("─".repeat(60));
  logger.info(
    `Done — ${inserted}/${keys.size} new key(s) written ` +
      (inserted < keys.size ? `(${keys.size - inserted} already existed)` : ""),
  );
  logger.info("═".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`[backfill] Failed: ${err}`);
    process.exit(1);
  });