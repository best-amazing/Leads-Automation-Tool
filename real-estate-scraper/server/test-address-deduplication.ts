import { prisma } from "./src/db/client";
import { upsertListing } from "./src/db/repository";
import { logger } from "./src/utils/logger";

const CREXI_SOURCE = "crexi";
const TEST_ADDRESS = "1234 Main Street, Columbus, Ohio 43215";

async function test() {
  logger.info("🧪 Starting address-based deduplication test...\n");

  try {
    // Step 1: Clean up any existing test listings
    logger.info("Step 1: Cleaning up old test data...");
    const existing = await prisma.listing.findMany({
      where: {
        source: CREXI_SOURCE,
        rawAddress: { contains: TEST_ADDRESS },
      },
    });
    if (existing.length > 0) {
      await prisma.listing.deleteMany({
        where: {
          source: CREXI_SOURCE,
          rawAddress: { contains: TEST_ADDRESS },
        },
      });
      logger.info(`  Deleted ${existing.length} old test listings\n`);
    }

    // Step 2: Insert listing #1 with URL A
    logger.info("Step 2: Inserting listing #1 (same address, URL-A)...");
    const listing1 = await upsertListing({
      url: "https://crexi.com/listing/property-123-from-page-1",
      source: CREXI_SOURCE,
      address: TEST_ADDRESS,
      title: "Great commercial property",
      price: 500000,
      location: "Columbus, OH",
      propertyType: "multi_family",
      bedrooms: 5,
      bathrooms: 2.5,
      squareFeet: 5000,
    });
    logger.info(`  ✓ Created listing #1 (id=${listing1.id})`);
    logger.info(`    URL: ${listing1.url}\n`);

    // Step 3: Insert listing #2 with SAME ADDRESS but DIFFERENT URL
    logger.info("Step 3: Inserting listing #2 (same address, URL-B from different pagination)...");
    const listing2 = await upsertListing({
      url: "https://crexi.com/listing/property-123-from-page-2",
      source: CREXI_SOURCE,
      address: TEST_ADDRESS,
      title: "Great commercial property",
      price: 500000,
      location: "Columbus, OH",
      propertyType: "multi_family",
      bedrooms: 5,
      bathrooms: 2.5,
      squareFeet: 5000,
    });
    logger.info(`  ✓ Processed listing #2 (id=${listing2.id})`);
    logger.info(`    URL: ${listing2.url}\n`);

    // Step 4: Verify deduplication
    logger.info("Step 4: Verifying deduplication...");
    
    if (listing1.id === listing2.id) {
      logger.info(`  ✅ DEDUPLICATION SUCCESSFUL!`);
      logger.info(`     Both listings map to the same record (id=${listing1.id})`);
      logger.info(`     URL was updated from "${listing1.url}" to "${listing2.url}"`);
    } else {
      logger.error(`  ❌ DEDUPLICATION FAILED!`);
      logger.error(`     Listing #1 id: ${listing1.id}`);
      logger.error(`     Listing #2 id: ${listing2.id}`);
      logger.error(`     Created duplicate records instead of updating!`);
    }

    // Step 5: Check database
    logger.info("\nStep 5: Checking database state...");
    const dbListings = await prisma.listing.findMany({
      where: {
        source: CREXI_SOURCE,
        rawAddress: { contains: TEST_ADDRESS },
      },
    });
    logger.info(`  Total listings in DB with this address: ${dbListings.length}`);
    if (dbListings.length === 1) {
      logger.info(`  ✅ Perfect! Only one record exists.`);
      logger.info(`     ID: ${dbListings[0].id}`);
      logger.info(`     URL: ${dbListings[0].url}`);
    } else {
      logger.warn(`  ⚠️  Found ${dbListings.length} records (expected 1)`);
      dbListings.forEach((l, i) => {
        logger.warn(`     [${i + 1}] id=${l.id}, url=${l.url}`);
      });
    }

    logger.info("\n🧪 Test complete!\n");
  } catch (err) {
    logger.error(`❌ Test failed with error: ${err}`);
  } finally {
    await prisma.$disconnect();
  }
}

test();
