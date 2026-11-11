// Quick script to remove the CSV download (a.href / a.download / a.click) from all console scripts
// while keeping the clipboard copy and console.table output.
const fs = require("fs");
const path = require("path");

const dirs = [
  path.join(__dirname, "console", "tool1"),
  path.join(__dirname, "console", "tool2-under200k"),
  path.join(__dirname, "console", "backfill"),
];

let total = 0;
for (const dir of dirs) {
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir).filter(f => f.endsWith(".js"))) {
    const file = path.join(dir, name);
    let src = fs.readFileSync(file, "utf8");

    // Pattern: the 4 lines that create an <a> element, set href to a Blob URL,
    // set download filename, and click it. They always appear together.
    const downloadPattern = /\s*const a = document\.createElement\("a"\);\n\s*a\.href = URL\.createObjectURL\(new Blob\(\[csv\], \{ type: "text\/csv" \}\)\);\n\s*a\.download = [^\n]+;\n\s*a\.click\(\);\n/g;

    const newSrc = src.replace(downloadPattern, "\n");
    if (newSrc !== src) {
      fs.writeFileSync(file, newSrc);
      console.log(`  ✓ ${path.relative(path.join(__dirname, ".."), file)}`);
      total++;
    }
  }
}
console.log(`\nRemoved CSV download from ${total} file(s).`);

