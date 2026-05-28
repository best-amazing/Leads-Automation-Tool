/**
 * Test script for Redfin Address Enricher
 *
 * Usage: npx ts-node test-redfin-enricher.ts
 *
 * Environment variables:
 *   OXYLABS_USERNAME=your_username   (required)
 *   OXYLABS_PASSWORD=your_password   (required)
 *   REDFIN_ENRICHER_DEBUG=true       (optional — saves raw API responses to logs/)
 *   TEST_ADDRESS="123 Main St, ..."  (optional — override the default test address)
 */

import { lookupRedfinEstimate } from "./src/scrapers/redfin/redfin.address.enricher";

const testAddress = process.env.TEST_ADDRESS ?? "4433 E 158th St, Cleveland, OH 44128";

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Redfin Address Enricher — Test");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // ── Credential check ──────────────────────────────────────────────────────

  if (!process.env.OXYLABS_USERNAME || !process.env.OXYLABS_PASSWORD) {
    console.error("❌ ERROR: Oxylabs credentials not set");
    console.error("   export OXYLABS_USERNAME=your_username");
    console.error("   export OXYLABS_PASSWORD=your_password");
    process.exit(1);
  }
  console.log("✓ Oxylabs credentials found");

  if (process.env.REDFIN_ENRICHER_DEBUG === "true") {
    console.log("✓ Debug mode ON — raw API responses saved to logs/");
  }

  console.log(`\nTesting: "${testAddress}"\n`);

  // ── Lookup ────────────────────────────────────────────────────────────────

  let result: Awaited<ReturnType<typeof lookupRedfinEstimate>>;

  try {
    result = await lookupRedfinEstimate(testAddress);
  } catch (err: any) {
    console.error("❌ Fatal error during lookup:");
    console.error(err?.message ?? err);
    process.exit(1);
  }

  // ── Raw result ────────────────────────────────────────────────────────────

  console.log("Raw result:");
  console.log("───────────────────────────────────────────────────────────────");
  console.log(JSON.stringify(result, null, 2));
  console.log("───────────────────────────────────────────────────────────────\n");

  // ── Summary ───────────────────────────────────────────────────────────────

  if (result.found) {
    console.log("✅ SUCCESS\n");
    console.log(`💰 Redfin Estimate : $${result.redfinEstimate!.toLocaleString()}`);
    if (result.redfinEstimateLow != null && result.redfinEstimateHigh != null) {
      console.log(
        `   Range           : $${result.redfinEstimateLow.toLocaleString()} – ` +
        `$${result.redfinEstimateHigh.toLocaleString()}`
      );
    }
    if (result.listPrice != null) {
      console.log(`💵 List Price       : $${result.listPrice.toLocaleString()}`);
    }
    console.log(`📍 Property ID      : ${result.propertyId}`);
    console.log(`🔗 URL              : ${result.url}`);
    console.log(`🏠 Address          : ${result.address}`);
  } else {
    // Partial success — property found on Redfin but no AVM estimate
    if (result.propertyId != null) {
      console.log("⚠️  PARTIAL: Property found on Redfin but no AVM estimate\n");
      console.log(`📍 Property ID : ${result.propertyId}`);
      console.log(`🔗 URL         : ${result.url}`);
      console.log(`🏠 Address     : ${result.address}`);
      console.log(`   Error       : ${result.error}`);
      console.log(
        "\n   This is expected for off-market / low-data properties." +
        "\n   Redfin does not publish AVM estimates for all properties."
      );
    } else {
      console.log(`❌ FAILED: ${result.error}\n`);
      console.log("   Possible reasons:");
      console.log("   • Address not found in Redfin's database");
      console.log("   • Oxylabs returned 613 (bot block) — check headers are forwarded");
      console.log("   • Autocomplete endpoint path changed — check /stingray/do/ is correct");
    }
  }
}

main();