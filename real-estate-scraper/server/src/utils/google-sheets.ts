import { google } from "googleapis";
import * as fs from "fs";
import { logger } from "./logger";
import { AduResearchListing } from "../scrapers/property-purchase-research/adu-research.parser";

let cachedExistingLinks: Set<string> | null = null;
let cachedHasHeaders = false;

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
    meta.data.sheets?.forEach((s) => {
      if (s.properties?.title === sheetName) sheetExists = true;
    });

    if (!sheetExists) {
      logger.info(`[sheets] Creating new sheet "${sheetName}"`);
      await sheets.spreadsheets.batchUpdate({
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
    }

    const headers = [
      "Date Found",
      "Source",
      "Title",
      "Address",
      "Zip",
      "Price",
      "Beds",
      "Baths",
      "SqFt",
      "Units",
      "Total Bedrooms",
      "Year Built",
      "School Rating",
      "Matched Keyword",
      "Link",
      "Description",
    ];

    const rows = listings.map((l) => {
      // safely extract keyword text if it's an object or string
      const matchedKw = typeof l.matchedKeyword === "string" ? l.matchedKeyword : (l.matchedKeyword as any)?.name || "";
      
      return [
        new Date().toLocaleDateString(),
        l.source || "",
        l.title || "",
        l.address || "",
        l.zip || "",
        l.price ? `$${l.price.toLocaleString()}` : "",
        l.bedrooms || "",
        l.bathrooms || "",
        l.squareFeet || "",
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
          if (linkIndex === -1) linkIndex = 14; // fallback to index 14
          
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
      const link = row[14];
      if (link && cachedExistingLinks?.has(link)) {
        return false;
      }
      return true;
    });

    if (newRows.length === 0) {
      logger.info(`[sheets] All ${listings.length} listings already exist in Google Sheets. Skipping append.`);
      return;
    }

    const dataToAppend = cachedHasHeaders ? newRows : [headers, ...newRows];

    logger.info(`[sheets] Appending ${newRows.length} new rows to "${sheetName}" (skipped ${listings.length - newRows.length} duplicates)...`);
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: dataToAppend,
      },
    });

    // Update caches
    cachedHasHeaders = true;
    for (const row of newRows) {
      if (row[14]) {
        cachedExistingLinks.add(row[14]);
      }
    }

    logger.info(`[sheets] Successfully wrote to Google Sheets!`);
  } catch (error: any) {
    logger.error(`[sheets] Failed to write to Google Sheets: ${error.message}`);
  }
}
