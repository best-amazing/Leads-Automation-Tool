#!/usr/bin/env ts-node
//
// test-realtor-enrichment.ts
//
// Stand-alone test script for RealtorAddressEnricher.
//
// Usage:
//   npx ts-node test-realtor-enrichment.ts "1925 Buhrer Ave, Cleveland, OH 44109"
//   npx ts-node test-realtor-enrichment.ts --test
//   npx ts-node test-realtor-enrichment.ts --batch addresses.txt
//

import dotenv from "dotenv";
import { RealtorAddressEnricher } from "./src/scrapers/realtor/realtor.address.enricher";

dotenv.config();

const TEST_ADDRESSES = [
  "1925 Buhrer Ave, Cleveland, OH 44109",
  "42 Whitethorne Ave, Columbus, OH 43223",
  "3206 N Tampa St, Tampa, FL 33603",
];

async function main() {
  const args = process.argv.slice(2);

  let addresses: string[] = [];

  if (args.includes("--test")) {
    addresses = TEST_ADDRESSES;
    console.log(
      `ℹ Test mode — testing ${addresses.length} addresses\n`,
    );
  } else if (args.includes("--batch")) {
    const fileIdx = args.indexOf("--batch") + 1;
    const filePath = args[fileIdx];
    if (!filePath) {
      console.error("❌ --batch requires a file path");
      process.exit(1);
    }
    try {
      const fs = require("fs");
      addresses = fs
        .readFileSync(filePath, "utf-8")
        .split("\n")
        .map((s: string) => s.trim())
        .filter(Boolean);
      console.log(
        `ℹ Batch mode — ${addresses.length} addresses from ${filePath}\n`,
      );
    } catch (e: any) {
      console.error(`❌ Could not read file: ${e.message}`);
      process.exit(1);
    }
  } else if (args.length > 0 && !args[0].startsWith("--")) {
    addresses = [args[0]];
  } else {
    console.error("Usage:");
    console.error(
      '  npx ts-node test-realtor-enrichment.ts "1925 Buhrer Ave, Cleveland, OH 44109"',
    );
    console.error("  npx ts-node test-realtor-enrichment.ts --test");
    console.error(
      "  npx ts-node test-realtor-enrichment.ts --batch addresses.txt",
    );
    process.exit(1);
  }

  const enricher = new RealtorAddressEnricher();
  const results = await enricher.lookupBatch(addresses, 1);

  // Summary
  const succeeded = results.filter((r) => r.found).length;
  const failed = results.filter((r) => !r.found).length;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`Results Summary`);
  console.log(`${"═".repeat(60)}`);
  console.log(`✓ Found:      ${succeeded}`);
  console.log(`✗ Not found:  ${failed}`);
  console.log(`${"═".repeat(60)}\n`);

  // Full JSON output
  console.log(JSON.stringify(results, null, 2));

  process.exit(succeeded === addresses.length ? 0 : 1);
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
