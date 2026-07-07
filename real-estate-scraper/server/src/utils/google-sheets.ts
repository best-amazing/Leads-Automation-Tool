import { google } from "googleapis";
import * as fs from "fs";
import { logger } from "./logger";
import { AduResearchListing } from "../scrapers/property-purchase-research/adu-research.parser";

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

  const sheetName = "property research";
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
      "City",
      "State",
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
      "Description Preview",
    ];

    const rows = listings.map((l) => {
      // safely extract keyword text if it's an object or string
      const matchedKw = typeof l.matchedKeyword === "string" ? l.matchedKeyword : (l.matchedKeyword as any)?.name || "";
      
      return [
        new Date().toLocaleDateString(),
        l.source || "",
        l.title || "",
        l.address || "",
        l.city || "",
        l.state || "",
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
        l.description ? l.description.substring(0, 150).replace(/\n/g, " ") : "",
      ];
    });

    // Check if headers already exist
    const getRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A1:Z1`,
    });

    const hasHeaders = getRes.data.values && getRes.data.values.length > 0;
    const dataToAppend = hasHeaders ? rows : [headers, ...rows];

    logger.info(`[sheets] Appending ${listings.length} rows to "${sheetName}"...`);
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: dataToAppend,
      },
    });

    logger.info(`[sheets] Successfully wrote to Google Sheets!`);
  } catch (error: any) {
    logger.error(`[sheets] Failed to write to Google Sheets: ${error.message}`);
  }
}
