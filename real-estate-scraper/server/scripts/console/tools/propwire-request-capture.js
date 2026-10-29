// scripts/console/tools/propwire-request-capture.js
// ─────────────────────────────────────────────────────────────────────────────
// Shows how propwire.com's own page calls api.propwire.com (the search body it
// sends and the fields it gets back), so the tool1-propwire / tool2-propwire
// console scripts can call it the same way.
//
//   1. Log in at https://propwire.com and open the search page.
//   2. Paste this into the DevTools console → Enter.
//   3. Search a state (e.g. Ohio) with the "For Sale" / MLS Active filter on,
//      then change one filter (price, beds or lot size) so the search re-runs.
//   4. Open one property's details page from the results.
//   5. Run  copy(window.__propwireCaptured)  and paste the result.
//
// The Authorization token and cookies are left out, and owner names, phones,
// emails and mailing addresses are replaced with "<hidden>". Only the first
// result of each response is kept in full; the rest are summarised as the
// list of field names.
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
  if (!/(^|\.)propwire\.com$/.test(location.hostname)) {
    out.error(`This script only works on propwire.com — you ran it on ${location.hostname}.`);
    return;
  }
  const MATCH = /api\.propwire\.com|\/api\//i;
  const SECRET_HEADER = /cookie|authorization|token|x-xsrf|x-csrf/i;
  const PRIVATE_FIELD = /owner|phone|email|mailing|contact|skip_?trace/i;
  const captured = (window.__propwireCaptured = window.__propwireCaptured ?? []);

  /** Deep copy with private fields hidden and long arrays cut to their first item. */
  function scrub(v, depth = 0) {
    if (depth > 8) return "…";
    if (Array.isArray(v)) {
      const fields = [...new Set(v.flatMap((x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.keys(x) : [])))];
      return v.length > 1 && fields.length
        ? { _count: v.length, _fieldsAcrossItems: fields, _first: scrub(v[0], depth + 1) }
        : v.map((x) => scrub(x, depth + 1));
    }
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) =>
        [k, PRIVATE_FIELD.test(k) && x != null && typeof x !== "boolean" ? "<hidden>" : scrub(x, depth + 1)]));
    }
    return typeof v === "string" && v.length > 1500 ? `${v.slice(0, 1500)}…` : v;
  }

  function record(url, method, headers, body, status, text) {
    let reqJson = null, resJson = null;
    try { reqJson = typeof body === "string" ? JSON.parse(body) : null; } catch {}
    try { resJson = JSON.parse(text); } catch {}
    const entry = {
      url: String(url),
      method,
      status,
      headers: Object.fromEntries(Object.entries(headers ?? {}).filter(([k]) => !SECRET_HEADER.test(k))),
      requestBody: reqJson ? scrub(reqJson) : body ? String(body).slice(0, 800) : undefined,
      response: resJson ? scrub(resJson) : String(text ?? "").slice(0, 400),
    };
    captured.push(entry);
    out.log(`[capture] #${captured.length} ${method} ${entry.url} → ${status}`, entry);
  }

  if (!window.__propwireCaptureInstalled) {
    window.__propwireCaptureInstalled = true;

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

    const XHR = XMLHttpRequest.prototype;
    const origOpen = XHR.open, origSet = XHR.setRequestHeader, origSend = XHR.send;
    XHR.open = function (method, url) { this.__cap = { method, url, headers: {} }; return origOpen.apply(this, arguments); };
    XHR.setRequestHeader = function (k, v) { if (this.__cap) this.__cap.headers[k] = v; return origSet.apply(this, arguments); };
    XHR.send = function (body) {
      const cap = this.__cap;
      if (cap && MATCH.test(cap.url ?? "")) {
        this.addEventListener("loadend", () => {
          const text = this.responseType === "" || this.responseType === "text" ? this.responseText
            : this.responseType === "json" ? JSON.stringify(this.response) : "";
          record(cap.url, cap.method, cap.headers, body, this.status, text);
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  out.log(
    "%c[capture] Ready. Now: search a state with the For Sale filter on, change one filter, open one property — then run copy(window.__propwireCaptured) and paste the result.",
    "font-weight:bold",
  );
})();
