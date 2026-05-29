// test-propwire-enricher.ts
import dotenv from "dotenv";
import { lookupPropwireEstimate } from "./src/scrapers/propwire/propwire.address.enricher";

dotenv.config();

const testAddress = "1925 Buhrer Ave, Cleveland, OH 44109";

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Propwire Address Enricher Test");
  console.log("═══════════════════════════════════════════════════════════════\n");

  if (!process.env.PROPWIRE_BEARER_TOKEN) {
    console.error("❌ PROPWIRE_BEARER_TOKEN not set");
    console.error("   Get it from DevTools → Network → api.propwire.com/api/property_search → Authorization header");
    process.exit(1);
  }

  console.log(`Testing: "${testAddress}"\n`);
  const result = await lookupPropwireEstimate(testAddress);

  console.log(JSON.stringify(result, null, 2));

  if (result.found) {
    console.log("\n✓ SUCCESS");
    if (result.propwireEstimate) console.log(`💰 AVM: $${result.propwireEstimate.toLocaleString()}`);
    if (result.estimatedEquity)  console.log(`📈 Equity: $${result.estimatedEquity.toLocaleString()}`);
    if (result.leadTypes.length) console.log(`🏷  Lead types: ${result.leadTypes.join(", ")}`);
    if (result.ownerName)        console.log(`👤 Owner: ${result.ownerName}`);
  } else {
    console.log(`\n❌ FAILED: ${result.error}`);
  }
}

main().catch(console.error);