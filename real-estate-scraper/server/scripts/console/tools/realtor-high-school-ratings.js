(async () => {
  if (!/(^|\.)realtor\.com$/.test(location.hostname)) {
    console.error(`Run this on realtor.com — you are on ${location.hostname}.`);
    return;
  }

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
  const T = "[realtor-schools]";
  const ENDPOINT = "/frontdoor/graphql";
  const REQUEST_TIMEOUT_MS = 30_000;
  const HEADER_SETS = [
    {
      "x-is-bot": "false",
      "Rdc-Client-Name": "WEB_SRP_ORACLE",
      "Rdc-Client-Version": "0.0.1",
      "rdc-ab-test-client": "rdc-search-for-sale",
      "srp-consumer-triggered-request": "rdc-search-for-sale",
    },
    {
      "x-is-bot": "false",
      "Rdc-Client-Name": "WEB_SRP_ORACLE",
      "Rdc-Client-Version": "0.0.1",
    },
  ];
  const QUERIES = [
    `query NearbySchools($propertyId: ID!) {
      home(property_id: $propertyId) {
        property_id
        nearby_schools(radius: 5.0, limit_per_level: 3) {
          schools { rating name education_levels assigned distance_in_miles }
        }
      }
    }`,
    `query NearbySchools($propertyId: ID!) {
      home(property_id: $propertyId) {
        property_id
        nearby_schools(radius: 5.0, limit_per_level: 3) {
          schools { rating name education_levels distance_in_miles }
        }
      }
    }`,
  ];

  let queryIndex = 0;
  let headerIndex = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pause = () => sleep(1_200 + Math.random() * 1_300);
  class BlockedError extends Error {}

  async function postOnce(body, headers) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    let res, text;
    try {
      res = await window.fetch(ENDPOINT, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", accept: "application/json", ...headers },
        body,
        signal: ctrl.signal,
      });
      text = await res.text();
    } catch (err) {
      throw Object.assign(
        new Error(err.name === "AbortError" ? `timed out after ${REQUEST_TIMEOUT_MS / 1000}s` : err.message),
        { retryable: true },
      );
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 403 || res.status === 429) {
      throw Object.assign(new BlockedError(`HTTP ${res.status} (bot check / rate limit)`), { retryable: true });
    }
    if (res.status >= 500) throw Object.assign(new Error(`HTTP ${res.status}`), { retryable: true });
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw Object.assign(new Error(`HTTP ${res.status}, response was not JSON`), { status: res.status });
    }
    if (!res.ok && !json.errors) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    return json;
  }

  async function post(body) {
    const waits = [5_000, 15_000, 45_000];
    for (let attempt = 0; ; attempt++) {
      try {
        return await postOnce(body, HEADER_SETS[headerIndex]);
      } catch (err) {
        if (err instanceof BlockedError && HEADER_SETS.length > 1) {
          headerIndex = (headerIndex + 1) % HEADER_SETS.length;
        }
        if (!err.retryable || attempt >= waits.length) throw err;
        out.warn(`${T} request failed (${err.message}) — retrying in ${waits[attempt] / 1000}s`);
        await sleep(waits[attempt]);
      }
    }
  }

  async function fetchSchools(propertyId) {
    for (;;) {
      const body = JSON.stringify({
        operationName: "NearbySchools",
        query: QUERIES[queryIndex],
        variables: { propertyId },
      });
      const json = await post(body);
      if (json.errors?.length) {
        if (queryIndex === 0) {
          queryIndex = 1;
          continue;
        }
        throw new Error(json.errors[0]?.message ?? "school query failed");
      }
      return json.data?.home?.nearby_schools?.schools ?? null;
    }
  }

  function propertyIdFrom(value) {
    let s = value;
    if (s && typeof s === "object") s = s.Link ?? s.link ?? s.url ?? s.id ?? "";
    s = String(s ?? "").trim();

    const permalink = s.match(/M(\d{3,})-(\d{3,})/i);
    if (permalink) return permalink[1] + permalink[2];

    const dashed = s.match(/^\d{3,}-\d{3,}$/);
    if (dashed) return s.replace(/-/g, "");

    const numeric = s.match(/^\d{6,}$/);
    if (numeric) return s;

    return "";
  }

  function addressFrom(value) {
    if (value && typeof value === "object") return value.Address ?? value.address ?? "";
    return "";
  }

  function summarize(schools) {
    if (!Array.isArray(schools) || !schools.length) {
      return { highSchoolRating: "", sheetRating: "", detail: "", highSchool: "" };
    }
    const pool = schools.some((s) => s.assigned) ? schools.filter((s) => s.assigned) : schools;
    const levels = { E: [], M: [], H: [] };
    const highSchools = [];
    for (const sc of pool) {
      const r = Number(sc.rating);
      const text = Array.isArray(sc.education_levels)
        ? sc.education_levels.join(" ")
        : String(sc.education_levels ?? "");
      const lv = text.toLowerCase();
      const isHigh = /high/.test(lv);
      if (r > 0) {
        if (/elementary|primary/.test(lv)) levels.E.push(r);
        if (/middle/.test(lv)) levels.M.push(r);
        if (isHigh) levels.H.push(r);
      }
      if (isHigh) highSchools.push({ name: sc.name ?? "", rating: r > 0 ? r : null });
    }
    const best = (arr) => (arr.length ? Math.max(...arr) : null);
    const high = best(levels.H);
    const sheet = high ?? best(levels.M) ?? best(levels.E);
    const bestHighSchool = highSchools.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))[0];
    const detail = Object.entries(levels)
      .filter(([, arr]) => arr.length)
      .map(([k, arr]) => `${k} ${best(arr)}`)
      .join(" / ");
    return {
      highSchoolRating: high ? `${high}/10` : "",
      sheetRating: sheet ? `${sheet}/10` : "",
      detail,
      highSchool: bestHighSchool?.name ?? "",
    };
  }

  const existing = [];
  const existingIds = new Set();
  for (const [source, rows] of [
    ["main", window.__realtorMainListings],
    ["strict", window.__realtorStrictListings],
    ["input", window.__realtorSchoolInput],
  ]) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const id = propertyIdFrom(row);
      if (!id || existingIds.has(id)) continue;
      existingIds.add(id);
      existing.push({
        id,
        source,
        address: addressFrom(row) || id,
        link: typeof row === "string" ? row : (row.Link ?? row.link ?? row.url ?? ""),
        existingRating: row?.["School Rating"] ?? row?.schoolRating ?? "",
      });
    }
  }

  const css = (node, styles) => {
    Object.assign(node.style, styles);
    return node;
  };

  const wrap = css(document.createElement("div"), {
    position: "fixed", inset: "0", zIndex: "2147483647", background: "rgba(0,0,0,.55)",
    display: "flex", alignItems: "center", justifyContent: "center",
    font: "13px/1.4 system-ui, -apple-system, Segoe UI, sans-serif",
  });
  const box = css(document.createElement("div"), {
    background: "#fff", color: "#111", padding: "16px", borderRadius: "10px",
    width: "min(760px, 92vw)", maxHeight: "86vh", display: "flex", flexDirection: "column",
    gap: "10px", boxShadow: "0 10px 40px rgba(0,0,0,.4)", boxSizing: "border-box",
  });
  const title = css(document.createElement("div"), { fontWeight: "700", fontSize: "16px" });
  title.textContent = "Realtor high-school ratings";
  const help = css(document.createElement("div"), { opacity: ".75" });
  help.textContent = existing.length
    ? `Found ${existing.length} listing(s) from this tab. Paste Realtor links or property IDs (one per line), then click Get ratings.`
    : "Paste Realtor links or property IDs (one per line), then click Get ratings. Links contain _M12345-67890; IDs look like 12345-67890.";
  const ta = css(document.createElement("textarea"), {
    width: "100%", height: "220px", font: "12px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace",
    padding: "8px", border: "1px solid #bbb", borderRadius: "6px", resize: "vertical", boxSizing: "border-box",
  });
  ta.placeholder = "https://www.realtor.com/realestateandhomes-detail/..._M12345-67890\n12345-67890";
  ta.value = existing.map((x) => x.link || x.id).join("\n");
  const actions = css(document.createElement("div"), { display: "flex", gap: "8px", justifyContent: "flex-end" });
  const cancelBtn = css(document.createElement("button"), { padding: "7px 12px", cursor: "pointer" });
  cancelBtn.textContent = "Cancel";
  const runBtn = css(document.createElement("button"), { padding: "7px 12px", cursor: "pointer", fontWeight: "700" });
  runBtn.textContent = "Get ratings";
  const statusEl = css(document.createElement("div"), {
    font: "12px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace",
    whiteSpace: "pre-wrap", maxHeight: "160px", overflow: "auto",
  });
  actions.append(cancelBtn, runBtn);
  box.append(title, help, ta, actions, statusEl);
  wrap.append(box);
  document.body.append(wrap);
  ta.focus();

  let stopped = false;
  cancelBtn.onclick = () => {
    stopped = true;
    wrap.remove();
  };

  runBtn.onclick = async () => {
    runBtn.disabled = true;
    cancelBtn.textContent = "Stop";
    statusEl.textContent = "";

    const byId = new Map(existing.map((x) => [x.id, x]));
    const seen = new Set();
    const items = [];
    const skipped = [];
    for (const line of ta.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      const id = propertyIdFrom(line);
      if (!id) {
        skipped.push(line);
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      const meta = byId.get(id);
      items.push({
        id,
        address: meta?.address ?? id,
        link: meta?.link ?? line,
        existingRating: meta?.existingRating ?? "",
      });
    }

    if (!items.length) {
      statusEl.textContent = "No Realtor property IDs found. Paste links containing _M12345-67890 or IDs like 12345-67890.";
      runBtn.disabled = false;
      cancelBtn.textContent = "Close";
      return;
    }
    if (skipped.length) out.warn(`${T} skipped ${skipped.length} line(s) with no property ID`, skipped);

    const results = [];
    for (let i = 0; i < items.length; i++) {
      if (stopped) break;
      const item = items[i];
      statusEl.textContent = `Fetching ${i + 1}/${items.length}: ${item.address}`;
      try {
        const schools = await fetchSchools(item.id);
        const summary = summarize(schools);
        results.push({ ...item, ...summary, error: "" });
        out.log(`${T} ${i + 1}/${items.length} ${item.address} -> ${summary.highSchoolRating || "(no high school rating)"}`);
      } catch (err) {
        results.push({
          ...item,
          highSchoolRating: "",
          sheetRating: "",
          detail: "",
          highSchool: "",
          error: err.message,
        });
        out.warn(`${T} ${item.address}: ${err.message}`);
      }
      await pause();
    }

    const rows = results.map((r) => ({
      Address: r.address,
      "High School Rating": r.highSchoolRating,
      "School Rating": r.sheetRating,
      "Schools (E/M/H)": r.detail,
      "High School": r.highSchool,
      Link: r.link,
      "Property ID": r.id,
      Error: r.error,
    }));
    window.__realtorSchoolRatings = rows;

    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [Object.keys(rows[0]), ...rows.map(Object.values)]
      .map((row) => row.map(esc).join(","))
      .join("\n");
    window.__realtorSchoolRatingsCSV = csv;

    out.table(rows);
    try {
      if (typeof copy === "function") copy(csv);
      else await navigator.clipboard.writeText(csv);
      statusEl.textContent = `Done: ${rows.length} row(s). CSV copied to clipboard. window.__realtorSchoolRatings is set.`;
    } catch {
      statusEl.textContent = `Done: ${rows.length} row(s). Copy failed — run copy(window.__realtorSchoolRatingsCSV).`;
    }
    out.log(`${T} Done: ${rows.length} row(s). window.__realtorSchoolRatings is set.`);
    runBtn.disabled = false;
    runBtn.textContent = "Run again";
    cancelBtn.textContent = "Close";
  };
})();
