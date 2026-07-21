import { google } from "googleapis";
import * as fs from "fs";
import { logger } from "./logger";
import { AduResearchListing } from "../scrapers/property-purchase-research/adu-research.parser";

let cachedExistingLinks: Set<string> | null = null;
let cachedHasHeaders = false;
let hasWrittenHeaderForRun = false;

function getServiceAccountPath(): string {
  let p = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || "";
  // Fix WSL path for Windows
  if (p.startsWith("/mnt/c/")) {
    p = "C:\\\\" + p.slice(7).replace(/\//g, "\\\\");
  }
  return p;
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

  const sheetName = "property research tool";
  const keyPath = getServiceAccountPath();

  if (!fs.existsSync(keyPath)) {
    logger.error(`[sheets] Google service account key not found at ${keyPath}. Skipping upload.`);
    return;
  }

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
      "Lot Size (sqft)",
      "Property Owner",
      "Phone Number",
      "Email address",
      "Units",
      "Total Bedrooms",
      "Year Built",
      "School Rating",
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
        l.lotSqft || "",
        l.ownerName || "",
        l.ownerPhone || "",
        l.ownerEmail || "",
        l.units || "",
        l.totalBedrooms || "",
        l.yearBuilt || "",
        l.schoolRating || "",
        matchedKw,
        l.url || "",
        l.description ? l.description.replace(/\n/g, " ") : "",
      ];
    });

    // Cache existing links to avoid fetching entire sheet on every match
    if (!cachedExistingLinks) {
      cachedExistingLinks = new Set<string>();
      
      try {
        const getRes = await sheets.spreadsheets.values.get({
          spreadsheetId,
          range: `${sheetName}!A:Z`,
        });
        
        const existingRows = getRes.data.values || [];
        cachedHasHeaders = existingRows.length > 0;
        
        if (cachedHasHeaders) {
          const headerRow = existingRows[0];
          let linkIndex = headerRow.indexOf("Link");
          if (linkIndex === -1) linkIndex = 20; // fallback to index 20
          
          for (let i = 1; i < existingRows.length; i++) {
            const row = existingRows[i];
            if (row && row[linkIndex]) {
              cachedExistingLinks.add(row[linkIndex]);
            }
          }
        }
      } catch (err) {
        // If sheet doesn't exist yet, get() might throw, which is fine
        cachedHasHeaders = false;
      }
    }

    const newRows = rows.filter((row) => {
      const link = row[20];
      if (link && cachedExistingLinks?.has(link)) {
        return false;
      }
      return true;
    });

    if (newRows.length === 0) {
      logger.info(`[sheets] All ${listings.length} listings already exist in Google Sheets. Skipping append.`);
      return;
    }

    if (!hasWrittenHeaderForRun && sheetId !== undefined) {
      logger.info(`[sheets] First run today: appending bold header row...`);
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              appendCells: {
                sheetId,
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
      hasWrittenHeaderForRun = true;
      cachedHasHeaders = true;
    }

    logger.info(`[sheets] Appending ${newRows.length} new rows to "${sheetName}" (skipped ${listings.length - newRows.length} duplicates)...`);
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: newRows,
      },
    });

    // Update caches
    cachedHasHeaders = true;
    for (const row of newRows) {
      if (row[20]) {
        cachedExistingLinks.add(row[20]);
      }
    }

    logger.info(`[sheets] Successfully wrote to Google Sheets!`);
  } catch (error: any) {
    logger.error(`[sheets] Failed to write to Google Sheets: ${error.message}`);
  }
}
