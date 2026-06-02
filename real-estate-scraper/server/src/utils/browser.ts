// src/utils/browser.ts

import { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { config } from "../config";
import { logger } from "./logger";

// ── Stealth plugin — all evasion sub-modules explicitly enabled ───────────────
const stealth = StealthPlugin();
stealth.enabledEvasions = new Set([
  "chrome.app",
  "chrome.csi",
  "chrome.loadTimes",
  "chrome.runtime",
  "defaultArgs",
  "iframe.contentWindow",
  "media.codecs",
  "navigator.hardwareConcurrency",
  "navigator.languages",
  "navigator.permissions",
  "navigator.plugins",
  "navigator.vendor",
  "navigator.webdriver",
  "sourceurl",
  "user-agent-override",
  "webgl.vendor",
  "window.outerdimensions",
]);
chromium.use(stealth);

// ── Proxy parsing ─────────────────────────────────────────────────────────────

function parseProxy(
  proxyUrl: string | null | undefined,
): { server: string; username?: string; password?: string } | undefined {
  if (!proxyUrl) return undefined;
  try {
    const parsed = new URL(proxyUrl);
    const server = `${parsed.protocol}//${parsed.host}`;
    const username = parsed.username
      ? decodeURIComponent(parsed.username)
      : undefined;
    const password = parsed.password
      ? decodeURIComponent(parsed.password)
      : undefined;
    if (username)
      logger.info(
        `[browser] Proxy credentials: user=${username} host=${parsed.host}`,
      );
    return { server, username, password };
  } catch {
    logger.warn(
      `[browser] Could not parse proxy URL — using as raw server: ${proxyUrl}`,
    );
    return { server: proxyUrl };
  }
}

// ── Comprehensive stealth init script ─────────────────────────────────────────
// Covers every PerimeterX detection vector that the plugin alone misses.
// Runs inside every page before any site JS executes.

const STEALTH_SCRIPT = `
(function () {
  // 1. webdriver
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  } catch {}

  // 2. Remove webdriver attribute from <html>
  try {
    const orig = document.documentElement.getAttribute.bind(document.documentElement);
    document.documentElement.getAttribute = function(attr) {
      if (attr === 'webdriver') return null;
      return orig(attr);
    };
  } catch {}

  // 3. Realistic Plugin / MimeType objects
  try {
    const makePlugin = (name, desc, filename, mimeTypes) => {
      const plugin = Object.create(Plugin.prototype);
      Object.defineProperties(plugin, {
        name:        { value: name,            enumerable: true },
        description: { value: desc,            enumerable: true },
        filename:    { value: filename,        enumerable: true },
        length:      { value: mimeTypes.length, enumerable: true },
      });
      mimeTypes.forEach((mt, i) => { plugin[i] = mt; });
      return plugin;
    };
    const makeMime = (type, desc, suffixes, plugin) => {
      const mime = Object.create(MimeType.prototype);
      Object.defineProperties(mime, {
        type:          { value: type,     enumerable: true },
        description:   { value: desc,     enumerable: true },
        suffixes:      { value: suffixes, enumerable: true },
        enabledPlugin: { value: plugin,   enumerable: true },
      });
      return mime;
    };

    const pdfPlugin = makePlugin('PDF Viewer', 'Portable Document Format', 'internal-pdf-viewer', []);
    const pdfMime   = makeMime('application/pdf', 'Portable Document Format', 'pdf', pdfPlugin);
    const pdfMime2  = makeMime('text/pdf',         'Portable Document Format', 'pdf', pdfPlugin);
    pdfPlugin[0] = pdfMime; pdfPlugin[1] = pdfMime2;

    const chromePdf = makePlugin('Chrome PDF Viewer', 'Portable Document Format', 'internal-pdf-viewer', []);
    chromePdf[0] = pdfMime;

    const nativeClient = makePlugin('Native Client', '', 'internal-nacl-plugin', []);

    const pluginArray = Object.create(PluginArray.prototype);
    Object.defineProperty(pluginArray, 'length', { value: 3 });
    pluginArray[0] = pdfPlugin; pluginArray[1] = chromePdf; pluginArray[2] = nativeClient;
    pluginArray.item      = i => pluginArray[i];
    pluginArray.namedItem = n => [pdfPlugin, chromePdf, nativeClient].find(p => p.name === n) ?? null;
    pluginArray.refresh   = () => {};
    Object.defineProperty(navigator, 'plugins', { get: () => pluginArray });

    const mimeArray = Object.create(MimeTypeArray.prototype);
    Object.defineProperty(mimeArray, 'length', { value: 2 });
    mimeArray[0] = pdfMime; mimeArray[1] = pdfMime2;
    mimeArray.item      = i => mimeArray[i];
    mimeArray.namedItem = n => [pdfMime, pdfMime2].find(m => m.type === n) ?? null;
    Object.defineProperty(navigator, 'mimeTypes', { get: () => mimeArray });
  } catch {}

  // 4. Languages + vendor
  try {
    Object.defineProperty(navigator, 'languages',  { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'vendor',     { get: () => 'Google Inc.' });
    Object.defineProperty(navigator, 'vendorSub',  { get: () => '' });
    Object.defineProperty(navigator, 'productSub', { get: () => '20030107' });
  } catch {}

  // 5. Hardware signals
  try {
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory',        { get: () => 8 });
    Object.defineProperty(screen,    'colorDepth',          { get: () => 24 });
    Object.defineProperty(screen,    'pixelDepth',          { get: () => 24 });
  } catch {}

  // 6. Screen / outer dimensions — must match viewport (1440 x 900)
  try {
    Object.defineProperty(screen,  'width',       { get: () => 1440 });
    Object.defineProperty(screen,  'height',      { get: () => 900  });
    Object.defineProperty(screen,  'availWidth',  { get: () => 1440 });
    Object.defineProperty(screen,  'availHeight', { get: () => 860  });
    Object.defineProperty(window,  'outerWidth',  { get: () => 1440 });
    Object.defineProperty(window,  'outerHeight', { get: () => 900  });
    Object.defineProperty(window,  'innerWidth',  { get: () => 1440 });
    Object.defineProperty(window,  'innerHeight', { get: () => 860  });
    Object.defineProperty(window,  'screenX',     { get: () => 0    });
    Object.defineProperty(window,  'screenY',     { get: () => 0    });
  } catch {}

  // 7. chrome.* APIs
  try {
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) {
      window.chrome.runtime = {
        PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
        PlatformArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformNaclArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64' },
        RequestUpdateCheckStatus: { THROTTLED: 'throttled', NO_UPDATE: 'no_update', UPDATE_AVAILABLE: 'update_available' },
        OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' },
        OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
        connect: () => {}, sendMessage: () => {}, id: undefined,
      };
    }
    if (!window.chrome.app) {
      window.chrome.app = {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        getDetails:     () => null,
        getIsInstalled: () => false,
        installState:   () => {},
        runningState:   () => 'cannot_run',
      };
    }
    window.chrome.loadTimes = function () {
      return {
        requestTime:             Date.now() / 1000 - 0.5,
        startLoadTime:           Date.now() / 1000 - 0.4,
        commitLoadTime:          Date.now() / 1000 - 0.2,
        finishDocumentLoadTime:  Date.now() / 1000 - 0.1,
        finishLoadTime:          Date.now() / 1000,
        firstPaintTime:          Date.now() / 1000 - 0.08,
        firstPaintAfterLoadTime: 0,
        navigationType:          'Other',
        wasFetchedViaSpdy:       true,
        wasNpnNegotiated:        true,
        npnNegotiatedProtocol:   'h2',
        wasAlternateProtocolAvailable: false,
        connectionInfo:          'h2',
      };
    };
    window.chrome.csi = function () {
      return { startE: Date.now(), onloadT: Date.now(), pageT: 1000, tran: 15 };
    };
  } catch {}

  // 8. Permissions — 'default' not 'denied'
  try {
    const origQuery = window.navigator.permissions?.query?.bind(navigator.permissions);
    if (origQuery) {
      window.navigator.permissions.query = (parameters) => {
        if (parameters.name === 'notifications') {
          return Promise.resolve({ state: 'default', onchange: null });
        }
        return origQuery(parameters);
      };
    }
  } catch {}

  // 9. navigator.connection
  try {
    if (!navigator.connection) {
      Object.defineProperty(navigator, 'connection', {
        get: () => ({ effectiveType: '4g', rtt: 50, downlink: 10, saveData: false }),
      });
    }
  } catch {}

  // 10. getBattery
  try {
    navigator.getBattery = () =>
      Promise.resolve({ charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1.0 });
  } catch {}

  // 11. WebGL vendor / renderer
  try {
    const getParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) return 'Intel Inc.';
      if (parameter === 37446) return 'Intel Iris OpenGL Engine';
      return getParam.call(this, parameter);
    };
  } catch {}

  // 12. toString() consistency
  try {
    const nativeToString = Function.prototype.toString;
    Function.prototype.toString = function() {
      if (this === Function.prototype.toString) return 'function toString() { [native code] }';
      return nativeToString.call(this);
    };
  } catch {}
})();
`;

// ── Public interface ──────────────────────────────────────────────────────────

export interface BrowserHandle {
  browser: Browser;
  context: BrowserContext;
  newPage(): Promise<Page>;
  close(): Promise<void>;
}

export async function createBrowser(
  proxyUrl?: string | null,
  headless: boolean = true,
): Promise<BrowserHandle> {
  const effectiveProxy = proxyUrl !== undefined ? proxyUrl : config.proxyUrl;
  const proxy = parseProxy(effectiveProxy);

  if (proxy) {
    logger.info(`[browser] Using proxy: ${proxy.server}`);
  } else {
    logger.info("[browser] No proxy — scraping direct");
  }

  const browser = (await (chromium as any).launch({
    headless: headless,
    args: [
      ...(headless ? ["--headless=new"] : []),
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--disable-gpu",
      "--no-zygote",
      "--window-size=1440,900",
      "--start-maximized",
      "--disable-features=IsolateOrigins",
      "--disable-site-isolation-trials",
      "--use-gl=swiftshader",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
    ],
    ...(proxy ? { proxy } : {}),
  })) as Browser;

  const context = await browser.newContext({
    userAgent: config.browser.userAgent,
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    timezoneId: "America/New_York",
    extraHTTPHeaders: { ...config.browser.extraHeaders },
    ignoreHTTPSErrors: true,
    colorScheme: "light",
  });

  await context.addInitScript(STEALTH_SCRIPT);
  logger.debug("[browser] Stealth init script applied to context");

  return {
    browser,
    context,
    async newPage(): Promise<Page> {
      const page = await context.newPage();
      await page.setExtraHTTPHeaders({
        "sec-ch-ua":
          '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
      });
      return page;
    },
    async close(): Promise<void> {
      try {
        await browser.close();
      } catch (err: any) {
        if (
          !err?.message?.includes("has been closed") &&
          !err?.message?.includes("Target closed")
        ) {
          throw err;
        }
      }
      logger.debug("[browser] Browser closed");
    },
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function jitter(baseMs: number, jitterMs = 2000): number {
  return baseMs + Math.random() * jitterMs;
}
