import "dotenv/config";
import { writeAduResearchToSheets } from "./src/utils/google-sheets";

async function run() {
  await writeAduResearchToSheets([
    {
      source: "test",
      title: "Test Property",
      address: "123 Test St",
      city: "Columbus",
      state: "OH",
      zip: "43201",
      price: 150000,
      url: "https://example.com"
    }
  ]);
}
run();
