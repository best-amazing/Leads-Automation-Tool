import { google } from "googleapis";
import * as fs from "fs";
import * as os from "os";
import { logger } from "./logger";
import { AduResearchListing } from "../scrapers/property-purchase-research/adu-research.parser";

let cachedExistingLinks: Set<string> | null = null;
let stateLoaded = false;
let cachedLastRow = 0;
let cachedLastRowIsHeader = false;
let headerWrittenThisRun = false;

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
      if (!fs.existsSync(tempPath) || fs.readFileSync(tempPath, "utf-8") !== decoded) {
        fs.writeFileSync(tempPath, decoded, { mode: 0o600 });
        logger.info("[sheets] Decoded GOOGLE_SERVICE_ACCOUNT_KEY_B64 to temp key file");
      }
      return tempPath;
    } catch (err) {
      logger.error(`[sheets] Failed to decode GOOGLE_SERVICE_ACCOUNT_KEY_B64: ${err}`);
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
    path.join(__dirname, "../..", "amazing-properties-447020-b2f3946f4b3e.json"),
    path.join(__dirname, "../../..", "amazing-properties-447020-b2f3946f4b3e.json")
  ];

  for (const cand of candidates) {
    if (cand && fs.existsSync(cand)) {
      return cand;
    }
  }

  return raw;
}

export async function writeAduResearchToSheets(
  listings: AduResearchListing[]
) {
  if (listings.length === 0) return;

  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) {
    logger.warn("[sheets] SPREADSHEET_ID not found in .env, skipping Google Sheets upload.");
    return;
  }

  const sheetName = "New Property Research Tool";
  const keyPath = getServiceAccountPath();

  if (!fs.existsSync(keyPath)) {
    logger.error(`[sheets] Google service account key not found at ${keyPath}. Skipping upload.`);
    return;
  }

  let attempt = 0;
  const maxRetries = 3;

  while (attempt < maxRetries) {
    try {
      const auth = new google.auth.GoogleAuth({
        keyFile: keyPath,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      });

      const sheets = google.sheets({ version: "v4", auth });

      // Check if sheet exists
      const meta = await sheets.spreadsheets.get({ spreadsheetId });
      let sheetExists = false;
      let sheetId: number | undefined;
      meta.data.sheets?.forEach((s) => {
        if (s.properties?.title === sheetName) {
           sheetExists = true;
           sheetId = s.properties.sheetId ?? undefined;
        }
      });

      if (!sheetExists) {
        logger.info(`[sheets] Creating new sheet "${sheetName}"`);
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
        sheetId = createRes.data.replies?.[0]?.addSheet?.properties?.sheetId ?? undefined;
      }

      const headers = [
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

      const rows = listings.map((l) => {
        // safely extract keyword text if it's an object or string
        const matchedKw = typeof l.matchedKeyword === "string" ? l.matchedKeyword : (l.matchedKeyword as any)?.name || "";
        
        return [
          new Date().toLocaleDateString(),
          "Eddy Ephraim",
          l.source || "",
          l.status || "",
          l.daysOnMarket != null ? l.daysOnMarket.toString() : "",
          l.address || "",
          l.zip || "",
          l.price ? `$${l.price.toLocaleString()}` : "",
          l.bedrooms || "",
          l.bathrooms || "",
          l.squareFeet || "",
          l.lotSqft != null ? (l.lotSqft / 43560).toFixed(2) : "",
          l.ownerName || "",
          l.ownerPhone || "",
          l.ownerEmail || "",
          l.units || "",
          l.totalBedrooms || "",
          l.yearBuilt || "",
          l.schoolRating || "",
          (l as any).deedTransferDate || "", // Deed Transfer Date (resolved via ATTOM / OGRIP)
          matchedKw,
          l.url || "",
          l.description ? l.description.replace(/\n/g, " ") : "",
        ];
      });

      // Load the current state of the sheet once per process so we always know
      // the exact last row (no table-detection guessing).
      if (!stateLoaded) {
        stateLoaded = true;
        cachedExistingLinks = new Set<string>();
        cachedLastRow = 0;
        cachedLastRowIsHeader = false;
        headerWrittenThisRun = false;

        try {
          const getRes = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${sheetName}!A:W`,
          });

          const existingRows = getRes.data.values || [];
          cachedLastRow = existingRows.length;
          cachedLastRowIsHeader =
            cachedLastRow > 0 && existingRows[cachedLastRow - 1]?.[0] === "Date Found";

          if (cachedLastRow > 0) {
            const headerRow = existingRows[0];
            let linkIndex = headerRow.indexOf("Link");
            if (linkIndex === -1) linkIndex = 21; // fallback to index 21 (V)

            for (let i = 1; i < existingRows.length; i++) {
              const row = existingRows[i];
              if (row && row[linkIndex]) {
                cachedExistingLinks.add(row[linkIndex]);
              }
            }
          }
        } catch (err) {
          // If sheet doesn't exist yet, get() might throw, which is fine
          cachedLastRow = 0;
          cachedLastRowIsHeader = false;
        }
      }

      const newRows = rows.filter((row) => {
        const link = row[21]; // Link is now at index 21
        if (link && cachedExistingLinks?.has(link)) {
          return false;
        }
        return true;
      });

      if (newRows.length === 0) {
        logger.info(`[sheets] All ${listings.length} listings already exist in Google Sheets. Skipping append.`);
        break; // break instead of return
      }

      let nextRow = cachedLastRow + 1;

      // Write a bold header at the top of this run's block when the sheet is
      // empty or the last row isn't already the header (daily runs).
      if (!headerWrittenThisRun && !cachedLastRowIsHeader && sheetId !== undefined) {
        logger.info(`[sheets] Writing bold header row at row ${nextRow}...`);
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
        headerWrittenThisRun = true;
        cachedLastRowIsHeader = true;
        nextRow += 1;
        cachedLastRow += 1;
      }

      logger.info(`[sheets] Writing ${newRows.length} new rows to "${sheetName}" starting at row ${nextRow} (skipped ${listings.length - newRows.length} duplicates)...`);
      const response = await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!A${nextRow}`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: newRows,
        },
      });

      // Update caches
      cachedLastRow += newRows.length;
      if (cachedExistingLinks) {
        for (const row of newRows) {
          if (row[21]) {
            cachedExistingLinks.add(row[21]);
          }
        }
      }

      const updatedRange = response.data.updatedRange;
      logger.info(`[sheets] Successfully wrote to Google Sheets at range: ${updatedRange}`);
      break; // Success! Break out of the retry loop
    } catch (error: any) {
      attempt++;
      stateLoaded = false; // reload true sheet state before retrying
      logger.error(`[sheets] Failed to write to Google Sheets (attempt ${attempt}/${maxRetries}): ${error.message}`);
      if (attempt >= maxRetries) {
        logger.error(`[sheets] Max retries reached. Listing could not be uploaded.`);
        break;
      }
      // Wait before retrying (2s, 4s, etc)
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
}
