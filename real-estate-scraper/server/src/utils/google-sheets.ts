import { google } from "googleapis";
import * as fs from "fs";
import {
  extractKeywordContext,
  displayAddress,
} from "../scrapers/property-purchase-research/core/adu-csv-writer";
import * as os from "os";
import { logger } from "./logger";
import { AduResearchListing } from "../scrapers/property-purchase-research/core/adu-research.parser";

import * as path from "path";

function getServiceAccountPath(): string {
  // If the key is provided base64-encoded (e.g. on Render, where files can't
  // be uploaded), decode it to a temp file on first use.
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64;
  if (b64) {
    try {
      const decoded = Buffer.from(b64, "base64").toString("utf-8");
      JSON.parse(decoded); // validate it's a JSON key
      const tempPath = path.join(os.tmpdir(), "google-service-account.json");
      if (
        !fs.existsSync(tempPath) ||
        fs.readFileSync(tempPath, "utf-8") !== decoded
      ) {
        fs.writeFileSync(tempPath, decoded, { mode: 0o600 });
        logger.info(
          "[sheets] Decoded GOOGLE_SERVICE_ACCOUNT_KEY_B64 to temp key file",
        );
      }
      return tempPath;
    } catch (err) {
      logger.error(
        `[sheets] Failed to decode GOOGLE_SERVICE_ACCOUNT_KEY_B64: ${err}`,
      );
    }
  }

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

export const ADU_SHEET_HEADERS = [
  "Date Found",
  "Owner",
  "Source",
  "Listing Status",
  "Days on Market",
  "Address",
  "Zip",
  "Price",
  "Beds",
  "Baths",
  "SqFt",
  "Lot Size (acres)",
  "Property Owner",
  "Phone Number",
  "Email address",
  "Units",
  "Total Bedrooms",
  "Year Built",
  "School Rating",
  "Deed Transfer Date",
  "Matched Keyword",
  "Link",
  "Description Preview",
];

/**
 * Maps a listing to the exact sheet row order of ADU_SHEET_HEADERS.
 * Exported so the column mapping can be unit-checked offline without
 * touching the live spreadsheet.
 */
export function buildAduSheetRow(l: AduResearchListing): any[] {
  // safely extract keyword text if it's an object or string
  const matchedKw =
    typeof l.matchedKeyword === "string"
      ? l.matchedKeyword
      : (l.matchedKeyword as any)?.name || "";

  return [
    new Date().toLocaleDateString(),
    "Eddy Ephraim",
    l.source || "",
    l.status || "",
    l.daysOnMarket != null ? l.daysOnMarket.toString() : "",
    displayAddress(l),
    l.zip || "",
    l.price ? `$${l.price.toLocaleString()}` : "",
    l.bedrooms || "",
    l.bathrooms != null ? l.bathrooms : "",
    l.squareFeet || "",
    l.lotSqft != null ? (l.lotSqft / 43560).toFixed(2) : "",
    l.ownerName || "",
    l.ownerPhone || "",
    l.ownerEmail || "",
    l.units || "",
    l.totalBedrooms || "",
    // "Unknown" flags leads that passed the new-construction check on
    // wording alone (no listing or public-record year) for manual review.
    l.yearBuilt || "Unknown",
    l.schoolRating || "",
    l.deedTransferDate || "", // resolved via ATTOM / OGRIP
    matchedKw,
    l.url || "",
    extractKeywordContext(l.description, matchedKw).replace(/\n/g, " "),
  ];
}

function buildAduDupKey(listing: AduResearchListing): string | null {
  if (listing.url) return `url:${listing.url}`;
  const address = String(listing.address ?? "").trim();
  const zip = String(listing.zip ?? "").trim();
  if (!address && !zip) return null;
  const normalizedAddress = address
    .replace(/\s+/g, " ")
    .replace(
      /\b(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|ct|court|pl|place|way)\b/gi,
      "",
    )
    .replace(/[^a-z0-9\s]/gi, "")
    .trim()
    .toLowerCase();
  return `addr:${normalizedAddress}|zip:${zip}`;
}

// ── Spreadsheet targets ─────────────────────────────────────────────────────
// "main"   — the original property research tab
// "strict" — the second property research tab (tighter criteria). By default
//            it's a tab in the same workbook; SPREADSHEET_ID_STRICT /
//            ADU_STRICT_SHEET_TAB can point it elsewhere.
export type SheetTarget = "main" | "strict";

function targetConfig(target: SheetTarget): {
  spreadsheetId: string | undefined;
  sheetName: string;
} {
  if (target === "strict") {
    return {
      spreadsheetId: process.env.SPREADSHEET_ID_STRICT || process.env.SPREADSHEET_ID,
      sheetName:
        process.env.ADU_STRICT_SHEET_TAB || "Second Property Research Spreadsheet",
    };
  }
  return {
    spreadsheetId: process.env.SPREADSHEET_ID,
    sheetName: "New Property Research Tool",
  };
}

export function isSheetTargetConfigured(target: SheetTarget): boolean {
  return !!targetConfig(target).spreadsheetId;
}

// Per-spreadsheet cached state. Each target has its own existing-link cache,
// last-row pointer, daily-header flag, write chain and buffer, so duplicates
// are tracked within each spreadsheet independently.
interface TargetState {
  existingLinks: Set<string> | null;
  stateLoaded: boolean;
  lastRow: number;
  hasTodayData: boolean;
  sheetId: number | undefined;
  // Writes are serialized per spreadsheet: each write computes its target row
  // from lastRow, so concurrent writes would otherwise overwrite each other.
  writeChain: Promise<void>;
  buffer: AduResearchListing[];
  flushTimer: NodeJS.Timeout | null;
}

const targetStates = new Map<SheetTarget, TargetState>();

function stateFor(target: SheetTarget): TargetState {
  let st = targetStates.get(target);
  if (!st) {
    st = {
      existingLinks: null,
      stateLoaded: false,
      lastRow: 0,
      hasTodayData: false,
      sheetId: undefined,
      writeChain: Promise.resolve(),
      buffer: [],
      flushTimer: null,
    };
    targetStates.set(target, st);
  }
  return st;
}

// Sheets client is resolved once per process (reset on error) instead of
// re-authenticating per write; it's shared by both spreadsheets.
let cachedSheetsClient: ReturnType<typeof google.sheets> | null = null;

export function writeAduResearchToSheets(
  listings: AduResearchListing[],
  target: SheetTarget = "main",
): Promise<void> {
  const st = stateFor(target);
  const run = st.writeChain.then(() => writeAduResearchToSheetsNow(listings, target));
  st.writeChain = run.catch(() => {});
  return run;
}

// ── Buffered writer ─────────────────────────────────────────────────────────
// Matches are collected and flushed as one append every ADU_SHEETS_FLUSH_SIZE
// rows or ADU_SHEETS_FLUSH_MS, keeping well under the Sheets write quota.
const SHEETS_FLUSH_SIZE = Number(process.env.ADU_SHEETS_FLUSH_SIZE ?? 20);
const SHEETS_FLUSH_MS = Number(process.env.ADU_SHEETS_FLUSH_MS ?? 15_000);
let sheetsExitHooked = false;

export function queueAduSheetWrite(
  listing: AduResearchListing,
  target: SheetTarget = "main",
): void {
  const st = stateFor(target);
  st.buffer.push(listing);
  hookSheetsFlushOnExit();
  if (st.buffer.length >= SHEETS_FLUSH_SIZE) {
    void flushTarget(target);
  } else if (!st.flushTimer) {
    st.flushTimer = setTimeout(() => void flushTarget(target), SHEETS_FLUSH_MS);
  }
}

async function flushTarget(target: SheetTarget): Promise<void> {
  const st = stateFor(target);
  if (st.flushTimer) {
    clearTimeout(st.flushTimer);
    st.flushTimer = null;
  }
  const batch = st.buffer;
  st.buffer = [];
  if (batch.length > 0) {
    await writeAduResearchToSheets(batch, target).catch((err) =>
      logger.error(`[sheets:${target}] Buffered flush failed: ${err}`),
    );
  } else {
    await st.writeChain;
  }
}

/** Flushes buffered rows for every spreadsheet. */
export async function flushAduSheetWrites(): Promise<void> {
  await Promise.all([...targetStates.keys()].map(flushTarget));
}

function hookSheetsFlushOnExit(): void {
  if (sheetsExitHooked) return;
  sheetsExitHooked = true;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      const buffered = [...targetStates.values()].reduce((n, s) => n + s.buffer.length, 0);
      logger.info(`[sheets] ${signal} — flushing ${buffered} buffered row(s)`);
      // Best effort: other shutdown handlers may exit first. Cap the wait so a
      // hung Sheets call can't block shutdown.
      Promise.race([
        flushAduSheetWrites(),
        new Promise((r) => setTimeout(r, 10_000)),
      ]).finally(() => process.exit(0));
    });
  }
}

async function writeAduResearchToSheetsNow(
  listings: AduResearchListing[],
  target: SheetTarget,
) {
  if (listings.length === 0) return;

  const { spreadsheetId, sheetName } = targetConfig(target);
  if (!spreadsheetId) {
    logger.warn(
      `[sheets:${target}] SPREADSHEET_ID not set, skipping Google Sheets upload.`,
    );
    return;
  }
  const st = stateFor(target);

  const keyPath = getServiceAccountPath();

  if (!fs.existsSync(keyPath)) {
    logger.error(
      `[sheets:${target}] Google service account key not found at ${keyPath}. Skipping upload.`,
    );
    return;
  }

  let attempt = 0;
  const maxRetries = 3;

  while (attempt < maxRetries) {
    try {
      if (!cachedSheetsClient) {
        const auth = new google.auth.GoogleAuth({
          keyFile: keyPath,
          scopes: ["https://www.googleapis.com/auth/spreadsheets"],
        });
        cachedSheetsClient = google.sheets({ version: "v4", auth });
        st.sheetId = undefined;
      }
      const sheets = cachedSheetsClient;

      // Check if sheet exists (once per process)
      let sheetExists = st.sheetId !== undefined;
      let sheetId: number | undefined = st.sheetId;
      if (!sheetExists) {
        const meta = await sheets.spreadsheets.get({ spreadsheetId });
        meta.data.sheets?.forEach((s) => {
          if (s.properties?.title === sheetName) {
            sheetExists = true;
            sheetId = s.properties.sheetId ?? undefined;
          }
        });
      }

      if (!sheetExists) {
        logger.info(`[sheets:${target}] Creating new sheet "${sheetName}"`);
        const createRes = await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                addSheet: {
                  properties: {
                    title: sheetName,
                  },
                },
              },
            ],
          },
        });
        sheetId =
          createRes.data.replies?.[0]?.addSheet?.properties?.sheetId ??
          undefined;
      }
      st.sheetId = sheetId;

      const headers = ADU_SHEET_HEADERS;

      const rows = listings.map(buildAduSheetRow);

      // Load the current state of the sheet once per process so we always know
      // the exact last row (no table-detection guessing).
      if (!st.stateLoaded) {
        st.stateLoaded = true;
        st.existingLinks = new Set<string>();
        st.lastRow = 0;
        st.hasTodayData = false;

        try {
          const getRes = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${sheetName}!A:W`,
          });

          const existingRows = getRes.data.values || [];
          st.lastRow = existingRows.length;

          if (st.lastRow > 0) {
            const headerRow = existingRows[0];
            let linkIndex = headerRow.indexOf("Link");
            if (linkIndex === -1) linkIndex = 21; // fallback to index 21 (V)

            for (let i = 1; i < existingRows.length; i++) {
              const row = existingRows[i];
              if (row && row[linkIndex]) {
                st.existingLinks.add(row[linkIndex]);
              }
            }

            // A header block is written once per day. Determine whether today's
            // block already exists: find the last header row, then check whether
            // any data rows after it are dated today. This is restart-proof —
            // Render recycles the instance between runs, so the decision must
            // come from the sheet itself, not process memory.
            const todayStr = new Date().toLocaleDateString();
            let lastHeaderIdx = -1;
            for (let i = existingRows.length - 1; i >= 0; i--) {
              if (existingRows[i]?.[0] === "Date Found") {
                lastHeaderIdx = i;
                break;
              }
            }
            for (let i = lastHeaderIdx + 1; i < existingRows.length; i++) {
              if (existingRows[i]?.[0] === todayStr) {
                st.hasTodayData = true;
                break;
              }
            }
          }
        } catch (err) {
          // If sheet doesn't exist yet, get() might throw, which is fine
          st.lastRow = 0;
          st.hasTodayData = false;
        }
      }

      const dedupedKeys = new Set<string>();
      const rowsWithListings = rows.map((row, rowIndex) => ({
        row,
        listing: listings[rowIndex],
      }));

      const newRows = rowsWithListings
        .filter(({ row, listing }) => {
          const link = row[21]; // Link is now at index 21
          if (link && st.existingLinks?.has(link)) {
            return false;
          }

          const rowKey = link ? `url:${String(link)}` : null;
          if (rowKey && st.existingLinks?.has(rowKey)) {
            return false;
          }

          const addressKey = listing ? buildAduDupKey(listing) : null;
          if (addressKey) {
            if (st.existingLinks?.has(addressKey)) {
              return false;
            }
            if (dedupedKeys.has(addressKey)) {
              return false;
            }
            dedupedKeys.add(addressKey);
          }

          return true;
        })
        .map(({ row }) => row);

      if (newRows.length === 0) {
        logger.info(
          `[sheets:${target}] All ${listings.length} listings already exist in Google Sheets. Skipping append.`,
        );
        break; // break instead of return
      }

      let nextRow = st.lastRow + 1;

      // Write a bold header at the top of today's block, but only once per day.
      // Restart-proof: the decision comes from the sheet state (no data rows
      // dated today exist yet), not process memory.
      if (!st.hasTodayData && sheetId !== undefined) {
        logger.info(`[sheets:${target}] Writing bold header row at row ${nextRow}...`);
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                updateCells: {
                  range: {
                    sheetId,
                    startRowIndex: nextRow - 1,
                    startColumnIndex: 0,
                    endColumnIndex: headers.length,
                  },
                  rows: [
                    {
                      values: headers.map((h) => ({
                        userEnteredValue: { stringValue: h },
                        userEnteredFormat: { textFormat: { bold: true } },
                      })),
                    },
                  ],
                  fields: "userEnteredValue,userEnteredFormat.textFormat.bold",
                },
              },
            ],
          },
        });
        st.hasTodayData = true;
        nextRow += 1;
        st.lastRow += 1;
      }

      logger.info(
        `[sheets:${target}] Writing ${newRows.length} new rows to "${sheetName}" starting at row ${nextRow} (skipped ${listings.length - newRows.length} duplicates)...`,
      );
      const response = await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!A${nextRow}`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: newRows,
        },
      });

      // Update caches
      st.lastRow += newRows.length;
      if (st.existingLinks) {
        for (const row of newRows) {
          const link = row[21];
          if (link) {
            st.existingLinks.add(String(link));
            st.existingLinks.add(`url:${String(link)}`);
          }
        }

        for (const listing of listings) {
          if (listing) {
            const addressKey = buildAduDupKey(listing);
            if (addressKey) {
              st.existingLinks.add(addressKey);
            }
          }
        }
      }

      const updatedRange = response.data.updatedRange;
      logger.info(
        `[sheets:${target}] Successfully wrote to Google Sheets at range: ${updatedRange}`,
      );
      break; // Success! Break out of the retry loop
    } catch (error: any) {
      attempt++;
      st.stateLoaded = false; // reload true sheet state before retrying
      cachedSheetsClient = null;
      st.sheetId = undefined;
      logger.error(
        `[sheets:${target}] Failed to write to Google Sheets (attempt ${attempt}/${maxRetries}): ${error.message}`,
      );
      if (attempt >= maxRetries) {
        logger.error(
          `[sheets:${target}] Max retries reached. Listing could not be uploaded.`,
        );
        break;
      }
      // Wait before retrying (2s, 4s, etc)
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}
