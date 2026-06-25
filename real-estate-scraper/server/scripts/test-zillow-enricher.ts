/**
 * Test script for Zillow Address Enricher
 * 
 * Usage: npx ts-node test-zillow-enricher.ts
 * 
 * Make sure to set environment variables:
 *   OXYLABS_USERNAME=your_username
 *   OXYLABS_PASSWORD=your_password
 *   ZILLOW_ENRICHER_DEBUG=true  (optional, for debug output)
 */

import { ZillowAddressEnricher, lookupZillowEstimate } from "./src/scrapers/zillow/zillow.address.enricher";

// Test address
const testAddress = "1657 Sullivant Avenue, Columbus, Franklin, OH 43223";

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Zillow Address Enricher Test");
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
    console.log("→ Calling lookupZillowEstimate()...\n");
    const result = await lookupZillowEstimate(testAddress);

    console.log("Result:");
    console.log("───────────────────────────────────────────────────────────────");
    console.log(JSON.stringify(result, null, 2));
    console.log("───────────────────────────────────────────────────────────────\n");

    // Summary
    if (result.found) {
      console.log("✓ SUCCESS: Address found on Zillow\n");
      if (result.zestimate != null) {
        console.log(`💰 Zestimate: $${result.zestimate.toLocaleString()}`);
        if (result.zestimateLow != null && result.zestimateHigh != null) {
          console.log(`   Range: $${result.zestimateLow.toLocaleString()} – $${result.zestimateHigh.toLocaleString()}`);
        }
      } else {
        console.log("⚠️  No zestimate found for this property");
      }
      if (result.zpid) {
        console.log(`📍 Zpid: ${result.zpid}`);
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
