import "dotenv/config";
import { google } from "googleapis";
import * as path from "path";
import { AduDedupeTracker } from "../src/scrapers/property-purchase-research/core/adu-dedupe-tracker";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sheetKeys } = require("./console-sheet-keys");

const KEY_FILE = path.join(process.cwd(), "amazing-properties-447020-b2f3946f4b3e.json");
const auth = new google.auth.GoogleAuth({ keyFile: KEY_FILE, scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
const sheets = google.sheets({ version: "v4", auth });
const SPREADSHEET_ID = "160skIk8n50KCid-G_aFolge7sW9LWC3ZpY1lCmIkDWk";

(async () => {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "'Eddy Property under200k_Tool2'!A1:Z500",
  });
  const rows = res.data.values || [];
  console.log(`Total rows in Tool 2: ${rows.length}`);
  
  rows.forEach((r, idx) => {
    const rowStr = JSON.stringify(r);
    if (/Mott/i.test(rowStr)) {
      console.log(`Found Mott at Row ${idx + 1}:`, r[0], r[5] || r[1]);
    }
    if (/Osage/i.test(rowStr) || /Second/i.test(rowStr)) {
      console.log(`Found Osage/Second at Row ${idx + 1}:`, r[0], r[5] || r[1]);
    }
  });

  const mottKeys = sheetKeys("906 908 Mott, New Madrid, MO 63869", "63869", "https://www.realtor.com/realestateandhomes-detail/906-908-Mott_New-Madrid_MO_63869_M99933-74795");
  const osageKeys = sheetKeys("112 N Second St, Osage City, KS 66523", "66523", "https://www.realtor.com/realestateandhomes-detail/112-N-2nd-St_Osage-City_KS_66523_M93859-26728");
  console.log("Mott generated keys:", mottKeys);
  console.log("Osage generated keys:", osageKeys);

  const tracker = new AduDedupeTracker();
  const mottTrack = await tracker.track({ address: "906 908 Mott, New Madrid, MO 63869", zip: "63869", url: "https://www.realtor.com/realestateandhomes-detail/906-908-Mott_New-Madrid_MO_63869_M99933-74795" }, "strict");
  const osageTrack = await tracker.track({ address: "112 N Second St, Osage City, KS 66523", zip: "66523", url: "https://www.realtor.com/realestateandhomes-detail/112-N-2nd-St_Osage-City_KS_66523_M93859-26728" }, "strict");
  console.log("Mott tracker would allow?", mottTrack);
  console.log("Osage tracker would allow?", osageTrack);
})();
