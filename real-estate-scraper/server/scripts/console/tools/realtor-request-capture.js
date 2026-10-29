// scripts/console/tools/realtor-request-capture.js
// ─────────────────────────────────────────────────────────────────────────────
// Shows how realtor.com's own page calls its search API, so the
// tool1-realtor*.js / tool2-realtor*.js console scripts can call it the same way.
//
//   1. Open a realtor.com search page (e.g. homes for sale in Columbus, OH).
//   2. Paste this into the DevTools console → Enter.
//   3. Change something on the page that re-runs the search (a price filter,
//      the sort order, or the next results page).
//   4. Run  copy(window.__realtorCaptured)  and paste the result.
//
// Only search-type requests are kept; cookies and auth tokens are left out.
// ─────────────────────────────────────────────────────────────────────────────
(() => {
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
  const MATCH = /graphql|hulk|search|rdc_/i;
  const SECRET = /cookie|authorization|token|kpsdk|x-csrf/i;
  const captured = (window.__realtorCaptured = window.__realtorCaptured ?? []);

  const record = (url, method, headers, body, status, responseText) => {
    let parsed = null;
    try { parsed = typeof body === "string" ? JSON.parse(body) : null; } catch {}
    const entry = {
      url: String(url).replace(location.origin, ""),
      method,
      status,
      headers: Object.fromEntries(Object.entries(headers ?? {}).filter(([k]) => !SECRET.test(k))),
      operationName: parsed?.operationName,
      query: parsed?.query?.replace(/\s+/g, " ").slice(0, 1500),
      variables: parsed?.variables,
      bodyIfNotJson: parsed ? undefined : String(body ?? "").slice(0, 500),
      responseStart: String(responseText ?? "").slice(0, 400),
    };
    captured.push(entry);
    out.log("[capture]", entry.method, entry.url, entry.status, entry.operationName ?? "", entry);
  };

  if (!window.__realtorCaptureInstalled) {
    window.__realtorCaptureInstalled = true;

    const origFetch = window.fetch;
    window.fetch = async function (input, init = {}) {
      const url = typeof input === "string" ? input : input?.url;
      const res = await origFetch.apply(this, arguments);
      if (MATCH.test(url ?? "")) {
        const hdrs = init.headers instanceof Headers ? Object.fromEntries(init.headers) : init.headers;
        res.clone().text().then((t) => record(url, init.method ?? "GET", hdrs, init.body, res.status, t)).catch(() => {});
      }
      return res;
    };

    const open = XMLHttpRequest.prototype.open;
    const setHeader = XMLHttpRequest.prototype.setRequestHeader;
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__cap = { method, url, headers: {} };
      return open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      if (this.__cap) this.__cap.headers[k] = v;
      return setHeader.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      const cap = this.__cap;
      if (cap && MATCH.test(cap.url)) {
        this.addEventListener("load", () => record(cap.url, cap.method, cap.headers, body, this.status, this.responseText));
      }
      return send.apply(this, arguments);
    };
  }

  const earlier = performance.getEntriesByType("resource").map((e) => e.name).filter((u) => MATCH.test(u) && u.startsWith(location.origin));
  out.log("[capture] Search requests this page already made (URLs only):", [...new Set(earlier)]);
  out.log("[capture] Listening — now change a filter or page so the site searches again, then run copy(window.__realtorCaptured).");
})();
