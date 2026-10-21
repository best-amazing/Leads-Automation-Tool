// scripts/redfin-region-check.js
// ─────────────────────────────────────────────────────────────────────────────
// Browser-console check: which Redfin region IDs give a real statewide search.
// For each state it asks Redfin's search box (location-autocomplete) for its
// suggestions, then runs a small test search with every candidate region and
// reports how many of the returned homes are actually in that state.
//
// Usage: open https://www.redfin.com, DevTools → Console, paste, Enter.
// Copy the final table (or the window.__redfinRegionCheck JSON) back.
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  const out = (() => {
    try {
      const f = document.createElement("iframe");
      f.style.display = "none";
      document.documentElement.appendChild(f);
      return f.contentWindow?.console ?? console;
    } catch {
      return console;
    }
  })();

  const STATES = [["OH", "Ohio"], ["IN", "Indiana"], ["IA", "Iowa"]]; // a few is enough
  const EXTRA_TYPES = [2, 4, 5, 8]; // also try the same id with these region_type values
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function getJson(url) {
    const res = await fetch(url, { credentials: "include" });
    const text = await res.text();
    return { status: res.status, json: (() => { try { return JSON.parse(text.replace(/^\{\}&&/, "")); } catch { return { raw: text.slice(0, 300) }; } })() };
  }

  const results = [];
  for (const [abbr, name] of STATES) {
    const ac = await getJson(`https://www.redfin.com/stingray/do/location-autocomplete?location=${encodeURIComponent(name)}&v=2&al=1`);
    out.log(`[region-check] ${name} autocomplete (HTTP ${ac.status}):`, JSON.stringify(ac.json).slice(0, 1500));

    // Every suggestion that carries an id like "4_36"
    const rows = [];
    const walk = (o) => {
      if (!o || typeof o !== "object") return;
      if (typeof o.id === "string" && /^\d+_\d+$/.test(o.id)) rows.push(o);
      for (const v of Object.values(o)) walk(v);
    };
    walk(ac.json);

    const tried = new Set();
    for (const row of rows.slice(0, 6)) {
      const [type, id] = row.id.split("_").map(Number);
      for (const t of [type, ...EXTRA_TYPES]) {
        const key = `${t}_${id}`;
        if (tried.has(key)) continue;
        tried.add(key);
        const p = new URLSearchParams({
          al: "1", region_id: String(id), region_type: String(t), uipt: "1,4",
          max_price: "200000", num_homes: "50", start: "0", status: "1", sf: "1,2,3,5,6,7", ord: "price-desc",
        });
        const gis = await getJson(`https://www.redfin.com/stingray/api/gis?${p}`);
        const homes = gis.json?.payload?.homes ?? [];
        const inState = homes.filter((h) => h.state === abbr).length;
        results.push({
          state: abbr,
          suggestion: `${row.name ?? ""}${row.subName ? ` (${row.subName})` : ""}`.slice(0, 40),
          suggestionId: row.id,
          url: (row.url ?? "").slice(0, 40),
          region_type: t,
          region_id: id,
          http: gis.status,
          error: gis.json?.errorMessage ?? "",
          homes: homes.length,
          inState,
          cities: [...new Set(homes.map((h) => h.city))].slice(0, 4).join(", "),
        });
        await sleep(800);
      }
    }
  }

  window.__redfinRegionCheck = results;
  out.log("%c[region-check] Done — rows with homes > 0 and inState ≈ homes are the working statewide regions", "font-weight:bold");
  out.table(results);
  try { if (typeof copy === "function") { copy(JSON.stringify(results, null, 1)); out.log("[region-check] Results copied to clipboard."); } } catch {}
})();
