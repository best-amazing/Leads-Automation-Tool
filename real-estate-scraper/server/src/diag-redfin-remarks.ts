import "dotenv/config";
// Probe which Redfin endpoint carries listing remarks/description for a
// propertyId we already know from the GIS feed.
import { buildBelowTheFoldUrl } from "./scrapers/redfin/redfin.parser";

const OXYLABS_USERNAME = process.env.OXYLABS_USERNAME ?? "";
const OXYLABS_PASSWORD = process.env.OXYLABS_PASSWORD ?? "";

function oxylabsGet(targetUrl: string): Promise<{ status: number; content: string | null }> {
  return new Promise((resolve, reject) => {
    const authStr = Buffer.from(`${OXYLABS_USERNAME}:${OXYLABS_PASSWORD}`).toString("base64");
    const bodyStr = JSON.stringify({
      source: "universal",
      url: targetUrl,
      geo_location: "United States",
      user_agent_type: "desktop_chrome",
    });
    const req = require("https").request(
      {
        hostname: "realtime.oxylabs.io", path: "/v1/queries", method: "POST", family: 4,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${authStr}`,
          "Content-Length": Buffer.byteLength(bodyStr).toString(),
          "Accept-Encoding": "gzip, deflate, br",
        },
      },
      (res: any) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", async () => {
          let buf = Buffer.concat(chunks);
          try {
            const env = JSON.parse(buf.toString("utf-8"));
            resolve({ status: env?.results?.[0]?.status_code ?? -1, content: env?.results?.[0]?.content ?? null });
          } catch (e) { resolve({ status: -1, content: null }); }
        });
      }
    );
    req.setTimeout(60_000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

function walkKeys(obj: any, needle: RegExp, pathSoFar = ""): string[] {
  // Find leaf keys whose name or string value looks like remarks
  const hits: string[] = [];
  if (obj == null) return hits;
  if (Array.isArray(obj)) {
    obj.slice(0, 3).forEach((v, i) => hits.push(...walkKeys(v, needle, `${pathSoFar}[${i}]`)));
    return hits;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      const p = pathSoFar ? `${pathSoFar}.${k}` : k;
      if (/remark|comment|descript|marketing|listingBody/i.test(k) && v != null && typeof v !== "object") {
        hits.push(`${p} = ${String(v).slice(0, 120)}`);
      } else if (typeof v === "string" && v.length > 150) {
        hits.push(`${p} (long str ${v.length}) = ${v.slice(0, 100)}...`);
      } else if (typeof v === "object") {
        hits.push(...walkKeys(v, needle, p));
      }
    }
  }
  return hits;
}

(async () => {
  const propertyId = 70722664; // Cleveland home seen in earlier GIS probe
  const path_ = "/OH/Cleveland/2525-Thurman-Ave-44113/home/70722664";
  const candidates: Array<[string, string]> = [
    ["aboveTheFold?id", `https://www.redfin.com/stingray/api/home/details/aboveTheFold?propertyId=${propertyId}&accessLevel=1`],
    ["aboveTheFold?path", `https://www.redfin.com/stingray/api/home/details/aboveTheFold?path=${encodeURIComponent(path_)}&accessLevel=1`],
    ["mainDetails", `https://www.redfin.com/stingray/api/home/details/main?path=${encodeURIComponent(path_)}&accessLevel=1`],
    ["btf?path", `https://www.redfin.com/stingray/api/home/details/belowTheFold?path=${encodeURIComponent(path_)}&accessLevel=1&pageType=1`],
  ];
  for (const [label, url] of candidates) {
    const r = await oxylabsGet(url);
    console.log(`── ${label}: status ${r.status}`);
    if (r.content && r.status === 200) {
      try {
        const json = JSON.parse(r.content);
        console.log("   keys:", Object.keys(json).slice(0, 15).join(", "));
        const hits = walkKeys(json, /remark|comment|descript/i);
        console.log(hits.length ? hits.slice(0, 10).map(h => "   " + h).join("\n") : "   (no remark-like keys)");
      } catch { console.log("   non-JSON:", String(r.content).slice(0, 120)); }
    }
    await new Promise(res => setTimeout(res, 2000));
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
