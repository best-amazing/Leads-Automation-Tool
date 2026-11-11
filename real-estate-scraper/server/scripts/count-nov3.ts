import "dotenv/config";
import * as path from "path";
import { google } from "googleapis";
import { resolveAduTab, tabRange } from "../src/utils/google-sheets";

const KEY_FILE = path.join(__dirname, "..", "amazing-properties-447020-b2f3946f4b3e.json");

(async () => {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  for (const target of ["main", "strict"] as const) {
    const tab = await resolveAduTab(sheets, target);
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: tab.spreadsheetId,
      range: tabRange(tab.title, "A:A"),
    });
    const vals = res.data.values || [];

    const t3 = vals.filter((r) => r[0] && r[0].includes("11/3/2026")).length;
    const t4 = vals.filter((r) => r[0] && r[0].includes("11/4/2026")).length;
    const label = target === "main" ? "Tab 1" : "Tab 2";
    console.log(`${label} ("${tab.title}"):`);
    console.log(`  11/3/2026: ${t3}`);
    console.log(`  11/4/2026: ${t4}`);
    console.log(`  Combined:  ${t3 + t4}`);
    console.log(`  Total rows: ${vals.length - 1}`);
    console.log();
  }
})();
