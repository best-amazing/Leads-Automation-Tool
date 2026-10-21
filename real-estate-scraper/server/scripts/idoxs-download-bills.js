// scripts/idoxs-download-bills.js
// ─────────────────────────────────────────────────────────────────────────────
// Browser-console script: downloads every document listed on the i-doxs
// Bills page (https://secure8.i-doxs.net/BDX/Secure/Bills.aspx), across all
// pages of the list.
//
// Usage:
//   1. Log in to i-doxs yourself and open the Bills page.
//   2. DevTools → Console → paste this whole file → Enter.
//   3. If the browser asks to allow multiple downloads, click Allow.
//   4. It's finished when the console prints "[bills] Done".
//
// No credentials are stored here — it runs inside your logged-in session.
// It recognises the usual ASP.NET patterns: direct PDF links, View/Download
// links and buttons that post back to the server, pop-up viewers
// (window.open), and numbered pages of results. If it finds nothing, it lists
// the page's links and buttons so the matching rules can be adjusted.
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  // Some sites silence console.log; borrow a clean console from a hidden iframe.
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

  const DELAY_MS = 1500; // pause between downloads
  const MAX_PAGES = 50; // safety cap on pages of results
  // Link/button text or URL that suggests a document
  const DOC_HINT = /\.pdf\b|pdf|bill|statement|document|invoice|download|view|print/i;
  // Things that look like documents but are navigation
  const SKIP_HINT = /logout|log out|sign out|help|faq|privacy|terms|contact|bills\.aspx$/i;
  const FILE_TYPES = /pdf|octet-stream|msword|officedocument|excel|image\/|zip/i;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const safeName = (s) => clean(s).replace(/[\\/:*?"<>|]+/g, "-").slice(0, 120) || "document";
  const absUrl = (u, base = location.href) => { try { return new URL(u, base).href; } catch { return null; } };
  // Only this site's own documents (cross-site links like the footer's privacy
  // policy are blocked by the browser anyway)
  const sameSite = (u) => { try { return new URL(u, location.href).origin === location.origin; } catch { return false; } };

  const NAV_RE = /(?:window\.open\(|location(?:\.href)?\s*=)\s*['"]([^'"]+)['"]/gi;
  // A ref that is clearly the file (e.g. i-doxs "__ImageGrabber.axd?…&format=PDF")
  const PDF_REF = /\.pdf\b|format=pdf/i;

  /**
   * Document-like references in a page: frames, pop-ups, redirects, PDF links.
   * Button handlers are read from the DOM so HTML entities are decoded
   * (onclick="document.location.href=&#39;__ImageGrabber.axd?…&#39;").
   * PDF-looking references come first.
   */
  function refsIn(html, doc, base) {
    const handlers = [...doc.querySelectorAll("[onclick], a[href^='javascript:' i]")]
      .flatMap((e) => [e.getAttribute("onclick") ?? "", e.getAttribute("href") ?? ""]);
    const refs = [
      ...[...doc.querySelectorAll("iframe[src], frame[src], embed[src]")].map((e) => e.getAttribute("src")),
      ...[...doc.querySelectorAll("object[data]")].map((e) => e.getAttribute("data")),
      ...handlers.flatMap((code) => [...code.matchAll(NAV_RE)].map((m) => m[1])),
      ...[...html.matchAll(NAV_RE)].map((m) => m[1]),
      ...[...html.matchAll(/['"]([^'"\s]+\.pdf(?:\?[^'"\s]*)?)['"]/gi)].map((m) => m[1]),
      doc.querySelector('meta[http-equiv="refresh" i]')?.getAttribute("content")?.match(/url=(.+)$/i)?.[1],
    ];
    const urls = refs.filter(Boolean).map((r) => absUrl(r.trim(), base)).filter((u) => u && sameSite(u));
    return [...new Set(urls)].sort((a, b) => PDF_REF.test(b) - PDF_REF.test(a));
  }
  // References already on the Bills page itself (footer links, scripts) are
  // never "the document" a View link opened
  const staticRefs = new Set(refsIn(document.documentElement.outerHTML, document, location.href));

  // ── Collect document candidates from a page ──────────────────────────────
  function rowLabel(el) {
    // The table row usually holds the bill date / account — use it to name
    // files. Links often sit in a nested table, so climb until the row says
    // more than the link itself ("View Bill").
    const own = clean(el.textContent || el.title || el.value || "");
    let row = el.closest("tr");
    while (row && clean(row.textContent) === own) row = row.parentElement?.closest("tr");
    if (!row) return own;
    // Join the cells with spaces ("10/15/2026 $130.00 View Bill")
    return [...row.children].map((c) => clean(c.textContent)).filter(Boolean).join(" ") || own;
  }
  /**
   * File name from the row's columns, matched by header text:
   * "2026-10-15 - Bill - 123 Main St - 1234567890". Falls back to the whole
   * row's text when the list has no recognisable headers.
   */
  function rowName(el) {
    const own = clean(el.textContent || el.title || el.value || "");
    let row = el.closest("tr");
    while (row && clean(row.textContent) === own) row = row.parentElement?.closest("tr");
    const table = row?.closest("table");
    const headerRow = table && [...table.querySelectorAll("tr")].find((tr) => tr.querySelector("th"));
    if (!row || !headerRow) return rowLabel(el);
    const headers = [...headerRow.children].map((c) => clean(c.textContent).toLowerCase());
    const cells = [...row.children].map((c) => clean(c.textContent));
    if (cells.length !== headers.length) return rowLabel(el); // columns don't line up
    // First header matching any pattern, tried in order ("bill date" before a bare "date")
    const col = (...res) => {
      for (const re of res) {
        const i = headers.findIndex((h) => re.test(h));
        if (i >= 0) return cells[i] ?? "";
      }
      return "";
    };
    const isoDate = (s) => {
      const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : s;
    };
    const parts = [isoDate(col(/bill date/, /statement date/, /^date$/)), "Bill", col(/service address/, /address/), col(/account number/, /account/)];
    return parts.filter(Boolean).length > 1 ? parts.filter(Boolean).join(" - ") : rowLabel(el);
  }
  // Generic server names ("document 0.pdf") say nothing about the bill
  const GENERIC_NAME = /^(document|file|download|image|bill|untitled)[\s_-]*\d*(\.\w+)?$/i;

  // Grid column headers ("Bill Date", "Amount Due"…) sort the list; they're not documents
  const isHeader = (el, arg) => /^Sort\$/i.test(arg ?? "") || !!el.closest("th, thead");

  function collect(doc, baseUrl) {
    const items = [];
    const pages = [];
    const pushUrl = (raw, el) => {
      try {
        const url = new URL(raw, baseUrl);
        if (!/^https?:$/.test(url.protocol) || !sameSite(url.href) || SKIP_HINT.test(url.pathname)) return;
        items.push({ kind: "url", key: url.href, url: url.href, label: rowName(el) });
      } catch {}
    };

    for (const el of doc.querySelectorAll("a[href], area[href], [onclick]")) {
      const href = el.getAttribute("href") ?? "";
      const onclick = el.getAttribute("onclick") ?? "";
      const text = clean(el.textContent || el.title || el.getAttribute("alt") || "");
      const code = `${href} ${onclick}`;
      const pb = code.match(/__doPostBack\(\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/);
      const realHref = href && !href.startsWith("#") && !/^javascript:/i.test(href) ? absUrl(href, baseUrl) : null;

      // Pager: "Page$3" postbacks, or numbered links ("Jump To Page: 1 2 3 4")
      const pageNum = pb && /^Page\$/i.test(pb[2]) ? pb[2].replace(/^Page\$/i, "") : /^\d{1,3}$/.test(text) ? text : null;
      if (pageNum) {
        if (pb) pages.push({ kind: "postback", target: pb[1], arg: pb[2], n: pageNum });
        else if (realHref && sameSite(realHref)) pages.push({ kind: "url", url: realHref, n: pageNum });
        continue;
      }
      if (isHeader(el, pb?.[2])) continue;

      // window.open('ViewBill.aspx?id=…') and similar pop-up viewers
      const opened = code.match(/window\.open\(\s*['"]([^'"]+)['"]/i);
      if (opened) { pushUrl(opened[1], el); continue; }

      // ASP.NET __doPostBack('target','argument')
      if (pb) {
        const [, target, arg] = pb;
        if (DOC_HINT.test(`${text} ${target} ${arg}`) && !SKIP_HINT.test(text)) {
          items.push({ kind: "postback", key: `${target}|${arg}`, target, arg, label: rowName(el) });
        }
        continue;
      }

      if (realHref) {
        if (DOC_HINT.test(`${href} ${text}`) && !SKIP_HINT.test(`${href} ${text}`)) pushUrl(href, el);
      }
    }

    // WebForms buttons inside the grid (input type=submit/image, <button>)
    for (const el of doc.querySelectorAll('input[type="submit"], input[type="image"], button[name]')) {
      const name = el.getAttribute("name");
      const label = clean(el.value || el.textContent || el.title || el.getAttribute("alt") || "");
      if (name && DOC_HINT.test(`${label} ${name}`) && !SKIP_HINT.test(label)) {
        items.push({ kind: "button", key: `btn|${name}`, name, value: el.value ?? "", image: el.type === "image", label: rowName(el) });
      }
    }
    return { items, pages };
  }

  // ── Requests ─────────────────────────────────────────────────────────────
  function postbackBody(doc, extra) {
    const form = doc.forms[0];
    const fd = form ? new FormData(form) : new FormData();
    fd.set("__EVENTTARGET", extra.target ?? "");
    fd.set("__EVENTARGUMENT", extra.arg ?? "");
    if (extra.name) {
      if (extra.image) { fd.set(`${extra.name}.x`, "1"); fd.set(`${extra.name}.y`, "1"); }
      else fd.set(extra.name, extra.value ?? "");
    }
    const action = new URL(form?.getAttribute("action") || location.href, location.href).href;
    return { action, body: new URLSearchParams(fd) };
  }

  async function post(doc, extra) {
    const { action, body } = postbackBody(doc, extra);
    return fetch(action, { method: "POST", body, credentials: "include" });
  }

  let saved = 0;
  let lastNonFile = null; // last response that wasn't a file, for debugging
  const usedNames = new Map();

  function download(blob, name) {
    const n = (usedNames.get(name) ?? 0) + 1;
    usedNames.set(name, n);
    const finalName = n > 1 ? name.replace(/(\.[a-z0-9]+)?$/i, ` (${n})$1`) : name;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = finalName;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 30_000);
    saved++;
    out.log(`%c[bills] ✓ ${saved}. ${finalName}`, "color:green");
  }

  function fileNameFrom(resp, label) {
    const cd = resp.headers.get("content-disposition") ?? "";
    const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    const serverName = m ? safeName(decodeURIComponent(m[1])) : "";
    if (serverName && !GENERIC_NAME.test(serverName)) return serverName;
    const type = resp.headers.get("content-type") ?? "";
    const ext =
      serverName.match(/\.\w+$/)?.[0] ??
      (/pdf/i.test(type) ? ".pdf" : /zip/i.test(type) ? ".zip" : /image\/(\w+)/i.test(type) ? `.${type.match(/image\/(\w+)/i)[1]}` : "");
    return `${safeName(label)}${ext}`;
  }

  /**
   * Saves a response if it's a file; if it's an HTML viewer page, follows the
   * embedded document (iframe/embed/object/window.open/PDF link) once.
   */
  async function handle(resp, label, depth = 0) {
    const type = resp.headers.get("content-type") ?? "";
    const cd = resp.headers.get("content-disposition") ?? "";
    if (FILE_TYPES.test(type) || /attachment/i.test(cd)) {
      download(await resp.blob(), fileNameFrom(resp, label));
      return true;
    }
    if (depth > 2 || !/html/i.test(type)) return false;
    const html = await resp.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    // The viewer is whatever this response references that the Bills page didn't
    const embedded = refsIn(html, doc, resp.url || location.href).find((u) => !staticRefs.has(u));
    if (!embedded) {
      lastNonFile = { label, url: resp.url, html };
      return false;
    }
    const next = await fetch(embedded, { credentials: "include" });
    return handle(next, label, depth + 1);
  }

  // ── Walk every page of the list ──────────────────────────────────────────
  out.log("%c[bills] Looking for documents…", "font-weight:bold");
  let doc = document;
  let pageUrl = location.href;
  const done = new Set();
  const failed = [];
  const visitedPages = new Set(["1"]);
  let pageNo = 1;

  while (pageNo <= MAX_PAGES) {
    const { items, pages } = collect(doc, pageUrl);
    // Postback/button names repeat on every page of the grid (row 1 is
    // "gvBills$ctl02$lnkViewBill" on page 1 and page 2), so they're only
    // unique per page; direct URLs are unique everywhere.
    for (const it of items) if (it.kind !== "url") it.key = `p${pageNo}|${it.key}`;
    const fresh = items.filter((it) => !done.has(it.key));
    out.log(`[bills] Page ${pageNo}: ${fresh.length} document link(s)`);
    out.table(fresh.map((it) => ({
      kind: it.kind,
      row: it.label.slice(0, 70),
      action: (it.url || it.target || it.name || "").slice(0, 70),
    })));

    const savedBefore = saved;
    for (const it of fresh) {
      done.add(it.key);
      try {
        const resp = it.kind === "url"
          ? await fetch(it.url, { credentials: "include" })
          : await post(doc, it);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        if (!(await handle(resp, it.label))) failed.push({ label: it.label, reason: "response wasn't a file" });
      } catch (err) {
        failed.push({ label: it.label, reason: err.message });
      }
      await sleep(DELAY_MS);
    }

    out.log(`[bills] Page ${pageNo}: downloaded ${saved - savedBefore} of ${fresh.length}`);

    // Next page: the lowest page number not yet visited
    const next = pages
      .filter((p) => !visitedPages.has(p.n) && p.n !== "First" && p.n !== "Prev")
      .sort((a, b) => (Number(a.n) || 1e9) - (Number(b.n) || 1e9))[0];
    if (!next) break;
    visitedPages.add(next.n);
    try {
      const resp = next.kind === "url"
        ? await fetch(next.url, { credentials: "include" })
        : await post(doc, next);
      pageUrl = resp.url || pageUrl;
      doc = new DOMParser().parseFromString(await resp.text(), "text/html");
      pageNo++;
    } catch (err) {
      out.error(`[bills] Couldn't open page ${next.n}: ${err.message}`);
      break;
    }
    await sleep(DELAY_MS);
  }

  out.log(`%c[bills] Done: ${saved} file(s) downloaded across ${pageNo} page(s)`, "font-weight:bold");
  if (failed.length) {
    out.warn(`[bills] ${failed.length} item(s) didn't download:`);
    out.table(failed);
  }
  if (lastNonFile) {
    window.__billsLastResponse = lastNonFile;
    out.warn(
      "[bills] Some View links returned a page instead of a file. To help adapt the script, run " +
        "copy(window.__billsLastResponse.html) and save the result to a file (it may contain account details).",
    );
  }
  if (done.size === 0) {
    // Nothing matched — list what's on the page so the rules can be adjusted
    out.warn("[bills] No document links found. Here are the page's links and buttons:");
    out.table(
      [...document.querySelectorAll("a, button, input[type=submit], input[type=image], [onclick]")]
        .slice(0, 80)
        .map((el) => ({
          text: clean(el.textContent || el.value || el.title || el.getAttribute("alt")).slice(0, 60),
          href: (el.getAttribute("href") || "").slice(0, 90),
          onclick: (el.getAttribute("onclick") || "").slice(0, 90),
          name: el.getAttribute("name") || "",
        })),
    );
  }
})();
