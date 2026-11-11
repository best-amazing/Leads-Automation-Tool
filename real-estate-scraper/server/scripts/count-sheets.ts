import "dotenv/config";
import { google } from "googleapis";
import * as path from "path";
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
      range: tabRange(tab.title, "A:Z"),
    });
    const rows = res.data.values || [];
    
    let headerIdx = -1;
    let dateCol = 0;
    let sourceCol = 3;
    let deedCol = -1;

    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const r = rows[i];
      if (r.includes("Date Found") || r.includes("Address")) {
        headerIdx = i;
        dateCol = r.indexOf("Date Found") >= 0 ? r.indexOf("Date Found") : 0;
        sourceCol = r.indexOf("Source") >= 0 ? r.indexOf("Source") : 3;
        deedCol = r.indexOf("Deed Transfer Date");
        break;
      }
    }

    const dataRows = rows.slice(headerIdx + 1).filter((r: any[]) => r.length > 0 && (r[dateCol] || r[3] || r[5]));
    
    const recentRows = dataRows.filter((r: any[]) => {
      const d = (r[dateCol] || "").trim().split(" ")[0];
      return d === "11/2/2026" || d === "10/30/2026";
    });

    let hasDeed = 0;
    let missingDeed = 0;
    const missingBySource: Record<string, number> = {};
    const sampleMissing: any[] = [];

    for (const r of recentRows) {
      const deedVal = (deedCol >= 0 ? r[deedCol] : "")?.toString().trim();
      const src = (r[sourceCol] || "unknown").toString().trim();
      if (deedVal) {
        hasDeed++;
      } else {
        missingDeed++;
        missingBySource[src] = (missingBySource[src] || 0) + 1;
        if (sampleMissing.length < 5) {
          sampleMissing.push({
            date: r[dateCol],
            source: src,
            address: r[5] || r[1],
            url: r.find((c: any) => /^https?:\/\//.test(String(c))),
          });
        }
      }
    }

    console.log(`\n=============================================`);
    console.log(`Sheet: "${tab.title}" (${target === "main" ? "First Sheet (Tool 1)" : "Second Sheet (Tool 2)"})`);
    console.log(`Deed column index: ${deedCol}`);
    console.log(`Total listings from today (11/2) & yesterday (10/30): ${recentRows.length}`);
    console.log(`  With Deed Date:    ${hasDeed}`);
    console.log(`  Missing Deed Date: ${missingDeed}`);
    console.log(`  Missing by source:`, missingBySource);
    console.log(`  Sample missing:`, sampleMissing);
  }
})();
