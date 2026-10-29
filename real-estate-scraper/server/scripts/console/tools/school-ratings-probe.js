// School-ratings probe for Zillow and Redfin listing pages.
//
// Open a single home's page (not the search map), e.g.
//   https://www.zillow.com/homedetails/.../12345_zpid/
//   https://www.redfin.com/OH/City/123-Main-St-44000/home/12345678
// then paste this whole script into the DevTools console and press Enter.
//
// It walks every JSON blob the page carries (plus Redfin's below-the-fold API,
// where Redfin keeps its school data) and prints every path whose key mentions
// "school", with the rating fields it finds underneath. The summary at the end
// gives the exact path to read, e.g. property.schools[].rating.
(async () => {
  // Redfin replaces console; borrow a clean one from a fresh iframe.
  const out = (() => {
    try {
      const f = document.createElement("iframe");
      f.style.display = "none";
      document.body.appendChild(f);
      return f.contentWindow.console;
    } catch { return console; }
  })();
  const TAG = "[school-probe]";
  const host = location.hostname;
  const sources = []; // { name, data }

  const tryJson = (text) => {
    if (typeof text !== "string") return null;
    const t = text.trim().replace(/^\{\}&&/, ""); // Redfin's anti-JSON-hijack prefix
    if (!/^[\[{]/.test(t)) return null;
    try { return JSON.parse(t); } catch { return null; }
  };

  // 1. JSON embedded in the page.
  document.querySelectorAll('script[type="application/json"], script#__NEXT_DATA__, script[type="application/ld+json"]').forEach((s, i) => {
    const data = tryJson(s.textContent);
    if (data) sources.push({ name: s.id || `script[${s.type}]#${i}`, data });
  });
  // Redfin keeps its page state on window globals.
  for (const k of ["__reactServerState", "__INITIAL_STATE__", "__PRELOADED_STATE__", "__APOLLO_STATE__"]) {
    if (window[k]) sources.push({ name: `window.${k}`, data: window[k] });
  }

  // 2. Redfin: school data lives in the below-the-fold API, not the page HTML.
  if (host.includes("redfin")) {
    const propertyId = (location.pathname.match(/\/home\/(\d+)/) || [])[1];
    if (!propertyId) out.warn(`${TAG} No /home/<id> in the URL — open a single listing page.`);
    else {
      const qs = `propertyId=${propertyId}&accessLevel=1`;
      for (const ep of ["belowTheFold", "aboveTheFold"]) {
        const url = `/stingray/api/home/details/${ep}?${qs}`;
        try {
          const res = await fetch(url, { credentials: "include" });
          const data = tryJson(await res.text());
          if (data) sources.push({ name: `GET ${url}`, data });
          else out.warn(`${TAG} ${url} → HTTP ${res.status}, not JSON`);
        } catch (e) { out.warn(`${TAG} ${url} failed: ${e.message}`); }
      }
    }
  }

  // 3. Walk everything. Zillow nests JSON-in-a-string (gdpClientCache), so
  //    strings that look like JSON are parsed and walked too.
  const hits = [];
  const seen = new WeakSet();
  const walk = (node, path, source, depth) => {
    if (depth > 40 || node == null) return;
    if (typeof node === "string") {
      if (node.length > 50 && /school/i.test(node)) {
        const inner = tryJson(node);
        if (inner) walk(inner, `${path}<json>`, source, depth + 1);
      }
      return;
    }
    if (typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`, source, depth + 1));
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      const p = path ? `${path}.${k}` : k;
      if (/school/i.test(k) && v != null) hits.push({ source, path: p, value: v });
      walk(v, p, source, depth + 1);
    }
  };
  sources.forEach((s) => walk(s.data, "", s.name, 0));

  // 4. Report. Collapse array indexes so repeated schools show as one path.
  const generic = (p) => p.replace(/\[\d+\]/g, "[]");
  const ratingKeys = /rating|score|grade|rank/i;
  const rows = new Map();
  for (const h of hits) {
    const key = `${h.source} :: ${generic(h.path)}`;
    if (rows.has(key)) { rows.get(key).count++; continue; }
    let sample;
    const v = h.value;
    if (Array.isArray(v)) {
      const first = v.find((x) => x && typeof x === "object") ?? v[0];
      sample = first && typeof first === "object"
        ? `array(${v.length}) of {${Object.keys(first).slice(0, 12).join(", ")}}`
        : `array(${v.length}): ${JSON.stringify(v).slice(0, 120)}`;
    } else if (typeof v === "object") {
      sample = `{${Object.keys(v).slice(0, 12).join(", ")}}`;
    } else sample = JSON.stringify(v).slice(0, 120);
    rows.set(key, { source: h.source, path: generic(h.path), sample, count: 1 });
  }

  // Rating fields sitting inside a school object, with example values.
  const ratings = new Map();
  for (const h of hits) {
    const list = Array.isArray(h.value) ? h.value : [h.value];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      for (const [k, val] of Object.entries(item)) {
        if (!ratingKeys.test(k) || (val !== null && typeof val === "object")) continue;
        const p = `${generic(h.path)}${Array.isArray(h.value) ? "[]" : ""}.${k}`;
        const r = ratings.get(p) || { source: h.source, path: p, examples: [] };
        if (r.examples.length < 5) r.examples.push(`${item.name || item.schoolName || "?"} = ${val}`);
        ratings.set(p, r);
      }
    }
  }

  out.log(`${TAG} ${host} — searched ${sources.length} data source(s): ${sources.map((s) => s.name).join(" | ") || "none"}`);
  if (!rows.size) {
    out.warn(`${TAG} No "school" keys found. Scroll down to the Schools section (so the page loads it), then run again.`);
    return;
  }
  out.log(`${TAG} Every key mentioning "school":`);
  out.table([...rows.values()]);
  if (ratings.size) {
    out.log(`${TAG} Rating fields inside school data — these are the paths to read:`);
    out.table([...ratings.values()].map((r) => ({ ...r, examples: r.examples.join("; ") })));
  } else {
    out.warn(`${TAG} School data found, but no rating/score field inside it.`);
  }
  window.schoolProbe = { sources, hits, rows: [...rows.values()], ratings: [...ratings.values()] };
  out.log(`${TAG} Done. Full results are in window.schoolProbe (e.g. copy(window.schoolProbe.ratings)).`);
})();
