// scripts/backfill-listing-details.ts
// ─────────────────────────────────────────────────────────────────────────────
// Fills missing listing details on rows already in the property research
// sheets: School Rating, Lot Size, Property Type, HOA and — Tool 1 only —
// the keyword evidence ("Description Preview"). Only EMPTY cells are written;
// nothing already in the sheet is changed.
//
//   npm run backfill:details                    # report what's missing
//   npm run backfill:details -- --cb [--limit N]
//        Coldwell Banker rows: fetched here on the server
//   npm run backfill:details -- --make-console
//        writes scripts/console/backfill/backfill-redfin.js and
//        backfill-zillow.js with the Redfin/Zillow rows that
//        still need data — paste each into a console on that site; it
//        downloads backfill-<site>-<date>.csv
//   npm run backfill:details -- --apply <backfill CSV>
//        writes a console backfill's results into the sheets
//
// Every mode first adds the "Property Type" / "HOA ($/mo)" headers to day
// sections written before those columns existed.
// ─────────────────────────────────────────────────────────────────────────────
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { google } from "googleapis";
import { ADU_SHEET_HEADERS, propertyTypeLabel, resolveAduTab, tabRange } from "../src/utils/google-sheets";
import { extractKeywordContext } from "../src/scrapers/property-purchase-research/core/adu-csv-writer";
import { ColdwellBankerScraper } from "../src/scrapers/coldwellbanker/coldwellbanker.scraper";

const KEY_FILE = path.join(__dirname, "..", "amazing-properties-447020-b2f3946f4b3e.json");
const FIELDS = ["School Rating", "Lot Size (acres)", "Property Type", "HOA ($/mo)", "Description Preview"] as const;
type Field = (typeof FIELDS)[number];

interface SheetRow {
  tab: "main" | "strict";
  title: string;
  rowNumber: number; // 1-based
  url: string;
  keyword: string;
  source: string;
  cols: Partial<Record<Field, number>>; // 0-based column per field
  missing: Field[];
}

/** Details a source can give for one listing. */
interface Details {
  schoolRating?: string;
  description?: string;
  lotSqft?: number;
  homeType?: string;
  hoaFee?: number;
}

const colA1 = (i: number) => {
  let s = "";
  for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
};
const siteOf = (url: string) =>
  /coldwellbanker/.test(url) ? "cb" : /redfin\.com/.test(url) ? "redfin" : /zillow\.com/.test(url) ? "zillow" : "other";

async function loadRows(sheets: any): Promise<SheetRow[]> {
  const out: SheetRow[] = [];
  for (const tab of ["main", "strict"] as const) {
    const t = await resolveAduTab(sheets, tab);
    const values: string[][] =
      (await sheets.spreadsheets.values.get({ spreadsheetId: t.spreadsheetId, range: tabRange(t.title, "A:Z") })).data.values ?? [];

    // Day sections from before the new columns: add their headers first
    const headerFixes = values
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => (r[0] || "").trim() === "Date Found" && !r.includes("Property Type"))
      .map(({ r, i }) => ({
        range: tabRange(t.title, `${colA1(r.length)}${i + 1}`),
        values: [ADU_SHEET_HEADERS.slice(r.length)],
      }));
    if (headerFixes.length) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: t.spreadsheetId,
        requestBody: { valueInputOption: "RAW", data: headerFixes },
      });
      for (const f of headerFixes) {
        const row = Number(f.range.match(/(\d+)$/)![1]) - 1;
        values[row] = [...values[row], ...f.values[0]];
      }
      console.log(`${t.title}: added the new column headers to ${headerFixes.length} day section(s)`);
    }

    let header: string[] = [];
    values.forEach((r, i) => {
      if ((r[0] || "").trim() === "Date Found") { header = r; return; }
      if (!/^\d{1,2}\/\d{1,2}\/\d{4}/.test((r[0] || "").trim())) return;
      const at = (name: string) => header.indexOf(name);
      const url = at("Link") >= 0 ? String(r[at("Link")] ?? "") : "";
      const keyword = at("Matched Keyword") >= 0 ? String(r[at("Matched Keyword")] ?? "").trim() : "";
      const cols: SheetRow["cols"] = {};
      const missing: Field[] = [];
      for (const f of FIELDS) {
        if (at(f) < 0) continue;
        if (f === "Description Preview" && (tab !== "main" || !keyword)) continue; // evidence: Tool 1 only
        cols[f] = at(f);
        if (!String(r[at(f)] ?? "").trim()) missing.push(f);
      }
      if (url && missing.length) {
        out.push({ tab, title: t.title, rowNumber: i + 1, url, keyword, source: String(r[at("Source")] ?? ""), cols, missing });
      }
    });
  }
  return out;
}

/** Sheet cell values for the empty fields `d` can fill. */
function cellsFor(row: SheetRow, d: Details): { field: Field; value: string }[] {
  const value: Record<Field, string> = {
    "School Rating": d.schoolRating ?? "",
    "Lot Size (acres)": d.lotSqft && d.lotSqft > 0 ? (d.lotSqft / 43_560).toFixed(2) : "",
    "Property Type": propertyTypeLabel({ homeType: d.homeType } as any),
    "HOA ($/mo)": d.hoaFee && d.hoaFee > 0 ? `$${Math.round(d.hoaFee).toLocaleString()}` : "",
    "Description Preview":
      d.description && row.keyword ? extractKeywordContext(d.description, row.keyword).replace(/\n/g, " ") : "",
  };
  return row.missing.filter((f) => value[f]).map((f) => ({ field: f, value: value[f] }));
}

async function writeCells(sheets: any, spreadsheetId: string, updates: { row: SheetRow; field: Field; value: string }[]) {
  for (let i = 0; i < updates.length; i += 400) {
    const chunk = updates.slice(i, i + 400);
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "RAW",
        data: chunk.map((u) => ({
          range: tabRange(u.row.title, `${colA1(u.row.cols[u.field]!)}${u.row.rowNumber}`),
          values: [[u.value]],
        })),
      },
    });
  }
}

function report(rows: SheetRow[]) {
  const by: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const k = `${r.tab === "main" ? "Tool 1" : "Tab 2"} · ${siteOf(r.url)}`;
    by[k] ??= { rows: 0 };
    by[k].rows++;
    for (const f of r.missing) by[k][f] = (by[k][f] ?? 0) + 1;
  }
  console.table(by);
}

// ── Console backfill scripts ────────────────────────────────────────────────
function consoleScript(site: "redfin" | "zillow", urls: string[]): string {
  const T = `[${site}-backfill]`;
  const fetchOne =
    site === "redfin"
      ? `
  // Redfin: schools from the details API (same as the search scripts); the
  // rest is read from the listing's details payloads by field name.
  const HOME_TYPES = { 1: "SINGLE_FAMILY", 2: "CONDO", 3: "TOWNHOUSE", 4: "MULTI_FAMILY", 5: "LAND", 6: "UNKNOWN", 7: "MOBILE" };
  async function getJson(url) {
    const res = await fetch(url, { credentials: "include" });
    const text = await res.text();
    if (res.status === 403 || res.status === 429) throw Object.assign(new Error("HTTP " + res.status), { blocked: true });
    try { const j = JSON.parse(text.replace(/^\\{\\}&&/, "")); return j.payload ?? j; } catch { return null; }
  }
  function schoolRating(schools) {
    const rated = (schools ?? []).filter((s) => Number(s.greatSchoolsRating) > 0);
    const high = rated.filter((s) => /(^|-)(9|1[0-2])$/.test(String(s.gradeRanges ?? "")));
    const best = Math.max(...(high.length ? high : rated).map((s) => Number(s.greatSchoolsRating)));
    return Number.isFinite(best) ? best + "/10" : undefined;
  }
  /** First value under any of \`keys\` anywhere in \`obj\`. */
  function find(obj, keys, test = (v) => v != null && v !== "") {
    let hit;
    (function walk(o, d) {
      if (hit !== undefined || !o || typeof o !== "object" || d > 12) return;
      for (const [k, v] of Object.entries(o)) {
        if (keys.includes(k)) { const val = v && typeof v === "object" && "value" in v ? v.value : v; if (test(val)) { hit = val; return; } }
        walk(v, d + 1);
      }
    })(obj, 0);
    return hit;
  }
  async function fetchOne(url) {
    const id = (url.match(/\\/home\\/(\\d+)/) || [])[1];
    if (!id) return null;
    const below = await getJson(\`/stingray/api/home/details/belowTheFold?propertyId=\${id}&accessLevel=1\`);
    const above = await getJson(\`/stingray/api/home/details/aboveTheFold?propertyId=\${id}&accessLevel=1\`);
    const both = { above, below };
    const info = below?.schoolsAndDistrictsInfo ?? {};
    const type = find(both, ["uiPropertyType", "propertyType"]);
    return {
      schoolRating: schoolRating(info.servingThisHomeSchools?.length ? info.servingThisHomeSchools : info.schoolsToShowOnDP),
      description: find(both, ["listingRemarks", "marketingRemarks", "remarks"], (v) => typeof v === "string" && v.length > 40),
      lotSqft: Number(find(both, ["lotSize", "lotSqFt", "lotSquareFeet"], (v) => Number(v) > 0)) || undefined,
      homeType: typeof type === "number" ? HOME_TYPES[type] : type,
      hoaFee: Number(find(both, ["hoaDues", "hoaFee", "hoa"], (v) => Number(v) > 0)) || undefined,
    };
  }`
      : `
  // Zillow: the listing page's property data (same reader as the search scripts)
  async function fetchOne(url) {
    const res = await fetch(url, { credentials: "include" });
    const html = await res.text();
    if (!html.includes("__NEXT_DATA__") && (res.status === 403 || /captcha|press & hold|access to this page has been denied/i.test(html))) {
      throw Object.assign(new Error("Zillow showed a captcha — solve it in this tab, then run again"), { blocked: true });
    }
    const el = new DOMParser().parseFromString(html, "text/html").getElementById("__NEXT_DATA__");
    let props;
    try { props = JSON.parse(el.textContent).props.pageProps; } catch { return null; }
    const raw = props?.gdpClientCache ?? props?.componentProps?.gdpClientCache;
    let p;
    try { p = Object.values(typeof raw === "string" ? JSON.parse(raw) : raw ?? {}).find((v) => v?.property)?.property; } catch {}
    if (!p) return null;
    const rated = (p.schools ?? []).filter((sc) => Number(sc?.rating) > 0);
    const high = rated.filter((sc) => /high/i.test(sc.level ?? "") || /12$/.test(sc.grades ?? ""));
    const best = Math.max(...(high.length ? high : rated).map((sc) => Number(sc.rating)));
    const lot = p.lotAreaValue ? Math.round(/acre/i.test(p.lotAreaUnit ?? "") ? p.lotAreaValue * 43560 : p.lotAreaValue) : p.lotSize;
    return {
      schoolRating: Number.isFinite(best) ? best + "/10" : undefined,
      description: props?.componentProps?.description ?? p.description ?? undefined,
      lotSqft: lot || undefined,
      homeType: p.homeType,
      hoaFee: Number(p.monthlyHoaFee ?? p.resoFacts?.associationFee) || undefined,
    };
  }`;

  return `// scripts/console/backfill/backfill-${site}.js — generated by \`npm run backfill:details -- --make-console\` (${new Date().toISOString().slice(0, 10)})
// ─────────────────────────────────────────────────────────────────────────────
// Looks up school rating, description, lot size, property type and HOA for the
// ${urls.length} ${site === "redfin" ? "Redfin" : "Zillow"} listings in the sheets that are missing some of them.
//   1. Open https://www.${site}.com in a normal tab.
//   2. DevTools → Console → paste this whole file → Enter.
//   3. When it prints "Done", a backfill-${site}-<date>.csv file is downloaded.
//      Then: npm run backfill:details -- --apply <that file>
// It stops early (and still downloads what it has) if the site shows a bot
// check — solve it, regenerate with --make-console, and run again.
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  const out = (() => {
    try { const f = document.createElement("iframe"); f.style.display = "none"; document.documentElement.appendChild(f); return f.contentWindow?.console ?? console; }
    catch { return console; }
  })();
  const URLS = ${JSON.stringify(urls, null, 0).replace(/","/g, '",\n    "')};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
${fetchOne}

  const results = [];
  const found = { schoolRating: 0, description: 0, lotSqft: 0, homeType: 0, hoaFee: 0 };
  out.log("${T} Looking up " + URLS.length + " listing(s)…");
  for (let i = 0; i < URLS.length; i++) {
    try {
      const d = await fetchOne(URLS[i]);
      if (d) {
        results.push({ url: URLS[i], ...d });
        for (const k of Object.keys(found)) if (d[k]) found[k]++;
      }
    } catch (err) {
      out.warn("${T} " + err.message + " — stopping at " + i + "/" + URLS.length);
      if (err.blocked) break;
    }
    if ((i + 1) % 20 === 0) out.log("${T} " + (i + 1) + "/" + URLS.length + " — found so far: " + JSON.stringify(found));
    await sleep(${site === "zillow" ? 1500 : 800} + Math.random() * 1000);
  }
  window.__backfillResults = results;
  out.log("%c${T} Done: " + results.length + "/" + URLS.length + " listing(s) read — " + JSON.stringify(found), "font-weight:bold");
  const esc = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
  const cols = ["url", "schoolRating", "description", "lotSqft", "homeType", "hoaFee"];
  const csv = [cols.join(","), ...results.map((r) => cols.map((c) => esc(c === "description" ? String(r[c] ?? "").slice(0, 3000) : r[c])).join(","))].join("\\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = "backfill-${site}-" + new Date().toISOString().slice(0, 10) + ".csv";
  a.click();
})();
`;
}

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

(async () => {
  const args = process.argv.slice(2);
  const auth = new google.auth.GoogleAuth({ keyFile: KEY_FILE, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  const sheets = google.sheets({ version: "v4", auth });
  const spreadsheetId = (await resolveAduTab(sheets, "main")).spreadsheetId;
  const rows = await loadRows(sheets);

  if (args.includes("--make-console")) {
    for (const site of ["redfin", "zillow"] as const) {
      const urls = [...new Set(rows.filter((r) => siteOf(r.url) === site).map((r) => r.url))];
      const file = path.join(__dirname, "console", "backfill", `backfill-${site}.js`);
      fs.writeFileSync(file, consoleScript(site, urls));
      console.log(`${path.basename(file)}: ${urls.length} listing(s)`);
    }
    process.exit(0);
  }

  const applyAt = args.indexOf("--apply");
  if (applyAt >= 0) {
    const file = args[applyAt + 1];
    const results = parseCsv(fs.readFileSync(file, "utf8"));
    const byUrl = new Map(results.map((r) => [r.url, r]));
    const updates: { row: SheetRow; field: Field; value: string }[] = [];
    for (const row of rows) {
      const r = byUrl.get(row.url);
      if (!r) continue;
      for (const c of cellsFor(row, {
        schoolRating: r.schoolRating || undefined,
        description: r.description || undefined,
        lotSqft: Number(r.lotSqft) || undefined,
        homeType: r.homeType || undefined,
        hoaFee: Number(r.hoaFee) || undefined,
      })) updates.push({ row, ...c });
    }
    await writeCells(sheets, spreadsheetId, updates);
    const byField: Record<string, number> = {};
    for (const u of updates) byField[u.field] = (byField[u.field] ?? 0) + 1;
    console.log(`${path.basename(file)}: ${results.length} listing(s) → filled ${updates.length} cell(s): ${JSON.stringify(byField)}`);
    process.exit(0);
  }

  if (args.includes("--cb")) {
    const limitAt = args.indexOf("--limit");
    const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : Infinity;
    const cbRows = rows.filter((r) => siteOf(r.url) === "cb");
    const urls = [...new Set(cbRows.map((r) => r.url))].slice(0, limit);
    console.log(`Coldwell Banker: ${urls.length} listing(s) to look up (${cbRows.length} row(s))`);
    const scraper = new ColdwellBankerScraper();
    let pending: { row: SheetRow; field: Field; value: string }[] = [];
    let done = 0, read = 0, filled = 0;
    const flush = async () => { await writeCells(sheets, spreadsheetId, pending); filled += pending.length; pending = []; };
    const worker = async (queue: string[]) => {
      for (let url = queue.shift(); url; url = queue.shift()) {
        try {
          const d: any = await scraper.fetchListingDetail(url);
          if (d) {
            read++;
            for (const row of cbRows.filter((r) => r.url === url)) {
              for (const c of cellsFor(row, d)) pending.push({ row, ...c });
            }
          }
        } catch (err: any) {
          console.warn(`  ${url}: ${err.message}`);
        }
        if (++done % 50 === 0) {
          await flush();
          console.log(`  ${done}/${urls.length} looked up, ${read} read, ${filled} cell(s) filled`);
        }
      }
    };
    const queue = [...urls];
    await Promise.all(Array.from({ length: 3 }, () => worker(queue)));
    await flush();
    console.log(`Coldwell Banker: ${read}/${urls.length} listing(s) read, ${filled} cell(s) filled`);
    process.exit(0);
  }

  report(rows);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
