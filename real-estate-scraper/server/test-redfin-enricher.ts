/**
 * Test script for Redfin Address Enricher
 * 
 * Usage: npx ts-node test-redfin-enricher.ts
 * 
 * Make sure to set environment variables:
 *   OXYLABS_USERNAME=your_username
 *   OXYLABS_PASSWORD=your_password
 *   REDFIN_ENRICHER_DEBUG=true  (optional, for debug output)
 */

import { RedfinAddressEnricher, lookupRedfinEstimate } from "./src/scrapers/redfin/redfin.address.enricher";

// Test address
const testAddress = "4433 E 158th St, Cleveland, OH 44128";

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Redfin Address Enricher Test");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Check if Oxylabs credentials are set
  const oxylabsUsername = process.env.OXYLABS_USERNAME;
  const oxylabsPassword = process.env.OXYLABS_PASSWORD;

  if (!oxylabsUsername || !oxylabsPassword) {
    console.error("❌ ERROR: Oxylabs credentials not set");
    console.error("   Please set the following environment variables:");
    console.error("   - OXYLABS_USERNAME");
    console.error("   - OXYLABS_PASSWORD");
    console.error("\n   Example:");
    console.error("   export OXYLABS_USERNAME=your_username");
    console.error("   export OXYLABS_PASSWORD=your_password");
    process.exit(1);
  }

  console.log("✓ Oxylabs credentials found\n");
  console.log("Testing address lookup:");
  console.log(`  Address: "${testAddress}"\n`);

  try {
    // Method 1: Using convenience function
    console.log("→ Calling lookupRedfinEstimate()...\n");
    const result = await lookupRedfinEstimate(testAddress);

    console.log("Result:");
    console.log("───────────────────────────────────────────────────────────────");
    console.log(JSON.stringify(result, null, 2));
    console.log("───────────────────────────────────────────────────────────────\n");

    // Summary
    if (result.found) {
      console.log("✓ SUCCESS: Address found on Redfin\n");
      if (result.redfinEstimate != null) {
        console.log(`💰 Redfin Estimate: $${result.redfinEstimate.toLocaleString()}`);
        if (result.redfinEstimateLow != null && result.redfinEstimateHigh != null) {
          console.log(`   Range: $${result.redfinEstimateLow.toLocaleString()} – $${result.redfinEstimateHigh.toLocaleString()}`);
        }
      } else {
        console.log("⚠️  No Redfin estimate found for this property");
      }
      if (result.propertyId) {
        console.log(`📍 Property ID: ${result.propertyId}`);
      }
      if (result.url) {
        console.log(`🔗 URL: ${result.url}`);
      }
      if (result.address) {
        console.log(`🏠 Address: ${result.address}`);
      }
      if (result.listPrice != null) {
        console.log(`💵 List Price: $${result.listPrice.toLocaleString()}`);
      }
    } else {
      console.log(`❌ FAILED: Address not found`);
      console.log(`   Error: ${result.error}`);
    }
  } catch (error) {
    console.error("❌ Error during lookup:");
    console.error(error);
    process.exit(1);
  }
}

main();
