import * as fs from "fs";
import * as path from "path";

const text = fs.readFileSync(path.join(__dirname, "temp-raw-table.txt"), "utf8");
const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);

const records: any[] = [];
for (const line of lines) {
  // Format: index\t'State'\t'Address'\t'Zip'\tPrice\tBeds\tBaths\tSqFt\t'Lot (acres)'\tYear Built\t'Home Type'\tDOM\t'Matched Keyword'\t'Description Preview'\t'School Rating'\t'Schools (E/M/H)'\t'Link'
  // Tabs or multi-space delimiter
  const parts = line.split("\t");
  if (parts.length < 15) continue;
  const clean = (s: string) => (s ?? "").trim().replace(/^['"]|['"]$/g, "").trim();

  // parts[0] is index
  const state = clean(parts[1]);
  const address = clean(parts[2]);
  const zip = clean(parts[3]);
  const price = clean(parts[4]);
  const beds = clean(parts[5]);
  const baths = clean(parts[6]);
  const sqft = clean(parts[7]);
  const lotAcres = clean(parts[8]);
  const yearBuilt = clean(parts[9]);
  const homeType = clean(parts[10]);
  const dom = clean(parts[11]);
  const matchedKeyword = clean(parts[12]);
  const descriptionPreview = clean(parts[13]);
  const schoolRating = clean(parts[14]);
  const schools = clean(parts[15]);
  const link = clean(parts[16]);

  records.push({
    State: state,
    Address: address,
    Zip: zip,
    Price: price,
    Beds: beds,
    Baths: baths,
    SqFt: sqft,
    "Lot (acres)": lotAcres,
    "Year Built": yearBuilt,
    "Home Type": homeType,
    "Days on Market": dom,
    "Matched Keyword": matchedKeyword,
    "Description Preview": descriptionPreview,
    "School Rating": schoolRating,
    "Schools (E/M/H)": schools,
    Link: link,
  });
}

console.log(`Parsed ${records.length} records`);

const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const headers = Object.keys(records[0]);
const csv = [headers.join(","), ...records.map(r => headers.map(h => esc(r[h])).join(","))].join("\n");

const outPath = path.join(__dirname, "tool1-realtor-batch.csv");
fs.writeFileSync(outPath, csv, "utf8");
console.log(`Wrote ${outPath}`);
