// scripts/console/tools/landcom-page-capture.js
// ─────────────────────────────────────────────────────────────────────────────
// Shows where land.com / landwatch.com keep their listing data (embedded page
// JSON, app state, or API calls), so the tool1-landcom / tool2-landcom console
// scripts can read it the same way.
//
//   1. Open https://www.land.com, search a state (e.g. Ohio), and turn on the
//      property type that includes houses ("Homesites" / "Homes" / "Farms and
//      Ranches" with a house — whatever the site offers).
//   2. Paste this into the DevTools console → Enter. The console answers with
//      a line starting "[capture]".
//   3. Go to the next results page and paste it again; then open one listing's
//      details page and paste it again there. (The site reloads on every page,
//      so the script has to be pasted on each one; what it recorded is kept
//      for this tab.)
//   4. Run  copy(window.__landCaptured)  and paste the result.
//
// Only page structure and the first listing of each list are kept.
// ─────────────────────────────────────────────────────────────────────────────
(() => {
  const out = console;
  if (!/(^|\.)(land|landwatch|landsofamerica)\.com$/.test(location.hostname)) {
    return `[capture] This script only works on land.com / landwatch.com — you ran it on ${location.hostname}.`;
  }
  const SECRET_HEADER = /cookie|authorization|token|x-xsrf|x-csrf/i;
  // Kept in sessionStorage: each page of the site is a full reload
  const STORE = "__landCaptured";
  let saved = [];
  try { saved = JSON.parse(sessionStorage.getItem(STORE) ?? "[]"); } catch {}
  const captured = (window.__landCaptured = window.__landCaptured?.length ? window.__landCaptured : saved);
  const save = () => { try { sessionStorage.setItem(STORE, JSON.stringify(captured)); } catch {} };
  const LISTINGISH = /price|acre|address|listing|propert|bed|lot/i;

  /** Deep copy with long arrays cut to their first item and long strings shortened. */
  function scrub(v, depth = 0) {
    if (depth > 5) return "…";
    if (v && typeof v === "object" && ((typeof Node === "function" && v instanceof Node) || v.window === v)) return "<element>";
    if (Array.isArray(v)) {
      const fields = [...new Set(v.flatMap((x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.keys(x) : [])))];
      return v.length > 1 && fields.length
        ? { _count: v.length, _fieldsAcrossItems: fields, _first: scrub(v[0], depth + 1) }
        : v.slice(0, 5).map((x) => scrub(x, depth + 1));
    }
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).slice(0, 80).map(([k, x]) => [k, scrub(x, depth + 1)]));
    return typeof v === "string" && v.length > 800 ? `${v.slice(0, 800)}…` : v;
  }

  /**
   * Paths to arrays of listing-like objects inside a value. Page globals are
   * large, self-referencing graphs (DOM nodes, framework internals), so each
   * object is visited once, DOM nodes and windows are skipped, and the walk
   * stops after a fixed number of objects.
   */
  function listingArrays(root, rootPath = "$", maxDepth = 8) {
    const found = [];
    const seen = new WeakSet();
    let budget = 20_000;
    const walk = (v, path, depth) => {
      if (depth > maxDepth || !v || typeof v !== "object" || --budget < 0 || seen.has(v)) return;
      if ((typeof Node === "function" && v instanceof Node) || v === window || v.window === v) return;
      seen.add(v);
      let entries;
      try { entries = Array.isArray(v) ? null : Object.entries(v); } catch { return; }
      if (Array.isArray(v)) {
        const objs = v.slice(0, 50).filter((x) => x && typeof x === "object" && !Array.isArray(x));
        if (objs.length >= 3 && objs.some((x) => { try { return Object.keys(x).filter((k) => LISTINGISH.test(k)).length >= 2; } catch { return false; } })) {
          found.push({ path, count: v.length, sample: scrub(objs[0]) });
        }
        v.slice(0, 3).forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1));
        return;
      }
      for (const [k, x] of entries.slice(0, 200)) walk(x, `${path}.${k}`, depth + 1);
    };
    walk(root, rootPath, 0);
    return found;
  }

  // 1) JSON embedded in <script> tags (Next.js data, JSON-LD, app state)
  const scripts = [...document.querySelectorAll("script")].map((s, i) => {
    const text = s.textContent ?? "";
    let json = null;
    const assign = text.match(/^\s*window\.([\w$]+)\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
    try { json = JSON.parse(assign ? assign[2] : text); } catch {}
    return { i, id: s.id || undefined, type: s.type || undefined, src: s.src || undefined, length: text.length, assigns: assign?.[1], json };
  });
  const embedded = scripts
    .filter((s) => s.json)
    .map((s) => ({ id: s.id, type: s.type, assigns: s.assigns, length: s.length, topKeys: Object.keys(s.json).slice(0, 40), listingArrays: listingArrays(s.json) }));

  // 2) Globals the app added that hold listing-like arrays
  const baseline = new Set(Object.getOwnPropertyNames(document.createElement("iframe").contentWindow ?? {}));
  const globals = [];
  for (const k of Object.keys(window)) {
    if (baseline.has(k) || k.startsWith("__land") || typeof window[k] !== "object" || !window[k]) continue;
    try {
      const arrays = listingArrays(window[k], `window.${k}`, 6);
      if (arrays.length) globals.push({ name: k, listingArrays: arrays });
    } catch {}
  }

  // 3) What a listing card / details page shows as text
  const cards = [...document.querySelectorAll("[data-testid*='card' i], [class*='card' i], article")]
    .filter((el) => /\$\s?\d/.test(el.textContent ?? "") && /acre/i.test(el.textContent ?? ""))
    .slice(0, 2)
    .map((el) => ({ tag: el.tagName, cls: String(el.className).slice(0, 120), testid: el.getAttribute("data-testid"), text: el.innerText?.replace(/\s+/g, " ").slice(0, 500), link: el.querySelector("a[href]")?.href }));

  captured.push({
    page: location.href,
    title: document.title,
    embedded,
    globals,
    cards,
    detailText: /\/property\/|\/pid\/|\/listing/i.test(location.pathname) ? document.body.innerText.replace(/\s+/g, " ").slice(0, 3000) : undefined,
    otherScripts: scripts.filter((s) => !s.json && !s.src && s.length > 2000).map((s) => ({ i: s.i, id: s.id, length: s.length, start: (s.length ? document.querySelectorAll("script")[s.i].textContent.slice(0, 300) : "") })),
  });
  save();

  // 4) API calls made from now on (next page, filters, map moves)
  if (!window.__landCaptureInstalled) {
    window.__landCaptureInstalled = true;
    const record = (url, method, headers, body, status, text) => {
      let res = null, req = null;
      try { res = JSON.parse(text); } catch {}
      try { req = typeof body === "string" ? JSON.parse(body) : null; } catch {}
      if (!res) return;
      const entry = {
        api: String(url), method, status,
        headers: Object.fromEntries(Object.entries(headers ?? {}).filter(([k]) => !SECRET_HEADER.test(k))),
        requestBody: req ? scrub(req) : body ? String(body).slice(0, 800) : undefined,
        topKeys: Object.keys(res).slice(0, 40),
        listingArrays: listingArrays(res),
      };
      captured.push(entry);
      save();
      out.log(`[capture] API ${method} ${entry.api} → ${status}`, entry);
    };
    const origFetch = window.fetch;
    window.fetch = async function (input, init = {}) {
      const url = typeof input === "string" ? input : input?.url;
      const res = await origFetch.apply(this, arguments);
      const hdrs = init.headers instanceof Headers ? Object.fromEntries(init.headers) : init.headers;
      res.clone().text().then((t) => record(url, init.method ?? "GET", hdrs, init.body, res.status, t)).catch(() => {});
      return res;
    };
    const XHR = XMLHttpRequest.prototype;
    const origOpen = XHR.open, origSet = XHR.setRequestHeader, origSend = XHR.send;
    XHR.open = function (method, url) { this.__cap = { method, url, headers: {} }; return origOpen.apply(this, arguments); };
    XHR.setRequestHeader = function (k, v) { if (this.__cap) this.__cap.headers[k] = v; return origSet.apply(this, arguments); };
    XHR.send = function (body) {
      const cap = this.__cap;
      if (cap) this.addEventListener("loadend", () => {
        if (this.responseType === "" || this.responseType === "text") record(cap.url, cap.method, cap.headers, body, this.status, this.responseText);
      });
      return origSend.apply(this, arguments);
    };
  }

  const last = captured.filter((c) => c.page).pop();
  // Returned, not logged: the console always shows the value of what was pasted
  return `[capture] Page ${captured.filter((c) => c.page).length} recorded (${last.embedded.length} JSON block(s), ` +
    `${last.embedded.reduce((n, e) => n + e.listingArrays.length, 0) + last.globals.length} listing list(s), ${last.cards.length} card(s)). ` +
    "Next: go to the next results page and paste again, open one listing and paste again — then run copy(window.__landCaptured).";
})();
