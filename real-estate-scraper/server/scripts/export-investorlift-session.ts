import * as path from "path";
import * as fs from "fs";
import * as readline from "readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const SESSION_FILE = path.join(__dirname, "..", "investorlift-session.json");

console.log("=======================================================");
console.log("To extract your existing session from your browser:");
console.log("1. Open InvestorLift in your regular browser where you are logged in.");
console.log("2. Open Developer Tools (F12 or right-click -> Inspect).");
console.log("3. Go to the 'Network' tab and refresh the page.");
console.log("4. Click on any request to 'investorlift.com' (e.g., 'properties' or the main document).");
console.log("5. Scroll down to 'Request Headers' and find the 'cookie' header.");
console.log("6. Right-click the cookie header value (everything after 'cookie: ') and copy it.");
console.log("=======================================================\n");

rl.question("Paste your raw cookie string here: ", (rawCookies) => {
  if (!rawCookies || rawCookies.trim() === "") {
    console.log("No cookies provided. Exiting.");
    process.exit(1);
  }

  const parsedCookies = rawCookies
    .split(";")
    .map((pair) => {
      const [name, ...rest] = pair.trim().split("=");
      return {
        name,
        value: rest.join("="),
        domain: ".investorlift.com",
        path: "/",
        expires: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, // 30 days valid
        httpOnly: false,
        secure: true,
        sameSite: "Lax"
      };
    })
    .filter(c => c.name);

  const storageState = {
    cookies: parsedCookies,
    origins: []
  };

  fs.writeFileSync(SESSION_FILE, JSON.stringify(storageState, null, 2));
  console.log(`\n✅ Session successfully saved to ${SESSION_FILE}!`);
  
  rl.close();
});
